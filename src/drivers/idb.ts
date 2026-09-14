/**
 * An IndexedDB driver for xdb.js. Stores tuples in one object store and
 * definitions in a second object store, inside one IndexedDB database.
 */

import { alreadyExists, invalidURI, unsupported } from '../core/errors.js'
import { parseURI, recordPath } from '../core/uri.js'
import type { Def, Driver, Mutation, Tuple, TupleValue, ValueType } from '../core/types.js'
import { valueKey } from '../core/value.js'

const TUPLES_STORE = 'tuples'
const DEFS_STORE = 'defs'
const NS_SCHEMA_INDEX = 'ns_schema'
const VALUE_INDEX = 'ns_schema_attr_value'

/** Options for {@link idb}. */
export interface IDBOptions {
  /** Overrides the IndexedDB database name. Defaults to the `name` argument of {@link idb}. */
  name?: string
  /** Overrides the `IDBFactory`. Tests pass the `fake-indexeddb` factory. */
  factory?: IDBFactory
}

/** The shape of one tuple record in the `tuples` object store. */
interface StoredTuple {
  path: string
  attr: string
  value: TupleValue
  type?: ValueType
  items?: ValueType
  ns: string
  schema: string
  id: string
  valueKey: string
}

/** The shape of one definition record in the `defs` object store. */
interface StoredDef extends Def {
  path: string
}


/** Splits a record path `ns/schema/id` into its three parts. */
function splitRecordPath(path: string): { ns: string; schema: string; id: string } {
  const parts = path.split('/')
  if (parts.length !== 3) throw invalidURI(`"${path}" is not a record path`)
  const [ns, schema, id] = parts as [string, string, string]
  return { ns, schema, id }
}

function toTuple(rec: StoredTuple): Tuple {
  const t: Tuple = { path: rec.path, attr: rec.attr, value: rec.value }
  if (rec.type !== undefined) t.type = rec.type
  if (rec.items !== undefined) t.items = rec.items
  return t
}

function toStoredTuple(path: string, t: Tuple): StoredTuple {
  const { ns, schema, id } = splitRecordPath(path)
  const rec: StoredTuple = { path, attr: t.attr, value: t.value, ns, schema, id, valueKey: valueKey(t.value) }
  if (t.type !== undefined) rec.type = t.type
  if (t.items !== undefined) rec.items = t.items
  return rec
}

function toDef(rec: StoredDef): Def {
  const { path: _path, ...def } = rec
  return def
}

function toStoredDef(path: string, def: Def): StoredDef {
  return { ...def, path }
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function collectCursor<T>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const out: T[] = []
    const req = source.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve(out)
        return
      }
      out.push(cursor.value as T)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * The key range covering every tuple of one record. The empty array upper
 * sentinel is always greater than any string, per IndexedDB key ordering, so
 * it bounds the attr component regardless of its content.
 */
function recordKeyRange(path: string): IDBKeyRange {
  return IDBKeyRange.bound([path], [path, []])
}

async function getRecordTuples(store: IDBObjectStore, path: string): Promise<StoredTuple[]> {
  return collectCursor<StoredTuple>(store, recordKeyRange(path))
}

async function putStoredTuple(store: IDBObjectStore, path: string, t: Tuple): Promise<void> {
  await reqPromise(store.put(toStoredTuple(path, t)))
}

