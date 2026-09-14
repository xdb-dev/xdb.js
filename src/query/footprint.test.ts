import { describe, expect, it } from 'vitest'
import { Footprint, changeKey } from './footprint.js'

describe('changeKey', () => {
  it('builds a schema|attr key from a record path', () => {
    expect(changeKey('app/posts/p-1', 'title')).toBe('app/posts|title')
  })
})

describe('Footprint', () => {
  it('records an exact schema and attribute, and matches only that change', () => {
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    expect(fp.keys()).toEqual(new Set(['app/posts|title']))
    expect(fp.overlaps(['app/posts|title'])).toBe(true)
    expect(fp.overlaps(['app/posts|views'])).toBe(false)
    expect(fp.overlaps(['app/users|title'])).toBe(false)
  })

  it('a schema wildcard (app/posts|*) matches every change in that schema', () => {
    const fp = new Footprint()
    fp.add('app/posts', null)
    expect(fp.keys()).toEqual(new Set(['app/posts|*']))
    expect(fp.overlaps(['app/posts|title'])).toBe(true)
    expect(fp.overlaps(['app/posts|views'])).toBe(true)
    expect(fp.overlaps(['app/users|title'])).toBe(false)
  })

  it('an attr wildcard (*|title) matches a title change in any schema', () => {
    const fp = new Footprint()
    fp.add(null, 'title')
    expect(fp.keys()).toEqual(new Set(['*|title']))
    expect(fp.overlaps(['app/posts|title'])).toBe(true)
    expect(fp.overlaps(['app/users|title'])).toBe(true)
    expect(fp.overlaps(['app/posts|views'])).toBe(false)
  })

  it('a full wildcard (*|*) matches every change', () => {
    const fp = new Footprint()
    fp.add(null, null)
    expect(fp.keys()).toEqual(new Set(['*|*']))
    expect(fp.overlaps(['app/posts|title'])).toBe(true)
    expect(fp.overlaps(['anything/at-all|whatsoever'])).toBe(true)
  })

  it('overlaps is true when any one of several change keys hits', () => {
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    expect(fp.overlaps(['app/users|name', 'app/posts|title'])).toBe(true)
  })

  it('overlaps is false for an empty footprint', () => {
    const fp = new Footprint()
    expect(fp.overlaps(['app/posts|title'])).toBe(false)
  })

  it('size counts distinct recorded keys', () => {
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    fp.add('app/posts', 'title')
    fp.add('app/posts', 'views')
    expect(fp.size).toBe(2)
  })
})
