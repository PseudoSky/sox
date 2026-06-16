# core-invariants — CORE_INVARIANTS

> **Slug is identity.** Immutable.

**Phase:** core · **Depends on:** core-engine · **Guard:** `npx --yes nx test tokenguard-core`

---

## Goal

After this state, the security invariants of the engine are **proven by a ported test suite** that is red before the engine is correct and green after: bijective+idempotent cache, reload-stable IDs, exact round-trip, zero-leak wire guarantee (scoped; `tools` untouched), SSE split-token reassembly, thinking-block passthrough, longest-first. This suite **is** the `[dod.4]` proof and the regression net for every later state.

---

## Semantic Distillation

- **Primitive:** CREATE `libs/tokenguard-core/test/*.spec.ts` — port `scripts/tokenguard/selftest.py` + `roundtrip.py` invariants to Vitest.
- **Reference Pattern:** `scripts/tokenguard/selftest.py` (phase_cache/detectors/engname/custom/tooling) and `scripts/tokenguard/roundtrip.py` (exact-inverse + no-leak + SSE split). Mirror their assertions, not their WOP fixtures. `extensions/mcp-servers/memory-server/vitest.config.ts` for the runner shape.
- **Delta Spec:**
  - `vitest.config.ts` + a `test` target in `libs/tokenguard-core/project.json`.
  - `test/mapper.spec.ts` — idempotent `getOrCreate` (same token returned, source preserved), bijective (a token never reverses to two reals), reload-stable IDs + per-type counter continues post-reload, every entry has `token/real/type/source(valid)/created_ts` (**[shape:token-map]**).
  - `test/detectors.spec.ts` — coverage for email/fqdn/ipv4/ipv6/mac/phone, case-insensitive, longest-first, `NEVER`-set exclusion, fqdn-vs-path disambiguation; `identifierGroupVariants` keeps specific labels + drops generic.
  - `test/roundtrip.spec.ts` — for a corpus of samples: `wireLeaks` empty after tokenization (**[inv:wire-guarantee]**) and `detokenizeText(tokenizeStr(x)) === x` (**[inv:bijective-roundtrip]**); request scoping leaves `tools` JSON-Schema verbatim while tokenizing `system/messages/metadata`.
  - `test/sse.spec.ts` — a placeholder split across two deltas reassembles + reverses correctly (vs naive flat replacement); `thinking`/`signature` deltas pass through byte-identical.
  - Use **[fix:roundtrip-sample]** for the SSE/scoping cases.
- **Invariants:** the suite asserts **[inv:bijective-roundtrip]** + **[inv:wire-guarantee]**; no WOP fixtures.
- **Validation:** `npx --yes nx test tokenguard-core` exits 0 with zero failing tests.

---

## Acceptance criteria

- [ ] **[core-invariants.1]** round-trip exactness is asserted. `grep -n "toBe\|toEqual" libs/tokenguard-core/test/roundtrip.spec.ts`
- [ ] **[core-invariants.2]** zero-leak wire guarantee is asserted (scoped; tools untouched). `grep -n "wireLeaks\|tools" libs/tokenguard-core/test/roundtrip.spec.ts`
- [ ] **[core-invariants.3]** SSE split-token reassembly is asserted. `grep -n "delta\|split" libs/tokenguard-core/test/sse.spec.ts`
- [ ] **[core-invariants.4]** bijective + reload-stable cache is asserted. `grep -n "reload\|bijective\|getOrCreate" libs/tokenguard-core/test/mapper.spec.ts`
- [ ] **[core-invariants.5]** the suite runs as the nx `test` target. `grep -n "\"test\"" libs/tokenguard-core/project.json`

---

## Reservations

```text
read_only:  ["libs/tokenguard-core/src/index.ts",
             "libs/tokenguard-core/src/mapper.ts",
             "libs/tokenguard-core/src/tokenize.ts",
             "libs/tokenguard-core/src/sse.ts",
             "scripts/tokenguard/selftest.py",
             "scripts/tokenguard/roundtrip.py"]
mutates:    ["libs/tokenguard-core/vitest.config.ts",
             "libs/tokenguard-core/test/mapper.spec.ts",
             "libs/tokenguard-core/test/detectors.spec.ts",
             "libs/tokenguard-core/test/roundtrip.spec.ts",
             "libs/tokenguard-core/test/sse.spec.ts"]
```

> Note: this state adds a `test` target to `libs/tokenguard-core/project.json` (authored by `core-engine`). That edit is a one-line target addition; record it as an executor-class `expand-artifacts` amendment if the file is otherwise frozen, or fold it during `core-engine`. Either is acceptable; keep `project.json` consistent.

---

## Contract Promise

- **Added:** the Vitest suite + config + the `test` target.
- **Modified:** `libs/tokenguard-core/project.json` (test target) — see note above.
- **Deleted:** none.

---

## Commit points

- [ ] **After the suite is green** — `test(tokenguard-service): core-invariants — port round-trip/leak/SSE invariant suite`
- [ ] **After the guard passes** (mandatory) — `test(tokenguard-service): core-invariants complete — suite green`

---

## Notes for executor

- The point of the suite is to be a **forcing function**: each assertion must currently fail if the corresponding engine behavior is wrong. Write at least one test that you can confirm flips red by perturbing the engine (this is the negative control [dod.4] declares).
- Do not import any WOP fixture or read an `roe`-shaped file — the suite is self-contained synthetic data.
