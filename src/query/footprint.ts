import type { ChangeKey } from '../core/types.js'

/**
 * The set of schema and attribute pairs that a query read. A live query
 * records its footprint while it runs, then the change bus compares the
 * footprint against a commit's change keys to decide whether to rerun.
 */
export class Footprint {
  private readonly _keys = new Set<ChangeKey>()

  /**
   * Records a read of `attr` on `schema`. `null` in either position is a
   * wildcard: a null `schema` matches every schema, and a null `attr`
   * matches every attribute.
   */
  add(schema: string | null, attr: string | null): void {
    this._keys.add(`${schema ?? '*'}|${attr ?? '*'}`)
  }

  /** The raw `schema|attr` keys this footprint recorded. */
  keys(): ReadonlySet<ChangeKey> {
    return this._keys
  }

  /**
   * True when any change key overlaps this footprint. A footprint entry of
   * `app/posts|*` matches every change in `app/posts`. An entry of `*|title`
   * matches a `title` change in any schema. An entry of `*|*` matches every
   * change.
   */
  overlaps(changes: Iterable<ChangeKey>): boolean {
    for (const c of changes) {
      const sep = c.indexOf('|')
      const schema = sep >= 0 ? c.slice(0, sep) : c
      const attr = sep >= 0 ? c.slice(sep + 1) : '*'
      if (
        this._keys.has(c) ||
        this._keys.has('*|*') ||
        this._keys.has(`${schema}|*`) ||
        this._keys.has(`*|${attr}`)
      ) {
        return true
      }
    }
    return false
  }

  /** The number of distinct keys recorded. */
  get size(): number {
    return this._keys.size
  }
}

/** The change key of one written attribute: `ns/schema|attr`. */
export function changeKey(path: string, attr: string): ChangeKey {
  const parts = path.split('/')
  return `${parts[0]}/${parts[1]}|${attr}`
}
