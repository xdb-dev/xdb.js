import { describe, expect, it } from 'vitest'
import type { Context, Pattern, PatternQuery, Tuple, WhereClause } from '../core/types.js'
import { isXDBError } from '../core/errors.js'
import { TupleIndex } from '../store/tuple-index.js'
import { Footprint } from './footprint.js'
import { compilePredicate, isVar, matchTuple, relevant, runContexts, runQuery } from './engine.js'

function t(path: string, attr: string, value: Tuple['value']): Tuple {
  return { path, attr, value }
}

function join(index: TupleIndex, tuples: Tuple[]): TupleIndex {
  for (const x of tuples) index.add(x)
  return index
}

/** Runs `fn` and returns whatever it throws, or undefined when it does not throw. */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('isVar', () => {
  it('is true only for strings that start with ?', () => {
    expect(isVar('?x')).toBe(true)
    expect(isVar('x')).toBe(false)
    expect(isVar(3)).toBe(false)
    expect(isVar(undefined)).toBe(false)
  })
})

describe('matchTuple: path slot forms', () => {
  it('a constant path matches only that record', () => {
    const pat: Pattern = ['app/posts/p-1', 'title', '?title']
    expect(matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), {})).toEqual({ '?title': 'Hello' })
    expect(matchTuple(pat, t('app/posts/p-2', 'title', 'Other'), {})).toBeNull()
  })

  it('ns/schema/?v matches every record of that schema and binds ?v to the id', () => {
    const pat: Pattern = ['app/posts/?p', 'title', '?title']
    const ctx = matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), {})
    expect(ctx).toEqual({ '?p': 'p-1', '?title': 'Hello' })
    // a different schema never matches, regardless of id shape
    expect(matchTuple(pat, t('app/users/p-1', 'title', 'Hello'), {})).toBeNull()
  })

  it('a bare ?v matches any record and binds ?v to the full path', () => {
    const pat: Pattern = ['?p', 'title', '?title']
    const ctx = matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), {})
    expect(ctx).toEqual({ '?p': 'app/posts/p-1', '?title': 'Hello' })
  })
})

describe('matchTuple: attribute slot', () => {
  it('a .* suffix matches every attribute with that prefix', () => {
    const pat: Pattern = ['app/movies/?m', 'cast.*', '?actor']
    expect(matchTuple(pat, t('app/movies/m-1', 'cast.0', 'p-2'), {})).toEqual({ '?m': 'm-1', '?actor': 'p-2' })
    expect(matchTuple(pat, t('app/movies/m-1', 'cast.1', 'p-4'), {})).toEqual({ '?m': 'm-1', '?actor': 'p-4' })
    expect(matchTuple(pat, t('app/movies/m-1', 'castaway', 'x'), {})).toBeNull()
    expect(matchTuple(pat, t('app/movies/m-1', 'title', 'x'), {})).toBeNull()
  })

  it('a constant attribute matches only that exact name', () => {
    const pat: Pattern = ['app/posts/?p', 'title', '?title']
    expect(matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), {})).not.toBeNull()
    expect(matchTuple(pat, t('app/posts/p-1', 'subtitle', 'Hello'), {})).toBeNull()
  })

  it('a variable attribute binds to the attribute name', () => {
    const pat: Pattern = ['app/posts/?p', '?attr', 'Hello']
    const ctx = matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), {})
    expect(ctx).toEqual({ '?p': 'p-1', '?attr': 'title' })
  })
})

describe('matchTuple: value slot', () => {
  it('a constant value matches only equal values', () => {
    const pat: Pattern = ['app/posts/?p', 'views', 3]
    expect(matchTuple(pat, t('app/posts/p-1', 'views', 3), {})).toEqual({ '?p': 'p-1' })
    expect(matchTuple(pat, t('app/posts/p-1', 'views', 4), {})).toBeNull()
  })

  it('a variable value binds to the tuple value', () => {
    const pat: Pattern = ['app/posts/?p', 'views', '?v']
    expect(matchTuple(pat, t('app/posts/p-1', 'views', 3), {})).toEqual({ '?p': 'p-1', '?v': 3 })
  })
})

