---
title: Drivers
description: The Driver contract, the four write ops, and the storage layout of the memory and IndexedDB drivers.
module: "@xdb-dev/xdb, @xdb-dev/xdb/idb, @xdb-dev/xdb/memory"
---

# Drivers

After this page, you know the contract that every driver implements.

## Driver responsibilities

<!-- A driver stores tuples and definitions. It does no validation. -->

## The Driver interface

```ts
// The Driver interface from src/core/types.ts.
```

## Write ops

| Op | Path absent | Path present |
| --- | --- | --- |
| `create` | | |
| `put` | | |
| `patch` | | |
| `delete` | | |

## Optional methods

| Method | Purpose |
| --- | --- |
| `tx` | |
| `queryTuples` | |
| `close` | |

## Storage layouts

| Driver | Layout |
| --- | --- |