/** Applies one mutation to `store`, following the four-op table. */
async function applyMutation(store: IDBObjectStore, m: Mutation): Promise<void> {
  switch (m.op) {
    case 'create': {
      const existing = await getRecordTuples(store, m.path)
      if (existing.length > 0) throw alreadyExists(`"${m.path}" already exists`, { uri: m.path })
      for (const t of m.tuples ?? []) await putStoredTuple(store, m.path, t)
      return
    }
    case 'put': {
      const existing = await getRecordTuples(store, m.path)
      for (const old of existing) await reqPromise(store.delete([m.path, old.attr]))
      for (const t of m.tuples ?? []) await putStoredTuple(store, m.path, t)
      return
    }
    case 'patch': {
      for (const t of m.tuples ?? []) await putStoredTuple(store, m.path, t)
      return
    }
    case 'delete': {
      if (m.attrs && m.attrs.length > 0) {
        for (const attr of m.attrs) await reqPromise(store.delete([m.path, attr]))
      } else {
        const existing = await getRecordTuples(store, m.path)
        for (const old of existing) await reqPromise(store.delete([m.path, old.attr]))
      }
      return
    }
    default:
      throw unsupported(`unsupported op "${String(m.op)}"`)
  }
}

/** Collects the tuple rows of a scan scope: `ns`, `ns/schema`, or `ns/schema/id`. */
async function collectScopeRows(store: IDBObjectStore, scope: string): Promise<StoredTuple[]> {
  const parts = scope.split('/')
  if (parts.length === 3) {
    return getRecordTuples(store, parts.join('/'))
  }
  if (parts.length === 2) {
    const [ns, schema] = parts as [string, string]
    const index = store.index(NS_SCHEMA_INDEX)
    return collectCursor<StoredTuple>(index, IDBKeyRange.only([ns, schema]))
  }
  if (parts.length === 1) {
    const [ns] = parts as [string]
    const index = store.index(NS_SCHEMA_INDEX)
    return collectCursor<StoredTuple>(index, IDBKeyRange.bound([ns], [ns, []]))
  }
  throw invalidURI(`"${scope}" is not a valid scope`)
}

/** Every definition whose path is `scope` itself or nested under `scope/`. */
async function collectDefScopeRows(store: IDBObjectStore, scope: string): Promise<StoredDef[]> {
  const all = (await reqPromise(store.getAll())) as StoredDef[]
  return all.filter((d) => d.path === scope || d.path.startsWith(scope + '/'))
}

/** Runs a function against one object store, in its own transaction or a shared one. */
interface StoreRunner {
  tuples<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T>
  defs<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T>
}

/** A runner that opens a fresh, single-store transaction per call, and rolls it back on error. */
function topRunner(getDB: () => Promise<IDBDatabase>): StoreRunner {
  const run = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await getDB()
    const t = db.transaction(storeName, mode)
    try {
      const result = await fn(t.objectStore(storeName))
      await txDone(t)
      return result
    } catch (err) {
      try {
        t.abort()
      } catch {
        // the transaction may already be finished
      }
      throw err
    }
  }
  return {
    tuples: (mode, fn) => run(TUPLES_STORE, mode, fn),
    defs: (mode, fn) => run(DEFS_STORE, mode, fn),
  }
}

/** A runner scoped to one already-open transaction, shared by both stores. */
function scopedRunner(idbTx: IDBTransaction): StoreRunner {
  return {
    tuples: (_mode, fn) => fn(idbTx.objectStore(TUPLES_STORE)),
    defs: (_mode, fn) => fn(idbTx.objectStore(DEFS_STORE)),
  }
}

