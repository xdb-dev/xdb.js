/**
 * Transactions group mutations from one or more collections bound to the
 * same store and apply them as a single store batch, so the driver sees one
 * write and a live query reruns once, not once per mutation. Matches
 * TanStack DB's transaction model: `mutations` reports item-level changes,
 * for a persistence handler; `writes` carries the tuple-level ops the store
 * applies. See "The one shape that differs from the tuple layer" and
 * "Transactions" in `CONTRACTS-DX.md`.
 */
import { unavailable, unsupported } from '../core/errors.js'
import type { Mutation, Tuple } from '../core/types.js'
import type { TupleStore } from '../store/store.js'
import type { Collection } from './collection.js'

/** The lifecycle of a {@link Transaction}. */
export type TransactionState = 'pending' | 'persisting' | 'completed' | 'failed'

/** The argument a {@link MutationFn} and an {@link OptimisticActionOptions.mutationFn} receive. */
export interface MutationFnContext {
  transaction: Transaction
  signal: AbortSignal
}

/** Persists a transaction's mutations. A rejection rolls every mutation in the batch back. */
export type MutationFn = (ctx: MutationFnContext) => Promise<unknown> | unknown

/** Options for {@link createTransaction}. */
export interface CreateTransactionOptions {
  /** A stable id. Defaults to a generated one. */
  id?: string
  /** Commits as soon as `mutate` returns. Defaults to `false`. */
  autoCommit?: boolean
  /** Persists the batch. Without one, the transaction writes only to the store. */
  mutationFn?: MutationFn
  metadata?: Record<string, unknown>
  /** The store to write to. Optional when every collection in the batch is bound to one store. */
  store?: TupleStore
}

/**
 * One item-level change, in the shape TanStack DB reports to a persistence
 * handler. `Transaction.mutations` holds these; `Transaction.writes` holds
 * the tuple-level ops the store applies for the same batch.
 */
export interface CollectionMutation<T = unknown> {
  type: 'insert' | 'update' | 'delete'
  key: string
  /** The item before the change. Absent on an insert. */
  original?: T
  /** The item after the change. Absent on a delete. */
  modified?: T
  /** Only the changed fields. Present on an update. */
  changes?: Partial<T>
  collection: Collection<T>
  metadata?: Record<string, unknown>
}

/** The argument an {@link MutationHandler} receives. */
export interface HandlerContext<T> {
  transaction: Transaction<T>
  collection: Collection<T>
}

/** A collection's `onInsert`, `onUpdate`, or `onDelete` handler. A rejection reverts the change. */
export type MutationHandler<T> = (ctx: HandlerContext<T>) => Promise<unknown> | unknown

/**
 * A transaction: a batch of item-level and tuple-level mutations, collected
 * across one or more collections, applied or discarded together.
 */
export interface Transaction<T = unknown> {
  readonly id: string
  readonly state: TransactionState
  /** Item-level changes, in order. */
  readonly mutations: CollectionMutation<T>[]
  /** Tuple-level writes the store applies. */
  readonly writes: Mutation[]
  readonly metadata: Record<string, unknown>
  /** Settles when the batch is persisted, or rejects with the failure. */
  readonly isPersisted: { promise: Promise<void> }
  /**
   * Runs `fn` synchronously. Any write a bound collection makes during the
   * call is redirected into this transaction instead of reaching the store.
   * Commits at once when this transaction's `autoCommit` is `true`.
   */
  mutate(fn: () => void): this
  /**
   * Applies every collected write to the store as one batch, so a live
   * query reruns once, then runs `mutationFn`, or the collections'
   * `onInsert`/`onUpdate`/`onDelete` handlers when there is no `mutationFn`.
   * Throws `UNSUPPORTED` when the transaction is not `pending`.
   */
  commit(): Promise<void>
  /**
   * Discards the batch. Reverts the store when the batch was already
   * applied. Throws `UNSUPPORTED` on a `completed` transaction.
   */
  rollback(): void
}

/**
 * @internal Shared between `transaction.ts` and `collection.ts` only; not
 * part of the frozen contract. A collection redirects a write into the
 * active transaction, when one is running its `mutate` callback, by pushing
 * onto this instead of applying to the store.
 */
