# audit-framework — FRAMEWORK_AUDIT

> **Slug is identity.** `audit-framework` is immutable; it depends on every state in its phase via `dag.json`.

**Phase:** Audit · **Depends on:** service-type, http-transport, mcp-as-service
**Guard:** `python3 docs/plan/tokenguard-service/scripts/audit_tokenguard.py --phase framework`

---

## Goal

Verify every acceptance criterion from `service-type`, `http-transport`, and `mcp-as-service` against the actual codebase before `tg-service` may begin. Mandatory hold point — **no deferrable items**. The decisive check is `[inv:no-regress-mcp]`: `memory-server` must pass its full lifecycle + the C6 denial after the routing refactor.

---

## Semantic Distillation

- **Primitive:** EXTEND `docs/plan/tokenguard-service/scripts/audit_tokenguard.py --phase framework` — runs all `service-type.*`, `http-transport.*`, `mcp-as-service.*` checks.
- **Reference Pattern:** the acceptance-criteria sections of the three framework states.
- **Delta Spec:** the script's `phase_framework()` runs one check per criterion ID `[service-type.1..6]`, `[http-transport.1..5]`, `[mcp-as-service.1..5]`, collects failures, prints each with its ID + the required fix, and exits with the failure count.
- **Invariants:** the script is read-only and runs without network beyond the local `./bin/sox` lifecycle the non-regress harness drives; fixes land in source, never in the check.
- **Validation:** exits 0 and prints `FRAMEWORK AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] The script checks every `[service-type.*]`, `[http-transport.*]`, `[mcp-as-service.*]` criterion ID. None omitted.
- [ ] `memory-server` non-regression (`MEMORY OK` + `C6 DENY OK`) is verified.
- [ ] The script exits 0 and prints the phase PASS line.
- [ ] No criterion is marked skipped/manual.

---

## Reservations

```text
read_only:  ["libs/manifest/src/index.ts",
             "libs/host-runtime/src/supervisor.ts",
             "libs/install-engine/src/install.ts",
             "libs/host-registry/src/claude.ts"]
mutates:    ["docs/plan/tokenguard-service/scripts/audit_tokenguard.py"]
```

---

## Contract Promise

- **Added:** `phase_framework()` checks in `audit_tokenguard.py`.
- **Modified:** none (audit is read-only; fixes happen in source).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — `fix(tokenguard-service): <slug>.<n> — <correction>`
- [ ] **After the audit passes** (mandatory) — `chore(tokenguard-service): audit-framework green`

---

## Notes for executor

- The likeliest failure is a C6 or memory-server lifecycle regression from the `mcp-as-service` routing change. Fix the routing in source; never weaken the C6 check.
- If a fix changes the dependency graph or target state, it is a planner-class amendment — stop and escalate.
