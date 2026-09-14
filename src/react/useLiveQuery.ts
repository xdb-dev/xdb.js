/**
 * React bindings. This is the only module that imports `react`, so a
 * consumer that never imports `xdb.js/react` needs no React runtime.
 *
 * `useLiveQuery` and `useCollection` both read through `useSyncExternalStore`
 * so a subscriber snapshot stays referentially stable across renders that
 * carry no new rows, which keeps React's concurrent renderer from looping.
 */
import * as React from 'react'
import { unavailable } from '../core/errors.js'
import type { Unsubscribe } from '../core/types.js'
import { QueryBuilder, query } from '../builder/query.js'
import type { TupleStore } from '../store/store.js'

/**
 * The structural shape `useCollection` needs from a collection. A real
 * `Collection` (from `src/collection/collection.ts`) satisfies this without
 * importing it: `src/react` does not depend on `src/collection`.
 */
export interface CollectionLike<T> {
  toArray(): T[]
  subscribe(cb: (items: T[]) => void): Unsubscribe
}

/** External-store glue shared by `useLiveQuery` and `useCollection`. */
interface ExternalCache<T> {
  rows: T[]
  subscribe(cb: () => void): Unsubscribe
}

/** Reads an `ExternalCache` through `useSyncExternalStore`, returning its current rows. */
function useExternalRows<T>(cache: ExternalCache<T>): T[] {
  const subscribe = React.useCallback((onStoreChange: () => void) => cache.subscribe(onStoreChange), [cache])
  const getSnapshot = React.useCallback(() => cache.rows, [cache])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const StoreContext = React.createContext<TupleStore | null>(null)

/** What a live-query hook returns. Matches TanStack DB's `useLiveQuery`. */
export interface UseLiveQueryResult<T> {
  data: T[]
  isLoading: boolean
  isReady: boolean
  status: 'loading' | 'ready'
  /** The live query as a collection, so it can feed another query. */
  collection: { toArray(): T[]; subscribe(cb: (items: T[]) => void): Unsubscribe }
}

/** The argument both live-query hooks accept: TanStack DB's object form, or a bare callback. */
export type LiveQueryArg = { query: (q: QueryBuilder) => QueryBuilder; id?: string } | ((q: QueryBuilder) => QueryBuilder)

/** Normalizes the two accepted argument forms to one builder callback. */
function builderOf(arg: LiveQueryArg): (q: QueryBuilder) => QueryBuilder {
  return typeof arg === 'function' ? arg : arg.query
}

/**
 * Runs the query against a fresh {@link QueryBuilder}, subscribes to the
 * result as a live query on the store from {@link useStore}, and re-renders
 * when the rows change.
 *
 * Accepts TanStack DB's object form, `{ query: (q) => ... }`, and a bare
 * callback.
 *
 * The query is rebuilt only when `deps` changes, the same rule as `useMemo`;
 * the callback itself is not a dependency, so an inline arrow does not force a
 * rebuild on every render.
 */
export function useLiveQuery<T = unknown>(arg: LiveQueryArg, deps: unknown[] = []): UseLiveQueryResult<T> {
  const store = useStore()

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query callback is intentionally excluded; see the TSDoc above.
  const cache = React.useMemo<ExternalCache<T>>(() => {
    const compiled = builderOf(arg)(query())
    const live = store.live<T>((index, fp) => compiled.run(index, fp) as T[])
    const state: ExternalCache<T> = {
      rows: [],
      subscribe(cb) {
        return live.subscribe((rows) => {
          state.rows = rows
          cb()
        })
      },
    }
    state.rows = live.toArray()
    return state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...deps])

  const data = useExternalRows(cache)
  const collection = React.useMemo(
    () => ({
      toArray: () => cache.rows,
      subscribe: (cb: (items: T[]) => void) => cache.subscribe(() => cb(cache.rows)),
    }),
    [cache],
  )

  // A live query over the in-memory index is answered on the first render, so
  // it is ready immediately. The fields exist for parity, and for the day a
  // collection loads on demand.
  return { data, isLoading: false, isReady: true, status: 'ready', collection }
}

/**
 * The Suspense form. The rows come from the in-memory index, so this never
 * suspends today; it exists so a component written against TanStack DB's
 * `useLiveSuspenseQuery` compiles and behaves the same.
 */
export function useLiveSuspenseQuery<T = unknown>(
  arg: LiveQueryArg,
  deps: unknown[] = [],
): Omit<UseLiveQueryResult<T>, 'isLoading'> {
  const { data, isReady, status, collection } = useLiveQuery<T>(arg, deps)
  return { data, isReady, status, collection }
}

/**
 * Subscribes to a collection-like object (structurally, any `Collection`)
 * and re-renders when its items change.
 */
export function useCollection<T>(collection: CollectionLike<T>): { data: T[] } {
  const cache = React.useMemo<ExternalCache<T>>(() => {
    const state: ExternalCache<T> = {
      rows: collection.toArray(),
      subscribe(cb) {
        return collection.subscribe((items) => {
          state.rows = items
          cb()
        })
      },
    }
    return state
  }, [collection])

  return { data: useExternalRows(cache) }
}

/** Provides the {@link TupleStore} that {@link useStore}, {@link useLiveQuery}, and collections in the tree read. */
export function XDBProvider(props: { store: TupleStore; children?: unknown }): unknown {
  return React.createElement(StoreContext.Provider, { value: props.store }, props.children as React.ReactNode)
}

/** The {@link TupleStore} from the nearest {@link XDBProvider}. Throws `UNAVAILABLE` outside one. */
export function useStore(): TupleStore {
  const store = React.useContext(StoreContext)
  if (!store) {
    throw unavailable('useStore: no XDBProvider found in the component tree. Wrap your app in <XDBProvider store={...}>.')
  }
  return store
}