describe('matchTuple: a variable bound twice must agree', () => {
  it('succeeds when the second occurrence agrees with the first binding', () => {
    const pat: Pattern = ['app/things/?x', 'selfref', '?x']
    const ctx = matchTuple(pat, t('app/things/5', 'selfref', '5'), {})
    expect(ctx).toEqual({ '?x': '5' })
  })

  it('fails when the second occurrence disagrees with the first binding', () => {
    const pat: Pattern = ['app/things/?x', 'selfref', '?x']
    expect(matchTuple(pat, t('app/things/5', 'selfref', '6'), {})).toBeNull()
  })

  it('fails when a variable is already bound in the incoming context to a different value', () => {
    const pat: Pattern = ['app/posts/?p', 'title', '?title']
    expect(matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), { '?p': 'p-2' })).toBeNull()
    expect(matchTuple(pat, t('app/posts/p-1', 'title', 'Hello'), { '?p': 'p-1' })).toEqual({
      '?p': 'p-1',
      '?title': 'Hello',
    })
  })
})

describe('relevant: picks the narrowest index', () => {
  // ns/a has 5 records, 2 attrs each (x, y) -> 10 tuples.
  // ns/b has 3 records, 2 attrs each (x, y) -> 6 tuples.
  // total index size 16. Only one ns/a tuple has the value 999.
  function buildIndex(): TupleIndex {
    const idx = new TupleIndex()
    for (let i = 0; i < 5; i++) {
      idx.add(t(`ns/a/id${i}`, 'x', i === 0 ? 999 : i))
      idx.add(t(`ns/a/id${i}`, 'y', i * 10))
    }
    for (let i = 0; i < 3; i++) {
      idx.add(t(`ns/b/id${i}`, 'x', i))
      idx.add(t(`ns/b/id${i}`, 'y', i * 10))
    }
    return idx
  }

  it('a constant path picks the path index: one record worth of candidates', () => {
    const idx = buildIndex()
    const pat: Pattern = ['ns/a/id0', '?attr', '?v']
    expect([...relevant(idx, pat, {})]).toHaveLength(2)
  })

  it('a schema id-slot with a constant attribute picks the schema-attr index', () => {
    const idx = buildIndex()
    const pat: Pattern = ['ns/a/?id', 'x', '?v']
    const candidates = [...relevant(idx, pat, {})]
    expect(candidates).toHaveLength(5)
    expect(candidates).not.toHaveLength(idx.size)
  })

  it('a bare variable path with a constant attribute cannot use the schema-attr index and falls back to a full scan', () => {
    const idx = buildIndex()
    const pat: Pattern = ['?p', 'x', '?v']
    const candidates = [...relevant(idx, pat, {})]
    expect(candidates).toHaveLength(idx.size)
  })

  it('a bound value picks the value index over a full scan', () => {
    const idx = buildIndex()
    const pat: Pattern = ['?p', 'x', 999]
    const candidates = [...relevant(idx, pat, {})]
    expect(candidates).toHaveLength(1)
  })

  it('a schema id-slot with a variable attribute picks the schema-only index', () => {
    const idx = buildIndex()
    const pat: Pattern = ['ns/a/?id', '?attr', '?v']
    const candidates = [...relevant(idx, pat, {})]
    expect(candidates).toHaveLength(10)
  })

  it('a fully unbound bare-variable pattern scans everything', () => {
    const idx = buildIndex()
    const pat: Pattern = ['?p', '?attr', '?v']
    const candidates = [...relevant(idx, pat, {})]
    expect(candidates).toHaveLength(idx.size)
  })

  it('a bound path variable narrows to one record via the substituted context', () => {
    const idx = buildIndex()
    const pat: Pattern = ['ns/a/?id', 'x', '?v']
    const candidates = [...relevant(idx, pat, { '?id': 'id2' })]
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.value).toBe(2)
  })
})

