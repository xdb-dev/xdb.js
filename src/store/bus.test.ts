import { describe, expect, it, vi } from 'vitest'
import type { WatchEvent } from '../core/types.js'
import { Footprint } from '../query/footprint.js'
import { ChangeBus } from './bus.js'

function event(uri: string): WatchEvent {
  return { type: 'put', uri, attrs: ['title'], version: 1 }
}

describe('ChangeBus.watch', () => {
  it('calls a subscriber whose scope contains the changed path', () => {
    const bus = new ChangeBus()
    const cb = vi.fn()
    bus.watch('app/posts', cb)
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p1')])
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(event('xdb://app/posts/p1'))
  })

  it('does not call a subscriber outside the scope', () => {
    const bus = new ChangeBus()
    const cb = vi.fn()
    bus.watch('app/comments', cb)
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p1')])
    expect(cb).not.toHaveBeenCalled()
  })

  it('scopes at the namespace level', () => {
    const bus = new ChangeBus()
    const cb = vi.fn()
    bus.watch('app', cb)
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p1')])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('scopes at the record level', () => {
    const bus = new ChangeBus()
    const cb = vi.fn()
    bus.watch('app/posts/p1', cb)
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p1')])
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p2')])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops delivery', () => {
    const bus = new ChangeBus()
    const cb = vi.fn()
    const stop = bus.watch('app/posts', cb)
    stop()
    bus.publish(['app/posts|title'], [event('xdb://app/posts/p1')])
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('ChangeBus live registration', () => {
  it('reruns an entry whose footprint overlaps the changes, coalesced into one flush', () => {
    const bus = new ChangeBus()
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    const rerun = vi.fn()
    bus.register({ footprint: fp, rerun })

    bus.publish(['app/posts|title'], [])
    bus.publish(['app/posts|title'], [])
    bus.publish(['app/posts|title'], [])
    expect(rerun).not.toHaveBeenCalled()

    bus.flush()
    expect(rerun).toHaveBeenCalledTimes(1)
  })

  it('does not rerun an entry whose footprint does not overlap the changes', () => {
    const bus = new ChangeBus()
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    const rerun = vi.fn()
    bus.register({ footprint: fp, rerun })

    bus.publish(['app/posts|views'], [])
    bus.flush()
    expect(rerun).not.toHaveBeenCalled()
  })

  it('coalesces several commits in one task into one microtask rerun', async () => {
    const bus = new ChangeBus()
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    const rerun = vi.fn()
    bus.register({ footprint: fp, rerun })

    bus.publish(['app/posts|title'], [])
    bus.publish(['app/posts|title'], [])
    await Promise.resolve()
    await Promise.resolve()
    expect(rerun).toHaveBeenCalledTimes(1)
  })

  it('reads the entry footprint live, so a later publish uses the footprint set by the last rerun', () => {
    const bus = new ChangeBus()
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    const entry = { footprint: fp, rerun: vi.fn() }
    bus.register(entry)

    entry.footprint = new Footprint() // narrowed to nothing, as a rerun might do
    bus.publish(['app/posts|title'], [])
    bus.flush()
    expect(entry.rerun).not.toHaveBeenCalled()
  })

  it('unregister stops future reruns', () => {
    const bus = new ChangeBus()
    const fp = new Footprint()
    fp.add('app/posts', 'title')
    const rerun = vi.fn()
    const stop = bus.register({ footprint: fp, rerun })
    stop()
    bus.publish(['app/posts|title'], [])
    bus.flush()
    expect(rerun).not.toHaveBeenCalled()
  })
})
