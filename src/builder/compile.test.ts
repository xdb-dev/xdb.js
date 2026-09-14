import { describe, expect, it } from 'vitest'
import { eq, gt } from './expr.js'
import { query } from './query.js'
import type { Pattern, WhereClause } from '../core/types.js'

const MOVIES = { path: 'demo/movies' }
const PEOPLE = { path: 'demo/people' }

/** True for a required pattern (a bare array), as opposed to `{ opt }` or a predicate. */
function isBarePattern(w: WhereClause): w is Pattern {
  return Array.isArray(w)
}

/** True for an all-or-nothing group: the left-join primitive. */
function isOptAll(w: WhereClause): w is { optAll: Pattern[] } {
  return !isBarePattern(w) && typeof w === 'object' && w !== null && 'optAll' in w
}

/**
 * Every pattern a clause contributes. A bare pattern and an `{ opt }` wrapper
 * give one; an `{ optAll }` group gives its whole list.
 */
function patternsOf(w: WhereClause): Pattern[] {
  if (isBarePattern(w)) return [w]
  if (isOptAll(w)) return w.optAll
  if (typeof w === 'object' && w !== null && 'opt' in w) return [w.opt]
  throw new Error('not a pattern')
}

/** The first pattern a clause contributes. */
function patternOf(w: WhereClause): Pattern {
  const all = patternsOf(w)
  if (all.length === 0) throw new Error('not a pattern')
  return all[0]!
}

/** True when the clause makes its patterns optional, either singly or as a group. */
function isOpt(w: WhereClause): boolean {
  if (isBarePattern(w)) return false
  return typeof w === 'object' && w !== null && ('opt' in w || 'optAll' in w)
}

/** Every pattern in the where list, flattened out of its clause wrapper. */
function allPatterns(where: WhereClause[]): Pattern[] {
  return where.filter((w) => typeof w !== 'function' && typeof w !== 'string').flatMap(patternsOf)
}

/** Finds the clause that carries a pattern for `attr`. Skips predicates. */
function findPattern(where: WhereClause[], attr: string): WhereClause | undefined {
  return where.find(
    (w) => typeof w !== 'function' && typeof w !== 'string' && patternsOf(w).some((p) => p[1] === attr),
  )
}

/** Finds the clause carrying the base pattern (`_id`) for `schemaPrefix`. */
function findBasePattern(where: WhereClause[], schemaPrefix: string): WhereClause | undefined {
  return where.find(
    (w) =>
      typeof w !== 'function' &&
      typeof w !== 'string' &&
      patternsOf(w).some((p) => p[1] === '_id' && p[0].startsWith(schemaPrefix)),
  )
}

describe('compile: from and base patterns', () => {
  it('emits one required base pattern per alias, binding the alias variable to the id', () => {
    const c = query().from({ movie: MOVIES }).compile()
    expect(c.where).toHaveLength(1)
    expect(c.where[0]).toEqual(['demo/movies/?movie', '_id', '?movie'])
  })

  it('emits base patterns for every from() and join() alias, in call order', () => {
    const c = query()
      .from({ movie: MOVIES })
      .join({ person: PEOPLE }, ({ movie, person }) => eq(movie.director, person.id))
      .compile()
    const patterns = allPatterns(c.where)
    expect(patterns[0]![0]).toBe('demo/movies/?movie')
    // the person base pattern's id slot is the unified variable, not '?person'
    const personBase = patterns.find((p) => p[0].startsWith('demo/people/') && p[1] === '_id')
    expect(personBase).toBeDefined()
  })
})

describe('compile: eq(field, constant) compiles into the value slot', () => {
  it('puts the constant directly in the pattern, with no separate predicate', () => {
    const c = query()
      .from({ movie: MOVIES })
      .where(({ movie }) => eq(movie.year, 1984))
      .compile()
    // base pattern + one field pattern for year, and nothing else (no predicate function)
    expect(c.where).toHaveLength(2)
    expect(c.where.every((w) => isBarePattern(w))).toBe(true)
    const yearPattern = c.where[1] as Pattern
    expect(yearPattern).toEqual(['demo/movies/?movie', 'year', 1984])
  })

  it('works the other way around too: eq(constant, field)', () => {
    const c = query()
      .from({ movie: MOVIES })
      .where(({ movie }) => eq(1984, movie.year))
      .compile()
    expect(c.where).toHaveLength(2)
    expect(c.where[1]).toEqual(['demo/movies/?movie', 'year', 1984])
  })
})

