---
title: Write data
description: Insert, update, and delete items, group writes in a transaction, and save them to a server.
module: "@xdb-dev/xdb"
read_when:
  - You change data from a user action
  - You send writes to your own API
  - A write fails and you need to revert the UI
---

# Write data

After this page, you can change items at once in memory, save them to a server, and revert a failed save.

## Insert an item

```ts
// Example: posts.insert with one item, then with an array.
```

## Update an item through a draft

```ts
// Example: posts.update with a draft callback, for one key and for two keys.
```

## Delete an item

```ts
// Example: posts.delete.
```

## Wait until a write persists

```ts
// Example: await posts.insert(...).isPersisted.promise.
```

## Save a write to your server

```ts
// Example: onInsert, onUpdate, and onDelete handlers that call fetch.
```

## Group writes in one transaction

```ts
// Example: createTransaction, mutate over two collections, commit.
```

## Save a transaction with one function

```ts
// Example: createTransaction with a mutationFn.
```

## Roll back a transaction

```ts
// Example: tx.rollback before commit.
```

## Build an optimistic action

```ts
// Example: createOptimisticAction with onMutate and mutationFn.
```

## Handle a failed write

```ts
// Example: catch VALIDATION on insert, and a rejected isPersisted.promise.
```
