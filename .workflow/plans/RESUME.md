# Session Resume — `user-thinking` skill design (2026-06-23)

> **READ THIS FIRST on restart.** This is the ACTIVE thread. The sox-ecosystem `main` thread
> further below is a *separate* handoff (committed/merged infra work) — do not conflate them.

## What this thread is

Building a **new skill** via the `workflow-agent-builder` protocol.
**Mode: CREATE · Artifact type: skill.** The discovery interview is complete (3 Q&A rounds)
and the Phase 2 plan was presented. **Status: awaiting plan approval, blocked on ONE open
question (catalog placement — see ⛳ below). NO files written yet.**

The user asked for thorough preliminary Q&A (extensions, clarifications, hard requirements,
optimizations) BEFORE any files. That gate is satisfied. Next step after the open question:
build the whole tree + run a smoke test.

## The skill: `user-thinking`

**Purpose:** teach an LLM agent to evaluate a project *as its USER would* — a consumer with
zero internal knowledge, seeking a solution, judging only from what's deliberately made
available. Targets **code repos, doc briefs, URLs/websites, PDFs, slide decks, monorepo
packages** (non-coding generalization is a HARD requirement).

### Core spec (captured so restart is self-sufficient — user will NOT re-paste)

**USER** = consumer who (a) has zero knowledge of internals and doesn't want it, (b) is seeking
a solution to one or more USE_CASE, (c) has base ABILITIES enabling consumption.

**3 LENSES (depth axis — "how far will the user dig"):**
- **Glance** — first surface only (README / landing / slide 1 / PDF p1 / package readme). 5-second-test behavior.
- **Librarian** — thoroughly reads docs *discoverable by following described links* from the entry point; recurses into linked docs whose link text describes them; does NOT explore everything.
- **Motivated** — **unrestricted access to ANY available source** (code, page view-source, network, linked externals, appendices) to reach fact-based conclusions; **logs every dig beyond the readily-surfaced docs** — each = a documentation-insufficiency signal. (This generalized form ABSORBS the originally-proposed 4th "Unrestricted" lens; there is NO 4th lens in v1. Persona-axis lenses deferred to v2.)