/** Builds every `Driver` method except `tx` and `close`, over a given `StoreRunner`. */
function buildDriverMethods(runner: StoreRunner): Omit<Driver, 'tx' | 'close'> {
  return {
    async getTuples(uris: string[]): Promise<Tuple[]> {
      return runner.tuples('readonly', async (store) => {
        const out: Tuple[] = []
        for (const raw of uris) {
          const parsed = parseURI(raw)
          if (!parsed.attr) throw invalidURI(`"${raw}" is not an attribute URI`)
          const path = recordPath(parsed)
          const rec = (await reqPromise(store.get([path, parsed.attr]))) as StoredTuple | undefined
          if (rec) out.push(toTuple(rec))
        }
        return out
      })
    },

    async *scanTuples(scope: string): AsyncGenerator<Tuple> {
      const rows = await runner.tuples('readonly', (store) => collectScopeRows(store, scope))
      for (const row of rows) yield toTuple(row)
    },

    async apply(m: Mutation): Promise<void> {
      await runner.tuples('readwrite', (store) => applyMutation(store, m))
    },

    async getSchema(path: string): Promise<Def | null> {
      const rec = (await runner.defs('readonly', (store) => reqPromise(store.get(path)))) as
        | StoredDef
        | undefined
      return rec ? toDef(rec) : null
    },

    async *scanSchemas(scope: string): AsyncGenerator<Def> {
      const rows = await runner.defs('readonly', (store) => collectDefScopeRows(store, scope))
      for (const row of rows) yield toDef(row)
    },

    async createSchema(def: Def): Promise<void> {
      const path = `${def.ns}/${def.schema}`
      await runner.defs('readwrite', async (store) => {
        const existing = await reqPromise(store.get(path))
        if (existing) throw alreadyExists(`schema "${path}" already exists`, { uri: path })
        await reqPromise(store.put(toStoredDef(path, def)))
      })
    },

    async putSchema(def: Def): Promise<void> {
      const path = `${def.ns}/${def.schema}`
      await runner.defs('readwrite', (store) => reqPromise(store.put(toStoredDef(path, def))))
    },

    async deleteSchema(path: string): Promise<void> {
      await runner.defs('readwrite', (store) => reqPromise(store.delete(path)))
    },

    async dropRecords(path: string): Promise<void> {
      const [ns, schema] = path.split('/') as [string, string]
      await runner.tuples('readwrite', async (store) => {
        const index = store.index(NS_SCHEMA_INDEX)
        const rows = await collectCursor<StoredTuple>(index, IDBKeyRange.only([ns, schema]))
        for (const row of rows) await reqPromise(store.delete([row.path, row.attr]))
      })
    },
  }
}

function openDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TUPLES_STORE)) {
        const tuples = db.createObjectStore(TUPLES_STORE, { keyPath: ['path', 'attr'] })
        tuples.createIndex(NS_SCHEMA_INDEX, ['ns', 'schema'])
        tuples.createIndex(VALUE_INDEX, ['ns', 'schema', 'attr', 'valueKey'])
      }
      if (!db.objectStoreNames.contains(DEFS_STORE)) {
        db.createObjectStore(DEFS_STORE, { keyPath: 'path' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error(`IndexedDB open blocked for database "${name}"`))
  })
}

/**
 * An IndexedDB driver. One object store holds tuples, keyed by `[path, attr]`,
 * with indexes on `[ns, schema]` and on `[ns, schema, attr, valueKey]`. A
 * second object store holds definitions verbatim, keyed by `ns/schema`.
 *
 * `apply` runs each mutation inside one IndexedDB transaction, so a `create`
 * on an existing path and a concurrent `create` race both resolve correctly:
 * IndexedDB serializes overlapping readwrite transactions on the same store.
 */
export function idb(name: string, opts: IDBOptions = {}): Driver {
  const dbName = opts.name ?? name
  const factory = opts.factory ?? indexedDB
  let dbPromise: Promise<IDBDatabase> | undefined
  const getDB = (): Promise<IDBDatabase> => {
    dbPromise ??= openDatabase(dbName, factory)
    return dbPromise
  }

  const methods = buildDriverMethods(topRunner(getDB))

  return {
    ...methods,

    async tx(fn: (t: Driver) => Promise<void>): Promise<void> {
      const db = await getDB()
      const idbTx = db.transaction([TUPLES_STORE, DEFS_STORE], 'readwrite')
      const scoped: Driver = buildDriverMethods(scopedRunner(idbTx))
      try {
        await fn(scoped)
      } catch (err) {
        try {
          idbTx.abort()
        } catch {
          // the transaction may already be finished
        }
        throw err
      }
      await txDone(idbTx)
    },

    async close(): Promise<void> {
      const db = await getDB()
      db.close()
    },
  }
}
