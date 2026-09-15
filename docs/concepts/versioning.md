---
title: Versioning
description: The _id, _version, and _updated system attributes, and the version precondition on a write.
module: "@xdb-dev/xdb"
---

# Versioning

After this page, you know the system attributes on each record and the cause of a `CONFLICT` error.

## System attributes

| Attribute | Type | Value |
| --- | --- | --- |
| `_id` | | |
| `_version` | | |
| `_updated` | | |

## Version preconditions

```ts
// Example: store.apply with version: 1 on a record at version 2.
```

## Collection writes carry the version they read

<!-- update and delete send the _version from the read. -->

## Stale writes

```ts
// Example: isXDBError(err, 'CONFLICT').
```
