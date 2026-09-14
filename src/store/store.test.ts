import { describe, expect, it, vi } from 'vitest'
import { isXDBError } from '../core/errors.js'
import type { Def, Driver, Mutation, RecordObject, Tuple } from '../core/types.js'
import { memory } from '../drivers/memory.js'
import { Footprint } from '../query/footprint.js'
import { TupleStore } from './store.js'

const postsDef: Def = {
  ns: 'app',
  schema: 'posts',
  mode: 'strict',
  fields: {
    title: { type: 'string', required: true },
    views: { type: 'integer' },
  },
}

async function openStore(opts: { defs?: Def[] } = {}): Promise<TupleStore> {
  return TupleStore.open({ driver: memory(), defs: opts.defs })
}

describe('TupleStore.apply: the four-op table', () => {
  it('create on an absent path writes the full tuple set, stamped', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'body', value: 'hi' }] }])
    const rec = store.record('app/notes/n1', { system: true })!
    expect(rec.body).toBe('hi')
    expect(rec.id).toBe('n1')
    expect(rec._version).toBe(1)
    expect(rec._updated).toBeInstanceOf(Date)
  })

  it('create on an existing path throws ALREADY_EXISTS', async () => {
    const store = await openStore()
    const m: Mutation = { path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'body', value: 'hi' }] }
    await store.apply([m])
    await expect(store.apply([m])).rejects.toSatisfy((e) => isXDBError(e, 'ALREADY_EXISTS'))
  })

  it('put on an absent path writes the full tuple set', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'put', tuples: [{ path: 'app/notes/n1', attr: 'body', value: 'hi' }] }])
    expect(store.record('app/notes/n1')!.body).toBe('hi')
  })

  it('put on an existing path replaces the full tuple set', async () => {
    const store = await openStore()
    await store.apply([
      { path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }, { path: 'app/notes/n1', attr: 'b', value: 2 }] },
    ])
    await store.apply([{ path: 'app/notes/n1', op: 'put', tuples: [{ path: 'app/notes/n1', attr: 'c', value: 3 }] }])
    const rec = store.record('app/notes/n1')!
    expect(rec.a).toBeUndefined()
    expect(rec.c).toBe(3)
  })

  it('patch on an absent path creates the record', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'body', value: 'hi' }] }])
    expect(store.record('app/notes/n1')!.body).toBe('hi')
  })

  it('patch on an existing path overlays only the named attributes', async () => {
    const store = await openStore()
    await store.apply([
      { path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }, { path: 'app/notes/n1', attr: 'b', value: 2 }] },
    ])
    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'b', value: 20 }] }])
    const rec = store.record('app/notes/n1')!
    expect(rec.a).toBe(1)
    expect(rec.b).toBe(20)
  })

  it('delete on an absent path is a no-op', async () => {
    const store = await openStore()
    await expect(store.apply([{ path: 'app/notes/missing', op: 'delete' }])).resolves.toBeUndefined()
  })

  it('delete with no attrs removes the whole record', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    await store.apply([{ path: 'app/notes/n1', op: 'delete' }])
    expect(store.record('app/notes/n1')).toBeUndefined()
  })

  it('delete with attrs removes only the named attributes, and bumps the version', async () => {
    const store = await openStore()
    await store.apply([
      { path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }, { path: 'app/notes/n1', attr: 'b', value: 2 }] },
    ])
    await store.apply([{ path: 'app/notes/n1', op: 'delete', attrs: ['a'] }])
    const rec = store.record('app/notes/n1', { system: true })!
    expect(rec.a).toBeUndefined()
    expect(rec.b).toBe(2)
    expect(rec._version).toBe(2)
  })
})