**3 ACTIONS (operating modes), each lensed:**
- **Audit** — ABILITIES (nothing too basic; generic→very specific) → Stated Use Cases (every one mentioned, even in passing) → Existing Generalization (true statements about current capability) → Target Market (who'd receive/buy/why/industry/pay) → User Definitions (profiles per stakeholder: discoverer / decider / executor) → assessment table (use cases = cols, profiles = rows; cells 🟢🟡⭐🔴) → gap tables for every non-🟢/⭐ cell → **Final synthesis: does this lens tell a compelling story? YES/NO**.
- **Repair** — given an audit, resolve unanswered (🔴/🟡) items at the lens depth → gap analysis (solved / solvable / unsolved) → per-User ROI & LOE → exact task list for simple solved/solvable → for complex/unsolved, list what must be answered FIRST.
- **Generalize** — problems solved → industry verticals with the *exact* problem → *similar* problems across industries → 3 adjacent-vertical pitches → 3 horizontal (out-of-set) target markets.

**Cross-lens SYNTHESIS (auto, extension E1):** when ≥2 lenses run on one snapshot, emit
`synthesis-<version>.md`: does the YES/NO story **hold or degrade** as reading deepens
(Glance=YES, Motivated=NO is the killer finding).

**HARD LAW — no guessing.** Unknown → 🔴 + skip the section. Never infer. The agent does NOT
resolve unknowns independently.

**Slugs:** every ABILITY/USER/USE_CASE/MARKET/GOAL/PROBLEM gets a unique type-namespaced
kebab-case slug (`ability:`/`user:`/`usecase:`/`market:`/`goal:`/`problem:`), tracked in `slugs.json`.

**JSONL log** (`<process>-<lens>.jsonl`, append-only, one validated event/line) records every
`read`(path,source) · `search`(path/query) · `question` · `answer`(question, resolving path, steps).
Per-event metrics: `chars_read`(int) · `importance`(1–5) · `effort`(`{step_count:int, friction:1–5}`).

**Emoji legend:** 🟢 fully demonstrated · 🟡 partial · ⭐ killer feature · 🔴 unknown/missing/not-demonstrated (🔴 doubles as no-guess skip marker).

### Locked decisions (from 3 Q&A rounds)

| Axis | Decision |
|---|---|
| Placement (S1) | `tools/skills/user-thinking/` — establishes the `tools/skills/` convention here; workspace skill, NO `extension.json` build lifecycle |
| Lenses | 3 (Glance / Librarian / Motivated). No 4th. |
| Operating modes | Audit · Repair · Generalize, each lensed; constrained-defaults + override with a warning on incoherent combos |
| Invocation (S2) | Dual: params (`action`, `lens`, `target`/`entrypoint`, optional `--out`) → headless; else interactive prompt |
| Versioning | content-keyed `audit-<version>`; fingerprint lens-applicable file index (Motivated/maximal set); `docs/usage/.audit-index.json` maps fingerprint→monotonic int. Skill-version change + same fingerprint = overwrite in place; fingerprint change = NEW `audit-<version>`. NO run-ts subfolder. |
| Output base | `./docs/usage/` of CWD, overridable via `--out`. URL/PDF targets: `<version>` fingerprints fetched surfaced index + content hash. |
| Tooling (S5/S0) | templates (CRANE — constrain output, not reasoning) + zero-dep Node ESM helper scripts |
| Supporting docs | README + RATIONALE + COST + CHANGELOG, co-located in the skill dir |
| Research | NONE dispatched; cite established frameworks inline (5-second test, JTBD, Kano, Nielsen heuristics, information scent) |
| Extensions adopted | E1 cross-lens synthesis · E2 metrics rollup · E3 optional first-person empathy trace |

### Skill Rubrics
- **S0 cost class = `generative`.** COST.md ships `f(N,U,P,A,L,R)` (N=artifacts read under lens, U=use cases, P=profiles, A=abilities, L=lenses, R=re-reads). Dominant term ≈ O(U·P) matrix + gap tables. Tooling levers lower it; irreducible core = analytical prose.
- **S5 determinism partition:** scripts (fail-closed) = JSONL append+validate, metrics rollup, fingerprint/version assignment, slug-registry CRUD. prose (judgment, template-constrained) = abilities/use-cases/generalization/market/profiles/scoring/gaps/ROI-LOE/synthesis.
- **S6 description (≤80w, trigger-led):** simulate the USER from available material; near-neighbor ux-researcher studies *real humans*, this *simulates* from material.

### File tree to build (NOTHING written yet)
```
tools/skills/user-thinking/
  SKILL.md            # core: when-to-use, invocation contract, 3 lenses, 3 actions, no-guess law, output contract → refs (progressive disclosure; load-bearing rules in primacy)
  README.md  RATIONALE.md  COST.md  CHANGELOG.md
  references/  lenses.md  processes.md  metrics.md  methodology.md  legend.md  slug-grammar.md
  templates/   audit.md  repair.md  generalize.md  synthesis.md
  scripts/     version.mjs  log.mjs  metrics.mjs  slugs.mjs   # Node ESM, ZERO deps, run via `node`
  schemas/     event.schema.json  slugs.schema.json  audit-index.schema.json
```
Run-time outputs under `--out`/`docs/usage/audit-<version>/`: `<process>-<lens>.md`,
`<process>-<lens>.jsonl`, `metrics-<process>-<lens>.json`, `slugs.json`, and (≥2 lenses)
`synthesis-<version>.md`. Every `.md` header: timestamp · agent name · skill version · git sha
(if present) · lens · process · audited-target version.

### Script responsibilities (delegation-ready)
- `version.mjs` — agent supplies a manifest of lens-applicable files/URLs + content hashes; script fingerprints, consults/updates `docs/usage/.audit-index.json`, returns the `audit-<version>` dir + overwrite-vs-new decision. (Script does NOT fetch — agent gathers, script fingerprints.)
- `log.mjs` — append one schema-validated event to `<process>-<lens>.jsonl`; stamps timestamp (real Node `Date.now()` is fine here).
- `metrics.mjs` — jsonl → `metrics-<process>-<lens>.json` (chars read, counts, doc-sufficiency = answered/(answered+unanswered), effort stats).
- `slugs.mjs` — register/lookup namespaced slugs in `slugs.json` (dedup, stable).

### Smoke test (after build)
Scripts run standalone on a fixture; then `audit Glance` against this repo's `README`/CLAUDE.md
produces a valid `audit-1/audit-glance.md` + non-empty `.jsonl` + metrics rollup, with ≥1 🔴
where the surface omits something.

### Protocol deviations (flagged, intentional)
- No marketplace `sox sync` — workspace skill under `tools/`, not a registry-checksummed extension; C2/C4 sequence does not apply.
- Catalog — see ⛳ OPEN QUESTION.

## ⛳ OPEN QUESTION blocking the build (answer FIRST on restart)

`docs/catalog/` **does not exist in this repo** (verified — nothing named "catalog" anywhere).
It's a construct from the `workflow-agent-builder` *home* project, not sox-ecosystem. So:
- **Option 1 (plan as-is, recommended):** co-locate RATIONALE/COST/CHANGELOG inside `tools/skills/user-thinking/`. Matches existing repo skills (`memory-usage`, `di-skill`); consistent with the user's "README + RATIONALE + COST + CHANGELOG" choice.
- **Option 2:** stand up `docs/catalog/` now — scaffold `docs/catalog/skills/user-thinking/` with full DESIGN/RATIONALE/COST/CHANGELOG/LEDGER + INDEX.md, establishing the convention repo-wide.

User was asked Option 1 vs 2 and chose to restart before answering.

## Next steps on restart
1. Get the Option 1 / Option 2 answer.
2. On approval, build the entire tree (SKILL.md + references + templates + working zero-dep scripts + schemas + README/RATIONALE/COST/CHANGELOG).
3. Run the smoke test; fix until green.
4. Return summary with example invocation + expected output + smoke-test command.

---

# Session Resume — 2026-06-23 (sox-ecosystem `main` infra thread)

**Branch:** `main`. **Everything below this session is committed + merged to `main` and the live migration has run.** Do NOT re-stage or re-implement — verify against `git log` if unsure.

---

## This session's arc (all merged to `main`)

Read newest→oldest in `git log --oneline --merges`. Highlights:

- **Memory subsystem to v1.1** — P4 (19-tool MCP surface incl. `memory_update`), P5 (structured export + SessionEnd auto-refresh), P6 (LLM `memory-organizer` removed; daemon → deterministic `runBatchEnrich`), filtered-clustering review + fixes, doc accuracy, BL-30 version/surface consistency, real-embed test-flake class closed.
- **ADR-0003 — content-addressed identity** (`8fc40bd`): extension identity = `id + sha256(entrypoint)`; per-extension semver retired; `memory_ping` returns the content address; lockfiles v2/bare-id.
- **Upgrade tooling** (`c63cf6f`): `verifyIntegrity` primitive (inherited by install/update/upgrade) + `soxe upgrade --all` (idempotent, all consumers × all scopes) + **auto rolling-restart** of changed services. `CLAUDE.md` AGENT SEQUENCE flipped to **"merge → immediately `soxe upgrade --all`"** (`003f5d2`).
- **BL-31** (`b1d4005`): `sox stop` verified-kill + SIGKILL escalation + store-path **orphan reaper** (fixed the LM-Studio zombie daemon).
- **`@sox` → `@adhd/sox-` scope rename** (`7885a30`) — founder-owned scope; workspace relinked; 0 `@sox` left.
- **BL-37** (`b3bf0d8`): daemon **self-contained bundle** from `bin.ts` + `NODE_PATH` for native addons; e2e Section E spawns from a copied store and asserts it stays up. (Also fixed a no-op-entry stacked bug.)
- **ADR-0004 — data root / placement / ownership index** (`ca20ecf`): `SOX_HOME` split into **`SOX_ECOSYSTEM_HOME`** (data root, default `~/.adhd/sox-ecosystem/`) + **`SOX_SANDBOX_ROOT`** (test-only reroute); user-scope placement → **real `~/.claude`** / global MCP; canonical `.adhd/sox-ecosystem/` layout; **ownership index** (`ownership.json`) tracking every owned file + config-key with `[no-untracked-injection]` / `[reversible-injection]` invariants + a born-conformance **reversibility gate**; `update`/`upgrade` re-materialize service stores (**closed BL-39**). `soxe migrate-home` added.
- **MCP install command fix** (`00e7f9e`, BL-40): `soxe install <mcp>` no longer writes `command:"sox"` (Homebrew audio tool) — now `SOX_CLI_BIN ?? process.argv[1] ?? 'soxe'`. + `docs/mcp-global-availability.md`.

**Live migration RAN:** `soxe migrate-home` relocated data → `~/.adhd/sox-ecosystem/` (install-registry, lockfile, supervisors) and re-placed skills + the `memory-server` MCP entry into the **real `~/.claude`** (`~/.claude.json` has `memory-server`; `~/.claude/skills` has memory-usage, gitnexus*, ticket-creation, …). Idempotent. Daemon (`memory-daemon`) running, **0 LM Studio connections**.

---

## In flight (this turn)

1. **Framework auto-merge of user-scope MCP → project `.mcp.json`** — the durable fix for Claude Code #16728 (project `.mcp.json` shadows user-scope without inheritance). Config-merge the server into each install-registry project's `.mcp.json`, tracked in the ownership index, reversible on uninstall.
2. **BL-41** — server expands a literal `~` `db_path` (no more stray `~/` dirs).
3. This `RESUME.md` refresh.

---

## MCP reachability — full diagnosis (memory unreachable to some agents)

Three independent causes:
1. **Sub-agent `tools:` allowlist** — an agent whose `tools:` omits `mcp__memory-server__*` is blocked from ALL MCP tools (per-agent declaration, no default-inherit). 230 `claude-agents` category agents already have it.
2. **#16728 + worktree trap** — project `.mcp.json` overrides user-scope; `claude-agents`'s root `.mcp.json` has `memory-server` **uncommitted**, so the 5 worktrees (HEAD) lack it. → **(your action, `claude-agents` repo):** `git add .mcp.json && git commit -m "fix(mcp): add memory-server"`, then `git merge`/recreate the worktrees + restart their sessions.
3. **`command:"sox"` collision** — ✅ fixed (BL-40).

The in-flight auto-merge (#1 above) systematizes cause #2 on the sox side.

---

## Open backlog (genuinely Open)

- **BL-33** `check-registry-sync.ts` scanner doesn't recurse into bundle members → false drift
- **BL-34** `sox` app entrypoint not index-resolvable → checksum hashes `extension.json`
- **BL-35** `install()` tests pollute the real install-registry (no path injection) — registry is heavily polluted (~585 records incl. fixtures + a stale `memory-organizer`)
- **BL-36** runtime record hardcodes `type:'mcp-server'` for every detached service
- **BL-38** `memory-server` shares the daemon's latent `tsc`-bare-requires shape + a stale tracked `bundle/`
- **BL-41** literal `~` `db_path` not expanded (being fixed this turn)

(BL-23/24 are folded into the `memory-enrichment` plan; BL-1…22, 25–40 resolved/folded.)

---

## Next planned work
- `runtime-productionization` (`.workflow/plans/runtime-productionization/SCOPE.md`) — P1–P9 already shipped (verify before re-doing).
- Founder env hygiene: `unset SOX_HOME` (retired by ADR-0004; only triggers a warning now).
- The `claude-agents` `.mcp.json` commit + worktree propagation (above).

## Standing invariants (don't regress)
- Identity = content checksum (ADR-0003); `version` is not an identity input.
- Data root = `SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`); placement → real `~/.claude`; sandbox = `SOX_SANDBOX_ROOT` only.
- No untracked injection; every injection is verifiably reversible (ownership index + reversibility gate).
- Build only via nx; never edit `bin/soxe`; explicit-path git staging; merge → `soxe upgrade --all`.
