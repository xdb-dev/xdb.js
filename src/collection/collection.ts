/**
 * The collection: the developer-facing view over one schema's worth of
 * records in a bound `TupleStore`. A collection holds no data of its own —
 * every read and write goes straight to the store — so binding it to a
 * store is a prerequisite for everything except construction. Matches
 * TanStack DB's collection surface: `insert`/`update`/`delete` return a
 * `Transaction`, `onInsert`/`onUpdate`/`onDelete` persist a direct write,
 * and `subscribeChanges` reports item-level changes. See `CONTRACTS-DX.md`.
 */
import { alreadyExists, notFound, unavailable, validation } from '../core/errors.js'
import { decodeRecord, encodeRecord } from '../core/record.js'
import type {
  Def,
  Field,
  Mutation,
  RecordObject,
  SchemaMode,
  SyncSource,
  Unsubscribe,
  WatchEvent,
} from '../core/types.js'
import { idOf, parseURI } from '../core/uri.js'
import { valueEquals } from '../core/value.js'
import type { QuerySource } from '../builder/query.js'
import type { TupleStore } from '../store/store.js'
import { diffItems } from './diff.js'
import { defFromSchema, parseItem } from './schema.js'
import { createTransaction, currentSink } from './transaction.js'
import type { CollectionMutation, MutationHandler, MutationSink, Transaction } from './transaction.js'

/** The lifecycle of a {@link Collection}. */
export type CollectionStatus = 'idle' | 'loading' | 'ready' | 'error' | 'cleaned-up'

/** Options for {@link createCollection}. */
export interface CollectionOptions<T> {
  /** A stable name. Defaults to the schema part of `uri`. */
  id?: string
  /** The collection's URI, for example `xdb://app/posts`. Defaults to `xdb://_local/<id>`. Its `ns/schema` becomes the collection's `path`. */
  uri?: string
  /** A Zod schema, or any Standard Schema. Validates input, applies defaults and transforms, and drives {@link defFromSchema}. Without one, the collection is `dynamic`. */
  schema?: unknown
  /** Extracts an item's id. Defaults to `(item) => item.id`. */
  getKey?: (item: T) => string
  /** Overrides the type mapping `defFromSchema` derives for the named attributes. */
  types?: Record<string, Field>
  /** Overrides the schema mode `defFromSchema` picks (`strict` with a schema, `dynamic` without one). */
  mode?: SchemaMode
  /** A sync source that mirrors this collection's writes to and from a remote store. */
  sync?: SyncSource
  /** Persists a direct `insert`. Applies to memory first; a rejection reverts it. */
  onInsert?: MutationHandler<T>
  /** Persists a direct `update`. Applies to memory first; a rejection reverts it. */
  onUpdate?: MutationHandler<T>
  /** Persists a direct `delete`. Applies to memory first; a rejection reverts it. */
  onDelete?: MutationHandler<T>
  /** Rows to seed the collection with once it binds, for any key not already present. */
  initialData?: T[]
  /** Extra methods exposed as `collection.utils`. */
  utils?: Record<string, (...args: any[]) => any>
}

/** One item-level change event, as {@link Collection.subscribeChanges} reports it. */
export interface ChangeMessage<T = unknown> {
  type: 'insert' | 'update' | 'delete'
  key: string
  value: T
  /** The item before the change. Present only on an `update`. */
  previousValue?: T
}

/**
 * A typed view over one schema's records in a bound `TupleStore`. Also a
 * {@link QuerySource}, so a collection can be passed straight to the query
 * builder's `from` and `join`.
 */
export interface Collection<T = RecordObject> extends QuerySource {
  /** The stable name given to, or derived for, {@link createCollection}. */
  readonly id: string
  /** The collection's URI, as given to or derived by {@link createCollection}. */
  readonly uri: string
  /** The `ns/schema` path this collection reads and writes. Also `QuerySource.path`. */
  readonly path: string
  /** The definition {@link defFromSchema} derived, or the caller supplied via `types`/`mode`. */
  readonly def: Def
  /** `idle` before `bind`, `loading` while hydrating, `ready` once loaded. */
  readonly status: CollectionStatus
  /** The number of items currently in the collection. */
  readonly size: number
  /** Every item, keyed by id. Built fresh on each read. */
  readonly state: ReadonlyMap<string, T>
  /** Extra methods this collection was created with, under `opts.utils`. */
  readonly utils: Record<string, (...args: any[]) => any>

