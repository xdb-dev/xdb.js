---
title: Use with React
description: Provide the store to a React tree and re-render components when their data changes.
module: "@xdb-dev/xdb/react"
read_when:
  - You show xdb.js data in React components
  - You move a component from TanStack DB to xdb.js
---

# Use with React

After this page, your components re-render when the rows they read change.

## Provide the store

```tsx
// Example: createDB, then XDBProvider with db.store around the app.
```

## Read a live query in a component

```tsx
// Example: useLiveQuery with a bare callback, and with the object form.
```

## Rebuild a query when props change

```tsx
// Example: useLiveQuery with a deps array that holds a prop.
```

## Use a Suspense boundary

```tsx
// Example: useLiveSuspenseQuery inside Suspense.
```

## Subscribe to a whole collection

```tsx
// Example: useCollection(posts).
```

## Read the store in a component

```tsx
// Example: useStore, then store.record.
```
