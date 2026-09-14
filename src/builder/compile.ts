/**
 * Compiles a `QueryBuilder` into the pattern list the query engine runs, plus
 * the row-building and ordering functions that turn matched contexts into
 * output rows. See "From Builder to Patterns" in `design.html` section 5 for
 * the reference behavior.
 */
import { decodeRecord } from '../core/record.js'
import type { Context, Pattern, Slot, TupleValue, WhereClause } from '../core/types.js'
import type { TupleIndex } from '../store/tuple-index.js'
import { evalAggregate, evalExpr, fieldProxy, isAggregate, isExprNode, isFieldRef } from './expr.js'
import type { AggregateNode, Expr, ExprNode, FieldRef } from './expr.js'
import type { QueryBuilder } from './query.js'
import { isPlainObject } from '../core/value.js'

/**
 * One alias whose unmatched records become rows. A right or a full join asks
 * for this, because a single ordered pattern run produces matched rows only.
 */
export interface AntiJoin {
  alias: string
  /** The `ns/schema` path of the alias, for enumerating its records. */
  path: string
  /** The context variable that holds this alias's record id. */
  idVar: string
  /** Builds a context that binds this alias's id and fields, and nothing else. */
  bind(index: TupleIndex, id: string): Context
}

/** The compiled form of a query: patterns to run, and post-processing steps. */
export interface CompiledQuery {
  /** The pattern list. Run it with `runContexts` from `../query/engine.js`. */
  where: WhereClause[]
  /**
   * Builds the row of one group. An ungrouped query passes a group of one
   * context. An aggregate folds over every context in the group.
   */
  row(index: TupleIndex, ctxs: Context[]): unknown
  /** Builds the `{ alias: record }` namespace of a context, for `fn` callbacks. */
  namespace(index: TupleIndex, ctx: Context): Record<string, unknown>
  /** True when `groupBy` was called, or a `select` or `having` uses an aggregate. */
  grouped: boolean
  /** The group key of a context. An empty array when the query is not grouped. */
  groupKey(ctx: Context): unknown[]
  /** Group filters from `having`, evaluated after aggregation. */
  having: ((index: TupleIndex, ctxs: Context[]) => boolean)[]
  /** True after `distinct`. */
  distinct: boolean
  /** The row cap. `Infinity` when the builder never called `limit`. */
  limit: number
  /** The number of leading rows to skip. `0` when the builder never called `offset`. */
  offset: number
  /** The sort keys, in the order `orderBy` added them. The first is primary. */
  orders: { read: (index: TupleIndex, ctxs: Context[]) => unknown; dir: 'asc' | 'desc' }[]
  /** Raw predicates from `fn.where`, run per row before grouping. */
  fnWhere: ((row: unknown) => boolean)[]
  /** Raw predicates from `fn.having`, run per group row. */
  fnHaving: ((row: unknown) => boolean)[]
  /** The raw projection from `fn.select`, applied to every output row. */
  fnSelect: ((row: unknown) => unknown) | null
  /** Aliases whose unmatched records become rows. */
  antiJoins: AntiJoin[]
}

interface FieldUsage {
  alias: string
  field: string
  required: boolean
}

/** The pattern variable a field ref binds to. The id field reuses the alias's own variable. */
function varOf(r: FieldRef): string {
  return r.field === 'id' ? '?' + r.alias : '?' + r.alias + '.' + r.field
}

/** Follows the union-find chain to the canonical variable name. */
function resolve(v: string, unify: Map<string, string>): string {
  let cur = v
  const seen = new Set<string>()
  while (unify.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    cur = unify.get(cur) as string
  }
  return cur
}

