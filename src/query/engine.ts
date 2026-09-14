import type { Context, Pattern, PathSlot, PatternQuery, Tuple, WhereClause } from '../core/types.js'
import { invalidQuery } from '../core/errors.js'
import { TupleIndex, valueKey } from '../store/tuple-index.js'
import { Footprint } from './footprint.js'

/** True when a slot is a variable: a string that starts with '?'. */
export function isVar(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('?')
}

/**
 * Same test as `isVar`, without a type predicate. `PathSlot` and the attr
 * slot are already typed as plain `string`, so a type predicate applied to
 * them narrows the negative branch to `never` instead of the rest of
 * `string`. Use this helper where the input is already known to be a
 * string and the caller still needs to use string methods afterward.
 */
function startsWithVar(s: string): boolean {
  return s.startsWith('?')
}

/** The `ns/schema` prefix of a record path. */
function schemaOf(path: string): string {
  const parts = path.split('/')
  return `${parts[0]}/${parts[1]}`
}

/** The id part of a record path. */
function idOf(path: string): string {
  return path.split('/')[2]
}

type PathForm =
  | { kind: 'const'; path: string }
  | { kind: 'id'; schema: string; v: string }
  | { kind: 'var'; v: string }

/**
 * Classifies a path slot into its three forms: a constant record path, a
 * schema path with a variable id, or a bare variable.
 */
function pathForm(p: PathSlot): PathForm {
  if (startsWithVar(p)) return { kind: 'var', v: p }
  const parts = p.split('/')
  if (parts.length === 3 && startsWithVar(parts[2])) {
    return { kind: 'id', schema: `${parts[0]}/${parts[1]}`, v: parts[2] }
  }
  return { kind: 'const', path: p }
}

/**
 * Binds `v` to `value` in `ctx`. When `v` is already bound, the existing
 * binding must equal `value`, or the bind fails and returns null.
 */
function bind(ctx: Context, v: string, value: unknown): Context | null {
  if (v in ctx) {
    return valueKey(ctx[v]) === valueKey(value) ? ctx : null
  }
  return { ...ctx, [v]: value }
}

/** Matches one tuple against a pattern. Returns the new context, or null. */
export function matchTuple(p: Pattern, t: Tuple, ctx: Context): Context | null {
  const [pathSlot, attrSlot, valueSlot] = p
  const pf = pathForm(pathSlot)
  let next: Context = ctx

  if (pf.kind === 'const') {
    if (t.path !== pf.path) return null
  } else if (pf.kind === 'id') {
    if (schemaOf(t.path) !== pf.schema) return null
    const bound = bind(next, pf.v, idOf(t.path))
    if (bound === null) return null
    next = bound
  } else {
    const bound = bind(next, pf.v, t.path)
    if (bound === null) return null
    next = bound
  }

  if (startsWithVar(attrSlot)) {
    const bound = bind(next, attrSlot, t.attr)
    if (bound === null) return null
    next = bound
  } else if (attrSlot.endsWith('.*')) {
    if (!t.attr.startsWith(attrSlot.slice(0, -1))) return null
  } else if (attrSlot !== t.attr) {
    return null
  }

  if (isVar(valueSlot)) {
    return bind(next, valueSlot, t.value)
  }
  return valueKey(valueSlot) === valueKey(t.value) ? next : null
}

/**
 * The candidate tuples for a pattern in a context. Substitutes the bound
 * variables, then picks the narrowest index: a known record path, then a
 * known schema and attribute, then a known value, then a known schema alone,
 * then every tuple. Records the read in `footprint`.
 */
export function relevant(
  index: TupleIndex,
  p: Pattern,
  ctx: Context,
  footprint?: Footprint,
): Iterable<Tuple> {
  const [pathSlot, attrSlot, valueSlot] = p
  const pf = pathForm(pathSlot)

  let path: string | null = null
  let schema: string | null = null
  if (pf.kind === 'const') {
    path = pf.path
    schema = schemaOf(pf.path)
  } else if (pf.kind === 'id') {
    schema = pf.schema
    if (pf.v in ctx) path = `${schema}/${ctx[pf.v] as string}`
  } else if (pf.v in ctx) {
    path = ctx[pf.v] as string
  }

  const attr = startsWithVar(attrSlot)
    ? attrSlot in ctx
      ? (ctx[attrSlot] as string)
      : null
    : attrSlot.endsWith('.*')
      ? null
      : attrSlot

  const value: unknown = isVar(valueSlot) ? (valueSlot in ctx ? ctx[valueSlot] : undefined) : valueSlot

  if (footprint) {
    footprint.add(schema ?? (path ? schemaOf(path) : null), attr)
  }

  if (path !== null) {
    const attrs = index.attrs(path)
    if (!attrs) return []
    if (attr !== null) {
      const t = attrs.get(attr)
      return t ? [t] : []
    }
    return [...attrs.values()]
  }
  if (schema !== null && attr !== null) {
    return index.bySchemaAttr(schema, attr)
  }
  if (value !== undefined) {
    return index.byValue(value)
  }
  if (schema !== null) {
    return index.bySchema(schema)
  }
  return index.all()
}

