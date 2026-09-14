/**
 * The query surface that matches TanStack DB: the four join kinds, groupBy with
 * aggregates, having, distinct, and the `fn` escape hatch. See CONTRACTS-DX.md.
 */
import { describe, expect, it } from 'vitest'
import { encodeRecord } from '../core/record.js'
import { Footprint } from '../query/footprint.js'
import { TupleIndex } from '../store/tuple-index.js'
import { and, avg, count, eq, gt, max, min, sum } from './expr.js'
import { query } from './query.js'

const POSTS = { path: 'app/posts' }
const USERS = { path: 'app/users' }

/**
 * Two users, and posts that deliberately do not line up: p-4 points at a user
 * that does not exist, and u-3 has no posts. That is what separates the four
 * join kinds.
 */
function fixture(): TupleIndex {
  const index = new TupleIndex()
  const add = (path: string, obj: Record<string, unknown>) => {
    for (const t of encodeRecord(path, obj)) index.add(t)
    index.add({ path, attr: '_id', value: path.split('/')[2]! })
  }
  add('app/users/u-1', { name: 'Ada', team: 'core' })
  add('app/users/u-2', { name: 'Grace', team: 'core' })
  add('app/users/u-3', { name: 'Alan', team: 'research' })
  add('app/posts/p-1', { title: 'One', author: 'u-1', views: 100, tag: 'news' })
  add('app/posts/p-2', { title: 'Two', author: 'u-1', views: 300, tag: 'news' })
  add('app/posts/p-3', { title: 'Three', author: 'u-2', views: 50, tag: 'blog' })
  add('app/posts/p-4', { title: 'Orphan', author: 'u-missing', views: 7, tag: 'blog' })
  return index
}

const titles = (rows: unknown[]) => rows.map((r) => (r as { title?: unknown }).title).sort()
const names = (rows: unknown[]) => rows.map((r) => (r as { name?: unknown }).name)

describe('join kinds', () => {
  const on = ({ post, user }: any) => eq(post.author, user.id)
  const project = ({ post, user }: any) => ({ title: post.title, name: user.name })

  it('innerJoin drops a post whose author is missing', () => {
    const rows = query().from({ post: POSTS }).innerJoin({ user: USERS }, on).select(project).run(fixture())
    expect(titles(rows)).toEqual(['One', 'Three', 'Two'])
  })

  it('leftJoin keeps the orphan post with no user', () => {
    const rows = query().from({ post: POSTS }).leftJoin({ user: USERS }, on).select(project).run(fixture())
    expect(titles(rows)).toEqual(['One', 'Orphan', 'Three', 'Two'])
    const orphan = rows.find((r) => (r as { title: string }).title === 'Orphan')
    expect((orphan as { name: unknown }).name).toBeUndefined()
  })

  it('join defaults to a left join', () => {
    const left = query().from({ post: POSTS }).leftJoin({ user: USERS }, on).select(project).run(fixture())
    const plain = query().from({ post: POSTS }).join({ user: USERS }, on).select(project).run(fixture())
    expect(titles(plain)).toEqual(titles(left))
  })

  it('rightJoin keeps the user with no posts', () => {
    const rows = query().from({ post: POSTS }).rightJoin({ user: USERS }, on).select(project).run(fixture())
    // Alan has no posts, so he appears with no title. The orphan post does not.
    expect(titles(rows)).toEqual(['One', 'Three', 'Two', undefined])
    const alan = rows.find((r) => (r as { name: string }).name === 'Alan')
    expect(alan).toBeDefined()
    expect((alan as { title: unknown }).title).toBeUndefined()
  })

  it('fullJoin keeps the unmatched rows of both sides', () => {
    const rows = query().from({ post: POSTS }).fullJoin({ user: USERS }, on).select(project).run(fixture())
    expect(rows).toHaveLength(5)
    expect(titles(rows)).toEqual(['One', 'Orphan', 'Three', 'Two', undefined])
    expect(names(rows).filter(Boolean).sort()).toEqual(['Ada', 'Ada', 'Alan', 'Grace'])
  })

  it('a left join on a non-id field does not leak non-matching records', () => {
    // The regression: matching pattern by pattern let a teammate whose team
    // differed survive with the base pattern already bound, so every user
    // paired with every post. The join must be all-or-nothing.
    const rows = query()
      .from({ user: USERS })
      .leftJoin({ mate: USERS }, ({ user, mate }: any) => eq(user.team, mate.team))
      .select(({ user, mate }: any) => ({ user: user.name, mate: mate.name }))
      .run(fixture())
    // core holds Ada and Grace, so each pairs with both. Alan is alone in
    // research and pairs only with himself. Nine rows would mean a leak.
    expect(rows).toHaveLength(5)
    const alan = rows.filter((r) => (r as { user: string }).user === 'Alan')
    expect(alan).toEqual([{ user: 'Alan', mate: 'Alan' }])
  })

  it('a left join leaves the alias absent when nothing matches', () => {
    const rows = query()
      .from({ post: POSTS })
      .leftJoin({ user: USERS }, ({ post, user }: any) => eq(post.author, user.id))
      .where(({ post }: any) => eq(post.title, 'Orphan'))
      .select(({ post, user }: any) => ({ title: post.title, name: user.name, team: user.team }))
      .run(fixture())
    // Every field of the absent alias is undefined, not partly bound.
    expect(rows).toEqual([{ title: 'Orphan', name: undefined, team: undefined }])
  })

  it('mixes kinds across a three-way join', () => {
    const rows = query()
      .from({ post: POSTS })
      .innerJoin({ user: USERS }, ({ post, user }: any) => eq(post.author, user.id))
      .leftJoin({ teammate: USERS }, ({ user, teammate }: any) => eq(user.team, teammate.team))
      .select(({ post, teammate }: any) => ({ title: post.title, mate: teammate.name }))
      .run(fixture())
    // Ada and Grace share the core team, so each of their three posts pairs
    // with both of them.
    expect(rows).toHaveLength(6)
  })
})

