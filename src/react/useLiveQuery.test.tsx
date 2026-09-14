// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gt } from '../builder/expr.js'
import type { QueryBuilder } from '../builder/query.js'
import type { RecordObject } from '../core/types.js'
import { memory } from '../drivers/memory.js'
import { TupleStore } from '../store/store.js'
import type { CollectionLike } from './useLiveQuery.js'
import { useCollection, useLiveQuery, useStore, XDBProvider } from './useLiveQuery.js'

/**
 * `XDBProvider`'s frozen signature returns `unknown` (CONTRACTS.md), so TSX
 * cannot use it directly as a component type. This test-only cast narrows it
 * back to a normal component for JSX; it changes no exported signature.
 */
const Provider = XDBProvider as unknown as (props: { store: TupleStore; children?: React.ReactNode }) => React.ReactElement

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A fresh store with two `app/posts` records and one unrelated `app/comments` record. */
async function seededStore(): Promise<TupleStore> {
  const store = await TupleStore.open({ driver: memory() })
  await store.apply([
    {
      path: 'app/posts/p1',
      op: 'create',
      tuples: [
        { path: 'app/posts/p1', attr: 'title', value: 'Low' },
        { path: 'app/posts/p1', attr: 'views', value: 5 },
      ],
    },
    {
      path: 'app/posts/p2',
      op: 'create',
      tuples: [
        { path: 'app/posts/p2', attr: 'title', value: 'High' },
        { path: 'app/posts/p2', attr: 'views', value: 150 },
      ],
    },
    {
      path: 'app/comments/c1',
      op: 'create',
      tuples: [{ path: 'app/comments/c1', attr: 'body', value: 'first!' }],
    },
  ])
  return store
}

function wrapperFor(store: TupleStore) {
  return function Wrapper({ children }: { children?: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

describe('useLiveQuery', () => {
  it('returns the current rows of the built query', async () => {
    const store = await seededStore()
    const { result } = renderHook(
      () => useLiveQuery<{ post: RecordObject }>((q) => q.from({ post: { path: 'app/posts' } })),
      { wrapper: wrapperFor(store) },
    )

    expect(result.current.isLoading).toBe(false)
    expect(result.current.data.map((r) => r.post.id).sort()).toEqual(['p1', 'p2'])
  })

  it('re-renders with new rows after a matching write', async () => {
    const store = await seededStore()
    const { result } = renderHook(
      () => useLiveQuery<{ post: RecordObject }>((q) => q.from({ post: { path: 'app/posts' } }).where(({ post }) => gt(post.views, 100))),
      { wrapper: wrapperFor(store) },
    )

    expect(result.current.data.map((r) => r.post.id)).toEqual(['p2'])

    await act(async () => {
      await store.apply([{ path: 'app/posts/p1', op: 'patch', tuples: [{ path: 'app/posts/p1', attr: 'views', value: 500 }] }])
    })

    expect(result.current.data.map((r) => r.post.id).sort()).toEqual(['p1', 'p2'])
  })

  it('does not re-render the component on an unrelated write', async () => {
    const store = await seededStore()
    const renders = { count: 0 }

    function Probe(): React.ReactElement {
      renders.count++
      const { data } = useLiveQuery<{ post: RecordObject }>((q) => q.from({ post: { path: 'app/posts' } }))
      return <div data-testid="ids">{data.map((r) => r.post.id).join(',')}</div>
    }

    render(
      <Provider store={store}>
        <Probe />
      </Provider>,
    )

    const rendersAfterMount = renders.count
    expect(screen.getByTestId('ids').textContent).toBe('p1,p2')

    await act(async () => {
      await store.apply([{ path: 'app/comments/c1', op: 'patch', tuples: [{ path: 'app/comments/c1', attr: 'body', value: 'edited' }] }])
    })

    expect(renders.count).toBe(rendersAfterMount)
    expect(screen.getByTestId('ids').textContent).toBe('p1,p2')
  })

  it('unsubscribes from the store on unmount', async () => {
    const store = await seededStore()
    let unsubscribeCalls = 0
    const originalLive = store.live.bind(store)
    vi.spyOn(store, 'live').mockImplementation((run) => {
      const live = originalLive(run)
      return {
        toArray: () => live.toArray(),
        subscribe: (cb) => {
          const unsub = live.subscribe(cb)
          return () => {
            unsubscribeCalls++
            unsub()
          }
        },
      }
    })

    const { unmount } = renderHook(() => useLiveQuery<{ post: RecordObject }>((q) => q.from({ post: { path: 'app/posts' } })), {
      wrapper: wrapperFor(store),
    })

    expect(unsubscribeCalls).toBe(0)
    unmount()
    expect(unsubscribeCalls).toBe(1)
  })

  it('rebuilds the query when deps change', async () => {
    const store = await seededStore()
    let liveCalls = 0
    const originalLive = store.live.bind(store)
    vi.spyOn(store, 'live').mockImplementation((run) => {
      liveCalls++
      return originalLive(run)
    })

    const build = (min: number) => (q: QueryBuilder) => q.from({ post: { path: 'app/posts' } }).where(({ post }) => gt(post.views, min))

    const { result, rerender } = renderHook(({ min }: { min: number }) => useLiveQuery<{ post: RecordObject }>(build(min), [min]), {
      wrapper: wrapperFor(store),
      initialProps: { min: 100 },
    })

    expect(result.current.data.map((r) => r.post.id)).toEqual(['p2'])
    expect(liveCalls).toBe(1)

    rerender({ min: 100 })
    expect(liveCalls).toBe(1) // same deps: no rebuild

    rerender({ min: 1 })
    expect(liveCalls).toBe(2) // deps changed: rebuilt
    expect(result.current.data.map((r) => r.post.id).sort()).toEqual(['p1', 'p2'])
  })
})

describe('useStore', () => {
  it('throws UNAVAILABLE outside an XDBProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useStore())).toThrow(/XDBProvider/)
    spy.mockRestore()
  })
})

describe('useCollection', () => {
  function fakeCollection<T>(initial: T[]): CollectionLike<T> & { push: (item: T) => void } {
    let items = initial
    const subs = new Set<(items: T[]) => void>()
    return {
      toArray: () => items,
      subscribe(cb) {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      push(item: T) {
        items = [...items, item]
        for (const cb of subs) cb(items)
      },
    }
  }

  it('reflects a collection-like object and updates when it changes', async () => {
    const collection = fakeCollection<{ id: string }>([{ id: 'a' }])
    const { result } = renderHook(() => useCollection(collection))

    expect(result.current.data).toEqual([{ id: 'a' }])

    act(() => {
      collection.push({ id: 'b' })
    })

    expect(result.current.data).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})
