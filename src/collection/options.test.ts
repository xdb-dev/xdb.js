import { describe, expect, it, vi } from 'vitest'
import { memory } from '../drivers/memory.js'
import { TupleStore } from '../store/store.js'
import { createCollection } from './collection.js'
import { localOnlyCollectionOptions, localStorageCollectionOptions, xdbCollectionOptions } from './options.js'

type Todo = { id: string; text: string; done: boolean }

async function freshStore(): Promise<TupleStore> {
  return TupleStore.open({ driver: memory() })
}

/** A minimal in-memory `Storage`, so a test does not depend on a real one. */
function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('localOnlyCollectionOptions', () => {
  it('defaults uri to xdb://_local/<id> and keeps data in memory only', async () => {
    const opts = localOnlyCollectionOptions<Todo>({ id: 'todos' })
    expect(opts.id).toBe('todos')
    expect(opts.uri).toBe('xdb://_local/todos')
    expect(opts.onInsert).toBeUndefined()

    const store = await freshStore()
    const todos = createCollection<Todo>(opts)
    todos.bind(store)
    await todos.insert({ id: 't-1', text: 'write tests', done: false }).isPersisted.promise
    expect(todos.get('t-1')).toMatchObject({ text: 'write tests' })
  })

  it('seeds initialData through to createCollection', async () => {
    const opts = localOnlyCollectionOptions<Todo>({
      id: 'todos',
      initialData: [{ id: 't-1', text: 'seeded', done: false }],
    })
    const store = await freshStore()
    const todos = createCollection<Todo>(opts)
    todos.bind(store)
    await todos.preload()
    expect(todos.get('t-1')!.text).toBe('seeded')
  })
})

describe('localStorageCollectionOptions', () => {
  it('works with no Storage available: guarded, degrades to in-memory', async () => {
    // This suite runs in vitest's default `node` environment, which has no
    // `window` or `localStorage`, and no `storage` override is given: every
    // guarded access must no-op rather than throw.
    const opts = localStorageCollectionOptions<Todo>({ id: 'todos', storageKey: 'todos-key' })
    expect(opts.initialData).toEqual([])

    const store = await freshStore()
    const todos = createCollection<Todo>(opts)
    expect(() => todos.bind(store)).not.toThrow()
    await expect(todos.insert({ id: 't-1', text: 'a', done: false }).isPersisted.promise).resolves.toBeUndefined()
  })

  it('reads initialData from storage on creation, and round-trips a write back to it', async () => {
    const storage = fakeStorage()
    storage.setItem('todos-key', JSON.stringify([{ id: 't-1', text: 'existing', done: false }]))

    const opts = localStorageCollectionOptions<Todo>({ id: 'todos', storageKey: 'todos-key', storage })
    expect(opts.initialData).toEqual([{ id: 't-1', text: 'existing', done: false }])

    const store = await freshStore()
    const todos = createCollection<Todo>(opts)
    todos.bind(store)
    await todos.preload()
    expect(todos.get('t-1')!.text).toBe('existing')

    await todos.insert({ id: 't-2', text: 'new', done: false }).isPersisted.promise

    const stored = JSON.parse(storage.getItem('todos-key')!) as Todo[]
    expect(stored.map((t) => t.id).sort()).toEqual(['t-1', 't-2'])
  })

  it('guards a storage that throws on write', async () => {
    const storage = fakeStorage()
    storage.setItem = () => {
      throw new Error('quota exceeded')
    }
    const opts = localStorageCollectionOptions<Todo>({ id: 'todos', storageKey: 'todos-key', storage })
    const store = await freshStore()
    const todos = createCollection<Todo>(opts)
    todos.bind(store)
    await expect(todos.insert({ id: 't-1', text: 'a', done: false }).isPersisted.promise).resolves.toBeUndefined()
  })

  it('follows a storage event from another tab', async () => {
    const storage = fakeStorage()
    let listener: ((e: { key: string | null }) => void) | undefined
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: (e: { key: string | null }) => void) => {
        if (type === 'storage') listener = cb
      },
    })

    try {
      const opts = localStorageCollectionOptions<Todo>({ id: 'todos', storageKey: 'todos-key', storage })
      const store = await freshStore()
      const todos = createCollection<Todo>(opts)
      todos.bind(store)
      await todos.insert({ id: 't-1', text: 'mine', done: false }).isPersisted.promise

      // Another tab writes the key directly, then fires the `storage` event
      // that only ever reaches *other* documents.
      storage.setItem(
        'todos-key',
        JSON.stringify([
          { id: 't-1', text: 'mine', done: false },
          { id: 't-2', text: 'theirs', done: false },
        ]),
      )
      expect(listener).toBeDefined()
      listener!({ key: 'todos-key' })
      await Promise.resolve()
      await Promise.resolve()

      expect(todos.get('t-2')).toMatchObject({ text: 'theirs' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('xdbCollectionOptions', () => {
  it('passes uri, schema, sync, and handlers through unchanged', () => {
    const onInsert = async () => undefined
    const opts = xdbCollectionOptions<Todo>({ uri: 'xdb://app/todos', onInsert })
    expect(opts.uri).toBe('xdb://app/todos')
    expect(opts.onInsert).toBe(onInsert)
    expect(opts.onUpdate).toBeUndefined()
  })
})