describe('groupBy and aggregates', () => {
  it('counts posts per author', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .select(({ post }: any) => ({ author: post.author, posts: count(), views: sum(post.views) }))
      .run(fixture())
    expect(rows).toEqual(
      expect.arrayContaining([
        { author: 'u-1', posts: 2, views: 400 },
        { author: 'u-2', posts: 1, views: 50 },
        { author: 'u-missing', posts: 1, views: 7 },
      ]),
    )
    expect(rows).toHaveLength(3)
  })

  it('folds every row into one group when groupBy is absent', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({
        total: count(),
        views: sum(post.views),
        mean: avg(post.views),
        low: min(post.views),
        high: max(post.views),
      }))
      .run(fixture())
    expect(rows).toEqual([{ total: 4, views: 457, mean: 457 / 4, low: 7, high: 300 }])
  })

  it('groups by several keys', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => [post.author, post.tag])
      .select(({ post }: any) => ({ author: post.author, tag: post.tag, n: count() }))
      .run(fixture())
    expect(rows).toHaveLength(3)
    expect(rows).toEqual(
      expect.arrayContaining([{ author: 'u-1', tag: 'news', n: 2 }, { author: 'u-2', tag: 'blog', n: 1 }]),
    )
  })

  it('takes an ungrouped field from the first row of the group', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .select(({ post }: any) => ({ author: post.author, aTitle: post.title, n: count() }))
      .run(fixture())
    const ada = rows.find((r) => (r as { author: string }).author === 'u-1') as { aTitle: string }
    expect(['One', 'Two']).toContain(ada.aTitle)
  })

  it('counts only the rows where the argument is present', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({ withTagline: count(post.tagline), all: count() }))
      .run(fixture())
    expect(rows).toEqual([{ withTagline: 0, all: 4 }])
  })

  it('having filters groups after aggregation', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .having(() => gt(count(), 1))
      .select(({ post }: any) => ({ author: post.author, n: count() }))
      .run(fixture())
    expect(rows).toEqual([{ author: 'u-1', n: 2 }])
  })

  it('orders and limits grouped rows', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .select(({ post }: any) => ({ author: post.author, views: sum(post.views) }))
      .orderBy(({ post }: any) => sum(post.views), 'desc')
      .limit(2)
      .run(fixture())
    expect(rows).toEqual([{ author: 'u-1', views: 400 }, { author: 'u-2', views: 50 }])
  })

  it('offsets grouped rows after ordering', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .select(({ post }: any) => ({ author: post.author, views: sum(post.views) }))
      .orderBy(({ post }: any) => sum(post.views), 'desc')
      .offset(1)
      .limit(1)
      .run(fixture())
    expect(rows).toEqual([{ author: 'u-2', views: 50 }])
  })
})

