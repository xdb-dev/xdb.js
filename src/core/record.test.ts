import { describe, expect, it } from 'vitest'
import type { Tuple } from './types.js'
import { attrsOf, decodeRecord, encodeRecord, getIn, setIn } from './record.js'

const PATH = 'app/posts/p-1'

function byAttr(tuples: Tuple[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const t of tuples) out[t.attr] = t.value
  return out
}

describe('encodeRecord', () => {
  it('encodes flat fields to tuples at the path', () => {
    const tuples = encodeRecord(PATH, { title: 'Hello', views: 3 })
    expect(tuples.every((t) => t.path === PATH)).toBe(true)
    expect(byAttr(tuples)).toEqual({ title: 'Hello', views: 3 })
  })

  it('folds a nested plain object into dotted attributes', () => {
    const tuples = encodeRecord(PATH, { meta: { lang: 'en', deep: { x: 1 } } })
    expect(byAttr(tuples)).toEqual({ 'meta.lang': 'en', 'meta.deep.x': 1 })
  })

  it('treats an array as one leaf tuple', () => {
    const tuples = encodeRecord(PATH, { tags: ['a', 'b'] })
    expect(byAttr(tuples)).toEqual({ tags: ['a', 'b'] })
  })

  it('treats a Date as one leaf tuple, not folded', () => {
    const d = new Date('2026-01-01T00:00:00Z')
    const tuples = encodeRecord(PATH, { updated: d })
    expect(byAttr(tuples)).toEqual({ updated: d })
  })

  it('treats a Uint8Array as one leaf tuple, not folded', () => {
    const b = new Uint8Array([1, 2, 3])
    const tuples = encodeRecord(PATH, { blob: b })
    expect(byAttr(tuples)).toEqual({ blob: b })
  })

  it('skips the id key', () => {
    const tuples = encodeRecord(PATH, { id: 'p-1', title: 'Hello' })
    expect(byAttr(tuples)).toEqual({ title: 'Hello' })
  })

  it('skips underscore-prefixed keys by default', () => {
    const tuples = encodeRecord(PATH, { title: 'Hello', _version: 2, _updated: new Date() })
    expect(byAttr(tuples)).toEqual({ title: 'Hello' })
  })

  it('keeps underscore-prefixed keys when system is true', () => {
    const tuples = encodeRecord(PATH, { title: 'Hello', _version: 2 }, { system: true })
    expect(byAttr(tuples)).toEqual({ title: 'Hello', _version: 2 })
  })

  it('skips an undefined leaf value', () => {
    const tuples = encodeRecord(PATH, { title: 'Hello', subtitle: undefined })
    expect(byAttr(tuples)).toEqual({ title: 'Hello' })
  })
})

describe('decodeRecord', () => {
  it('unfolds a dotted attribute into a nested object', () => {
    const tuples: Tuple[] = [
      { path: PATH, attr: 'meta.lang', value: 'en' },
      { path: PATH, attr: 'meta.deep.x', value: 1 },
    ]
    expect(decodeRecord(tuples)).toEqual({ meta: { lang: 'en', deep: { x: 1 } } })
  })

  it('turns _id into id', () => {
    const tuples: Tuple[] = [{ path: PATH, attr: '_id', value: 'p-1' }]
    expect(decodeRecord(tuples)).toEqual({ id: 'p-1' })
  })

  it('drops other system attributes by default', () => {
    const tuples: Tuple[] = [
      { path: PATH, attr: '_id', value: 'p-1' },
      { path: PATH, attr: '_version', value: 2 },
      { path: PATH, attr: 'title', value: 'Hello' },
    ]
    expect(decodeRecord(tuples)).toEqual({ id: 'p-1', title: 'Hello' })
  })

  it('keeps other system attributes when system is true', () => {
    const tuples: Tuple[] = [
      { path: PATH, attr: '_id', value: 'p-1' },
      { path: PATH, attr: '_version', value: 2 },
      { path: PATH, attr: 'title', value: 'Hello' },
    ]
    expect(decodeRecord(tuples, { system: true })).toEqual({ id: 'p-1', _version: 2, title: 'Hello' })
  })
})

