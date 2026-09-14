/**
 * The tuple store: the in-memory index, the driver that persists it, and the
 * commit bus that live queries and watchers subscribe to. Every write is
 * compiled into mutations, enforced against a schema, versioned, applied to
 * the index, published to the bus, and then written to the driver. A driver
 * failure rolls the index back to its exact prior state and republishes.
 */
import { alreadyExists, unsupported } from '../core/errors.js'
import { decodeRecord } from '../core/record.js'
import type {
  ChangeKey,
  Def,
  Driver,
  LiveQuery,
  Mutation,
  Page,
  PatternQuery,
  Query,
  RecordObject,
  Tuple,
  Unsubscribe,
  WatchEvent,
} from '../core/types.js'
import { schemaPath } from '../core/uri.js'
import { isSystemAttr } from '../core/value.js'
import { changeKey, Footprint } from '../query/footprint.js'
import { runQuery } from '../query/engine.js'
import { ChangeBus, type LiveEntry } from './bus.js'
import { enforce } from './enforce.js'
import { groupByPath, normalizeMutation } from './mutation.js'
import { TupleIndex } from './tuple-index.js'
import { stampVersion } from './version.js'

/** Options for {@link TupleStore.open}. */
export interface StoreOptions {
  /** The driver that persists the store. */
  driver: Driver
  /** Definitions to register in the index and in the driver at open. */
  defs?: Def[]
}

/** The outcome of staging a batch of mutations against the index. */
interface Staged {
  changes: Set<ChangeKey>
  events: WatchEvent[]
  /** Restores the index to its state before this batch. Call in one shot; it undoes every mutation in reverse order. */
  undo: () => void
  /** The mutations to send to the driver, one per underlying driver op. A single input mutation can compile to more than one op, for example a partial delete plus its version stamp. */
  driverOps: Mutation[]
  /** Definitions that dynamic mode evolved during this batch. The driver must store them. */
  evolvedDefs: Def[]
}

/** The mutable state a `tx` buffers instead of committing immediately. */
interface TxBuffer {
  changes: Set<ChangeKey>
  events: WatchEvent[]
  driverOps: Mutation[]
  evolvedDefs: Def[]
  undos: Array<() => void>
}

/**
 * The tuple store. Holds the working set of tuples in memory, in a
 * {@link TupleIndex}, and mirrors every write to a {@link Driver}. Queries and
 * live queries read the index only, never the driver.
 */
export class TupleStore {
  /** The in-memory working set. Queries read from here, never from the driver. */
  readonly index: TupleIndex
  /** The driver that persists this store's writes. */
  readonly driver: Driver
  /** The commit bus: one publish per `apply` or `tx`. */
  readonly bus: ChangeBus

  private readonly defs = new Map<string, Def>()
  private readonly hydrated = new Set<string>()
  private txBuffer: TxBuffer | null = null
  /**
   * Serializes driver writes. The index is written synchronously, in call
   * order, but a driver write is asynchronous, so two overlapping `apply`
   * calls would otherwise interleave their ops and reach the driver out of
   * order. A patch that overtakes its own create makes the driver reject a
   * write that the index already accepted.
   */
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(driver: Driver) {
    this.driver = driver
    this.index = new TupleIndex()
    this.bus = new ChangeBus()
  }

  /** Opens a store over `opts.driver`, registering `opts.defs` in the index and in the driver. */
  static async open(opts: StoreOptions): Promise<TupleStore> {
    const store = new TupleStore(opts.driver)
    for (const def of opts.defs ?? []) {
      await store.putDef(def)
    }
    return store
  }

  /**
   * Loads every tuple under `scope` from the driver into the index. A no-op
   * on a scope already hydrated, so a collection can call this on every
   * bind without doing the scan twice.
   */
  async hydrate(scope: string): Promise<void> {
    if (this.hydrated.has(scope)) return
    for await (const t of this.driver.scanTuples(scope)) {
      this.index.add(t)
    }
    this.hydrated.add(scope)
  }

  /** Registers a definition, in the index (for enforcement) and in the driver (for persistence). */
  async putDef(def: Def): Promise<void> {
    // Registers in memory first, synchronously up to the first await, so a
    // caller that does not await this still gets enforcement on its next
    // write. The driver write is the slow part and only affects durability.
    this.defs.set(`${def.ns}/${def.schema}`, def)
    await this.driver.putSchema(def)
  }

