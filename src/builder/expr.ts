/**
 * Expression trees for the query builder. `where`, `join`, `select`, and
 * `orderBy` callbacks build these trees out of field references and the
 * comparison and string functions below. `compile.ts` reads the tree to emit
 * patterns and predicates; `evalExpr` runs the tree against real values.
 */
import { invalidQuery } from '../core/errors.js'
import type { TupleValue } from '../core/types.js'
import { isDate, valueEquals } from '../core/value.js'

/** A reference to a field of an alias. The builder proxies produce these. */
export interface FieldRef {
  $ref: true
  alias: string
  field: string
}

/** True when `x` is a `FieldRef`. */
export function isFieldRef(x: unknown): x is FieldRef {
  return typeof x === 'object' && x !== null && (x as { $ref?: unknown }).$ref === true
}

/** An expression: a field reference, an expression node, or a plain value. */
export type Expr = FieldRef | ExprNode | TupleValue

/** One node of an expression tree, built by `eq`, `gt`, `and`, and the rest. */
export interface ExprNode {
  $expr: true
  op: string
  args: Expr[]
}

/**
 * True when `x` is an `ExprNode`. Not part of the frozen contract; exported
 * because `compile.ts` needs the same check and duplicating it would drift.
 */
export function isExprNode(x: unknown): x is ExprNode {
  return typeof x === 'object' && x !== null && (x as { $expr?: unknown }).$expr === true
}

function node(op: string, args: Expr[]): ExprNode {
  return { $expr: true, op, args }
}

/**
 * A field-ref proxy for one alias. Any string property read returns a
 * `FieldRef` for that alias and field, so a callback can read any field name,
 * including the same one more than once. A non-string property read, such as
 * a symbol, throws rather than building a broken ref. The proxy holds no
 * state and evaluates nothing, so it is safe to call a builder callback with
 * it purely to inspect which fields the callback reads, without running the
 * query.
 *
 * Not part of the frozen contract; exported because `query.ts` and
 * `compile.ts` both need to build the same kind of proxy at different times.
 */
export function fieldProxy(alias: string): Record<string, unknown> {
  return new Proxy(Object.create(null), {
    get(_target, prop): FieldRef {
      if (typeof prop !== 'string') {
        throw invalidQuery('a query builder callback read a non-string property of a field ref')
      }
      return { $ref: true, alias, field: prop }
    },
  }) as Record<string, unknown>
}

/** `a == b`. Between two field refs this is a join. Between a field ref and a constant it is an index lookup. */
export function eq(a: Expr, b: Expr): ExprNode {
  return node('eq', [a, b])
}
/** `a != b`. */
export function ne(a: Expr, b: Expr): ExprNode {
  return node('ne', [a, b])
}
/** `a > b`. */
export function gt(a: Expr, b: Expr): ExprNode {
  return node('gt', [a, b])
}
/** `a >= b`. */
export function gte(a: Expr, b: Expr): ExprNode {
  return node('gte', [a, b])
}
/** `a < b`. */
export function lt(a: Expr, b: Expr): ExprNode {
  return node('lt', [a, b])
}
/** `a <= b`. */
export function lte(a: Expr, b: Expr): ExprNode {
  return node('lte', [a, b])
}
/** True when every argument is truthy. A top-level `and` in `where` or `join` splits into separate conditions. */
export function and(...xs: Expr[]): ExprNode {
  return node('and', xs)
}
/** True when any argument is truthy. */
export function or(...xs: Expr[]): ExprNode {
  return node('or', xs)
}
/** True when `x` is falsy. */
export function not(x: Expr): ExprNode {
  return node('not', [x])
}
/** True when `needle` equals an element of the `haystack` array. */
export function inArray(needle: Expr, haystack: Expr): ExprNode {
  return node('in', [needle, haystack])
}
/** SQL-style pattern match. `%` matches any run of characters, `_` matches one character. */
export function like(x: Expr, pattern: Expr): ExprNode {
  return node('like', [x, pattern])
}
/** Case-insensitive `like`. */
export function ilike(x: Expr, pattern: Expr): ExprNode {
  return node('ilike', [x, pattern])
}
/** True when the string `x` starts with `prefix`. */
export function startsWith(x: Expr, prefix: Expr): ExprNode {
  return node('startsWith', [x, prefix])
}
/** True when the string `x` ends with `suffix`. */
export function endsWith(x: Expr, suffix: Expr): ExprNode {
  return node('endsWith', [x, suffix])
}
/** True when `x` evaluates to `undefined`. */
export function isUndefined(x: Expr): ExprNode {
  return node('isUndefined', [x])
}
/** The length of a string or an array. `undefined` for anything else. */
export function length(x: Expr): ExprNode {
  return node('length', [x])
}
/** Upper-cases a string. */
export function upper(x: Expr): ExprNode {
  return node('upper', [x])
}
/** Lower-cases a string. */
export function lower(x: Expr): ExprNode {
  return node('lower', [x])
}

