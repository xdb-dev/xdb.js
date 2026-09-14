/**
 * Folds a plain object into tuples and back. A nested plain object becomes
 * dotted attributes. A `Date`, a `Uint8Array`, and an array are leaves, never
 * objects to fold further.
 */
import type { RecordObject, Tuple, TupleValue } from './types.js'
import { isPlainObject, isSystemAttr } from './value.js'

/** Walks one value, yielding `[dottedAttr, leafValue]` pairs. `undefined` leaves are skipped. */
function* walkValue(prefix: string, value: unknown): Generator<[string, unknown]> {
  if (value === undefined) return
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      yield* walkValue(`${prefix}.${k}`, value[k])
    }
    return
  }
  yield [prefix, value]
}

/** Walks the top-level keys of a record object, applying the `id` and system-attr skip rules. */
function* walkEntries(obj: RecordObject, system: boolean): Generator<[string, unknown]> {
  for (const key of Object.keys(obj)) {
    if (key === 'id') continue
    if (isSystemAttr(key) && !system) continue
    yield* walkValue(key, obj[key])
  }
}

/**
 * Encodes a plain object to tuples at `path`. A nested plain object folds into
 * dotted attributes. An array becomes one tuple. The `id` key is skipped, and
 * a key that starts with `'_'` is skipped unless `system` is true.
 */
export function encodeRecord(path: string, obj: RecordObject, opts?: { system?: boolean }): Tuple[] {
  const system = opts?.system ?? false
  const tuples: Tuple[] = []
  for (const [attr, value] of walkEntries(obj, system)) {
    tuples.push({ path, attr, value: value as TupleValue })
  }
  return tuples
}

/**
 * Decodes tuples to a plain object. A dotted attribute unfolds into nested
 * objects. `_id` becomes `id`. Other system attributes are kept only when
 * `system` is true.
 */
export function decodeRecord(tuples: Iterable<Tuple>, opts?: { system?: boolean }): RecordObject {
  const system = opts?.system ?? false
  const obj: RecordObject = {}
  for (const t of tuples) {
    if (t.attr === '_id') {
      obj.id = t.value
      continue
    }
    if (isSystemAttr(t.attr) && !system) continue
    setIn(obj, t.attr, t.value)
  }
  return obj
}

/** Reads a dotted path out of an object. Returns `undefined` when a segment is missing. */
export function getIn(obj: RecordObject, attr: string): unknown {
  const parts = attr.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Writes a dotted path into an object. Creates the intermediate objects. */
export function setIn(obj: RecordObject, attr: string, value: unknown): void {
  const parts = attr.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    const next = cur[p]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      cur[p] = created
      cur = created
    } else {
      cur = next as Record<string, unknown>
    }
  }
  cur[parts[parts.length - 1]] = value
}

/** The dotted attribute names of an object, in encode order. */
export function attrsOf(obj: RecordObject, opts?: { system?: boolean }): string[] {
  const system = opts?.system ?? false
  const attrs: string[] = []
  for (const [attr] of walkEntries(obj, system)) attrs.push(attr)
  return attrs
}