describe('TupleStore.apply: enforcement wiring', () => {
  it('rejects an undeclared attribute in a strict schema', async () => {
    const store = await openStore({ defs: [postsDef] })
    await expect(
      store.apply([{ path: 'app/posts/p1', op: 'create', tuples: [{ path: 'app/posts/p1', attr: 'title', value: 'x' }, { path: 'app/posts/p1', attr: 'bogus', value: 1 }] }]),
    ).rejects.toSatisfy((e) => isXDBError(e, 'SCHEMA_VIOLATION'))
  })

  it('rejects a create missing a required field', async () => {
    const store = await openStore({ defs: [postsDef] })
    await expect(store.apply([{ path: 'app/posts/p1', op: 'create', tuples: [] }])).rejects.toSatisfy((e) =>
      isXDBError(e, 'SCHEMA_VIOLATION'),
    )
  })

  it('rejects deleting a required attribute', async () => {
    const store = await openStore({ defs: [postsDef] })
    await store.apply([{ path: 'app/posts/p1', op: 'create', tuples: [{ path: 'app/posts/p1', attr: 'title', value: 'x' }] }])
    await expect(store.apply([{ path: 'app/posts/p1', op: 'delete', attrs: ['title'] }])).rejects.toSatisfy((e) =>
      isXDBError(e, 'SCHEMA_VIOLATION'),
    )
  })

  it('allows a whole-record delete of a record with required fields', async () => {
    const store = await openStore({ defs: [postsDef] })
    await store.apply([{ path: 'app/posts/p1', op: 'create', tuples: [{ path: 'app/posts/p1', attr: 'title', value: 'x' }] }])
    await expect(store.apply([{ path: 'app/posts/p1', op: 'delete' }])).resolves.toBeUndefined()
  })

  it('persists a dynamic-mode field evolution to def()', async () => {
    const dynDef: Def = { ns: 'app', schema: 'events', mode: 'dynamic', fields: {} }
    const store = await openStore({ defs: [dynDef] })
    await store.apply([{ path: 'app/events/e1', op: 'create', tuples: [{ path: 'app/events/e1', attr: 'kind', value: 'click' }] }])
    expect(store.def('app/events')!.fields.kind).toEqual({ type: 'string' })
  })
})

describe('TupleStore.apply: versioning', () => {
  it('stamps _version 1 on create and increments on each subsequent write', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    expect(store.record('app/notes/n1', { system: true })!._version).toBe(1)
    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 2 }] }])
    expect(store.record('app/notes/n1', { system: true })!._version).toBe(2)
  })

  it('throws CONFLICT on a stale version and writes nothing', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    await expect(
      store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 2 }], version: 99 }]),
    ).rejects.toSatisfy((e) => isXDBError(e, 'CONFLICT'))
    expect(store.record('app/notes/n1')!.a).toBe(1)
  })

  it('writes unconditionally when version is absent or 0', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 2 }], version: 0 }])
    expect(store.record('app/notes/n1')!.a).toBe(2)
  })
})

describe('TupleStore.apply: driver rejection rolls back', () => {
  function flakyDriver(): { driver: Driver; failNext: () => void } {
    const inner = memory()
    let fail = false
    const driver: Driver = {
      ...inner,
      apply: async (m: Mutation) => {
        if (fail) {
          fail = false
          throw new Error('driver exploded')
        }
        return inner.apply(m)
      },
    }
    return { driver, failNext: () => (fail = true) }
  }

  it('restores the index to its exact prior state and the live subscriber sees the reversal', async () => {
    const { driver, failNext } = flakyDriver()
    const store = await TupleStore.open({ driver })
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])

    const before = [...store.index.attrs('app/notes/n1')!.entries()]

    const live = store.live((index, fp) => {
      fp.add('app/notes', 'a')
      const t = index.get('app/notes/n1', 'a')
      return t ? [t.value] : []
    })
    const seen: unknown[][] = []
    live.subscribe((rows) => seen.push(rows))

    failNext()
    await expect(
      store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 2 }] }]),
    ).rejects.toThrow('driver exploded')

    // index restored byte-for-byte
    const after = [...store.index.attrs('app/notes/n1')!.entries()]
    expect(after).toEqual(before)

    store.bus.flush()
    // first delivery was [1], the failed write briefly published [2], then reverted back to [1]
    expect(seen[0]).toEqual([1])
    expect(seen.at(-1)).toEqual([1])
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })
})

