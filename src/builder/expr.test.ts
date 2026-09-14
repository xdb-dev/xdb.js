import { describe, expect, it } from 'vitest'
import {
  add,
  and,
  avg,
  caseWhen,
  coalesce,
  concat,
  count,
  divide,
  endsWith,
  eq,
  evalAggregate,
  evalExpr,
  gt,
  gte,
  ilike,
  inArray,
  isAggregate,
  isFieldRef,
  isNull,
  isUndefined,
  length,
  like,
  lower,
  lt,
  lte,
  max,
  min,
  multiply,
  ne,
  not,
  or,
  startsWith,
  subtract,
  sum,
  upper,
} from './expr.js'
import type { FieldRef } from './expr.js'

/** Reads a field ref out of a flat `{ alias.field: value }` bag. Used by every test below. */
function makeReader(values: Record<string, unknown>): (r: FieldRef) => unknown {
  return (r) => values[`${r.alias}.${r.field}`]
}

describe('isFieldRef', () => {
  it('is true only for a $ref object', () => {
    expect(isFieldRef({ $ref: true, alias: 'a', field: 'b' })).toBe(true)
    expect(isFieldRef({ alias: 'a', field: 'b' })).toBe(false)
    expect(isFieldRef(null)).toBe(false)
    expect(isFieldRef(3)).toBe(false)
  })
})

