---
title: Schemas
description: Definitions, the strict, flexible, and dynamic modes, and how a collection derives a definition from Zod.
module: "@xdb-dev/xdb"
---

# Schemas

After this page, you can predict which writes a schema accepts and which writes it rejects.

## Definitions

```ts
// Example: a Def with ns, schema, mode, and fields.
```

## Schema modes

| Mode | Undeclared attribute |
| --- | --- |

## Declared field checks

<!-- Every mode coerces a declared field to its type. -->

## Required fields

<!-- A full write needs every required field. A delete cannot name one. -->

## Dynamic mode adds fields

```ts
// Example: store.def before and after a write with a new attribute.
```

## Definitions from Zod

```ts
// Example: defFromSchema on a Zod object.
```

## Validation and schema enforcement

| Check | Runs in | Error code |
| --- | --- | --- |
