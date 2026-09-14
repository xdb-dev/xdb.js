import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isXDBError } from '../core/errors.js'
import type { Mutation, SyncChange, SyncContext } from '../core/types.js'
import { daemon } from './daemon.js'

/** One JSON-RPC request as vitest sees it through a mocked `fetch`. */
function requestOf(call: unknown[]): { url: string; init: RequestInit; body: any } {
  const [url, init] = call as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) }
}

/** A `SyncContext` that records `begin`/`write`/`commit` calls, in order, as strings. */
function recordingContext(): SyncContext & { order: string[] } {
  const order: string[] = []
  return {
    order,
    begin: vi.fn(() => order.push('begin')),
    write: vi.fn((c: SyncChange) => {
      order.push(`write:${c.path}:${c.attr}:${c.deleted ? 'deleted' : JSON.stringify(c.value)}:${c.version}`)
    }),
    commit: vi.fn(() => order.push('commit')),
  }
}

/** A record mutation's tuples, including the system tuples the store would stamp on it. */
function recordTuples(path: string, attrs: Record<string, unknown>, id: string, version: number): Mutation['tuples'] {
  return [
    ...Object.entries(attrs).map(([attr, value]) => ({ path, attr, value }) as any),
    { path, attr: '_id', value: id },
    { path, attr: '_version', value: version },
    { path, attr: '_updated', value: new Date('2024-01-01T00:00:00.000Z') },
  ]
}

/**
 * A minimal SSE `ReadableStream<Uint8Array>` that yields `frames` in order,
 * then stays open (like a live connection) until `cancel()`, so a test can
 * observe that unsubscribing actually tears the stream down.
 */
function sseStream(frames: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i++]))
      }
      // Once frames run out, stay open: a live watch stream does not close on
      // its own. The test ends it explicitly through `stop()`.
    },
    cancel() {
      onCancel?.()
    },
  })
}

describe('daemon push', () => {
  it('sends a batch.execute request with one operation per mutation', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: '1', result: { total: 5, succeeded: 5, failed: 0, results: [] } }),
    })) as unknown as typeof fetch

    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock })

    const mutations: Mutation[] = [
      { path: 'app/posts/p1', op: 'create', tuples: recordTuples('app/posts/p1', { title: 'Hello' }, 'p1', 1) },
      { path: 'app/posts/p2', op: 'put', tuples: recordTuples('app/posts/p2', { title: 'World' }, 'p2', 1) },
      { path: 'app/posts/p3', op: 'patch', tuples: recordTuples('app/posts/p3', { views: 3 }, 'p3', 2) },
      { path: 'app/posts/p4', op: 'delete' },
      { path: 'app/posts/p5', op: 'delete', attrs: ['views'] },
      { path: 'app/posts/p6', op: 'delete', attrs: ['views', 'title'] },
    ]

    await source.push(mutations)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init, body } = requestOf((fetchMock as any).mock.calls[0])
    expect(url).toBe('http://localhost:7777/rpc')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: '1',
      method: 'batch.execute',
      params: {
        operations: [
          { op: 'records.create', uri: 'xdb://app/posts/p1', data: { title: 'Hello' } },
          { op: 'records.upsert', uri: 'xdb://app/posts/p2', data: { title: 'World' } },
          { op: 'records.update', uri: 'xdb://app/posts/p3', data: { views: 3 } },
          { op: 'records.delete', uri: 'xdb://app/posts/p4' },
          { op: 'records.delete', uri: 'xdb://app/posts/p5#views' },
          { op: 'records.delete', uri: 'xdb://app/posts/p6#views' },
          { op: 'records.delete', uri: 'xdb://app/posts/p6#title' },
        ],
      },
    })
  })

  it('does nothing for an empty mutation list', async () => {
    const fetchMock = vi.fn()
    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock as unknown as typeof fetch })
    await source.push([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws UNAVAILABLE when the transport rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock })

    await expect(source.push([{ path: 'app/posts/p1', op: 'delete' }])).rejects.toSatisfy(
      (e: unknown) => isXDBError(e, 'UNAVAILABLE') && /connection refused/.test((e as Error).message),
    )
  })

  it('throws UNAVAILABLE on a JSON-RPC error response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: '1', error: { code: -32602, message: 'invalid params' } }),
    })) as unknown as typeof fetch
    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock })

    await expect(source.push([{ path: 'app/posts/p1', op: 'delete' }])).rejects.toSatisfy(
      (e: unknown) => isXDBError(e, 'UNAVAILABLE') && /invalid params/.test((e as Error).message),
    )
  })

  it('throws UNAVAILABLE when a batch operation fails', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: {
          total: 1,
          succeeded: 0,
          failed: 1,
          results: [{ index: 0, uri: 'xdb://app/posts/p1', status: 'error', error: { code: -32003, message: 'conflict' } }],
        },
      }),
    })) as unknown as typeof fetch
    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock })

    await expect(
      source.push([{ path: 'app/posts/p1', op: 'patch', tuples: [{ path: 'app/posts/p1', attr: 'views', value: 1 }] }]),
    ).rejects.toSatisfy((e: unknown) => isXDBError(e, 'UNAVAILABLE') && /conflict/.test((e as Error).message))
  })
})

