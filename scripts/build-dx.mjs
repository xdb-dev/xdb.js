// Bundles the library and the demo into one self-contained page, so dx.html
// opens from the file system with no server and no network.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['demo/dx-entry.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  write: false,
  minify: true,
  legalComments: 'none',
})

const code = result.outputFiles[0].text
const template = await readFile('demo/template.html', 'utf8')
const html = template.replace('/*BUNDLE*/', () => code)
await writeFile('dx.html', html)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`dx.html written: ${kb(html.length)} total, ${kb(code.length)} of script`)
