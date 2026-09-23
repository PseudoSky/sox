# The release path destroys the checksum pinning it is supposed to ship

**Date:** 2026-09-22 · **Author:** `cli-index-release` agent · **Status:** BLOCKER, unresolved
**Related:** commit `304513c4` (checksum pinning), commit `06aa9e79` (bundled-registry gate)

> Filed as a document because the backlog MCP server is down (`CONNECTION_CLOSED`) — this belongs
> in the graph as a `BL-*` item once it is reachable.

## Summary

`registry/index.json` was pinned to **published npm bytes** by `304513c4`. Every mechanism that
regenerates, verifies, or releases that file recomputes checksums from **local disk bytes**. The two
are different by construction, so:

1. The CI drift gate can never pass — with or without the publication signal.
2. `pnpm release:prepared` — the documented release command — **overwrites the pinning** as its
   first action, then publishes the result.
3. `scripts/acceptance/clean-room-smoke.sh` — the documented canonical pre-publish gate — **also**
   overwrites it, and does not restore it.

Following `PUBLISHING.md` verbatim would re-ship the exact defect `304513c4` fixed, at a higher
version number.

## Evidence

### The pinning has no durable anchor

`resolveChecksum` (`scripts/build-index.ts:330-356`) honours `manifest.checksum` from
`extension.json` first — "If the manifest already has a checksum (set by CI on publish), use it" —
and otherwise checksums the local entrypoint (`computeFileChecksum(extDir/dist/index.js)`).

`304513c4` touched **only `registry/index.json`**; no `extension.json` carries a `checksum` field:

```
memory-cli: manifest.checksum = <ABSENT>
memory-flush: manifest.checksum = <ABSENT>
memory-server: manifest.checksum = <ABSENT>
sox: manifest.checksum = <ABSENT>
sox-memory-bundle: manifest.checksum = <ABSENT>
```

So the pin lives in a file that every regeneration rewrites, with nothing to restore it from.

### Three-way checksum divergence (measured)

| extension | local `dist/index.js` now | committed (`304513c4`, = npm bytes) | pre-remediation committed |
|---|---|---|---|
| memory-cli | `b1ec63b78a7a8645` | `b2935bd16d305…` | `c685c53599d81…` |
| memory-flush | `afbdfc5d72c429ff` | `891e1c2c0465e…` | `d530fcac2eff7…` |
| memory-server | `e37ff9de9ecd4351` | `6a4168d7ac0a2…` | `4ea748572b1e8…` |
| sox | `2bd3ddec1cdc4d3e` | `b31388ad87e96…` | `7377e85ecf521…` |

Local bytes match **neither** committed generation — `dist/` is a moving target rewritten by every
agent's build. Any disk-derived gate compares against a value that changes under it.

### The CI drift gate is unsatisfiable *both* ways

`ci.yml:105-109` and `validate.yml:77-81` run bare `pnpm build-index` then
`git diff --exit-code registry/index.json`.

Bare `npx tsx scripts/check-registry-sync.ts` → **exit 1**, 25 extensions "on disk, missing from
registry" plus all 6 entries differing (the bare run emits the dev `file://` variant of 31 entries).

With the publication signal → still **exit 1**:

```
check-registry-sync: FAIL — registry/index.json is out of sync with disk.
  Disk: 6 entries  Registry: 6 entries
  ~ content differs for: memory-cli
  ~ content differs for: memory-flush
  ~ content differs for: memory-server
  ~ content differs for: sox
```

Those are **exactly** the four entries `304513c4` corrected. Re-wiring the workflows to
`manifest:check-registry` (`libs/manifest/project.json:57-69`) therefore does **not** produce a green
pipeline; it narrows the failure from 31 entries to the 4 deliberately-pinned ones. The gate's
premise — "the registry should equal what the local tree hashes to" — is incompatible with pinning
to published bytes. `check-registry-sync.ts` is confirmed read-only (no `writeFileSync`; verified by
sha256 before/after), so it is safe to run, just not satisfiable.

### `release:prepared` overwrites the pinning before publishing

```
release:prepared = release-consumers && build-index:publish && nx build sox && changeset publish
```