describe('TupleStore.live: coalescing and footprint isolation', () => {
  it('coalesces several writes in one task into one rerun', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 0 }] }])

    const live = store.live((index, fp) => {
      fp.add('app/notes', 'a')
      return [index.get('app/notes/n1', 'a')?.value]
    })
    const cb = vi.fn()
    live.subscribe(cb)
    cb.mockClear()

    // fire all three writes in the same task, without awaiting in between, so the
    // bus's microtask coalescing has a chance to collapse them into one rerun.
    const p1 = store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    const p2 = store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 2 }] }])
    const p3 = store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 3 }] }])
    store.bus.flush()
    await Promise.all([p1, p2, p3])

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith([3])
  })

  it('does not rerun when an attribute outside the footprint changes', async () => {
    const store = await openStore()
    await store.apply([
      { path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }, { path: 'app/notes/n1', attr: 'b', value: 1 }] },
    ])

    const live = store.live((index, fp) => {
      fp.add('app/notes', 'a')
      return [index.get('app/notes/n1', 'a')?.value]
    })
    const cb = vi.fn()
    live.subscribe(cb)
    cb.mockClear()

    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'b', value: 2 }] }])
    store.bus.flush()

    expect(cb).not.toHaveBeenCalled()
  })

  it('does not call the subscriber when the rerun produces the same rows', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }, { path: 'app/notes/n1', attr: 'b', value: 1 }] }])

    const live = store.live((index, fp) => {
      fp.add('app/notes', null)
      return [index.get('app/notes/n1', 'a')?.value]
    })
    const cb = vi.fn()
    live.subscribe(cb)
    cb.mockClear()

    // b changes, but the projected row (a's value) does not
    await store.apply([{ path: 'app/notes/n1', op: 'patch', tuples: [{ path: 'app/notes/n1', attr: 'b', value: 2 }] }])
    store.bus.flush()

    expect(cb).not.toHaveBeenCalled()
  })

  it('toArray reads the index directly without registering a live subscription', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    const live = store.live((index) => [index.get('app/notes/n1', 'a')?.value])
    expect(live.toArray()).toEqual([1])
  })
})

describe('TupleStore.watch: scope filtering', () => {
  it('delivers events at ns scope', async () => {
    const store = await openStore()
    const events: unknown[] = []
    store.watch('app', (e) => events.push(e))
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    expect(events).toHaveLength(1)
  })

  it('delivers events at schema scope', async () => {
    const store = await openStore()
    const events: unknown[] = []
    store.watch('app/notes', (e) => events.push(e))
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    await store.apply([{ path: 'app/other/o1', op: 'create', tuples: [{ path: 'app/other/o1', attr: 'a', value: 1 }] }])
    expect(events).toHaveLength(1)
  })

  it('delivers events at record scope', async () => {
    const store = await openStore()
    const events: unknown[] = []
    store.watch('app/notes/n1', (e) => events.push(e))
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    await store.apply([{ path: 'app/notes/n2', op: 'create', tuples: [{ path: 'app/notes/n2', attr: 'a', value: 1 }] }])
    expect(events).toHaveLength(1)
  })

  it('does not deliver events outside the scope', async () => {
    const store = await openStore()
    const events: unknown[] = []
    store.watch('other', (e) => events.push(e))
    await store.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
    expect(events).toHaveLength(0)
  })
})

describe('TupleStore.list', () => {
  async function seeded(): Promise<TupleStore> {
    const store = await openStore()
    for (let i = 0; i < 5; i++) {
      await store.apply([
        { path: `app/notes/n${i}`, op: 'create', tuples: [{ path: `app/notes/n${i}`, attr: 'i', value: i }, { path: `app/notes/n${i}`, attr: 'even', value: i % 2 === 0 }] },
      ])
    }
    return store
  }

  it('filters with a predicate', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', filter: (r) => r.even === true })
    expect(page.items.map((r) => r.i).sort()).toEqual([0, 2, 4])
  })

  it('paginates with a limit', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', limit: 2 })
    expect(page.items).toHaveLength(2)
  })

  it('paginates with an offset', async () => {
    const store = await seeded()
    const all = store.list({ scope: 'app/notes', limit: 20 })
    const rest = store.list({ scope: 'app/notes', limit: 20, offset: 2 })
    expect(rest.items).toHaveLength(3)
    expect(rest.items.map((r) => r.id).sort()).toEqual(all.items.slice(2).map((r) => r.id as string).sort())
  })

  it('total is the full match count, not the page size', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', limit: 2 })
    expect(page.total).toBe(5)
  })

  it('nextOffset is 0 on the last page', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', limit: 20 })
    expect(page.nextOffset).toBe(0)
  })

  it('nextOffset points past the current page when more remain', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', limit: 2 })
    expect(page.nextOffset).toBe(2)
  })

  it('defaults the limit to 20', async () => {
    const store = await openStore()
    for (let i = 0; i < 25; i++) {
      await store.apply([{ path: `app/notes/n${i}`, op: 'create', tuples: [{ path: `app/notes/n${i}`, attr: 'i', value: i }] }])
    }
    const page = store.list({ scope: 'app/notes' })
    expect(page.items).toHaveLength(20)
  })

  it('caps the limit at 1000', async () => {
    const store = await seeded()
    const page = store.list({ scope: 'app/notes', limit: 5000 })
    expect(page.items.length).toBeLessThanOrEqual(1000)
  })
})

