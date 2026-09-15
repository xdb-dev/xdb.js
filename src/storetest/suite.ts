/**
 * The driver conformance suite. Every xdb.js driver runs this suite against
 * its own factory, inside its own test file. It is the JavaScript equivalent
 * of the Go library's `storetest.NewDriverSuite`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { isXDBError, type ErrorCode } from '../core/errors.js'
import type { Def, Driver, Tuple } from '../core/types.js'

/** A short random suffix, used to keep test paths from colliding. */
function uid(): string {
  return Math.random().toString(36).slice(2)
}

/** Collects an async iterable of tuples into an array. */
async function collectScan(driver: Driver, scope: string): Promise<Tuple[]> {
  const out: Tuple[] = []
  for await (const t of driver.scanTuples(scope)) out.push(t)
  return out
}

/** Collects an async iterable of definitions into an array. */
async function collectSchemas(driver: Driver, scope: string): Promise<Def[]> {
  const out: Def[] = []
  for await (const d of driver.scanSchemas(scope)) out.push(d)
  return out
}

/** Awaits `p` and asserts it rejects with an `XDBError` of `code`. */
async function expectRejectsWithCode(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await p
  } catch (e) {
    expect(isXDBError(e, code)).toBe(true)
    return
  }
  throw new Error(`expected the promise to reject with ${code}`)
}

/**
 * Runs the driver conformance suite against `make`, inside a `describe(name, ...)`
 * block. `make` must return an isolated driver on every call: the suite calls
 * it before each test.
 */
