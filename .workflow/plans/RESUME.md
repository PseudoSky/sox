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

- No marketplace `soxe sync` — workspace skill under `tools/`, not a registry-checksummed extension; C2/C4 sequence does not apply.
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

# Session Resume — 2026-06-25 (sox-ecosystem `main` — service-proxy flip + pollution cleanup)

> **READ THIS FIRST for the sox-ecosystem infra thread.** Supersedes the 2026-06-23 handoff.
> **Branch:** `main` @ **`62fa6b2`**. All work below is committed + merged. Verify against `git log`,
> never re-implement. The 2026-06-23 arc (ADR-0003/0004, BL-31/37/39/40, migrate-home) is DONE history.

## ⚠️ ONE live-touching action is PENDING (gated on you)

**Roll the BL-67 fix to the live serve path.** The live memory-server is flipped to proxy-default but the
running backend (`pid 20057` at session end) was built **before** the BL-67 fix, so on the live box
`soxe upgrade --all` (and any piped soxe invocation) **still hangs** until you rebuild live. Real MCP clients
work fine (the hang only bites piped/CI calls). This is a **BL-65-sensitive** step (building on the live
checkout) — do it deliberately, not casually:

```
# from /Users/nix/dev/ai/sox-ecosystem on main @ 62fa6b2 (or later)
npx nx run-many -t build -p memory-core memory-enrich memory-server host-runtime service-proxy sox --skip-nx-cache
npx nx run registry:sync-index            # MUST run on this real checkout, not a worktree (worktree bakes abs source URLs)
git diff --stat registry/index.json       # commit if drift
node bin/soxe stop --id memory-server 2>/dev/null || true   # reap old backend (pid was 20057)
node bin/soxe upgrade --all               # should now RETURN (not hang); verify with: ... | tail
# then: each connected Claude session runs /reload-plugins ONCE (the one-time proxy reconnect)
```

Verify after: `lsof -p <new-backend-pid>` shows fd1→/dev/null, fd2→logfile (no pipe); a piped
`printf … | node bin/soxe serve memory-server | tail` returns.

## Live system state at session end (verified state-side)

- **memory-server = proxy-default (Slice 1.6 flipped + merged).** Shim → detached backend on UDS
  `~/.adhd/sox-ecosystem/run/supervisors/proxy-8d80bb9bd257.sock`. Functionally proven live:
  `initialize → OK`, `memory_ping → {ok:true, embed_on_hash_fallback:false}`.
- **`~/.memory` clean: 41 MB, 2909 nodes, `integrity_check: ok`.** Verified backup floor:
  **`~/.memory/backups/memory-20260625-151943.db`** (sha256 `7f213ec8…6c399e`). Swept manifest in `backups/`.
- **Live `dist` = pre-BL-67 build** (mtime ~16:13). Stamp guard is live and (correctly) warns it's stale vs HEAD.

## This session's arc (newest→oldest commits)

