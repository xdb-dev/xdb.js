/**
 * The developer-experience page. Runs every example against the real library,
 * in the browser, and shows the tuples, the live queries, and the change
 * events that the code produces.
 */
import { z } from 'zod'
import * as xdb from '../src/index.js'
import { isBytes, isDate } from '../src/core/value.js'
import type { LiveQuery, Tuple, WatchEvent } from '../src/core/types.js'
import { examples } from './examples.js'

interface Shared {
  db?: any
  posts?: any
  users?: any
}

const S: Shared = {}
const lives = new Map<string, LiveQuery<unknown>>()
const liveRows = new Map<string, unknown[]>()
const liveStops: Array<() => void> = []
const events: WatchEvent[] = []

const $ = (sel: string) => document.querySelector(sel)!
const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** Indents each part by two spaces, including its own inner lines. */
function block(parts: string[]): string {
  return parts.map((part) => '  ' + part.split('\n').join('\n  ')).join(',\n')
}

/** Renders a value the way the page shows it: compact, but readable. */
function show(v: unknown, depth = 0): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return depth === 0 ? v : JSON.stringify(v)
  if (typeof v === 'bigint') return `${v}n`
  if (isDate(v)) return v.toISOString()
  if (isBytes(v)) return `bytes(${v.length})`
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const parts = v.map((x) => show(x, depth + 1))
    const oneLine = `[${parts.join(', ')}]`
    return oneLine.length <= 80 ? oneLine : `[\n${block(parts)}\n]`
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const parts = entries.map(([k, x]) => `${k}: ${show(x, depth + 1)}`)
    const oneLine = `{ ${parts.join(', ')} }`
    return oneLine.length <= 80 ? oneLine : `{\n${block(parts)}\n}`
  }
  return String(v)
}

// ---- the live panels on the right ----

function renderTuples(): void {
  const host = $('#tuples')
  host.textContent = ''
  const all: Tuple[] = S.db ? [...S.db.store.index.all()] : []
  $('#tuple-count').textContent = `${all.length}`
  if (!S.db) {
    host.append(el('p', 'empty', 'Run the first example.'))
    return
  }
  if (all.length === 0) {
    host.append(el('p', 'empty', 'No tuples yet.'))
    return
  }
  all.sort((a, b) => (a.path === b.path ? a.attr.localeCompare(b.attr) : a.path.localeCompare(b.path)))
  const table = el('table', 'tuples')
  const head = el('tr')
  for (const h of ['path', 'attr', 'value']) head.append(el('th', undefined, h))
  table.append(head)
  let lastPath = ''
  for (const t of all) {
    const row = el('tr', t.attr.startsWith('_') ? 'sys' : undefined)
    row.append(el('td', 'path', t.path === lastPath ? '' : t.path))
    lastPath = t.path
    row.append(el('td', 'attr', t.attr))
    const value = el('td', 'val', show(t.value, 1))
    if (t.type) value.title = t.type
    row.append(value)
    table.append(row)
  }
  host.append(table)
}

function renderLives(): void {
  const host = $('#lives')
  host.textContent = ''
  if (lives.size === 0) {
    host.append(el('p', 'empty', 'Run the live query example.'))
    return
  }
  for (const [name] of lives) {
    const rows = liveRows.get(name) ?? []
    const box = el('div', 'live')
    const head = el('div', 'live-head')
    head.append(el('span', 'live-name', name))
    head.append(el('span', 'badge', `${rows.length} row${rows.length === 1 ? '' : 's'}`))
    box.append(head)
    const pre = el('pre', 'live-rows', rows.length ? rows.map((r) => show(r, 1)).join('\n') : '(no rows)')
    box.append(pre)
    host.append(box)
  }
}

function renderEvents(): void {
  const host = $('#events')
  host.textContent = ''
  $('#event-count').textContent = `${events.length}`
  if (events.length === 0) {
    host.append(el('p', 'empty', 'No change events yet.'))
    return
  }
  for (const e of [...events].reverse().slice(0, 40)) {
    const row = el('div', 'event')
    row.append(el('span', `tag ${e.type}`, e.type))
    row.append(el('span', 'uri', e.uri.replace('xdb://', '')))
    if (e.attrs.length) row.append(el('span', 'attrs', e.attrs.join(', ')))
    row.append(el('span', 'ver', `v${e.version}`))
    host.append(row)
  }
}

function renderPanels(): void {
  renderTuples()
  renderLives()
  renderEvents()
}

/** Keeps a live query on screen. The panel re-renders whenever it emits. */
function watchLive(name: string, live: LiveQuery<unknown>): void {
  lives.set(name, live)
  liveRows.set(name, live.toArray())
  liveStops.push(
    live.subscribe((rows) => {
      liveRows.set(name, rows)
      renderLives()
    }),
  )
  renderLives()
}

// ---- running an example ----

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

const api = {
  z,
  ...xdb,
}

