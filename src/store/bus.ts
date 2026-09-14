/**
 * The commit bus. Every store mutation publishes one commit here: the set of
 * changed schema/attribute keys, and the watch events the commit produced.
 * The bus fans a commit out to two kinds of subscriber: raw watch callbacks,
 * scoped by URI, and live queries, scoped by footprint. Live reruns coalesce
 * into one microtask, so several commits in one task produce one rerun.
 */
import type { ChangeKey, Unsubscribe, WatchEvent } from '../core/types.js'
import { inScope } from '../core/uri.js'
import type { Footprint } from '../query/footprint.js'

/** A live query registered with the bus: its last-run footprint and how to rerun it. */
export interface LiveEntry {
  /** The schema/attr pairs the query's last run read. The bus reads this live, so reassigning it after a rerun takes effect on the next commit. */
  footprint: Footprint
  /** Reruns the query. The bus calls this at most once per coalesced batch, even when several of the query's dependencies changed. */
  rerun(): void
}

interface WatchSub {
  scope: string
  cb: (e: WatchEvent) => void
}

interface LiveSub {
  entry: LiveEntry
  dirty: boolean
}

/** Strips the `xdb://` scheme and any `#attr` fragment, leaving a bare record path. */
function pathOf(uri: string): string {
  const noScheme = uri.startsWith('xdb://') ? uri.slice('xdb://'.length) : uri
  const hash = noScheme.indexOf('#')
  return hash >= 0 ? noScheme.slice(0, hash) : noScheme
}

export class ChangeBus {
  private readonly watchers = new Set<WatchSub>()
  private readonly liveSubs = new Set<LiveSub>()
  private pending: Promise<void> | null = null

  /**
   * Publishes one commit: the `schema|attr` keys it changed, and the watch
   * events it produced. Raw watch subscribers whose scope contains an
   * event's path are called synchronously, in this call. Live queries whose
   * footprint overlaps `changes` are marked dirty and reran in a coalesced
   * microtask, or immediately by `flush`.
   */
  publish(changes: Iterable<ChangeKey>, events: WatchEvent[]): void {
    const changeList = [...changes]

    for (const w of this.watchers) {
      for (const e of events) {
        if (inScope(w.scope, pathOf(e.uri))) w.cb(e)
      }
    }

    let anyDirty = false
    for (const s of this.liveSubs) {
      if (s.entry.footprint.overlaps(changeList)) {
        s.dirty = true
        anyDirty = true
      }
    }
    if (anyDirty) this.schedule()
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = Promise.resolve().then(() => {
      this.pending = null
      this.runDirty()
    })
  }

  /** Runs every dirty live query now. Tests use this so they do not have to await a microtask. */
  flush(): void {
    this.runDirty()
  }

  private runDirty(): void {
    for (const s of this.liveSubs) {
      if (s.dirty) {
        s.dirty = false
        s.entry.rerun()
      }
    }
  }

  /** Subscribes to raw watch events whose record path falls inside `scope` (`ns`, `ns/schema`, or a record path). */
  watch(scope: string, cb: (e: WatchEvent) => void): Unsubscribe {
    const sub: WatchSub = { scope, cb }
    this.watchers.add(sub)
    return () => this.watchers.delete(sub)
  }

  /** Registers a live query. The bus reruns it, coalesced, whenever a commit's changes overlap its footprint. */
  register(entry: LiveEntry): Unsubscribe {
    const sub: LiveSub = { entry, dirty: false }
    this.liveSubs.add(sub)
    return () => this.liveSubs.delete(sub)
  }
}
