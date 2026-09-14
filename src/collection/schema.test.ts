import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isXDBError } from '../core/errors.js'
import { defFromSchema, parseItem } from './schema.js'

describe('defFromSchema', () => {
  it('covers every row of the section 9 mapping table', () => {
    const Post = z.object({
      id: z.string(),
      title: z.string(),
      views: z.number().int(),
      rating: z.number().int().nonnegative(),
      score: z.number(),
      active: z.boolean(),
      createdAt: z.date(),
      author: z.object({ name: z.string(), age: z.number().int() }),
      meta: z.record(z.string(), z.unknown()),
      raw: z.any(),
      avatar: z.instanceof(Uint8Array),
      tags: z.array(z.string()),
      nickname: z.optional(z.string()),
      role: z.enum(['admin', 'member']),
    })

    const def = defFromSchema('xdb://app/posts', Post)

    expect(def.ns).toBe('app')
    expect(def.schema).toBe('posts')
    expect(def.mode).toBe('strict')
    expect(def.fields.id).toBeUndefined() // the id lives in the path, not as a stored attribute

    expect(def.fields.title).toEqual({ type: 'string', required: true })
    expect(def.fields.views).toEqual({ type: 'integer', required: true })
    expect(def.fields.rating).toEqual({ type: 'unsigned', required: true })
    expect(def.fields.score).toEqual({ type: 'float', required: true })
    expect(def.fields.active).toEqual({ type: 'boolean', required: true })
    expect(def.fields.createdAt).toEqual({ type: 'time', required: true })
    expect(def.fields['author.name']).toEqual({ type: 'string', required: true })
    expect(def.fields['author.age']).toEqual({ type: 'integer', required: true })
    expect(def.fields.meta).toEqual({ type: 'json', required: true })
    expect(def.fields.raw).toEqual({ type: 'json', required: true })
    expect(def.fields.avatar).toEqual({ type: 'bytes', required: true })
    expect(def.fields.tags).toEqual({ type: 'array', items: 'string', required: true })
    expect(def.fields.nickname).toEqual({ type: 'string', required: false })
    expect(def.fields.role).toEqual({ type: 'string', required: true })
  })

  it('maps a transform that returns a Date to time, and a transform whose output cannot be produced falls back to the input type', () => {
    const WithTransform = z.object({
      createdAt: z.string().transform((v) => new Date(v)),
      broken: z.string().transform((v) => {
        throw new Error(`cannot transform ${v}`)
      }),
    })

    const def = defFromSchema('xdb://app/events', WithTransform)
    expect(def.fields.createdAt).toEqual({ type: 'time', required: true })
    // The probe parse throws, so the field falls back to the pre-transform (string) type.
    expect(def.fields.broken).toEqual({ type: 'string', required: true })
  })

  it('a field with a default is not required', () => {
    const Post = z.object({
      views: z.number().int().default(0),
      tags: z.array(z.string()).default([]),
    })
    const def = defFromSchema('xdb://app/posts', Post)
    expect(def.fields.views).toEqual({ type: 'integer', required: false })
    expect(def.fields.tags).toEqual({ type: 'array', items: 'string', required: false })
  })

  it('the Post schema from design.html section 3 derives the documented fields', () => {
    const Post = z.object({
      id: z.string(),
      title: z.string(),
      author: z.string(),
      views: z.number().int().default(0),
      tags: z.array(z.string()).default([]),
      createdAt: z.string().transform((v) => new Date(v)),
    })

    const def = defFromSchema('xdb://app/posts', Post)
    expect(def).toEqual({
      ns: 'app',
      schema: 'posts',
      mode: 'strict',
      fields: {
        title: { type: 'string', required: true },
        author: { type: 'string', required: true },
        views: { type: 'integer', required: false },
        tags: { type: 'array', items: 'string', required: false },
        createdAt: { type: 'time', required: true },
      },
    })
  })

  it('a `types` override replaces the derived mapping for a named field', () => {
    const Post = z.object({ views: z.number() })
    const def = defFromSchema('xdb://app/posts', Post, { views: { type: 'unsigned', required: true } })
    expect(def.fields.views).toEqual({ type: 'unsigned', required: true })
  })

  it('without a schema, the collection is dynamic with no declared fields', () => {
    const def = defFromSchema('xdb://app/things', undefined)
    expect(def).toEqual({ ns: 'app', schema: 'things', mode: 'dynamic', fields: {} })
  })

  it('a schema that is not a recognizable Zod object also falls back to dynamic mode', () => {
    const def = defFromSchema('xdb://app/things', { parse: (v: unknown) => v })
    expect(def.mode).toBe('dynamic')
    expect(def.fields).toEqual({})
  })
})

describe('parseItem', () => {
  it('applies defaults and transforms, so a string in becomes a Date out', () => {
    const Post = z.object({
      title: z.string(),
      views: z.number().int().default(0),
      createdAt: z.string().transform((v) => new Date(v)),
    })
    const out = parseItem<{ title: string; views: number; createdAt: Date }>(Post, {
      title: 'Hello',
      createdAt: '2026-09-13T00:00:00Z',
    })
    expect(out.views).toBe(0)
    expect(out.createdAt).toBeInstanceOf(Date)
    expect(out.createdAt.toISOString()).toBe('2026-09-13T00:00:00.000Z')
  })

  it('throws VALIDATION with issues carrying a real, dotted field path', () => {
    const Post = z.object({
      title: z.string(),
      author: z.object({ name: z.string() }),
    })
    let caught: unknown
    try {
      parseItem(Post, { title: 5, author: { name: 42 } })
    } catch (err) {
      caught = err
    }
    expect(isXDBError(caught, 'VALIDATION')).toBe(true)
    const issues = isXDBError(caught) ? caught.issues : undefined
    expect(issues).toBeDefined()
    const paths = (issues ?? []).map((i) => i.path)
    expect(paths).toContain('title')
    expect(paths).toContain('author.name')
    expect((issues ?? []).every((i) => typeof i.message === 'string' && i.message.length > 0)).toBe(true)
  })

  it('passes input through unchanged without a schema', () => {
    const input = { anything: 'goes' }
    expect(parseItem(undefined, input)).toBe(input)
  })

  it('works with a bare `{ parse }` schema, not just a Standard Schema', () => {
    const bare = { parse: (v: unknown) => ({ ...(v as object), stamped: true }) }
    expect(parseItem(bare, { a: 1 })).toEqual({ a: 1, stamped: true })
  })
})
