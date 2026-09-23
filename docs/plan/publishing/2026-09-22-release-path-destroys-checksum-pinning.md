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

## Recommended fix (not implemented — checksum axis is another agent's lane)

1. **Anchor the pin where regeneration reads it**: write the published-byte checksum into each
   `extension.json`'s `checksum` field. `resolveChecksum` already honours it, and the code comment
   says that is its intended purpose. The pin then survives `build-index`, `release:prepared`, and
   the smoke script.
2. **Reorder `release:prepared`** so the index is generated *after* `nx build sox`, or the published
   `sox` entry is always stale against the artifact shipped beside it.
3. **Make the smoke script non-destructive**: snapshot/restore `registry/index.json` in its trap, or
   operate on a copied tree.
4. **Re-point the CI drift gate** only after (1) — with the pin anchored in `extension.json`, a
   publish-signalled `check-registry-sync` becomes satisfiable, and the `manifest:check-registry`
   re-wiring is then correct rather than merely narrower.

## What is already fixed

`06aa9e79` guarantees the *shape* of the registry embedded in the published CLI (no `file://`, no
`provisional`, no `+dirty`) at build time and again at `prepack`/`prepublishOnly`. It deliberately
does not police checksum *values* — that is this document's axis.
