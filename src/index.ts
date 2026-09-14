/**
 * xdb.js: think in tuples, storage is a detail.
 *
 * The browser edition of XDB. Data is tuples underneath: a path, an
 * attribute, and a typed value. On top sits a collection per schema, with
 * typed objects, optimistic mutations, and live queries.
 */

import { createCollection } from './collection/collection.js'
import { TupleStore } from './store/store.js'
import { query, QueryBuilder } from './builder/query.js'
import type { Collection } from './collection/collection.js'
import type { Driver, Def, LiveQuery, SyncSource, Unsubscribe } from './core/types.js'

// ---- core ----
export { XDBError, isXDBError } from './core/errors.js'
export type { ErrorCode } from './core/errors.js'
export { parseURI, formatURI, depth, recordPath, schemaPath, idOf, splitPath, inScope, tupleURI } from './core/uri.js'
export {
  inferType, inferItems, coerce, valueKey, valueEquals, toTuple, isSystemAttr,
  isDate, isBytes, isArrayBuffer, isPlainObject,
} from './core/value.js'
export { encodeRecord, decodeRecord, getIn, setIn, attrsOf } from './core/record.js'
export type * from './core/types.js'

// ---- store and query ----
export { TupleStore } from './store/store.js'
export type { StoreOptions } from './store/store.js'
export { TupleIndex } from './store/tuple-index.js'
export { ChangeBus } from './store/bus.js'
export { Footprint, changeKey } from './query/footprint.js'
export { runQuery, runContexts, matchTuple, relevant, compilePredicate, isVar } from './query/engine.js'

// ---- builder ----
export { query, QueryBuilder }
export type { QuerySource, JoinKind } from './builder/query.js'
export { compile } from './builder/compile.js'
export type { CompiledQuery, AntiJoin } from './builder/compile.js'
export {
  eq, ne, gt, gte, lt, lte, and, or, not,
  inArray, like, ilike, startsWith, endsWith,
  isNull, isUndefined, length, upper, lower, concat,
  add, subtract, multiply, divide, coalesce, caseWhen,
  count, sum, avg, min, max,
  isFieldRef, isExprNode, isAggregate, evalExpr, evalAggregate, fieldProxy,
} from './builder/expr.js'
export type { Expr, ExprNode, FieldRef, AggregateNode } from './builder/expr.js'

// ---- collections ----
export { createCollection } from './collection/collection.js'
export type { Collection, CollectionOptions, CollectionStatus, ChangeMessage } from './collection/collection.js'
export { defFromSchema, parseItem } from './collection/schema.js'
export { diffItems } from './collection/diff.js'
export { createTransaction, createOptimisticAction } from './collection/transaction.js'
export type {
  Transaction,
  TransactionState,
  CollectionMutation,
  CreateTransactionOptions,
  MutationFn,
  MutationFnContext,
  MutationHandler,
  HandlerContext,
  OptimisticActionOptions,
} from './collection/transaction.js'
export { createLiveQueryCollection } from './collection/live-query.js'
export type { LiveQueryCollectionConfig } from './collection/live-query.js'
export {
  localOnlyCollectionOptions,
  localStorageCollectionOptions,
  xdbCollectionOptions,
} from './collection/options.js'

// ---- drivers ----
export { memory } from './drivers/memory.js'

/**
 * A live query over a store, built with the query builder. Returns rows now,
 * and again after every commit that touches what the query read.
 *
 * ```ts
 * const popular = createLiveQuery(db.store, (q) =>
 *   q.from({ post: posts }).where(({ post }) => gt(post.views, 100)),
 * )
 * const stop = popular.subscribe((rows) => render(rows))
 * ```
 */
export function createLiveQuery<T = unknown>(
  store: TupleStore,
  build: (q: QueryBuilder) => QueryBuilder,
): LiveQuery<T> {
  return store.live<T>((index, fp) => build(query()).run(index, fp) as T[])
}

/** Options for {@link createDB}. */
export interface CreateDBOptions {
  /** The local driver that persists this database. Defaults to {@link memory}. */
  driver?: Driver
  /** The collections this database serves, keyed by the name you use in code. */
  collections?: Record<string, Collection<any>>
  /** Extra definitions to register, for schemas without a collection. */
  defs?: Def[]
}