export interface MutationSink {
  /** The transaction this sink belongs to. A collection returns this from `insert`/`update`/`delete`. */
  readonly transaction: Transaction<any>
  /** Records one item-level change and its tuple writes. `handler` is the collection's matching `onInsert`/`onUpdate`/`onDelete`, if any. */
  push<U>(
    collection: Collection<U>,
    item: Omit<CollectionMutation<U>, 'collection'>,
    writes: Mutation[],
    store: TupleStore,
    handler: MutationHandler<U> | undefined,
  ): void
}

/**
 * The transaction currently running its `mutate` callback, if any. Only one
 * `mutate` call runs at a time: `mutate` runs `fn` synchronously, so nothing
 * else can interleave.
 */
let activeTransaction: TransactionImpl<any> | null = null

/**
 * The active {@link MutationSink} for `store`, or `undefined` outside of a
 * `Transaction.mutate` call on that store.
 *
 * @internal Read by `collection.ts` so a collection's mutation methods can
 * redirect into an in-progress transaction instead of writing straight to
 * the store.
 */
export function currentSink(store: TupleStore): MutationSink | undefined {
  if (!activeTransaction) return undefined
  if (activeTransaction.explicitStore && activeTransaction.explicitStore !== store) return undefined
  return activeTransaction
}

let txCounter = 0

/** A short, unique-enough transaction id. Prefers `crypto.randomUUID`, without assuming it exists. */
function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  txCounter += 1
  return `tx-${Date.now()}-${txCounter}`
}

class TransactionImpl<T = unknown> implements Transaction<T>, MutationSink {
  readonly id: string
  readonly mutations: CollectionMutation<T>[] = []
  readonly writes: Mutation[] = []
  readonly metadata: Record<string, unknown>
  readonly isPersisted: { promise: Promise<void> }
  readonly explicitStore: TupleStore | undefined
  readonly autoCommit: boolean

  private _state: TransactionState = 'pending'
  private readonly mutationFn: MutationFn | undefined
  private inferredStore: TupleStore | undefined
  private readonly handlers = new Map<Collection<any>, Partial<Record<CollectionMutation['type'], MutationHandler<any>>>>()
  private appliedSnapshot: Map<string, Tuple[] | null> | null = null
  private resolvePersisted!: () => void
  private rejectPersisted!: (err: unknown) => void

  constructor(opts: CreateTransactionOptions = {}) {
    this.id = opts.id ?? generateId()
    this.metadata = opts.metadata ?? {}
    this.mutationFn = opts.mutationFn
    this.autoCommit = opts.autoCommit ?? false
    this.explicitStore = opts.store
    this.isPersisted = {
      promise: new Promise<void>((resolve, reject) => {
        this.resolvePersisted = resolve
        this.rejectPersisted = reject
      }),
    }
    // `isPersisted.promise` is often left unconsumed, for example by a
    // caller who only awaits `commit()`. Attaching a handler here marks the
    // promise as handled, so Node does not report it as an unhandled
    // rejection; a caller's own `.then`/`.catch`/`await` still fires too.
    this.isPersisted.promise.catch(() => undefined)
  }

  get state(): TransactionState {
    return this._state
  }

  get transaction(): Transaction<T> {
    return this
  }

  push<U>(
    collection: Collection<U>,
    item: Omit<CollectionMutation<U>, 'collection'>,
    writes: Mutation[],
    store: TupleStore,
    handler: MutationHandler<U> | undefined,
  ): void {
    this.mutations.push({ ...item, collection } as unknown as CollectionMutation<T>)
    this.writes.push(...writes)
    if (this.inferredStore === undefined) this.inferredStore = store
    if (handler) {
      let byType = this.handlers.get(collection)
      if (!byType) {
        byType = {}
        this.handlers.set(collection, byType)
      }
      byType[item.type] = handler
    }
  }

  mutate(fn: () => void): this {
    const previous = activeTransaction
    activeTransaction = this
    try {
      fn()
    } finally {
      activeTransaction = previous
    }
    if (this.autoCommit) {
      // Fire-and-forget: `isPersisted` is the channel a caller awaits. A
      // caller that also awaits `commit()` still observes the rejection.
      this.commit().catch(() => undefined)
    }
    return this
  }

  private resolveStore(): TupleStore | undefined {
    return this.explicitStore ?? this.inferredStore
  }