describe('distinct', () => {
  it('drops duplicate rows, compared by value', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({ tag: post.tag }))
      .distinct()
      .run(fixture())
    expect(rows.map((r) => (r as { tag: string }).tag).sort()).toEqual(['blog', 'news'])
  })

  it('compares whole object rows, not identity', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({ tag: post.tag, nested: { tag: post.tag } }))
      .distinct()
      .run(fixture())
    expect(rows).toHaveLength(2)
  })
})

describe('the fn escape hatch', () => {
  it('fn.where filters on a condition the expressions cannot express', () => {
    const rows = query()
      .from({ post: POSTS })
      .fn.where((row: any) => row.post.title.length === 3)
      .select(({ post }: any) => ({ title: post.title }))
      .run(fixture())
    expect(titles(rows)).toEqual(['One', 'Two'])
  })

  it('fn.where sees every alias of the row', () => {
    const rows = query()
      .from({ post: POSTS })
      .innerJoin({ user: USERS }, ({ post, user }: any) => eq(post.author, user.id))
      .fn.where((row: any) => row.user.name.startsWith('A'))
      .select(({ post }: any) => ({ title: post.title }))
      .run(fixture())
    expect(titles(rows)).toEqual(['One', 'Two'])
  })

  it('fn.having filters groups', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .select(({ post }: any) => ({ author: post.author, n: count() }))
      .fn.having((row: any) => row.n > 1)
      .run(fixture())
    expect(rows).toEqual([{ author: 'u-1', n: 2 }])
  })

  it('fn.select projects freely, after limit', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({ title: post.title, views: post.views }))
      .orderBy(({ post }: any) => post.views, 'desc')
      .limit(2)
      .fn.select((row: any) => `${row.title}:${row.views}`)
      .run(fixture())
    expect(rows).toEqual(['Two:300', 'One:100'])
  })
})

describe('stage order', () => {
  it('orders before limiting, not after', () => {
    const rows = query()
      .from({ post: POSTS })
      .select(({ post }: any) => ({ views: post.views }))
      .orderBy(({ post }: any) => post.views, 'desc')
      .limit(1)
      .run(fixture())
    // Limiting before ordering would give whichever row the scan met first.
    expect(rows).toEqual([{ views: 300 }])
  })

  it('applies having before distinct', () => {
    const rows = query()
      .from({ post: POSTS })
      .groupBy(({ post }: any) => post.author)
      .having(() => gt(count(), 1))
      .select(({ post }: any) => ({ n: count() }))
      .distinct()
      .run(fixture())
    // Only u-1 survives having, so distinct has one row to consider, not three.
    expect(rows).toEqual([{ n: 2 }])
  })

  it('runs fn.where before grouping', () => {
    const rows = query()
      .from({ post: POSTS })
      .fn.where((row: any) => row.post.views >= 50)
      .groupBy(({ post }: any) => post.tag)
      .select(({ post }: any) => ({ tag: post.tag, n: count() }))
      .run(fixture())
    // p-4 has 7 views and is dropped, so the blog group holds one row.
    expect(rows).toEqual(expect.arrayContaining([{ tag: 'blog', n: 1 }, { tag: 'news', n: 2 }]))
    expect(rows).toHaveLength(2)
  })
})

describe('footprints', () => {
  it('records every schema and attribute a grouped join touched', () => {
    const fp = new Footprint()
    query()
      .from({ post: POSTS })
      .innerJoin({ user: USERS }, ({ post, user }: any) => eq(post.author, user.id))
      .where(({ post }: any) => and(gt(post.views, 10)))
      .groupBy(({ user }: any) => user.team)
      .select(({ user }: any) => ({ team: user.team, n: count() }))
      .run(fixture(), fp)
    const keys = [...fp.keys()].join(' ')
    expect(keys).toContain('app/posts|author')
    expect(keys).toContain('app/posts|views')
    expect(keys).toContain('app/users|team')
  })

  it('records the anti-joined schema of a right join', () => {
    const fp = new Footprint()
    query()
      .from({ post: POSTS })
      .rightJoin({ user: USERS }, ({ post, user }: any) => eq(post.author, user.id))
      .select(({ user }: any) => ({ name: user.name }))
      .run(fixture(), fp)
    expect(fp.overlaps(['app/users|name'])).toBe(true)
  })
})