describe('evalExpr', () => {
  const read = makeReader({ 'post.views': 100, 'post.title': 'Hello World', 'post.tags': ['a', 'b', 'c'] })
  const post = (field: string): FieldRef => ({ $ref: true, alias: 'post', field })

  it('evaluates a plain constant to itself', () => {
    expect(evalExpr(3, read)).toBe(3)
    expect(evalExpr('x', read)).toBe('x')
  })

  it('resolves a field ref through the reader', () => {
    expect(evalExpr(post('views'), read)).toBe(100)
  })

  it('eq and ne', () => {
    expect(evalExpr(eq(post('views'), 100), read)).toBe(true)
    expect(evalExpr(eq(post('views'), 3), read)).toBe(false)
    expect(evalExpr(ne(post('views'), 3), read)).toBe(true)
    expect(evalExpr(eq(post('views'), 100n), read)).toBe(true)
  })

  it('gt, gte, lt, lte', () => {
    expect(evalExpr(gt(post('views'), 50), read)).toBe(true)
    expect(evalExpr(gt(post('views'), 500), read)).toBe(false)
    expect(evalExpr(gte(post('views'), 100), read)).toBe(true)
    expect(evalExpr(lt(post('views'), 500), read)).toBe(true)
    expect(evalExpr(lte(post('views'), 100), read)).toBe(true)
  })

  it('compares Date values by epoch milliseconds', () => {
    const dread = makeReader({ 'e.at': new Date('2024-01-02') })
    const at = (): FieldRef => ({ $ref: true, alias: 'e', field: 'at' })
    expect(evalExpr(gt(at(), new Date('2024-01-01')), dread)).toBe(true)
    expect(evalExpr(lt(at(), new Date('2024-01-03')), dread)).toBe(true)
  })

  it('and, or, not', () => {
    expect(evalExpr(and(gt(post('views'), 1), eq(post('title'), 'Hello World')), read)).toBe(true)
    expect(evalExpr(and(gt(post('views'), 1), eq(post('title'), 'nope')), read)).toBe(false)
    expect(evalExpr(or(eq(post('title'), 'nope'), gt(post('views'), 1)), read)).toBe(true)
    expect(evalExpr(or(eq(post('title'), 'nope'), eq(post('title'), 'still nope')), read)).toBe(false)
    expect(evalExpr(not(eq(post('title'), 'nope')), read)).toBe(true)
    expect(evalExpr(not(eq(post('title'), 'Hello World')), read)).toBe(false)
  })

  it('nests and/or/not several levels deep', () => {
    const e = and(or(eq(post('title'), 'nope'), gt(post('views'), 1)), not(eq(post('views'), 3)))
    expect(evalExpr(e, read)).toBe(true)
  })

  it('inArray against an array-valued field', () => {
    expect(evalExpr(inArray('b', post('tags')), read)).toBe(true)
    expect(evalExpr(inArray('z', post('tags')), read)).toBe(false)
  })

  it('inArray against a literal list', () => {
    expect(evalExpr(inArray(post('title'), ['Hello World', 'Other']), read)).toBe(true)
    expect(evalExpr(inArray(post('title'), ['Other']), read)).toBe(false)
  })

  it('inArray is false when the haystack is not an array', () => {
    expect(evalExpr(inArray(post('title'), post('title')), read)).toBe(false)
  })

  it('like matches % and _ wildcards, case-sensitively', () => {
    expect(evalExpr(like(post('title'), 'Hello%'), read)).toBe(true)
    expect(evalExpr(like(post('title'), 'hello%'), read)).toBe(false)
    expect(evalExpr(like(post('title'), 'Hell_ World'), read)).toBe(true)
    expect(evalExpr(like(post('title'), 'Goodbye%'), read)).toBe(false)
  })

  it('ilike matches case-insensitively', () => {
    expect(evalExpr(ilike(post('title'), 'hello%'), read)).toBe(true)
    expect(evalExpr(ilike(post('title'), 'HELLO WORLD'), read)).toBe(true)
  })

  it('startsWith and endsWith', () => {
    expect(evalExpr(startsWith(post('title'), 'Hello'), read)).toBe(true)
    expect(evalExpr(startsWith(post('title'), 'World'), read)).toBe(false)
    expect(evalExpr(endsWith(post('title'), 'World'), read)).toBe(true)
    expect(evalExpr(endsWith(post('title'), 'Hello'), read)).toBe(false)
  })

  it('isUndefined', () => {
    const r2 = makeReader({})
    expect(evalExpr(isUndefined(post('missing')), r2)).toBe(true)
    expect(evalExpr(isUndefined(post('views')), read)).toBe(false)
  })

  it('length of a string and of an array', () => {
    expect(evalExpr(length(post('title')), read)).toBe(11)
    expect(evalExpr(length(post('tags')), read)).toBe(3)
    expect(evalExpr(length(post('views')), read)).toBe(undefined)
  })

  it('upper and lower', () => {
    expect(evalExpr(upper(post('title')), read)).toBe('HELLO WORLD')
    expect(evalExpr(lower(post('title')), read)).toBe('hello world')
  })

  it('isNull is true only for exactly null, not for undefined or a present value', () => {
    const r2 = makeReader({ 'post.deletedAt': null })
    expect(evalExpr(isNull(post('deletedAt')), r2)).toBe(true)
    expect(evalExpr(isNull(post('missing')), r2)).toBe(false)
    expect(evalExpr(isNull(post('views')), read)).toBe(false)
  })

  it('concat joins its arguments as strings', () => {
    expect(evalExpr(concat('a', 'b', 'c'), read)).toBe('abc')
    expect(evalExpr(concat(post('title'), '!'), read)).toBe('Hello World!')
    expect(evalExpr(concat('n=', 3), read)).toBe('n=3')
  })

  it('concat propagates null and undefined to undefined', () => {
    const r2 = makeReader({ 'post.mid': null })
    expect(evalExpr(concat('a', post('mid'), 'c'), r2)).toBe(undefined)
    expect(evalExpr(concat('a', post('missing'), 'c'), r2)).toBe(undefined)
  })

  it('add, subtract, multiply on plain numbers', () => {
    expect(evalExpr(add(2, 3), read)).toBe(5)
    expect(evalExpr(subtract(5, 3), read)).toBe(2)
    expect(evalExpr(multiply(4, 3), read)).toBe(12)
  })

  it('add, subtract, multiply propagate null and undefined', () => {
    const r2 = makeReader({ 'post.n': null })
    expect(evalExpr(add(post('n'), 1), r2)).toBe(undefined)
    expect(evalExpr(subtract(1, post('n')), r2)).toBe(undefined)
    expect(evalExpr(multiply(post('missing'), 1), r2)).toBe(undefined)
  })

  it('divide computes a normal quotient', () => {
    expect(evalExpr(divide(10, 4), read)).toBe(2.5)
  })

  it('divide by zero yields undefined, not Infinity', () => {
    expect(evalExpr(divide(10, 0), read)).toBe(undefined)
  })

  it('divide propagates null and undefined', () => {
    const r2 = makeReader({ 'post.n': null })
    expect(evalExpr(divide(post('n'), 2), r2)).toBe(undefined)
    expect(evalExpr(divide(2, post('missing')), r2)).toBe(undefined)
  })

  it('coalesce returns the first value that is neither null nor undefined', () => {
    const r2 = makeReader({ 'post.a': null, 'post.c': 0, 'post.d': false })
    expect(evalExpr(coalesce(post('a'), post('missing'), post('c')), r2)).toBe(0)
    expect(evalExpr(coalesce(post('missing'), post('d')), r2)).toBe(false)
    expect(evalExpr(coalesce(post('missing'), post('a')), r2)).toBe(undefined)
  })

  it('caseWhen returns whenTrue or whenFalse based on the condition', () => {
    expect(evalExpr(caseWhen(gt(post('views'), 1), 'many', 'few'), read)).toBe('many')
    expect(evalExpr(caseWhen(gt(post('views'), 1000), 'many', 'few'), read)).toBe('few')
  })

  it('caseWhen without whenFalse yields undefined on a false condition', () => {
    expect(evalExpr(caseWhen(gt(post('views'), 1000), 'many'), read)).toBe(undefined)
    expect(evalExpr(caseWhen(gt(post('views'), 1), 'many'), read)).toBe('many')
  })

  it('throws INVALID_QUERY when handed an aggregate', () => {
    expect(() => evalExpr(count(), read)).toThrow(/groupBy|select/)
    expect(() => evalExpr(sum(post('views')), read)).toThrow(/groupBy|select/)
  })
})

