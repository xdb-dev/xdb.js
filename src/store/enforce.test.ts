import { describe, expect, it } from 'vitest'
import { isXDBError } from '../core/errors.js'
import type { Def, Mutation, Tuple } from '../core/types.js'
import { enforce } from './enforce.js'

function t(path: string, attr: string, value: Tuple['value']): Tuple {
  return { path, attr, value }
}

const strictDef: Def = {
  ns: 'app',
  schema: 'posts',
  mode: 'strict',
  fields: {
    title: { type: 'string', required: true },
    views: { type: 'integer' },
  },
}

const flexibleDef: Def = { ...strictDef, mode: 'flexible' }
const dynamicDef: Def = { ...strictDef, mode: 'dynamic' }

describe('enforce: declared fields, every mode', () => {
  it('type-checks a declared field in strict mode', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 42)] }
    expect(() => enforce(m, strictDef, false)).toThrow()
  })

  it('type-checks a declared field in flexible mode', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 42)] }
    expect(() => enforce(m, flexibleDef, false)).toThrow()
  })

  it('type-checks a declared field in dynamic mode', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 42)] }
    expect(() => enforce(m, dynamicDef, false)).toThrow()
  })

  it('passes a matching declared field through, coerced', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 'Hello')] }
    const { mutation } = enforce(m, strictDef, false)
    expect(mutation.tuples![0]!.value).toBe('Hello')
    expect(mutation.tuples![0]!.type).toBe('string')
  })

  it('coerces a numeric string for an integer field', () => {
    const m: Mutation = {
      path: 'app/posts/p1',
      op: 'patch',
      tuples: [t('app/posts/p1', 'title', 'x'), t('app/posts/p1', 'views', '7')],
    }
    const { mutation } = enforce(m, strictDef, true)
    expect(mutation.tuples!.find((x) => x.attr === 'views')?.value).toBe(7)
  })
})

describe('enforce: undeclared attributes, by mode', () => {
  const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 'x'), t('app/posts/p1', 'extra', 'y')] }

  it('rejects an undeclared attribute in strict mode', () => {
    let threw = false
    try {
      enforce(m, strictDef, false)
    } catch (e) {
      threw = true
      expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
    }
    expect(threw).toBe(true)
  })

  it('accepts an undeclared attribute as-is in flexible mode', () => {
    const { mutation, def } = enforce(m, flexibleDef, false)
    expect(mutation.tuples!.find((x) => x.attr === 'extra')?.value).toBe('y')
    expect(def).toBeUndefined()
  })

  it('infers and evolves the definition for an undeclared attribute in dynamic mode', () => {
    const { mutation, def } = enforce(m, dynamicDef, false)
    expect(mutation.tuples!.find((x) => x.attr === 'extra')?.value).toBe('y')
    expect(def).toBeDefined()
    expect(def!.fields.extra).toEqual({ type: 'string' })
    // the original fields are preserved
    expect(def!.fields.title).toEqual(dynamicDef.fields.title)
  })

  it('infers an array element type in dynamic mode', () => {
    const withArray: Mutation = {
      path: 'app/posts/p1',
      op: 'create',
      tuples: [t('app/posts/p1', 'title', 'x'), t('app/posts/p1', 'tags', ['a', 'b'])],
    }
    const { def } = enforce(withArray, dynamicDef, false)
    expect(def!.fields.tags).toEqual({ type: 'array', items: 'string' })
  })

  it('does not evolve the definition from a null value in dynamic mode', () => {
    const withNull: Mutation = {
      path: 'app/posts/p1',
      op: 'create',
      tuples: [t('app/posts/p1', 'title', 'x'), t('app/posts/p1', 'extra', null)],
    }
    const { def } = enforce(withNull, dynamicDef, false)
    expect(def).toBeUndefined()
  })
})

describe('enforce: required fields', () => {
  it('throws on a missing required field on create', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [] }
    expect(() => enforce(m, strictDef, false)).toThrow()
  })

  it('throws on a missing required field on put', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'put', tuples: [] }
    expect(() => enforce(m, strictDef, true)).toThrow()
  })

  it('throws on a missing required field on a patch that creates the record', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'patch', tuples: [t('app/posts/p1', 'views', 1)] }
    expect(() => enforce(m, strictDef, false)).toThrow()
  })

  it('does not require the field on a patch to an existing record', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'patch', tuples: [t('app/posts/p1', 'views', 1)] }
    expect(() => enforce(m, strictDef, true)).not.toThrow()
  })

  it('passes when the required field is present on create', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'title', 'x')] }
    expect(() => enforce(m, strictDef, false)).not.toThrow()
  })
})

describe('enforce: delete', () => {
  it('throws SCHEMA_VIOLATION deleting a required attribute', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'delete', attrs: ['title'] }
    let threw = false
    try {
      enforce(m, strictDef, true)
    } catch (e) {
      threw = true
      expect(isXDBError(e, 'SCHEMA_VIOLATION')).toBe(true)
    }
    expect(threw).toBe(true)
  })

  it('allows deleting a non-required attribute', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'delete', attrs: ['views'] }
    expect(() => enforce(m, strictDef, true)).not.toThrow()
  })

  it('allows a whole-record delete even when the schema has required fields', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'delete' }
    expect(() => enforce(m, strictDef, true)).not.toThrow()
  })
})

describe('enforce: no schema', () => {
  it('passes a mutation through unchanged when def is null', () => {
    const m: Mutation = { path: 'app/posts/p1', op: 'create', tuples: [t('app/posts/p1', 'anything', 42)] }
    const { mutation, def } = enforce(m, null, false)
    expect(mutation).toBe(m)
    expect(def).toBeUndefined()
  })
})
