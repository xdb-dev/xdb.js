/**
 * Zod-to-XDB schema derivation, and item parsing through a Standard Schema.
 *
 * This is the one file in the package allowed to import `zod`, and even here
 * the import is a dynamic, guarded read of a schema's own introspection data
 * (`schema._zod.def`), never a static `import { z } from 'zod'`. A user who
 * never installs `zod` can still use the library: `defFromSchema` degrades to
 * `dynamic` mode, and `parseItem` passes the input through unchanged, when
 * `schema` is `undefined` or is not recognizable as a Zod schema.
 *
 * The mapping below follows the table in `design.html` section 9. A `checks`
 * array is Zod's own record of the refinements chained onto a schema (`.int()`,
 * `.nonnegative()`, and so on); reading it, rather than re-deriving the same
 * information by trial parses, keeps the mapping exact and side-effect free.
 * The one case with no such signal is a `transform`: Zod deliberately hides a
 * transform's output type from static introspection, so this module parses a
 * synthesized sample value that satisfies the transform's input schema and
 * infers the type of the result, as `design.html` describes ("xdb.js reads
 * the output type from the first parsed value"). When that probe throws, the
 * field falls back to the type of the transform's input.
 */
import { validation } from '../core/errors.js'
import { inferItems, inferType } from '../core/value.js'
import { parseURI } from '../core/uri.js'
import type { Def, Field, ValueType } from '../core/types.js'

/**
 * The shape common to every Standard Schema (https://standardschema.dev), the
 * interface Zod, Valibot, and others implement so a library like this one can
 * validate against any of them without a hard dependency on any one.
 */
export interface StandardSchemaLike {
  '~standard': { validate: (v: unknown) => any }
}

/** A schema xdb.js can parse with: a Standard Schema, or a bare `{ parse }` object such as a Zod schema used directly. */
export type AnySchema = StandardSchemaLike | { parse: (v: unknown) => unknown }

/** One issue reported by `parseItem`'s underlying schema library. */
interface Issue {
  path: string
  message: string
}

/** A Zod internal schema node, as seen through `_zod.def`. Not a public Zod type; read defensively, field by field. */
interface ZodNode {
  _zod?: { def?: ZodDef }
  safeParse?: (v: unknown) => { success: boolean }
  parse?: (v: unknown) => unknown
}

interface ZodDef {
  type: string
  checks?: ZodCheck[]
  shape?: Record<string, ZodNode>
  element?: ZodNode
  innerType?: ZodNode
  in?: ZodNode
  out?: ZodNode
  entries?: Record<string, unknown>
  [k: string]: unknown
}

interface ZodCheck {
  _zod?: { def?: { check?: string; format?: string; value?: unknown; inclusive?: boolean } }
}

/** True when `v` looks like a Zod schema: it exposes `_zod.def.type`. */
function isZodNode(v: unknown): v is ZodNode {
  return typeof v === 'object' && v !== null && typeof (v as ZodNode)._zod?.def?.type === 'string'
}

/** Strips `optional` and `default` wrappers, and reports whether the field is still required. */
function unwrap(node: ZodNode): { node: ZodNode; required: boolean } {
  let cur = node
  let required = true
  for (;;) {
    const def = cur._zod?.def
    if (!def) break
    if (def.type === 'optional') {
      required = false
      cur = def.innerType!
      continue
    }
    if (def.type === 'default') {
      required = false
      cur = def.innerType!
      continue
    }
    break
  }
  return { node: cur, required }
}

/** True when a number schema's checks include Zod's integer format check. */
function hasIntCheck(checks: ZodCheck[]): boolean {
  return checks.some((c) => c._zod?.def?.check === 'number_format' && c._zod.def.format === 'safeint')
}

/** True when a number schema's checks include a `>= 0` bound, Zod's shape for `.nonnegative()`. */
function hasNonnegativeCheck(checks: ZodCheck[]): boolean {
  return checks.some(
    (c) => c._zod?.def?.check === 'greater_than' && c._zod.def.value === 0 && c._zod.def.inclusive === true,
  )
}

/** True when `node` parses a `Uint8Array` but rejects a plain string and a number. Distinguishes `z.instanceof(Uint8Array)` from any other custom check, without relying on Zod internals that a `custom` node does not expose. */
function looksLikeBytes(node: ZodNode): boolean {
  if (typeof node.safeParse !== 'function') return false
  try {
    return (
      node.safeParse(new Uint8Array(0)).success &&
      !node.safeParse('x').success &&
      !node.safeParse(0).success
    )
  } catch {
    return false
  }
}

/** Builds a value that satisfies `node`, well enough to drive a transform chained after it. Best-effort: a schema this cannot sample falls through to `undefined`, and the caller catches the resulting parse failure. */
function sampleFor(node: ZodNode): unknown {
  const { node: n } = unwrap(node)
  const def = n._zod?.def
  if (!def) return undefined
  switch (def.type) {
    case 'string':
      return new Date().toISOString()
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'date':
      return new Date()
    case 'bigint':
      return 0n
    case 'array':
      return []
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [k, sub] of Object.entries(def.shape ?? {})) out[k] = sampleFor(sub)
      return out
    }
    case 'record':
      return {}
    case 'enum': {
      const values = Object.values(def.entries ?? {})
      return values[0]
    }
    default:
      return undefined
  }
}