describe('isAggregate', () => {
  it('is true only for an AggregateNode, not an ExprNode or a FieldRef', () => {
    expect(isAggregate(count())).toBe(true)
    expect(isAggregate(sum('x'))).toBe(true)
    expect(isAggregate(eq(1, 1))).toBe(false)
    expect(isAggregate({ $ref: true, alias: 'a', field: 'b' })).toBe(false)
    expect(isAggregate(null)).toBe(false)
    expect(isAggregate(3)).toBe(false)
  })
})

describe('evalAggregate', () => {
  const post = (field: string): FieldRef => ({ $ref: true, alias: 'post', field })

  /** Builds one `read` function per row, over a flat `{ field: value }` bag. */
  function rowsOf(values: Array<Record<string, unknown>>): Array<(r: FieldRef) => unknown> {
    return values.map((v) => (r: FieldRef) => v[r.field])
  }

  it('count() with no argument counts every row, including one with a null field', () => {
    const rows = rowsOf([{ views: 1 }, { views: null }, { views: undefined }])
    expect(evalAggregate(count(), rows)).toBe(3)
  })

  it('count(x) counts only rows where x is neither null nor undefined', () => {
    const rows = rowsOf([{ views: 1 }, { views: null }, { views: undefined }, { views: 2 }])
    expect(evalAggregate(count(post('views')), rows)).toBe(2)
  })

  it('count() of an empty group is 0', () => {
    expect(evalAggregate(count(), [])).toBe(0)
  })

  it('sum skips null and undefined', () => {
    const rows = rowsOf([{ n: 1 }, { n: null }, { n: 2 }, { n: undefined }, { n: 3 }])
    expect(evalAggregate(sum(post('n')), rows)).toBe(6)
  })

  it('sum of an empty group is 0', () => {
    expect(evalAggregate(sum(post('n')), [])).toBe(0)
  })

  it('sum of a group holding only nulls is 0', () => {
    const rows = rowsOf([{ n: null }, { n: undefined }])
    expect(evalAggregate(sum(post('n')), rows)).toBe(0)
  })

  it('avg skips null and undefined', () => {
    const rows = rowsOf([{ n: 1 }, { n: null }, { n: 3 }, { n: undefined }])
    expect(evalAggregate(avg(post('n')), rows)).toBe(2)
  })

  it('avg of an empty group is undefined', () => {
    expect(evalAggregate(avg(post('n')), [])).toBe(undefined)
  })

  it('avg of a group holding only nulls is undefined', () => {
    const rows = rowsOf([{ n: null }, { n: undefined }])
    expect(evalAggregate(avg(post('n')), rows)).toBe(undefined)
  })

  it('min and max over numbers', () => {
    const rows = rowsOf([{ n: 5 }, { n: 1 }, { n: 3 }])
    expect(evalAggregate(min(post('n')), rows)).toBe(1)
    expect(evalAggregate(max(post('n')), rows)).toBe(5)
  })

  it('min and max over strings, ordinally', () => {
    const rows = rowsOf([{ s: 'banana' }, { s: 'apple' }, { s: 'cherry' }])
    expect(evalAggregate(min(post('s')), rows)).toBe('apple')
    expect(evalAggregate(max(post('s')), rows)).toBe('cherry')
  })

  it('min and max over Dates compare by time', () => {
    const rows = rowsOf([
      { at: new Date('2024-02-01') },
      { at: new Date('2024-01-01') },
      { at: new Date('2024-03-01') },
    ])
    expect(evalAggregate(min(post('at')), rows)).toEqual(new Date('2024-01-01'))
    expect(evalAggregate(max(post('at')), rows)).toEqual(new Date('2024-03-01'))
  })

  it('min and max skip null and undefined', () => {
    const rows = rowsOf([{ n: null }, { n: 5 }, { n: undefined }, { n: 1 }])
    expect(evalAggregate(min(post('n')), rows)).toBe(1)
    expect(evalAggregate(max(post('n')), rows)).toBe(5)
  })

  it('min and max of an empty group are undefined', () => {
    expect(evalAggregate(min(post('n')), [])).toBe(undefined)
    expect(evalAggregate(max(post('n')), [])).toBe(undefined)
  })

  it('min and max of a group holding only nulls are undefined', () => {
    const rows = rowsOf([{ n: null }, { n: undefined }])
    expect(evalAggregate(min(post('n')), rows)).toBe(undefined)
    expect(evalAggregate(max(post('n')), rows)).toBe(undefined)
  })
})
