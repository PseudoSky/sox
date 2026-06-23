# Definition of Done — sox-ecosystem

The initial system is **done** only when it can **rapidly absorb many extensions of every type** —
each going `init → build → validate → install → run` with **zero manual conformance work**, on a build
that stays fast as the count grows — **and** the full command surface works.

**Verification rule:** "done" means verified against **reality** (the OS process table, real built
artifacts, the documented command forms) from a clean slate — *not* self-reported test output.

This supersedes and includes the earlier command-lifecycle DoD.

---

## A. Command surface — every command does its real job
- **A1 `init`** — scaffolds a **born-conformant** extension (builds + validates with zero hand-edits).
- **A2 `validate`** — manifest + entrypoint-reachability conformance.
- **A3 `search`** — finds extensions in the registry.
- **A4 `install`** — resolves + writes lockfile at the chosen scope.
- **A5 `start`** — host loads the lockfile, spawns + supervises extensions.
- **A6 `list` / `details`** — show installed **and RUNNING** state (scope, pid, source).
- **A7 `enable` / `disable`** — actually (de)activate the running process, not just set a flag.
- **A8 `update`** — re-resolves; never fails on stale registry checksums.
- **A9 `uninstall`** — stops **and** removes.
- **A10 `stop`** — clean teardown, **zero orphan processes** (verified against the OS).
- **A11 `exec`** — invoke a tool **through the running runtime** (not a throwaway session).
- **A12 flags** — both `--flag value` and `--flag=value` forms parse correctly (match `--help`).

## B. Authoring at scale — add many extensions of every type, fast
- **B1** `init <type>` is born-conformant for **all 7 types** (self-description, per-package `tsconfig`, `keywords`/`author`).
- **B2** Every type passes `init → build → validate → install → run`, **repeatably, no manual fixups**.
- **B3** Build graph **scales**: incremental/cached — only changed packages rebuild; fast at 50–100+ packages.
- **B4** Adding an extension **never red-bars** the whole tree (validate stays green).

## C. Foundational integrity
- **C1** Framework owns the build — generates each `dist/index.js`; **no hand-maintained `dist` mirrors**.
- **C2** Registry checksums stay current (CI drift gate) so `install`/`update` never break on drift.
- **C3** `build → validate --strict → typecheck → test` are **blocking** CI gates, in that order.
- **C4** Tests/gates check **reality** (process table, real artifacts), not bookkeeping records.
- **C5** The reference extension (memory MCP) works end-to-end: `memory_write` + `memory_recall`.
- **C6** Declared `permissions` are **enforced at runtime**, not merely validated.
- **C7** An extension can reuse shared internal code **without duplicating it or reaching into another extension's internals.**

---

## Explicitly OUT of scope (not part of this DoD)
- Ingestion / normalization / reinjection of external extensions (done *outside* the tool).
- Memory semantic quality — real embeddings, enrichment pipeline tuning.
