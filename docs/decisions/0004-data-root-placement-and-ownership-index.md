# ADR-0004 — Data root (`SOX_ECOSYSTEM_HOME`) is split from the test sandbox switch; placement targets the real host; an ownership index makes installs reversible

**Status:** Accepted (2026-06-23). Refines the install/placement model of ADR-0002 and the scope/lockfile model touched by ADR-0003. Supersedes the overloaded `SOX_HOME` contract that conflated *data location* with *host-path rerouting*.

**Decision (one sentence):** `SOX_HOME` is replaced by **two orthogonal variables** — `SOX_ECOSYSTEM_HOME` (the **data root**, default `~/.adhd/sox-ecosystem/`, governing *only* where sox keeps its own bookkeeping) and `SOX_SANDBOX_ROOT` (the **test isolation switch**, the *only* thing that reroutes host placements) — and the framework enforces **`[inv:no-untracked-injection]` / `[inv:reversible-injection]`**: every config key, file, array value, and materialized store sox writes is recorded in an **explicit ownership index** and is verifiably reversible, with all config contributions flowing through the one general `config-merge` capability and a reversibility gate proving install→uninstall leaves host files byte-clean.

**Requirements it serves:** `DOD.md` A4/A8/A9 (install/update/uninstall correctness), C4 (reality gates — placement reaches the real host; uninstall leaves zero residue), B-series (placement at scale without manual cleanup). Closes **BACKLOG BL-39** (upgrade must re-materialize the service store).

---

## Context

`SOX_HOME` is **overloaded** — it is read by two unrelated subsystems with two unrelated meanings:

1. **Data root (legitimate).** `host-runtime` (`lock.ts:54`, `registry.ts:57`, `runtime.ts:106,198`) and `install-engine` (`install-registry.ts:43`) read `process.env['SOX_HOME'] ?? ~/.sox` to locate sox's *own* state: `install-registry.json`, `supervisors.json`, the per-process lock + runtime records.

2. **Host-path rerouting / test sandbox (a different thing entirely).** `host-registry` (`claude.ts:71 getBase()`, `codex.ts:121 getCodexBase()`, `internal.ts:117 expandHome()`) reroutes **every absolute user-scope host path** under `SOX_HOME` when it is set — `~/.claude/skills` becomes `$SOX_HOME/.claude/skills`. This exists so the install-probe e2e can assert *zero real-home writes* (`[inv:sandbox-isolation]`, tested in `host-registry.spec.ts:465`).

These two meanings collide catastrophically. The founder set `SOX_HOME=/Users/nix/dev/ai/claude-agents` **for data** (meaning 1) and silently tripped meaning 2: **every user-scope placement was rerouted** — the global memory-usage skill landed under `claude-agents/.claude/skills` instead of the real `~/.claude/skills`, and the user-scope memory MCP was written into `claude-agents/.claude.json` instead of `~/.claude.json`. Result: the global skill is stale and the memory MCP is unreachable by other Claude Code sessions/agents. The data-root setting *worked*; the invisible side effect (rerouting placements) broke the system. **One variable cannot mean both "where sox keeps its files" and "pretend the user's home is somewhere else."**

A second, independent defect compounds it. `cmdUninstall` (`apps/sox/src/main.ts:1851`) removes **only** the lockfile entry, the `extensions.json` entry, and the global install-registry record. It **never reverses the per-scope ledger** — so the placed skill files, the MCP config key, and the materialized `.sox/ext/<id>/` store **survive uninstall as orphans**. And `update`/`upgrade` (`install({mode:'update'})`) re-pins the lockfile checksum but **never re-materializes the service store** (BL-39) — leaving a running daemon on its *original* copied code after an "upgrade." The system can place files but cannot reliably *un*-place or *re*-place them, because **no single record says what an install owns.**

### Today's path landscape (the scatter this ADR consolidates)

