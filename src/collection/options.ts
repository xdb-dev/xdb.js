/**
 * Options creators: plain functions that fill in {@link CollectionOptions}
 * defaults for three common shapes, matching TanStack DB's
 * `localOnlyCollectionOptions`, `localStorageCollectionOptions`, and the
 * equivalent of its query-collection helpers for an XDB-backed collection.
 * None of them touch a store; they only build the options object a caller
 * passes to `createCollection`.
 */
import type { SyncSource } from '../core/types.js'
import type { Collection, CollectionOptions } from './collection.js'
import type { MutationHandler } from './transaction.js'

/** Options for {@link localOnlyCollectionOptions}. */
export interface LocalOnlyCollectionOptions<T> {
  id: string
  schema?: unknown
  getKey?: (item: T) => string
  initialData?: T[]
}

/** In memory only, for UI state that never needs to persist. */
export function localOnlyCollectionOptions<T>(opts: LocalOnlyCollectionOptions<T>): CollectionOptions<T> {
  return {
    id: opts.id,
    uri: `xdb://_local/${opts.id}`,
    schema: opts.schema,
    getKey: opts.getKey,
    initialData: opts.initialData,
  }
}

/** Options for {@link localStorageCollectionOptions}. */
export interface LocalStorageCollectionOptions<T> {
  id: string
  /** The `localStorage` key the whole collection round-trips through. */
  storageKey: string
  schema?: unknown
  getKey?: (item: T) => string
  /** Overrides the storage to use. Defaults to `window.localStorage`, when present. */
  storage?: Storage
}

/** The global `localStorage`, or `undefined` where the API does not exist. Never throws. */
function defaultStorage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage
}

/** The global `window`, or `undefined` outside a browser-like environment. Never throws. */
function globalWindow(): (typeof globalThis & { addEventListener?: Window['addEventListener'] }) | undefined {
  return (globalThis as { window?: typeof globalThis }).window
}

/**
 * Persists to `localStorage`, and follows the `storage` event so a second
 * tab stays in step. Every `localStorage` access is guarded, so this works
 * where the API is missing: it degrades to an in-memory collection.
 */
export function localStorageCollectionOptions<T>(opts: LocalStorageCollectionOptions<T>): CollectionOptions<T> {
  const storage = opts.storage ?? defaultStorage()
  const getKey = opts.getKey ?? ((item: unknown) => (item as { id: string }).id)

  function readAll(): T[] {
    if (!storage) return []
    try {
      const raw = storage.getItem(opts.storageKey)
      return raw ? (JSON.parse(raw) as T[]) : []
    } catch {
      return []
    }
  }

  function writeAll(items: T[]): void {
    if (!storage) return
    try {
      storage.setItem(opts.storageKey, JSON.stringify(items))
    } catch {
      // Storage full, disabled, or otherwise unavailable: best effort only.
    }
  }

  // Set the first time a handler below runs, so the `storage` listener has a
  // live collection to reconcile into. `createCollection` has not returned
  // yet when this module-level closure is built, so it cannot be captured
  // any earlier than that.
  let bound: Collection<T> | null = null

  function persist({ collection }: { collection: Collection<T> }): void {
    bound = collection
    writeAll(collection.toArray())
  }

  const win = globalWindow()
  if (storage && win && typeof win.addEventListener === 'function') {
    win.addEventListener('storage', (e: Event) => {
      const se = e as StorageEvent
      if (se.key !== null && se.key !== opts.storageKey) return
      if (!bound) return
      const incoming = readAll()
      const incomingKeys = new Set(incoming.map(getKey))
      for (const key of [...bound.keys()]) {
        if (!incomingKeys.has(key)) bound.delete(key)
      }
      for (const item of incoming) {
        const key = getKey(item)
        if (bound.has(key)) bound.update(key, (draft) => Object.assign(draft as object, item))
        else bound.insert(item)
      }
    })
  }

  const handler: MutationHandler<T> = async (ctx) => persist(ctx)

  return {
    id: opts.id,
    uri: `xdb://_local/${opts.id}`,
    schema: opts.schema,
    getKey: opts.getKey,
    initialData: readAll(),
    onInsert: handler,
    onUpdate: handler,
    onDelete: handler,
  }
}

/** Options for {@link xdbCollectionOptions}. */
export interface XdbCollectionOptions<T> {
  uri: string
  schema?: unknown
  getKey?: (item: T) => string
  sync?: SyncSource
  onInsert?: MutationHandler<T>
  onUpdate?: MutationHandler<T>
  onDelete?: MutationHandler<T>
}

/** A collection backed by an XDB namespace and schema, synced through `sync` and persisted through the given handlers. */
export function xdbCollectionOptions<T>(opts: XdbCollectionOptions<T>): CollectionOptions<T> {
  return {
    uri: opts.uri,
    schema: opts.schema,
    getKey: opts.getKey,
    sync: opts.sync,
    onInsert: opts.onInsert,
    onUpdate: opts.onUpdate,
    onDelete: opts.onDelete,
  }
}