describe('daemon start: polling fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls back to polling records.list when the server has no event stream, then stops cleanly', async () => {
    let listCalls = 0
    const pages = [
      { items: [{ _id: 'p1', _version: 1, title: 'Hello' }], total: 1, next_offset: 0 },
      { items: [{ _id: 'p1', _version: 1, title: 'Hello' }], total: 1, next_offset: 0 }, // unchanged version
      { items: [], total: 0, next_offset: 0 }, // p1 removed
    ]

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string)
      if (req.method === 'watch') {
        return { ok: true, headers: { get: () => 'application/json' } } as unknown as Response
      }
      if (req.method === 'records.list') {
        const page = pages[listCalls++] ?? { items: [], total: 0, next_offset: 0 }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, result: page }) } as unknown as Response
      }
      throw new Error(`unexpected method ${req.method}`)
    }) as unknown as typeof fetch

    const source = daemon({ url: 'http://localhost:7777/rpc', scope: 'app/posts', pollMs: 1000, fetch: fetchMock })
    const ctx = recordingContext()

    const stop = source.start(ctx)

    // Let the watch-capability probe resolve before the first interval fires.
    await vi.advanceTimersByTimeAsync(0)
    const watchCall = requestOf((fetchMock as any).mock.calls[0])
    expect(watchCall.body).toMatchObject({ method: 'watch', params: { uri: 'xdb://app/posts' } })

    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.order).toEqual(['begin', 'write:app/posts/p1:title:"Hello":1', 'commit'])

    // Second tick: same version, no change, no begin/write/commit.
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.order).toEqual(['begin', 'write:app/posts/p1:title:"Hello":1', 'commit'])

    // Third tick: the record is gone, a deleted write goes out.
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.order).toEqual([
      'begin',
      'write:app/posts/p1:title:"Hello":1',
      'commit',
      'begin',
      'write:app/posts/p1:*:deleted:1',
      'commit',
    ])

    const callsBeforeStop = (fetchMock as any).mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect((fetchMock as any).mock.calls.length).toBe(callsBeforeStop)
  })
})

describe('daemon start: server-sent events', () => {
  it('translates watch event frames into begin/write/commit and stops the stream on unsubscribe', async () => {
    let cancelled = false
    const frames = [
      'event: ready\ndata: {"uri":"xdb://app/posts"}\n\n',
      'event: event\ndata: {"type":"record.update","uri":"xdb://app/posts/p1","data":{"title":"Hi","_version":2},"version":2}\n\n',
      'event: event\ndata: {"type":"record.delete","uri":"xdb://app/posts/p2#views","version":3}\n\n',
    ]

    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: sseStream(frames, () => {
        cancelled = true
      }),
    })) as unknown as typeof fetch

    const source = daemon({ url: 'http://localhost:7777/rpc', scope: 'app/posts', fetch: fetchMock })
    const ctx = recordingContext()

    const stop = source.start(ctx)

    await vi.waitFor(() => expect(ctx.order.filter((e) => e === 'commit').length).toBe(2))

    expect(ctx.order).toEqual([
      'begin',
      'write:app/posts/p1:title:"Hi":2',
      'commit',
      'begin',
      'write:app/posts/p2:views:deleted:3',
      'commit',
    ])

    stop()
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('makes no request and returns a no-op unsubscribe when no scope is configured', () => {
    const fetchMock = vi.fn()
    const source = daemon({ url: 'http://localhost:7777/rpc', fetch: fetchMock as unknown as typeof fetch })
    const ctx = recordingContext()
    const stop = source.start(ctx)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })
})
