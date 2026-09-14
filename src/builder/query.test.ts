import { beforeEach, describe, expect, it } from 'vitest'
import { encodeRecord } from '../core/record.js'
import { Footprint } from '../query/footprint.js'
import { TupleIndex } from '../store/tuple-index.js'
import {
  and,
  endsWith,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isUndefined,
  length,
  like,
  lower,
  lt,
  lte,
  ne,
  not,
  or,
  startsWith,
  upper,
} from './expr.js'
import { query } from './query.js'

const MOVIES = { path: 'demo/movies' }
const PEOPLE = { path: 'demo/people' }

interface MovieSeed {
  id: string
  title: string
  year: number
  director: string
  leadActor: string
  cast: string[]
  genre: string
  views: number
  tagline?: string
}

interface PersonSeed {
  id: string
  name: string
}

/** Seeds one record: an `_id` tuple plus every field, via `encodeRecord`. */
function seedRecord<T extends { id: string }>(index: TupleIndex, schemaPath: string, obj: T): void {
  const path = `${schemaPath}/${obj.id}`
  index.add({ path, attr: '_id', value: obj.id })
  for (const t of encodeRecord(path, obj as Record<string, unknown>)) index.add(t)
}

const PEOPLE_SEED: PersonSeed[] = [
  { id: 'p-1', name: 'James Cameron' },
  { id: 'p-2', name: 'Arnold Schwarzenegger' },
  { id: 'p-3', name: 'John McTiernan' },
  { id: 'p-4', name: 'Linda Hamilton' },
  { id: 'p-5', name: 'Carl Weathers' },
  { id: 'p-6', name: 'Paul Verhoeven' },
]

// m-2 and m-6 share a year (1987), for the orderBy stability and multi-key tests.
// m-5's leadActor ('p-999') does not exist, for the join tests.
const MOVIES_SEED: MovieSeed[] = [
  {
    id: 'm-1',
    title: 'The Terminator',
    year: 1984,
    director: 'p-1',
    leadActor: 'p-2',
    cast: ['p-2', 'p-4'],
    genre: 'scifi',
    views: 500,
    tagline: "I'll be back.",
  },
  { id: 'm-2', title: 'Predator', year: 1987, director: 'p-3', leadActor: 'p-2', cast: ['p-2', 'p-5'], genre: 'action', views: 300 },
  { id: 'm-3', title: 'Terminator 2', year: 1991, director: 'p-1', leadActor: 'p-2', cast: ['p-2', 'p-4'], genre: 'scifi', views: 900 },
  { id: 'm-4', title: 'Total Recall', year: 1990, director: 'p-6', leadActor: 'p-2', cast: ['p-2'], genre: 'scifi', views: 200 },
  { id: 'm-5', title: 'Die Hard', year: 1988, director: 'p-3', leadActor: 'p-999', cast: [], genre: 'action', views: 700 },
  { id: 'm-6', title: 'Amazing Movie', year: 1987, director: 'p-6', leadActor: 'p-2', cast: ['p-2'], genre: 'scifi', views: 150 },
]

function buildIndex(): TupleIndex {
  const index = new TupleIndex()
  for (const p of PEOPLE_SEED) seedRecord(index, PEOPLE.path, p)
  for (const m of MOVIES_SEED) seedRecord(index, MOVIES.path, m)
  return index
}

let index: TupleIndex

beforeEach(() => {
  index = buildIndex()
})

describe('a single-collection query with where and select', () => {
  it('filters and projects', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .where(({ movie }) => gt(movie.year, 1987))
      .select(({ movie }) => ({ title: movie.title, year: movie.year }))
      .run(index)
    expect(rows).toEqual(
      expect.arrayContaining([
        { title: 'Terminator 2', year: 1991 },
        { title: 'Total Recall', year: 1990 },
        { title: 'Die Hard', year: 1988 },
      ]),
    )
    expect(rows).toHaveLength(3)
  })
})

