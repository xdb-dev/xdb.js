import { describe, expect, it } from 'vitest'
import { isXDBError } from '../core/errors.js'
import type { Tuple } from '../core/types.js'
import { TupleIndex } from './tuple-index.js'
import { currentVersion, stampVersion } from './version.js'

function seedVersion(index: TupleIndex, path: string, version: number): void {
  index.add({ path, attr: '_version', value: version })
}

describe('currentVersion', () => {
  it('is 0 for an absent record', () => {
    expect(currentVersion(new TupleIndex(), 'ns/sch/missing')).toBe(0)
  })

  it('reads the stored _version tuple', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 5)
    expect(currentVersion(index, 'ns/sch/p1')).toBe(5)
  })
})

describe('stampVersion', () => {
  const now = new Date('2024-01-01T00:00:00.000Z')

  it('stamps _version 1 for a record that does not exist yet', () => {
    const index = new TupleIndex()
    const tuples = stampVersion(index, { path: 'ns/sch/p1', op: 'create' }, now)
    const byAttr = new Map(tuples.map((t) => [t.attr, t.value]))
    expect(byAttr.get('_version')).toBe(1)
    expect(byAttr.get('_id')).toBe('p1')
    expect(byAttr.get('_updated')).toBe(now)
  })

  it('stamps _version current+1 for an existing record', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    const tuples = stampVersion(index, { path: 'ns/sch/p1', op: 'put' }, now)
    expect(tuples.find((t) => t.attr === '_version')?.value).toBe(5)
  })

  it('writes unconditionally when version is absent', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    expect(() => stampVersion(index, { path: 'ns/sch/p1', op: 'put' }, now)).not.toThrow()
  })

  it('writes unconditionally when version is 0', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    expect(() => stampVersion(index, { path: 'ns/sch/p1', op: 'put', version: 0 }, now)).not.toThrow()
  })

  it('throws CONFLICT when the supplied version does not match, and adds nothing to the index', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    let threw = false
    try {
      stampVersion(index, { path: 'ns/sch/p1', op: 'put', version: 3 }, now)
    } catch (e) {
      threw = true
      expect(isXDBError(e, 'CONFLICT')).toBe(true)
    }
    expect(threw).toBe(true)
    expect(currentVersion(index, 'ns/sch/p1')).toBe(4)
  })

  it('succeeds when the supplied version matches the current one', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    const tuples = stampVersion(index, { path: 'ns/sch/p1', op: 'put', version: 4 }, now)
    expect(tuples.find((t) => t.attr === '_version')?.value).toBe(5)
  })

  it('returns no tuples for a whole-record delete', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    const tuples = stampVersion(index, { path: 'ns/sch/p1', op: 'delete' }, now)
    expect(tuples).toEqual([])
  })

  it('returns system tuples for a partial delete (attrs given)', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    const tuples = stampVersion(index, { path: 'ns/sch/p1', op: 'delete', attrs: ['a'] }, now)
    expect(tuples.find((t) => t.attr === '_version')?.value).toBe(5)
  })

  it('still checks the version precondition on a whole-record delete', () => {
    const index = new TupleIndex()
    seedVersion(index, 'ns/sch/p1', 4)
    expect(() => stampVersion(index, { path: 'ns/sch/p1', op: 'delete', version: 1 }, now)).toThrow()
  })
})
