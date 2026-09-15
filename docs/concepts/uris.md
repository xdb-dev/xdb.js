---
title: URIs
description: The xdb:// address of a namespace, a schema, a record, or one attribute.
module: "@xdb-dev/xdb"
---

# URIs

After this page, you can write the URI or the bare path for any level of data.

## URI form

```
xdb://ns/schema/id#attr
```

## Depth

| Depth | Example | Addresses |
| --- | --- | --- |

## Bare paths

```ts
// Example: parseURI('app/posts/p-1') and parseURI('xdb://app/posts/p-1').
```

## Scopes

```ts
// Example: inScope('app/posts', 'app/posts/p-1').
```

## Valid components

<!-- Empty parts, slashes, #, and whitespace throw INVALID_URI. -->

## URI functions

| Function | Returns |
| --- | --- |