| Concern | Current location | File:line |
|---|---|---|
| install-registry (global ledger) | `$SOX_HOME/install-registry.json` → `~/.sox/` | `install-registry.ts:43` |
| supervisors registry | `$SOX_HOME/supervisors.json` → `~/.sox/` | `registry.ts:57` |
| per-process lock | `$SOX_HOME/…` → `~/.sox/` | `lock.ts:54` |
| runtime records / logs | `$SOX_HOME/…` → `~/.sox/` | `runtime.ts:106,198` |
| user-scope lockfile/config | `~/.config/extensions/` | `install.ts:159`, `runtime.ts:822` |
| project lockfile/config | `<repo>/.extensions/` | `install.ts:164`, `runtime.ts:827` |
| per-scope ledger | `<scopeRoot>/.sox/ledger.json` | `ledger.ts:79` |
| materialized service store | `<scopeRoot>/.sox/ext/<id>/` | `install.ts:1230` |
| host placement (skill/MCP) | real host path, rerouted by `SOX_HOME` | `claude.ts`, `install.ts:1338` |

Three different roots (`~/.sox`, `~/.config/extensions`, `<scopeRoot>/.sox`) for one logical thing ("sox's data for a scope"). This ADR unifies them under `.adhd/sox-ecosystem/`.

---

## Decisions (Accepted)

### D1 — `SOX_ECOSYSTEM_HOME` is the data root; default `~/.adhd/sox-ecosystem/`

Rename `SOX_HOME` → **`SOX_ECOSYSTEM_HOME`**, an **optional** override read at call time (never at module load). It governs **only** the data root. Default is **`~/.adhd/sox-ecosystem/`** — *not* `~/.sox`, *not* a project directory. Setting it relocates sox's bookkeeping and **nothing else** — it has **zero** effect on where skills/MCP/agents are placed on a host.

`SOX_HOME` is removed, not aliased. A one-time migration (`soxe migrate-home`, D8) relocates an existing `~/.sox` (or a custom `$SOX_HOME`) to the new root. (No silent back-compat alias: an alias would re-introduce the overload — a stale `SOX_HOME` in a shell would keep rerouting placements. The variable's *meaning* changed; keeping the old name would be a lie.)

### D2 — Canonical per-scope layout: `.adhd/sox-ecosystem/`, rooted per scope

All sox data for a scope lives under a single deterministic root `<scopeRoot>/.adhd/sox-ecosystem/`:

| Scope | `dataRoot(scope, root)` |
|---|---|
| user / global | `$SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`) |
| project | `<project>/.adhd/sox-ecosystem/` (**deterministic — no per-project override**) |
| org | `<orgRoot>/.adhd/sox-ecosystem/` |
| local | `<project>/.adhd/sox-ecosystem/` (shares the project root; distinct lockfile name) |

Inside that root, the layout is identical across scopes:

```
.adhd/sox-ecosystem/
  extensions.json            # scope config (was .extensions/extensions.json or ~/.config/extensions/)
  extensions.lock            # scope lockfile          (local → extensions.local.lock)
  ledger.json                # per-scope provenance ledger (was <scopeRoot>/.sox/ledger.json)
  ownership.json             # NEW — the ownership index (D5)
  ext/<id>/                  # materialized service store (was <scopeRoot>/.sox/ext/<id>/)
  install-registry.json      # global only (user root) — every scope's installs (D6)
  supervisors.json           # global only (user root)
  run/                        # per-process locks, runtime.json, logs (was ~/.sox/…)
```

**Retired:** the scattered `<project>/.extensions/`, `<scopeRoot>/.sox/ext/`, `~/.config/extensions/`, and `~/.sox/` paths. A single `dataRoot()` resolver (in `host-runtime`, re-exported to `install-engine` and `apps/sox`) is the **one** place these paths are computed; `getScopePath`/`getScopePaths` are reimplemented on top of it so the three current duplicate resolvers collapse to one.

> Project scope is **deterministic by design** (`<project>/.adhd/sox-ecosystem/`). There is intentionally **no** per-project config knob to relocate it — predictability beats flexibility for a path every command must agree on.

### D3 — The sandbox switch moves to a dedicated variable `SOX_SANDBOX_ROOT`

The host-registry rerouting (test/probe isolation) is split **off** the data root onto a dedicated variable **`SOX_SANDBOX_ROOT`**. When — and **only** when — `SOX_SANDBOX_ROOT` is set, `expandHome()`/`getBase()`/`getCodexBase()` reroot absolute user-scope host paths under it (so `~/.claude/skills` → `$SOX_SANDBOX_ROOT/.claude/skills`). When it is unset, host placements target the **real** host path regardless of `SOX_ECOSYSTEM_HOME`'s value.

