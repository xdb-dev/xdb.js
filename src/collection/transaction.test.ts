import { describe, expect, it } from 'vitest'
import { isXDBError } from '../core/errors.js'
import { memory } from '../drivers/memory.js'
import { TupleStore } from '../store/store.js'
import { createCollection } from './collection.js'
import { createOptimisticAction, createTransaction } from './transaction.js'

async function freshStore(): Promise<TupleStore> {
  return TupleStore.open({ driver: memory() })
}

describe('createTransaction', () => {
  it('commit applies every mutation as one store batch, so a live query reruns once', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    const users = createCollection<{ id: string; active: boolean }>({ uri: 'xdb://app/users' })
    posts.bind(store)
    users.bind(store)

    await posts.insert({ id: 'p-1', views: 0 }).isPersisted.promise
    await users.insert({ id: 'u-1', active: false }).isPersisted.promise

    let calls = 0
    store.live((index, fp) => {
      fp.add('app/posts', null)
      fp.add('app/users', null)
      calls++
      return [...index.paths('app/posts'), ...index.paths('app/users')]
    }).subscribe(() => {})
    calls = 0 // the initial subscribe call does not count

    const tx = createTransaction({ store })
    tx.mutate(() => {
      posts.update('p-1', (draft) => {
        draft.views += 1
      })
      users.update('u-1', (draft) => {
        draft.active = true
      })
    })

    expect(tx.mutations.length).toBe(2)
    await tx.commit()
    store.bus.flush()

    expect(calls).toBe(1)
    expect(posts.get('p-1')!.views).toBe(1)
    expect(users.get('u-1')!.active).toBe(true)
  })

  it('a mutation made inside mutate() resolves its isPersisted only once commit succeeds', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)
    await posts.insert({ id: 'p-1', views: 0 }).isPersisted.promise

    const tx = createTransaction({ store })
    let redirected: ReturnType<typeof posts.update> | null = null
    tx.mutate(() => {
      redirected = posts.update('p-1', (draft) => {
        draft.views = 5
      })
    })

    // Not applied to the store yet: memory is untouched until commit.
    expect(posts.get('p-1')!.views).toBe(0)

    let settled = false
    redirected!.isPersisted.promise.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    await tx.commit()
    expect(posts.get('p-1')!.views).toBe(5)
    await redirected!.isPersisted.promise
    expect(settled).toBe(true)
  })

  it('rollback discards the collected mutations and leaves the store untouched', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)
    await posts.insert({ id: 'p-1', views: 0 }).isPersisted.promise

    const tx = createTransaction({ store })
    tx.mutate(() => {
      posts.update('p-1', (draft) => {
        draft.views = 99
      })
    })
    expect(tx.mutations.length).toBe(1)

    tx.rollback()
    expect(posts.get('p-1')!.views).toBe(0)
    expect(tx.mutations.length).toBe(0)
    expect(tx.writes.length).toBe(0)

    // A rolled-back transaction is no longer pending: committing it throws,
    // matching a commit on any other non-pending transaction.
    await expect(tx.commit()).rejects.toSatisfy((err) => isXDBError(err, 'UNSUPPORTED'))
  })

  it('outside of mutate(), a collection write applies directly, unaffected by an unrelated transaction', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store })
    tx.mutate(() => {
      // nothing
    })

    await posts.insert({ id: 'p-1', views: 0 }).isPersisted.promise
    expect(posts.get('p-1')).toBeDefined()
    expect(tx.mutations.length).toBe(0)
  })
})

describe('Transaction: state machine', () => {
  it('starts pending, moves to persisting, then completed on a successful commit', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store })
    expect(tx.state).toBe('pending')

    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))
    const seenDuring: string[] = []
    const commitPromise = tx.commit()
    seenDuring.push(tx.state) // synchronously moved to 'persisting' before any await
    await commitPromise

    expect(seenDuring).toEqual(['persisting'])
    expect(tx.state).toBe('completed')
  })

  it('moves to failed when mutationFn rejects', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store, mutationFn: () => Promise.reject(new Error('nope')) })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))
    await expect(tx.commit()).rejects.toThrow('nope')
    expect(tx.state).toBe('failed')
  })

  it('commit on a non-pending transaction throws UNSUPPORTED', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))
    await tx.commit()
    expect(tx.state).toBe('completed')

    await expect(tx.commit()).rejects.toSatisfy((err) => isXDBError(err, 'UNSUPPORTED'))
  })

  it('rollback on a completed transaction throws UNSUPPORTED', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))
    await tx.commit()

    expect(() => tx.rollback()).toThrow()
    try {
      tx.rollback()
    } catch (err) {
      expect(isXDBError(err, 'UNSUPPORTED')).toBe(true)
    }
  })
})

describe('Transaction: a rejected mutationFn reverts the store batch', () => {
  it('restores the prior field values and rejects isPersisted', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)
    await posts.insert({ id: 'p-1', views: 1 }).isPersisted.promise

    const tx = createTransaction({ store, mutationFn: () => Promise.reject(new Error('rejected')) })
    tx.mutate(() => {
      posts.update('p-1', (draft) => {
        draft.views = 100
      })
    })

    // Applied optimistically as soon as commit starts.
    const commitPromise = tx.commit()
    await expect(commitPromise).rejects.toThrow('rejected')
    await expect(tx.isPersisted.promise).rejects.toThrow('rejected')

    // Reverted back to the value before the batch.
    expect(posts.get('p-1')!.views).toBe(1)
  })

  it('a rejected mutationFn on an insert removes the record it created', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store, mutationFn: () => Promise.reject(new Error('rejected')) })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))

    await expect(tx.commit()).rejects.toThrow('rejected')
    expect(posts.has('p-1')).toBe(false)
  })
})

describe('Transaction: autoCommit', () => {
  it('defaults to false: mutate() does not commit on its own', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))
    expect(tx.state).toBe('pending')
    expect(posts.has('p-1')).toBe(false)
  })

  it('true: commits as soon as mutate() returns', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const tx = createTransaction({ store, autoCommit: true })
    tx.mutate(() => posts.insert({ id: 'p-1', views: 0 }))

    // The index write inside `commit` happens synchronously, so the record
    // is visible immediately, even though `commit` itself is async.
    expect(posts.has('p-1')).toBe(true)
    await tx.isPersisted.promise
    expect(tx.state).toBe('completed')
  })
})

describe('createOptimisticAction', () => {
  it('applies onMutate at once and persists through mutationFn', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const persisted: unknown[] = []
    const addPost = createOptimisticAction<{ id: string }>({
      onMutate: (params) => posts.insert({ id: params.id, views: 0 }),
      mutationFn: async (params) => {
        persisted.push(params.id)
      },
    })

    const tx = addPost({ id: 'p-1' })
    expect(posts.has('p-1')).toBe(true) // applied at once
    await tx.isPersisted.promise
    expect(persisted).toEqual(['p-1'])
    expect(tx.state).toBe('completed')
  })

  it('rolls back the optimistic change when mutationFn rejects', async () => {
    const store = await freshStore()
    const posts = createCollection<{ id: string; views: number }>({ uri: 'xdb://app/posts' })
    posts.bind(store)

    const addPost = createOptimisticAction<{ id: string }>({
      onMutate: (params) => posts.insert({ id: params.id, views: 0 }),
      mutationFn: async () => {
        throw new Error('server rejected')
      },
    })

    const tx = addPost({ id: 'p-1' })
    expect(posts.has('p-1')).toBe(true) // applied at once, before the rejection
    await expect(tx.isPersisted.promise).rejects.toThrow('server rejected')
    expect(posts.has('p-1')).toBe(false)
  })
})
