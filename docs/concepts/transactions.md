---
title: Transactions
description: The transaction state machine, item mutations and tuple writes, and the revert on a failed save.
module: "@xdb-dev/xdb"
---

# Transactions

After this page, you know the order in which a transaction applies writes, persists them, and reverts them.

## A transaction collects writes

```ts
// Example: tx.mutate with two collection writes, then tx.writes.length.
```

## Item mutations and tuple writes

| Property | Level | Read by |
| --- | --- | --- |
| `mutations` | | |
| `writes` | | |

## States

```
pending -> persisting -> completed
                      -> failed
```

## Commit order

<!-- Snapshot, store.apply, then mutationFn or the handlers. -->

## Revert on a failed save

<!-- A rejection writes the snapshot back and rejects isPersisted.promise. -->

## Implicit transactions

<!-- A direct collection write creates and commits its own transaction. -->

## Store transactions

```ts
// Example: db.tx compared with createTransaction.
```