  /** Binds the collection to a store and starts hydrating it. Every other method throws `UNAVAILABLE` before this is called. */
  bind(store: TupleStore): void
  /** The item at `key`, or `undefined` when it does not exist. */
  get(key: string): T | undefined
  /** True when an item exists at `key`. */
  has(key: string): boolean
  /** `[key, item]` pairs for every item in the collection, in no particular order. */
  entries(): IterableIterator<[string, T]>
  /** Every item in the collection, in no particular order. */
  values(): IterableIterator<T>
  /** The keys of every item in the collection. */
  keys(): IterableIterator<string>
  /** Every item in the collection, in no particular order. */
  toArray(): T[]

  /** Validates and inserts one item or an array of items, each as a `create` mutation. Throws `ALREADY_EXISTS` for a key already present. */
  insert(item: T | T[]): Transaction<T>
  /** Reads the item at `key` (or each key), clones it, runs `fn` on the clone, and writes only the attributes that changed. Throws `NOT_FOUND` for a missing key. */
  update(key: string | string[], fn: (draft: T) => void): Transaction<T>
  /** Deletes the whole record at `key` or each key. Throws `NOT_FOUND` for a missing key. */
  delete(key: string | string[]): Transaction<T>

  /**
   * Item-level change events: fires once per commit that touches this
   * collection, with every change from that commit. With
   * `includeInitialState`, also fires once immediately with every current
   * item reported as an `insert`.
   */
  subscribeChanges(cb: (changes: ChangeMessage<T>[]) => void, opts?: { includeInitialState?: boolean }): Unsubscribe
  /** Calls `cb` with the current items, then again after any commit that touches this collection's schema. Returns a function that stops the subscription. */
  subscribe(cb: (items: T[]) => void): Unsubscribe

  /** True once the collection has finished its initial hydration. */
  isReady(): boolean
  /** Resolves once the collection has loaded. Resolves at once if it already has. */
  preload(): Promise<void>
  /** Calls `cb` the first time the collection becomes ready. Calls it at once if it already is. */
  onFirstReady(cb: () => void): Unsubscribe
  /** Marks the collection `cleaned-up`. Idempotent. */
  cleanup(): Promise<void>
}

/** Reads the numeric `_version` of a record, or `0` when it has none. */
function versionOf(store: TupleStore, path: string): number {
  const t = store.get(path, '_version')
  if (!t) return 0
  return typeof t.value === 'bigint' ? Number(t.value) : (t.value as number)
}

/**
 * A shallow, top-level diff between two decoded items, for the `changes`
 * field of a {@link CollectionMutation}. Only top-level keys that differ are
 * included, each holding `after`'s value. `id` is never included.
 */
function shallowChanges(before: RecordObject, after: RecordObject): RecordObject {
  const out: RecordObject = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (key === 'id') continue
    if (!valueEquals(before[key], after[key])) out[key] = after[key]
  }
  return out
}

/** One prepared write: the item-level mutation (without `collection`, filled in at dispatch) and its tuple writes. */
interface Prepared<T> {
  item: Omit<CollectionMutation<T>, 'collection'>
  writes: Mutation[]
}

class CollectionImpl<T> implements Collection<T> {
  readonly id: string
  readonly uri: string
  readonly path: string
  readonly def: Def
  readonly utils: Record<string, (...args: any[]) => any>
  private readonly schema: unknown
  private readonly getKeyFn: (item: T) => string
  private readonly onInsert: MutationHandler<T> | undefined
  private readonly onUpdate: MutationHandler<T> | undefined
  private readonly onDelete: MutationHandler<T> | undefined
  private readonly initialData: T[]
  private store: TupleStore | null = null

  private _status: CollectionStatus = 'idle'
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private firstReadyFired = false
  private firstReadyCbs: Array<() => void> = []

