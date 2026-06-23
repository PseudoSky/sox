# ADR-0003 — Extension identity is content-addressed (`id + checksum`); per-extension semver is retired

**Status:** Accepted (2026-06-22). Supersedes the implicit per-extension-semver model that crept in with the nx migration (ADR-0001). **Supersedes** the proposed "make versioning real" tooling (BACKLOG BL-32) and the `SERVER_VERSION` one-off — both are withdrawn by this decision.

**Decision (one sentence):** An extension's identity is **`id` + content `checksum`** (the sha256 of its built entrypoint artifact); the extension's own `version` field is **removed from resolution, the lockfile key, bundle member constraints, and all integrity decisions**, surviving only as `compatibility.host` (host-runtime compatibility — a *different* thing) and, optionally, as a derived human label never hand-authored.

**Requirements it serves:** `DOD.md` C2, C4 (checksum integrity made the *sole* identity authority); A4, A8 (install/update simplified); B-series (authoring at scale — one source of version truth, not two).

---

## Context

The founder's recollection is correct, and the code confirms it: identity in this system was **always** `id + checksum`. Per-extension semver arrived as undifferentiated machinery with the nx migration and now produces only drift, not value.

Verified against the tree (branch `design/extension-identity-versioning`):

1. **One build per id — multi-version resolution never happens.** `registry/index.json` holds **14 entries, 14 unique ids, zero duplicates**. Therefore `resolveFromRegistry` (`libs/install-engine/src/install.ts:223`) filters `candidates = index.filter(e => e.id === id)` to a set that is **always size 1**, and the `semverSatisfies(candidate.version, versionSpec)` loop at `install.ts:235-239` is dead branch logic — it always returns `candidates[0]`. `semverSatisfies` itself (`install.ts:243`) has **exactly one caller** (that dead loop).

2. **Semver is migration sediment.** `git log -S semverSatisfies` lands the version-resolution client in the nx-migration line (`32e81e1` engine-libs / the "install client + registry index" work `d894b63`), not in the original design.

3. **The lockfile key's version is cosmetic.** Install writes keys as `` `${entry.id}@${resolvedVersion}` `` (`install.ts:605`), but every *read* strips back to the bare id: `findLockKey` matches `` `${id}@` `` prefix (`install.ts:936`), and frozen-lockfile verification looks up by id, not by `id@version` (`install.ts:472`). The version in the key is decoration; the **checksum** (`install.ts:609`) is what the system actually trusts.

4. **Integrity is already 100% checksum-based.** `fetchArtifact` verifies the entrypoint sha256 and throws `CHECKSUM MISMATCH` on any drift (`install.ts:360-369`). `resolveChecksum` / the C4 work checksum the **declared entrypoint** (built artifact), not source (`build-index.ts:182`, `install.ts:305-329`). Drift detection (`diff.ts`) is entirely content-hash based (`diff.ts:60-67,179`). Nowhere does any integrity, drift, or "is this current" decision consult `version`.

5. **Version is dual-written — the structural drift source.** Each extension's version lives in **both** `extension.json` and the nx `package.json`. BL-30 is the canonical failure: the manifest said `0.1.0` while the tool surface claimed `1.1.0`; install resolved `0.1.0` against a *matching* checksum — i.e. the checksum was right, the version was a lie, and **the version lie was invisible to every gate** because no gate checks it. Two hand-maintained sources of one fact, neither load-bearing, is pure drift surface.

6. **`compatibility.host` is the only legitimate semver — and is presently declared-but-unenforced.** It expresses *which host-runtime versions an extension supports* (`>=1.0.0 <2.0.0` in every registry entry). It is read into the registry (`build-index.ts:162`) and **printed** (`apps/sox/src/main.ts:2350`) but **never checked** at install or runtime (no `satisfies` call consumes it). It is a *different axis* from the extension's own version and must survive — but its (non-)enforcement is out of scope for this ADR (see Consequences).

### Load-bearing vs. vestigial verdict on `version`

| Consumer | File:line | Status | Verdict |
|---|---|---|---|
| `semverSatisfies` range matching | `install.ts:243` | only caller is the dead size-1 loop | **Vestigial** — delete |
| `resolveFromRegistry` version arg | `install.ts:223-240` | branch never taken (one build per id) | **Vestigial** — reduce to `id` lookup |
| Lockfile key `id@version` | `install.ts:605`; read at `:936,:472` | reads strip to bare id | **Cosmetic** — becomes `id`, integrity is checksum |
| Bundle `members[].version` (`^0.1.0`) | `install.ts:85,829-845` | conflict-warns on spec mismatch; resolution still picks the one build | **Vestigial** — members reference by id |
| `registry/index.json` `version` | `build-index.ts:248` | written, displayed | **Derived label only** (see Decision 6) |
| `package.json` version (nx) | dual-written | drift source (BL-30) | **Demote** to mechanical release bookkeeping, decoupled from identity |
| `compatibility.host` | `build-index.ts:162` | distinct axis (host compat) | **LOAD-BEARING — keep** (enforcement is a separate concern) |
| `memory_stats.tool_version` / serverInfo `version: '1.1.0'` | memory-server `index.ts:526,2120,2157` | hand-coded surface marker | **Replace** with content address (Decision 5) |

