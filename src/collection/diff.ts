/**
 * The attribute-level difference between two record objects, used by
 * `Collection.update` to turn a "read, mutate a clone, compare" step into a
 * minimal patch: only the attributes that actually changed reach the driver.
 */
import { encodeRecord } from '../core/record.js'
import type { RecordObject, Tuple } from '../core/types.js'
import { valueEquals } from '../core/value.js'

/**
 * Compares `before` and `after`, both decoded record objects for the same
 * item, and reports what a write from one to the other would touch.
 *
 * `tuples` holds one entry per attribute that is new in `after` or whose
 * value differs from `before`, in `after`'s dotted-attribute encoding
 * (`encodeRecord`, so a nested object contributes one tuple per leaf and an
 * array is one tuple). `attrs` holds the dotted names present in `before`
 * but missing from `after`. An attribute unchanged between the two appears
 * in neither list.
 */
export function diffItems(before: RecordObject, after: RecordObject, path: string): { tuples: Tuple[]; attrs: string[] } {
  const beforeTuples = new Map(encodeRecord(path, before).map((t) => [t.attr, t]))
  const afterTuples = encodeRecord(path, after)

  const tuples: Tuple[] = []
  const afterAttrs = new Set<string>()
  for (const t of afterTuples) {
    afterAttrs.add(t.attr)
    const prev = beforeTuples.get(t.attr)
    if (!prev || !valueEquals(prev.value, t.value)) tuples.push(t)
  }

  const attrs: string[] = []
  for (const attr of beforeTuples.keys()) {
    if (!afterAttrs.has(attr)) attrs.push(attr)
  }

  return { tuples, attrs }
}
