---
"@adhd/sox-store-adapter": minor
---

**BREAKING (behavior): `multiprocess_wal` is now opt-in on `TursoAdapter`, not opt-out.**

Previously any caller that did not mention the flag got it — `experimental: { multiprocessWal: false }`
was the only way out, and `capabilities.multiprocessWrite` defaulted `true`. Now you get it only by
asking:

```ts
// multi-process store — several OS processes open the same file
await createTursoAdapter({ dbPath, experimental: { multiprocessWal: true } });
```

`FEAT-SOX-001`'s own constraint list says *"Multi-process WAL must be opt-in (experimental, not
default)"*; the shipped code was the opposite. It is experimental upstream, coordinates through a
versioned `.tshm` on-disk sidecar whose stability upstream explicitly disclaims, is mutually
exclusive with MVCC, and causes Turso to reject `VACUUM`. Under BL-373 a stale `-tshm` left a real
store **permanently unopenable** after an ordinary restart, crash-looping the backend — the recovery
path in `TursoAdapterImpl.connect()` exists because of that incident. A consumer that never asked
for cross-process access should not inherit that class of failure, and single-process consumers lose
nothing: Turso's in-process WAL coordination is the engine's own default.

**Migration:** if more than one OS process opens the same store, pass
`experimental: { multiprocessWal: true }`. Everyone else does nothing.
`capabilities.multiprocessWrite` now mirrors what was actually requested, so it stays a truthful
description of the connection rather than a claim about the library.

The capability itself is untouched and fully supported — this changed a default, not a feature.
`index_method` remains unconditionally on for every connection (FTS depends on it), and is verified
independent of this flag in both branches.

Also in this release:

- **README** now documents three things consumers previously discovered by failing: a read-only
  Turso connection cannot run `fts_match`/`fts_score` (`Resource is read-only`) and needs
  `allowFtsInReadonly: true`; the `@tursodatabase/database` peer is **optional** while
  `createStoreAdapter()` defaults to Turso, so the quick-start install does not include the default
  backend; and Turso's own `experimental` option is an **array** (`['index_method',
  'multiprocess_wal']`), not this package's object form, with `index_method` required on every
  connection that runs FTS.
- `engines.node: ">=20"` and `publishConfig.access: public` (the only publishable package missing
  either).