  constructor(opts: CollectionOptions<T>) {
    if (!opts.uri && !opts.id) {
      throw validation('createCollection requires an id or a uri', {})
    }
    this.uri = opts.uri ?? `xdb://_local/${opts.id}`
    const u = parseURI(this.uri)
    this.path = `${u.ns}/${u.schema ?? u.ns}`
    this.id = opts.id ?? (u.schema ?? u.ns)
    this.schema = opts.schema
    this.getKeyFn = opts.getKey ?? ((item: unknown) => (item as { id: string }).id)
    const derived = defFromSchema(this.uri, opts.schema, opts.types)
    this.def = opts.mode ? { ...derived, mode: opts.mode } : derived
    this.onInsert = opts.onInsert
    this.onUpdate = opts.onUpdate
    this.onDelete = opts.onDelete
    this.initialData = opts.initialData ?? []
    this.utils = opts.utils ?? {}
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve
    })
  }

  get status(): CollectionStatus {
    return this._status
  }

  bind(store: TupleStore): void {
    this.store = store
    // Registers the derived definition with the store so the CLI and other
    // tools see real, typed fields. `putDef` writes it into `store.def`
    // synchronously, before its first await, so enforcement sees it even
    // though this call is not awaited.
    void store.putDef(this.def)
    this._status = 'loading'
    store
      .hydrate(this.path)
      .then(() => this.seedInitialData(store))
      .then(() => {
        // A `cleanup` during hydration wins: a resolved load must not revive a
        // collection the caller has already torn down.
        if (this._status === 'cleaned-up') return
        this._status = 'ready'
        this.resolveReady()
        if (!this.firstReadyFired) {
          this.firstReadyFired = true
          const cbs = this.firstReadyCbs
          this.firstReadyCbs = []
          for (const cb of cbs) cb()
        }
      })
      .catch(() => {
        if (this._status === 'cleaned-up') return
        this._status = 'error'
      })
  }

  /** Inserts every `initialData` row whose key is not already present. Applied directly to the store: `initialData` is trusted, already-shaped input. */
  private async seedInitialData(store: TupleStore): Promise<void> {
    for (const raw of this.initialData) {
      const parsed = parseItem<T>(this.schema, raw)
      const key = this.getKeyFn(parsed)
      const path = this.recordPath(key)
      if (store.index.has(path)) continue
      const tuples = encodeRecord(path, parsed as RecordObject)
      await store.apply([{ path, op: 'create', tuples }])
    }
  }

  private requireStore(): TupleStore {
    if (!this.store) throw unavailable(`collection ${this.uri} is not bound to a store`, { uri: this.uri })
    return this.store
  }

  private recordPath(key: string): string {
    return `${this.path}/${key}`
  }

  get(key: string): T | undefined {
    const store = this.requireStore()
    const rec = store.record(this.recordPath(key))
    return rec as T | undefined
  }

  has(key: string): boolean {
    const store = this.requireStore()
    return store.index.has(this.recordPath(key))
  }

  toArray(): T[] {
    return [...this.values()]
  }

  *entries(): IterableIterator<[string, T]> {
    const store = this.requireStore()
    for (const path of store.index.paths(this.path)) {
      const attrs = store.index.attrs(path)
      if (attrs) yield [idOf(path), decodeRecord(attrs.values()) as T]
    }
  }

  *values(): IterableIterator<T> {
    for (const [, value] of this.entries()) yield value
  }

  *keys(): IterableIterator<string> {
    const store = this.requireStore()
    for (const path of store.index.paths(this.path)) yield idOf(path)
  }

  get state(): ReadonlyMap<string, T> {
    return new Map(this.entries())
  }

  get size(): number {
    const store = this.requireStore()
    let n = 0
    for (const _ of store.index.paths(this.path)) n++
    return n
  }

  private handlerFor(type: CollectionMutation['type']): MutationHandler<T> | undefined {
    if (type === 'insert') return this.onInsert
    if (type === 'update') return this.onUpdate
    return this.onDelete
  }

  insert(item: T | T[]): Transaction<T> {
    const store = this.requireStore()
    const items = Array.isArray(item) ? item : [item]
    const prepared: Prepared<T>[] = []
    for (const raw of items) {
      const parsed = parseItem<T>(this.schema, raw)
      const key = this.getKeyFn(parsed)
      const path = this.recordPath(key)
      if (store.index.has(path)) throw alreadyExists(`a record already exists at ${path}`, { uri: path })
      const tuples = encodeRecord(path, parsed as RecordObject)
      prepared.push({
        item: { type: 'insert', key, modified: parsed },
        writes: [{ path, op: 'create', tuples }],
      })
    }
    return this.dispatch(store, prepared, 'insert')
  }

  update(key: string | string[], fn: (draft: T) => void): Transaction<T> {
    const store = this.requireStore()
    const keys = Array.isArray(key) ? key : [key]
    const prepared: Prepared<T>[] = []
    for (const oneKey of keys) {
      const path = this.recordPath(oneKey)
      const before = store.record(path)
      if (!before) throw notFound(`no record at ${path}`, { uri: path })

      const version = versionOf(store, path)
      const draft = structuredClone(before) as RecordObject
      fn(draft as T)

      const { tuples, attrs } = diffItems(before, draft, path)
      const writes: Mutation[] = []
      let versionUsed = false
      if (tuples.length > 0) {
        writes.push({ path, op: 'patch', tuples, version })
        versionUsed = true
      }
      if (attrs.length > 0) {
        writes.push({ path, op: 'delete', attrs, version: versionUsed ? undefined : version })
      }

      prepared.push({
        item: {
          type: 'update',
          key: oneKey,
          original: before as T,
          modified: draft as T,
          changes: shallowChanges(before, draft) as Partial<T>,
        },
        writes,
      })
    }
    return this.dispatch(store, prepared, 'update')
  }

  delete(key: string | string[]): Transaction<T> {
    const store = this.requireStore()
    const keys = Array.isArray(key) ? key : [key]
    const prepared: Prepared<T>[] = []
    for (const oneKey of keys) {
      const path = this.recordPath(oneKey)
      if (!store.index.has(path)) throw notFound(`no record at ${path}`, { uri: path })
      const before = store.record(path) as T
      prepared.push({
        item: { type: 'delete', key: oneKey, original: before },
        writes: [{ path, op: 'delete', version: versionOf(store, path) }],
      })
    }
    return this.dispatch(store, prepared, 'delete')
  }

  /**
   * Routes `prepared` into the active transaction, when a `mutate` call on
   * this collection's store is in progress, or otherwise builds an implicit
   * transaction, applies it to memory at once, and commits it. `commit`
   * runs `this.on<Type>` when the caller gave one; without one, the store
   * write already reached the driver, matching the pre-transaction behavior.
   */
  private dispatch(store: TupleStore, prepared: Prepared<T>[], type: CollectionMutation['type']): Transaction<T> {
    const handler = this.handlerFor(type)
    const existing = currentSink(store)
    const sink: MutationSink =
      existing ?? (createTransaction<T>({ store }) as unknown as Transaction<T> & MutationSink)
    for (const p of prepared) sink.push(this, p.item, p.writes, store, handler)
    if (!existing) {
      // `commit` writes the index before its first internal `await`, so the
      // mutation is visible to `get` and to live queries as soon as this
      // call returns, even though we do not await the commit here.
      ;(sink.transaction as Transaction<T>).commit().catch(() => undefined)
    }
    return sink.transaction as Transaction<T>
  }

  subscribeChanges(cb: (changes: ChangeMessage<T>[]) => void, opts?: { includeInitialState?: boolean }): Unsubscribe {
    const store = this.requireStore()
    const cache = new Map<string, T>(this.entries())

    if (opts?.includeInitialState && cache.size > 0) {
      const initial: ChangeMessage<T>[] = [...cache.entries()].map(([key, value]) => ({
        type: 'insert' as const,
        key,
        value,
      }))
      cb(initial)
    }

    let pending: ChangeMessage<T>[] | null = null
    const flush = (): void => {
      if (!pending) return
      const batch = pending
      pending = null
      cb(batch)
    }

    return store.watch(this.path, (e: WatchEvent) => {
      const path = e.uri.startsWith('xdb://') ? e.uri.slice('xdb://'.length) : e.uri
      const key = idOf(path)
      let msg: ChangeMessage<T>
      if (e.type === 'delete') {
        const previous = cache.get(key)
        cache.delete(key)
        msg = { type: 'delete', key, value: previous as T }
      } else {
        const value = store.record(path) as T
        const existed = cache.has(key)
        const previous = cache.get(key)
        cache.set(key, value)
        msg = existed ? { type: 'update', key, value, previousValue: previous } : { type: 'insert', key, value }
      }
      if (!pending) {
        pending = []
        queueMicrotask(flush)
      }
      pending.push(msg)
    })
  }

  subscribe(cb: (items: T[]) => void): Unsubscribe {
    const store = this.requireStore()
    const live = store.live<T>((index, fp) => {
      fp.add(this.path, null)
      const items: T[] = []
      for (const path of index.paths(this.path)) {
        const attrs = index.attrs(path)
        if (attrs) items.push(decodeRecord(attrs.values()) as T)
      }
      return items
    })
    return live.subscribe(cb)
  }

  isReady(): boolean {
    return this._status === 'ready'
  }

  preload(): Promise<void> {
    return this.readyPromise
  }

  onFirstReady(cb: () => void): Unsubscribe {
    if (this.firstReadyFired) {
      cb()
      return () => undefined
    }
    this.firstReadyCbs.push(cb)
    return () => {
      this.firstReadyCbs = this.firstReadyCbs.filter((c) => c !== cb)
    }
  }

  async cleanup(): Promise<void> {
    this._status = 'cleaned-up'
  }
}

/**
 * Creates a {@link Collection}. Call {@link Collection.bind} with a
 * `TupleStore` before using it; every other method throws `UNAVAILABLE`
 * until then.
 */
export function createCollection<T = RecordObject>(opts: CollectionOptions<T>): Collection<T> {
  return new CollectionImpl<T>(opts)
}