describe('joins', () => {
  it('a left join keeps a row whose joined record is missing, with the joined alias undefined', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .join({ actor: PEOPLE }, ({ movie, actor }) => eq(movie.leadActor, actor.id))
      .where(({ movie }) => eq(movie.id, 'm-5'))
      .run(index) as { movie: Record<string, unknown>; actor: Record<string, unknown> | undefined }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].movie.title).toBe('Die Hard')
    expect(rows[0].actor).toBeUndefined()
  })

  it('an inner join drops a row whose joined record is missing', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .innerJoin({ actor: PEOPLE }, ({ movie, actor }) => eq(movie.leadActor, actor.id))
      .where(({ movie }) => eq(movie.id, 'm-5'))
      .run(index)

    expect(rows).toHaveLength(0)
  })

  it('keeps a matched left-joined row intact', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .join({ actor: PEOPLE }, ({ movie, actor }) => eq(movie.leadActor, actor.id))
      .where(({ movie }) => eq(movie.id, 'm-1'))
      .select(({ movie, actor }) => ({ title: movie.title, lead: actor.name }))
      .run(index)

    expect(rows).toEqual([{ title: 'The Terminator', lead: 'Arnold Schwarzenegger' }])
  })

  it('a three-way join resolves both the director and the lead actor', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .join({ director: PEOPLE }, ({ movie, director }) => eq(movie.director, director.id))
      .join({ lead: PEOPLE }, ({ movie, lead }) => eq(movie.leadActor, lead.id))
      .where(({ movie }) => eq(movie.id, 'm-1'))
      .select(({ movie, director, lead }) => ({
        title: movie.title,
        directedBy: director.name,
        starring: lead.name,
      }))
      .run(index)

    expect(rows).toEqual([{ title: 'The Terminator', directedBy: 'James Cameron', starring: 'Arnold Schwarzenegger' }])
  })

  it('select can compute a value from two aliases', () => {
    // Combines movie.views and director.name (via length) into one derived field.
    // Composing with the expr functions works inside select; raw JS operators on a
    // field-ref proxy would not, since select is walked once at compile time with
    // field-ref markers, and a native operator like a template literal or `+`
    // stringifies a marker via `toString` instead of composing it.
    const director = PEOPLE_SEED.find((p) => p.id === 'p-1')!
    const rows = query()
      .from({ movie: MOVIES })
      .join({ director: PEOPLE }, ({ movie, director }) => eq(movie.director, director.id))
      .where(({ movie }) => eq(movie.id, 'm-3'))
      .select(({ movie, director }) => ({
        title: movie.title,
        viewsBeatNameLength: gt(movie.views, length(director.name)),
      }))
      .run(index)

    expect(rows).toEqual([{ title: 'Terminator 2', viewsBeatNameLength: 900 > director.name.length }])
  })
})

describe('without select', () => {
  it('a row is an object with one key per alias, each the decoded record', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .where(({ movie }) => eq(movie.id, 'm-1'))
      .run(index) as { movie: Record<string, unknown> }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].movie).toEqual({
      id: 'm-1',
      title: 'The Terminator',
      year: 1984,
      director: 'p-1',
      leadActor: 'p-2',
      cast: ['p-2', 'p-4'],
      genre: 'scifi',
      views: 500,
      tagline: "I'll be back.",
    })
  })
})

describe('expression functions, each evaluated through a real query', () => {
  const titlesWhere = (fn: (refs: any) => any): string[] =>
    (query().from({ movie: MOVIES }).where(fn).run(index) as { movie: Record<string, unknown> }[])
      .map((r) => r.movie.title as string)
      .sort()

  it('eq', () => {
    expect(titlesWhere(({ movie }) => eq(movie.genre, 'action'))).toEqual(['Die Hard', 'Predator'])
  })
  it('ne', () => {
    expect(titlesWhere(({ movie }) => and(ne(movie.genre, 'action'), eq(movie.director, 'p-1')))).toEqual([
      'Terminator 2',
      'The Terminator',
    ])
  })
  it('gt / gte / lt / lte', () => {
    expect(titlesWhere(({ movie }) => gt(movie.year, 1990))).toEqual(['Terminator 2'])
    expect(titlesWhere(({ movie }) => gte(movie.year, 1990))).toEqual(['Terminator 2', 'Total Recall'])
    expect(titlesWhere(({ movie }) => lt(movie.year, 1985))).toEqual(['The Terminator'])
    expect(titlesWhere(({ movie }) => lte(movie.year, 1984))).toEqual(['The Terminator'])
  })
  it('and / or / not, nested', () => {
    expect(
      titlesWhere(({ movie }) => and(gt(movie.year, 1985), or(eq(movie.genre, 'action'), not(lt(movie.views, 800))))),
    ).toEqual(['Die Hard', 'Predator', 'Terminator 2'])
  })
  it('inArray against an array-valued field', () => {
    expect(titlesWhere(({ movie }) => inArray('p-5', movie.cast))).toEqual(['Predator'])
  })
  it('inArray against a literal list', () => {
    expect(titlesWhere(({ movie }) => inArray(movie.year, [1984, 1991]))).toEqual(['Terminator 2', 'The Terminator'])
  })
  it('like and ilike', () => {
    expect(titlesWhere(({ movie }) => like(movie.title, 'The %'))).toEqual(['The Terminator'])
    expect(titlesWhere(({ movie }) => ilike(movie.title, 'the %'))).toEqual(['The Terminator'])
  })
  it('startsWith and endsWith', () => {
    expect(titlesWhere(({ movie }) => startsWith(movie.title, 'The'))).toEqual(['The Terminator'])
    expect(titlesWhere(({ movie }) => endsWith(movie.title, 'Recall'))).toEqual(['Total Recall'])
  })
  it('isUndefined finds records missing the attribute', () => {
    expect(titlesWhere(({ movie }) => isUndefined(movie.tagline))).toEqual(
      ['Amazing Movie', 'Die Hard', 'Predator', 'Terminator 2', 'Total Recall'].sort(),
    )
    expect(titlesWhere(({ movie }) => not(isUndefined(movie.tagline)))).toEqual(['The Terminator'])
  })
  it('length', () => {
    // 'Predator' and 'Die Hard' are both 8 characters.
    expect(titlesWhere(({ movie }) => eq(length(movie.title), 'Predator'.length))).toEqual(['Die Hard', 'Predator'])
  })
  it('upper and lower', () => {
    expect(titlesWhere(({ movie }) => eq(upper(movie.genre), 'ACTION'))).toEqual(['Die Hard', 'Predator'])
    expect(titlesWhere(({ movie }) => eq(lower(movie.genre), 'scifi'))).toEqual([
      'Amazing Movie',
      'Terminator 2',
      'The Terminator',
      'Total Recall',
    ])
  })
})

