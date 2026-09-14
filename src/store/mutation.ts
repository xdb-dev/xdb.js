/**
 * Pure helpers over tuple lists and mutations: folding a patch onto a
 * record's current tuples, removing named attributes, grouping tuples by
 * record path, and filling in a mutation's optional fields.
 */
import type { Mutation, Tuple } from '../core/types.js'

/**
 * Folds a patch onto the current tuples of a record. A patch attribute
 * replaces the current tuple of the same name, in place. A patch attribute
 * not present in `current` is appended. The result has one tuple per
 * attribute.
 */
export function mergeTuples(current: Tuple[], patch: Tuple[]): Tuple[] {
  const byAttr = new Map<string, Tuple>()
  for (const t of current) byAttr.set(t.attr, t)
  for (const t of patch) byAttr.set(t.attr, t)
  return [...byAttr.values()]
}

/**
 * Removes the named attributes from `current`. An empty `attrs` list removes
 * every tuple, the whole-record-delete case.
 */
export function removeAttrs(current: Tuple[], attrs: string[]): Tuple[] {
  if (attrs.length === 0) return []
  const victims = new Set(attrs)
  return current.filter((t) => !victims.has(t.attr))
}

/**
 * Groups tuples by record path. Each group holds its tuples in first-seen
 * order, and the map holds its groups in first-seen path order.
 */
export function groupByPath(tuples: Tuple[]): Map<string, Tuple[]> {
  const out = new Map<string, Tuple[]>()
  for (const t of tuples) {
    let group = out.get(t.path)
    if (!group) {
      group = []
      out.set(t.path, group)
    }
    group.push(t)
  }
  return out
}

/**
 * Normalizes a mutation for the rest of the store pipeline: `path` and `op`
 * pass through, and `tuples` and `attrs` are filled with `[]` when absent so
 * downstream code never has to check for `undefined`.
 */
export function normalizeMutation(m: Mutation): Required<Pick<Mutation, 'path' | 'op'>> & Mutation {
  return {
    ...m,
    path: m.path,
    op: m.op,
    tuples: m.tuples ?? [],
    attrs: m.attrs ?? [],
  }
}
