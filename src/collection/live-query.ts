/**
 * A live query that is itself a collection, so its result can be the source of
 * another query. This is what makes a subquery work: a collection is a
 * `QuerySource`, and so is the result of a query over collections. Matches
 * TanStack DB's `createLiveQueryCollection`. See `CONTRACTS-DX.md`.
 *
 * The rows are materialized into the tuple index under the `_live` namespace,
 * in `flexible` mode, and rewritten whenever the query emits. The engine
 * therefore needs no notion of a subquery: it reads materialized tuples the
 * same way it reads any other record.
 */
import { unsupported } from '../core/errors.js'
import { encodeRecord } from '../core/record.js'
import type { RecordObject, Unsubscribe } from '../core/types.js'
import { isPlainObject } from '../core/value.js'
import { QueryBuilder, query } from '../builder/query.js'
import type { TupleStore } from '../store/store.js'
import { createCollection } from './collection.js'
import type { ChangeMessage, Collection, CollectionStatus } from './collection.js'
import type { Transaction } from './transaction.js'

/** Options for {@link createLiveQueryCollection}. */
export interface LiveQueryCollectionConfig<T> {
  /** A stable name. Becomes the schema part of the materialized path. */
  id?: string
  /** Builds the query. Receives a fresh builder. */
  query: (q: QueryBuilder) => QueryBuilder
  /** Extracts a row key. Defaults to the row's `id`, then to its position. */
  getKey?: (row: T) => string
  /** The store to read and materialize into. Defaults to the store of the first source. */
  store?: TupleStore
}

let counter = 0

/** The namespace every materialized live query lives in. */
const LIVE_NS = '_live'

/**
 * Builds a live query whose result is a collection. Read it with `toArray`,
 * `get`, and `subscribe`, and pass it straight to another query's `from` or
 * `join`.
 *
 * ```ts
 * const active = createLiveQueryCollection((q) =>
 *   q.from({ user: users }).where(({ user }) => eq(user.active, true)),
 * )
 * const rows = query().from({ u: active }).select(({ u }) => u.name).run(db.store.index)
 * ```
 *
 * The returned collection is read-only: `insert`, `update`, and `delete` throw
 * `UNSUPPORTED`, because its contents are derived.
 */
export function createLiveQueryCollection<T = RecordObject>(
  config: LiveQueryCollectionConfig<T> | ((q: QueryBuilder) => QueryBuilder),
): Collection<T> {
  const cfg: LiveQueryCollectionConfig<T> = typeof config === 'function' ? { query: config } : config
  const id = cfg.id ?? `q${++counter}`
  const build = cfg.query

  const backing = createCollection<RecordObject>({
    id,
    uri: `xdb://${LIVE_NS}/${id}`,
    mode: 'flexible',
  })

  let store: TupleStore | null = null
  let stopSource: Unsubscribe | null = null
  /** The keys currently materialized, so a rerun can remove the rows that went away. */
  let present = new Set<string>()

  const keyOf = (row: unknown, position: number): string => {
    if (cfg.getKey) return cfg.getKey(row as T)
    if (isPlainObject(row) && typeof row.id === 'string') return row.id
    return String(position)
  }

  /**
   * Shapes one row for storage. A plain object is stored as itself. Any other
   * value, as `fn.select` can return, is wrapped so it still has attributes.
   */
  const shape = (row: unknown, key: string): RecordObject =>
    isPlainObject(row) ? { ...row, id: key } : { id: key, value: row }

  /** Rewrites the materialized rows to match `rows`. */
  const materialize = (rows: unknown[]): void => {
    if (!store) return
    const next = new Set<string>()
    const writes = []
    for (let i = 0; i < rows.length; i++) {
      const key = keyOf(rows[i], i)
      next.add(key)
      const path = `${LIVE_NS}/${id}/${key}`
      const obj = shape(rows[i], key)
      writes.push({ path, op: 'put' as const, tuples: encodeRecord(path, obj) })
    }
    for (const key of present) {
      if (!next.has(key)) writes.push({ path: `${LIVE_NS}/${id}/${key}`, op: 'delete' as const })
    }
    present = next
    if (writes.length === 0) return
    // Materialization is a derived write. A query reads real collections, never
    // its own output, so this cannot make the query rerun itself.
    void store.apply(writes).catch(() => undefined)
  }

  const collection: Collection<T> = {
    get id() {
      return backing.id
    },
    get uri() {
      return backing.uri
    },
    get path() {
      return backing.path
    },
    get def() {
      return backing.def
    },
    get status(): CollectionStatus {
      return backing.status
    },
    get size() {
      return backing.size
    },
    get state() {
      return backing.state as ReadonlyMap<string, T>
    },
    get utils() {
      return backing.utils
    },

    bind(s: TupleStore): void {
      if (store === s) return
      store = s
      backing.bind(s)
      stopSource?.()
      const live = s.live<unknown>((index, fp) => build(query()).run(index, fp))
      // Materialize now, then on every emission.
      materialize(live.toArray())
      stopSource = live.subscribe((rows) => materialize(rows))
    },

    get: (key) => backing.get(key) as T | undefined,
    has: (key) => backing.has(key),
    entries: () => backing.entries() as IterableIterator<[string, T]>,
    values: () => backing.values() as IterableIterator<T>,
    keys: () => backing.keys(),
    toArray: () => backing.toArray() as T[],

    insert(): Transaction<T> {
      throw unsupported(`live query "${id}" is read-only: its rows come from its query`)
    },
    update(): Transaction<T> {
      throw unsupported(`live query "${id}" is read-only: its rows come from its query`)
    },
    delete(): Transaction<T> {
      throw unsupported(`live query "${id}" is read-only: its rows come from its query`)
    },

    subscribeChanges: (cb, opts) =>
      backing.subscribeChanges(cb as (c: ChangeMessage<RecordObject>[]) => void, opts),
    subscribe: (cb) => backing.subscribe((items) => cb(items as T[])),

    isReady: () => backing.isReady(),
    preload: () => backing.preload(),
    onFirstReady: (cb) => backing.onFirstReady(cb),
    async cleanup(): Promise<void> {
      stopSource?.()
      stopSource = null
      present = new Set()
      await backing.cleanup()
    },
  }

  return collection
}

