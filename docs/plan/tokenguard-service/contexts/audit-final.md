# audit-final — FINAL_AUDIT

> **Slug is identity.** `audit-final` is immutable; depends on `code-review` (and transitively the whole graph) via `dag.json`.

**Phase:** Audit · **Depends on:** code-review
**Guard:** `python3 docs/plan/tokenguard-service/scripts/audit_tokenguard.py --phase final`

---

## Goal

The terminal hold point. Operationalize the Definition of Done: **every `[dod.N]` proven** (behavioral clauses driven through their declared entrypoint with the observable asserted; structural clauses by grep/AST), **every `[ref:]` conformance check** green, the **WOP-gone** negative checks green, and the **live demonstration** producing the four founder-facing artifacts. `done` is refused unless every `[dod.N]` emits an executed PASS line. No deferrable items.

---

## Semantic Distillation

- **Primitive:** EXTEND `audit_tokenguard.py --phase final` — calls `phase_service()` then runs every DoD + reference + decoupling + reviewer check.
- **Reference Pattern:** the `## Definition of Done` clauses in `README.md`; `references.json`; the demo harnesses `extensions/services/tokenguard/demo/proxy-roundtrip.sh` + `live-seed.sh`; the conformance harnesses `tools/tg-plan/check-*.sh`.
- **Delta Spec — `phase_final()` runs:**
  - **Definition-of-Done** — one `check("dod.N", …)` per clause:
    - `dod.1` drives `bash tools/tg-plan/check-service-scaffold.sh`, asserts `SCAFFOLD OK`.
    - `dod.2` drives `bash tools/tg-plan/check-http-service.sh`, asserts `HTTP SERVICE HEALTHY` + `STOPPED CLEAN orphans=0`.
    - `dod.3` drives `bash tools/tg-plan/check-memory-nonregress.sh`, asserts `MEMORY OK` + `C6 DENY OK`.
    - `dod.4` drives `npx --yes nx test tokenguard-core`, asserts the suite passes.
    - `dod.5` drives `bash extensions/services/tokenguard/demo/proxy-roundtrip.sh`, asserts `ROUNDTRIP OK` + `LEAKS 0`.
    - `dod.6` drives `bash extensions/services/tokenguard/demo/live-seed.sh`, asserts `LIVE SEED REFLECTED`.
    - `dod.7`/`dod.8` structural negative checks (no WOP vocab; no hard-coded provider hostname in the engine; both adapters present).
    - `dod.9` reviewer: `code-review.md` `VERDICT: PASS` + the four demo artifacts present.
    - `dod.10`/`dod.11` structural: non-goals + rollback documented.
  - **Reference conformance** — one check per `[ref:]`: `[audit-final.ref-config-schema]`, `[audit-final.ref-run-service-spec]`, `[audit-final.ref-supervisor-stop]`, `[audit-final.ref-born-conformant-template]`, `[audit-final.ref-host-keyed-target]`, `[audit-final.ref-c7-no-reach-in]`, `[audit-final.ref-c6-policy-guard]`.
  - **Live demonstration** — the `dod.5` harness writes the four artifacts under `extensions/services/tokenguard/demo/out/` (agent prompts, outbound real→placeholder diff, raw provider reply, inbound placeholder→real diff); the founder reviews them at acceptance.
- **Invariants:** read-only; the orchestrator confirms each `[dod.N]` via its `PASS` line — DONE is impossible without an executed PASS for every clause.
- **Validation:** exits 0 and prints `FINAL AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] Every `[dod.N]` (1–11) has an executed `check("dod.N", …)` that PASSes; behavioral ones drive the declared entrypoint and assert the observable.
- [ ] Every `[ref:]` has its `[audit-final.ref-*]` conformance check and it PASSes.
- [ ] The four founder-facing demo artifacts are produced and the live round-trip reports zero leaks.
- [ ] The script exits 0 and prints `FINAL AUDIT PASSED`.

---

## Reservations

```text
read_only:  ["README.md",
             "references.json",
             "extensions/services/tokenguard/demo/proxy-roundtrip.sh",
             "tools/tg-plan/check-service-scaffold.sh"]
mutates:    ["docs/plan/tokenguard-service/scripts/audit_tokenguard.py"]
```

---

## Contract Promise

- **Added:** `phase_final()` — DoD + reference + decoupling + reviewer checks.
- **Modified:** none (audit is read-only).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing DoD/reference check — `fix(tokenguard-service): <id> — <correction>`
- [ ] **After the final audit passes** (mandatory) — `chore(tokenguard-service): audit-final green — DoD confirmed`

---

## Notes for executor

- This audit must drive the **real entrypoints** (the `sox`-CLI harnesses + the demo), not proxies. A `[dod.N]` proven by a grep that never ran the interaction is a forged proof — the gap-check rejects it at author time, and the orchestrator refuses DONE without a real PASS.
- The founder's acceptance is the live demo (`[dod.9]`): present the four `demo/out/` artifacts. Acceptance is human; the audit makes it provable.