> **Invariant `[inv:data-root-never-reroutes]`:** setting `SOX_ECOSYSTEM_HOME` must never change a single host placement path. Rerouting is *exclusively* `SOX_SANDBOX_ROOT`'s job. This is the precise failure the founder hit, encoded as a test.

Every test and e2e harness that relied on `SOX_HOME` for isolation switches to `SOX_SANDBOX_ROOT` (and, where it also needed a private data root, additionally sets `SOX_ECOSYSTEM_HOME` to a temp dir). The `host-registry.spec.ts` sandbox suite (`§6`) is rewritten against `SOX_SANDBOX_ROOT` and gains the new `[inv:data-root-never-reroutes]` assertion: with `SOX_ECOSYSTEM_HOME` set and `SOX_SANDBOX_ROOT` unset, every user-scope surface path equals the real-HOME path.

### D4 — Placement targets the real host discovery path, independent of the data root

User/global-scope placement targets the **real** host paths, found by the host registry with `SOX_SANDBOX_ROOT` unset:

- **skills → `~/.claude/skills/<id>/`** (and `~/.codex/skills/<id>/` for codex);
- **user MCP → `~/.claude.json`** (verified on this machine — the global MCP config Claude Code reads; *not* `settings.json`), Codex → `~/.codex/config.toml`;
- agents/commands/rules/hooks → their real `~/.claude/...` discovery paths.

Project-scope placement targets `<project>/.claude/` (and `<project>/.mcp.json`) as today. The consequence the founder needs: **a user-scope install is reachable by every Claude Code session/agent on the machine**, because it lands in the real `~/.claude`.

### D5 — Ownership index: every install records exactly what it wrote

Introduce an explicit **ownership manifest** — `<dataRoot>/ownership.json`, keyed by `(extId, scope)` — recording every filesystem location and config key an install owns. It is the union of provenance that today is split between the per-scope ledger (config/array merges) and *nothing at all* (materialized stores, placed file-drops are only in the ledger, the install-registry is global-only). Shape:

```jsonc
{
  "version": 1,
  "owned": [
    {
      "extId": "memory-server",
      "scope": "user",
      "host": "claude",
      "artifactChecksum": "sha256:…",   // the content address placed (ADR-0003)
      "installedAt": "2026-06-23T…",
      "updatedAt": "2026-06-23T…",
      "entries": [
        { "kind": "file-drop",   "path": "/Users/nix/.claude/skills/memory-usage" },
        { "kind": "materialize", "path": "/Users/nix/.adhd/sox-ecosystem/ext/memory-server" },
        { "kind": "config-key",  "file": "/Users/nix/.claude.json", "keyPath": "mcpServers.memory-server", "appliedHash": "sha256:…" },
        { "kind": "array-values","file": "/Users/nix/.claude.json", "keyPath": "…enabledMcpjsonServers", "values": ["memory-server"] },
        { "kind": "lockfile-key","file": "/Users/nix/.adhd/sox-ecosystem/extensions.lock", "keyPath": "memory-server" },
        { "kind": "registry-record", "extId": "memory-server", "scope": "user", "root": "/Users/nix" }
      ]
    }
  ]
}
```

**Why a sibling index and not just the ledger.** The ledger (`ledger.ts`) is *portable-by-design* for project scope (repo-relative paths, no absolute/home paths — `assertPortableAction`) and only records shared-file merges richly. The ownership index is the *opposite*: a **complete, absolute-path** record of *everything* placed for *one install*, including the materialized store and the file-drops, deliberately **not** portable (it is machine-local truth for cleanup). The ledger stays the authority for *reversing shared-file merges* (its deny-wins array logic is non-trivial); the ownership index is the authority for *what an install owns end to end*. At install time the index entry is built from the same capability results the ledger records, plus the materialize result and the lockfile/registry keys — one write, populated from the install's own return values (no second source of truth to drift).

**Record points:** `install()` writes/updates the ownership entry after a successful install (the capability `results` already returned by `declarativeInstall` carry every `target` path; materialize and run-service add their store path; the lockfile key and registry record are known at the call site). `update`/`upgrade` refresh it.

