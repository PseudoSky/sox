# core-engine — CORE_ENGINE

> **Slug is identity.** Immutable.

**Phase:** core · **Depends on:** (none — a root) · **Guard:** `npx --yes nx build tokenguard-core`
**Parallel with:** service-type / the whole framework track

---

## Goal

After this state, `@adhd/sox-tokenguard-core` exists as a **pure, IO-light TypeScript port** of `scripts/tokenguard/core.py`: the bijective, origin-tagged `Mapper`, the ordered detector pipeline, two-pass request tokenization, leak scoping, longest-first detokenization, and SSE delta reassembly. The WOP-specific `engagement_variants` logic is **generalized** into a neutral identifier-group helper with no red-team vocabulary. This is the single source of truth the proxy and any test share — runs fully parallel to the framework track (disjoint files).

---

## Semantic Distillation

- **Primitive:** CREATE `libs/tokenguard-core/src/*` — port the engine.
- **Reference Pattern:** `scripts/tokenguard/core.py` (the whole file) — `Mapper`, `tokenize_str/walk_tokenize/tokenize_request`, `wire_leaks`, `detokenize_text/detokenize_sse`, the detector functions + regexes, `REQUEST_TOKENIZE_KEYS`, `_SKIP_VALUE_KEYS`, `_DELTA_FIELD`, `NEVER`, `BOUNDED_TYPES`. The `memory-core` lib (`libs/memory-core/`) for the nx-lib shape (project.json/package.json/tsconfig) and **[ref:c7-no-reach-in]**.
- **Delta Spec:**
  - nx library `libs/tokenguard-core` (project name `tokenguard-core`, package `@adhd/sox-tokenguard-core`), build target `tsc`, mirroring `memory-core`'s project.json/package.json/tsconfig.
  - `src/types.ts` — `[shape:token-map]` (`MapEntry`, `TokenMap`), `IdType`, `Source`.
  - `src/mapper.ts` — `Mapper`: `getOrCreate(real,type,source)`, `registerExplicit`, `seed`, `tokenOf/realOf/typeFor`, `realsLongestFirst/tokensLongestFirst`, load/persist of `[shape:token-map]`. Bijective + idempotent + reload-stable per-type counters.
  - `src/detectors.ts` — `detectKnown/Email/Fqdn/Ipv4/Ipv6/Mac/Phone`, the regexes, `NEVER`, `BOUNDED_TYPES`, optional-detector toggles (phone/ipv6) read from config (not env-coupled in the lib).
  - `src/tokenize.ts` — `tokenizeStr`, `walkTokenize`, `tokenizeRequest` (two-pass; scoped to `system|messages|metadata`), `wireLeaks`, `detokenizeText` (longest-first). `identifierGroupVariants(label, members)` replaces `engagement_variants` — neutral naming, same algorithm (keep specific labels, drop generic).
  - `src/sse.ts` — `detokenizeSse(raw, reverse)` — reassemble a content block across deltas before reversing; pass `thinking`/`signature` verbatim.
  - `src/index.ts` — the public surface (barrel export).
- **Invariants:** **[inv:bijective-roundtrip]**, **[inv:wire-guarantee]** (implemented here, proven in [core-invariants]); pure lib — no `net`/`http`/`fs` beyond optional map persist; **no** red-team / roe / engagement vocabulary anywhere.
- **Validation:** `npx --yes nx build tokenguard-core` compiles the lib (the invariants are proven in the next state).

---

## Acceptance criteria

- [ ] **[core-engine.1]** the lib builds and exports the Mapper. `grep -n "class Mapper\|export" libs/tokenguard-core/src/mapper.ts`
- [ ] **[core-engine.2]** request scoping covers exactly `system`/`messages`/`metadata`. `grep -n "system\|messages\|metadata" libs/tokenguard-core/src/tokenize.ts`
- [ ] **[core-engine.3]** SSE reassembly is present (no flat replacement). `grep -n "detokenizeSse\|delta" libs/tokenguard-core/src/sse.ts`
- [ ] **[core-engine.4]** the WOP `engagement` vocabulary is gone from the lib; the generalized helper is present. `grep -rni "engagement\|roe" libs/tokenguard-core/src` → empty; `grep -n "identifierGroupVariants" libs/tokenguard-core/src/tokenize.ts`
- [ ] **[core-engine.5]** the lib is a buildable nx project. `test -f libs/tokenguard-core/project.json`

---

## Reservations

```text
read_only:  ["scripts/tokenguard/core.py",
             "libs/memory-core/project.json",
             "libs/memory-core/package.json"]
mutates:    ["libs/tokenguard-core/project.json",
             "libs/tokenguard-core/package.json",
             "libs/tokenguard-core/tsconfig.json",
             "libs/tokenguard-core/src/index.ts",
             "libs/tokenguard-core/src/types.ts",
             "libs/tokenguard-core/src/mapper.ts",
             "libs/tokenguard-core/src/detectors.ts",
             "libs/tokenguard-core/src/tokenize.ts",
             "libs/tokenguard-core/src/sse.ts"]
```

---

## Contract Promise

- **Added:** the `@adhd/sox-tokenguard-core` library and its modules.
- **Modified:** none (new project).
- **Deleted:** none — the Python source stays in place until the service replaces its callers (out of scope for this plan; the Python tool is untouched).

---

## Commit points

- [ ] **After the lib compiles** — `feat(tokenguard-service): core-engine — port tokenguard engine to @adhd/sox-tokenguard-core`
- [ ] **After the guard passes** (mandatory) — `feat(tokenguard-service): core-engine complete — build green`

---

## Notes for executor

- The detector **order** is load-bearing: known reals → email → fqdn → ipv6 → ipv4 → mac → phone, longest-first within each. A reordering silently changes which token a substring gets and breaks reversibility. Port the order verbatim.
- `tokenize_request` is two-pass (full pipeline, then known-reals-only to catch discovered sub-domains). Keep both passes.
- Keep the lib free of `process.env` reads — config is injected by the service layer, not the engine, so the engine stays testable and reusable.
