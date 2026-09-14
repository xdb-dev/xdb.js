import { describe, expect, it } from 'vitest'
import type { Tuple } from '../core/types.js'
import { groupByPath, mergeTuples, normalizeMutation, removeAttrs } from './mutation.js'

function t(path: string, attr: string, value: Tuple['value']): Tuple {
  return { path, attr, value }
}

describe('mergeTuples', () => {
  it('keeps a current attribute untouched by the patch', () => {
    const current = [t('p', 'a', 1), t('p', 'b', 2)]
    const out = mergeTuples(current, [t('p', 'b', 20)])
    expect(out.find((x) => x.attr === 'a')?.value).toBe(1)
  })

  it('replaces a current attribute the patch names', () => {
    const current = [t('p', 'a', 1), t('p', 'b', 2)]
    const out = mergeTuples(current, [t('p', 'b', 20)])
    expect(out.find((x) => x.attr === 'b')?.value).toBe(20)
  })

  it('appends a patch attribute not present in current', () => {
    const current = [t('p', 'a', 1)]
    const out = mergeTuples(current, [t('p', 'c', 3)])
    expect(out.map((x) => x.attr).sort()).toEqual(['a', 'c'])
  })

  it('has exactly one tuple per attribute', () => {
    const current = [t('p', 'a', 1)]
    const out = mergeTuples(current, [t('p', 'a', 2), t('p', 'a', 3)])
    expect(out).toHaveLength(1)
    expect(out[0]!.value).toBe(3)
  })
})

describe('removeAttrs', () => {
  it('removes only the named attributes', () => {
    const current = [t('p', 'a', 1), t('p', 'b', 2), t('p', 'c', 3)]
    const out = removeAttrs(current, ['b'])
    expect(out.map((x) => x.attr).sort()).toEqual(['a', 'c'])
  })

  it('removes everything when attrs is empty', () => {
    const current = [t('p', 'a', 1), t('p', 'b', 2)]
    expect(removeAttrs(current, [])).toEqual([])
  })

  it('ignores a named attribute that is not present', () => {
    const current = [t('p', 'a', 1)]
    expect(removeAttrs(current, ['missing'])).toEqual(current)
  })
})

describe('groupByPath', () => {
  it('groups tuples by record path, in first-seen order', () => {
    const tuples = [t('p2', 'x', 1), t('p1', 'y', 2), t('p2', 'z', 3), t('p1', 'w', 4)]
    const groups = groupByPath(tuples)
    expect([...groups.keys()]).toEqual(['p2', 'p1'])
    expect(groups.get('p1')!.map((x) => x.attr)).toEqual(['y', 'w'])
    expect(groups.get('p2')!.map((x) => x.attr)).toEqual(['x', 'z'])
  })

  it('returns an empty map for an empty list', () => {
    expect(groupByPath([]).size).toBe(0)
  })
})

describe('normalizeMutation', () => {
  it('fills tuples and attrs with [] when absent', () => {
    const m = normalizeMutation({ path: 'ns/sch/id', op: 'create' })
    expect(m.tuples).toEqual([])
    expect(m.attrs).toEqual([])
  })

  it('passes through given tuples and attrs unchanged', () => {
    const tuples = [t('ns/sch/id', 'a', 1)]
    const m = normalizeMutation({ path: 'ns/sch/id', op: 'patch', tuples, attrs: ['a'] })
    expect(m.tuples).toBe(tuples)
    expect(m.attrs).toEqual(['a'])
  })

  it('preserves path, op, and version', () => {
    const m = normalizeMutation({ path: 'ns/sch/id', op: 'put', version: 3 })
    expect(m.path).toBe('ns/sch/id')
    expect(m.op).toBe('put')
    expect(m.version).toBe(3)
  })
})