/**
 * A database: one store, plus the collections bound to it. The tuple layer
 * stays reachable through `tuples`, `records`, `query`, and `watch`, for
 * tools, migrations, and data without a schema.
 */
export interface DB<C extends Record<string, Collection<any>> = Record<string, Collection<any>>> {
  /** The underlying tuple store. */
  readonly store: TupleStore
  /** The bound collections, under the names you gave them. */
  readonly collections: C
  /** Attribute-level reads and writes. */
  readonly tuples: {
    get(uri: string): unknown
    put(...tuples: Array<[string, string, unknown] | { path: string; attr: string; value: unknown }>): Promise<void>
    delete(...uris: string[]): Promise<void>
  }
  /** Whole-record reads and lists over the tuple layer. */
  readonly records: {
    get(uri: string): Record<string, unknown> | undefined
    list(
      scope: string,
      opts?: { filter?: (record: Record<string, unknown>) => boolean; limit?: number; offset?: number },
    ): {
      items: Record<string, unknown>[]
      total: number
      nextOffset: number
    }
  }
  /** Runs a pattern query against the tuple index. */
  query(q: { find: string[]; where: any[] }): unknown[][]
  /** A live query over this database, built with the query builder. */
  live<T = unknown>(build: (q: QueryBuilder) => QueryBuilder): LiveQuery<T>
  /** Streams change events for a scope. */
  watch(scope: string, cb: (e: import('./core/types.js').WatchEvent) => void): Unsubscribe
  /** Runs `fn` and commits its writes as one batch. */
  tx(fn: (store: TupleStore) => void | Promise<void>): Promise<void>
  /** Closes the driver. */
  close(): Promise<void>
}

/**
 * Opens a database, binds every collection to it, and loads each
 * collection's records from the driver into memory.
 *
 * ```ts
 * const db = await createDB({ driver: idb('myapp'), collections: { posts, users } })
 * posts.insert({ id: 'p-1', title: 'Hello' })
 * ```
 */
export async function createDB<C extends Record<string, Collection<any>>>(
  opts: CreateDBOptions & { collections?: C } = {},
): Promise<DB<C>> {
  const { memory } = await import('./drivers/memory.js')
  const driver = opts.driver ?? memory()
  const store = await TupleStore.open({ driver, defs: opts.defs })
  const collections = (opts.collections ?? {}) as C

  for (const collection of Object.values(collections)) {
    collection.bind(store)
    await store.hydrate(collection.path)
  }

  const { parseURI, recordPath } = await import('./core/uri.js')
  const { toTuple } = await import('./core/value.js')

  return {
    store,
    collections,
    tuples: {
      get(uri) {
        const u = parseURI(uri)
        if (!u.attr) throw new Error('a tuple read needs an attribute URI, for example xdb://ns/schema/id#attr')
        return store.get(recordPath(u), u.attr)?.value
      },
      put(...tuples) {
        const normalized = tuples.map((t) => toTuple(t as any))
        const byPath = new Map<string, typeof normalized>()
        for (const t of normalized) {
          const list = byPath.get(t.path) ?? []
          list.push(t)
          byPath.set(t.path, list)
        }
        return store.apply([...byPath].map(([path, ts]) => ({ path, op: 'patch' as const, tuples: ts })))
      },
      delete(...uris) {
        const byPath = new Map<string, string[]>()
        for (const uri of uris) {
          const u = parseURI(uri)
          const path = recordPath(u)
          const list = byPath.get(path) ?? []
          if (u.attr) list.push(u.attr)
          byPath.set(path, list)
        }
        return store.apply([...byPath].map(([path, attrs]) => ({ path, op: 'delete' as const, attrs })))
      },
    },
    records: {
      get(uri) {
        return store.record(recordPath(parseURI(uri)), { system: true })
      },
      list(scope, listOpts = {}) {
        const page = store.list({ scope: scope.replace('xdb://', ''), ...listOpts })
        return { items: page.items, total: page.total, nextOffset: page.nextOffset }
      },
    },
    query: (q) => store.query(q),
    live: (build) => createLiveQuery(store, build),
    watch: (scope, cb) => store.watch(scope.replace('xdb://', ''), cb),
    tx: (fn) => store.tx(fn),
    close: () => store.close(),
  }
}

/** Re-exported for convenience: a sync source type. */
export type { SyncSource }
export type { Driver, Def }
export { createCollection as collection }