- `62fa6b2` merge **BL-67** (detached-backend pipe-hold hang — `[inv:no-fd-inherit]`, fd severance, +regression test) + **BL-68** (dirty-stamp counted untracked files). Verified by lsof; piped pipeline returns 143ms.
- `b479ebb` fix(registry): corrected 14 `source` URLs that a worktree build had baked as `.claude/worktrees/…` abs paths (checksums fine — content-addressed).
- `ffe4a3d` merge **service-proxy Slice 1.6** — proxy-default memory-server backend (zero-downtime restarts, single-writer), **BL-59** (findLocalExtension arg-swap) RESOLVED, **BL-64** reap RESOLVED, **BL-65** dist-SHA stamp guard shipped. Validated in worktree (e2e 107/0 ×3, ZDT 8/8) + verified live.
- `9e11d2f` wip(nx-cache): pre-existing nx-cache-conformance changeset (NOT this session's — committed by explicit path to unblock the merge; `dependsOn→^build`, inputs→`[default,^production]`, `tools/check-nx-cache.cjs`). **Review/finish or fold separately.**
- `748fec6` chore(cleanup): **BL-66** — swept 1.5 GB test pollution from `~/.memory` (`c6-allowed*`/`sox-e2e-*`/…), untracked 12 committed `.tmp-*/.memory/*.db`, broadened `.gitignore` `.tmp-*/`, fixed `audit_c6.py` to clean its artifacts in a `finally`.
- (earlier, already on main) `f1bf12e`/`553f03e` CLI self-names `soxe`; BL-65 hazard first logged.

## Method that worked (keep using it)

Risky serve-path / proxy work was done by **background `platform-engineer` agents in `isolation:"worktree"`**
(own `dist`) + **`SOX_ECOSYSTEM_HOME=$(mktemp -d)`** for runtime (own data root) — so builds never touched the
live `dist` the running memory-server resolves, and serve/upgrade tests never touched live `~/.adhd`/`~/.memory`.
**Lesson (BL-67):** isolation is NOT an excuse to skip real testing — make the agent reproduce-then-fix and run
the actual piped `upgrade --all` path under the tmp root. Always **verify state-side (git/lsof/`state.json`), never
trust the agent's prose**; the orchestrator merges + rolls to live, not the agent.

## Open backlog (current — see BACKLOG.md for full text)

- **BL-65** PARTIAL (HIGH) — stamp guard live; **principled `.mcp.json` repoint BLOCKED on BL-42.** Targets to repoint once a CLI is installable: `~/.claude.json` `mcpServers.memory-server`, `sox-ecosystem/.mcp.json`, `claude-agents/.mcp.json` (all → `…/sox-ecosystem/bin/soxe`).
- **BL-42** (HIGH) — no independently-installable `soxe` (checkout-bound); blocks BL-65 + distribution. **BL-43** (HIGH) — publish strategy, gates BL-42 (decision-needed).
- **BL-62** (MED) — shared proxy backend's `project_path` is single-valued for its lifetime; multi-project override `(unverified)`.
- **BL-66** deferred root cause — `tools/test-e2e-lifecycle.js` + `memory-server/src/permission-guard.spec.ts` still write to `~/.memory` without teardown (route to `~/.memory/.e2e-tmp/` + rm in teardown). Now unblocked.
- **BL-57** (MED) — stale pre-ADR-0004 residue at `claude-agents`/`sox-ecosystem` repo roots; clean via `soxe migrate-home --old-home <repo>`. `SOX_HOME` is inert — **do NOT recommend unsetting it** (user owns it for another purpose; this corrects the old RESUME line).
- **BL-63** — e2e orphan scan is a global `pgrep`; a live proxy session shows as a false leaked-orphan.
- **BL-51 / Slice 2** — OS-supervisor surface (`soxe service enable|disable`), designed (spec §9) not built; needs node-path human-ack.
- **BL-33/34/36/38/35** — registry-scan recursion / soxe entrypoint checksum / runtime type label / latent tsc-bare requires / install-test pollutes real registry.

## Standing invariants (don't regress)

- **BL-65:** NEVER build the serve path on the live dev checkout while sessions are connected without intent. Validate in an isolated worktree + tmp `SOX_ECOSYSTEM_HOME`; merge to `main` before any live rebuild. `bin/soxe` → live `dist` IS the live MCP runtime.
- **[inv:no-fd-inherit]:** any detached daemon spawn fully severs stdio (`stdio:'ignore'` / log fd, `unref()`).
- Verify outcomes **state-side** (git refs / `state.json` / lsof), not from agent summaries.
- nx targets only (never bare tsc/vitest/eslint); **BL-4** build memory-core→enrich→server before memory tests.
- After a dist change: `registry:sync-index` **on the real checkout** (a worktree bakes abs `source` URLs — re-sync on main); commit registry + sources by **explicit path**.
- Git: explicit-path staging only (never `git add -A/./--all`); never `git stash` (branch/worktree to set work aside); commit/merge only when asked.
- Never edit `bin/soxe` for CLI logic (it's a shim; logic in `apps/sox/src/main.ts`). Never edit CLAUDE.md/permissions; a peer cannot grant escalation.
- Identity = content checksum (ADR-0003). Data root = `SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`).