/** Records every field ref found in `v`, recursing into expression trees, plain objects, and arrays. */
function walk(v: unknown, required: boolean, fields: Map<string, FieldUsage>): void {
  if (isFieldRef(v)) {
    if (v.field === 'id') return
    const k = varOf(v)
    const existing = fields.get(k)
    if (existing) existing.required = existing.required || required
    else fields.set(k, { alias: v.alias, field: v.field, required })
    return
  }
  if (isAggregate(v)) {
    // An aggregate folds over a group, so its argument must be readable per
    // row but must never gate which rows match.
    if (v.arg !== undefined) walk(v.arg, false, fields)
    return
  }
  if (isExprNode(v)) {
    // isUndefined(x) tests for a missing attribute. A required pattern needs a
    // matching tuple to survive, so it would drop exactly the rows the check
    // wants to find. Treat its argument as optional so the variable can stay
    // unbound instead.
    const argRequired = v.op === 'isUndefined' ? false : required
    for (const a of v.args) walk(a, argRequired, fields)
    return
  }
  if (Array.isArray(v)) {
    for (const el of v) walk(el, required, fields)
    return
  }
  if (isPlainObject(v)) {
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, required, fields)
  }
}

/** Flattens a top-level `and` into its parts. `eq` inside an `or` or a `not` is not flattened. */
function flattenAnd(nodes: ExprNode[]): ExprNode[] {
  const out: ExprNode[] = []
  for (const n of nodes) {
    if (n.op === 'and') out.push(...flattenAnd(n.args.filter(isExprNode)))
    else out.push(n)
  }
  return out
}

/** True when `v` holds an aggregate anywhere inside it. */
function hasAggregate(v: unknown): boolean {
  if (isAggregate(v)) return true
  if (isExprNode(v)) return v.args.some(hasAggregate)
  if (Array.isArray(v)) return v.some(hasAggregate)
  if (isPlainObject(v)) return Object.values(v as Record<string, unknown>).some(hasAggregate)
  return false
}

/** Builds the `{ alias: fieldProxy }` map the compile-time callbacks read fields from. */
function refsFor(aliases: string[]): Record<string, Record<string, unknown>> {
  const r: Record<string, Record<string, unknown>> = {}
  for (const alias of aliases) r[alias] = fieldProxy(alias)
  return r
}