  /** The registered definition of `schema` (`ns/schema`), or `null` when none is registered. */
  def(schema: string): Def | null {
    return this.defs.get(schema) ?? null
  }

  /**
   * Enforces, versions, and applies each mutation to the index, in order, so
   * a later mutation in the same batch sees the effect of an earlier one.
   * Fully rolls back the batch's index changes and rethrows on the first
   * failure: an `ALREADY_EXISTS`, a `SCHEMA_VIOLATION`, or a `CONFLICT`.
   */
  private stage(mutations: Mutation[]): Staged {
    const changes = new Set<ChangeKey>()
    const events: WatchEvent[] = []
    const driverOps: Mutation[] = []
    const evolvedDefs: Def[] = []
    const undos: Array<() => void> = []
    const now = new Date()

    try {
      for (const raw of mutations) {
        const m = normalizeMutation(raw)
        const schema = schemaPath(m.path)
        const exists = this.index.has(m.path)

        if (m.op === 'create' && exists) {
          throw alreadyExists(`a record already exists at ${m.path}`, { uri: m.path })
        }
        if (m.op === 'delete' && !exists) {
          // No-op, per the four-op table. Still forwarded to the driver, which is idempotent here.
          driverOps.push({ path: m.path, op: 'delete' })
          continue
        }

        const def = this.def(schema)
        const { mutation: enforced, def: evolvedDef } = enforce(m, def, exists)
        if (evolvedDef) {
          const prevDef = def
          this.defs.set(schema, evolvedDef)
          evolvedDefs.push(evolvedDef)
          undos.push(() => {
            if (prevDef) this.defs.set(schema, prevDef)
            else this.defs.delete(schema)
          })
        }

        const prevSnapshot = exists ? [...this.index.attrs(m.path)!.values()] : null
        undos.push(() => {
          this.index.removePath(m.path)
          if (prevSnapshot) for (const t of prevSnapshot) this.index.add(t)
        })

        const sysTuples = stampVersion(this.index, enforced, now)

        if (enforced.op === 'delete') {
          const wholeDelete = (enforced.attrs?.length ?? 0) === 0
          if (wholeDelete) {
            const removedAttrs = (prevSnapshot ?? []).map((t) => t.attr)
            for (const a of removedAttrs) {
              this.index.remove(m.path, a)
              changes.add(changeKey(m.path, a))
            }
            driverOps.push({ path: m.path, op: 'delete' })
            const prevVersion = (prevSnapshot ?? []).find((t) => t.attr === '_version')?.value
            events.push({
              type: 'delete',
              uri: `xdb://${m.path}`,
              attrs: removedAttrs.filter((a) => !isSystemAttr(a)),
              version: typeof prevVersion === 'bigint' ? Number(prevVersion) : ((prevVersion as number) ?? 0),
            })
          } else {
            const removedAttrs = enforced.attrs ?? []
            for (const a of removedAttrs) {
              this.index.remove(m.path, a)
              changes.add(changeKey(m.path, a))
            }
            for (const t of sysTuples) {
              this.index.add(t)
              changes.add(changeKey(m.path, t.attr))
            }
            driverOps.push({ path: m.path, op: 'delete', attrs: removedAttrs })
            driverOps.push({ path: m.path, op: 'patch', tuples: sysTuples })
            events.push({
              type: 'put',
              uri: `xdb://${m.path}`,
              attrs: removedAttrs.filter((a) => !isSystemAttr(a)),
              version: versionOf(sysTuples),
            })
          }
          continue
        }

        if (enforced.op === 'put' && exists) this.index.removePath(m.path)
        const finalTuples = [...(enforced.tuples ?? []), ...sysTuples]
        for (const t of finalTuples) {
          this.index.add(t)
          changes.add(changeKey(m.path, t.attr))
        }
        driverOps.push({ path: m.path, op: enforced.op, tuples: finalTuples, version: enforced.version })
        events.push({
          type: 'put',
          uri: `xdb://${m.path}`,
          attrs: (enforced.tuples ?? []).map((t) => t.attr).filter((a) => !isSystemAttr(a)),
          version: versionOf(sysTuples),
        })
      }
    } catch (err) {
      for (let i = undos.length - 1; i >= 0; i--) undos[i]!()
      throw err
    }

    const undo = (): void => {
      for (let i = undos.length - 1; i >= 0; i--) undos[i]!()
    }
    return { changes, events, undo, driverOps, evolvedDefs }
  }