/** True when `x` evaluates to exactly `null`. Unlike `isUndefined`, a missing field is not `null`. */
export function isNull(x: Expr): ExprNode {
  return node('isNull', [x])
}
/** Concatenates every argument as a string. Yields `undefined` if any argument is `null` or `undefined`. */
export function concat(...xs: Expr[]): ExprNode {
  return node('concat', xs)
}
/** `a + b`. Yields `undefined` if either argument is `null` or `undefined`. */
export function add(a: Expr, b: Expr): ExprNode {
  return node('add', [a, b])
}
/** `a - b`. Yields `undefined` if either argument is `null` or `undefined`. */
export function subtract(a: Expr, b: Expr): ExprNode {
  return node('subtract', [a, b])
}
/** `a * b`. Yields `undefined` if either argument is `null` or `undefined`. */
export function multiply(a: Expr, b: Expr): ExprNode {
  return node('multiply', [a, b])
}
/** `a / b`. Yields `undefined` if either argument is `null` or `undefined`, or if `b` is zero. */
export function divide(a: Expr, b: Expr): ExprNode {
  return node('divide', [a, b])
}
/** The first argument that is neither `null` nor `undefined`. `undefined` if every argument is. */
export function coalesce(...xs: Expr[]): ExprNode {
  return node('coalesce', xs)
}
/** `whenTrue` if `condition` is truthy, else `whenFalse`. Without `whenFalse`, a false condition yields `undefined`. */
export function caseWhen(condition: Expr, whenTrue: Expr, whenFalse?: Expr): ExprNode {
  return node('case', whenFalse === undefined ? [condition, whenTrue] : [condition, whenTrue, whenFalse])
}

/** Ordinal comparison. A `Date` compares by its epoch milliseconds. */
function compareOrd(a: unknown, b: unknown): number {
  const av = isDate(a) ? a.getTime() : a
  const bv = isDate(b) ? b.getTime() : b
  if ((av as number | string | bigint) < (bv as number | string | bigint)) return -1
  if ((av as number | string | bigint) > (bv as number | string | bigint)) return 1
  return 0
}

/** Escapes one character for use inside a regular expression. */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch
}

/** Turns a SQL-style `%`/`_` pattern into an anchored `RegExp`. */
function likeToRegExp(pattern: string, ci: boolean): RegExp {
  let src = ''
  for (const ch of pattern) {
    if (ch === '%') src += '.*'
    else if (ch === '_') src += '.'
    else src += escapeRegExpChar(ch)
  }
  return new RegExp(`^${src}$`, ci ? 'is' : 's')
}

function likeMatch(value: unknown, pattern: unknown, ci: boolean): boolean {
  return likeToRegExp(String(pattern), ci).test(String(value))
}

function lengthOf(x: unknown): number | undefined {
  if (typeof x === 'string' || Array.isArray(x)) return x.length
  return undefined
}

function inArrayEval(needle: unknown, haystack: unknown): boolean {
  if (!Array.isArray(haystack)) return false
  return haystack.some((el) => valueEquals(el, needle))
}

/**
 * Applies a numeric operator to two values, propagating `null`/`undefined`.
 * Two bigints combine as a bigint; anything else is treated as a number.
 */
function arith(
  a: unknown,
  b: unknown,
  fn: (x: number, y: number) => number,
  bigFn: (x: bigint, y: bigint) => bigint,
): unknown {
  if (a === null || a === undefined || b === null || b === undefined) return undefined
  if (typeof a === 'bigint' && typeof b === 'bigint') return bigFn(a, b)
  return fn(a as number, b as number)
}

/** `a / b`, propagating `null`/`undefined` and yielding `undefined` rather than `Infinity` on division by zero. */
function divideEval(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined || b === null || b === undefined) return undefined
  if (typeof a === 'bigint' && typeof b === 'bigint') return b === 0n ? undefined : a / b
  return (b as number) === 0 ? undefined : (a as number) / (b as number)
}

/** Concatenates every argument as a string, or `undefined` if any is `null` or `undefined`. */
function concatEval(xs: unknown[]): unknown {
  if (xs.some((x) => x === null || x === undefined)) return undefined
  return xs.map((x) => String(x)).join('')
}

/**
 * Evaluates an expression tree. `read` resolves a `FieldRef` to its bound
 * value; a plain value in the tree evaluates to itself. Throws
 * `INVALID_QUERY` for an operator this module does not know, and for an
 * `AggregateNode`, which `evalAggregate` folds over a group instead.
 */
