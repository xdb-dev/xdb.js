import { describe, expect, it } from 'vitest'
import { isXDBError } from './errors.js'
import { coerce, inferItems, inferType, isSystemAttr, toTuple, valueEquals, valueKey } from './value.js'

describe('inferType', () => {
  it('infers string', () => {
    expect(inferType('hi')).toBe('string')
  })

  it('infers boolean', () => {
    expect(inferType(true)).toBe('boolean')
    expect(inferType(false)).toBe('boolean')
  })

  it('infers time from a Date', () => {
    expect(inferType(new Date())).toBe('time')
  })

  it('infers bytes from a Uint8Array', () => {
    expect(inferType(new Uint8Array([1, 2, 3]))).toBe('bytes')
  })

  it('infers array', () => {
    expect(inferType([1, 2, 3])).toBe('array')
  })

  it('infers integer for an integer number', () => {
    expect(inferType(3)).toBe('integer')
    expect(inferType(0)).toBe('integer')
    expect(inferType(-42)).toBe('integer')
  })

  it('infers float for a non-integer number', () => {
    expect(inferType(3.5)).toBe('float')
    expect(inferType(-0.1)).toBe('float')
  })

  it('infers integer for a bigint', () => {
    expect(inferType(3n)).toBe('integer')
    expect(inferType(9007199254740993n)).toBe('integer')
  })

  it('infers json for a plain object', () => {
    expect(inferType({ a: 1 })).toBe('json')
    expect(inferType({})).toBe('json')
  })

  it('throws SCHEMA_VIOLATION for null', () => {
    try {
      inferType(null)
      expect.unreachable()
    } catch (e) {
      expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
    }
  })

  it('throws SCHEMA_VIOLATION for undefined', () => {
    try {
      inferType(undefined)
      expect.unreachable()
    } catch (e) {
      expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
    }
  })
})

describe('inferItems', () => {
  it('infers the common element type', () => {
    expect(inferItems([1, 2, 3])).toBe('integer')
    expect(inferItems(['a', 'b'])).toBe('string')
    expect(inferItems([true, false])).toBe('boolean')
  })

  it('returns json for a mixed array', () => {
    expect(inferItems([1, 'a'])).toBe('json')
    expect(inferItems([1, 2.5])).toBe('json')
  })

  it('returns json for an empty array', () => {
    expect(inferItems([])).toBe('json')
  })
})