  /** Builds the reversed form of a watch event, from the index state after an undo. */
  private reversalEvent(e: WatchEvent): WatchEvent {
    const path = e.uri.startsWith('xdb://') ? e.uri.slice('xdb://'.length) : e.uri
    const stillExists = this.index.has(path)
    const versionTuple = this.index.get(path, '_version')?.value
    const version = typeof versionTuple === 'bigint' ? Number(versionTuple) : ((versionTuple as number) ?? 0)
    return { type: stillExists ? 'put' : 'delete', uri: e.uri, attrs: e.attrs, version }
  }

  /**
   * Applies mutations to the index only, and returns an undo function plus
   * the changes and watch events the batch produced. Runs enforcement and
   * versioning, but never touches the driver and never publishes to the
   * bus; the caller decides whether and when to do either.
   */
  applyLocal(mutations: Mutation[]): { undo: () => void; changes: Set<ChangeKey>; events: WatchEvent[] } {
    const { changes, events, undo } = this.stage(mutations)
    return { undo, changes, events }
  }

  /**
   * Runs `fn` after every driver write already queued. A rejection is passed
   * to the caller and does not block the writes behind it.
   */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(fn, fn)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Applies mutations: enforcement and versioning per mutation, the index
   * write, one bus commit, then the driver write. Inside a {@link tx}, the
   * mutations are staged against the index and buffered instead; the
   * enclosing `tx` commits the whole batch as one driver write and one
   * publish.
   *
   * On a driver failure, restores the index to its state before this call,
   * publishes the reversal, and rethrows the driver's error.
   */
  async apply(mutations: Mutation[]): Promise<void> {
    const { changes, events, undo, driverOps, evolvedDefs } = this.stage(mutations)

    if (this.txBuffer) {
      const buf = this.txBuffer
      for (const c of changes) buf.changes.add(c)
      buf.events.push(...events)
      buf.driverOps.push(...driverOps)
      buf.evolvedDefs.push(...evolvedDefs)
      buf.undos.push(undo)
      return
    }

    this.bus.publish(changes, events)
    return this.enqueue(async () => {
      try {
        // A dynamic-mode write that added a field must persist the new
        // definition, or a reopened store loses the inferred type.
        for (const def of evolvedDefs) await this.driver.putSchema(def)
        for (const op of driverOps) await this.driver.apply(op)
      } catch (err) {
        undo()
        this.bus.publish(
          changes,
          events.map((e) => this.reversalEvent(e)),
        )
        throw err
      }
    })
  }

  /** The raw tuple at `(path, attr)`, or `undefined` when absent. Reads the index. */
  get(path: string, attr: string): Tuple | undefined {
    return this.index.get(path, attr)
  }

  /** The decoded record at `path`, or `undefined` when it holds no tuples. */
  record(path: string, opts?: { system?: boolean }): RecordObject | undefined {
    const attrs = this.index.attrs(path)
    if (!attrs) return undefined
    return decodeRecord(attrs.values(), opts)
  }

  /**
   * Lists the records of `q.scope`, filtered, and paginated. `q.filter` is a
   * predicate over the decoded record. `q.limit` defaults to 20 and is capped
   * at 1000. `q.offset` is zero-based. `q.fields` is not read here, matching
   * the Go facade.
   */
  list(q: Query): Page<RecordObject> {
    const limit = Math.min(q.limit ?? 20, 1000)
    const offset = Math.max(q.offset ?? 0, 0)

    const groups = groupByPath([...this.index.scan(q.scope)])
    const matches: RecordObject[] = []
    for (const tuples of groups.values()) {
      const rec = decodeRecord(tuples, { system: true })
      if (q.filter !== undefined && !q.filter(rec)) continue
      matches.push(rec)
    }

    const total = matches.length
    const items = matches.slice(offset, offset + limit)
    const nextOffset = offset + items.length < total ? offset + limit : 0
    return { items, total, nextOffset }
  }

