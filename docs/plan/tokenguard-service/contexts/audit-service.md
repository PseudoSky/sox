# audit-service — SERVICE_AUDIT

> **Slug is identity.** `audit-service` is immutable; depends on its phase's states via `dag.json`.

**Phase:** Audit · **Depends on:** tg-service, tg-cli
**Guard:** `python3 docs/plan/tokenguard-service/scripts/audit_tokenguard.py --phase service`

---

## Goal

Verify the `tg-service.*` and `tg-cli.*` criteria, and re-run the framework + core checks (this phase depends on both prior audits), before the final tail begins. Mandatory hold point. Proves the real `sox` lifecycle, the live round-trip with zero leaks through a mock upstream, both adapters, and the CLI live-seed reflection.

---

## Semantic Distillation

- **Primitive:** EXTEND `audit_tokenguard.py --phase service` — calls `phase_framework()` + `phase_core()` then runs `tg-service.*` + `tg-cli.*` checks.
- **Reference Pattern:** the acceptance-criteria sections of `tg-service` + `tg-cli`; the demo harnesses.
- **Delta Spec:** `phase_service()` runs prior phases then one check per `[tg-service.1..6]` + `[tg-cli.1..5]`, including the live round-trip (`ROUNDTRIP OK` + `LEAKS 0`) and the live-seed reflection (`LIVE SEED REFLECTED`) through the real `./bin/sox` lifecycle with zero orphans.
- **Invariants:** read-only; fixes land in the service/CLI source; the lifecycle leaves zero orphans (`[ref:supervisor-stop]`).
- **Validation:** exits 0 and prints `SERVICE AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] The script checks every `[tg-service.*]` + `[tg-cli.*]` criterion ID and re-runs framework + core. None omitted.
- [ ] The live round-trip + zero-leak and live-seed reflection are verified through the real `sox` lifecycle.
- [ ] The script exits 0 and prints the phase PASS line.
- [ ] No criterion is marked skipped/manual.

---

## Reservations

```text
read_only:  ["extensions/services/tokenguard/src/index.ts",
             "extensions/services/tokenguard/src/proxy.ts",
             "extensions/services/tokenguard/src/cli.ts"]
mutates:    ["docs/plan/tokenguard-service/scripts/audit_tokenguard.py"]
```

---

## Contract Promise

- **Added:** `phase_service()` checks in `audit_tokenguard.py`.
- **Modified:** none.

---

## Commit points

- [ ] **After each source fix** — `fix(tokenguard-service): <slug>.<n> — <correction>`
- [ ] **After the audit passes** (mandatory) — `chore(tokenguard-service): audit-service green`

---

## Notes for executor

- A `port.txt` race (probe before the server listens) or a stale in-memory map (CLI seed not reflected) are the likeliest failures — fix the ordering/subscription in source, never relax the assertion.
