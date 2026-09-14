/**
 * Cross-realm values must behave like same-realm ones. A Date that crosses a
 * realm boundary, through an iframe, a worker, or a `structuredClone`
 * implementation from another context, fails `instanceof Date`. The library
 * must still treat it as a time.
 */
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { inferType, valueKey, isDate, isBytes, isPlainObject, coerce } from './value.js'
import { encodeRecord, decodeRecord, attrsOf } from './record.js'
import { diffItems } from '../collection/diff.js'

// A real second realm, so these objects genuinely fail instanceof.
const other = vm.runInNewContext(
  '({ date: new Date("2026-09-13T00:00:00Z"), bytes: new Uint8Array([1,2,3]), arr: [1,2], obj: { a: 1 } })',
)
const foreignDate = other.date as Date
const foreignBytes = other.bytes as Uint8Array
const foreignArray = other.arr as number[]
const foreignObject = other.obj as Record<string, unknown>

describe('cross-realm values', () => {
  it('the premise holds: instanceof fails across realms', () => {
    expect(foreignDate instanceof Date).toBe(false)
    expect(foreignBytes instanceof Uint8Array).toBe(false)
  })

  it('the brand checks still recognize them', () => {
    expect(isDate(foreignDate)).toBe(true)
    expect(isBytes(foreignBytes)).toBe(true)
    expect(isPlainObject(foreignDate)).toBe(false)
    expect(isPlainObject(foreignBytes)).toBe(false)
    expect(isPlainObject(foreignArray)).toBe(false)
    expect(isPlainObject(foreignObject)).toBe(true)
  })

  it('infers a foreign Date as time and foreign bytes as bytes', () => {
    expect(inferType(foreignDate)).toBe('time')
    expect(inferType(foreignBytes)).toBe('bytes')
  })

  it('keys a foreign Date like a native one', () => {
    expect(valueKey(foreignDate)).toBe(valueKey(new Date('2026-09-13T00:00:00Z')))
  })

  it('coerces a foreign Date to time without wrapping it in an object', () => {
    expect(valueKey(coerce(foreignDate, 'time'))).toBe(valueKey(new Date('2026-09-13T00:00:00Z')))
  })

  it('encodes a foreign Date as one leaf, not an empty object', () => {
    const tuples = encodeRecord('app/posts/p-1', { title: 'x', createdAt: foreignDate })
    expect(tuples.map((t) => t.attr).sort()).toEqual(['createdAt', 'title'])
    expect(attrsOf({ createdAt: foreignDate })).toEqual(['createdAt'])
  })

  it('does not report a foreign Date as a removed attribute', () => {
    // The bug this guards: a cloned Date became a plain object with no keys, so
    // the diff reported the attribute as deleted and the write hit a required
    // field.
    const before = { title: 'x', createdAt: new Date('2026-09-13T00:00:00Z'), views: 1 }
    const after = { title: 'x', createdAt: foreignDate, views: 2 }
    const { tuples, attrs } = diffItems(before, after, 'app/posts/p-1')
    expect(attrs).toEqual([])
    expect(tuples.map((t) => t.attr)).toEqual(['views'])
  })

  it('round-trips a record that holds foreign values', () => {
    const tuples = encodeRecord('app/posts/p-1', { at: foreignDate, blob: foreignBytes, tags: foreignArray })
    const back = decodeRecord(tuples)
    expect(valueKey(back.at)).toBe(valueKey(new Date('2026-09-13T00:00:00Z')))
    expect(isBytes(back.blob)).toBe(true)
    expect(back.tags).toEqual([1, 2])
  })
})
