---
title: Query data
description: Read items with the query builder, join collections, aggregate, and keep a result live.
module: "@xdb-dev/xdb"
read_when:
  - You show a list that combines more than one collection
  - You need a count, a sum, or a group
  - You want a result that updates after each write
---

# Query data

After this page, you can build a query over one or more collections and subscribe to its rows.

## Read one collection

```ts
// Example: posts.get, posts.toArray, posts.subscribe.
```

## Start a query

```ts
// Example: q.from({ post: posts }) with no other stage.
```

## Filter rows

```ts
// Example: where with and, gt, and eq.
```

## Join collections

```ts
// Example: join, innerJoin, rightJoin, and fullJoin on post.author and user.id.
```

| Method | Rows it keeps |
| --- | --- |

## Shape the rows

```ts
// Example: select with fields from two aliases.
```

## Sort and page the rows

```ts
// Example: orderBy, offset, and limit.
```

## Group rows and aggregate

```ts
// Example: groupBy author, select count and sum, having count > 1.
```

## Remove duplicate rows

```ts
// Example: distinct.
```

## Use plain JavaScript in a query

```ts
// Example: fn.where with a regular expression.
```

## Keep a query live

```ts
// Example: db.live and subscribe.
```

## Use a query as the source of another query

```ts
// Example: createLiveQueryCollection, then from on its result.
```

## Know the order of the stages

<!-- The stage order from QueryBuilder.run. -->
