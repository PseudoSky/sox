# decouple-generalize — DECOUPLE

> **Slug is identity.** Immutable.

**Phase:** final · **Depends on:** audit-service · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_decouple.py`

---

## Goal

After this state, the port is **provably free of WOP/red-team coupling** and documented for **generic, config-driven** use against any model provider. This is the explicit `[dod.7]` negative gate plus the generalization documentation — no new runtime behavior, just the proof that nothing red-team-specific rode along and the docs that make the tool reusable by anyone.

---

## Semantic Distillation

- **Primitive:** WIRE documentation + a negative gate — confirm decoupling and document generic usage.
- **Reference Pattern:** the new `extensions/services/tokenguard/` + `libs/tokenguard-core/` trees (everything authored so far); the `*_BASE_URL` redirect model (the way the proxy is adopted: point the client's base-URL env at it).
- **Delta Spec:**
  - `libs/tokenguard-core/README.md` + `extensions/services/tokenguard/README.md` — document the engine API and the generic operator workflow: install → start → point the client base-URL variable at the proxy → seed via config or CLI. Cover at least two provider base-URL variables (the default-provider and an OpenAI-compatible one) as the adoption pattern.
  - `extensions/services/tokenguard/CLAUDE.md` — operator/agent guidance for the service + CLI.
  - The negative gate (run by the guard + re-run in `audit-final`): `grep -rniE "roe|engagement|labtarget|limabar|workspace/engagements|e2e-run|red.?team" libs/tokenguard-core/src extensions/services/tokenguard/src` returns **empty**. No WOP path or vocabulary in shipped source.
- **Invariants:** **[inv:c7-no-reach-in]**; the proxy works for any upstream — confirm no provider hostname is hard-coded in the engine (it lives only in an adapter/config).
- **Validation:** the guard runs the negative grep gate (empty) and confirms the generic-usage docs exist.

---

## Acceptance criteria

- [ ] **[decouple-generalize.1]** zero WOP vocabulary/paths in shipped source. `grep -rniE "roe|engagement|labtarget|limabar|workspace/engagements|red.?team" libs/tokenguard-core/src extensions/services/tokenguard/src` → empty
- [ ] **[decouple-generalize.2]** generic, provider-agnostic usage is documented (≥2 base-URL variables). `grep -niE "BASE_URL" extensions/services/tokenguard/README.md`
- [ ] **[decouple-generalize.3]** no provider hostname is hard-coded in the engine lib. `grep -rniE "anthropic\.com|openai\.com" libs/tokenguard-core/src` → empty

---

## Reservations

```text
read_only:  ["libs/tokenguard-core/src/index.ts",
             "extensions/services/tokenguard/src/index.ts",
             "extensions/services/tokenguard/src/proxy.ts"]
mutates:    ["extensions/services/tokenguard/README.md",
             "extensions/services/tokenguard/CLAUDE.md",
             "libs/tokenguard-core/README.md"]
```

---

## Contract Promise

- **Added:** the engine + service READMEs and the service CLAUDE.md.
- **Modified:** none (docs-only; the negative gate is a check, not a change).
- **Deleted:** none — if the grep gate finds coupling, the fix lands in the owning source state as an amendment, not here.

---

## Commit points

- [ ] **After docs + the green negative gate** — `docs(tokenguard-service): decouple-generalize — generic usage + WOP-coupling negative gate`
- [ ] **After the guard passes** (mandatory) — `docs(tokenguard-service): decouple-generalize complete — zero coupling proven`

---

## Notes for executor

- If the negative grep is non-empty, do **not** suppress it — trace each hit to its source state and fix it there (an engine/service amendment), then re-run. A coupling hit is a real leak of WOP specifics into a tool meant to be generic.
- The provider hostname belongs in config or an adapter default, never in `@sox/tokenguard-core`.
