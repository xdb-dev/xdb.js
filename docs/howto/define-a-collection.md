---
title: Define a collection
description: Create a typed collection for a schema, with Zod or without it, and pick where its data lives.
module: "@xdb-dev/xdb"
read_when:
  - You add a new kind of item to your app
  - You decide between strict, flexible, and dynamic schemas
---

# Define a collection

After this page, you can create a collection for each schema and control its types, its key, and its storage.

## Name the collection

```ts
// Example: a collection with a uri, and a collection with only an id.
```

## Validate items with a Zod schema

```ts
// Example: a Zod schema with a default and a transform.
```

## Read the derived field types

| Zod schema | XDB type |
| --- | --- |

## Override a field type

```ts
// Example: the types option sets a field to unsigned.
```

## Pick a schema mode

```ts
// Example: mode: 'flexible' on a Zod collection.
```

## Use a key other than `id`

```ts
// Example: getKey returns item.slug.
```

## Seed a collection with initial data

```ts
// Example: initialData with two rows.
```

## Use a collection without a schema

```ts
// Example: a dynamic collection that infers types from the first insert.
```

## Start from an options preset

### Keep UI state in memory

```ts
// Example: localOnlyCollectionOptions.
```

### Persist a collection to localStorage

```ts
// Example: localStorageCollectionOptions with a storageKey.
```

### Back a collection with an XDB schema

```ts
// Example: xdbCollectionOptions with a uri and handlers.
```

## Wait for a collection to load

```ts
// Example: await posts.preload(), and posts.status.
```
