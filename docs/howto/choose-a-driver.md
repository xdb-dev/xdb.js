---
title: Choose a driver
description: Pick the memory or the IndexedDB driver, or write a driver and test it with the conformance suite.
module: "@xdb-dev/xdb/memory, @xdb-dev/xdb/idb, @xdb-dev/xdb/storetest"
read_when:
  - You select where a database stores its data
  - You write a driver for another storage API
---

# Choose a driver

After this page, you can select the driver for a database, or write a new driver and test it.

## Compare the drivers

| Driver | Import | Storage | Use for |
| --- | --- | --- | --- |

## Keep data in memory

```ts
// Example: createDB with memory().
```

## Persist data to IndexedDB

```ts
// Example: createDB with idb('myapp').
```

## Write a driver

```ts
// Example: an object that implements the Driver interface.
```

## Test a driver with the conformance suite

```ts
// Example: runDriverSuite inside a vitest file.
```
