/**
 * Value-level rules shared by the whole library: type inference, coercion,
 * the stable key used for equality and indexing, and tuple normalization.
 */
import { schemaViolation } from './errors.js'
import type { JSONValue, Tuple, TupleInput, TupleValue, ValueType } from './types.js'

/** A short, safe description of a value, for error messages. */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  return `${typeof v} ${String(v)}`
}

/**
 * True when `v` is a Date, including one that came from another realm. A value
 * that crosses a realm boundary, through an iframe, a worker, or a
 * `structuredClone` polyfill, fails `instanceof Date`, so this reads the
 * object brand instead.
 */
export function isDate(v: unknown): v is Date {
  return Object.prototype.toString.call(v) === '[object Date]'
}

/** True when `v` is a Uint8Array, including one from another realm. */
export function isBytes(v: unknown): v is Uint8Array {
  return Object.prototype.toString.call(v) === '[object Uint8Array]'
}

/** True when `v` is an ArrayBuffer, including one from another realm. */
export function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]'
}

/**
 * True when `v` is a plain object: not null, not an array, not a Date, and not
 * binary data. Only a plain object folds into dotted attributes.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !isDate(v) && !isBytes(v) && !isArrayBuffer(v)
}

/**
 * Infers the XDB type of a JavaScript value. A string is `string`, a boolean
 * is `boolean`, a `Date` is `time`, a `Uint8Array` is `bytes`, an `Array` is
 * `array`, a `bigint` is `integer`, a plain object is `json`. A `number` is
 * `integer` when `Number.isInteger` is true, and `float` otherwise. `null`
 * and `undefined` throw `SCHEMA_VIOLATION`.
 */
export function inferType(v: unknown): ValueType {
  if (v === null || v === undefined) {
    throw schemaViolation('cannot infer the type of null or undefined')
  }
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (isDate(v)) return 'time'
  if (isBytes(v)) return 'bytes'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'bigint') return 'integer'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'float'
  if (typeof v === 'object') return 'json'
  throw schemaViolation(`cannot infer the type of a ${typeof v}`)
}

/**
 * Infers the element type of an array value, by inferring the type of every
 * element and folding them into one. Returns `'json'` for a mixed array, and
 * for an empty array.
 */
export function inferItems(v: unknown[]): ValueType {
  let type: ValueType | undefined
  for (const el of v) {
    const t = inferType(el)
    if (type === undefined) type = t
    else if (type !== t) return 'json'
  }
  return type ?? 'json'
}

/** Parses an integer-looking string to a `number`, or a `bigint` when it overflows the safe range. */
function coerceIntegerString(s: string): number | bigint {
  const t = s.trim()
  if (!/^[+-]?\d+$/.test(t)) throw schemaViolation(`"${s}" is not an integer`)
  const n = Number(t)
  if (Number.isSafeInteger(n)) return n
  return BigInt(t)
}

/** True when `v` is a value that JSON can represent. */
function isJSONValue(v: unknown): v is JSONValue {
  if (v === null) return true
  const t = typeof v
  if (t === 'boolean' || t === 'number' || t === 'string') return true
  if (Array.isArray(v)) return v.every(isJSONValue)
  if (t === 'object') {
    if (isDate(v) || isBytes(v)) return false
    return Object.values(v as Record<string, unknown>).every(isJSONValue)
  }
  return false
}

/**
 * Coerces `v` to `type`. Throws `SCHEMA_VIOLATION` when it cannot.
 *
 * `integer` and `unsigned` accept a number, a bigint, and a numeric string.
 * `unsigned` rejects a negative value. `float` accepts a number and a numeric
 * string. `time` accepts a `Date`, an RFC 3339 string, and a number of
 * milliseconds. `bytes` accepts a `Uint8Array` and an `ArrayBuffer`. `json`
 * accepts any JSON value. `array` coerces every element to `items`, which
 * defaults to the inferred element type. `string` and `boolean` accept only a
 * value already of that type.
 */
