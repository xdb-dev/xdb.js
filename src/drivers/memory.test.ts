import { describe, expect, it } from 'vitest'
import { isXDBError } from '../core/errors.js'
import type { Def } from '../core/types.js'
import { runDriverSuite } from '../storetest/suite.js'
import { memory } from './memory.js'

runDriverSuite('memory', () => memory())

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('memory(): the four-op table, directly', () => {
  it('create on an absent path writes the full tuple set', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['a'])
  })

  it('create on an existing path throws ALREADY_EXISTS and leaves the record untouched', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    await expect(d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 2 }] })).rejects.toSatisfy((e) =>
      isXDBError(e, 'ALREADY_EXISTS'),
    )
    expect((await collect(d.scanTuples(path)))[0]!.value).toBe(1)
  })

  it('put on an absent path writes the full tuple set', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'put', tuples: [{ path, attr: 'a', value: 1 }] })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['a'])
  })

  it('put on an existing path replaces the full tuple set', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }, { path, attr: 'b', value: 2 }] })
    await d.apply({ path, op: 'put', tuples: [{ path, attr: 'c', value: 3 }] })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['c'])
  })

  it('patch on an absent path creates the record', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'patch', tuples: [{ path, attr: 'a', value: 1 }] })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['a'])
  })

  it('patch on an existing path overlays only the named attributes', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }, { path, attr: 'b', value: 2 }] })
    await d.apply({ path, op: 'patch', tuples: [{ path, attr: 'b', value: 20 }] })
    const tuples = await collect(d.scanTuples(path))
    expect(tuples.find((t) => t.attr === 'a')?.value).toBe(1)
    expect(tuples.find((t) => t.attr === 'b')?.value).toBe(20)
  })

  it('delete on an absent path is a no-op', async () => {
    const d = memory()
    await expect(d.apply({ path: 'ns/sch/missing', op: 'delete' })).resolves.toBeUndefined()
  })

  it('delete with no attrs removes the whole record', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    await d.apply({ path, op: 'delete' })
    expect(await collect(d.scanTuples(path))).toEqual([])
  })

  it('delete with attrs removes only the named attributes', async () => {
    const d = memory()
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }, { path, attr: 'b', value: 2 }] })
    await d.apply({ path, op: 'delete', attrs: ['a'] })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['b'])
  })
})

describe('memory(): tx', () => {
  it('commits every write when the callback resolves', async () => {
    const d = memory()
    if (!d.tx) throw new Error('memory() must implement tx')
    const path = 'ns/sch/p1'
    await d.tx(async (t) => {
      await t.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    })
    expect((await collect(d.scanTuples(path))).map((t) => t.attr)).toEqual(['a'])
  })

  it('rolls back every write when the callback throws, restoring the index byte-for-byte', async () => {
    const d = memory()
    if (!d.tx) throw new Error('memory() must implement tx')
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })

    await expect(
      d.tx!(async (t) => {
        await t.apply({ path, op: 'patch', tuples: [{ path, attr: 'a', value: 2 }] })
        await t.apply({ path, op: 'patch', tuples: [{ path, attr: 'b', value: 9 }] })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const tuples = await collect(d.scanTuples(path))
    expect(tuples.map((t) => t.attr)).toEqual(['a'])
    expect(tuples[0]!.value).toBe(1)
  })

  it('rolls back schema writes too', async () => {
    const d = memory()
    if (!d.tx) throw new Error('memory() must implement tx')
    const def: Def = { ns: 'ns', schema: 'sch', mode: 'flexible', fields: {} }
    await expect(
      d.tx!(async (t) => {
        await t.createSchema(def)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await d.getSchema('ns/sch')).toBeNull()
  })
})

describe('memory(): definitions', () => {
  it('createSchema then getSchema round-trips verbatim', async () => {
    const d = memory()
    const def: Def = { ns: 'ns', schema: 'sch', mode: 'strict', fields: { a: { type: 'string' } } }
    await d.createSchema(def)
    expect(await d.getSchema('ns/sch')).toEqual(def)
  })

  it('dropRecords removes records but keeps the definition', async () => {
    const d = memory()
    const def: Def = { ns: 'ns', schema: 'sch', mode: 'flexible', fields: {} }
    await d.createSchema(def)
    const path = 'ns/sch/p1'
    await d.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    await d.dropRecords('ns/sch')
    expect(await collect(d.scanTuples('ns/sch'))).toEqual([])
    expect(await d.getSchema('ns/sch')).toEqual(def)
  })
})