`build-index:publish` (`package.json:16`) is `SOX_REGISTRY_PUBLISH=npm npx tsx scripts/build-index.ts`,
which **writes** `registry/index.json` from local bytes. Observed directly this session: an
invocation of `buildIndex()` rewrote all six checksums to the local-byte values in the table above
and stamped `provisional: true` / `+dirty` (restored with `git restore`).

Second, independent defect in the same line: `build-index:publish` runs **before** `nx build sox`, so
the `sox` entry is checksummed from the *pre-rebuild* artifact and is stale against the very binary
the same command then builds and publishes.

### The canonical smoke gate has the same side effect

`scripts/acceptance/clean-room-smoke.sh:73` runs `SOX_REGISTRY_PUBLISH=npm npx tsx
scripts/build-index.ts` against the real repo, and its `cleanup` trap (`:34-38`) only kills
verdaccio — `registry/index.json` is left rewritten. Line 69 additionally runs
`npx nx run-many -t build`, which rebuilds every `dist/` in the checkout, including the one the live
memory service executes (BL-235).

## The `sox` entry cannot be pinned before the publish exists

`sox`'s committed checksum `b31388ad…` is pinned to sox-cli@**1.2.1**'s published bytes. Publishing
1.2.2 produces a different `dist/index.js`, so that entry is *necessarily* stale the moment a new
version ships. It cannot be pre-pinned. The only correct ordering is
**build → publish → checksum the unmodified `dist` → commit** — which is exactly what
`release.yml:111-113` does *after* publish, and exactly what `release:prepared`'s *pre*-publish
regeneration breaks.

This is why local `2bd3ddec` matches neither committed value: `apps/sox/dist` was rebuilt today,
after 1.2.1 shipped. **The defect is ordering, not a missing anchor.**

## Options (not implemented — the checksum axis is another agent's lane)

1. **Reorder `release:prepared`** so the index is generated *after* `nx build sox` — or, better, not
   at all pre-publish, leaving `release.yml`'s existing post-publish regeneration as the single
   writer. Unambiguous win.
2. **Make the smoke script non-destructive**: snapshot/restore `registry/index.json` in its `trap`,
   or operate on a copied tree. Unambiguous win.
3. **Re-pointing the CI drift gate is NOT sufficient on its own** (measured above) and should wait
   until the writer story is settled.

### Rejected: anchoring the pin in `extension.json.checksum`

Superficially attractive — `resolveChecksum` honours `manifest.checksum` first, and its comment says
that is the intended purpose. But setting that field has a second, unwanted effect at
`build-index.ts:300-303`:

```ts
if (manifest.checksum) {
  return `https://cdn.jsdelivr.net/npm/${pkgName}@${resolveDisplayVersion(extDir)}/dist/index.js`;
}
```

In publish mode this is shadowed by the `SOX_REGISTRY_PUBLISH` branch above it, so `npm-package:`
still wins. But in a **dev** build it flips every source from `file://` to a single-file jsdelivr
URL — and per `PUBLISHING.md`, that fetch cannot deliver the transitive native deps
(`better-sqlite3`, `sqlite-vec`) the `npm-package:` install mode exists to provide. It would also
pass the `06aa9e79` gate silently, since `https://` is accepted as portable.

Anchoring therefore trades a release-path defect for a broken local dev path. It needs a design
decision, not a unilateral change.

## The clean-room gate cannot run in a shared checkout (measured 2026-09-22)

With the trap fix in place, the smoke was run. It died at step 3 and the restore guard reported
`registry/index.json unchanged` — the pin was never written, because `build-index` refused first:

`buildIndex` raises `DirtyTreeError` (`build-index.ts:28`, `:540-546`) when the tree has any
**checksum-relevant** uncommitted path. At the time of the run those were two untracked files
belonging to other agents:

```
  IRRELEVANT: .research-trace/2026-09-20-retrieval-augmented-decision-reassessment.md
  >>> CHECKSUM-RELEVANT (blocks build-index): SPEC-EMBEDDING-HOST.md
  IRRELEVANT: docs/plan/store-adapter-batch-0.10.0/SPEC.md
  >>> CHECKSUM-RELEVANT (blocks build-index): tools/reap-nx-daemons.mjs
```

