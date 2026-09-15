---
title: Collections
description: A collection is a typed view over one schema in a store, with a load lifecycle and change subscriptions.
module: "@xdb-dev/xdb"
---

# Collections

After this page, you know what a collection holds, how it loads, and how it reports changes.

## A collection holds no data

```
// Diagram: collection -> TupleStore index -> driver.
```

## Binding and status

| Status | Meaning |
| --- | --- |

## Items and records

<!-- One item is one record at ns/schema/key. -->

## Writes go through a transaction

<!-- insert, update, and delete return a Transaction. -->

## Change subscriptions

| Method | Callback receives |
| --- | --- |

## Differences from TanStack DB

<!-- The parts of the TanStack DB collection surface that match, and the parts that differ. -->
