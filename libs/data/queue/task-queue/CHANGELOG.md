# @adhd/sox-task-queue

## 0.2.11

### Patch Changes

- 884e3e7: Rewrite the package README against real, executed behaviour.

  These packages published to npm with READMEs that were missing, wrong, or unusable:
  no install line, no runnable example, and in several cases relative links pointing
  outside the package directory — dead for every npm reader, since a tarball carries
  only the package's own directory plus a force-included README and LICENSE.

  Every README now has an install line and at least one example that was actually run
  against the built artifact, with real output. Every documented symbol is verified to
  exist in that package's own declarations.

  Packages built on `@adhd/sox-store-adapter` now state the concurrency properties they
  inherit from it: the default Turso backend mandates `multiprocess-wal`, so multiple
  processes hold concurrent write connections to one store file. The claim is scoped
  per package rather than asserted blanket-wide — packages whose default path is
  single-writer by construction say so.

  Corrections found by reading and running the code rather than trusting the prose:
  `sox-graph-store` described itself as a store "over SQLite" when it has no
  better-sqlite3 dependency and is built on StoreAdapter; `sox-hybrid-search` described
  itself as an unimplemented skeleton when its implementation is complete;
  `sox-embedding-provider` advertised a hash provider that exists in no factory branch;
  and `sox-tokenguard-core` documented `detectFqdn` as returning `<FQDN_1>` when it
  returns `<HOST_1>`.

- Updated dependencies [884e3e7]
  - @adhd/sox-store-adapter@0.9.0

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