describe('relevant: footprint recording for each pattern shape', () => {
  it('records schema and attribute for a constant path and constant attribute', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    const fp = new Footprint()
    ;[...relevant(idx, ['app/posts/p-1', 'title', '?v'], {}, fp)]
    expect(fp.keys()).toEqual(new Set(['app/posts|title']))
  })

  it('records schema and attribute for an id-slot pattern regardless of whether the id is bound', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    const fp = new Footprint()
    ;[...relevant(idx, ['app/posts/?p', 'title', '?v'], {}, fp)]
    expect(fp.keys()).toEqual(new Set(['app/posts|title']))
  })

  it('records a schema wildcard for a .* attribute prefix', () => {
    const idx = new TupleIndex()
    idx.add(t('app/movies/m-1', 'cast.0', 'p-2'))
    const fp = new Footprint()
    ;[...relevant(idx, ['app/movies/?m', 'cast.*', '?v'], {}, fp)]
    expect(fp.keys()).toEqual(new Set(['app/movies|*']))
  })

  it('records an attribute wildcard for a bare variable path with a constant attribute', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    const fp = new Footprint()
    ;[...relevant(idx, ['?p', 'title', '?v'], {}, fp)]
    expect(fp.keys()).toEqual(new Set(['*|title']))
  })

  it('records a full wildcard when both path and attribute are unbound', () => {
    const idx = new TupleIndex()
    idx.add(t('app/posts/p-1', 'title', 'Hello'))
    const fp = new Footprint()
    ;[...relevant(idx, ['?p', '?a', '?v'], {}, fp)]
    expect(fp.keys()).toEqual(new Set(['*|*']))
  })
})

describe('compilePredicate', () => {
  it('supports == != < <= > >= with a variable and a JSON literal', () => {
    const cases: [string, Context, boolean][] = [
      ['?a == 3', { '?a': 3 }, true],
      ['?a == 3', { '?a': 4 }, false],
      ['?a != 3', { '?a': 4 }, true],
      ['?a < 3', { '?a': 2 }, true],
      ['?a < 3', { '?a': 3 }, false],
      ['?a <= 3', { '?a': 3 }, true],
      ['?a > 3', { '?a': 4 }, true],
      ['?a > 3', { '?a': 3 }, false],
      ['?a >= 3', { '?a': 3 }, true],
    ]
    for (const [src, ctx, expected] of cases) {
      expect(compilePredicate(src)(ctx)).toBe(expected)
    }
  })

  it('supports a variable on both sides', () => {
    expect(compilePredicate('?a == ?b')({ '?a': 3, '?b': 3 })).toBe(true)
    expect(compilePredicate('?a == ?b')({ '?a': 3, '?b': 4 })).toBe(false)
  })

  it('supports a string literal on the right', () => {
    expect(compilePredicate('?a == "hi"')({ '?a': 'hi' })).toBe(true)
  })

  it('throws INVALID_QUERY for a predicate that does not parse', () => {
    expect(() => compilePredicate('this is not valid')).toThrow()
    const err = captureError(() => compilePredicate('this is not valid'))
    expect(isXDBError(err, 'INVALID_QUERY')).toBe(true)
  })

  it('throws INVALID_QUERY when the left variable is unbound at evaluation time', () => {
    const pred = compilePredicate('?a > 3')
    expect(() => pred({})).toThrow()
    const err = captureError(() => pred({}))
    expect(isXDBError(err, 'INVALID_QUERY')).toBe(true)
  })

  it('throws INVALID_QUERY when the right-hand variable is unbound at evaluation time', () => {
    const pred = compilePredicate('?a == ?b')
    expect(() => pred({ '?a': 3 })).toThrow()
  })
})

