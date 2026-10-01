# `_shared.md` — store-concurrency

Glossary, invariants, and reference patterns shared by every segment of this plan.

## Glossary

- `[def:read-open]` Any open of a store that is *intended* to be read-only but is
  not side-effect-free on the filesystem. In this substrate it is the
  `TursoAdapterImpl.connect({ readonly: true, allowFtsInReadonly: true })`
  "soft-readonly" connect — a **native-writable** handle (BL-391, the price of
  `fts_match`). It **creates** a `-tshm` and may create `-wal`/`-shm`.
- `[def:sidecar]` A store file beside the main db whose name is the db path plus a
  suffix: `-tshm` (Turso WAL-index coordination), `-wal` (write-ahead log),
  `-shm` (classic SQLite shared-memory index), `-tshm.stale-<stamp>` /
  `-shm.stale-<stamp>` (forensic rename targets), `.sidecar-sweep-marker`,
  `.sox-lease.d/`.
- `[def:artifact-set]` The full set of sidecars beside a store at an instant,
  captured by `listFileArtifacts`/`snapshotSidecarArtifacts` (`store-rebuild.ts:450`).
  The unit of ownership comparison — **never** a boolean.
- `[def:quiescent]` `storeQuiescence(path).quiescent` — no live peer holds the
  store. `storeOpeners(path)` additionally reports live/unknown openers.
- `[def:rename-aside]` The only permitted removal of a content-dead sidecar:
  `renameSync(sidecar, staleSidecarPath(sidecar))` (BL-1010e417 / BUG014.T3). Never
  `unlink`.

## Invariants

- `[inv:read-owns-nothing]` A read-open may create sidecars; it may never destroy
  one it did not create. (DESIGN §2.)
- `[inv:snapshot-not-boolean]` Ownership is decided by a **full-set** snapshot
  taken before the open, never by a boolean or a single path. (DESIGN §2.)
- `[inv:rename-not-unlink]` Under non-quiescence, remove nothing; the sole
  permitted sidecar action is rename-aside of a content-proven-dead sidecar.
- `[inv:rename-target-excluded]` A `.stale-*` minted by renaming a **pre-existing**
  sidecar is not attributable to the open and must survive its cleanup (0086e8cd).
- `[inv:no-weakened-assertion]` A test that skips the failing case does not count
  (BL-225). "Allowed failure count" is a skipped case in disguise.
- `[inv:no-empty-catch]` Every error path traces via `@adhd/sox-telemetry`.
- `[inv:serialize-s1-s2]` S1 lands before S2 (overlapping files; S2 asserts S1's
  invariant).

## Reference patterns

- `[ref:full-snapshot]` `store-rebuild.ts:770` — `listFileArtifacts(canonical,
  event)` **before** the open; `:771-772` `removeCreatedArtifacts(canonical,
  before, event)` after. The model for S1.
- `[ref:soft-readonly-mints-tshm]` `store-rebuild.ts:758-768` (comment) — the
  soft-readonly open creates the `-tshm`; a `--dry-run` must leave the store
  byte-identical (BUG-2e232ee9).
- `[ref:test-seam]` `store-rebuild.ts:665` `_beforeSwap?()` — a test-only awaited
  hook in the critical window. The shape for S2's `-tshm` create-then-write seam.
- `[ref:message-marker-predicate]` `errors.ts:468` `isTshmCoordinationInitRace` —
  match driver message TEXT, never `err.code` (Turso reports `GenericFailure`
  always).
- `[ref:naive-vs-barrier]` `fixtures/tshm-init-race-child.ts:29-40` — for THIS
  race, naive concurrent spawn reproduces (~1.5-3 %) where a READY/GO barrier
  does not; do not "fix" a race by adding a barrier that narrows it.