export function evalExpr(e: Expr, read: (r: FieldRef) => unknown): unknown {
  if (isAggregate(e)) {
    throw invalidQuery('an aggregate cannot be evaluated on its own row; it needs a groupBy or a select')
  }
  if (isFieldRef(e)) return read(e)
  if (!isExprNode(e)) return e

  const args = e.args.map((a) => evalExpr(a, read))
  switch (e.op) {
    case 'eq':
      return valueEquals(args[0], args[1])
    case 'ne':
      return !valueEquals(args[0], args[1])
    case 'gt':
      return compareOrd(args[0], args[1]) > 0
    case 'gte':
      return compareOrd(args[0], args[1]) >= 0
    case 'lt':
      return compareOrd(args[0], args[1]) < 0
    case 'lte':
      return compareOrd(args[0], args[1]) <= 0
    case 'and':
      return args.every(Boolean)
    case 'or':
      return args.some(Boolean)
    case 'not':
      return !args[0]
    case 'in':
      return inArrayEval(args[0], args[1])
    case 'like':
      return likeMatch(args[0], args[1], false)
    case 'ilike':
      return likeMatch(args[0], args[1], true)
    case 'startsWith':
      return typeof args[0] === 'string' && typeof args[1] === 'string' && args[0].startsWith(args[1])
    case 'endsWith':
      return typeof args[0] === 'string' && typeof args[1] === 'string' && args[0].endsWith(args[1])
    case 'isUndefined':
      return args[0] === undefined
    case 'length':
      return lengthOf(args[0])
    case 'upper':
      return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0]
    case 'lower':
      return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0]
    case 'isNull':
      return args[0] === null
    case 'concat':
      return concatEval(args)
    case 'add':
      return arith(args[0], args[1], (x, y) => x + y, (x, y) => x + y)
    case 'subtract':
      return arith(args[0], args[1], (x, y) => x - y, (x, y) => x - y)
    case 'multiply':
      return arith(args[0], args[1], (x, y) => x * y, (x, y) => x * y)
    case 'divide':
      return divideEval(args[0], args[1])
    case 'coalesce':
      return args.find((a) => a !== null && a !== undefined)
    case 'case':
      return args[0] ? args[1] : args[2]
    default:
      throw invalidQuery(`unknown expression operator: ${e.op}`)
  }
}

/** An aggregate over the rows of a group: `count`, `sum`, `avg`, `min`, or `max`. */
export interface AggregateNode {
  $agg: true
  op: 'count' | 'sum' | 'avg' | 'min' | 'max'
  arg?: Expr
}

/** True when `x` is an `AggregateNode`. */
export function isAggregate(x: unknown): x is AggregateNode {
  return typeof x === 'object' && x !== null && (x as { $agg?: unknown }).$agg === true
}

/** Counts rows. With no argument, counts every row. With `x`, counts rows where `x` is neither null nor undefined. */
export function count(x?: Expr): AggregateNode {
  return x === undefined ? { $agg: true, op: 'count' } : { $agg: true, op: 'count', arg: x }
}
/** Sums `x` over the group, skipping null and undefined. 0 for an empty group. */
export function sum(x: Expr): AggregateNode {
  return { $agg: true, op: 'sum', arg: x }
}
/** Averages `x` over the group, skipping null and undefined. `undefined` for an empty group. */
export function avg(x: Expr): AggregateNode {
  return { $agg: true, op: 'avg', arg: x }
}
/** The smallest value of `x` over the group, skipping null and undefined. Compares like `lt`/`gt`. */
export function min(x: Expr): AggregateNode {
  return { $agg: true, op: 'min', arg: x }
}
/** The largest value of `x` over the group, skipping null and undefined. Compares like `lt`/`gt`. */
export function max(x: Expr): AggregateNode {
  return { $agg: true, op: 'max', arg: x }
}

/**
 * Folds an aggregate over the rows of one group. `read` resolves a field ref
 * per row; `rows` holds one `read` function per row of the group.
 */
export function evalAggregate(a: AggregateNode, rows: Array<(r: FieldRef) => unknown>): unknown {
  switch (a.op) {
    case 'count': {
      if (a.arg === undefined) return rows.length
      const arg = a.arg
      let n = 0
      for (const read of rows) {
        const v = evalExpr(arg, read)
        if (v !== null && v !== undefined) n++
      }
      return n
    }
    case 'sum': {
      const arg = a.arg as Expr
      let total = 0
      for (const read of rows) {
        const v = evalExpr(arg, read)
        if (v === null || v === undefined) continue
        total += v as number
      }
      return total
    }
    case 'avg': {
      const arg = a.arg as Expr
      let total = 0
      let n = 0
      for (const read of rows) {
        const v = evalExpr(arg, read)
        if (v === null || v === undefined) continue
        total += v as number
        n++
      }
      return n === 0 ? undefined : total / n
    }
    case 'min':
    case 'max': {
      const arg = a.arg as Expr
      let best: unknown
      let has = false
      for (const read of rows) {
        const v = evalExpr(arg, read)
        if (v === null || v === undefined) continue
        if (!has || (a.op === 'min' ? compareOrd(v, best) < 0 : compareOrd(v, best) > 0)) {
          best = v
          has = true
        }
      }
      return has ? best : undefined
    }
    default:
      throw invalidQuery(`unknown aggregate operator: ${a.op as string}`)
  }
}
