<!-- markdownlint-disable MD013 MD033 -->
# audit-enforcement — ENFORCEMENT_AUDIT

> **Slug is identity.** `audit-enforcement` is immutable. It depends on every state in the
> enforcement phase via `dag.json`, so adding a state to the phase only adds an edge — this file's
> name never changes.

**Phase:** Audit · **Depends on:** mcp-runtime, install-lifecycle, generators, rehome-memory-server
**Guard:** `python3 scripts/audit_eim.py --phase enforcement`

---

## Goal

Verify every acceptance criterion from `mcp-runtime`, `install-lifecycle`, `generators`, and
`rehome-memory-server` (plus all foundation criteria, since the audit is phase-cumulative) against
the actual codebase before advancing to the **convergence** phase. This is a mandatory hold point.
`ingestion-skill` and `dod-reconcile` may not begin until every enforcement criterion passes.

**There are no deferrable items in an audit state.** A failing check is fixed in source before
advancing — not a known issue, not a follow-up ticket, not a `# TODO`.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_eim.py` — add `phase_enforcement()`, which calls
  `phase_foundation()` first, then runs the enforcement-phase criterion checks.

- **Reference Pattern:** the acceptance-criteria sections of `mcp-runtime.md`,
  `install-lifecycle.md`, `generators.md`, `rehome-memory-server.md` — the exact items the script
  checks, by slug-keyed ID.

- **Delta Spec:** `scripts/audit_eim.py --phase enforcement` runs `phase_foundation()` then:

  ```text
  [mcp-runtime.1..5]          wrapper / dual-transport / C6-on-both / conformance / serves
  [install-lifecycle.1..5]    modules / on-disk e2e / install-target gone / diff+update / abort
  [generators.1..5]           schema options / descriptor emit / source provenance / parity / 6 templates
  [rehome-memory-server.1..5] serve() / vendored guard GONE / no compilePolicyFromEnv copy / dep / e2e
  ```

  Same `_run` PATH augmentation as foundation. Collects all failures, prints each with its ID + fix,
  exits with the failure count.

- **Invariants:** runs without ML models or network; read-only; every failure names the file/symbol;
  fixes committed before re-run.

- **Validation:** `python3 scripts/audit_eim.py --phase enforcement` exits 0 and prints
  `ENFORCEMENT AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] `phase_enforcement()` calls `phase_foundation()` first (cumulative).
- [ ] The script checks every slug-keyed criterion ID from the four enforcement states. No criterion
      is omitted.
- [ ] The script exits 0 and prints `ENFORCEMENT AUDIT PASSED`.
- [ ] No criterion is marked "skipped" or "manual-only".

---

## Reservations

```text
read_only:  ["libs/mcp-runtime", "libs/install-engine", "libs/authoring",
             "packages/sox-nx", "extensions/mcp-servers/memory-server", "bin/sox",
             "apps/sox"]
mutates:    ["scripts/audit_eim.py"]
```

---

## Contract Promise

- **Added:** `phase_enforcement()` in `scripts/audit_eim.py`.
- **Modified:** `scripts/audit_eim.py` (extends the one script; audit stays read-only over source).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — `fix(eim): <slug>.<n> — <what was corrected>`
- [ ] **After the audit passes** (mandatory) — commit the audit script plus `state.json` /
      `dag.json`: `chore(eim): audit-enforcement green — enforcement criteria verified`

---

## Notes for executor

- The likely failures (dag notes): C6 not enforced on the sse path (`mcp-runtime.3`); a vendored
  memory-server guard symbol still present (`rehome-memory-server.2/.3`); declarative `update` not
  idempotent (`install-lifecycle`); born-conformance parity drift (`generators.4`). Fix source.
- Keep the single accumulating script — `phase_enforcement()` MUST call `phase_foundation()` so a
  later `--phase enforcement` re-runs every foundation check too.
