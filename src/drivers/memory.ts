/**
 * The in-memory driver. Storage is a {@link TupleIndex} plus a `Map` of
 * definitions; nothing outlives the process. `apply` follows the four-op
 * table exactly: `create` rejects an existing path, `put` replaces the full
 * tuple set, `patch` overlays it, and `delete` removes named attributes or
 * the whole record. `tx` is a clone-and-restore snapshot.
 */
import { alreadyExists } from '../core/errors.js'
import type { Def, Driver, Mutation, Tuple } from '../core/types.js'
import { parseURI } from '../core/uri.js'
import { TupleIndex } from '../store/tuple-index.js'

/** Strips the `xdb://` scheme from a scope, so a caller can pass either form. */
function bareScope(scope: string): string {
  return scope.startsWith('xdb://') ? scope.slice('xdb://'.length) : scope
}

/** Creates an in-memory {@link Driver}. Every call returns an independent store. */
export function memory(): Driver {
  let index = new TupleIndex()
  let defs = new Map<string, Def>()

  const driver: Driver = {
    async getTuples(uris: string[]): Promise<Tuple[]> {
      const out: Tuple[] = []
      for (const uri of uris) {
        const u = parseURI(uri)
        if (!u.schema || !u.id || !u.attr) continue
        const t = index.get(`${u.ns}/${u.schema}/${u.id}`, u.attr)
        if (t) out.push(t)
      }
      return out
    },

    async *scanTuples(scope: string): AsyncIterable<Tuple> {
      yield* index.scan(bareScope(scope))
    },

    async apply(m: Mutation): Promise<void> {
      const exists = index.has(m.path)
      switch (m.op) {
        case 'create': {
          if (exists) throw alreadyExists(`a record already exists at ${m.path}`, { uri: m.path })
          for (const t of m.tuples ?? []) index.add(t)
          return
        }
        case 'put': {
          index.removePath(m.path)
          for (const t of m.tuples ?? []) index.add(t)
          return
        }
        case 'patch': {
          for (const t of m.tuples ?? []) index.add(t)
          return
        }
        case 'delete': {
          if (!m.attrs || m.attrs.length === 0) {
            index.removePath(m.path)
            return
          }
          for (const a of m.attrs) index.remove(m.path, a)
          return
        }
      }
    },

    async getSchema(path: string): Promise<Def | null> {
      return defs.get(path) ?? null
    },

    async *scanSchemas(scope: string): AsyncIterable<Def> {
      const bare = bareScope(scope)
      for (const [path, def] of defs) {
        if (path === bare || path.startsWith(`${bare}/`)) yield def
      }
    },

    async createSchema(def: Def): Promise<void> {
      const path = `${def.ns}/${def.schema}`
      if (defs.has(path)) throw alreadyExists(`a schema already exists at ${path}`, { uri: path })
      defs.set(path, def)
    },

    async putSchema(def: Def): Promise<void> {
      defs.set(`${def.ns}/${def.schema}`, def)
    },

    async deleteSchema(path: string): Promise<void> {
      defs.delete(path)
    },

    async dropRecords(path: string): Promise<void> {
      const paths = new Set<string>()
      for (const t of index.scan(bareScope(path))) paths.add(t.path)
      for (const p of paths) index.removePath(p)
    },

    async tx(fn: (t: Driver) => Promise<void>): Promise<void> {
      const savedIndex = index.clone()
      const savedDefs = new Map(defs)
      try {
        await fn(driver)
      } catch (err) {
        index = savedIndex
        defs = savedDefs
        throw err
      }
    },
  }

  return driver
}