describe('coerce', () => {
  describe('string', () => {
    it('accepts a string', () => {
      expect(coerce('hi', 'string')).toBe('hi')
    })
    it('rejects a number', () => {
      expect(() => coerce(3, 'string')).toThrow()
      try {
        coerce(3, 'string')
      } catch (e) {
        expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
      }
    })
  })

  describe('boolean', () => {
    it('accepts a boolean', () => {
      expect(coerce(true, 'boolean')).toBe(true)
    })
    it('rejects a non-boolean', () => {
      expect(() => coerce('true', 'boolean')).toThrow()
    })
  })

  describe('integer', () => {
    it('accepts a number', () => {
      expect(coerce(3, 'integer')).toBe(3)
    })
    it('accepts a bigint', () => {
      expect(coerce(3n, 'integer')).toBe(3n)
    })
    it('accepts a numeric string', () => {
      expect(coerce('42', 'integer')).toBe(42)
    })
    it('parses an overflowing numeric string to bigint', () => {
      expect(coerce('9007199254740993', 'integer')).toBe(9007199254740993n)
    })
    it('rejects a float number', () => {
      expect(() => coerce(3.5, 'integer')).toThrow()
    })
    it('rejects a non-numeric string', () => {
      expect(() => coerce('abc', 'integer')).toThrow()
    })
    it('rejects a boolean', () => {
      expect(() => coerce(true, 'integer')).toThrow()
    })
  })

  describe('unsigned', () => {
    it('accepts a non-negative number', () => {
      expect(coerce(3, 'unsigned')).toBe(3)
      expect(coerce(0, 'unsigned')).toBe(0)
    })
    it('rejects a negative number', () => {
      expect(() => coerce(-3, 'unsigned')).toThrow()
      try {
        coerce(-3, 'unsigned')
      } catch (e) {
        expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
      }
    })
    it('rejects a negative bigint', () => {
      expect(() => coerce(-3n, 'unsigned')).toThrow()
    })
    it('rejects a negative numeric string', () => {
      expect(() => coerce('-3', 'unsigned')).toThrow()
    })
  })

  describe('float', () => {
    it('accepts a number', () => {
      expect(coerce(3.5, 'float')).toBe(3.5)
      expect(coerce(3, 'float')).toBe(3)
    })
    it('accepts a numeric string', () => {
      expect(coerce('3.5', 'float')).toBe(3.5)
    })
    it('rejects a non-numeric string', () => {
      expect(() => coerce('abc', 'float')).toThrow()
    })
    it('rejects a boolean', () => {
      expect(() => coerce(true, 'float')).toThrow()
    })
  })

  describe('time', () => {
    it('accepts a Date', () => {
      const d = new Date('2026-01-01T00:00:00Z')
      expect(coerce(d, 'time')).toBe(d)
    })
    it('accepts an RFC 3339 string', () => {
      const out = coerce('2026-01-01T00:00:00Z', 'time')
      expect(out).toBeInstanceOf(Date)
      expect((out as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    })
    it('accepts epoch milliseconds', () => {
      const ms = 1735689600000
      const out = coerce(ms, 'time')
      expect(out).toBeInstanceOf(Date)
      expect((out as Date).getTime()).toBe(ms)
    })
    it('rejects an unparseable string', () => {
      expect(() => coerce('not a date', 'time')).toThrow()
    })
    it('rejects other types', () => {
      expect(() => coerce(true, 'time')).toThrow()
    })
  })

  describe('bytes', () => {
    it('accepts a Uint8Array', () => {
      const b = new Uint8Array([1, 2, 3])
      expect(coerce(b, 'bytes')).toBe(b)
    })
    it('accepts an ArrayBuffer', () => {
      const buf = new Uint8Array([1, 2, 3]).buffer
      const out = coerce(buf, 'bytes')
      expect(out).toBeInstanceOf(Uint8Array)
      expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3])
    })
    it('rejects other types', () => {
      expect(() => coerce('abc', 'bytes')).toThrow()
    })
  })

  describe('json', () => {
    it('accepts any JSON value', () => {
      expect(coerce({ a: 1, b: [1, 'x', null, true] }, 'json')).toEqual({ a: 1, b: [1, 'x', null, true] })
      expect(coerce(null, 'json')).toBe(null)
      expect(coerce(3, 'json')).toBe(3)
    })
    it('rejects a Date', () => {
      expect(() => coerce(new Date(), 'json')).toThrow()
    })
    it('rejects a Uint8Array', () => {
      expect(() => coerce(new Uint8Array([1]), 'json')).toThrow()
    })
  })

  describe('array', () => {
    it('coerces every element to the given items type', () => {
      expect(coerce(['1', '2', '3'], 'array', 'integer')).toEqual([1, 2, 3])
    })
    it('defaults items to the inferred element type', () => {
      expect(coerce([1, 2, 3], 'array')).toEqual([1, 2, 3])
    })
    it('rejects a non-array', () => {
      expect(() => coerce('abc', 'array')).toThrow()
    })
    it('propagates a failing element coercion', () => {
      expect(() => coerce(['1', 'abc'], 'array', 'integer')).toThrow()
    })
  })
})

describe('valueKey', () => {
  it('gives a Date and its epoch milliseconds the same key', () => {
    const ms = 1735689600000
    const d = new Date(ms)
    expect(valueKey(d)).toBe(valueKey(ms))
  })

  it('gives the integer 3 and the float 3 the same key', () => {
    expect(valueKey(3n)).toBe(valueKey(3.0))
    expect(valueKey(3)).toBe(valueKey(3.0))
  })

  it('sorts object keys, so two equal JSON objects give one key', () => {
    expect(valueKey({ a: 1, b: 2 })).toBe(valueKey({ b: 2, a: 1 }))
  })

  it('gives different keys to different types with visually similar values', () => {
    expect(valueKey('3')).not.toBe(valueKey(3))
    expect(valueKey(true)).not.toBe(valueKey('true'))
  })

  it('is stable for nested arrays and objects', () => {
    const a = { x: [1, { y: 'z' }] }
    const b = { x: [1, { y: 'z' }] }
    expect(valueKey(a)).toBe(valueKey(b))
  })
})

describe('valueEquals', () => {
  it('uses valueKey for equality', () => {
    expect(valueEquals(new Date(1000), 1000)).toBe(true)
    expect(valueEquals(3, 3.0)).toBe(true)
    expect(valueEquals(3, 4)).toBe(false)
    expect(valueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })
})

describe('toTuple', () => {
  it('normalizes the array form', () => {
    expect(toTuple(['app/posts/p-1', 'title', 'Hello'])).toEqual({
      path: 'app/posts/p-1',
      attr: 'title',
      value: 'Hello',
    })
  })

  it('passes through the object form', () => {
    const t = { path: 'app/posts/p-1', attr: 'title', value: 'Hello' }
    expect(toTuple(t)).toEqual(t)
  })
})

describe('isSystemAttr', () => {
  it('is true for an underscore-prefixed attribute', () => {
    expect(isSystemAttr('_id')).toBe(true)
    expect(isSystemAttr('_version')).toBe(true)
  })

  it('is false for a normal attribute', () => {
    expect(isSystemAttr('title')).toBe(false)
    expect(isSystemAttr('author.name')).toBe(false)
  })
})
