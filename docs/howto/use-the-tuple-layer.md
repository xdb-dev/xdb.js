---
title: Use the tuple layer
description: Read and write single attributes, list records, run pattern queries, and watch changes without a collection.
module: "@xdb-dev/xdb"
read_when:
  - You write a migration or a developer tool
  - You work with data that has no schema
  - You need a query that the builder cannot express
---

# Use the tuple layer

After this page, you can work with tuples and records directly, without a collection.

## Read and write one attribute

```ts
// Example: db.tuples.get, db.tuples.put, db.tuples.delete.
```

## Read and list records

```ts
// Example: db.records.get, db.records.list with filter, limit, and offset.
```

## Run a pattern query

```ts
// Example: db.query with find and one pattern.
```

## Join records with a shared variable

```ts
// Example: two patterns that share ?u.
```

## Filter with a predicate

```ts
// Example: '?views > 100'.
```

## Match an attribute that can be absent

```ts
// Example: a { opt } pattern.
```

## Watch a scope for changes

```ts
// Example: db.watch('xdb://app/posts', cb).
```

## Commit tuple writes as one batch

```ts
// Example: db.tx with two apply calls.
```
