import { describe, expect, it } from 'vitest'
import { diffItems } from './diff.js'

const PATH = 'app/posts/p-1'

describe('diffItems', () => {
  it('reports a changed scalar attribute and leaves the unchanged ones out', () => {
    const before = { id: 'p-1', title: 'Hello', views: 0 }
    const after = { id: 'p-1', title: 'Hello', views: 1 }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([{ path: PATH, attr: 'views', value: 1 }])
    expect(attrs).toEqual([])
  })

  it('reports an added attribute as a tuple', () => {
    const before = { id: 'p-1', title: 'Hello' }
    const after = { id: 'p-1', title: 'Hello', views: 0 }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([{ path: PATH, attr: 'views', value: 0 }])
    expect(attrs).toEqual([])
  })

  it('reports a removed attribute by name, not as a tuple', () => {
    const before = { id: 'p-1', title: 'Hello', views: 0 }
    const after = { id: 'p-1', title: 'Hello' }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([])
    expect(attrs).toEqual(['views'])
  })

  it('reports a nested object change as a dotted attribute', () => {
    const before = { id: 'p-1', author: { name: 'Ravi', age: 30 } }
    const after = { id: 'p-1', author: { name: 'Ravi', age: 31 } }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([{ path: PATH, attr: 'author.age', value: 31 }])
    expect(attrs).toEqual([])
  })

  it('reports a removed nested leaf as a dotted attribute name', () => {
    const before = { id: 'p-1', author: { name: 'Ravi', age: 30 } }
    const after = { id: 'p-1', author: { name: 'Ravi' } }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([])
    expect(attrs).toEqual(['author.age'])
  })

  it('reports an array change as one tuple for the whole array', () => {
    const before = { id: 'p-1', tags: ['news'] }
    const after = { id: 'p-1', tags: ['news', 'sports'] }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([{ path: PATH, attr: 'tags', value: ['news', 'sports'] }])
    expect(attrs).toEqual([])
  })

  it('does not report an unchanged array as changed', () => {
    const before = { id: 'p-1', tags: ['news', 'sports'] }
    const after = { id: 'p-1', tags: ['news', 'sports'] }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([])
    expect(attrs).toEqual([])
  })

  it('reports nothing for two identical items', () => {
    const before = { id: 'p-1', title: 'Hello', views: 0, tags: ['a'] }
    const after = { id: 'p-1', title: 'Hello', views: 0, tags: ['a'] }
    const { tuples, attrs } = diffItems(before, after, PATH)
    expect(tuples).toEqual([])
    expect(attrs).toEqual([])
  })
})
