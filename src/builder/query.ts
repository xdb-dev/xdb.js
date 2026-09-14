/**
 * The live-query builder. `from`, the four join kinds, `where`, `groupBy`,
 * `having`, `distinct`, `select`, `orderBy`, `limit`, and `offset` describe a
 * query over one or more aliased sources. `compile` turns the description into
 * patterns; `run` executes them against a `TupleIndex` and returns rows.
 *
 * The surface follows TanStack DB. A `where` call builds an expression tree,
 * not a per-row predicate, so the compiler can turn an equality into an index
 * lookup. The `fn` namespace is the escape hatch for plain JavaScript.
 */
import type { Context } from '../core/types.js'
import type { Footprint } from '../query/footprint.js'
import { runContexts } from '../query/engine.js'
import type { TupleIndex } from '../store/tuple-index.js'
import { compile } from './compile.js'
import type { CompiledQuery } from './compile.js'
import { fieldProxy } from './expr.js'
import type { ExprNode } from './expr.js'
import { isDate, valueKey } from '../core/value.js'
import { idOf } from '../core/uri.js'

/** A source of a query: a collection, or anything with a schema path. */
export interface QuerySource {
  path: string
}

/** How a source joins to the aliases declared before it. */
export type JoinKind = 'from' | 'left' | 'inner' | 'right' | 'full'

/** One aliased source the builder has collected, in `from`/`join` order. */
interface SourceEntry {
  alias: string
  path: string
  kind: JoinKind
  /** True when a row survives with no matching record for this alias. */
  optional: boolean
}

/** One `orderBy` call the builder has collected. */
interface OrderEntry {
  fn: (refs: Record<string, unknown>) => unknown
  dir: 'asc' | 'desc'
}

/**
 * A live-query builder. Chain `from`, `join`, `where`, `select`, `orderBy`,
 * `limit`, and `offset`, then call `run` against a `TupleIndex`, or `compile`
 * to inspect the pattern list.
 *
 * The `Aliases` type parameter is a placeholder for future row typing; the
 * runtime shape does not depend on it today.
 */
export class QueryBuilder<Aliases extends Record<string, unknown> = {}> {
  /** @internal Collected `from`/`join` sources, in call order. */
  _sources: SourceEntry[] = []
  /** @internal Collected `where` and `join` condition trees. */
  _exprs: ExprNode[] = []
  /** @internal The `select` projection, if any. */
  _selectFn: ((refs: Record<string, unknown>) => Record<string, unknown>) | null = null
  /** @internal Collected `orderBy` calls, in call order. */
  _orders: OrderEntry[] = []
  /** @internal The `limit`, or `Infinity` when never set. */
  _limit = Infinity
  /** @internal The `offset`, or `0` when never set. */
  _offset = 0
  /** @internal The `groupBy` key builder, if any. */
  _groupByFn: ((refs: Record<string, unknown>) => unknown) | null = null
  /** @internal Collected `having` condition trees, evaluated over a whole group. */
  _havingExprs: ExprNode[] = []
  /** @internal True after `distinct`. */
  _distinct = false
  /** @internal Raw predicates from `fn.where`, run per row after the pattern run. */
  _fnWhere: ((row: any) => boolean)[] = []
  /** @internal Raw predicates from `fn.having`, run per group. */
  _fnHaving: ((row: any) => boolean)[] = []
  /** @internal The raw projection from `fn.select`, applied last. */
  _fnSelect: ((row: any) => unknown) | null = null

  /** Builds the compile-time field-ref proxies for every alias seen so far. */
  private refs(): Record<string, unknown> {
    const r: Record<string, unknown> = {}
    for (const s of this._sources) r[s.alias] = fieldProxy(s.alias)
    return r
  }

  /** Adds required sources. Every alias here must have a matching record for a row to exist. */
  from(sources: Record<string, QuerySource>): this {
    for (const [alias, src] of Object.entries(sources)) {
      this._sources.push({ alias, path: src.path, kind: 'from', optional: false })
    }
    return this
  }

