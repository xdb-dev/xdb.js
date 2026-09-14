import { invalidURI } from './errors.js'
import type { URI } from './types.js'

const SCHEME = 'xdb://'

/** True when `c` is a valid component: no '/', '#', whitespace, and not empty. */
function validComponent(kind: string, raw: string): string {
  if (raw === '') throw invalidURI(`the ${kind} is empty`)
  if (/[\s#]/.test(raw) || raw.includes('/')) {
    throw invalidURI(`the ${kind} "${raw}" has an invalid character`)
  }
  return raw
}

/**
 * Parses `xdb://ns/schema/id#attr`. The scheme is optional, so a bare path
 * such as `app/posts/p-1` parses too. Depth decides which parts are present.
 */
export function parseURI(input: string): URI {
  if (typeof input !== 'string' || input === '') throw invalidURI('the URI is empty')
  let rest = input.startsWith(SCHEME) ? input.slice(SCHEME.length) : input
  let attr: string | undefined
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    attr = rest.slice(hash + 1)
    rest = rest.slice(0, hash)
    if (attr === '') throw invalidURI('the attribute is empty')
    if (/[\s#]/.test(attr) || attr.includes('/')) {
      throw invalidURI(`the attribute "${attr}" has an invalid character`)
    }
  }
  if (rest.endsWith('/')) throw invalidURI(`the URI "${input}" ends with a slash`)
  const parts = rest.split('/')
  if (parts.length > 3) throw invalidURI(`the URI "${input}" has too many path parts`)
  const uri: URI = { ns: validComponent('namespace', parts[0]) }
  if (parts.length > 1) uri.schema = validComponent('schema', parts[1])
  if (parts.length > 2) uri.id = validComponent('id', parts[2])
  if (attr !== undefined) {
    if (uri.id === undefined) throw invalidURI('an attribute needs a record path')
    uri.attr = attr
  }
  return uri
}

/** Formats a URI with the `xdb://` scheme. */
export function formatURI(uri: URI): string {
  let out = SCHEME + uri.ns
  if (uri.schema) out += '/' + uri.schema
  if (uri.id) out += '/' + uri.id
  if (uri.attr) out += '#' + uri.attr
  return out
}

/** The number of path parts: 1 = namespace, 2 = schema, 3 = record. */
export function depth(uri: URI): 1 | 2 | 3 {
  return uri.id ? 3 : uri.schema ? 2 : 1
}

/** The record path `ns/schema/id`, without the scheme and the attribute. */
export function recordPath(uri: URI | string): string {
  const u = typeof uri === 'string' ? parseURI(uri) : uri
  if (!u.schema || !u.id) throw invalidURI('not a record URI')
  return `${u.ns}/${u.schema}/${u.id}`
}

/** The schema path `ns/schema` of a record path or URI. */
export function schemaPath(pathOrURI: string): string {
  const parts = pathOrURI.replace(SCHEME, '').split('#')[0].split('/')
  if (parts.length < 2) throw invalidURI(`"${pathOrURI}" has no schema`)
  return `${parts[0]}/${parts[1]}`
}

/** The id part of a record path. */
export function idOf(path: string): string {
  const parts = path.replace(SCHEME, '').split('#')[0].split('/')
  if (parts.length < 3) throw invalidURI(`"${path}" has no id`)
  return parts[2]
}

/** Splits a record path into ns, schema, and id. */
export function splitPath(path: string): { ns: string; schema: string; id: string } {
  const parts = path.replace(SCHEME, '').split('#')[0].split('/')
  if (parts.length !== 3) throw invalidURI(`"${path}" is not a record path`)
  return { ns: parts[0], schema: parts[1], id: parts[2] }
}

/**
 * True when a record path is inside a scope. The scope is `ns`, `ns/schema`,
 * or a full record path.
 */
export function inScope(scope: string, path: string): boolean {
  if (scope === path) return true
  return path.startsWith(scope + '/')
}

/** Builds the attribute URI `xdb://ns/schema/id#attr`. */
export function tupleURI(path: string, attr: string): string {
  return `${SCHEME}${path}#${attr}`
}