describe('TupleStore.tx', () => {
  it('commits every mutation fn makes as one batch, seen as one live rerun', async () => {
    const store = await openStore()
    const live = store.live((index, fp) => {
      fp.add('app/notes', null)
      return [[...index.paths('app/notes')].length]
    })
    const cb = vi.fn()
    live.subscribe(cb)
    cb.mockClear()

    await store.tx(async (t) => {
      await t.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
      await t.apply([{ path: 'app/notes/n2', op: 'create', tuples: [{ path: 'app/notes/n2', attr: 'a', value: 1 }] }])
    })
    store.bus.flush()

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith([2])
    expect(store.record('app/notes/n1')).toBeDefined()
    expect(store.record('app/notes/n2')).toBeDefined()
  })

  it('reads inside the transaction see mutations made earlier in the same transaction', async () => {
    const store = await openStore()
    let seenDuringTx: unknown
    await store.tx(async (t) => {
      await t.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
      seenDuringTx = t.record('app/notes/n1')?.a
    })
    expect(seenDuringTx).toBe(1)
  })

  it('rolls back every mutation when fn throws', async () => {
    const store = await openStore()
    await store.apply([{ path: 'app/notes/n0', op: 'create', tuples: [{ path: 'app/notes/n0', attr: 'a', value: 1 }] }])

    await expect(
      store.tx(async (t) => {
        await t.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(store.record('app/notes/n1')).toBeUndefined()
    expect(store.record('app/notes/n0')!.a).toBe(1)
  })

  it('rolls back every mutation when the driver rejects at commit', async () => {
    const inner = memory()
    let calls = 0
    const driver: Driver = {
      ...inner,
      apply: async (m: Mutation) => {
        calls++
        if (calls === 2) throw new Error('driver exploded')
        return inner.apply(m)
      },
    }
    const store = await TupleStore.open({ driver })

    await expect(
      store.tx(async (t) => {
        await t.apply([{ path: 'app/notes/n1', op: 'create', tuples: [{ path: 'app/notes/n1', attr: 'a', value: 1 }] }])
        await t.apply([{ path: 'app/notes/n2', op: 'create', tuples: [{ path: 'app/notes/n2', attr: 'a', value: 1 }] }])
      }),
    ).rejects.toThrow('driver exploded')

    expect(store.record('app/notes/n1')).toBeUndefined()
    expect(store.record('app/notes/n2')).toBeUndefined()
  })
})

describe('TupleStore.hydrate', () => {
  it('loads driver tuples into the index', async () => {
    const driver = memory()
    const path = 'app/notes/n1'
    await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    const store = await TupleStore.open({ driver })
    expect(store.record(path)).toBeUndefined()
    await store.hydrate('app/notes')
    expect(store.record(path)!.a).toBe(1)
  })

  it('is idempotent per scope', async () => {
    const driver = memory()
    const path = 'app/notes/n1'
    await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
    const store = await TupleStore.open({ driver })
    await store.hydrate('app/notes')
    // mutate the index locally; a second hydrate of the same scope must not re-scan and clobber it
    await store.apply([{ path, op: 'patch', tuples: [{ path, attr: 'a', value: 2 }] }])
    await store.hydrate('app/notes')
    expect(store.record(path)!.a).toBe(2)
  })
})