  /**
   * Adds joined sources. `on` receives field-ref proxies for every alias
   * declared so far, including the ones this call adds. `type` defaults to
   * `'left'`: a row survives even when no record matches the joined alias.
   * `'inner'` drops such a row.
   */
  join(sources: Record<string, QuerySource>, on: (refs: any) => ExprNode, type: JoinKind = 'left'): this {
    for (const [alias, src] of Object.entries(sources)) {
      // A right or a full join keeps rows that have no match on this side, so
      // the pattern run treats the alias as required and `run` adds the
      // unmatched rows in a second pass. See `antiJoins` in compile.ts.
      this._sources.push({ alias, path: src.path, kind: type, optional: type === 'left' })
    }
    this._exprs.push(on(this.refs()))
    return this
  }

  /** `join` with `type: 'inner'`: a row needs a match on both sides. */
  innerJoin(sources: Record<string, QuerySource>, on: (refs: any) => ExprNode): this {
    return this.join(sources, on, 'inner')
  }

  /** The same as `join`: keeps a row whose joined record is missing. */
  leftJoin(sources: Record<string, QuerySource>, on: (refs: any) => ExprNode): this {
    return this.join(sources, on, 'left')
  }

  /** Keeps every record of the joined alias, even with no match on the earlier aliases. */
  rightJoin(sources: Record<string, QuerySource>, on: (refs: any) => ExprNode): this {
    return this.join(sources, on, 'right')
  }

  /** Keeps unmatched records on both sides. */
  fullJoin(sources: Record<string, QuerySource>, on: (refs: any) => ExprNode): this {
    return this.join(sources, on, 'full')
  }

  /** Adds a filter condition. `fn` receives field-ref proxies for every alias declared so far. */
  where(fn: (refs: any) => ExprNode): this {
    this._exprs.push(fn(this.refs()))
    return this
  }

  /** Sets the row projection. Without it, a row is one decoded record per alias. */
  select(fn: (refs: any) => Record<string, unknown>): this {
    this._selectFn = fn as (refs: Record<string, unknown>) => Record<string, unknown>
    return this
  }

  /**
   * Groups the rows by one key or by an array of keys. A `select` may then use
   * the aggregates from `expr.js`, such as `count` and `sum`.
   */
  groupBy(fn: (refs: any) => unknown | unknown[]): this {
    this._groupByFn = fn as (refs: Record<string, unknown>) => unknown
    return this
  }

  /** Filters groups after aggregation, so the condition may use an aggregate. */
  having(fn: (refs: any) => ExprNode): this {
    this._havingExprs.push(fn(this.refs()))
    return this
  }

  /** Drops duplicate rows, compared by value. Applied after `having`. */
  distinct(): this {
    this._distinct = true
    return this
  }

  /**
   * Plain JavaScript over whole rows. Each callback receives `{ alias: record }`
   * and runs once per row, so the compiler cannot read it: a `fn` filter uses no
   * index and the optimizer cannot reorder around it. Prefer `where` unless the
   * condition is impossible to express with the expression functions. This
   * mirrors TanStack DB's `fn` namespace.
   */
  get fn(): {
    where: (predicate: (row: any) => boolean) => QueryBuilder
    having: (predicate: (row: any) => boolean) => QueryBuilder
    select: (project: (row: any) => unknown) => QueryBuilder
  } {
    return {
      where: (predicate) => {
        this._fnWhere.push(predicate)
        return this
      },
      having: (predicate) => {
        this._fnHaving.push(predicate)
        return this
      },
      select: (project) => {
        this._fnSelect = project
        return this
      },
    }
  }

  /** Adds a sort key. Later calls are tiebreakers for earlier ones. Applied after the pattern run. */
  orderBy(fn: (refs: any) => unknown, dir: 'asc' | 'desc' = 'asc'): this {
    this._orders.push({ fn: fn as (refs: Record<string, unknown>) => unknown, dir })
    return this
  }

  /** Caps the row count. Applied after `orderBy` and `offset`. */
  limit(n: number): this {
    this._limit = n
    return this
  }

  /** Skips this many leading rows. Applied after `orderBy`, before `limit`. */
  offset(n: number): this {
    this._offset = n
    return this
  }