Neither is a source change; both are new files at paths outside the `CHECKSUM_IRRELEVANT_PREFIXES`
allow-list, which **fails closed** by design. So:

**The canonical publish gate is unrunnable whenever any concurrent agent holds an untracked file
outside `docs/`, `.claude/`, `.opencode/`, `.worktrees/`, `.nx/`, `.cto/`, `.research-trace/`.**
It also fails *silently*: `clean-room-smoke.sh:73` redirects the command's output to `/dev/null`, so
`set -e` aborts the script with no diagnostic — the log jumps straight from "regenerating registry"
to the cleanup line. Anyone running it sees an early exit and no reason.

Forcing it with `--allow-dirty` is not a workaround: that stamps `provisional: true`, which the
`06aa9e79` gate then correctly refuses. That is the system working — a publishable artifact cannot
be produced from a dirty tree — but it means the gate must be run from a **clean clone or
worktree**, never the shared development checkout.

### Side effect: the smoke rebuilt the live memory-server artifact

`clean-room-smoke.sh:69` runs `npx nx run-many -t build` across the whole workspace. Measured across
the run:

| artifact | before | after |
|---|---|---|
| `registry/index.json` | `042973a0…` | `042973a0…` (intact) |
| `apps/sox/dist/index.js` | `e52db888…` | `e52db888…` (intact) |
| `memory-server/dist/index.js` | `e37ff9de…` | **`564840c4…`** (rebuilt) |

That is the artifact the live memory MCP service executes directly out of this checkout. No service
was restarted, so the running process still holds its previously-loaded code — but the next restart
adopts the new bytes. The rebuild was from committed source (no tracked file was modified), so the
new artifact is *more* attributable than the one it replaced, not less. Still: the canonical gate
silently rebuilds a live production artifact as a side effect, which belongs in its header and in
any clearance to run it.

## The candidate artifact WAS verified end to end — against real npm, not verdaccio

Since the verdaccio script is unrunnable here, the candidate 1.2.2 artifact was instead tested
directly, which is stronger evidence for this particular break: it exercises **the exact bytes that
will ship** (not a rebuild of them) and resolves members from **real npm** (not a local mirror).

`npm pack` in `apps/sox` → tarball carrying `dist/index.js` `e52db888…` and
`dist/registry/index.json` `042973a0…` (6 entries, 0 `file://`, 0 provisional). Installed with
`npm i -g --prefix` under an isolated `HOME`, from a cwd with **no repo checkout** so
`loadRegistryResolved` is forced onto the embedded copy — the exact fresh-machine path that failed
in 1.2.1.

- **G1** — `soxe --version` → `1.2.1`; `soxe search` lists the public entries with **zero** `/Users/`
  occurrences. (1.2.1 leaked a maintainer's home directory here.)
- **G2 install** — `soxe install sox-memory-bundle --scope user` → exit 0, all four members resolved
  from npm at **exactly** the checksums `304513c4` pinned:
  `memory-server 6a4168d7…`, `memory-flush 891e1c2c…`, `memory-cli b2935bd1…`,
  `memory-usage 35441a13…`. **This is the first confirmation that the pinning is byte-correct
  against real npm** — the checksum gate was reached and passed, where 1.2.1 never reached it.
- **G2 runtime** — `memory_ping` over direct stdio → `"ok":true` and
  `"artifact":"sha256:6a4168d7ac0a…"`, matching the pinned value; real embedding model loaded.
  (`store_ok:false` is expected for a bare probe — BL-412 refuses to guess a store path without a
  host-injected `SOX_CONFIG_DB_PATH`. The canonical gate asserts only `ok:true` plus the content
  address, both green.)

So the production break is fixed in the candidate artifact, and both remediation axes — shape
(`06aa9e79`) and checksum values (`304513c4`) — are verified together.

## What is already fixed

`06aa9e79` guarantees the *shape* of the registry embedded in the published CLI (no `file://`, no
`provisional`, no `+dirty`) at build time and again at `prepack`/`prepublishOnly`. It deliberately
does not police checksum *values* — that is this document's axis.