/** Resolves the `Field` for a `pipe` (transform) node, by parsing a sample input and inferring the type of the result. Falls back to the input schema's own type when the probe throws. */
function resolveTransform(node: ZodNode): Field {
  const def = node._zod!.def!
  try {
    const sample = sampleFor(def.in!)
    const result = node.parse!(sample)
    if (result === null || result === undefined) return { type: 'json' }
    const type = inferType(result)
    if (type === 'array') return { type: 'array', items: inferItems(result as unknown[]) }
    return { type }
  } catch {
    try {
      return leafField(unwrap(def.in!).node)
    } catch {
      return { type: 'json' }
    }
  }
}

/** Resolves the `Field` of a schema node that is not a nested `object`: every row of the section 9 mapping table except the nested-object row, which `fieldsOf` handles by recursing before it ever calls this. */
function leafField(node: ZodNode): Field {
  const def = node._zod?.def
  if (!def) return { type: 'json' }
  switch (def.type) {
    case 'string':
      return { type: 'string' }
    case 'boolean':
      return { type: 'boolean' }
    case 'date':
      return { type: 'time' }
    case 'number': {
      const checks = def.checks ?? []
      if (!hasIntCheck(checks)) return { type: 'float' }
      return { type: hasNonnegativeCheck(checks) ? 'unsigned' : 'integer' }
    }
    case 'record':
    case 'unknown':
    case 'any':
      return { type: 'json' }
    case 'array': {
      const el = unwrap(def.element!).node
      const elDef = el._zod?.def
      const items: ValueType = elDef?.type === 'object' ? 'json' : leafField(el).type
      return { type: 'array', items }
    }
    case 'enum':
      return { type: 'string' }
    case 'custom':
      return looksLikeBytes(node) ? { type: 'bytes' } : { type: 'json' }
    case 'pipe':
      return resolveTransform(node)
    default:
      return { type: 'json' }
  }
}

/** Recursively resolves every leaf of a schema's shape to a dotted-attribute `Field` map. A nested `z.object` folds into `parent.child` attributes, one per leaf, matching `encodeRecord`. */
function fieldsOf(prefix: string, shape: Record<string, ZodNode>): Record<string, Field> {
  const out: Record<string, Field> = {}
  for (const [key, raw] of Object.entries(shape)) {
    if (key === 'id') continue // the id lives in the record path, never as a stored attribute
    const { node, required } = unwrap(raw)
    const attr = prefix ? `${prefix}.${key}` : key
    const def = node._zod?.def
    if (def?.type === 'object') {
      Object.assign(out, fieldsOf(attr, def.shape ?? {}))
      continue
    }
    out[attr] = { ...leafField(node), required }
  }
  return out
}

/**
 * Derives an XDB {@link Def} from a Zod schema, following the mapping table
 * in `design.html` section 9. `uri` is the collection's URI or schema path
 * (`xdb://ns/schema` or `ns/schema`); its `ns` and `schema` become the def's.
 *
 * Without a schema, or when `schema` is not recognizable as a Zod object
 * schema, falls back to `dynamic` mode with no declared fields: the store
 * infers types from the values it is given. `overrides` replaces the
 * derived `Field` for any named attribute, declared field or not.
 */
export function defFromSchema(uri: string, schema: unknown | undefined, overrides?: Record<string, Field>): Def {
  const u = parseURI(uri)
  const ns = u.ns
  const schemaName = u.schema ?? u.ns

  if (!isZodNode(schema) || schema._zod?.def?.type !== 'object') {
    return { ns, schema: schemaName, mode: 'dynamic', fields: { ...overrides } }
  }

  const shape = schema._zod!.def!.shape ?? {}
  const fields = { ...fieldsOf('', shape), ...(overrides ?? {}) }
  return { ns, schema: schemaName, mode: 'strict', fields }
}

/** Turns a Standard Schema issue path (a mix of property keys and `{ key }` segments) into a dotted attribute string. */
function issuePath(path: ReadonlyArray<unknown> | undefined): string {
  if (!path) return ''
  return path
    .map((seg) => (seg && typeof seg === 'object' && 'key' in (seg as object) ? (seg as { key: unknown }).key : seg))
    .map(String)
    .join('.')
}

/**
 * Parses `input` with `schema`, applying its defaults and transforms.
 * Prefers the Standard Schema `~standard.validate` entry point when present,
 * falling back to a bare `parse` method. Without a schema, returns `input`
 * unchanged.
 *
 * Throws a `VALIDATION` `XDBError` on failure, with `issues` carrying the
 * dotted field path and message the schema library reported.
 */
export function parseItem<T>(schema: unknown | undefined, input: unknown): T {
  if (schema === undefined || schema === null) return input as T

  const std = (schema as Partial<StandardSchemaLike>)['~standard']
  if (std && typeof std.validate === 'function') {
    const result = std.validate(input)
    if (result instanceof Promise) {
      throw validation('an asynchronous schema validator is not supported', { issues: [] })
    }
    if (result.issues && result.issues.length > 0) {
      const issues: Issue[] = result.issues.map((iss: { path?: ReadonlyArray<unknown>; message: string }) => ({
        path: issuePath(iss.path),
        message: iss.message,
      }))
      throw validation('validation failed', { issues })
    }
    return result.value as T
  }

  const parse = (schema as { parse?: (v: unknown) => unknown }).parse
  if (typeof parse === 'function') {
    try {
      return parse(input) as T
    } catch (err) {
      const zodIssues = (err as { issues?: Array<{ path?: ReadonlyArray<unknown>; message: string }> })?.issues
      if (Array.isArray(zodIssues)) {
        const issues: Issue[] = zodIssues.map((iss) => ({ path: issuePath(iss.path), message: iss.message }))
        throw validation('validation failed', { issues, cause: err })
      }
      throw validation(err instanceof Error ? err.message : 'validation failed', { cause: err })
    }
  }

  return input as T
}
