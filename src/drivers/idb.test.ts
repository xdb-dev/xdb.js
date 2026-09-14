import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { idb } from './idb.js'
import { runDriverSuite } from '../storetest/suite.js'

/** A fresh, collision-free database name for each driver instance. */
let counter = 0
function freshName(): string {
  counter += 1
  return `xdb-idb-test-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`
}

runDriverSuite('idb', () => idb(freshName()))

describe('idb: object store layout', () => {
  it('creates a tuples store keyed by [path, attr] with the two mandated indexes, and a defs store keyed by path', async () => {
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
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['defs', 'tuples'])
      const tx = db.transaction(['tuples', 'defs'], 'readonly')
      const tuples = tx.objectStore('tuples')
      expect(tuples.keyPath).toEqual(['path', 'attr'])
      expect(Array.from(tuples.indexNames).sort()).toEqual(['ns_schema', 'ns_schema_attr_value'])
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