describe('compile: eq(field, field) unifies into one shared variable', () => {
  it('the director field pattern and the joined alias base pattern share one variable', () => {
    const c = query()
      .from({ movie: MOVIES })
      .join({ person: PEOPLE }, ({ movie, person }) => eq(movie.director, person.id))
      .compile()

    // director is required by the join condition, and the alias 'movie' is required (from()), so it is a bare pattern
    const directorBare = c.where.find(
      (w) => isBarePattern(w) && w[0] === 'demo/movies/?movie' && w[1] === 'director',
    ) as Pattern
    expect(directorBare).toBeDefined()
    const sharedVar = directorBare[2]
    expect(typeof sharedVar).toBe('string')
    expect((sharedVar as string).startsWith('?')).toBe(true)

    // The person base pattern sits in the all-or-nothing group, because join
    // defaults to a left join. Its id slot is the same unified variable.
    const personBase = allPatterns(c.where).find((p) => p[1] === '_id' && p[0].startsWith('demo/people/'))
    expect(personBase).toBeDefined()
    expect(personBase![0]).toBe(`demo/people/${sharedVar}`)
    expect(personBase![2]).toBe(sharedVar)
  })
})

describe('compile: field optionality', () => {
  it('a field read only by select is optional', () => {
    const c = query()
      .from({ movie: MOVIES })
      .select(({ movie }) => ({ title: movie.title }))
      .compile()
    const titlePattern = findPattern(c.where, 'title')
    expect(titlePattern).toBeDefined()
    expect(isOpt(titlePattern!)).toBe(true)
  })

  it('a field read only by orderBy is optional', () => {
    const c = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.views)
      .compile()
    const viewsPattern = findPattern(c.where, 'views')
    expect(viewsPattern).toBeDefined()
    expect(isOpt(viewsPattern!)).toBe(true)
  })

  it('a field read by where is required, and a predicate function follows the patterns', () => {
    const c = query()
      .from({ movie: MOVIES })
      .where(({ movie }) => gt(movie.year, 1900))
      .compile()
    const yearPattern = findPattern(c.where, 'year')
    expect(yearPattern).toBeDefined()
    expect(isOpt(yearPattern!)).toBe(false)

    const patternEntries = c.where.filter((w) => typeof w !== 'function')
    const predicateEntries = c.where.filter((w) => typeof w === 'function')
    expect(predicateEntries).toHaveLength(1)
    // every pattern comes before the predicate
    expect(c.where.indexOf(patternEntries[patternEntries.length - 1])).toBeLessThan(
      c.where.indexOf(predicateEntries[0]),
    )
  })
})

describe('compile: join type controls optionality of the joined alias', () => {
  it('a left join (the default) puts the joined alias in an all-or-nothing group', () => {
    const c = query()
      .from({ movie: MOVIES })
      .join({ person: PEOPLE }, ({ movie, person }) => eq(movie.director, person.id))
      .compile()
    const personBase = findBasePattern(c.where, 'demo/people/')
    expect(personBase).toBeDefined()
    expect(isOpt(personBase!)).toBe(true)
    // The group is what makes the join all-or-nothing: a person who fails a
    // later condition leaves the alias absent instead of half bound.
    expect(isOptAll(personBase!)).toBe(true)
  })

  it('an inner join keeps the joined alias patterns required', () => {
    const c = query()
      .from({ movie: MOVIES })
      .innerJoin({ person: PEOPLE }, ({ movie, person }) => eq(movie.director, person.id))
      .compile()
    const personBase = findBasePattern(c.where, 'demo/people/')
    expect(personBase).toBeDefined()
    expect(isOpt(personBase!)).toBe(false)
  })

  it('a gating field on a left-joined alias joins the same all-or-nothing group', () => {
    const c = query()
      .from({ movie: MOVIES })
      .join({ person: PEOPLE }, ({ movie, person }) => eq(movie.director, person.id))
      .where(({ person }) => gt(person.name, ''))
      .compile()
    const namePattern = findPattern(c.where, 'name')
    expect(namePattern).toBeDefined()
    expect(isOpt(namePattern!)).toBe(true)
    // The name condition sits with the base pattern, so a person failing it
    // drops the whole alias rather than surviving with an unbound name.
    expect(isOptAll(namePattern!)).toBe(true)
    expect((namePattern as { optAll: Pattern[] }).optAll.some((p) => p[1] === '_id')).toBe(true)
  })
})
