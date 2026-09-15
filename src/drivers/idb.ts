/**
 * An IndexedDB driver for xdb.js. Stores one row per record in one object
 * store and definitions in a second object store, inside one IndexedDB
 * database.
 */

import { alreadyExists, invalidURI, unsupported } from '../core/errors.js'
import { parseURI, recordPath } from '../core/uri.js'
import type { Def, Driver, Mutation, Tuple, TupleValue, ValueType } from '../core/types.js'

const RECORDS_STORE = 'records'
const DEFS_STORE = 'defs'
const NS_SCHEMA_INDEX = 'ns_schema'

/** Options for {@link idb}. */
export interface IDBOptions {
  /** Overrides the IndexedDB database name. Defaults to the `name` argument of {@link idb}. */
  name?: string
  /** Overrides the `IDBFactory`. Tests pass the `fake-indexeddb` factory. */
  factory?: IDBFactory
}

/** The value, type, and items of one attribute of a stored record. */
interface StoredAttr {
  value: TupleValue
  type?: ValueType
  items?: ValueType
}

/**
 * The shape of one record row in the `records` object store. `attrs` is keyed
 * by the dotted attribute name. A stored row always holds at least one attribute.
 */
interface StoredRecord {
  path: string
  ns: string
  schema: string
  attrs: Map<string, StoredAttr>
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

function toTuple(path: string, attr: string, a: StoredAttr): Tuple {
  const t: Tuple = { path, attr, value: a.value }
  if (a.type !== undefined) t.type = a.type
  if (a.items !== undefined) t.items = a.items
  return t
}

function toStoredAttr(t: Tuple): StoredAttr {
  const a: StoredAttr = { value: t.value }
  if (t.type !== undefined) a.type = t.type
  if (t.items !== undefined) a.items = t.items
  return a
}

function rowToTuples(row: StoredRecord): Tuple[] {
  const out: Tuple[] = []
  for (const [attr, a] of row.attrs) out.push(toTuple(row.path, attr, a))
  return out
}

function tuplesToRow(path: string, tuples: Tuple[]): StoredRecord {
  const { ns, schema } = splitRecordPath(path)
  const row: StoredRecord = { path, ns, schema, attrs: new Map() }
  for (const t of tuples) row.attrs.set(t.attr, toStoredAttr(t))
  return row
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

async function getRow(store: IDBObjectStore, path: string): Promise<StoredRecord | undefined> {
  return (await reqPromise(store.get(path))) as StoredRecord | undefined
}

/** Writes `row`, or deletes it when it holds no attributes. */
async function writeRow(store: IDBObjectStore, row: StoredRecord): Promise<void> {
  if (row.attrs.size === 0) await reqPromise(store.delete(row.path))
  else await reqPromise(store.put(row))
}

/** Applies one mutation to `store`, following the four-op table. */
async function applyMutation(store: IDBObjectStore, m: Mutation): Promise<void> {
  switch (m.op) {
    case 'create': {
      if (await getRow(store, m.path)) throw alreadyExists(`"${m.path}" already exists`, { uri: m.path })
      await writeRow(store, tuplesToRow(m.path, m.tuples ?? []))
      return
    }
    case 'put': {
      await writeRow(store, tuplesToRow(m.path, m.tuples ?? []))
      return
    }
    case 'patch': {
      const row = (await getRow(store, m.path)) ?? tuplesToRow(m.path, [])
      for (const t of m.tuples ?? []) row.attrs.set(t.attr, toStoredAttr(t))
      await writeRow(store, row)
      return
    }
    case 'delete': {
      if (m.attrs && m.attrs.length > 0) {
        const row = await getRow(store, m.path)
        if (!row) return
        for (const attr of m.attrs) row.attrs.delete(attr)
        await writeRow(store, row)
      } else {
        await reqPromise(store.delete(m.path))
      }
      return
    }
    default:
      throw unsupported(`unsupported op "${String(m.op)}"`)
  }
}

/** Collects the record rows of a scan scope: `ns`, `ns/schema`, or `ns/schema/id`. */
async function collectScopeRows(store: IDBObjectStore, scope: string): Promise<StoredRecord[]> {
  const parts = scope.split('/')
  if (parts.length === 3) {
    const row = await getRow(store, parts.join('/'))
    return row ? [row] : []
  }
  const index = store.index(NS_SCHEMA_INDEX)
  if (parts.length === 2) {
    const [ns, schema] = parts as [string, string]
    return (await reqPromise(index.getAll(IDBKeyRange.only([ns, schema])))) as StoredRecord[]
  }
  if (parts.length === 1) {
    const [ns] = parts as [string]
    return (await reqPromise(index.getAll(IDBKeyRange.bound([ns], [ns, []])))) as StoredRecord[]
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
  records<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T>
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
    records: (mode, fn) => run(RECORDS_STORE, mode, fn),
    defs: (mode, fn) => run(DEFS_STORE, mode, fn),
  }
}

/** A runner scoped to one already-open transaction, shared by both stores. */
function scopedRunner(idbTx: IDBTransaction): StoreRunner {
  return {
    records: (_mode, fn) => fn(idbTx.objectStore(RECORDS_STORE)),
    defs: (_mode, fn) => fn(idbTx.objectStore(DEFS_STORE)),
  }
}

/** Builds every `Driver` method except `tx` and `close`, over a given `StoreRunner`. */
function buildDriverMethods(runner: StoreRunner): Omit<Driver, 'tx' | 'close'> {
  return {
    async getTuples(uris: string[]): Promise<Tuple[]> {
      return runner.records('readonly', async (store) => {
        const out: Tuple[] = []
        const rows = new Map<string, StoredRecord | undefined>()
        for (const raw of uris) {
          const parsed = parseURI(raw)
          if (!parsed.attr) throw invalidURI(`"${raw}" is not an attribute URI`)
          const path = recordPath(parsed)
          if (!rows.has(path)) rows.set(path, await getRow(store, path))
          const a = rows.get(path)?.attrs.get(parsed.attr)
          if (a) out.push(toTuple(path, parsed.attr, a))
        }
        return out
      })
    },

    async *scanTuples(scope: string): AsyncGenerator<Tuple> {
      const rows = await runner.records('readonly', (store) => collectScopeRows(store, scope))
      for (const row of rows) yield* rowToTuples(row)
    },

    async apply(m: Mutation): Promise<void> {
      await runner.records('readwrite', (store) => applyMutation(store, m))
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
      await runner.records('readwrite', async (store) => {
        const index = store.index(NS_SCHEMA_INDEX)
        const keys = await reqPromise(index.getAllKeys(IDBKeyRange.only([ns, schema])))
        for (const key of keys) await reqPromise(store.delete(key))
      })
    },
  }
}

function openDatabase(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        const records = db.createObjectStore(RECORDS_STORE, { keyPath: 'path' })
        records.createIndex(NS_SCHEMA_INDEX, ['ns', 'schema'])
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
 * An IndexedDB driver. One object store holds one row per record, keyed by
 * `path`, with an index on `[ns, schema]`. A second object store holds
 * definitions verbatim, keyed by `ns/schema`.
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
      const idbTx = db.transaction([RECORDS_STORE, DEFS_STORE], 'readwrite')
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