### D6 — `uninstall`/`update`/`upgrade` consume the ownership index

- **`uninstall`** loads the index entry for `(extId, scope)` and removes **exactly** its `entries` — file-drops and materialized stores `rm`'d, config-keys/array-values reversed via the existing ledger reversal (so foreign keys stay untouched — `[inv:ledger-reversible]`), lockfile key + install-registry record deleted — then deletes the index entry. **Result: zero owned files survive, and nothing foreign is touched.** This replaces today's lockfile-only `cmdUninstall`, closing the orphan class (the stale global skill, leftover MCP keys, abandoned `ext/<id>/` stores).

- **`update`/`upgrade`** computes the **diff** between the *old* owned set and the *new* placement: any file/key the old install owned that the new one does not (e.g. a renamed skill dir, a relocated store) is **removed before** the new placement, then the new artifact is placed and the index re-recorded with the new `artifactChecksum`. Crucially, when the artifact changes, the **materialized store is re-copied** (the old `ext/<id>/` is cleared via its index entry and the new dist materialized) — **this is the BL-39 fix**: an upgrade that changes the artifact re-materializes the store, so a daemon never runs stale copied code after an upgrade.

> **BL-39 closure restated:** `install({mode:'update'})` will, for a `type:service`, consult the ownership index, detect the materialize entry whose `artifactChecksum` differs from the freshly resolved artifact, `reverse` (clear) that store, and re-`materialize` the new dist — before re-registering run-service. The re-pin and the re-materialize become one atomic step instead of the re-pin happening alone.

### D6a — Governing invariant: no untracked injection; every injection is verifiably reversible

This is the **framework contract** (uniform across every extension type, not memory-specific):

> **`[inv:no-untracked-injection]`** — *Nothing* sox places anywhere is allowed to exist without a corresponding ownership-index entry. "Anywhere" is exhaustive: a config key merged into a host file (global MCP registration in `~/.claude.json` / project `.mcp.json`, `.codex/config.toml` agent/MCP/hook keys, `settings.json` permissions), a file/dir dropped at a discovery path (`~/.claude/skills/<id>`, agents, commands, rules, hooks), an array value appended (MCP trust), and the materialized `ext/<id>` store — **all are recorded as first-class owned entries** at apply time, populated from the capability's own return value. An apply path that writes to a host without recording ownership is a framework defect, not a feature.

> **`[inv:reversible-injection]`** — *Every* recorded injection has a verifiable removal. `uninstall` consumes the ownership index and surgically reverses **exactly** what it placed — config keys removed via the applied-hash-tracked, foreign-key-preserving config-merge/array-merge reversal (`[inv:ledger-reversible]`); files/stores `rm`'d — leaving the host files **byte-clean of sox-owned content** while preserving every entry the user (or another tool) authored. An injection that cannot be cleanly reversed must fail at install time (`ReverseAbortError` semantics, `[dod.12]`), never land un-removably.

**config-merge is the one sanctioned config-injection path (generalized, not special-cased).** Any host-config contribution from any extension type — the global MCP server registration, agent/command/hook keys, codex `config.toml` entries — flows through the **existing** `config-merge` capability (`capabilities/config-merge.ts`): idempotent, applied-hash-tracked, format-aware (JSON + TOML), preserving the user's other entries. No extension type gets a bespoke config writer. The ownership index records the exact merged `keyPath` + `appliedHash` as a `config-key` (or `array-values`) entry alongside placed files, so the merge and its removal are one tracked unit. This generalizes the memory-server MCP registration to *every* injecting extension.

### D6b — The reversibility gate (born-conformance-style, per injecting extension)

Reversibility is proven by a gate modeled on the `init` born-conformance gates: for **every** extension that injects anything, the harness runs **install → assert injected → uninstall → assert zero residue**, and **fails** if any injection lacks a clean, verified removal. Concretely, woven into `test-e2e host-runtime`:

1. **install** the extension at a (sandboxed) scope; snapshot the target host files' pre-install bytes.
2. **assert injected** — the ownership index lists the entry; each owned thing is present (skill dir exists, MCP `keyPath` resolves in the host config, the `ext/<id>` store exists, array values present).
3. **uninstall** — consume the ownership index.
4. **assert zero residue** — every owned file/dir is gone; every owned config key/array value is removed; **the host config file is byte-identical to its pre-install snapshot** (proving foreign entries untouched AND sox-owned entries fully removed); the ownership index entry is gone.

