import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { isXDBError } from '../core/errors.js'
import { memory } from '../drivers/memory.js'
import { query } from '../builder/query.js'
import { gt } from '../builder/expr.js'
import { TupleStore } from '../store/store.js'
import { createCollection } from './collection.js'
import type { Collection } from './collection.js'

const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  views: z.number().int().default(0),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().transform((v) => new Date(v)),
})
type PostT = { id: string; title: string; author: string; views: number; tags: string[]; createdAt: Date }

async function freshStore(): Promise<TupleStore> {
  return TupleStore.open({ driver: memory() })
}

describe('Collection: unbound', () => {
  it('throws UNAVAILABLE before bind', () => {
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    expect(() => posts.get('p-1')).toThrow()
    try {
      posts.get('p-1')
    } catch (err) {
      expect(isXDBError(err, 'UNAVAILABLE')).toBe(true)
    }
    expect(() => posts.insert({ id: 'p-1', title: 't', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)).toThrow()
  })
})

describe('Collection: basic CRUD', () => {
  async function setup() {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    return { store, posts }
  }

  it('path is ns/schema and def reflects the schema', () => {
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    expect(posts.path).toBe('app/posts')
    expect(posts.def.mode).toBe('strict')
  })

  it('insert applies defaults and a string-to-Date transform, and get reads it back', async () => {
    const { posts } = await setup()
    const tx = posts.insert({
      id: 'p-1',
      title: 'Hello',
      author: 'u-1',
      createdAt: '2026-09-13T00:00:00Z',
    } as any)
    await tx.isPersisted.promise

    const got = posts.get('p-1')
    expect(got).toBeDefined()
    expect(got!.views).toBe(0)
    expect(got!.tags).toEqual([])
    expect(got!.createdAt).toBeInstanceOf(Date)
    expect(got!.createdAt.toISOString()).toBe('2026-09-13T00:00:00.000Z')
  })

  it('has, size, toArray, and keys reflect inserted items', async () => {
    const { posts } = await setup()
    expect(posts.has('p-1')).toBe(false)
    expect(posts.size).toBe(0)

    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise
    await posts.insert({ id: 'p-2', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    expect(posts.has('p-1')).toBe(true)
    expect(posts.size).toBe(2)
    // `keys()` is an iterator, not an array: the DX contract matches
    // TanStack DB's `Map`-like collection surface.
    expect([...posts.keys()].sort()).toEqual(['p-1', 'p-2'])
    expect(posts.toArray().map((p) => p.id).sort()).toEqual(['p-1', 'p-2'])
  })

  it('entries, values, and state reflect inserted items', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    expect([...posts.entries()]).toEqual([['p-1', expect.objectContaining({ id: 'p-1', title: 'A' })]])
    expect([...posts.values()].map((p) => p.id)).toEqual(['p-1'])
    expect(posts.state.get('p-1')).toEqual(posts.get('p-1'))
    expect(posts.state.size).toBe(1)
  })

  it('insert accepts an array of items', async () => {
    const { posts } = await setup()
    const tx = posts.insert([
      { id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
      { id: 'p-2', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
    ])
    await tx.isPersisted.promise
    expect(posts.size).toBe(2)
  })

  it('insert on an existing key throws ALREADY_EXISTS', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise
    expect(() =>
      posts.insert({ id: 'p-1', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any),
    ).toThrow()
    try {
      posts.insert({ id: 'p-1', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    } catch (err) {
      expect(isXDBError(err, 'ALREADY_EXISTS')).toBe(true)
    }
  })

  it('update computes a diff and only writes changed attributes; the draft mutation is reflected on read', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    const tx = posts.update('p-1', (draft) => {
      draft.views += 1
    })
    // `mutations` is the item-level view (what a persistence handler reads);
    // `writes` is the tuple-level view (what the store applies).
    expect(tx.mutations.length).toBe(1)
    expect(tx.mutations[0]!.type).toBe('update')
    expect(tx.writes.length).toBe(1)
    expect(tx.writes[0]!.op).toBe('patch')
    await tx.isPersisted.promise

    expect(posts.get('p-1')!.views).toBe(1)
  })

  it('update accepts an array of ids', async () => {
    const { posts } = await setup()
    await posts.insert([
      { id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
      { id: 'p-2', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
    ]).isPersisted.promise

    await posts.update(['p-1', 'p-2'], (draft) => {
      draft.tags.push('news')
    }).isPersisted.promise

    expect(posts.get('p-1')!.tags).toEqual(['news'])
    expect(posts.get('p-2')!.tags).toEqual(['news'])
  })

  it('update on a missing id throws NOT_FOUND', async () => {
    const { posts } = await setup()
    expect(() => posts.update('missing', () => {})).toThrow()
    try {
      posts.update('missing', () => {})
    } catch (err) {
      expect(isXDBError(err, 'NOT_FOUND')).toBe(true)
    }
  })

  it('delete removes the whole record', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise
    await posts.delete('p-1').isPersisted.promise
    expect(posts.has('p-1')).toBe(false)
    expect(posts.get('p-1')).toBeUndefined()
  })

  it('delete accepts an array of ids', async () => {
    const { posts } = await setup()
    await posts.insert([
      { id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
      { id: 'p-2', title: 'B', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
    ]).isPersisted.promise
    await posts.delete(['p-1', 'p-2']).isPersisted.promise
    expect(posts.size).toBe(0)
  })

  it('delete on a missing id throws NOT_FOUND', async () => {
    const { posts } = await setup()
    expect(() => posts.delete('missing')).toThrow()
    try {
      posts.delete('missing')
    } catch (err) {
      expect(isXDBError(err, 'NOT_FOUND')).toBe(true)
    }
  })

  it('a stale version precondition surfaces as CONFLICT', async () => {
    const { store, posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    // The version a caller read before someone else wrote.
    const stale = store.get('app/posts/p-1', '_version')!.value as number

    // A concurrent write bumps the stored version past the one just read.
    await store.apply([
      { path: 'app/posts/p-1', op: 'patch', tuples: [{ path: 'app/posts/p-1', attr: 'title', value: 'B' }] },
    ])

    // Writing with the stale precondition now conflicts and changes nothing.
    await expect(
      store.apply([
        {
          path: 'app/posts/p-1',
          op: 'patch',
          tuples: [{ path: 'app/posts/p-1', attr: 'title', value: 'C' }],
          version: stale,
        },
      ]),
    ).rejects.toSatisfy((err) => isXDBError(err, 'CONFLICT'))
    expect(posts.get('p-1')!.title).toBe('B')
  })

  it('a collection update cannot conflict with itself, because it applies at once', async () => {
    const { store, posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    // Two updates in the same tick both land: each reads the version the one
    // before it wrote, because the index write is synchronous.
    const first = posts.update('p-1', (draft) => {
      draft.views += 1
    })
    const second = posts.update('p-1', (draft) => {
      draft.views += 1
    })
    await Promise.all([first.isPersisted.promise, second.isPersisted.promise])

    expect(posts.get('p-1')!.views).toBe(2)
    expect(store.get('app/posts/p-1', '_version')!.value).toBe(3)
  })
})

describe('Collection: validation', () => {
  it('insert throws VALIDATION with issues carrying a real field path', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    let caught: unknown
    try {
      posts.insert({ id: 'p-1', title: 5, author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    } catch (err) {
      caught = err
    }
    expect(isXDBError(caught, 'VALIDATION')).toBe(true)
    const issues = isXDBError(caught) ? caught.issues : undefined
    expect(issues?.some((i) => i.path === 'title')).toBe(true)
  })
})

describe('Collection: schema-free (dynamic)', () => {
  it('stores and reads whatever shape it is given', async () => {
    const store = await freshStore()
    const things = createCollection({ uri: 'xdb://app/things' })
    things.bind(store)
    expect(things.def.mode).toBe('dynamic')

    await things.insert({ id: 't-1', anything: 42, nested: { ok: true } }).isPersisted.promise
    const got = things.get('t-1')
    expect(got).toEqual({ id: 't-1', anything: 42, nested: { ok: true } })
  })
})

describe('Collection: isPersisted', () => {
  it('resolves after the driver accepts the write', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    await expect(tx.isPersisted.promise).resolves.toBeUndefined()
  })

  it('rejects when the driver fails', async () => {
    const driver = memory()
    const failing = { ...driver, apply: vi.fn().mockRejectedValue(new Error('disk full')) }
    const store = await TupleStore.open({ driver: failing })
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    await expect(tx.isPersisted.promise).rejects.toThrow('disk full')
  })
})

describe('Collection: subscribe', () => {
  it('fires on a relevant write and gives the current items immediately', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)

    const seen: number[] = []
    const unsub = posts.subscribe((items) => seen.push(items.length))
    expect(seen).toEqual([0])

    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise
    store.bus.flush()
    expect(seen).toEqual([0, 1])
    unsub()
  })

  it('does not fire on an unrelated schema', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    const users = createCollection({ uri: 'xdb://app/users' })
    posts.bind(store)
    users.bind(store)

    const seen: number[] = []
    posts.subscribe((items) => seen.push(items.length))
    expect(seen).toEqual([0])

    await users.insert({ id: 'u-1', name: 'Ravi' }).isPersisted.promise
    store.bus.flush()
    expect(seen).toEqual([0])
  })
})

describe('Collection: as a query source', () => {
  it('works with query().from(...) and returns real rows', async () => {
    const store = await freshStore()
    const posts: Collection<PostT> = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    await posts.insert([
      { id: 'p-1', title: 'Popular', author: 'u-1', views: 500, createdAt: '2026-01-01T00:00:00Z' } as any,
      { id: 'p-2', title: 'Quiet', author: 'u-1', views: 1, createdAt: '2026-01-01T00:00:00Z' } as any,
    ]).isPersisted.promise

    const rows = query()
      .from({ post: posts })
      .where(({ post }) => gt(post.views, 100))
      .run(store.index)

    expect(rows).toEqual([{ post: expect.objectContaining({ id: 'p-1', title: 'Popular' }) }])
  })
})

describe('Collection: a write reaches memory synchronously', () => {
  it('get() sees an insert on the very next line, with no await', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)

    posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    expect(posts.get('p-1')).toBeDefined()
    expect(posts.has('p-1')).toBe(true)
  })

  it('a write with no handler still reaches the driver', async () => {
    const driver = memory()
    const applySpy = vi.spyOn(driver, 'apply')
    const store = await TupleStore.open({ driver })
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)

    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    await tx.isPersisted.promise
    expect(applySpy).toHaveBeenCalled()
  })
})

describe('Collection: CollectionMutation shape', () => {
  async function setup() {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    return { store, posts }
  }

  it('insert reports type, key, modified, and the collection; no original or changes', async () => {
    const { posts } = await setup()
    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    await tx.isPersisted.promise

    expect(tx.mutations).toHaveLength(1)
    const m = tx.mutations[0]!
    expect(m.type).toBe('insert')
    expect(m.key).toBe('p-1')
    expect(m.original).toBeUndefined()
    expect(m.changes).toBeUndefined()
    expect(m.modified).toMatchObject({ id: 'p-1', title: 'A' })
    expect(m.collection).toBe(posts)
  })

  it('update reports type, key, original, modified, and changes holding only the changed fields', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', views: 1, createdAt: '2026-01-01T00:00:00Z' } as any)
      .isPersisted.promise

    const tx = posts.update('p-1', (draft) => {
      draft.views = 5
    })
    await tx.isPersisted.promise

    expect(tx.mutations).toHaveLength(1)
    const m = tx.mutations[0]!
    expect(m.type).toBe('update')
    expect(m.key).toBe('p-1')
    expect(m.original).toMatchObject({ id: 'p-1', views: 1 })
    expect(m.modified).toMatchObject({ id: 'p-1', views: 5 })
    // Only the field that actually changed is present.
    expect(m.changes).toEqual({ views: 5 })
  })

  it('delete reports type, key, and original; no modified or changes', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    const tx = posts.delete('p-1')
    await tx.isPersisted.promise

    expect(tx.mutations).toHaveLength(1)
    const m = tx.mutations[0]!
    expect(m.type).toBe('delete')
    expect(m.key).toBe('p-1')
    expect(m.original).toMatchObject({ id: 'p-1', title: 'A' })
    expect(m.modified).toBeUndefined()
    expect(m.changes).toBeUndefined()
  })
})

describe('Collection: persistence handlers', () => {
  it('onInsert fires with only this collection\'s insert mutations, after the change is already in memory', async () => {
    const store = await freshStore()
    const seenAt: Array<{ inMemory: boolean; count: number }> = []
    const posts = createCollection<PostT>({
      uri: 'xdb://app/posts',
      schema: Post,
      onInsert: async ({ transaction, collection }) => {
        seenAt.push({ inMemory: collection.has('p-1'), count: transaction.mutations.length })
      },
    })
    posts.bind(store)

    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    // Applied to memory before the handler is even awaited.
    expect(posts.has('p-1')).toBe(true)
    await tx.isPersisted.promise

    expect(seenAt).toEqual([{ inMemory: true, count: 1 }])
    expect(tx.mutations[0]!.type).toBe('insert')
  })

  it('onInsert rejection reverts the change and rejects isPersisted', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({
      uri: 'xdb://app/posts',
      schema: Post,
      onInsert: async () => {
        throw new Error('server refused')
      },
    })
    posts.bind(store)

    const tx = posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any)
    expect(posts.has('p-1')).toBe(true) // applied optimistically first
    await expect(tx.isPersisted.promise).rejects.toThrow('server refused')
    expect(tx.state).toBe('failed')
    // The revert runs, and is awaited, before `isPersisted` settles.
    expect(posts.has('p-1')).toBe(false)
  })

  it('onUpdate fires with the update mutation and reverts the value on rejection', async () => {
    const store = await freshStore()
    let fired: string | undefined
    const posts = createCollection<PostT>({
      uri: 'xdb://app/posts',
      schema: Post,
      onUpdate: async ({ transaction }) => {
        fired = transaction.mutations[0]?.type
      },
    })
    posts.bind(store)
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', views: 1, createdAt: '2026-01-01T00:00:00Z' } as any)
      .isPersisted.promise

    const tx = posts.update('p-1', (d) => {
      d.views = 9
    })
    await tx.isPersisted.promise
    expect(fired).toBe('update')
    expect(posts.get('p-1')!.views).toBe(9)
  })

  it('onDelete fires with the delete mutation and reverts on rejection', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({
      uri: 'xdb://app/posts',
      schema: Post,
      onDelete: async () => {
        throw new Error('cannot delete')
      },
    })
    posts.bind(store)
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    const tx = posts.delete('p-1')
    expect(posts.has('p-1')).toBe(false) // applied optimistically first
    await expect(tx.isPersisted.promise).rejects.toThrow('cannot delete')

    expect(posts.has('p-1')).toBe(true)
    expect(posts.get('p-1')).toMatchObject({ id: 'p-1', title: 'A' })
  })
})

