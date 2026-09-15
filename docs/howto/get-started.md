---
title: Get started
description: Install xdb.js, define two collections, and show a live joined query in React.
module: "@xdb-dev/xdb, @xdb-dev/xdb/idb, @xdb-dev/xdb/react"
read_when:
  - You use xdb.js for the first time
  - You want a working app before you read the concepts
---

# Get started

After this page, you have a React component that shows a live list of posts and their authors from IndexedDB.

## Install the package

```bash
# pnpm add @xdb-dev/xdb zod
```

## Define a collection for each schema

```ts
// Example: Post and User Zod schemas, then createCollection for each.
```

## Open the database

```ts
// Example: createDB with idb('myapp') and both collections.
```

## Write items

```ts
// Example: insert a user and a post, then update the post through a draft.
```

## Query across collections

```ts
// Example: db.live with a join on post.author and user.id.
```

## Show the rows in React

```tsx
// Example: XDBProvider around a component that calls useLiveQuery.
```

## Save writes to your server

```ts
// Example: an onInsert handler that sends the new post to an API.
```

## Next steps

<!-- Links to write-data, query-data, and the concepts index. -->