async function run(code: string, out: HTMLElement): Promise<void> {
  out.textContent = ''
  out.classList.remove('error')
  const lines: string[] = []
  const log = (...args: unknown[]): void => {
    lines.push(args.map((a) => show(a)).join(' '))
    out.textContent = lines.join('\n')
  }
  const use = (vals: Shared): void => {
    const isNewDB = vals.db !== undefined && vals.db !== S.db
    Object.assign(S, vals)
    if (isNewDB && S.db) {
      liveStops.splice(0).forEach((stop) => stop())
      lives.clear()
      liveRows.clear()
      events.length = 0
      S.db.watch('xdb://app', (e: WatchEvent) => {
        events.push(e)
        renderEvents()
      })
    }
  }

  // The code runs inside `with`, over a proxy scope. That way an example can
  // declare `const posts = ...` and shadow the shared one, while a later
  // example reads the shared one as a free variable. Getters keep the shared
  // values live after `use()` replaces them.
  const scope: Record<string, unknown> = {
    log,
    use,
    watchLive,
    ...api,
  }
  Object.defineProperties(scope, {
    db: { get: () => S.db, enumerable: true },
    posts: { get: () => S.posts, enumerable: true },
    users: { get: () => S.users, enumerable: true },
  })
  const sandbox = new Proxy(scope, {
    has: () => true,
    get: (target, key) => (key in target ? target[key as string] : (globalThis as never)[key as never]),
  })

  try {
    const fn = new AsyncFunction('$scope', `with ($scope) {\n${code}\n}`)
    await fn(sandbox)
    if (lines.length === 0) log('ok')
  } catch (err) {
    out.classList.add('error')
    const e = err as { code?: string; message?: string; issues?: unknown }
    const head = e.code ? `${e.code}: ${e.message}` : String(err)
    out.textContent = [...lines, head, e.issues ? show(e.issues) : ''].filter(Boolean).join('\n')
  }
  renderPanels()
}

// ---- page ----

function card(ex: (typeof examples)[number], index: number): HTMLElement {
  const section = el('section', 'card')
  section.id = ex.id

  const head = el('div', 'card-head')
  head.append(el('span', 'num', String(index + 1)))
  head.append(el('h2', undefined, ex.title))
  section.append(head)
  section.append(el('p', 'blurb', ex.blurb))

  const editor = el('textarea', 'code') as HTMLTextAreaElement
  editor.value = ex.code
  editor.spellcheck = false
  editor.rows = ex.code.split('\n').length + 1
  section.append(editor)

  const bar = el('div', 'bar')
  const runBtn = el('button', 'run', 'Run') as HTMLButtonElement
  const resetBtn = el('button', 'ghost', 'Reset code') as HTMLButtonElement
  bar.append(runBtn, resetBtn)
  section.append(bar)

  const out = el('pre', 'out')
  out.textContent = 'Not run yet.'
  section.append(out)

  runBtn.onclick = async () => {
    runBtn.disabled = true
    runBtn.textContent = 'Running'
    if (!S.db && ex.id !== 'define') {
      await run(examples[0]!.code, el('pre'))
    }
    await run(editor.value, out)
    runBtn.disabled = false
    runBtn.textContent = 'Run'
  }
  resetBtn.onclick = () => {
    editor.value = ex.code
    editor.rows = ex.code.split('\n').length + 1
  }
  return section
}

function mount(): void {
  const main = $('#examples')
  examples.forEach((ex, i) => main.append(card(ex, i)))

  const nav = $('#toc')
  examples.forEach((ex, i) => {
    const a = el('a', undefined, `${i + 1}. ${ex.title}`) as HTMLAnchorElement
    a.href = `#${ex.id}`
    nav.append(a)
  })

  $('#run-all').addEventListener('click', async () => {
    const btn = $('#run-all') as HTMLButtonElement
    btn.disabled = true
    for (const ex of examples) {
      const section = document.getElementById(ex.id)!
      const editor = section.querySelector('textarea') as HTMLTextAreaElement
      const out = section.querySelector('.out') as HTMLElement
      await run(editor.value, out)
    }
    btn.disabled = false
  })

  $('#reset-db').addEventListener('click', async () => {
    liveStops.splice(0).forEach((stop) => stop())
    lives.clear()
    liveRows.clear()
    events.length = 0
    delete S.db
    delete S.posts
    delete S.users
    for (const ex of examples) {
      const out = document.getElementById(ex.id)!.querySelector('.out') as HTMLElement
      out.textContent = 'Not run yet.'
      out.classList.remove('error')
    }
    renderPanels()
  })

  renderPanels()
  // Expose the library for the browser console, so a reader can poke at it.
  ;(window as unknown as Record<string, unknown>).xdb = xdb
  ;(window as unknown as Record<string, unknown>).z = z
  ;(window as unknown as Record<string, unknown>).S = S
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
else mount()