/** Compiles `b` into a `CompiledQuery`. */
export function compile(b: QueryBuilder): CompiledQuery {
  const sources = b._sources
  const unify = new Map<string, string>()
  const consts = new Map<string, TupleValue>()
  const fields = new Map<string, FieldUsage>()
  const predicates: ((ctx: Context) => boolean)[] = []

  const flattened = flattenAnd(b._exprs)

  // Pass 1: an eq between two field refs is a join. Unify their variables and emit no predicate.
  const remaining: ExprNode[] = []
  for (const e of flattened) {
    if (e.op === 'eq' && isFieldRef(e.args[0]) && isFieldRef(e.args[1])) {
      const a = e.args[0] as FieldRef
      const bRef = e.args[1] as FieldRef
      walk(a, true, fields)
      walk(bRef, true, fields)
      const ra = resolve(varOf(a), unify)
      const rb = resolve(varOf(bRef), unify)
      if (ra !== rb) unify.set(rb, ra)
    } else {
      remaining.push(e)
    }
  }

  // Pass 2: an eq between a field ref and a constant is an index lookup. Everything else is a predicate.
  for (const e of remaining) {
    const a0 = e.args[0]
    const a1 = e.args[1]
    if (e.op === 'eq' && isFieldRef(a0) && !isFieldRef(a1) && !isExprNode(a1)) {
      walk(a0, true, fields)
      consts.set(resolve(varOf(a0), unify), a1 as TupleValue)
    } else if (e.op === 'eq' && isFieldRef(a1) && !isFieldRef(a0) && !isExprNode(a0)) {
      walk(a1, true, fields)
      consts.set(resolve(varOf(a1), unify), a0 as TupleValue)
    } else {
      walk(e, true, fields)
      predicates.push((ctx: Context) => Boolean(evalExpr(e, (r) => resolveCtxValue(r, ctx, unify, consts))))
    }
  }

  // select, orderBy, groupBy and having also read fields. select and orderBy do
  // not gate which rows match, so their reads are optional.
  const aliasNames = sources.map((s) => s.alias)
  const sampleRefs = refsFor(aliasNames)
  const selectTemplate: Record<string, unknown> | null = b._selectFn ? b._selectFn(sampleRefs) : null
  if (selectTemplate) walk(selectTemplate, false, fields)

  const orderTemplates: { template: unknown; dir: 'asc' | 'desc' }[] = []
  for (const o of b._orders) {
    const t = o.fn(sampleRefs)
    walk(t, false, fields)
    orderTemplates.push({ template: t, dir: o.dir })
  }

  const groupTemplate = b._groupByFn ? b._groupByFn(sampleRefs) : null
  if (groupTemplate !== null) walk(groupTemplate, true, fields)

  const havingTemplates = b._havingExprs
  for (const h of havingTemplates) walk(h, false, fields)

  // A select or a having that holds an aggregate groups every row into one
  // group when groupBy was never called, as SQL does.
  const grouped =
    groupTemplate !== null || hasAggregate(selectTemplate) || havingTemplates.some((h) => hasAggregate(h))

  const slot = (v: string): Slot => (consts.has(v) ? (consts.get(v) as Slot) : v)

  const where: WhereClause[] = []
  for (const src of sources) {
    const idVar = resolve('?' + src.alias, unify)
    const idSlot = slot(idVar)
    const pathSlot = `${src.path}/${idSlot}`
    const basePattern: Pattern = [pathSlot, '_id', idSlot]

    const gating: Pattern[] = []
    const extra: Pattern[] = []
    for (const f of fields.values()) {
      if (f.alias !== src.alias) continue
      const rawVar = varOf({ $ref: true, alias: f.alias, field: f.field })
      const canon = resolve(rawVar, unify)
      const fieldPattern: Pattern = [pathSlot, f.field, slot(canon)]
      if (f.required) gating.push(fieldPattern)
      else extra.push(fieldPattern)
    }

    if (src.optional) {
      // An optional alias joins as a whole. The base pattern and every
      // condition on it go in one all-or-nothing group, so a record that fails
      // one condition leaves the alias absent rather than half bound. Fields
      // that only `select` or `orderBy` read stay individually optional, so a
      // missing title does not drop the row.
      where.push({ optAll: [basePattern, ...gating] })
      for (const pat of extra) where.push({ opt: pat })
    } else {
      where.push(basePattern)
      for (const pat of gating) where.push(pat)
      for (const pat of extra) where.push({ opt: pat })
    }
  }
  for (const pred of predicates) where.push(pred)

  function resolveCtxValueBound(r: FieldRef, ctx: Context): unknown {
    return resolveCtxValue(r, ctx, unify, consts)
  }

  /** Evaluates a template against one context. No aggregate may appear here. */
  function evalTemplate(v: unknown, ctx: Context): unknown {
    if (isFieldRef(v)) return resolveCtxValueBound(v, ctx)
    if (isExprNode(v)) return evalExpr(v as Expr, (r) => resolveCtxValueBound(r, ctx))
    if (Array.isArray(v)) return v.map((el) => evalTemplate(el, ctx))
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = evalTemplate(val, ctx)
      return out
    }
    return v
  }

  /**
   * Evaluates a template against a whole group. An aggregate folds over every
   * context. A plain field read takes the first context's value, so a select
   * may name a field that is neither grouped nor aggregated.
   */
  function evalGroupTemplate(v: unknown, ctxs: Context[]): unknown {
    if (isAggregate(v)) return foldAggregate(v, ctxs)
    if (isFieldRef(v)) return resolveCtxValueBound(v, ctxs[0] ?? {})
    if (isExprNode(v)) {
      // An aggregate can sit inside an expression, as in gt(count(), 2). Fold
      // the aggregates first, then evaluate the expression over the result.
      if (hasAggregate(v)) {
        const folded: ExprNode = { ...v, args: v.args.map((a) => foldedArg(a, ctxs)) }
        return evalExpr(folded as Expr, (r) => resolveCtxValueBound(r, ctxs[0] ?? {}))
      }
      return evalExpr(v as Expr, (r) => resolveCtxValueBound(r, ctxs[0] ?? {}))
    }
    if (Array.isArray(v)) return v.map((el) => evalGroupTemplate(el, ctxs))
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = evalGroupTemplate(val, ctxs)
      return out
    }
    return v
  }

  /** Replaces an aggregate argument with its folded value, leaving the rest alone. */
  function foldedArg(a: Expr, ctxs: Context[]): Expr {
    if (isAggregate(a as unknown)) return foldAggregate(a as unknown as AggregateNode, ctxs) as Expr
    if (isExprNode(a) && hasAggregate(a)) {
      return { ...a, args: a.args.map((inner) => foldedArg(inner, ctxs)) }
    }
    return a
  }

  /** Folds one aggregate over a group, reading each context as a row. */
  function foldAggregate(a: AggregateNode, ctxs: Context[]): unknown {
    const readers = ctxs.map((ctx) => (r: FieldRef) => resolveCtxValueBound(r, ctx))
    return evalAggregate(a, readers)
  }

  /** The `{ alias: record }` view of one context. */
  function namespace(index: TupleIndex, ctx: Context): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const src of sources) {
      const idVar = resolve('?' + src.alias, unify)
      const idVal = consts.has(idVar) ? consts.get(idVar) : ctx[idVar]
      if (idVal === undefined) {
        out[src.alias] = undefined
        continue
      }
      const attrs = index.attrs(`${src.path}/${idVal as string}`)
      out[src.alias] = attrs ? decodeRecord(attrs.values()) : undefined
    }
    return out
  }

  function row(index: TupleIndex, ctxs: Context[]): unknown {
    if (selectTemplate) {
      return grouped ? evalGroupTemplate(selectTemplate, ctxs) : evalTemplate(selectTemplate, ctxs[0] ?? {})
    }
    return namespace(index, ctxs[0] ?? {})
  }

  function groupKey(ctx: Context): unknown[] {
    if (groupTemplate === null) return []
    const value = evalTemplate(groupTemplate, ctx)
    return Array.isArray(value) ? value : [value]
  }

  const having = havingTemplates.map(
    (h) =>
      (_index: TupleIndex, ctxs: Context[]): boolean =>
        Boolean(evalGroupTemplate(h, ctxs)),
  )

  const orders = orderTemplates.map((o) => ({
    read: (_index: TupleIndex, ctxs: Context[]): unknown =>
      grouped ? evalGroupTemplate(o.template, ctxs) : evalTemplate(o.template, ctxs[0] ?? {}),
    dir: o.dir,
  }))

  // A right or a full join keeps the records that the pattern run cannot
  // produce: those with no match on the other side. Collect one anti-join pass
  // per alias that needs it. For a full join, both sides need one.
  const antiJoins: AntiJoin[] = []
  const antiAliases = new Set<string>()
  sources.forEach((src, i) => {
    if (src.kind !== 'right' && src.kind !== 'full') return
    antiAliases.add(src.alias)
    if (src.kind === 'full') {
      for (let j = 0; j < i; j++) antiAliases.add(sources[j]!.alias)
    }
  })
  for (const alias of antiAliases) {
    const src = sources.find((x) => x.alias === alias)
    if (!src) continue
    const idVar = resolve('?' + alias, unify)
    antiJoins.push({
      alias,
      path: src.path,
      idVar,
      bind(index: TupleIndex, id: string): Context {
        const ctx: Context = { [idVar]: id }
        const attrs = index.attrs(`${src.path}/${id}`)
        if (!attrs) return ctx
        for (const f of fields.values()) {
          if (f.alias !== alias) continue
          const canon = resolve(varOf({ $ref: true, alias, field: f.field }), unify)
          const tuple = attrs.get(f.field)
          if (tuple === undefined) continue
          // A constant fixed by an `eq` still applies on the preserved side.
          if (consts.has(canon)) continue
          ctx[canon] = tuple.value
        }
        return ctx
      },
    })
  }

  return {
    where,
    row,
    namespace,
    grouped,
    groupKey,
    having,
    distinct: b._distinct,
    limit: b._limit,
    offset: b._offset,
    orders,
    fnWhere: b._fnWhere,
    fnHaving: b._fnHaving,
    fnSelect: b._fnSelect,
    antiJoins,
  }
}

/** Resolves a field ref to its bound value: the constant slot if `eq` fixed it, else the context binding. */
function resolveCtxValue(
  r: FieldRef,
  ctx: Context,
  unify: Map<string, string>,
  consts: Map<string, TupleValue>,
): unknown {
  const canon = resolve(varOf(r), unify)
  return consts.has(canon) ? consts.get(canon) : ctx[canon]
}