export function coerce(v: unknown, type: ValueType, items?: ValueType): TupleValue {
  switch (type) {
    case 'string': {
      if (typeof v === 'string') return v
      throw schemaViolation(`cannot coerce ${describe(v)} to string`)
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v
      throw schemaViolation(`cannot coerce ${describe(v)} to boolean`)
    }
    case 'integer':
    case 'unsigned': {
      let out: number | bigint
      if (typeof v === 'bigint') {
        out = v
      } else if (typeof v === 'number') {
        if (!Number.isInteger(v)) throw schemaViolation(`${v} is not an integer`)
        out = v
      } else if (typeof v === 'string') {
        out = coerceIntegerString(v)
      } else {
        throw schemaViolation(`cannot coerce ${describe(v)} to ${type}`)
      }
      if (type === 'unsigned' && out < 0) throw schemaViolation(`${out} is negative`)
      return out
    }
    case 'float': {
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const t = v.trim()
        const n = Number(t)
        if (t === '' || Number.isNaN(n)) throw schemaViolation(`"${v}" is not a number`)
        return n
      }
      throw schemaViolation(`cannot coerce ${describe(v)} to float`)
    }
    case 'time': {
      if (isDate(v)) return v
      if (typeof v === 'number') return new Date(v)
      if (typeof v === 'string') {
        const d = new Date(v)
        if (Number.isNaN(d.getTime())) throw schemaViolation(`"${v}" is not a valid time`)
        return d
      }
      throw schemaViolation(`cannot coerce ${describe(v)} to time`)
    }
    case 'bytes': {
      if (isBytes(v)) return v
      if (isArrayBuffer(v)) return new Uint8Array(v)
      throw schemaViolation(`cannot coerce ${describe(v)} to bytes`)
    }
    case 'json': {
      if (!isJSONValue(v)) throw schemaViolation(`cannot coerce ${describe(v)} to json`)
      return v
    }
    case 'array': {
      if (!Array.isArray(v)) throw schemaViolation(`cannot coerce ${describe(v)} to array`)
      const itemType = items ?? inferItems(v)
      return v.map((el) => coerce(el, itemType))
    }
    default:
      throw schemaViolation(`unknown value type "${type as string}"`)
  }
}

/** Renders a byte array as lowercase hex, for use inside a value key. */
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A canonical decimal string for a number, so `3` and `3.0` render the same. */
function canonicalNumber(n: number): string {
  if (Object.is(n, -0)) return '0'
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity'
  return String(n)
}

/** Stringifies a JSON-shaped value with object keys sorted, so equal objects render the same. */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const keys = Object.keys(rec).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

/**
 * A stable string key for equality and for the value index.
 *
 * A `Date` and its epoch milliseconds give the same key. The integer `3` and
 * the float `3` give the same key. Object keys are sorted, so two equal JSON
 * objects give one key.
 */
export function valueKey(v: unknown): string {
  if (v === null) return 'z:null'
  if (v === undefined) return 'z:undefined'
  if (typeof v === 'string') return 's:' + v
  if (typeof v === 'boolean') return 'b:' + v
  if (typeof v === 'bigint') return 'n:' + v.toString()
  if (typeof v === 'number') return 'n:' + canonicalNumber(v)
  if (isDate(v)) return 'n:' + canonicalNumber(v.getTime())
  if (isBytes(v)) return 'y:' + bytesToHex(v)
  if (Array.isArray(v)) return 'a:[' + v.map(valueKey).join(',') + ']'
  if (typeof v === 'object') return 'j:' + stableStringify(v)
  return 'u:' + String(v)
}

/** True when two tuple values are equal. Uses `valueKey`. */
export function valueEquals(a: unknown, b: unknown): boolean {
  return valueKey(a) === valueKey(b)
}

/** Normalizes a tuple on input. Accepts the array form `[path, attr, value]` and the object form. */
export function toTuple(input: TupleInput): Tuple {
  if (Array.isArray(input)) {
    const [path, attr, value] = input
    return { path, attr, value }
  }
  return input
}

/** True when the attribute is a system field: it starts with `'_'`. */
export function isSystemAttr(attr: string): boolean {
  return attr.startsWith('_')
}
