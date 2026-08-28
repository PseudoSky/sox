# @adhd/sox-blob-store

## 0.2.10

### Patch Changes

- Updated dependencies [d9a5023]
  - @adhd/sox-store-adapter@0.8.0

## 0.2.9

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.7.0

## 0.2.8

### Patch Changes

- **graph-store**: `engineIdentity` and `supportsRecursiveCte` now resolve correctly under the adapter's lazy-connect (BL-580/BL-581) — both previously snapshotted at construction, so `engineIdentity` cached `null` permanently and `supportsRecursiveCte` read a value captured before any connection existed. Backup residue is now reclaimed with a bounded sweep. A semicolon inside a SQL comment was being split into a phantom statement. Indexed the predicate the hot queries actually use, across all three DDL surfaces — a 11.9s delete became 15ms.

  **embedding-provider**: fastembed child pooling is concurrency-adaptive with abort plumbing (BL-575/576), breaking embed head-of-line blocking. The pool's grow trigger now has a real time dimension rather than firing on instantaneous depth, and auto-sizing accounts for macOS reclaimable memory — `os.freemem()` excludes inactive/speculative/purgeable pages, so the pool previously sized itself against a number far below the memory actually available.

  **blob-store**: internal workspace dependency ranges float (`workspace:^`) so published consumers are not pinned to an exact internal version.

- Updated dependencies
  - @adhd/sox-store-adapter@0.6.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.5.3

## 0.2.6

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.5.2

## 0.2.5

### Patch Changes

- Updated dependencies [62c72a9]
- Updated dependencies [0a588bf]
  - @adhd/sox-store-adapter@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies [32275f7]
  - @adhd/sox-store-adapter@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.2.0

## 0.2.1

### Patch Changes

- @adhd/sox-store-adapter@0.1.1