**Bottom line:** every use of an extension's *own* `version` is vestigial or cosmetic. None is load-bearing. The only load-bearing semver is `compatibility.host`, which is a separate field describing a separate thing.

---

## Decisions (Accepted)

1. **Identity = `id + checksum`.** An extension is identified by its `id` (stable name) and addressed by the sha256 `checksum` of its built entrypoint artifact (resolution order already established in C4: `manifest.entrypoint` → `dist/index.js` → `prompt.md`/`SKILL.md` → `extension.json`). The `(id → checksum)` binding is the identity. An artifact change *is* an identity change; an `id` can never silently map to two artifacts.

2. **Remove per-extension `version` from resolution and identity.**
   - Delete `semverSatisfies` and `compareSemver` (`install.ts:243-286`). They have no surviving caller.
   - Reduce `resolveFromRegistry(id, versionSpec, index)` to `resolveFromRegistry(id, index)` — a pure `id` lookup over the single registry build. (One build per id is the invariant; a future multi-build registry is an explicit, separately-decided change, not a latent capability we keep dead code for.)
   - `version` is **forbidden as a hand-authored field** in `extension.json`. The manifest schema drops it as an authored input.

3. **Lockfile key becomes `id`; the checksum is the integrity authority.** Lockfile shape:
   ```json
   { "lockfileVersion": 2,
     "resolved": {
       "memory-server": {
         "source": "file://…/dist/index.js",
         "checksum": "sha256:…",
         "resolved_at": "…",
         "bundle_id": "sox-memory-bundle"   // optional
       } } }
   ```
   `lockfileVersion` bumps to `2` to mark the key-format change. Reads already key by id (`findLockKey`), so consumer churn is minimal. The `id@version` form is gone.

4. **Bundles reference members by `id` (current build).** `members[]` becomes `[{ "id": "memory-daemon" }, …]` — no `version` / `^x.y.z` spec. The "bundle version conflict" machinery (`install.ts:827-841`) is deleted: with one build per id there is exactly one artifact to resolve, and the checksum gate catches any mismatch between what was pinned and what is on disk. (If two bundles must ever pin *different* artifacts of the same id, that is the same explicit multi-build decision as in Decision 2 — not solved by reintroducing per-extension semver.)