describe('Collection: status, preload, and onFirstReady', () => {
  it('moves idle -> loading -> ready as bind hydrates', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    expect(posts.status).toBe('idle')

    posts.bind(store)
    expect(posts.status).toBe('loading')
    expect(posts.isReady()).toBe(false)

    await posts.preload()
    expect(posts.status).toBe('ready')
    expect(posts.isReady()).toBe(true)
  })

  it('onFirstReady fires once, and fires at once for a caller who registers late', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    let earlyCalls = 0
    posts.onFirstReady(() => earlyCalls++)

    posts.bind(store)
    await posts.preload()
    expect(earlyCalls).toBe(1)

    let lateCalls = 0
    posts.onFirstReady(() => lateCalls++)
    expect(lateCalls).toBe(1)
  })
})

describe('Collection: cleanup', () => {
  it('marks the collection cleaned-up', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    await posts.preload()

    await posts.cleanup()
    expect(posts.status).toBe('cleaned-up')
  })
})

describe('Collection: initialData', () => {
  it('seeds rows on bind, skipping a key that already exists', async () => {
    const store = await freshStore()
    const posts = createCollection<PostT>({
      uri: 'xdb://app/posts',
      schema: Post,
      initialData: [
        { id: 'p-1', title: 'Seeded', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
        { id: 'p-2', title: 'Also seeded', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any,
      ],
    })
    posts.bind(store)
    await posts.preload()

    expect(posts.size).toBe(2)
    expect(posts.get('p-1')!.title).toBe('Seeded')
    expect(posts.get('p-2')!.title).toBe('Also seeded')
  })
})

describe('Collection: subscribeChanges', () => {
  async function setup() {
    const store = await freshStore()
    const posts = createCollection<PostT>({ uri: 'xdb://app/posts', schema: Post })
    posts.bind(store)
    return { store, posts }
  }

  it('without includeInitialState, does not fire for pre-existing items', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    const seen: unknown[][] = []
    const unsub = posts.subscribeChanges((changes) => seen.push(changes))
    expect(seen).toHaveLength(0)
    unsub()
  })

  it('with includeInitialState, fires once with every current item as an insert', async () => {
    const { posts } = await setup()
    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as any).isPersisted
      .promise

    const seen: unknown[][] = []
    const unsub = posts.subscribeChanges((changes) => seen.push(changes), { includeInitialState: true })
    expect(seen).toEqual([[{ type: 'insert', key: 'p-1', value: expect.objectContaining({ id: 'p-1' }) }]])
    unsub()
  })

  it('reports an insert, then an update with previousValue, then a delete', async () => {
    const { posts } = await setup()
    const seen: any[] = []
    const unsub = posts.subscribeChanges((changes) => seen.push(...changes))

    await posts.insert({ id: 'p-1', title: 'A', author: 'u-1', views: 1, createdAt: '2026-01-01T00:00:00Z' } as any)
      .isPersisted.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([{ type: 'insert', key: 'p-1', value: expect.objectContaining({ views: 1 }) }])

    await posts.update('p-1', (d) => {
      d.views = 2
    }).isPersisted.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(seen[1]).toMatchObject({
      type: 'update',
      key: 'p-1',
      value: expect.objectContaining({ views: 2 }),
      previousValue: expect.objectContaining({ views: 1 }),
    })

    await posts.delete('p-1').isPersisted.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(seen[2]).toMatchObject({ type: 'delete', key: 'p-1' })

    unsub()
  })
})

describe('Collection: cleanup during hydration', () => {
  it('a load that resolves after cleanup does not revive the collection', async () => {
    const store = await TupleStore.open({ driver: memory() })
    const posts = createCollection<any>({ uri: 'xdb://app/posts' })
    // Bind starts an async hydrate. Clean up before it settles.
    posts.bind(store)
    await posts.cleanup()
    // Let the pending hydrate chain run to completion.
    await Promise.resolve()
    await Promise.resolve()
    expect(posts.status).toBe('cleaned-up')
  })
})
