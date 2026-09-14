/**
 * End-to-end test. Runs the developer experience that design.html section 3
 * documents, through the public entry point only. If a snippet in the design
 * doc stops working, this test fails.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  createDB,
  createCollection,
  createTransaction,
  createOptimisticAction,
  createLiveQueryCollection,
  localOnlyCollectionOptions,
  query,
  eq,
  gt,
  and,
  inArray,
  count,
  sum,
  isXDBError,
} from './index.js'

const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  views: z.number().int().default(0),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().transform((v) => new Date(v)),
})

const User = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean().default(true),
})

function setup() {
  const posts = createCollection<z.output<typeof Post>>({ uri: 'xdb://app/posts', schema: Post })
  const users = createCollection<z.output<typeof User>>({ uri: 'xdb://app/users', schema: User })
  return { posts, users }
}

describe('the documented developer experience', () => {
  it('derives an XDB definition from the Zod schema', async () => {
    const { posts, users } = setup()
    await createDB({ collections: { posts, users } })

    expect(posts.def).toMatchObject({
      ns: 'app',
      schema: 'posts',
      mode: 'strict',
      fields: {
        title: { type: 'string', required: true },
        author: { type: 'string', required: true },
        views: { type: 'integer' },
        tags: { type: 'array', items: 'string' },
        createdAt: { type: 'time', required: true },
      },
    })
  })

  it('inserts with defaults and transforms, then reads typed objects back', async () => {
    const { posts, users } = setup()
    await createDB({ collections: { posts, users } })

    posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' } as never)

    const post = posts.get('p-1')!
    expect(post.title).toBe('Hello')
    expect(post.views).toBe(0)
    expect(post.tags).toEqual([])
    expect(post.createdAt).toBeInstanceOf(Date)
    expect((post.createdAt as Date).getUTCFullYear()).toBe(2026)
  })

  it('updates through a draft callback and writes only what changed', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' } as never)
    await posts.update('p-1', (d) => {
      d.views += 1
    }).isPersisted.promise

    expect(posts.get('p-1')!.views).toBe(1)
    // The tuple layer sees the same record, with its system fields.
    const raw = db.records.get('xdb://app/posts/p-1')!
    expect(raw._version).toBe(2)
    expect(raw.title).toBe('Hello')
  })

  it('answers a live query with a join and keeps it live', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    users.insert([
      { id: 'u-1', name: 'Ada' },
      { id: 'u-2', name: 'Grace' },
    ] as never)
    posts.insert([
      { id: 'p-1', title: 'Hello', author: 'u-1', views: 150, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Quiet', author: 'u-1', views: 3, createdAt: '2026-09-02T00:00:00Z' },
      { id: 'p-3', title: 'Third', author: 'u-2', views: 900, createdAt: '2026-09-03T00:00:00Z' },
    ] as never)

    const popular = db.store.live((index, fp) =>
      query()
        .from({ post: posts })
        .join({ user: users }, ({ post, user }) => eq(post.author, user.id))
        .where(({ post, user }) => and(gt(post.views, 100), eq(user.active, true)))
        .select(({ post, user }) => ({ id: post.id, title: post.title, by: user.name }))
        .orderBy(({ post }) => post.views, 'desc')
        .limit(20)
        .run(index, fp) as unknown[],
    )

    expect(popular.toArray()).toEqual([
      { id: 'p-3', title: 'Third', by: 'Grace' },
      { id: 'p-1', title: 'Hello', by: 'Ada' },
    ])

    const seen: unknown[][] = []
    const stop = popular.subscribe((rows) => seen.push(rows))
    expect(seen).toHaveLength(1)

    // A write that crosses the threshold re-runs the query.
    await posts.update('p-2', (d) => {
      d.views = 500
    }).isPersisted.promise
    db.store.bus.flush()

    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(3)

    // A write outside the query's footprint does not re-run it.
    await posts.update('p-2', (d) => {
      d.tags = ['news']
    }).isPersisted.promise
    db.store.bus.flush()
    expect(seen).toHaveLength(2)

    stop()
  })

  it('runs the README live query through db.live', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    users.insert({ id: 'u-1', name: 'Ada' } as never)
    posts.insert([
      { id: 'p-1', title: 'Hello', author: 'u-1', views: 150, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Quiet', author: 'u-1', views: 3, createdAt: '2026-09-02T00:00:00Z' },
    ] as never)

    const popular = db.live((q) =>
      q
        .from({ post: posts })
        .join({ user: users }, ({ post, user }) => eq(post.author, user.id))
        .where(({ post, user }) => and(gt(post.views, 100), eq(user.active, true)))
        .select(({ post, user }) => ({ id: post.id, title: post.title, by: user.name }))
        .orderBy(({ post }) => post.views, 'desc')
        .limit(20),
    )

    expect(popular.toArray()).toEqual([{ id: 'p-1', title: 'Hello', by: 'Ada' }])

    const seen: unknown[][] = []
    const stop = popular.subscribe((rows) => seen.push(rows))
    await posts.update('p-2', (d) => {
      d.views = 500
    }).isPersisted.promise
    db.store.bus.flush()

    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(2)
    stop()
  })

  it('commits a transaction across two collections as one change', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    users.insert({ id: 'u-1', name: 'Ada', active: false } as never)
    posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' } as never)

    const commits = vi.fn()
    const stop = db.store.live((index, fp) =>
      query().from({ post: posts }).select(({ post }) => ({ v: post.views })).run(index, fp) as unknown[],
    ).subscribe(commits)
    expect(commits).toHaveBeenCalledTimes(1)

    const tx = createTransaction({ store: db.store })
    tx.mutate(() => {
      posts.update('p-1', (d) => {
        d.views += 1
      })
      users.update('u-1', (d) => {
        d.active = true
      })
    })
    await tx.commit()
    db.store.bus.flush()

    expect(posts.get('p-1')!.views).toBe(1)
    expect(users.get('u-1')!.active).toBe(true)
    expect(commits).toHaveBeenCalledTimes(2)
    stop()
  })

  it('reaches the tuple layer for the same data', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', views: 7, createdAt: '2026-09-13T00:00:00Z' } as never)

    expect(db.tuples.get('xdb://app/posts/p-1#title')).toBe('Hello')

    await db.tuples.put(['app/posts/p-1', 'views', 9])
    expect(posts.get('p-1')!.views).toBe(9)

    const page = db.records.list('xdb://app/posts', { filter: (r) => (r.views as number) >= 5 })
    expect(page.total).toBe(1)
    expect(page.items[0]!.title).toBe('Hello')

    const rows = db.query({
      find: ['?title', '?views'],
      where: [
        ['app/posts/?p', 'title', '?title'],
        ['app/posts/?p', 'views', '?views'],
      ],
    })
    expect(rows).toEqual([['Hello', 9]])
  })

  it('streams watch events for a scope', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    const events: unknown[] = []
    const stop = db.watch('xdb://app/posts', (e) => events.push(e))

    posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' } as never)
    await users.insert({ id: 'u-1', name: 'Ada' } as never).isPersisted.promise

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'put', uri: 'xdb://app/posts/p-1' })
    stop()
  })

  it('rejects an invalid item with VALIDATION and a field path', async () => {
    const { posts, users } = setup()
    await createDB({ collections: { posts, users } })

    expect(() => posts.insert({ id: 'p-1', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' } as never)).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    )
  })

  it('uses a collection as a query source with inArray', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    users.insert({ id: 'u-1', name: 'Ada' } as never)
    posts.insert([
      { id: 'p-1', title: 'Tagged', author: 'u-1', tags: ['news'], createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Plain', author: 'u-1', tags: [], createdAt: '2026-09-02T00:00:00Z' },
    ] as never)

    const rows = query()
      .from({ post: posts })
      .where(({ post }) => inArray('news', post.tags))
      .select(({ post }) => post.title)
      .run(db.store.index)

    expect(rows).toEqual(['Tagged'])
  })
})

describe('the TanStack DB surface', () => {
  it('groups and aggregates through the public entry point', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    posts.insert([
      { id: 'p-1', title: 'One', author: 'u-1', views: 300, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Two', author: 'u-1', views: 50, createdAt: '2026-09-02T00:00:00Z' },
      { id: 'p-3', title: 'Three', author: 'u-2', views: 400, createdAt: '2026-09-03T00:00:00Z' },
    ] as never)

    const rows = query()
      .from({ post: posts })
      .groupBy(({ post }) => post.author)
      .select(({ post }) => ({ author: post.author, posts: count(), views: sum(post.views) }))
      .orderBy(({ post }) => sum(post.views), 'desc')
      .run(db.store.index)

    expect(rows).toEqual([
      { author: 'u-2', posts: 1, views: 400 },
      { author: 'u-1', posts: 2, views: 350 },
    ])
  })

  it('keeps unmatched rows with a right join', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })

    users.insert([{ id: 'u-1', name: 'Ada' }, { id: 'u-2', name: 'Idle' }] as never)
    posts.insert({ id: 'p-1', title: 'One', author: 'u-1', createdAt: '2026-09-01T00:00:00Z' } as never)

    const rows = query()
      .from({ post: posts })
      .rightJoin({ user: users }, ({ post, user }) => eq(post.author, user.id))
      .select(({ post, user }) => ({ name: user.name, title: post.title }))
      .run(db.store.index)

    expect(rows).toEqual(
      expect.arrayContaining([
        { name: 'Ada', title: 'One' },
        { name: 'Idle', title: undefined },
      ]),
    )
  })

  it('uses fn.where for a condition the expressions cannot express', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })
    posts.insert([
      { id: 'p-1', title: 'abc', author: 'u-1', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'abcd', author: 'u-1', createdAt: '2026-09-02T00:00:00Z' },
    ] as never)

    const rows = query()
      .from({ post: posts })
      .fn.where((row) => row.post.title.length % 2 === 1)
      .select(({ post }) => ({ title: post.title }))
      .run(db.store.index)

    expect(rows).toEqual([{ title: 'abc' }])
  })

  it('reads one live query from another', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })
    posts.insert([
      { id: 'p-1', title: 'One', author: 'u-1', views: 300, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Two', author: 'u-1', views: 5, createdAt: '2026-09-02T00:00:00Z' },
    ] as never)

    const popular = createLiveQueryCollection<{ id: string; author: string; views: number }>({
      id: 'popular-e2e',
      query: (q) =>
        q
          .from({ post: posts })
          .where(({ post }) => gt(post.views, 100))
          .select(({ post }) => ({ id: post.id, author: post.author, views: post.views })),
    })
    popular.bind(db.store)

    expect(popular.toArray().map((r) => r.id)).toEqual(['p-1'])

    const perAuthor = query()
      .from({ p: popular })
      .groupBy(({ p }) => p.author)
      .select(({ p }) => ({ author: p.author, n: count() }))
      .run(db.store.index)
    expect(perAuthor).toEqual([{ author: 'u-1', n: 1 }])
  })

  it('reports an item-level mutation to a persistence handler', async () => {
    const seen: unknown[] = []
    const posts = createCollection<any>({
      uri: 'xdb://app/posts',
      onInsert: async ({ transaction }) => {
        seen.push(transaction.mutations.map((m) => ({ type: m.type, key: m.key, title: m.modified?.title })))
      },
    })
    const db = await createDB({ collections: { posts } })
    expect(db.store).toBeDefined()

    await posts.insert({ id: 'p-1', title: 'Hello' }).isPersisted.promise
    expect(seen).toEqual([[{ type: 'insert', key: 'p-1', title: 'Hello' }]])
  })

  it('rolls a change back when its handler rejects', async () => {
    const posts = createCollection<any>({
      uri: 'xdb://app/posts',
      onUpdate: async () => {
        throw new Error('server said no')
      },
    })
    const db = await createDB({ collections: { posts } })
    expect(db).toBeDefined()

    await posts.insert({ id: 'p-1', title: 'Hello', views: 1 }).isPersisted.promise
    const tx = posts.update('p-1', (d: any) => {
      d.views = 99
    })
    // The change is visible at once.
    expect(posts.get('p-1').views).toBe(99)
    await expect(tx.isPersisted.promise).rejects.toThrow('server said no')
    // Then it is reverted.
    expect(posts.get('p-1').views).toBe(1)
  })

  it('runs an optimistic action and rolls it back on failure', async () => {
    const posts = createCollection<any>({ uri: 'xdb://app/posts' })
    await createDB({ collections: { posts } })

    const bump = createOptimisticAction<string>({
      onMutate: (id) => {
        posts.update(id, (d: any) => {
          d.views += 1
        })
      },
      mutationFn: async () => {
        throw new Error('offline')
      },
    })

    await posts.insert({ id: 'p-1', title: 'Hello', views: 7 }).isPersisted.promise
    const tx = bump('p-1')
    expect(posts.get('p-1').views).toBe(8)
    await expect(tx.isPersisted.promise).rejects.toThrow('offline')
    expect(posts.get('p-1').views).toBe(7)
  })

  it('builds a local-only collection from the options creator', async () => {
    const ui = createCollection(localOnlyCollectionOptions<any>({ id: 'ui', initialData: [{ id: 'panel', open: true }] }))
    await createDB({ collections: { ui } })
    await ui.preload()

    expect(ui.get('panel')).toEqual({ id: 'panel', open: true })
    ui.update('panel', (d: any) => {
      d.open = false
    })
    expect(ui.get('panel').open).toBe(false)
  })

  it('exposes a Map-like state and iterators', async () => {
    const { posts, users } = setup()
    await createDB({ collections: { posts, users } })
    posts.insert([
      { id: 'p-1', title: 'One', author: 'u-1', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'p-2', title: 'Two', author: 'u-1', createdAt: '2026-09-02T00:00:00Z' },
    ] as never)

    expect(posts.size).toBe(2)
    expect([...posts.keys()].sort()).toEqual(['p-1', 'p-2'])
    expect([...posts.values()].map((p) => p.title).sort()).toEqual(['One', 'Two'])
    expect([...posts.entries()].map(([k]) => k).sort()).toEqual(['p-1', 'p-2'])
    expect(posts.state.get('p-1')!.title).toBe('One')
  })

  it('reports item-level changes through subscribeChanges', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })
    const batches: unknown[] = []
    const stop = posts.subscribeChanges((changes) => batches.push(changes))

    posts.insert({ id: 'p-1', title: 'One', author: 'u-1', createdAt: '2026-09-01T00:00:00Z' } as never)
    db.store.bus.flush()
    await Promise.resolve()
    await Promise.resolve()

    expect(batches.length).toBeGreaterThan(0)
    expect(batches[0]).toEqual([expect.objectContaining({ type: 'insert', key: 'p-1' })])
    stop()
  })

  it('refuses to write to a live query collection', async () => {
    const { posts, users } = setup()
    const db = await createDB({ collections: { posts, users } })
    const all = createLiveQueryCollection((q) => q.from({ post: posts }).select(({ post }) => ({ id: post.id })))
    all.bind(db.store)

    try {
      all.insert({ id: 'x' } as never)
      throw new Error('expected a throw')
    } catch (err) {
      expect(isXDBError(err, 'UNSUPPORTED')).toBe(true)
    }
  })
})
