import { describe, expect, it } from 'vitest'
import type { Tuple } from '../core/types.js'
import { TupleIndex, valueKey } from './tuple-index.js'

function t(path: string, attr: string, value: Tuple['value']): Tuple {
  return { path, attr, value }
}

describe('valueKey', () => {
  it('gives a Date and its epoch milliseconds the same tag but keeps them distinguishable from numbers', () => {
    const d = new Date('2024-01-01T00:00:00.000Z')
    expect(valueKey(d)).toBe(valueKey(new Date(d.getTime())))
  })

  it('gives the integer 3, the float 3, and the bigint 3n the same key', () => {
    expect(valueKey(3)).toBe(valueKey(3.0))
    expect(valueKey(3)).toBe(valueKey(3n))
  })

  it('sorts object keys so two equal JSON objects give one key', () => {
    expect(valueKey({ a: 1, b: 2 })).toBe(valueKey({ b: 2, a: 1 }))
  })

  it('keys arrays and bytes distinctly from other types', () => {
    expect(valueKey([1, 2, 3])).not.toBe(valueKey({ 0: 1, 1: 2, 2: 3 }))
    expect(valueKey(new Uint8Array([1, 2, 3]))).toBe(valueKey(new Uint8Array([1, 2, 3])))
    expect(valueKey(new Uint8Array([1, 2, 3]))).not.toBe(valueKey(new Uint8Array([3, 2, 1])))
  })
})

describe('TupleIndex', () => {
  it('adds a tuple and makes it reachable through path, schema-attr, and value maps', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))

    expect(idx.get('app/posts/p-1', 'title')).toEqual({ path: 'app/posts/p-1', attr: 'title', value: 'Hello' })
    expect([...idx.bySchemaAttr('app/posts', 'title')]).toHaveLength(1)
    expect([...idx.byValue('Hello')]).toHaveLength(1)
    expect(idx.size).toBe(1)
  })

  it('replacing a value removes the old value-index entry', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'views', 3))
    expect([...idx.byValue(3)]).toHaveLength(1)

    idx.add(t('app/posts/p-1', 'views', 9))
    expect([...idx.byValue(3)]).toHaveLength(0)
    expect([...idx.byValue(9)]).toHaveLength(1)
    expect(idx.get('app/posts/p-1', 'views')?.value).toBe(9)
    expect(idx.size).toBe(1)
  })

  it('replacing a tuple keeps the schema-attr index at one entry, not two', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'views', 3))
    idx.add(t('app/posts/p-1', 'views', 9))
    expect([...idx.bySchemaAttr('app/posts', 'views')]).toHaveLength(1)
  })

  it('remove cleans the path, schema-attr, and value maps', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    idx.add(t('app/posts/p-1', 'views', 3))

    idx.remove('app/posts/p-1', 'title')
    expect(idx.get('app/posts/p-1', 'title')).toBeUndefined()
    expect([...idx.bySchemaAttr('app/posts', 'title')]).toHaveLength(0)
    expect([...idx.byValue('Hello')]).toHaveLength(0)
    // the record still holds 'views', so it must still exist
    expect(idx.has('app/posts/p-1')).toBe(true)
    expect(idx.size).toBe(1)
  })

  it('remove drops the record once it holds no more tuples', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    idx.remove('app/posts/p-1', 'title')
    expect(idx.has('app/posts/p-1')).toBe(false)
    expect(idx.attrs('app/posts/p-1')).toBeUndefined()
  })

  it('remove on an absent path or attr is a no-op', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    expect(() => idx.remove('app/posts/missing', 'title')).not.toThrow()
    expect(() => idx.remove('app/posts/p-1', 'missing')).not.toThrow()
    expect(idx.size).toBe(1)
  })

  it('removePath removes every tuple at a path and returns them', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    idx.add(t('app/posts/p-1', 'views', 3))
    idx.add(t('app/posts/p-2', 'title', 'Other'))

    const removed = idx.removePath('app/posts/p-1')
    expect(removed).toHaveLength(2)
    expect(idx.has('app/posts/p-1')).toBe(false)
    expect(idx.has('app/posts/p-2')).toBe(true)
    expect([...idx.bySchemaAttr('app/posts', 'title')]).toHaveLength(1)
    expect(idx.size).toBe(1)
  })

  it('removePath on an absent path returns an empty array', () => {
    const idx = new TupleIndex()
    expect(idx.removePath('app/posts/missing')).toEqual([])
  })

  it('attrs returns the live per-record map without letting the caller corrupt other indexes through it', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    const attrs = idx.attrs('app/posts/p-1')
    expect(attrs?.get('title')?.value).toBe('Hello')
  })

  it('scan at ns scope returns every tuple under that namespace', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/users/u-1', 'name', 'B'))
    idx.add(t('other/posts/p-1', 'title', 'C'))
    expect([...idx.scan('app')]).toHaveLength(2)
  })

  it('scan at schema scope returns every tuple of that schema only', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/posts/p-2', 'title', 'B'))
    idx.add(t('app/users/u-1', 'name', 'C'))
    expect([...idx.scan('app/posts')]).toHaveLength(2)
  })

  it('scan at record scope returns only that record', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/posts/p-1', 'views', 3))
    idx.add(t('app/posts/p-2', 'title', 'B'))
    expect([...idx.scan('app/posts/p-1')]).toHaveLength(2)
  })

  it('bySchema yields the tuples of one record contiguously', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/posts/p-2', 'title', 'B'))
    idx.add(t('app/posts/p-1', 'views', 1))
    idx.add(t('app/posts/p-2', 'views', 2))

    const tuples = [...idx.bySchema('app/posts')]
    expect(tuples).toHaveLength(4)
    const p1Indexes = tuples.map((x, i) => (x.path === 'app/posts/p-1' ? i : -1)).filter((i) => i >= 0)
    expect(p1Indexes).toEqual([p1Indexes[0], p1Indexes[0] + 1])
  })

  it('paths lists the record paths of one schema', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/posts/p-2', 'title', 'B'))
    idx.add(t('app/users/u-1', 'name', 'C'))
    expect([...idx.paths('app/posts')].sort()).toEqual(['app/posts/p-1', 'app/posts/p-2'])
  })

  it('all returns every tuple in the index', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    idx.add(t('app/users/u-1', 'name', 'B'))
    expect([...idx.all()]).toHaveLength(2)
  })

  it('clone is independent: mutating the clone does not affect the original, and vice versa', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'A'))
    const clone = idx.clone()

    clone.add(t('app/posts/p-2', 'title', 'B'))
    expect(idx.has('app/posts/p-2')).toBe(false)
    expect(clone.has('app/posts/p-2')).toBe(true)

    idx.remove('app/posts/p-1', 'title')
    expect(idx.has('app/posts/p-1')).toBe(false)
    expect(clone.has('app/posts/p-1')).toBe(true)

    expect(idx.size).toBe(0)
    expect(clone.size).toBe(2)
  })
})
