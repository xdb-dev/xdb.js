# xdb.js

Think in tuples. Storage is a detail.

xdb.js is the browser edition of [XDB](https://github.com/xdb-dev/xdb). Data is
tuples underneath: a path, an attribute, and a typed value. On top sits a
collection per schema, so you work with plain typed objects, mutate them in
place, and read live queries that update themselves. The tuple layer stays
reachable, and it is what syncs to a server.

## Install

```bash
pnpm add @xdb-dev/xdb zod
```

`zod` is optional. Without a schema a collection runs in `dynamic` mode and
infers types from the values you write.

## Quick start

Define a collection for each schema. The Zod schema validates input, applies
defaults, transforms values, and gives the collection its TypeScript type.

```ts
import { z } from 'zod'
import { createDB, createCollection } from '@xdb-dev/xdb'
import { idb } from '@xdb-dev/xdb/idb'

const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  views: z.number().int().default(0),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().transform((v) => new Date(v)),
})

const User = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean().default(true),
})

export const posts = createCollection({ uri: 'xdb://app/posts', schema: Post })
export const users = createCollection({ uri: 'xdb://app/users', schema: User })

const db = await createDB({ driver: idb('myapp'), collections: { posts, users } })
```

Write with `insert`, `update`, and `delete`. A mutation reaches memory at once.
Persistence happens after. If the write fails, the store rolls the mutation back
and rejects the promise.

```ts
posts.insert({ id: 'p-1', title: 'Hello', author: 'u-1', createdAt: '2026-09-13T00:00:00Z' })

posts.update('p-1', (draft) => {
  draft.views += 1
})

posts.get('p-1')      // { id: 'p-1', title: 'Hello', views: 1, tags: [], createdAt: Date }
await posts.delete('p-1').isPersisted.promise
```

Read with the query builder. A query joins collections, and a live query
re-runs after each commit that touches what it read.

```ts
import { eq, gt, and } from '@xdb-dev/xdb'

const popular = db.live((q) =>
  q
    .from({ post: posts })
    .join({ user: users }, ({ post, user }) => eq(post.author, user.id))
    .where(({ post, user }) => and(gt(post.views, 100), eq(user.active, true)))
    .select(({ post, user }) => ({ id: post.id, title: post.title, by: user.name }))
    .orderBy(({ post }) => post.views, 'desc')
    .limit(20),
)

const stop = popular.subscribe((rows) => render(rows))
```

In React, use the hook.

```tsx
import { XDBProvider, useLiveQuery } from '@xdb-dev/xdb/react'

function Popular() {
  const { data } = useLiveQuery((q) => q.from({ post: posts }).where(({ post }) => gt(post.views, 100)))
  return data.map((p) => <li key={p.id}>{p.title}</li>)
}
```

Group writes across collections with a transaction. The driver receives one
batch, and a live query sees one commit.

```ts
import { createTransaction } from '@xdb-dev/xdb'

const tx = createTransaction({ store: db.store })
tx.mutate(() => {
  posts.update('p-1', (d) => {
    d.views += 1
  })
  users.update('u-1', (d) => {
    d.active = true
  })
})
await tx.commit()
```

## The tuple layer

A collection is a view. The tuples below it are the storage format, and they
are addressable on their own. Use the tuple layer for tools, migrations, and
data without a schema.

```ts
db.tuples.get('xdb://app/posts/p-1#title')          // 'Hello'
await db.tuples.put(['app/posts/p-1', 'views', 9])
await db.tuples.delete('xdb://app/posts/p-1#views')

db.records.get('xdb://app/posts/p-1')               // with _id, _version, _updated
db.records.list('xdb://app/posts', { filter: (r) => r.views >= 100, limit: 20 })

db.watch('xdb://app/posts', (event) => console.log(event))
```

The tuple layer also answers pattern queries. A variable starts with `?`, and a
variable in two patterns joins them. This is the engine the builder compiles to.

```ts
db.query({
  find: ['?title', '?name'],
  where: [
    ['app/posts/?p', 'author', '?u'],
    ['app/users/?u', 'name', '?name'],
    ['app/posts/?p', 'title', '?title'],
    ['app/posts/?p', 'views', '?views'],
    '?views > 100',
  ],
})
```

## Drivers

| Driver | Import | Storage |
| ------ | ------ | ------- |
| `memory()` | `@xdb-dev/xdb` | In memory. For tests and demos. |
| `idb(name)` | `@xdb-dev/xdb/idb` | IndexedDB. One record store, one definition store. |

## Sync

A collection can mirror its writes to an XDB daemon. Mutations go out as tuple
writes over JSON-RPC, and remote changes come back as tuple events.

```ts
import { daemon } from '@xdb-dev/xdb/sync'

export const posts = createCollection({
  uri: 'xdb://app/posts',
  schema: Post,
  sync: daemon({ url: 'http://localhost:7777', scope: 'app/posts' }),
})
```

The Go daemon serves JSON-RPC over a Unix socket today. It has no HTTP
listener, so the daemon sync source needs one before it can connect. See the
open decisions in `design.html`.

## Errors

Every error is an `XDBError` with a `code`. The codes are the ones the XDB CLI
reports, plus `VALIDATION` for a schema parse failure.

```ts
import { isXDBError } from '@xdb-dev/xdb'

try {
  posts.insert({ id: 'p-1' })
} catch (err) {
  if (isXDBError(err, 'VALIDATION')) console.log(err.issues)
}
```

| Code | Cause |
| ---- | ----- |
| `VALIDATION` | The schema rejected the input. `issues` names the fields. |
| `NOT_FOUND` | No record at the id. |
| `ALREADY_EXISTS` | `insert` found the key in use. |
| `SCHEMA_VIOLATION` | A tuple write broke the XDB schema. |
| `CONFLICT` | A write carried a stale `_version`. |
| `INVALID_QUERY` | A pattern predicate did not parse, or it read an unbound variable. |
| `UNAVAILABLE` | The collection has no store, or the daemon is unreachable. |

## Docs

Read the [overview](docs/README.md) first. Then go to
[Get started](docs/howto/get-started.md), or open the
[concepts index](docs/concepts/README.md).

## Try it in a browser

Open `dx.html`. It has no server and no network dependency. Every example on the
page runs this library in the tab, and three panels show what the code did: the
tuples in the store, the rows of each live query, and the change events. Edit a
code cell and run it again.

Rebuild the page after a change to the library:

```bash
pnpm dx          # writes dx.html
pnpm dx:check    # writes it, then runs every example headlessly
```

## Develop

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc, the library and the demo
pnpm build         # tsc, writes dist/
pnpm check         # typecheck, test, and the demo page
```

`dx.html` is the developer-experience page, generated from `demo/`.
`design.html` is the design document. It holds the architecture, the compile
rules from the builder to tuple patterns, the type mapping, and a runnable
prototype. `CONTRACTS.md` is the interface between modules.

## Status

Early. The API can change. The data model, the URIs, the schema modes, and the
version contract follow the Go library, so a record written by the CLI reads the
same way here.