const OP_RE = /^\s*(\?[\w.]+)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/

/** Compares two values with a predicate operator. */
function compare(op: string, x: unknown, y: unknown): boolean {
  switch (op) {
    case '==':
      return valueKey(x) === valueKey(y)
    case '!=':
      return valueKey(x) !== valueKey(y)
    case '<':
      return (x as number) < (y as number)
    case '<=':
      return (x as number) <= (y as number)
    case '>':
      return (x as number) > (y as number)
    case '>=':
      return (x as number) >= (y as number)
    default:
      throw invalidQuery(`unsupported operator: ${op}`)
  }
}

/**
 * Compiles a predicate string such as '?a > 3' or '?a == ?b'. Supports the
 * operators `== != < <= > >=`, with a `?var` on the left and a `?var` or a
 * JSON literal on the right. Throws INVALID_QUERY when the source does not
 * parse. The returned function throws INVALID_QUERY when it runs against a
 * context where a referenced variable is unbound.
 */
export function compilePredicate(src: string): (ctx: Context) => boolean {
  const m = OP_RE.exec(src)
  if (!m) throw invalidQuery(`cannot parse predicate: ${src}`)
  const [, left, op, rhsRaw] = m as unknown as [string, string, string, string]

  let rhsVar: string | null = null
  let rhsLiteral: unknown
  if (isVar(rhsRaw)) {
    rhsVar = rhsRaw
  } else {
    try {
      rhsLiteral = JSON.parse(rhsRaw)
    } catch {
      throw invalidQuery(`cannot parse predicate: ${src}`)
    }
  }

  return (ctx: Context): boolean => {
    if (!(left in ctx)) throw invalidQuery(`unbound variable in predicate: ${src}`)
    if (rhsVar !== null && !(rhsVar in ctx)) {
      throw invalidQuery(`unbound variable in predicate: ${src}`)
    }
    const r = rhsVar !== null ? ctx[rhsVar] : rhsLiteral
    return compare(op, ctx[left], r)
  }
}

/**
 * True when `w` is a required pattern, as opposed to an `{ opt }` wrapper, a
 * predicate string, or a compiled predicate function.
 */
function isPattern(w: WhereClause): w is Pattern {
  return Array.isArray(w)
}

/** Matches one pattern against every context, with no optional fallback. */
function stepPattern(
  index: TupleIndex,
  pat: Pattern,
  contexts: Context[],
  footprint?: Footprint,
): Context[] {
  const out: Context[] = []
  for (const ctx of contexts) {
    for (const t of relevant(index, pat, ctx, footprint)) {
      const next = matchTuple(pat, t, ctx)
      if (next) out.push(next)
    }
  }
  return out
}

/**
 * Runs a where list and returns the matching contexts. Evaluates the list in
 * order, starting from one empty context. A pattern keeps only the contexts
 * that match. An `{ opt }` pattern keeps the original context when nothing
 * matches. An `{ optAll }` group binds every pattern or none of them. A string
 * or a function filters the contexts.
 */
export function runContexts(
  index: TupleIndex,
  where: WhereClause[],
  footprint?: Footprint,
): Context[] {
  let contexts: Context[] = [{}]
  for (const w of where) {
    if (typeof w === 'string') {
      const pred = compilePredicate(w)
      contexts = contexts.filter(pred)
      continue
    }
    if (typeof w === 'function') {
      contexts = contexts.filter(w)
      continue
    }
    if (!isPattern(w) && 'optAll' in w) {
      // The left-join primitive. A joined alias matches as a whole: run the
      // group against each context on its own, and fall back to the untouched
      // context when the group yields nothing. Matching pattern by pattern
      // would let a record that fails a later condition survive with the
      // earlier variables already bound.
      const group = w.optAll
      contexts = contexts.flatMap((ctx) => {
        let sub: Context[] = [ctx]
        for (const pat of group) {
          sub = stepPattern(index, pat, sub, footprint)
          if (sub.length === 0) break
        }
        return sub.length > 0 ? sub : [ctx]
      })
      continue
    }
    const isOpt = !isPattern(w)
    const pat: Pattern = isOpt ? (w as { opt: Pattern }).opt : w
    contexts = contexts.flatMap((ctx) => {
      const out = stepPattern(index, pat, [ctx], footprint)
      return out.length > 0 || !isOpt ? out : [ctx]
    })
  }
  return contexts
}

/** Runs a pattern query and returns one row per context. */
export function runQuery(index: TupleIndex, q: PatternQuery, footprint?: Footprint): unknown[][] {
  const contexts = runContexts(index, q.where, footprint)
  return contexts.map((ctx) => q.find.map((v) => ctx[v]))
}
