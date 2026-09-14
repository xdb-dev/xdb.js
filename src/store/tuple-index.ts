import type { Tuple } from '../core/types.js'
import { valueKey } from '../core/value.js'


export { valueKey }

/** The `ns/schema` prefix of a record path. */
function schemaOf(path: string): string {
  const parts = path.split('/')
  return `${parts[0]}/${parts[1]}`
}

/** The `ns/schema|attr` key of the schema-attribute index. */
function attrKey(path: string, attr: string): string {
  return `${schemaOf(path)}|${attr}`
}

/**
 * The in-memory tuple index. It keeps every tuple in three maps: by record
 * path, by schema and attribute, and by value key. Every mutating method
 * keeps all three maps consistent.
 */
export class TupleIndex {
  private readonly byPath = new Map<string, Map<string, Tuple>>()
  private readonly byAttr = new Map<string, Set<Tuple>>()
  private readonly byVal = new Map<string, Set<Tuple>>()
  private count = 0

  /** Adds or replaces the tuple at (path, attr). */
  add(t: Tuple): void {
    this.remove(t.path, t.attr)
    let attrs = this.byPath.get(t.path)
    if (!attrs) {
      attrs = new Map()
      this.byPath.set(t.path, attrs)
    }
    attrs.set(t.attr, t)

    const ak = attrKey(t.path, t.attr)
    let aset = this.byAttr.get(ak)
    if (!aset) {
      aset = new Set()
      this.byAttr.set(ak, aset)
    }
    aset.add(t)

    const vk = valueKey(t.value)
    let vset = this.byVal.get(vk)
    if (!vset) {
      vset = new Set()
      this.byVal.set(vk, vset)
    }
    vset.add(t)

    this.count++
  }

  /** Removes one tuple. Removes the record when it holds no more tuples. */
  remove(path: string, attr: string): void {
    const attrs = this.byPath.get(path)
    if (!attrs) return
    const t = attrs.get(attr)
    if (!t) return
    attrs.delete(attr)
    if (attrs.size === 0) this.byPath.delete(path)
    this.byAttr.get(attrKey(path, attr))?.delete(t)
    this.byVal.get(valueKey(t.value))?.delete(t)
    this.count--
  }

  /** Removes every tuple at a path. Returns the tuples it removed. */
  removePath(path: string): Tuple[] {
    const attrs = this.byPath.get(path)
    if (!attrs) return []
    const removed = [...attrs.values()]
    for (const attr of [...attrs.keys()]) this.remove(path, attr)
    return removed
  }

  /** Reads one tuple, or undefined when it is absent. */
  get(path: string, attr: string): Tuple | undefined {
    return this.byPath.get(path)?.get(attr)
  }

  /** The live attribute map of a record, or undefined. Do not mutate it. */
  attrs(path: string): ReadonlyMap<string, Tuple> | undefined {
    return this.byPath.get(path)
  }

  /** True when the record holds at least one tuple. */
  has(path: string): boolean {
    return this.byPath.has(path)
  }

  /** Tuples of one schema and attribute. `schema` is `ns/schema`. */
  *bySchemaAttr(schema: string, attr: string): Iterable<Tuple> {
    yield* this.byAttr.get(`${schema}|${attr}`) ?? []
  }

  /** Tuples whose value equals `v`. */
  *byValue(v: unknown): Iterable<Tuple> {
    yield* this.byVal.get(valueKey(v)) ?? []
  }

  /** Tuples of one schema, grouped by record, contiguous per record. */
  *bySchema(schema: string): Iterable<Tuple> {
    for (const [path, attrs] of this.byPath) {
      if (schemaOf(path) === schema) yield* attrs.values()
    }
  }

  /** Every tuple under a scope: `ns`, `ns/schema`, or `ns/schema/id`. */
  *scan(scope: string): Iterable<Tuple> {
    for (const [path, attrs] of this.byPath) {
      if (path === scope || path.startsWith(`${scope}/`)) yield* attrs.values()
    }
  }

  /** Every tuple in the index. */
  *all(): Iterable<Tuple> {
    for (const attrs of this.byPath.values()) yield* attrs.values()
  }

  /** The record paths of one schema. */
  *paths(schema: string): Iterable<string> {
    for (const path of this.byPath.keys()) {
      if (schemaOf(path) === schema) yield path
    }
  }

  /** The number of tuples. */
  get size(): number {
    return this.count
  }

  /** A shallow copy. Used for transaction rollback. */
  clone(): TupleIndex {
    const copy = new TupleIndex()
    for (const [path, attrs] of this.byPath) {
      copy.byPath.set(path, new Map(attrs))
    }
    for (const [k, set] of this.byAttr) {
      copy.byAttr.set(k, new Set(set))
    }
    for (const [k, set] of this.byVal) {
      copy.byVal.set(k, new Set(set))
    }
    copy.count = this.count
    return copy
  }
}
