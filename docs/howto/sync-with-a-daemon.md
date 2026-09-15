---
title: Sync with a daemon
description: The daemon sync source, the JSON-RPC calls it makes, and the parts that do not work yet.
module: "@xdb-dev/xdb/sync"
read_when:
  - You plan to mirror browser data to an XDB daemon
  - You debug the requests that the sync source sends
---

# Sync with a daemon

After this page, you know the requests the daemon sync source sends and receives, and which parts are not connected yet.

## Know the current limits

<!-- The collection does not call its sync source. The Go daemon has no HTTP listener. The SSE stream does not reconnect. -->

## Create a daemon sync source

```ts
// Example: daemon({ url, scope, pollMs }).
```

## Push local writes

| Mutation op | JSON-RPC batch operation |
| --- | --- |

## Pull remote changes

```ts
// Example: start(ctx) with a SyncContext that logs each change.
```

## Handle an unreachable daemon

```ts
// Example: catch UNAVAILABLE from push.
```
