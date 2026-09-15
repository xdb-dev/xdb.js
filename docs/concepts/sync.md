---
title: Sync
description: The SyncSource contract, with a push side for local writes and a pull side for remote changes.
module: "@xdb-dev/xdb, @xdb-dev/xdb/sync"
---

# Sync

After this page, you know the contract that a sync source implements.

## The SyncSource interface

```ts
// The SyncSource, SyncContext, and SyncChange types from src/core/types.ts.
```

## Push side

<!-- push(mutations). A rejection rolls the mutations back. -->

## Pull side

<!-- start(ctx) writes changes in begin, write, and commit groups. -->

## Status

<!-- No collection calls a sync source in this release. -->