  /** Compiles this builder to patterns. See `compile.ts`. */
  compile(): CompiledQuery {
    return compile(this)
  }

  /**
   * Runs this query against `index` and returns the rows. Records every
   * schema and attribute the run touched in `footprint`, when given.
   *
   * The stages run in this order: the pattern run, the anti-join passes that
   * add unmatched rows for a right or a full join, `fn.where`, grouping,
   * aggregation, `having` and `fn.having`, `distinct`, `orderBy`, `offset`,
   * `limit`, then `select` and `fn.select`.
   *
   * The projected row is built once per group, before `having` runs, and
   * reused as the output row. A projection has no side effects and cannot
   * change which rows survive, so building it early is unobservable.
   */
  run(index: TupleIndex, footprint?: Footprint): unknown[] {
    const compiled = this.compile()
    let contexts = runContexts(index, compiled.where, footprint)

    // A single ordered pattern run yields only matched rows. A right or a full
    // join also wants the records with no match, so add them here, one pass per
    // alias that asked for them.
    for (const anti of compiled.antiJoins) {
      const matched = new Set<unknown>()
      for (const ctx of contexts) matched.add(ctx[anti.idVar])
      for (const path of index.paths(anti.path)) {
        const id = idOf(path)
        if (matched.has(id)) continue
        contexts.push(anti.bind(index, id))
      }
      if (footprint) footprint.add(anti.path, null)
    }

    // fn.where: plain JavaScript over the row namespace, per row.
    for (const predicate of compiled.fnWhere) {
      contexts = contexts.filter((ctx) => predicate(compiled.namespace(index, ctx)))
    }

    // Grouping. An ungrouped query makes each context its own group of one, so
    // the aggregate path and the plain path share the rest of the pipeline.
    let groups: Context[][]
    if (compiled.grouped) {
      const byKey = new Map<string, Context[]>()
      for (const ctx of contexts) {
        const key = valueKey(compiled.groupKey(ctx))
        const bucket = byKey.get(key)
        if (bucket) bucket.push(ctx)
        else byKey.set(key, [ctx])
      }
      groups = [...byKey.values()]
    } else {
      groups = contexts.map((ctx) => [ctx])
    }

    // Aggregation happens inside `row`, which folds an aggregate over its group.
    let rows = groups.map((ctxs) => ({ ctxs, value: compiled.row(index, ctxs) }))

    for (const test of compiled.having) rows = rows.filter((r) => test(index, r.ctxs))
    for (const predicate of compiled.fnHaving) rows = rows.filter((r) => predicate(r.value))

    if (compiled.distinct) {
      const seen = new Set<string>()
      rows = rows.filter((r) => {
        const key = valueKey(r.value)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    if (compiled.orders.length > 0) {
      const decorated = rows.map((r) => ({
        r,
        keys: compiled.orders.map((o) => o.read(index, r.ctxs)),
      }))
      decorated.sort((x, y) => {
        for (let i = 0; i < compiled.orders.length; i++) {
          const cmp = compareOrdered(x.keys[i], y.keys[i])
          if (cmp !== 0) return compiled.orders[i].dir === 'desc' ? -cmp : cmp
        }
        return 0
      })
      rows = decorated.map((d) => d.r)
    }

    rows = rows.slice(compiled.offset, compiled.offset + compiled.limit)

    const out = rows.map((r) => r.value)
    return compiled.fnSelect ? out.map((row) => compiled.fnSelect!(row)) : out
  }
}

/** Ordinal comparison for a sort key. A `Date` compares by its epoch milliseconds. */
function compareOrdered(a: unknown, b: unknown): number {
  const av = isDate(a) ? a.getTime() : a
  const bv = isDate(b) ? b.getTime() : b
  if ((av as number | string | bigint) < (bv as number | string | bigint)) return -1
  if ((av as number | string | bigint) > (bv as number | string | bigint)) return 1
  return 0
}

/** Starts a builder. `q` in the examples. */
export function query(): QueryBuilder {
  return new QueryBuilder()
}