The acceptance case is `sox-memory-bundle`: uninstalling it removes its global MCP entry (`~/.claude.json` → `mcpServers.memory-server`), its `~/.claude/skills/memory-usage`, its codex agent/MCP keys, and its `ext/<id>` stores — and the gate asserts the host files are clean afterward. Any injecting extension added later is held to the same gate automatically (it is keyed off "this extension injected something," not off a per-extension allowlist).

### D7 — install-registry stays global and logs every scope

`install-registry.json` remains a **single global file** under the user data root (`$SOX_ECOSYSTEM_HOME/install-registry.json`) and continues to record **every** scope's installs (project + user + local), so `upgrade --all` still enumerates all consumers across the machine. Only its *location* moves (out of `~/.sox` into `~/.adhd/sox-ecosystem/`); its global, all-scopes semantics are unchanged.

### D8 — `soxe migrate-home` relocates an existing install idempotently

A new command **`soxe migrate-home`** performs a one-time, idempotent relocation:

1. Move `$old/install-registry.json`, `$old/supervisors.json`, runtime/lock state, and every `ext/<id>/` store from the old data root (`$SOX_HOME` if set, else `~/.sox`, plus `~/.config/extensions/`) into `~/.adhd/sox-ecosystem/` (or `$SOX_ECOSYSTEM_HOME`).
2. **Re-place** user-scope skills/MCP that a prior sandboxed `SOX_HOME` had written under the *wrong* root (e.g. `$SOX_HOME/.claude/...`) to the **real** `~/.claude/...`, building an ownership entry for each as it goes (so they are henceforth tracked).
3. Idempotent: a second run is a no-op (it detects the new layout already present and skips moved items).

It is reality-tested against a **temp fixture** (an old-layout data dir + a sandboxed `.claude` tree) asserting the registry/stores land in the new root and the skills/MCP land in the real (fixture) `~/.claude`. The live migration of the founder's `claude-agents` data is run separately by the orchestrator — **not** by the implementing work.

---

## All-scopes rule (org / user / project / local — identical)

Path resolution, ownership recording, and reversal MUST behave **identically across all four scopes**, differing only in the *root* each resolves to (D2 table). One `dataRoot(scope, root)` resolver feeds config, lockfile, ledger, ownership index, and store paths for every scope. The ownership index keys on `(extId, scope)` uniformly. `uninstall`/`update` consume it identically per scope. This mirrors ADR-0003's all-scopes integrity rule: the *mechanism* is scope-independent; only the root differs.

---

## Consequences

**What gets fixed.**
- The founder's exact failure becomes impossible: `SOX_ECOSYSTEM_HOME` relocates data and **never** reroutes a placement (`[inv:data-root-never-reroutes]`, tested). A user-scope install lands in the real `~/.claude` and is reachable by every session.
- `uninstall` leaves **zero** owned residue (orphan class closed). `update`/`upgrade` remove superseded files and **re-materialize the service store** (BL-39 closed).
- Three scattered data roots collapse to one deterministic, per-scope `.adhd/sox-ecosystem/` layout with a single resolver.

**What changes for users.**
- `SOX_HOME` no longer works; `SOX_ECOSYSTEM_HOME` replaces it (data only). `soxe migrate-home` performs the one-time move. Default data root moves from `~/.sox` to `~/.adhd/sox-ecosystem/`.
- Tests/e2e use `SOX_SANDBOX_ROOT` for isolation (and optionally a temp `SOX_ECOSYSTEM_HOME` for a private data root).

**Carve-outs.**
- This ADR does not change *which* host paths exist (the §4 surface matrix is unchanged) — only that they are reached unrerouted when `SOX_SANDBOX_ROOT` is unset.
- ADR-0003's content-addressed identity is the `artifactChecksum` the ownership index records; this ADR does not reintroduce semver.
- OS-kernel sandboxing remains a non-goal (C6 in-process enforcement is unaffected).

---

## Migration (phased — each phase gated, never advance on red)

