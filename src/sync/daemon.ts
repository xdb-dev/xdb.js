/**
 * A `SyncSource` that talks to an XDB daemon over JSON-RPC 2.0. Pushes local
 * mutations with `batch.execute`, one batch operation per mutation. Pulls
 * remote changes from the `watch` server-sent-event stream when the daemon
 * offers one, and falls back to polling `records.list` with a per-record
 * version cursor otherwise.
 *
 * Wire shapes come from the Go daemon's own client and API packages:
 * `rpc.Request` / `rpc.Response` (github.com/xdb-dev/xdb/rpc/request.go),
 * the SSE framing in `rpc.Router.serveStream` (rpc/router.go), the
 * `records.*`, `batch.execute`, and `watch` method and parameter names in
 * `api/catalog/catalog.go`, and the `WatchEvent` shape in `api/watch.go`.
 */
import { unavailable } from '../core/errors.js'
import { decodeRecord, encodeRecord } from '../core/record.js'
import type { Mutation, RecordObject, SyncChange, SyncContext, SyncSource, Unsubscribe } from '../core/types.js'
import { formatURI, parseURI } from '../core/uri.js'

/** Options for {@link daemon}. */
export interface DaemonOptions {
  /** The base URL of the daemon's JSON-RPC endpoint. */
  url: string
  /**
   * Scope to watch: `ns` or `ns/schema`, with or without the `xdb://`
   * prefix. Defaults to the collection scope.
   *
   * The frozen `SyncSource` interface gives `daemon()` no channel to learn
   * a collection's URI after construction, so this module cannot infer
   * that default itself. When `scope` is omitted, {@link daemon}'s `start`
   * is a no-op: it watches nothing and returns an unsubscribe function that
   * does nothing. Pass `scope` explicitly to pull remote changes.
   */
  scope?: string
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Poll interval in ms when the server has no event stream. Defaults to 2000. */
  pollMs?: number
}

/** A JSON-RPC 2.0 error object, as `rpc.Error` in the Go daemon. */
interface RPCError {
  code: number
  message: string
  data?: unknown
}

/** A JSON-RPC 2.0 response envelope, as `rpc.Response` in the Go daemon. */
interface RPCResponse {
  jsonrpc?: string
  id?: string
  result?: unknown
  error?: RPCError
}

/** One entry of a `batch.execute` `operations` array, as `api.BatchOperation`. */
interface BatchOp {
  op: string
  uri: string
  data?: unknown
}

/** One entry of a `batch.execute` response's `results` array, as `api.BatchResult`. */
interface BatchResult {
  index: number
  uri: string
  status: string
  error?: RPCError
}

/** The response of `batch.execute`, as `api.ExecuteBatchResponse`. */
interface BatchResponse {
  total: number
  succeeded: number
  failed: number
  results: BatchResult[]
}

/** One frame of a `records.list` page, as `api.ListRecordsResponse`. */
interface ListResponse {
  items: RecordObject[]
  total: number
  next_offset: number
}

/** One `watch` SSE `event` frame's payload, as `api.WatchEvent`. */
interface RemoteWatchEvent {
  type: string
  uri: string
  data?: RecordObject
  version?: number
}

/** A source of write mutations, coalesced into one `batch.execute` request. */
async function call(fetchImpl: typeof fetch, url: string, id: string, method: string, params: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
  } catch (err) {
    throw unavailable(`cannot reach the daemon at ${url}: ${(err as Error).message}`, { cause: err })
  }

  let body: RPCResponse
  try {
    body = (await res.json()) as RPCResponse
  } catch (err) {
    throw unavailable(`the daemon at ${url} returned an invalid response to ${method}`, { cause: err })
  }

  if (body.error) {
    throw unavailable(`the daemon rejected ${method}: ${body.error.message}`, { cause: body.error })
  }
  if (!res.ok) {
    throw unavailable(`the daemon at ${url} responded with HTTP ${res.status} to ${method}`)
  }
  return body.result
}

/** Builds the daemon-facing URI of a bare `ns/schema/id` record path. */
function recordURI(path: string): string {
  return formatURI(parseURI(path))
}

/** Normalizes a scope (`ns` or `ns/schema`, with or without `xdb://`) to a daemon-facing URI. */
function scopeURI(scope: string): string {
  return formatURI(parseURI(scope))
}

/** The bare record-path prefix (`ns` or `ns/schema`) of a scope. */
function scopePrefix(scope: string): string {
  const u = parseURI(scope)
  return u.schema ? `${u.ns}/${u.schema}` : u.ns
}

/** Decodes a mutation's tuples to the plain `data` object the daemon's record methods expect. */
function toData(tuples: Mutation['tuples']): Record<string, unknown> {
  const obj = decodeRecord(tuples ?? [], { system: false }) as Record<string, unknown>
  delete obj.id
  return obj
}

/**
 * Compiles one local `Mutation` to the `batch.execute` operations it needs.
 * One mutation compiles to one operation, except a `delete` that names more
 * than one attribute: `records.delete` addresses at most one attribute per
 * call (`xdb://ns/schema/id#attr`), so such a mutation compiles to one
 * `records.delete` per named attribute.
 */
function toOps(m: Mutation): BatchOp[] {
  const uri = recordURI(m.path)
  switch (m.op) {
    case 'create':
      return [{ op: 'records.create', uri, data: toData(m.tuples) }]
    case 'put':
      return [{ op: 'records.upsert', uri, data: toData(m.tuples) }]
    case 'patch':
      return [{ op: 'records.update', uri, data: toData(m.tuples) }]
    case 'delete': {
      const attrs = m.attrs ?? []
      if (attrs.length === 0) return [{ op: 'records.delete', uri }]
      return attrs.map((a) => ({ op: 'records.delete', uri: `${uri}#${a}` }))
    }
  }
}

