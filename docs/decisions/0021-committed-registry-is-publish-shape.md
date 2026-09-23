# ADR-0021 — Committed registry is publish-shape; local development is registry-free

**Status:** ACCEPTED (2026-09-23). Amends ADR-0003 (Migration); operationalises ADR-0005 §4.
**Owner:** pseudosky.
**Grounding:** `scripts/build-index.ts`'s default mode recomputing every registry row from local
disk bytes — including the `npm-package:` rows ADR-0005 §4 pins to published npm bytes — is the
exact outage class that shipped `@adhd/sox-cli@1.2.1` with a bundled registry of 31 `file://`
sources stamped `+dirty` (PROD-BREAK-SOXCLI-121) and the memory-server CHECKSUM MISMATCH outage
hand-repaired in commit `304513c4`. `libs/install-engine/src/install.ts:733-740`
(`findLocalExtension`, called from the resolver at `install.ts:735` and `install.ts:1008`) already
installs an unregistered extension straight from its local dir via a `file://` source with **no**
checksum comparison — the local-development path this ADR sanctions already existed and needed no
registry write. `tools/repin-registry-entry.mjs:94-97` (`const entry = index.find((e) => e.id ===
id); if (!entry) { …; process.exit(1); }`) already refuses to operate on an id absent from
`registry/index.json`, confirming it can only correct an already-published row, never create one.
`scripts/build-index.ts`'s `loadCommittedPins`/pin-preservation logic (documented inline as
"PUBLISHED-BYTES PIN PRESERVATION") keeps a committed checksum whenever the *regenerated* locator
is still `npm-package:`-shaped and unchanged — but that branch only fires in release mode
(`resolveSource`, `scripts/build-index.ts:306-317`): in DEFAULT mode `SOX_REGISTRY_PUBLISH` is
unset, so `resolveSource` returns `file://${extDir}` unconditionally and every `npm-package:` row
IS rewritten. Default-mode `build-index` refusing to touch a published pin at all is not yet
current behavior — it is added by the pin guard on branch `fix/build-index-pin-guard` (backlog
`4d1a3bf9`): a `PinLossError` thrown on any rewrite or drop of an `npm-package:` row in default
mode, and a stderr warning (not a throw) on a drop in release mode.
**Relates to:** ADR-0003 (extension identity is content-addressed — unchanged by this ADR; only
*when/who* writes the registry changes, not the identity model), ADR-0005 §4 (the `npm-package:`
install mode / `SOX_REGISTRY_PUBLISH` signal this ADR names as the sole non-repin write path).

## Context

Before this ADR, `scripts/build-index.ts` in its default mode — and the `npx nx run
registry:sync-index` target that wraps it — rewrote every entry in `registry/index.json` from
whatever bytes happened to be on local disk, including the small set of `npm-package:` rows ADR-0005
§4 pins to published npm bytes. Documentation across the repo (AGENTS.md's "AGENT SEQUENCE", the
sox-ingest skill, `docs/guidelines/authoring.md`, `docs/spec/service-lifecycle.md`,
`docs/standards/extension-bundling.md`) told every agent to run `registry:sync-index`/`build-index`
after *any* artifact rebuild, reinforcing the exact behavior that caused the outage: a local rebuild
with no version bump silently re-pinned a published row's checksum to local bytes that npm was not
serving, so the very next fresh install failed closed with `CHECKSUM MISMATCH`.

Separately, the install path never needed the registry write in the first place. An extension with
no row in `registry/index.json` resolves via `findLocalExtension` and installs from a `file://`
source with no checksum gate at all — a completely valid, already-shipped local-development path
that the "rebuild → regenerate registry" instruction pattern obscured rather than used.

## Decision

**`registry/index.json` holds only release-produced rows. Local development never writes it.**

- **Only two writers.** `build-index:publish` (`SOX_REGISTRY_PUBLISH=npm npx tsx
  scripts/build-index.ts`, wired into `release:prepared`) writes rows — including a package's
  **first** row — at publish time. `tools/repin-registry-entry.mjs` corrects an
  **already-published** row's checksum against what npm currently serves; it looks the id up in the
  existing index and exits non-zero if the row does not exist, so it structurally cannot create a
  first row.
- **No row → no gate.** An extension absent from `registry/index.json` installs from its local dir
  via `findLocalExtension` with no checksum comparison. This was already true; this ADR makes it
  the sanctioned path for local development rather than an accidental side effect masked by
  "always regenerate the registry" instructions.
- **Default-mode `build-index` refuses to rewrite or drop a published pin.** Enforced by the pin
  guard (`fix/build-index-pin-guard`, backlog `4d1a3bf9`), not by pin preservation — preservation is
  the release-mode behavior that keeps an unchanged `npm-package:` locator's checksum when
  `SOX_REGISTRY_PUBLISH` is set. In default mode the guard throws `PinLossError` on any rewrite or
  drop of an `npm-package:` row; in release mode a drop is surfaced as a stderr warning rather than
  silently shrinking the committed set (a rewrite in release mode is the intended re-pin).
- **`registry:sync-index` is retired as a workflow step.** With the guard in place, default-mode
  `build-index` outside a release refuses outright while any `npm-package:` pin exists in
  `registry/index.json`, and no documented workflow instructs anyone to run it. Its own header
  comment already says its remediation advice ("re-sync with registry:sync-index") must never be
  followed to fix a red gate (`scripts/check-registry-sync.ts`).

## Consequences

- `registry:sync-index` is retired from every canonical workflow sequence (see AGENTS.md § registry
  is release-only). The `libs/registry:sync-index` nx target is removed; the only remaining callers
  of `scripts/build-index.ts` are `build-index`/`build-index:publish` (package.json scripts) and
  `release:prepared`.
- The `CHECKSUM MISMATCH` remedy changes from "regenerate the registry" (which was the defect) to:
  install from local (no row needed) or repin via `tools/repin-registry-entry.mjs` if the row is
  already published and genuinely wrong.
- Pre-release drift between local artifacts and the committed registry is not a bug to fix locally —
  it is caught, if it matters, by `git diff --exit-code registry/index.json` staying clean through
  the normal lint → build → typecheck/test → smoke → commit sequence, since that sequence never
  touches the file.
- ADR-0003's Migration section, written when every artifact touch was followed by
  `registry:sync-index`, is amended in place (its historical phase-by-phase design record is
  otherwise unchanged — the identity decision itself does not move).

## What does NOT change

- ADR-0003's content-addressed identity model (`id` + checksum) is untouched — this ADR only
  changes who writes the pin and when, never what the pin means.
- ADR-0005 §4's `npm-package:` install mode and the `SOX_REGISTRY_PUBLISH` publication signal are
  unchanged; this ADR names that signal as the sole legitimate write trigger rather than adding a
  new mechanism.
- The published-bytes network assertion (`pnpm check-published-bytes` /
  `scripts/check-registry-sync.ts --published-bytes-only`) is unchanged and remains the CI gate.