export function runDriverSuite(name: string, make: () => Driver | Promise<Driver>): void {
  describe(name, () => {
    let driver: Driver

    beforeEach(async () => {
      driver = await make()
    })

    describe('apply: four ops, against an absent path', () => {
      it('create writes the full tuple set', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({
          path,
          op: 'create',
          tuples: [
            { path, attr: 'a', value: 'x' },
            { path, attr: 'b', value: 1 },
          ],
        })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr).sort()).toEqual(['a', 'b'])
      })

      it('put writes the full tuple set', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'put', tuples: [{ path, attr: 'a', value: 'x' }] })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr)).toEqual(['a'])
      })

      it('patch creates the record', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'patch', tuples: [{ path, attr: 'a', value: 'x' }] })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr)).toEqual(['a'])
      })

      it('delete is a no-op', async () => {
        const path = `ns/sch/${uid()}`
        await expect(driver.apply({ path, op: 'delete' })).resolves.toBeUndefined()
        expect((await collectScan(driver, path)).length).toBe(0)
      })
    })

    describe('apply: four ops, against an existing path', () => {
      it('create throws ALREADY_EXISTS', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 'x' }] })
        await expectRejectsWithCode(
          driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 'y' }] }),
          'ALREADY_EXISTS',
        )
        // the original record is untouched
        const tuples = await collectScan(driver, path)
        expect(tuples.find((t) => t.attr === 'a')?.value).toBe('x')
      })

      it('put replaces the whole tuple set', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({
          path,
          op: 'create',
          tuples: [
            { path, attr: 'a', value: 1 },
            { path, attr: 'b', value: 2 },
          ],
        })
        await driver.apply({ path, op: 'put', tuples: [{ path, attr: 'c', value: 3 }] })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr)).toEqual(['c'])
      })

      it('patch overlays only the named attributes', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({
          path,
          op: 'create',
          tuples: [
            { path, attr: 'a', value: 1 },
            { path, attr: 'b', value: 2 },
          ],
        })
        await driver.apply({ path, op: 'patch', tuples: [{ path, attr: 'b', value: 20 }] })
        const tuples = await collectScan(driver, path)
        const byAttr = new Map(tuples.map((t) => [t.attr, t.value]))
        expect(byAttr.get('a')).toBe(1)
        expect(byAttr.get('b')).toBe(20)
      })

      it('delete with no attrs removes the whole record', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
        await driver.apply({ path, op: 'delete' })
        expect((await collectScan(driver, path)).length).toBe(0)
      })

      it('delete with attrs removes only the named attributes', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({
          path,
          op: 'create',
          tuples: [
            { path, attr: 'a', value: 1 },
            { path, attr: 'b', value: 2 },
          ],
        })
        await driver.apply({ path, op: 'delete', attrs: ['a'] })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr)).toEqual(['b'])
      })

      it('delete of the last attribute removes the record, so create succeeds again', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
        await driver.apply({ path, op: 'delete', attrs: ['a'] })
        expect((await collectScan(driver, path)).length).toBe(0)
        await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'b', value: 2 }] })
        const tuples = await collectScan(driver, path)
        expect(tuples.map((t) => t.attr)).toEqual(['b'])
      })

      it('put with an empty tuple set removes the record', async () => {
        const path = `ns/sch/${uid()}`
        await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
        await driver.apply({ path, op: 'put', tuples: [] })
        expect((await collectScan(driver, path)).length).toBe(0)
        await expect(
          driver.apply({ path, op: 'create', tuples: [{ path, attr: 'b', value: 2 }] }),
        ).resolves.toBeUndefined()
      })
    })

    it('resolves a 16-way concurrent create race to exactly one winner', async () => {
      const path = `ns/sch/${uid()}`
      const attempts = Array.from({ length: 16 }, (_, i) =>
        driver.apply({ path, op: 'create', tuples: [{ path, attr: 'n', value: i }] }).then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ ok: false as const, code: isXDBError(e) ? e.code : undefined }),
        ),
      )
      const results = await Promise.all(attempts)
      const wins = results.filter((r) => r.ok)
      const losses = results.filter((r) => !r.ok)
      expect(wins.length).toBe(1)
      expect(losses.length).toBe(15)
      for (const loss of losses) expect(loss.code).toBe('ALREADY_EXISTS')
    })

    it('getTuples omits absent attributes and preserves request order', async () => {
      const path = `ns/sch/${uid()}`
      await driver.apply({
        path,
        op: 'create',
        tuples: [
          { path, attr: 'a', value: 1 },
          { path, attr: 'b', value: 2 },
          { path, attr: 'c', value: 3 },
        ],
      })
      const result = await driver.getTuples([`xdb://${path}#c`, `xdb://${path}#missing`, `xdb://${path}#a`])
      expect(result.map((t) => t.attr)).toEqual(['c', 'a'])
    })

    it('scan yields the tuples of one record contiguously', async () => {
      const ns = 'ns'
      const schema = `sch${uid()}`
      const ids = [uid(), uid(), uid()]
      for (const id of ids) {
        const path = `${ns}/${schema}/${id}`
        await driver.apply({
          path,
          op: 'create',
          tuples: [
            { path, attr: 'a', value: 1 },
            { path, attr: 'b', value: 2 },
            { path, attr: 'c', value: 3 },
          ],
        })
      }
      const tuples = await collectScan(driver, `${ns}/${schema}`)
      expect(tuples.length).toBe(ids.length * 3)
      const seen = new Set<string>()
      let last: string | null = null
      for (const t of tuples) {
        if (t.path !== last) {
          expect(seen.has(t.path)).toBe(false)
          seen.add(t.path)
          last = t.path
        }
      }
    })

    it('scan supports ns, ns/schema, and ns/schema/id scopes', async () => {
      const ns = `ns${uid()}`
      const schema = 'sch'
      const id = uid()
      const path = `${ns}/${schema}/${id}`
      await driver.apply({
        path,
        op: 'create',
        tuples: [
          { path, attr: 'a', value: 1 },
          { path, attr: 'b', value: 2 },
        ],
      })

      expect((await collectScan(driver, path)).length).toBe(2)
      expect((await collectScan(driver, `${ns}/${schema}`)).length).toBe(2)
      expect((await collectScan(driver, ns)).length).toBe(2)
    })

    describe('definitions', () => {
      it('createSchema writes verbatim and getSchema round-trips it', async () => {
        const def: Def = { ns: `ns${uid()}`, schema: 'sch', mode: 'flexible', fields: { a: { type: 'string' } } }
        await driver.createSchema(def)
        expect(await driver.getSchema(`${def.ns}/${def.schema}`)).toEqual(def)
      })

      it('createSchema on an existing path throws ALREADY_EXISTS', async () => {
        const def: Def = { ns: `ns${uid()}`, schema: 'sch', mode: 'flexible', fields: {} }
        await driver.createSchema(def)
        await expectRejectsWithCode(driver.createSchema(def), 'ALREADY_EXISTS')
      })

      it('putSchema creates on an absent path', async () => {
        const def: Def = { ns: `ns${uid()}`, schema: 'sch', mode: 'flexible', fields: {} }
        await driver.putSchema(def)
        expect(await driver.getSchema(`${def.ns}/${def.schema}`)).toEqual(def)
      })

      it('putSchema replaces an existing definition', async () => {
        const ns = `ns${uid()}`
        const schema = 'sch'
        const def1: Def = { ns, schema, mode: 'flexible', fields: { a: { type: 'string' } } }
        await driver.createSchema(def1)
        const def2: Def = { ns, schema, mode: 'strict', fields: { b: { type: 'integer' } } }
        await driver.putSchema(def2)
        expect(await driver.getSchema(`${ns}/${schema}`)).toEqual(def2)
      })

      it('getSchema on an absent path returns null', async () => {
        expect(await driver.getSchema(`ns${uid()}/sch`)).toBeNull()
      })

      it('deleteSchema removes the definition', async () => {
        const ns = `ns${uid()}`
        const schema = 'sch'
        await driver.createSchema({ ns, schema, mode: 'flexible', fields: {} })
        await driver.deleteSchema(`${ns}/${schema}`)
        expect(await driver.getSchema(`${ns}/${schema}`)).toBeNull()
      })

      it('scanSchemas yields the definitions of one namespace', async () => {
        const ns = `ns${uid()}`
        await driver.createSchema({ ns, schema: 'a', mode: 'flexible', fields: {} })
        await driver.createSchema({ ns, schema: 'b', mode: 'flexible', fields: {} })
        const defs = await collectSchemas(driver, ns)
        expect(defs.map((d) => d.schema).sort()).toEqual(['a', 'b'])
      })
    })

    it('dropRecords removes records but keeps the definition', async () => {
      const ns = `ns${uid()}`
      const schema = 'sch'
      const def: Def = { ns, schema, mode: 'flexible', fields: {} }
      await driver.createSchema(def)
      const path = `${ns}/${schema}/${uid()}`
      await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })

      await driver.dropRecords(`${ns}/${schema}`)

      expect((await collectScan(driver, `${ns}/${schema}`)).length).toBe(0)
      expect(await driver.getSchema(`${ns}/${schema}`)).toEqual(def)
    })

    it('tx rolls back every write when the callback throws, when the driver implements tx', async () => {
      if (!driver.tx) return
      const path = `ns/sch/${uid()}`
      await driver.apply({ path, op: 'create', tuples: [{ path, attr: 'a', value: 1 }] })
      const boom = new Error('boom')

      await expect(
        driver.tx(async (t) => {
          await t.apply({ path, op: 'patch', tuples: [{ path, attr: 'a', value: 2 }] })
          throw boom
        }),
      ).rejects.toThrow(boom)

      const tuples = await collectScan(driver, path)
      expect(tuples.find((t) => t.attr === 'a')?.value).toBe(1)
    })
  })
}
