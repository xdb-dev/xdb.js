---
title: Records
description: A record is the set of tuples at one path, and it decodes to a plain object.
module: "@xdb-dev/xdb"
---

# Records

After this page, you can predict the tuples that an object encodes to, and the object that tuples decode to.

## A record is the tuples at one path

```
// Diagram: one object and its tuples, side by side.
```

## Nested objects fold into dotted attributes

```ts
// Example: encodeRecord on an object with a nested author.
```

## Leaf values

<!-- Arrays, Date, and Uint8Array stay one tuple each. -->

## The `id` key lives in the path

```ts
// Example: decodeRecord turns _id into id.
```

## System attributes on read

```ts
// Example: decodeRecord with and without { system: true }.
```
