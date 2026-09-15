---
title: Stores
description: The TupleStore keeps the working set in memory, publishes each commit, and mirrors writes to a driver.
module: "@xdb-dev/xdb"
---

# Stores

After this page, you know the steps of a store write and the state of the store after a driver failure.

## The working set is in memory

<!-- Queries read the index, never the driver. -->

## Steps of a write

```
// Diagram: stage (enforce, version, index) -> publish -> driver queue.
```

## Driver write order

<!-- The write queue keeps driver ops in call order. -->

## Rollback on a driver failure

<!-- undo, publish the reversal, rethrow. -->

## Hydration

```ts
// Example: store.hydrate('app/posts').
```

## The tuple index

| Map | Key | Serves |
| --- | --- | --- |