describe('runContexts / runQuery', () => {
  function seedPostsAndUsers(): TupleIndex {
    return join(new TupleIndex(), [
      t('app/users/u-1', 'name', 'Ada'),
      t('app/users/u-2', 'name', 'Grace'),
      t('app/posts/p-1', 'author', 'u-1'),
      t('app/posts/p-1', 'title', 'Hello'),
      t('app/posts/p-1', 'views', 150),
      t('app/posts/p-2', 'author', 'u-2'),
      t('app/posts/p-2', 'title', 'World'),
      t('app/posts/p-2', 'views', 10),
    ])
  }

  it('joins across records through a shared variable', () => {
    const idx = seedPostsAndUsers()
    const q: PatternQuery = {
      find: ['?title', '?name'],
      where: [
        ['app/posts/?p', 'author', '?u'],
        ['app/users/?u', 'name', '?name'],
        ['app/posts/?p', 'title', '?title'],
      ],
    }
    const rows = runQuery(idx, q)
    expect(rows.sort()).toEqual(
      [
        ['Hello', 'Ada'],
        ['World', 'Grace'],
      ].sort(),
    )
  })

  it('a predicate string filters the joined contexts', () => {
    const idx = seedPostsAndUsers()
    const q: PatternQuery = {
      find: ['?title'],
      where: [
        ['app/posts/?p', 'title', '?title'],
        ['app/posts/?p', 'views', '?views'],
        '?views > 100',
      ],
    }
    expect(runQuery(idx, q)).toEqual([['Hello']])
  })

  it('an { opt } pattern keeps the context when nothing matches', () => {
    const idx = seedPostsAndUsers()
    idx.add(t('app/posts/p-3', 'title', 'No views yet'))
    const where: WhereClause[] = [
      ['app/posts/?p', 'title', '?title'],
      { opt: ['app/posts/?p', 'views', '?views'] },
    ]
    const contexts = runContexts(idx, where)
    const p3 = contexts.find((c) => c['?title'] === 'No views yet')
    expect(p3).toBeDefined()
    expect(p3?.['?views']).toBeUndefined()
    const p1 = contexts.find((c) => c['?title'] === 'Hello')
    expect(p1?.['?views']).toBe(150)
  })

  it('an { opt } pattern still narrows the context when a match exists', () => {
    const idx = seedPostsAndUsers()
    const where: WhereClause[] = [{ opt: ['app/posts/?p', 'title', 'Hello'] }]
    const contexts = runContexts(idx, where)
    expect(contexts.some((c) => c['?p'] === 'p-1')).toBe(true)
  })

  it('a compiled predicate function filters the contexts', () => {
    const idx = seedPostsAndUsers()
    const where: WhereClause[] = [
      ['app/posts/?p', 'views', '?views'],
      (ctx: Context) => (ctx['?views'] as number) > 100,
    ]
    const contexts = runContexts(idx, where)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.['?views']).toBe(150)
  })

  it('throws INVALID_QUERY when a predicate reads an unbound variable', () => {
    const idx = seedPostsAndUsers()
    const where: WhereClause[] = ['?nowhere > 3']
    expect(() => runContexts(idx, where)).toThrow()
    const err = captureError(() => runContexts(idx, where))
    expect(isXDBError(err, 'INVALID_QUERY')).toBe(true)
  })

  it('throws INVALID_QUERY when a predicate string does not parse', () => {
    const idx = seedPostsAndUsers()
    const where: WhereClause[] = [['app/posts/?p', 'title', '?title'], 'not a predicate at all']
    expect(() => runContexts(idx, where)).toThrow()
  })

  it('runQuery projects find variables in order, one row per context', () => {
    const idx = seedPostsAndUsers()
    const q: PatternQuery = {
      find: ['?u', '?name'],
      where: [['app/users/?u', 'name', '?name']],
    }
    const rows = runQuery(idx, q)
    expect(rows.sort()).toEqual(
      [
        ['u-1', 'Ada'],
        ['u-2', 'Grace'],
      ].sort(),
    )
  })
})