The whole-repo gate after **every** phase: `nx run-many -t build lint test --projects=install-engine,host-runtime,host-registry,sox,manifest --skip-nx-cache`, `nx test manifest`, and **`nx test-e2e host-runtime`** (must stay green; extended per below). `registry:sync-index` after any artifact change.

**Implementation status (live):** P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ · P5 ✅ — all gated green. Full gate: `nx run-many build,lint,test` (install-engine, host-runtime, host-registry, sox, manifest) green; `nx test manifest` 152/152; `nx test-e2e host-runtime` 85/0 including the P3 placement proof, the §D6b reversibility gate (Section R, byte-clean), and the §D8 migrate-home fixture proof (Section M). Reality proofs live in `tools/probe-adr0004-{placement,reversibility,migrate-home}.mjs`.

**Store location (resolves "don't pollute global spaces"):** the materialized service store is `<dataRoot>/ext/<id>` = `.adhd/sox-ecosystem/ext/<id>` for every scope — never `~/.sox` and never inside the host's `.claude`. Bundle members are grouped under the bundle in the ownership index (P4); the on-disk store may further nest as `ext/<bundle>/<member>` so a bundle's stores are co-located and removed as a unit on uninstall.

**P0 — ADR-0004 written** (this document).

**P1 — Data-root rename + `.adhd/sox-ecosystem/` layout (data only).** Introduce `dataRoot(scope, root)` in `host-runtime`; reimplement `getScopePath`/`getScopePaths`, `resolveInstallRegistryPath`, `getSupervisorsFilePath`, lock/runtime/log paths, `ledgerPath`, and the materialize store dir on top of it. `SOX_ECOSYSTEM_HOME` replaces `SOX_HOME` for **data** reads. **No placement change yet** — host-registry still reads `SOX_HOME` here so the gate stays green within the phase; the switch is P2.

**P2 — Sandbox-var split.** `host-registry` (`expandHome`/`getBase`/`getCodexBase`) reads `SOX_SANDBOX_ROOT` instead of `SOX_HOME`. Rewrite `host-registry.spec.ts:§6` and every isolation-dependent test/e2e onto `SOX_SANDBOX_ROOT`; add the `[inv:data-root-never-reroutes]` assertion. Gate green proves data root and placement are now orthogonal.

**P3 — Placement → real host.** Verify user/global placement reaches real `~/.claude/skills` + `~/.claude.json` (sandbox unset). Extend `test-e2e host-runtime`: a user-scope install under a temp `HOME` + temp `SOX_ECOSYSTEM_HOME`, **`SOX_SANDBOX_ROOT` unset**, lands the skill in the temp-`HOME` real `~/.claude/skills` and the MCP in `~/.claude.json`, while data lands in `$SOX_ECOSYSTEM_HOME`.

**P4 — Ownership index + consumers + reversibility gate (incl. BL-39).** Add `ownership.json` read/write; populate it in `install()` from capability results + materialize/lockfile/registry keys, enforcing `[inv:no-untracked-injection]` (every config-key/file/array-value/store recorded). Confirm all config injection routes through the one general `config-merge` capability (no bespoke writers). Rewrite `cmdUninstall` to consume the index and surgically reverse every entry (`[inv:reversible-injection]`, zero residue, foreign keys preserved). Make `install({mode:'update'})` diff old vs new owned sets, remove superseded files, and **re-materialize** on artifact change. Add the **reversibility gate** (D6b) to `test-e2e host-runtime`: for `sox-memory-bundle`, install → assert injected (MCP key in `~/.claude.json`, skill dir, codex keys, `ext/<id>` stores) → uninstall → assert zero residue + host config byte-identical to the pre-install snapshot + ownership entry gone; also assert `update` clears a superseded file + re-materializes a changed store.

**P5 — `soxe migrate-home` + fixture e2e.** Implement the relocate/re-place/idempotent command; test against a temp fixture (old layout + sandboxed `.claude`) asserting new-root data + real-`~/.claude` re-placement + idempotent second run.

**Rollback:** P1–P3 are additive resolvers behind one function; P4 ownership index is written alongside (not replacing) the ledger, so a partial migration still uninstalls via the ledger path. `migrate-home` is idempotent and never deletes the old root until the new layout is confirmed present.
