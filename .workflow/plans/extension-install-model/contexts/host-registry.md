<!-- markdownlint-disable MD013 MD033 -->
# host-registry — Pluggable host modules: claude + codex

> **Slug is identity.** This filename and the `host-registry` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** foundation · **Depends on:** schema-delta · **Guard:** `./node_modules/.bin/nx run host-registry:test`
**Parallel with:** capability-engine

---

## Goal

After this state `libs/host-registry` (**[def:host-registry]**) ships the pluggable per-host
abstraction `{ host, detect(), scopePaths(scope), surfaces{} }` with **two** real modules —
`claude.ts` (the verified §4 matrix) and `codex.ts` (TOML, the §4b matrix) — proving the abstraction
is not Claude-shaped (ADR resolved #6). It is the single place literal host-discovery paths live
(**[ref:host-keyed-target]**), and it encodes the forbidden-key rules (**[inv:never-managed]**:
Claude **[def:managed-tier]**, Codex **[def:project-forbidden-keys]**).

It depends on `schema-delta` (surfaces are keyed to the descriptor) and is parallel with
`capability-engine` (disjoint files). The lifecycle + generators states consume it downstream.

---

## Semantic Distillation

- **Primitive:** CREATE `libs/host-registry/src/{index,claude,codex}.ts` — registry + two host
  modules.

- **Reference Pattern:** spec §4 (Claude matrix + P0.5 corrections: `output-style` is not a file
  surface; hooks = file-drop + config-merge; MCP trust = prompt), §4b (Codex TOML matrix +
  project-forbidden keys + the divergence note), §3.5 (registry shape).

- **Delta Spec:**
  - `index.ts` defines the registry interface + a lookup keyed by host name; `surfaces{}` maps each
    extension type → `{ capability, scope→path }` per host.
  - `claude.ts`: agents/skills/commands → file-drop; settings/MCP → config-merge; permissions →
    array-merge; MCP trust defaults to **prompt** (no auto-flag); **never** the managed tier.
  - `codex.ts`: `config.toml` tables via config-merge (toml); AGENTS.md/skills via file-drop;
    encodes **[def:project-forbidden-keys]** (`model_providers`/`notify`/`profile`/`otel`) +
    trust-level semantics.
  - `detect()` defaults `--host` from the workspace (`.claude/`/`.mcp.json`/`CLAUDE.md` → claude;
    `.codex/` → codex).
  - **FIRST resolve P0.6** — verify the Codex **skills path** (`.agents/skills` per official docs
    vs `~/.codex/skills` community) and the **plugin/marketplace paths** against the *installed*
    Codex CLI; record what was verified in a comment/test so the choice is auditable.

- **Invariants:** **[inv:host-agnostic-type]** (registry is the only place targets resolve),
  **[inv:never-managed]**, **[ref:host-keyed-target]**.

- **Validation:** `./node_modules/.bin/nx run host-registry:test` — tests assert both modules resolve
  scope→path for every shipped surface, `detect()` returns the right host for a fixture workspace,
  and forbidden/managed keys are flagged.

---

## Acceptance criteria

Checked by `audit-foundation`. One check per item; none deferred.

- [ ] **[host-registry.1]** Two host modules ship with `detect`/`scopePaths`/`surfaces`.
      `for h in claude codex; do grep -lqE 'detect|scopePaths|surfaces' libs/host-registry/src/$h.ts || exit 1; done`
- [ ] **[host-registry.2]** Literal host-discovery paths live ONLY in `libs/host-registry`
      (**[ref:host-keyed-target]**). `host-registry:test` covers `scopePaths` for project+user on
      both hosts; `grep -nE '\.claude|\.codex' libs/host-registry/src/claude.ts libs/host-registry/src/codex.ts` → non-empty (paths present here, by design).
- [ ] **[host-registry.3]** Codex module encodes project-forbidden keys (**[inv:never-managed]**).
      `grep -nE 'model_providers|notify|profile|otel' libs/host-registry/src/codex.ts` → non-empty.
- [ ] **[host-registry.4]** Claude module never targets the managed tier and defaults MCP trust to
      prompt. `grep -niE 'managed' libs/host-registry/src/claude.ts` → non-empty (the never-managed
      guard); `host-registry:test` asserts no managed-tier path is produced.
- [ ] **[host-registry.5]** P0.6 codex paths verified + recorded. `grep -niE 'P0.6|skills path|agents/skills' libs/host-registry/src/codex.ts libs/host-registry/src/host-registry.spec.ts` → non-empty.

---

## Reservations

```text
read_only:  ["libs/manifest/src/schema.json",
             "docs/plans/extension-install-and-reinjection-model.md"]
mutates:    ["libs/host-registry/src/index.ts",
             "libs/host-registry/src/claude.ts",
             "libs/host-registry/src/codex.ts",
             "libs/host-registry/src/host-registry.spec.ts"]
```

**Merge protocol:** none — disjoint files from the parallel `capability-engine` state.

---

## Contract Promise

- **Added:** `libs/host-registry` index + `claude.ts` + `codex.ts` + spec.
- **Modified:** none (new package files).
- **Deleted:** none.

---

## Commit points

- [ ] **After both modules pass `host-registry:test`** (mandatory) — commit source **and**
      `state.json` / `dag.json`: `feat(eim): host-registry complete — claude+codex modules — guard green`

If P0.6 verification is a distinct chunk, commit it first:
`chore(eim): host-registry — P0.6 codex path verification`.

---

## Notes for executor

- **Do P0.6 before wiring codex paths** — if the installed CLI uses `~/.codex/skills`, the matrix
  changes. Record the verification (CLI version + what you observed) so the audit can confirm it
  wasn't guessed (**[host-registry.5]**).
- This is the ONLY package allowed to contain literal `.claude/`/`.codex/` paths
  (**[ref:host-keyed-target]**); the final audit greps every other package to prove it. Keep paths
  here.
- `output-style` is **not** a file surface (P0.5) — do not add it as one; it is a `settings.json`
  value only.