  /** Runs a pattern query against the index and returns one row per matching context. */
  query(q: PatternQuery): unknown[][] {
    return runQuery(this.index, q)
  }

  /**
   * A live view over `run`. `run` reads the index and records the schema and
   * attribute pairs it read into the footprint it is given. The first
   * subscriber triggers the first evaluation; the bus reruns `run`,
   * coalesced, whenever a commit's changes overlap the last-recorded
   * footprint. A subscriber is called only when the rerun's rows differ from
   * the last delivery, compared by a JSON key.
   */
  live<T>(run: (index: TupleIndex, fp: Footprint) => T[]): LiveQuery<T> {
    const store = this
    let subscribers: Array<(rows: T[]) => void> = []
    let lastRows: T[] = []
    let lastKey: string | null = null
    let unregister: Unsubscribe | null = null

    const entry: LiveEntry = {
      footprint: new Footprint(),
      rerun(): void {
        const fp = new Footprint()
        const rows = run(store.index, fp)
        entry.footprint = fp
        const key = JSON.stringify(rows)
        if (key === lastKey) return
        lastKey = key
        lastRows = rows
        for (const cb of subscribers) cb(rows)
      },
    }

    return {
      toArray(): T[] {
        return run(store.index, new Footprint())
      },
      subscribe(cb: (rows: T[]) => void): Unsubscribe {
        if (subscribers.length === 0) {
          const fp = new Footprint()
          lastRows = run(store.index, fp)
          entry.footprint = fp
          lastKey = JSON.stringify(lastRows)
          unregister = store.bus.register(entry)
        }
        subscribers = [...subscribers, cb]
        cb(lastRows)
        return () => {
          subscribers = subscribers.filter((s) => s !== cb)
          if (subscribers.length === 0 && unregister) {
            unregister()
            unregister = null
          }
        }
      },
    }
  }

  /** Subscribes to raw watch events whose record path falls inside `scope`. */
  watch(scope: string, cb: (e: WatchEvent) => void): Unsubscribe {
    return this.bus.watch(scope, cb)
  }

  /**
   * Runs `fn` with this store. Every `apply` that `fn` makes is staged
   * against the index immediately, so reads inside `fn` see prior writes in
   * the same transaction, but the driver write and the bus publish are
   * deferred until `fn` returns. The whole batch commits as one driver write
   * sequence and one publish, so a live query reruns once for the
   * transaction, not once per mutation inside it.
   *
   * If `fn` throws, or the deferred driver write fails, every mutation
   * staged during the transaction is rolled back from the index. A failed
   * driver write also publishes the reversal, matching `apply`.
   */
  async tx(fn: (t: TupleStore) => void | Promise<void>): Promise<void> {
    if (this.txBuffer) throw unsupported('nested transactions are not supported')

    const buf: TxBuffer = { changes: new Set(), events: [], driverOps: [], evolvedDefs: [], undos: [] }
    this.txBuffer = buf
    try {
      await fn(this)
    } catch (err) {
      for (let i = buf.undos.length - 1; i >= 0; i--) buf.undos[i]!()
      this.txBuffer = null
      throw err
    }
    this.txBuffer = null

    this.bus.publish(buf.changes, buf.events)
    return this.enqueue(async () => {
      try {
        for (const def of buf.evolvedDefs) await this.driver.putSchema(def)
        for (const op of buf.driverOps) await this.driver.apply(op)
      } catch (err) {
        for (let i = buf.undos.length - 1; i >= 0; i--) buf.undos[i]!()
        this.bus.publish(
          buf.changes,
          buf.events.map((e) => this.reversalEvent(e)),
        )
        throw err
      }
    })
  }

  /** Closes the underlying driver, when it has a `close` method. */
  async close(): Promise<void> {
    if (this.driver.close) await this.driver.close()
  }
}

/** The `_version` value of a stamped tuple set, as a `number`. */
function versionOf(sysTuples: Tuple[]): number {
  const v = sysTuples.find((t) => t.attr === '_version')?.value
  return typeof v === 'bigint' ? Number(v) : ((v as number) ?? 0)
}
