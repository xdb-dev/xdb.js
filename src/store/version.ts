/**
 * The record versioning contract: `_id`, `_version`, and `_updated` on every
 * write, and the `_version` optimistic-concurrency precondition. Matches the
 * Go store's versioning middleware.
 */
import { conflict } from '../core/errors.js'
import type { Mutation, Tuple } from '../core/types.js'
import { idOf } from '../core/uri.js'
import type { TupleIndex } from './tuple-index.js'

/** Reads the `_version` of a record from the index. `0` when the record is absent or has no `_version` tuple. */
export function currentVersion(index: TupleIndex, path: string): number {
  const t = index.get(path, '_version')
  if (!t) return 0
  return typeof t.value === 'bigint' ? Number(t.value) : (t.value as number)
}

/**
 * Checks the `_version` precondition and returns the system tuples to add
 * for this write: `_id`, `_version`, and `_updated`.
 *
 * Throws `CONFLICT` when `m.version` is set and does not match the record's
 * current version. An absent or `0` version writes unconditionally. The new
 * `_version` is the current version plus one, so it is `1` for a record that
 * does not yet exist.
 *
 * Returns `[]` for a whole-record delete: a removed record carries no
 * tuples, system or otherwise.
 */
export function stampVersion(index: TupleIndex, m: Mutation, now: Date = new Date()): Tuple[] {
  const current = currentVersion(index, m.path)
  if (m.version !== undefined && m.version !== 0 && m.version !== current) {
    throw conflict(`version ${m.version} does not match the current version ${current} of ${m.path}`, {
      uri: m.path,
    })
  }

  const wholeRecordDelete = m.op === 'delete' && (!m.attrs || m.attrs.length === 0)
  if (wholeRecordDelete) return []

  const nextVersion = current + 1
  return [
    { path: m.path, attr: '_id', value: idOf(m.path), type: 'string' },
    { path: m.path, attr: '_version', value: nextVersion, type: 'integer' },
    { path: m.path, attr: '_updated', value: now, type: 'time' },
  ]
}