5. **Runtime self-reporting returns the content address, not a hand-typed version.**
   - `memory_ping` returns the **content address** of the running server: `{ id: "memory-server", artifact: "sha256:<full>", short: "<first 12 hex>", host_compat: "<compatibility.host>" }`. The short hash is the drift-proof, human-glanceable answer to "what code is this?"
   - `serve(..., { name, version })` no longer takes a hand-coded `version: '1.1.0'`. The MCP `serverInfo.version` is populated from the resolved artifact checksum (short hash) at startup, derived — never authored.
   - `memory_stats.tool_version: '1.1.0'` (the v1.1-surface signal at `index.ts:2120`) is replaced by **capability presence**, not a version string: report the set of registered tool names (e.g. `tools: [...]` already includes/excludes `memory_update`), so a client tests for the capability it needs rather than inferring it from a semver. `ENRICH_VERSION` (a genuine data-schema/enrichment-format version, not the extension's package version) is unaffected and stays.

6. **`version` may exist only as a *derived* label, never authored in two files.** If a human-readable version is wanted for display (`sox list`, registry rows), it is **derived at build/index time** from a single source — the nx `package.json` (release bookkeeping) — and **never** written into `extension.json`. The registry MAY carry a `displayVersion` for `sox list` cosmetics, clearly non-identity. Resolution, lockfile, bundles, and integrity never read it. This eliminates the dual-write (BL-30 class) entirely: one source, display-only, not a gate input.

7. **`compatibility.host` is preserved unchanged as the one legitimate semver.** It is a distinct field on a distinct axis (extension ↔ host-runtime). This ADR neither adds nor removes its (currently absent) enforcement — it only guarantees the field survives the version purge and is not conflated with the extension's own version. Whether/where to *enforce* `compatibility.host` at install/runtime is tracked separately.

---

## All-scopes integrity rule (org / user / project / local — identical)

The "is this current / needs upgrade?" decision and the integrity check MUST behave **byte-identically across all four scopes**. Each scope has its own lockfile via `getScopePath` (`install.ts:136-158`: org → `.extensions/org.extensions.lock`, user → `~/.config/extensions/extensions.lock`, project → `.extensions/extensions.lock`, local → `.extensions/extensions.local.lock`). The rule is scope-independent:

> **For an installed extension `id` at scope `S`: it is CURRENT iff the sha256 of the artifact at the resolved `source` equals the `checksum` recorded under key `id` in scope `S`'s lockfile. Any inequality ⇒ needs upgrade (re-resolve + re-pin). A missing lockfile entry ⇒ not installed. There is no version comparison anywhere in this decision.**

Binding-enforcement invariants (each must have a test, run **per scope** with a parameterized matrix `[org, user, project, local]`):

- **B1 — artifact change is detected.** Mutate the built artifact; `install`/`update` re-resolves and the lockfile checksum changes; `--frozen-lockfile` (which today verifies presence at `install.ts:472`) is strengthened to verify the **checksum** matches, not merely that the key exists — and FAILS on drift, identically in every scope.
- **B2 — id maps to exactly one artifact.** No path lets one `id` carry two distinct checksums within a scope's lockfile (the key is now `id`, so this is structural).
- **B3 — cross-scope parity.** The same `(id, artifact)` installed at two scopes yields the **same checksum** and the **same current/stale verdict**; the only difference is lockfile path.
- **B4 — tamper gate.** A checksum mismatch at fetch raises `CHECKSUM MISMATCH` (`install.ts:362`) identically regardless of scope.

A new parameterized suite (`install-engine/src/integrity.scope.spec.ts`, matrix over the four scopes) is the conformance gate for this ADR. "Tests pass against a stale `dist`" is not acceptance — per BL-4, build (`nx build`) before asserting, and prove the checksum verdict against the built `dist`.

---

## Consequences

**Less code, fewer drift surfaces.**
- Deleted: `semverSatisfies`, `compareSemver` (`install.ts:243-286`), the size-1 version loop in `resolveFromRegistry`, the bundle-version-conflict warning path (`install.ts:827-841`), and the `versionSpec` plumbing through bundle expansion.
- Eliminated: the `extension.json` ↔ `package.json` dual-write — the entire BL-30 failure class becomes structurally impossible (no authored version to disagree).
- Simplified: lockfile key, bundle `members[]`, registry entry (version demoted to optional display label).

**What gets better.**
- `memory_ping` / serverInfo now answer "what code is actually running?" with the content address — the question a human asks during a drift incident, answered drift-proof. BL-30 ("manifest 0.1.0, surface 1.1.0, both green") could not recur: there is no second number to disagree with.
- The integrity story is now *one* story (checksum), uniform across scopes, with a parameterized conformance gate instead of four ad-hoc paths.

**What this explicitly does NOT do (carve-outs).**
- `compatibility.host` stays; its enforcement is unchanged (still declared-not-checked) and tracked separately. This ADR forbids conflating it with the extension's own version.
- `ENRICH_VERSION` (memory data/enrichment-format version) is a genuine schema version, not a package version — untouched.
- `lockfileVersion` (the lockfile *format* version) is a format marker — untouched (bumped 1→2 to flag the key change).
- No multi-build-per-id capability is introduced. If that need ever arrives it is a fresh, explicit ADR — we do not keep dead semver code "just in case."

**Withdrawn by this decision.**
- **BL-32 "make versioning real"** — the premise (extensions need working semver) is rejected; identity is content-addressed.
- The **`SERVER_VERSION` one-off** — replaced by the derived content address in Decision 5.

---

## Migration

Phased; design-only here (do not implement under this ADR). Each phase is independently shippable and gated by `nx run-many build,lint,test` + the new scope-parity suite. Per the repo's C2/C4 sequence, any artifact touch is followed by `registry:sync-index` and an explicit-path commit.

**Phase 0 — Schema + invariants (no behavior change).**
- Mark `version` optional/deprecated in the manifest schema (`libs/manifest/src/index.ts`); add the scope-parity integrity suite (`integrity.scope.spec.ts`) asserting the checksum rule on **today's** code (it already holds — locks in the invariant before refactoring).

**Phase 1 — Resolution + lockfile (the core).**
- `resolveFromRegistry(id, index)` — drop `versionSpec`; delete `semverSatisfies`/`compareSemver`.
- Lockfile key → bare `id`; bump `lockfileVersion` to `2`; add a one-time reader that accepts legacy `id@version` keys and rewrites to `id` on next install (back-compat for already-installed scopes).
- Strengthen `--frozen-lockfile` to verify **checksum equality**, not key presence (B1).

**Phase 2 — Bundles.**
- `members[]` → `[{ id }]`; delete the bundle-version-conflict path. Re-emit `sox-memory-bundle`'s manifest; `registry:sync-index`.

**Phase 3 — Runtime self-reporting.**
- `serve()` derives `serverInfo.version` from the resolved artifact short hash; `memory_ping` returns the content-address object (Decision 5); replace `tool_version` with tool-name capability reporting. Remove the `'1.1.0'` literals (`index.ts:526,2120,2157`).

**Phase 4 — Version demotion + cleanup.**
- Remove `version` from `extension.json` files; if a display label is wanted, derive `displayVersion` at index time from `package.json` only. Regenerate `registry/index.json` via `registry:sync-index`; refresh per-scope lockfiles. Reality-verify a real spawned `memory-server` reports its checksum via `memory_ping`, and that `--frozen-lockfile` fails on a mutated artifact in all four scopes.

**Rollback:** Phases are additive-then-subtractive; the legacy-key reader (Phase 1) means an old lockfile still resolves, so a partial migration is never bricked.