describe('encodeRecord / decodeRecord round trip', () => {
  it('round-trips a flat object', () => {
    const obj = { title: 'Hello', views: 3, active: true }
    expect(decodeRecord(encodeRecord(PATH, obj))).toEqual(obj)
  })

  it('round-trips nested objects', () => {
    const obj = { meta: { lang: 'en', deep: { x: 1, y: 2 } }, title: 'Hello' }
    expect(decodeRecord(encodeRecord(PATH, obj))).toEqual(obj)
  })

  it('round-trips arrays', () => {
    const obj = { tags: ['a', 'b', 'c'], nums: [1, 2, 3] }
    expect(decodeRecord(encodeRecord(PATH, obj))).toEqual(obj)
  })

  it('round-trips a Date', () => {
    const obj = { updated: new Date('2026-01-01T00:00:00Z') }
    expect(decodeRecord(encodeRecord(PATH, obj))).toEqual(obj)
  })

  it('round-trips a Uint8Array', () => {
    const obj = { blob: new Uint8Array([1, 2, 3]) }
    expect(decodeRecord(encodeRecord(PATH, obj))).toEqual(obj)
  })

  it('round-trips dotted attributes and system fields together', () => {
    const obj = {
      id: 'p-1',
      title: 'Hello',
      author: { name: 'Ravi', id: 'u-1' },
      _version: 2,
      _updated: new Date('2026-01-01T00:00:00Z'),
    }
    const tuples = encodeRecord(PATH, obj, { system: true })
    // encodeRecord skips the top-level `id` key (it lives in the path), so add
    // an explicit `_id` tuple the way the store would, then decode it back.
    tuples.push({ path: PATH, attr: '_id', value: 'p-1' })
    expect(decodeRecord(tuples, { system: true })).toEqual(obj)
  })
})

describe('getIn', () => {
  it('reads a shallow path', () => {
    expect(getIn({ title: 'Hello' }, 'title')).toBe('Hello')
  })

  it('reads a deep path', () => {
    expect(getIn({ meta: { deep: { x: 1 } } }, 'meta.deep.x')).toBe(1)
  })

  it('returns undefined for a missing path', () => {
    expect(getIn({ meta: {} }, 'meta.deep.x')).toBeUndefined()
    expect(getIn({}, 'a.b.c')).toBeUndefined()
  })

  it('returns undefined when a segment is not an object', () => {
    expect(getIn({ title: 'Hello' }, 'title.x')).toBeUndefined()
  })
})

describe('setIn', () => {
  it('writes a shallow path', () => {
    const obj: Record<string, unknown> = {}
    setIn(obj, 'title', 'Hello')
    expect(obj).toEqual({ title: 'Hello' })
  })

  it('creates intermediate objects for a deep path', () => {
    const obj: Record<string, unknown> = {}
    setIn(obj, 'meta.deep.x', 1)
    expect(obj).toEqual({ meta: { deep: { x: 1 } } })
  })

  it('merges into an existing intermediate object', () => {
    const obj: Record<string, unknown> = { meta: { lang: 'en' } }
    setIn(obj, 'meta.deep.x', 1)
    expect(obj).toEqual({ meta: { lang: 'en', deep: { x: 1 } } })
  })

  it('overwrites a non-object intermediate value', () => {
    const obj: Record<string, unknown> = { meta: 'flat' }
    setIn(obj, 'meta.deep.x', 1)
    expect(obj).toEqual({ meta: { deep: { x: 1 } } })
  })
})

describe('attrsOf', () => {
  it('lists dotted attribute names in encode order', () => {
    const obj = { title: 'Hello', meta: { lang: 'en', deep: { x: 1 } }, views: 3 }
    expect(attrsOf(obj)).toEqual(['title', 'meta.lang', 'meta.deep.x', 'views'])
  })

  it('applies the id and system-attr skip rules', () => {
    const obj = { id: 'p-1', title: 'Hello', _version: 2 }
    expect(attrsOf(obj)).toEqual(['title'])
    expect(attrsOf(obj, { system: true })).toEqual(['title', '_version'])
  })

  it('matches the attrs that encodeRecord produces', () => {
    const obj = { title: 'Hello', meta: { lang: 'en' }, _version: 2 }
    expect(attrsOf(obj, { system: true })).toEqual(encodeRecord(PATH, obj, { system: true }).map((t) => t.attr))
  })
})
