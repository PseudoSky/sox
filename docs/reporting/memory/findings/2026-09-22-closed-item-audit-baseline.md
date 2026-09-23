# BL-225 closed-item audit — instrument + baseline measurement

**Segment D / TRIAGE-SPEC.md item 9. Read-only. No backlog-graph writes performed at any point.**

Instrument: [`tools/audit-closed-items.mjs`](../../../../tools/audit-closed-items.mjs).
Regression test: [`scripts/audit-closed-items.test.mjs`](../../../../scripts/audit-closed-items.test.mjs)
(16/16 passing, collected via the root `vitest.config.ts` include — confirmed with
`npx vitest run scripts/audit-closed-items.test.mjs`, not `nx test`).
Baseline run: 2026-09-23T02:20:13.292Z, against commit `854840ed` (repo HEAD at run time).

## What the brief got wrong, corrected before building

The dispatching brief's Signal A said to `rg` the repo "for the item's `uid` **and** any `BL-<n>`
alias." Both halves of that don't work as written, confirmed empirically before writing the
classifier (not assumed):

- **No test names a `uid`.** Backlog identity is UUID-only in the live store (confirmed:
  `backlog query`'s `fields` enum has no `humanId`; `backlog get` returns none either).
  `docs/reporting/memory/findings/2026-09-22-neardup-rollout-blocked.md` §6 independently confirms
  `humanId` was removed from the backlog tool's own `src/` in commit `9fab4938` — this is a very
  recent (within the week) breaking change, not a long-standing gap. Nobody writes a UUID into a
  test name, so uid-matching contributes **zero** signal and the instrument does not attempt it.
- **`filter.grep` on the backlog `query` verb is not literal substring matching.** Tested directly:
  `{"filter":{"status":"closed","grep":"BL-225"}}` returned 16 items, none containing the literal
  string "BL-225" in the printed title (hits included "BL-405/BL-412 pair", "IS NULLAND", etc.) —
  it reads as fuzzy/semantic, the same trap already recorded for the `text` parameter ("`total`
  is corpus size, not match count"). The instrument therefore pulls **every** closed item's raw
  `title`+`body` (paginated bulk `query`, not per-item `get` — see performance note below) and
  scrapes `BL-<n>`/`BUG-<n>`/`DEBT-<n>` strings client-side with a plain regex, then does **one**
  repo-wide `rg` pass over tracked test files for those strings. Zero reliance on any backlog-side
  text search.
- **The originating brief's own count was already stale by the time this ran.** It quoted 493
  (queried minutes earlier by the architect). This run saw the live total move from 493 → 495 → 496
  across three checks in the same session (concurrent writers, most likely `backlog-filer`). The
  instrument copes by paging until `hasMore` is false and asserting `fetchedCount === lastSeenGraphTotal`
  against whichever total the last page reported — it cannot and does not claim a total that
  outlives the read.

Performance note: the first working version called `backlog get` once per item for body text (a
literal per-item subprocess) and was killed after 2 minutes as unacceptably slow and unnecessary —
`query`'s `fields` enum already accepts `body` in the same bulk paginated call used for the shallow
scan (confirmed empirically, not documented anywhere the schema error message shows). Final run:
10 paginated `query` calls + 1 `rg` pass, **52 seconds wall clock** for all 496 items.

## What the instrument checks

For every closed item (`status: closed` — the store's own meta-status folding
`RESOLVED`/`FIXED`/`SHIPPED`/`VERIFIED` etc.):

1. **`aliasesFound`** — `BL-<n>`/`BUG-<n>`/`DEBT-<n>` strings scraped from the item's own
   `title`+`body` (self-reported at filing time; not all items carry one — see below).
2. **`citedTestFiles`** / **`citedTestFilesExtant`** — the item's `citations[].file` entries that
   look like a test/spec filename, and which of those still exist on disk. A citation to a deleted
   test file is treated as **weaker** than no citation at all, and reported separately.
3. **`greppedHits`** — every occurrence of a scraped alias inside a tracked `*.test.*`/`*.spec.*`
   file, from one repo-wide `rg` pass (not sampled, not per-item — mechanizable at 100% coverage
   over the corpus that exists).
4. **Skip-shape detection** — a ±30-line text window around each hit is checked for
   `it.skip(`/`describe.skip(`/`test.skip(`/`xit(`/`xdescribe(`/`it.todo(`/a frozen
   `{ skip: ... }` option. This is a **window heuristic**, not the AST-based
   `tools/eslint-local/no-hook-assigned-skip.cjs` rule — see LIMITS.
5. **`bodyGuardSuspect`** — a much weaker, explicitly-labelled *lead*: within the same window, an
   `if (...) return/continue` immediately followed by an `expect(` call. This is a text-shape proxy
   for the BL-167 failure mode (an early guard that skips the assertion for exactly the failing
   case), not a detector of it.
6. **Verdict** — `CITED` (a live hit, or an extant cited test file — necessary, not sufficient),
   `SKIP-MASKED` (every hit sits in a statically-skipped window), `UNEVIDENCED` (has a checkable
   alias, zero hits, no extant citation), `NOT-AUDITABLE` (no alias scraped at all, and no test-file
   citation — this instrument has **no way** to check this item, a fact distinct from and worse
   than "checked and found nothing").

## What the instrument cannot check (read this before trusting any row)

1. **It cannot confirm a `CITED` test's assertion actually exercises the failing case** — only that
   a test naming the alias exists and is not, by the window heuristics above, statically skipped.
   That is exactly BL-225's own bar ("you must have seen it fail," not "it would fail"), and
   confirming it requires a human to read the test. No `CITED` row is self-certifying.
2. **Skip detection is a line-window heuristic, not an AST analysis.** It reliably catches a literal
   `.skip(`/`{skip:true}`/`xit(` near a hit. It does **not** reliably catch the BL-167 shape itself
   (a `beforeAll`-assigned variable read into a frozen `skip` option, evaluated before the hook
   runs) — that needs the vitest-collection-timing model `no-hook-assigned-skip.cjs` encodes as an
   ESLint AST rule. Root `eslint`/`Linter` was not resolvable from a bare `node` invocation in this
   checkout within this segment's scope (pnpm's isolated linker nests it several levels down; wiring
   it up would mean either a build step or an `nx`-mediated resolution, both out of this segment's
   pinned, no-nx-target scope) — reusing that rule programmatically is future work, not done here.
   `bodyGuardSuspect` is the deliberately-weaker substitute; it is a lead, not a verdict, and is
   reported as its own field, never folded into `classification`.
3. **It cannot see evidence in an untracked or gitignored file** (`git ls-files` is the tracked-file
   universe, matching `tools/check-backlog-citations.mjs`'s own precedent) — by design: a reviewer
   without local scratch-file access could never see it either.
4. **It cannot disambiguate alias collisions.** Two unrelated items can carry the same self-reported
   `BL-225`-shaped string (a documented, real hazard —
   `tools/backlog-citation-allowlist.json`'s own `_readme` records exactly this happening for
   `BUG-019`). A `CITED` verdict from a shared alias is reported against every item that scraped it;
   only a human, reading both items, can tell true citation from string collision.
5. **`NOT-AUDITABLE` is not "clean."** It means the item's own title/body never recorded a `BL-<n>`
   string and its citations never pointed at a test file — the majority-shape for items filed after
   the `humanId` field was retired, or filed without a self-reported alias in the first place. It is
   the single most important number in this report: it says the BL-225 rule, as currently stated,
   is **not mechanically checkable against a large fraction of the graph's own schema**, which is a
   defect in the rule/schema pairing, not a gap this tool can close by trying harder.

## Baseline distribution (496 closed items, live total at run time — see drift note above)

| Verdict | Count | % |
|---|---:|---:|
| CITED | 329 | 66.3% |
| UNEVIDENCED | 136 | 27.4% |
| NOT-AUDITABLE | 31 | 6.3% |
| SKIP-MASKED | 0 | 0.0% |

`bodyGuardSuspect` (lead only, not a verdict): **4** items, all currently classified `CITED` — i.e.
these look evidenced by the mechanizable signals, but carry a guard-shape near the hit that a human
should specifically look at before trusting the `CITED` verdict.

Priority is sparse across the whole corpus (most items, including in every verdict bucket, carry no
`priority` at all — a fact about the graph, not this tool):

| Verdict | CRITICAL | HIGH | MEDIUM | LOW | (none) |
|---|---:|---:|---:|---:|---:|
| CITED | 12 | 59 | 42 | 19 | 197 |
| UNEVIDENCED | 0 | 2 | 2 | 2 | 130 |
| NOT-AUDITABLE | 3 | 8 | 6 | 5 | 9 |

## Shortlist — highest-risk items (sampled for this report, not exhaustive)

**NOT-AUDITABLE at CRITICAL priority — cannot be checked by this instrument at all, highest
severity in the graph, deserves first human attention:**

- `c6aed07c-1f34-4dfe-887a-d018e218bab5` — "openDb() never creates fts_node or vec_node —
  schema.ts's own comment describes a DDL step [missing]"
- `65daa706-db92-466c-840f-ccf151e9a328` — "DETERMINATION NEEDED (not an unattended alarm): are
  the 716 pre-swap nodes — 403 episodes ... [recoverable]"
- `030d7736-979e-4692-9df8-6d30ef6b3115` — "memory_write drops a write at parallelism 4 and
  surfaces a raw SQLite-flavoured 'database [locked]' error"

**UNEVIDENCED with a scraped alias but zero live/skip-masked test hits and no extant test
citation** — these are the items where the BL-225 rule is checkable and the check came back empty:

- `71f7f0e7-4e4f-4b88-9fc3-3ba8f2810c4d` (HIGH, aliases `BL-001`, `BL-509`) — "backlog
  create-item returned created:true + nodeId 2117 for an item that never persisted — silent
  write [loss]"
- `733afa5e-a752-415e-ba21-5ff0ea27551c` (MEDIUM, alias `BL-371`) — "raw NUL byte at
  tools/eslint-local/no-storage-backend-leak.cjs:287 keeps check-no-nul-bytes guard [red]"
- `e84ef288-479b-4d94-a031-f93d4f41811d` (MEDIUM, alias `BL-588`) — "The primary WAL flush was
  silent on success while its own backstop logged, inverting what the traces [show]"

**`bodyGuardSuspect` leads — currently `CITED`, but flagged for a human second look:**

- `ceb17ffa-bc77-4050-916b-13a1769e8c5d` / `ea49b0e9-2031-492a-ac0f-f6b5f0aaeda4` — both hit in
  `apps/sox/src/bl36-bl178-bl57.spec.ts` (a single spec file covering three aliases — worth
  checking whether each alias's assertion is actually distinct or whether one guards past another).
- `0607e234-0e20-4d4b-a033-68f3b387d633` / `6f23aaa3-0015-4413-87eb-974e5e785467` — both hit in
  `libs/memory-core/src/update.spec.ts:680/682/736` — same file, two different item ids, same
  guard-shape signature; worth checking together.

Full machine-readable output (all 496 rows) was produced by this run but is **not** committed —
it is a point-in-time snapshot against a graph that moves under concurrent writers (see drift
note), and committing it would misrepresent it as durable. Re-run `node tools/audit-closed-items.mjs
--out <path>` to regenerate.

## Scope boundary honored

This tool made **zero** write calls to the backlog graph — every subprocess invocation is
`backlog query` (paginated reads only). It registers no `nx` target and no entry in
`tools/guards-manifest.mjs` or root `project.json`, per the pin in TRIAGE-SPEC.md item 9 (avoiding
collision with Segment C's item-7 work on the same file). Wiring it in as an enforced guard is
explicitly out of scope for this wave (Wave 2, per the batch plan) and is not done here.

## Recommended next step (not performed here — sizing only)

The residual "is a `CITED` verdict a real red→green" question needs human sampling, sized from
this run's own counts rather than the brief's stale assumption of ~125/493: stratify the 329
`CITED` rows by `closedAt` quarter (priority is too sparse — see table above — to stratify on
usefully) and draw ~20 (~6%) for a human read against the actual test. The 4 `bodyGuardSuspect`
rows should be reviewed unconditionally regardless of sample, since they are a targeted signal, not
a random draw.