/** Reads one SSE frame (`event: ...\ndata: ...`) out of `frame`, or `null` when it is not an event frame. */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = ''
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length)
    else if (line.startsWith('data: ')) data = line.slice('data: '.length)
  }
  if (!event) return null
  return { event, data }
}

/** Reads SSE frames from `reader` until the stream ends, dispatching each `event` frame to `onEvent`. */
async function readSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: RemoteWatchEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let sep = buf.indexOf('\n\n')
    while (sep >= 0) {
      const frame = parseFrame(buf.slice(0, sep))
      buf = buf.slice(sep + 2)
      if (frame && frame.event === 'event') {
        try {
          onEvent(JSON.parse(frame.data) as RemoteWatchEvent)
        } catch {
          // Malformed frame. Skip it; the stream continues.
        }
      }
      sep = buf.indexOf('\n\n')
    }
  }
}

/** Applies one remote change event to `ctx` as one `begin`/`write*`/`commit` group. */
function applyEvent(ctx: SyncContext, evt: RemoteWatchEvent): void {
  if (!evt.type.startsWith('record.')) return // schema.* events carry no tuple data

  const u = parseURI(evt.uri)
  if (!u.schema || !u.id) return
  const path = `${u.ns}/${u.schema}/${u.id}`
  const version = evt.version ?? 0

  ctx.begin()
  if (evt.type === 'record.delete') {
    // A partial delete names its attribute in the URI fragment. A whole-record
    // delete carries no payload (see api.WatchEvent), so its attrs are unknown
    // here; '*' signals "the whole record", the same wildcard the footprint
    // layer uses for "every attribute".
    ctx.write({ path, attr: u.attr ?? '*', deleted: true, version })
  } else if (evt.data) {
    for (const t of encodeRecord(path, evt.data)) {
      ctx.write({ path, attr: t.attr, value: t.value, version })
    }
  }
  ctx.commit()
}

/**
 * A sync source that talks to an XDB daemon over JSON-RPC 2.0. `push` sends
 * mutations with `batch.execute`. `start` pulls from the `watch` SSE stream
 * when the daemon offers one, and otherwise polls `records.list` every
 * `opts.pollMs`.
 */
export function daemon(opts: DaemonOptions): SyncSource {
  const fetchImpl = opts.fetch ?? fetch
  const url = opts.url
  let seq = 0
  const nextID = (): string => String(++seq)

  async function push(mutations: Mutation[]): Promise<void> {
    if (mutations.length === 0) return
    const operations = mutations.flatMap(toOps)
    const result = (await call(fetchImpl, url, nextID(), 'batch.execute', { operations })) as
      | BatchResponse
      | undefined

    const failed = result?.results?.find((r) => r.status === 'error')
    if (failed || (result?.failed ?? 0) > 0) {
      throw unavailable(
        `the daemon rejected a batch operation on ${failed?.uri ?? '(unknown)'}: ${failed?.error?.message ?? 'unknown error'}`,
        { uri: failed?.uri },
      )
    }
  }

  /** Polls `records.list` on `scope` and translates changed records into writes. */
  function startPolling(scope: string, ctx: SyncContext): () => void {
    const seen = new Map<string, number>()
    let stopped = false

    const tick = async (): Promise<void> => {
      let page: ListResponse | undefined
      try {
        page = (await call(fetchImpl, url, nextID(), 'records.list', { uri: scopeURI(scope), limit: 1000 })) as
          | ListResponse
          | undefined
      } catch {
        return // Transient failure. Try again on the next tick.
      }
      if (stopped) return

      const prefix = scopePrefix(scope)
      const items = page?.items ?? []
      const current = new Set<string>()
      const writes: SyncChange[] = []

      for (const item of items) {
        const id = item._id
        if (typeof id !== 'string') continue
        const path = `${prefix}/${id}`
        current.add(path)
        const raw = item._version
        const version = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : 0
        const last = seen.get(path)
        if (last !== undefined && last >= version) continue
        seen.set(path, version)
        for (const t of encodeRecord(path, item)) {
          writes.push({ path, attr: t.attr, value: t.value, version })
        }
      }

      for (const path of seen.keys()) {
        if (!current.has(path)) {
          writes.push({ path, attr: '*', deleted: true, version: seen.get(path) ?? 0 })
          seen.delete(path)
        }
      }

      if (writes.length > 0) {
        ctx.begin()
        for (const w of writes) ctx.write(w)
        ctx.commit()
      }
    }

    const timer = setInterval(() => {
      void tick()
    }, opts.pollMs ?? 2000)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  function start(ctx: SyncContext): Unsubscribe {
    const scope = opts.scope
    if (!scope) return () => {}

    let stopped = false
    let stopPoll: (() => void) | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

    const openStream = async (): Promise<void> => {
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: nextID(), method: 'watch', params: { uri: scopeURI(scope) } }),
        })
      } catch {
        if (!stopped) stopPoll = startPolling(scope, ctx)
        return
      }
      if (stopped) return

      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || !res.body || !contentType.includes('text/event-stream')) {
        stopPoll = startPolling(scope, ctx)
        return
      }

      reader = res.body.getReader()
      try {
        await readSSE(reader, (evt) => applyEvent(ctx, evt))
      } catch {
        // The stream ended or broke. This release does not reconnect.
      }
    }

    void openStream()

    return () => {
      stopped = true
      if (reader) void reader.cancel().catch(() => {})
      if (stopPoll) stopPoll()
    }
  }

  return { push, start }
}
