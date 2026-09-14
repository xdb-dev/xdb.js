// Loads dx.html in jsdom, runs every example, and fails when any output pane
// reports an error or when the panels stay empty.
import { readFile } from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'

const html = await readFile('dx.html', 'utf8')

// A rejection that escapes the page would otherwise make node print the whole
// bundle. Record it against whichever example is running.
const escaped = []
let current = '(page load)'
const brief = (e) => {
  const code = e && e.code ? `${e.code}: ` : ''
  const uri = e && e.uri ? ` [${e.uri}]` : ''
  return `${current}: ${code}${(e && e.message) || String(e)}${uri}`
}
process.on('uncaughtException', (e) => escaped.push(brief(e)))
process.on('unhandledRejection', (e) => escaped.push(brief(e)))

// jsdom prints the whole bundle on an uncaught error, so keep its console
// short and report only the message.
const virtualConsole = new VirtualConsole()
const pageErrors = []
virtualConsole.on('jsdomError', (err) => pageErrors.push(err.message.split('\n')[0]))
virtualConsole.on('error', (...args) => pageErrors.push(args.map(String).join(' ').slice(0, 200)))

const dom = new JSDOM(html, {
  virtualConsole,
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://xdb.test/dx.html',
})
const { window } = dom
// jsdom omits a few globals the library uses.
window.structuredClone ??= structuredClone
window.queueMicrotask ??= queueMicrotask

await new Promise((resolve) => {
  if (window.document.readyState === 'complete') resolve()
  else window.addEventListener('load', resolve)
})

const cards = [...window.document.querySelectorAll('.card')]
if (cards.length === 0) throw new Error('no example cards rendered')

const failures = []
for (const card of cards) {
  current = card.id
  const button = card.querySelector('button.run')
  button.click()
  // Let the async run settle: the handler awaits, so drain the microtask and
  // timer queues a few times.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))

  const out = card.querySelector('.out')
  const text = out.textContent.trim()
  const label = `${card.id}`
  if (out.classList.contains('error')) failures.push(`${label}: reported an error\n${indent(text)}`)
  else if (text === '' || text === 'Not run yet.') failures.push(`${label}: produced no output`)
  else console.log(`ok   ${label}\n${indent(text.split('\n').slice(0, 3).join('\n'))}`)
}

const tupleCount = Number(window.document.querySelector('#tuple-count').textContent)
const eventCount = Number(window.document.querySelector('#event-count').textContent)
const liveRows = window.document.querySelectorAll('.live').length
const tocLinks = window.document.querySelectorAll('#toc a').length

if (!(tupleCount > 20)) failures.push(`the tuple panel shows ${tupleCount} tuples, expected more than 20`)
if (!(eventCount > 5)) failures.push(`the event panel shows ${eventCount} events, expected more than 5`)
if (liveRows < 1) failures.push('the live-query panel has no query')
if (tocLinks !== cards.length) failures.push(`the contents list has ${tocLinks} links for ${cards.length} cards`)

// The reset button must clear the state.
window.document.querySelector('#reset-db').click()
for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
if (Number(window.document.querySelector('#tuple-count').textContent) !== 0) {
  failures.push('reset left tuples behind')
}

function indent(s) {
  return s
    .split('\n')
    .map((l) => '     ' + l)
    .join('\n')
}

if (escaped.length) failures.push(`rejections escaped the page:\n${indent([...new Set(escaped)].join('\n'))}`)
if (pageErrors.length) failures.push(`the page logged errors:\n${indent(pageErrors.slice(0, 5).join('\n'))}`)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.length} problem(s)\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log(`PASS: ${cards.length} examples ran, ${tupleCount} tuples, ${eventCount} events, ${liveRows} live query`)
