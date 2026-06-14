<!-- markdownlint-disable MD013 MD033 -->
# capability-engine — Six idempotent capabilities + provenance ledger

> **Slug is identity.** This filename and the `capability-engine` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** foundation · **Depends on:** schema-delta · **Guard:** `./node_modules/.bin/nx run install-engine:test`
**Parallel with:** host-registry

---

## Goal

After this state `libs/install-engine` implements the six capabilities — `file-drop`,
`config-merge` (json|toml), `array-merge`, `bin-link`, `run-service`, `materialize` — each
honoring **[shape:capability]** (apply / reverse / update(diff) / verify), idempotent and
(host, scope)-aware, plus the per-scope provenance **[def:ledger]**. This is the mechanism layer
(spec §3.2): install/update/diff/uninstall (the `install-lifecycle` state) compose it; nothing is
wired to a caller yet, which keeps the downstream lifecycle guard red→green.

It depends on `schema-delta` because capabilities operate over **[shape:install-descriptor]**
targets. It is parallel with `host-registry` (disjoint files: engine vs registry).

---

## Semantic Distillation

- **Primitive:** CREATE `libs/install-engine/src/capabilities/*.ts` + `ledger.ts` — the six
  capabilities and the provenance ledger.

- **Reference Pattern:** spec §3.2 capability table (action/reverse/clean), §3.4 ledger shape, §4/§4b
  for which surfaces each capability serves; existing `libs/install-engine` for the package layout.

- **Delta Spec:**
  - Implement each capability to **[shape:capability]**. `config-merge` is **format-aware** —
    JSON (`settings.json` / `.mcp.json` / `~/.claude.json`) **and** TOML (codex `config.toml`)
    (**[inv:format-aware-merge]**, **[ref:config-merge-format]**).
  - `array-merge` is deny-wins and records the exact appended values (**[shape:ledger-action]**).
  - Every `config-merge` / `array-merge` apply writes a per-scope ledger action
    (**[inv:ledger-reversible]**, **[ref:ledger-reversible]**); `reverse` undoes exactly those
    actions and never touches foreign keys. Project ledger = committed/portable (repo-relative);
    user ledger = gitignored `~/.sox/`.
  - `materialize` places built code at a stable store path so host pointers don't break.
  - **No callers wired** — capabilities are exercised only by `capabilities.spec.ts`.

- **Invariants:** **[inv:ledger-reversible]**, **[inv:format-aware-merge]**. Targets are passed in
  (resolved by the registry/lifecycle), not hard-coded here (**[inv:host-agnostic-type]**).

- **Validation:** `./node_modules/.bin/nx run install-engine:test` — unit tests prove each
  capability's apply→verify→reverse round-trip is idempotent and clean, toml round-trips, and a
  shared-file merge reverses without disturbing a foreign key.

---

## Acceptance criteria

Checked by `audit-foundation`. One check per item; none deferred.

- [ ] **[capability-engine.1]** All six capability modules exist and export apply/reverse/update/
      verify. `for f in file-drop config-merge array-merge bin-link run-service materialize; do grep -lqE 'apply|reverse|update|verify' libs/install-engine/src/capabilities/$f.ts || exit 1; done`
- [ ] **[capability-engine.2]** `config-merge` is format-aware (json AND toml)
      (**[inv:format-aware-merge]**). `grep -niE 'toml' libs/install-engine/src/capabilities/config-merge.ts` → non-empty; `install-engine:test` covers a toml round-trip.
- [ ] **[capability-engine.3]** Every config-merge/array-merge apply records a ledger action and
      `reverse` is exact (**[inv:ledger-reversible]**, **[ref:ledger-reversible]**).
      `grep -nE 'ledger' libs/install-engine/src/capabilities/config-merge.ts libs/install-engine/src/capabilities/array-merge.ts` → non-empty; `install-engine:test` covers an apply→reverse round-trip leaving a foreign key intact.
- [ ] **[capability-engine.4]** `ledger.ts` exists and the project ledger is portable (no absolute /
      user paths written to the committed project ledger).
      `grep -nE 'reverse|action' libs/install-engine/src/ledger.ts` → non-empty; `install-engine:test` asserts project-ledger paths are repo-relative.
- [ ] **[capability-engine.5]** Capabilities are idempotent — re-apply is a no-op.
      `install-engine:test` covers double-apply == single-apply.

---

## Reservations

```text
read_only:  ["libs/manifest/src/schema.json",
             "libs/host-registry/src/index.ts"]
mutates:    ["libs/install-engine/src/capabilities/file-drop.ts",
             "libs/install-engine/src/capabilities/config-merge.ts",
             "libs/install-engine/src/capabilities/array-merge.ts",
             "libs/install-engine/src/capabilities/bin-link.ts",
             "libs/install-engine/src/capabilities/run-service.ts",
             "libs/install-engine/src/capabilities/materialize.ts",
             "libs/install-engine/src/ledger.ts",
             "libs/install-engine/src/capabilities/capabilities.spec.ts"]
```

**Merge protocol:** none — disjoint files from the parallel `host-registry` state. The
`install-lifecycle` state (later phase) adds `install.ts`/`lifecycle.ts`/`diff.ts` to this same
package but runs after `audit-foundation`, so there is no concurrent write here.

---

## Contract Promise

- **Added:** six capability modules + `ledger.ts` in `libs/install-engine`, each to
  **[shape:capability]**.
- **Modified:** none (new files only).
- **Deleted:** none.

---

## Commit points

- [ ] **After all six capabilities + ledger pass `install-engine:test`** (mandatory) — commit source
      **and** `state.json` / `dag.json`: `feat(eim): capability-engine complete — 6 caps + ledger — guard green`

Long state — if you land capabilities incrementally, commit per coherent group
(`feat(eim): capability-engine — file-drop/materialize/bin-link`) so a crash loses at most one group.

---

## Notes for executor

- The hardest part is **reverse correctness** for shared files: the ledger must capture enough to
  remove ONLY sox's keys/values (deny-wins array-merge especially). Test the foreign-key-survives
  case explicitly — it is the most common real-world regression.
- TOML and JSON must go through the **same** `config-merge` entry point (**[ref:config-merge-format]**)
  — do not fork into a json-only and a toml-only writer; a single capability, format detected from
  the target.
- Do not import the host registry's literal paths; capabilities receive a resolved target
  (**[inv:host-agnostic-type]**). Budget ~2 sessions.
