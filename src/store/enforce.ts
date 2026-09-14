/**
 * Schema policy for one mutation: declared-field type checks in every mode,
 * the strict/flexible/dynamic split on undeclared attributes, and the
 * required-field rules. Matches the Go store's enforcement middleware.
 */
import { schemaViolation } from '../core/errors.js'
import type { Def, Field, Mutation, Tuple } from '../core/types.js'
import { coerce, inferItems, inferType, isSystemAttr } from '../core/value.js'

/** Type-checks and, in dynamic mode, evolves one declared or undeclared tuple. */
function enforceTuple(t: Tuple, def: Def, evolved: Record<string, Field>): Tuple {
  if (isSystemAttr(t.attr)) return t

  const field = def.fields[t.attr]
  if (field) {
    // An explicit null carries no type of its own, so it satisfies any declared type.
    if (t.value === null) return { ...t, value: null, type: field.type, items: field.items }
    const value = coerce(t.value, field.type, field.items)
    return { ...t, value, type: field.type, items: field.items }
  }

  if (def.mode === 'strict') {
    throw schemaViolation(`unknown field "${t.attr}" in strict schema ${def.ns}/${def.schema}`, {
      uri: `${def.ns}/${def.schema}`,
      issues: [{ path: t.attr, message: `"${t.attr}" is not declared and the schema is strict` }],
    })
  }

  if (def.mode === 'dynamic' && t.value !== null) {
    const type = inferType(t.value)
    const items = type === 'array' ? inferItems(t.value as unknown[]) : undefined
    const newField: Field = items !== undefined ? { type, items } : { type }
    evolved[t.attr] = newField
    return items !== undefined ? { ...t, type, items } : { ...t, type }
  }

  // flexible mode, or a null value under dynamic mode: stored as-is, no evolution.
  return t
}

/**
 * Applies schema policy to a mutation. Returns the mutation to write, with
 * declared fields type-checked (and coerced) and, under dynamic mode, newly
 * seen fields typed. Returns the evolved definition too, only when dynamic
 * mode added a field.
 *
 * Throws `SCHEMA_VIOLATION`:
 * - on a type mismatch against a declared field, in every mode;
 * - on an undeclared attribute, in strict mode;
 * - on a missing `required` field, on a full-record write (`create`, `put`,
 *   or a `patch` that creates the record);
 * - on a `delete` that names a `required` attribute.
 *
 * `def` of `null` means the record has no schema: the mutation passes
 * through unchanged.
 */
export function enforce(m: Mutation, def: Def | null, exists: boolean): { mutation: Mutation; def?: Def } {
  if (def === null) return { mutation: m }

  if (m.op === 'delete') {
    for (const attr of m.attrs ?? []) {
      if (def.fields[attr]?.required) {
        throw schemaViolation(`cannot delete required field "${attr}" of ${def.ns}/${def.schema}`, {
          uri: `${m.path}#${attr}`,
        })
      }
    }
    return { mutation: m }
  }

  const evolved: Record<string, Field> = {}
  const tuples = (m.tuples ?? []).map((t) => enforceTuple(t, def, evolved))

  const fullWrite = m.op === 'create' || m.op === 'put' || (m.op === 'patch' && !exists)
  if (fullWrite) {
    const present = new Set(tuples.map((t) => t.attr))
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.required && !present.has(name)) {
        throw schemaViolation(`missing required field "${name}" of ${def.ns}/${def.schema}`, {
          uri: m.path,
          issues: [{ path: name, message: `"${name}" is required` }],
        })
      }
    }
  }

  const mutation: Mutation = { ...m, tuples }
  if (Object.keys(evolved).length > 0) {
    return { mutation, def: { ...def, fields: { ...def.fields, ...evolved } } }
  }
  return { mutation }
}