  /** Snapshots the current tuples of every path this batch touches, so a later failure can restore them exactly. */
  private snapshot(store: TupleStore): Map<string, Tuple[] | null> {
    const paths = new Set(this.writes.map((w) => w.path))
    const snap = new Map<string, Tuple[] | null>()
    for (const path of paths) {
      const attrs = store.index.attrs(path)
      snap.set(path, attrs ? [...attrs.values()] : null)
    }
    return snap
  }

  /** Restores every path in `appliedSnapshot` to its pre-batch tuples, as a best-effort compensating write. */
  private async revert(store: TupleStore): Promise<void> {
    if (!this.appliedSnapshot) return
    const compensating: Mutation[] = []
    for (const [path, tuples] of this.appliedSnapshot) {
      compensating.push(tuples === null ? { path, op: 'delete' } : { path, op: 'put', tuples })
    }
    try {
      await store.apply(compensating)
    } catch {
      // Best effort: the mutationFn/handler rejection is what the caller sees.
    }
  }

  /** Runs the matching `onInsert`/`onUpdate`/`onDelete` handler once per (collection, type) pair present in `mutations`. */
  private async runHandlers(): Promise<void> {
    const grouped = new Map<Collection<any>, Set<CollectionMutation['type']>>()
    for (const m of this.mutations) {
      let types = grouped.get(m.collection)
      if (!types) {
        types = new Set()
        grouped.set(m.collection, types)
      }
      types.add(m.type)
    }
    const calls: Array<Promise<unknown>> = []
    for (const [collection, types] of grouped) {
      const byType = this.handlers.get(collection)
      if (!byType) continue
      for (const type of types) {
        const handler = byType[type]
        if (handler) calls.push(Promise.resolve(handler({ transaction: this, collection })))
      }
    }
    await Promise.all(calls)
  }

  async commit(): Promise<void> {
    if (this._state !== 'pending') throw unsupported(`cannot commit a transaction in state "${this._state}"`, {})
    this._state = 'persisting'

    const store = this.resolveStore()
    if (this.writes.length > 0) {
      if (!store) {
        const err = unavailable('a transaction with writes needs a store: pass one to createTransaction, or write through a bound collection', {})
        this._state = 'failed'
        this.rejectPersisted(err)
        throw err
      }
      try {
        this.appliedSnapshot = this.snapshot(store)
        await store.apply(this.writes)
      } catch (err) {
        this._state = 'failed'
        this.rejectPersisted(err)
        throw err
      }
    }

    try {
      if (this.mutationFn) {
        const signal = new AbortController().signal
        await this.mutationFn({ transaction: this, signal })
      } else {
        await this.runHandlers()
      }
      this._state = 'completed'
      this.resolvePersisted()
    } catch (err) {
      if (store) await this.revert(store)
      this._state = 'failed'
      this.rejectPersisted(err)
      throw err
    }
  }

  rollback(): void {
    if (this._state === 'completed') throw unsupported('cannot roll back a completed transaction', {})
    const store = this.resolveStore()
    if (this.appliedSnapshot && store) {
      // Best effort: `rollback` is synchronous, so the revert runs in the background.
      void this.revert(store)
    }
    this.mutations.length = 0
    this.writes.length = 0
    this._state = 'failed'
  }
}

/**
 * Creates a {@link Transaction}. Use `mutate` to run writes against
 * collections, then `commit` to apply them as one batch, or `rollback` to
 * discard them.
 */
export function createTransaction<T = unknown>(opts: CreateTransactionOptions = {}): Transaction<T> {
  return new TransactionImpl<T>(opts)
}

/** Options for {@link createOptimisticAction}. */
export interface OptimisticActionOptions<P> {
  /** Applies the change to memory at once. Runs inside a transaction. */
  onMutate: (params: P) => void
  /** Persists it. A rejection rolls the change back. */
  mutationFn: (params: P, ctx: MutationFnContext) => Promise<unknown> | unknown
}

/**
 * Builds a callable that applies a change at once, through `onMutate`, and
 * persists it after, through `mutationFn`. A rejected `mutationFn` rolls the
 * optimistic change back.
 */
export function createOptimisticAction<P>(opts: OptimisticActionOptions<P>): (params: P) => Transaction {
  return (params: P) => {
    const tx = new TransactionImpl({
      autoCommit: true,
      mutationFn: (ctx) => opts.mutationFn(params, ctx),
    })
    tx.mutate(() => opts.onMutate(params))
    return tx
  }
}
