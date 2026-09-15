import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { idb } from './idb.js'
import { runDriverSuite } from '../storetest/suite.js'
import { TupleStore } from '../store/store.js'

/** A fresh, collision-free database name for each driver instance. */
let counter = 0
function freshName(): string {
  counter += 1
  return `xdb-idb-test-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`
}

runDriverSuite('idb', () => idb(freshName()))

describe('idb: object store layout', () => {
  it('creates a records store keyed by path with the ns_schema index, and a defs store keyed by path', async () => {
    const name = freshName()
    const driver = idb(name)
    // Force the database (and its object stores) to open.
    await driver.getSchema('ns/sch')

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['defs', 'records'])
      const tx = db.transaction(['records', 'defs'], 'readonly')
      const records = tx.objectStore('records')
      expect(records.keyPath).toEqual('path')
      expect(Array.from(records.indexNames)).toEqual(['ns_schema'])
      const defs = tx.objectStore('defs')
      expect(defs.keyPath).toEqual('path')
    } finally {
      db.close()
    }
  })
})

describe('idb: structured clone of native types', () => {
  it('stores and retrieves a Date and a Uint8Array value verbatim', async () => {
    const driver = idb(freshName())
    const path = 'ns/sch/rec-1'
    const when = new Date('2024-01-02T03:04:05.000Z')
    const bytes = new Uint8Array([1, 2, 3])
    await driver.apply({
      path,
      op: 'create',
      tuples: [
        { path, attr: 'when', value: when, type: 'time' },
        { path, attr: 'bytes', value: bytes, type: 'bytes' },
      ],
    })
    const [t1, t2] = await driver.getTuples([`xdb://${path}#when`, `xdb://${path}#bytes`])
    expect(t1?.value).toBeInstanceOf(Date)
    expect((t1?.value as Date).getTime()).toBe(when.getTime())
    expect(t2?.value).toBeInstanceOf(Uint8Array)
    expect(Array.from(t2?.value as Uint8Array)).toEqual([1, 2, 3])
  })

  it('preserves the type and items fields of a tuple verbatim', async () => {
    const driver = idb(freshName())
    const path = 'ns/sch/rec-2'
    await driver.apply({
      path,
      op: 'create',
      tuples: [{ path, attr: 'tags', value: ['a', 'b'], type: 'array', items: 'string' }],
    })
    const [t] = await driver.getTuples([`xdb://${path}#tags`])
    expect(t?.type).toBe('array')
    expect(t?.items).toBe('string')
  })
})

describe('idb: TupleStore.tx atomicity', () => {
  it('leaves no record of the transaction on disk when a later create fails', async () => {
    const driver = idb(freshName())
    // n2 exists on disk but not in the store index, so the store accepts the
    // create and the driver rejects it.
    const n2 = 'app/notes/n2'
    await driver.apply({ path: n2, op: 'create', tuples: [{ path: n2, attr: 'a', value: 0 }] })
    const store = await TupleStore.open({ driver })

    await expect(
      store.tx(async (t) => {
        await t.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
        await t.apply([{ path: n2, op: 'create', tuples: [{ path: n2, attr: 'a', value: 1 }] }])
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })

    expect(await driver.getTuples(['xdb://app/notes/n1#a'])).toEqual([])
    const [t] = await driver.getTuples([`xdb://${n2}#a`])
    expect(t?.value).toBe(0)
  })
})
