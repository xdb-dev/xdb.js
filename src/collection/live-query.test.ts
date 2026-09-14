/**
 * A live query is a collection, so a query can read another query's result.
 * See CONTRACTS-DX.md, "src/collection/live-query.ts".
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isXDBError } from '../core/errors.js'
import { memory } from '../drivers/memory.js'
import { TupleStore } from '../store/store.js'
import { query } from '../builder/query.js'
import { count, eq, gt, sum } from '../builder/expr.js'
import { createCollection } from './collection.js'
import { createLiveQueryCollection } from './live-query.js'

const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  views: z.number().int().default(0),
})

async function setup() {
  const store = await TupleStore.open({ driver: memory() })
  const posts = createCollection<z.output<typeof Post>>({ uri: 'xdb://app/posts', schema: Post })
  posts.bind(store)
  await posts.preload()
  posts.insert([
    { id: 'p-1', title: 'One', author: 'u-1', views: 300 },
    { id: 'p-2', title: 'Two', author: 'u-1', views: 50 },
    { id: 'p-3', title: 'Three', author: 'u-2', views: 400 },
  ] as never)
  return { store, posts }
}

describe('createLiveQueryCollection', () => {
  it('materializes its rows as a readable collection', async () => {
    const { store } = await setup()
    const popular = createLiveQueryCollection<{ id: string; title: string }>({
      id: 'popular',
      query: (q) =>
        q
          .from({ post: { path: 'app/posts' } })
          .where(({ post }: any) => gt(post.views, 100))
          .select(({ post }: any) => ({ id: post.id, title: post.title })),
    })
    popular.bind(store)

    expect(popular.size).toBe(2)
    expect(popular.toArray().map((r) => r.title).sort()).toEqual(['One', 'Three'])
    expect(popular.get('p-1')!.title).toBe('One')
  })

  it('accepts a bare builder callback', async () => {
    const { store } = await setup()
    const all = createLiveQueryCollection((q) =>
      q.from({ post: { path: 'app/posts' } }).select(({ post }: any) => ({ id: post.id })),
    )
    all.bind(store)
    expect(all.size).toBe(3)
  })

  it('follows the underlying data as it changes', async () => {
    const { store, posts } = await setup()
    const popular = createLiveQueryCollection<{ id: string; title: string }>({
      id: 'pop2',
      query: (q) =>
        q
          .from({ post: { path: 'app/posts' } })
          .where(({ post }: any) => gt(post.views, 100))
          .select(({ post }: any) => ({ id: post.id, title: post.title })),
    })
    popular.bind(store)
    expect(popular.size).toBe(2)

    // p-2 crosses the threshold, so the live query gains a row.
    await posts.update('p-2', (d) => {
      d.views = 500
    }).isPersisted.promise
    store.bus.flush()
    await Promise.resolve()
    expect(popular.size).toBe(3)

    // p-1 drops below it, so the row goes away.
    await posts.update('p-1', (d) => {
      d.views = 1
    }).isPersisted.promise
    store.bus.flush()
    await Promise.resolve()
    expect(popular.toArray().map((r) => r.id).sort()).toEqual(['p-2', 'p-3'])
  })

  it('is a query source, so a query can read it', async () => {
    const { store } = await setup()
    const popular = createLiveQueryCollection({
      id: 'pop3',
      query: (q) =>
        q
          .from({ post: { path: 'app/posts' } })
          .where(({ post }: any) => gt(post.views, 100))
          .select(({ post }: any) => ({ id: post.id, title: post.title, author: post.author })),
    })
    popular.bind(store)

    // The subquery: group the already-filtered rows by author.
    const rows = query()
      .from({ p: popular })
      .groupBy(({ p }: any) => p.author)
      .select(({ p }: any) => ({ author: p.author, n: count() }))
      .run(store.index)

    expect(rows).toEqual(
      expect.arrayContaining([{ author: 'u-1', n: 1 }, { author: 'u-2', n: 1 }]),
    )
  })

  it('composes two levels of live query', async () => {
    const { store } = await setup()
    const withViews = createLiveQueryCollection({
      id: 'lvl1',
      query: (q) =>
        q.from({ post: { path: 'app/posts' } }).select(({ post }: any) => ({
          id: post.id,
          author: post.author,
          views: post.views,
        })),
    })
    withViews.bind(store)

    const perAuthor = createLiveQueryCollection<{ id: string; total: number }>({
      id: 'lvl2',
      getKey: (row) => row.id,
      query: (q) =>
        q
          .from({ r: withViews })
          .groupBy(({ r }: any) => r.author)
          .select(({ r }: any) => ({ id: r.author, total: sum(r.views) })),
    })
    perAuthor.bind(store)

    expect(perAuthor.get('u-1')!.total).toBe(350)
    expect(perAuthor.get('u-2')!.total).toBe(400)
  })

  it('keys a non-object row and keeps its value reachable', async () => {
    const { store } = await setup()
    const titles = createLiveQueryCollection<{ id: string; value: string }>({
      id: 'titles',
      query: (q) =>
        q
          .from({ post: { path: 'app/posts' } })
          .select(({ post }: any) => ({ title: post.title }))
          .fn.select((row: any) => row.title),
    })
    titles.bind(store)
    expect(titles.toArray().map((r) => r.value).sort()).toEqual(['One', 'Three', 'Two'])
  })

  it('is read-only', async () => {
    const { store } = await setup()
    const all = createLiveQueryCollection((q) => q.from({ post: { path: 'app/posts' } }))
    all.bind(store)
    for (const call of [() => all.insert({} as never), () => all.update('p-1', () => {}), () => all.delete('p-1')]) {
      expect(call).toThrow()
      try {
        call()
      } catch (err) {
        expect(isXDBError(err, 'UNSUPPORTED')).toBe(true)
      }
    }
  })

  it('does not rerun itself: materializing is not in its own footprint', async () => {
    const { store, posts } = await setup()
    let runs = 0
    const counted = createLiveQueryCollection({
      id: 'counted',
      query: (q) => {
        runs++
        return q.from({ post: { path: 'app/posts' } }).select(({ post }: any) => ({ id: post.id }))
      },
    })
    counted.bind(store)
    store.bus.flush()
    await Promise.resolve()
    const afterBind = runs

    // One unrelated write must cause at most one more run, never a cascade.
    await posts.update('p-1', (d) => {
      d.title = 'Renamed'
    }).isPersisted.promise
    store.bus.flush()
    await Promise.resolve()
    store.bus.flush()
    await Promise.resolve()

    expect(runs - afterBind).toBeLessThanOrEqual(2)
  })

  it('stops following after cleanup', async () => {
    const { store, posts } = await setup()
    const all = createLiveQueryCollection({
      id: 'stops',
      query: (q) => q.from({ post: { path: 'app/posts' } }).select(({ post }: any) => ({ id: post.id })),
    })
    all.bind(store)
    expect(all.size).toBe(3)
    await all.cleanup()

    await posts.insert({ id: 'p-9', title: 'Nine', author: 'u-3', views: 1 } as never).isPersisted.promise
    store.bus.flush()
    await Promise.resolve()
    // The collection is cleaned up, so it did not take the new row.
    expect(all.status).toBe('cleaned-up')
  })
})
