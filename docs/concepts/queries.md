---
title: Queries
description: The pattern engine, and the rules that compile a builder query into patterns.
module: "@xdb-dev/xdb"
---

# Queries

After this page, you can read the pattern list that a builder query compiles to.

## Patterns

```ts
// Example: ['app/posts/?p', 'title', '?title'].
```

## Path slots

| Form | Matches | Binds |
| --- | --- | --- |

## Shared variables

```ts
// Example: two patterns joined on ?u.
```

## Optional patterns

| Clause | Behavior |
| --- | --- |
| `{ opt }` | |
| `{ optAll }` | |

## Predicates

```ts
// Example: '?views > 100' and '?a == ?b'.
```

## Builder compilation

```ts
// Example: a builder query and its compile().where.
```

## Stages after the pattern run

```
// Diagram: patterns -> anti-joins -> fn.where -> groupBy -> having -> distinct -> orderBy -> offset -> limit -> select.
```
