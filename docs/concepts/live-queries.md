---
title: Live queries
description: Footprints, the change bus, rerun coalescing, and live query collections.
module: "@xdb-dev/xdb"
---

# Live queries

After this page, you know which writes make a live query run again, and when its subscribers receive rows.

## Footprints

```ts
// Example: the footprint keys of a join query.
```

## The change bus

```
// Diagram: commit -> change keys -> overlapping footprints -> rerun.
```

## Rerun coalescing

<!-- Several commits in one task give one rerun. -->

## Row delivery

<!-- A subscriber receives rows only when their JSON key changes. -->

## Live query collections

```ts
// Example: createLiveQueryCollection and the _live/<id> records.
```
