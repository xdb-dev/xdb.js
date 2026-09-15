---
title: Errors
description: XDBError, the error codes, and field issues.
module: "@xdb-dev/xdb"
---

# Errors

After this page, you can identify the cause of any error that xdb.js throws.

## XDBError

```ts
// The XDBError fields: code, message, uri, action, issues.
```

## Error codes

| Code | Cause | Thrown by |
| --- | --- | --- |

## Check an error code

```ts
// Example: isXDBError(err, 'VALIDATION').
```

## Field issues

```ts
// Example: err.issues after a failed insert.
```