describe('orderBy, limit, offset', () => {
  it('orders ascending', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.year, 'asc')
      .select(({ movie }) => ({ title: movie.title, year: movie.year }))
      .run(index) as { title: string; year: number }[]
    expect(rows.map((r) => r.year)).toEqual([1984, 1987, 1987, 1988, 1990, 1991])
  })

  it('orders descending', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.year, 'desc')
      .select(({ movie }) => ({ year: movie.year }))
      .run(index) as { year: number }[]
    expect(rows.map((r) => r.year)).toEqual([1991, 1990, 1988, 1987, 1987, 1984])
  })

  it('is stable: equal keys preserve the original relative order', () => {
    // m-2 (Predator) is seeded before m-6 (Amazing Movie); both have year 1987.
    // Sorting by year alone must not reorder them by title.
    const rows = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.year, 'asc')
      .select(({ movie }) => ({ title: movie.title, year: movie.year }))
      .run(index) as { title: string; year: number }[]
    const among1987 = rows.filter((r) => r.year === 1987).map((r) => r.title)
    expect(among1987).toEqual(['Predator', 'Amazing Movie'])
  })

  it('supports several keys, applied in the order they were added', () => {
    // Same year (1987), but now broken by title ascending, so the tie no longer follows insertion order.
    const rows = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.year, 'asc')
      .orderBy(({ movie }) => movie.title, 'asc')
      .select(({ movie }) => ({ title: movie.title, year: movie.year }))
      .run(index) as { title: string; year: number }[]
    const among1987 = rows.filter((r) => r.year === 1987).map((r) => r.title)
    expect(among1987).toEqual(['Amazing Movie', 'Predator'])
  })

  it('limit and offset together', () => {
    const rows = query()
      .from({ movie: MOVIES })
      .orderBy(({ movie }) => movie.year, 'asc')
      .orderBy(({ movie }) => movie.title, 'asc')
      .select(({ movie }) => ({ title: movie.title }))
      .offset(2)
      .limit(2)
      .run(index) as { title: string }[]
    // full order: The Terminator(1984), Amazing Movie(1987), Predator(1987), Die Hard(1988), Total Recall(1990), Terminator 2(1991)
    expect(rows.map((r) => r.title)).toEqual(['Predator', 'Die Hard'])
  })
})

describe('footprint', () => {
  it('run() records every schema and attribute the query touched', () => {
    const fp = new Footprint()
    query()
      .from({ movie: MOVIES })
      .join({ director: PEOPLE }, ({ movie, director }) => eq(movie.director, director.id))
      .where(({ movie }) => gt(movie.year, 1985))
      .select(({ movie, director }) => ({ title: movie.title, by: director.name }))
      .run(index, fp)

    const keys = fp.keys()
    expect(keys.has('demo/movies|_id')).toBe(true)
    expect(keys.has('demo/movies|director')).toBe(true)
    expect(keys.has('demo/movies|year')).toBe(true)
    expect(keys.has('demo/movies|title')).toBe(true)
    expect(keys.has('demo/people|_id')).toBe(true)
    expect(keys.has('demo/people|name')).toBe(true)
  })
})
