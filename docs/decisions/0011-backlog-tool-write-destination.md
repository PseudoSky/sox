# ADR-0011 — The backlog tool becomes the write destination; `BACKLOG.md`/`CHANGELOG.md` progressively deprecate

**Status:** ACCEPTED (2026-08-06).
**Owner:** pseudosky.
**Supersedes:** [`docs/decisions/0009-backlog-source-of-truth.md`](./0009-backlog-source-of-truth.md)
(marked `SUPERSEDED BY 0011` in its own header, body otherwise untouched — its evidence is still
correct and is the baseline this ADR measures forward from).
**Relates to:** `DEBT-BACKLOG-TOOL-MARKDOWN-SPLIT-BRAIN-001` (graph), BL-476, BL-478, BL-475,
BL-416, BL-224, BL-225, BL-435.
**Does NOT authorize:** editing `@adhd/backlog` (external repo, `github.com:PseudoSky/adhd`),
editing `BACKLOG.md`/`CHANGELOG.md`/`PLAN.md`/`STATE.md` by hand, or any code change — this ADR
is design only. Implementation is a separate dispatch, scoped by the stage plan in §4.

## The ruling

The owner ruled, verbatim, 2026-08-06:

> **"All future backlog writes must be migrated to the backlog tool. Progressively deprecate the
> files."**

This reverses ADR-0009's "`BACKLOG.md` is the source of truth for `BL-*` items in this repo,
today" — not because ADR-0009 was wrong when written (2026-08-04), but because the two blockers
it based non-viability on (renderer grammar mismatch, id-allocator collision) are now understood,
scoped, and — critically — do not block the write path this ruling actually asks for. ADR-0009
argued against **regenerating `BACKLOG.md` from the graph**. This ADR does not ask for that. It
asks for the opposite direction: **stop writing the file by hand, start writing the tool, and let
the file wither** (§2, decision D2). That direction was never blocked by anything ADR-0009 found.

## Why this reads as a reversal but isn't one

ADR-0009's own §"What would have to change to make the graph authoritative here" lists three
preconditions, all of them about the **render** direction (graph → markdown):

1. `renderItemsToMarkdown` must emit the heading-marker grammar `check-backlog-markers.mjs` needs.
2. `allocate-bl-id.mjs` / `check-bl-id-integrity.mjs` must validate against the graph.
3. Only then does regenerating `BACKLOG.md` become safe.

None of these gate **stopping hand-writes**. A world where every future `BL-*` item is filed
through `backlog_create_item` and `BACKLOG.md` is never edited by hand again does not need the
graph to render markdown at all — it needs the *opposite* projection, markdown-shaped read access
into what the tool already holds, which `plan-status.mjs` and the two checkers can be pointed at
directly (ruled in §4, Stage 2) without ever asking the renderer to reproduce the heading grammar.
ADR-0009's non-viability argument is scoped to regeneration; it is silent on cutover, and correctly
so — nobody asked that question in that ADR.

## What changes

1. **New `BL-*` items stop being filed by hand-editing `BACKLOG.md`.** They are created via
   `backlog_create_item` (family `BL`, repo `sox-ecosystem`) or the `backlog` CLI/MCP equivalent.
2. **Status transitions, claims, notes, and citations on `BL-*` items** move to the corresponding
   tool calls (`backlog_transition_status`, `backlog_claim_item`, `backlog_append_note`,
   `backlog_add_citation`) instead of hand-edited heading markers and body prose.
3. **`BACKLOG.md` stops being a write target** at the end of Stage 1 (§4) and becomes, for a
   bounded transition window, a **generated snapshot** — not hand-edited, not the input to any
   guard — until Stage 3 removes it from the repo (or reduces it to a stub redirect; ruled in §4).
4. **`CHANGELOG.md`'s `BL-*` entries** move the same direction on the same schedule as `BACKLOG.md`
   (§4, Stage 1 covers both files together — they are two views of one lifecycle, and splitting
   their cutover would leave one direction of the resolve-and-archive flow authoritative in the
   tool while the other still requires a hand edit, which is worse than not starting).
5. **`PLAN.md`/`STATE.md`'s derived blocks** are re-sourced to read the graph instead of
   `BACKLOG.md` (§4, Stage 2) — this is the ruled choice among three alternatives; see §3, Decision
   R2.
6. **The global disclosure protocol at `~/.claude/CLAUDE.md:45`** needs a phase-aware amendment;
   this ADR does not make that edit (out of scope — that file is global, not repo-owned) but
   specifies the exact text change for the owner in §5.

## What does NOT change, and why (files out of bounds)

| File | Why untouched by this ADR |
|---|---|
| `BACKLOG.md`, `CHANGELOG.md`, `PLAN.md`, `STATE.md` | Owner has put these off-limits to hand-editing for this dispatch; the *implementer's* stage-1 packet touches `BACKLOG.md`/`CHANGELOG.md` only through the tool, never a text editor. |
| `docs/decisions/0009-backlog-source-of-truth.md` (body) | Its evidence section is still correct — the renderer/allocator defects it documents are real and independently tracked (BL-478, BL-476). Only the one-line status header changes. |
| `@adhd/backlog` source (`~/dev/node/adhd`) | External repo, not authorized for this dispatch. Every blocker that lives there (§3) is either worked around in this repo or explicitly deferred to it, never patched here. |
| `~/.claude/CLAUDE.md` | Global, cross-repo file. §5 gives the owner the exact line-level recommendation; an agent must not edit it unilaterally. |
| `tools/plan-status.mjs`, `tools/check-backlog-markers.mjs`, `tools/check-bl-id-integrity.mjs`, `tools/allocate-bl-id.mjs` | Named here as **in scope for the implementer**, not out of bounds — listed in this table only to record that *this* document (the ADR) does not itself edit them. The implementer edits them per §4's stage plan. |

## Root cause (why the cutover was blocked, and by how much each blocker actually blocks)

Four blockers were named in ADR-0009 and in fresh 2026-08-06 filings. Read against the *actual*
ruling (stop hand-writing, not regenerate), three of the four turn out not to block Stage 1 at all.

### B1 — `tools/plan-status.mjs` reads `BACKLOG.md`, not the graph

`tools/plan-status.mjs:39,102-119` (`BACKLOG = resolve(ROOT, 'BACKLOG.md')`, `readBacklogStatuses`
parsing `### BL-(\d+) — ` headings via regex) is the sole input to `renderPlanBlock`/
`renderStateBlock`, which write the derived tables in `docs/reporting/memory/PLAN.md` and `STATE.md`
between the `<!-- PLAN-STATUS:BEGIN -->`/`END` markers (`tools/plan-status.mjs:43-44,423-430`).
Nothing in the repo reads the graph today. **This blocks Stage 2, not Stage 1** — see §4.

### B2 — three checker/allocator scripts read/write the markdown; the pre-commit hook enforces two

- `tools/check-backlog-markers.mjs:97` reads `BACKLOG.md` from the shared main-checkout root and
  validates the inline heading-marker grammar (rules 1–5, `tools/check-backlog-markers.mjs:16-23`).
- `tools/check-bl-id-integrity.mjs:110-116` reads both `BACKLOG.md` and `CHANGELOG.md` from the
  same shared root, checking for id collisions across the two files.
- `tools/allocate-bl-id.mjs` (not read in full here, but named identically in both checkers'
  header comments as sharing the same `--git-common-dir`-based root resolution) mints new ids by
  scanning the same markdown.
- `.husky/pre-commit:20,26-30` runs `check-bl-id-integrity.mjs` unconditionally and
  `plan-status.mjs --check` whenever `BACKLOG.md` or the `PLAN.md`/`STATE.md` pair is staged.

**This blocks Stage 1 directly**: the moment an agent files a `BL-*` item through the tool instead
of hand-editing `BACKLOG.md`, that item is invisible to all three scripts and to the pre-commit
hook — not broken, just silently absent from every derived count and from collision protection.
Stage 1 must ship a companion change to these three scripts (or their replacements) in the same
change that changes the filing convention, or the two stores diverge on day one (see §3, Decision
R4, "the dangerous window").

### B3 — renderer/checker grammar mismatch (BL-478) — informational, not a Stage-1 blocker

`backlog_render_to_markdown` calls into `@adhd/backlog`'s `renderItemBlock`
(`entrypoint/backlog/src/markdown.ts:261-274` in `PseudoSky/adhd`, quoted in full in ADR-0009's
body) which emits `### {humanId} — {title}` then a **separate** `**Status:** {STATUS}` body line.
`check-backlog-markers.mjs` requires the status inline in the heading's single bold span
(`tools/check-backlog-markers.mjs:109,122-140`). BL-478 (`BACKLOG.md:3333-3343`) already re-frames
this as **not a regeneration blocker** — because this ADR does not regenerate `BACKLOG.md` from the
tool at any stage (§3, Decision R2 rules that out explicitly), this mismatch never has to be
reconciled. It stays open, tracked at BL-478, informational only, and is not on the critical path
of any stage below.

### B4 — id-allocator collision risk (BL-476) — real, and a Stage-1 blocker for auto-allocated ids

`computeNextHumanId` (`~/dev/sdlc-experiments/arm-rf/rf-run/entrypoint/backlog/src/store/ids.ts:25-55`,
quoted in `BACKLOG.md:3296-3303`) derives the next id as `MAX(live graph nodes' humanId) + 1` and
has zero visibility into markdown-only history. `BACKLOG.md:3311` records the current graph
high-water-mark (`BL-475`, backfilled 2026-08-06) as **coincidentally** equal to the true
markdown+graph max — "self-healing from a one-time backfill, not a fix." The moment the in-flight
CHANGELOG→graph migration (referenced in the dispatch brief) lands with any gap in its coverage, or
any agent files a markdown-only id above the graph's current max through some other path, the next
tool-side auto-allocation can collide with resolved history and silently overwrite it
(`BACKLOG.md:3307`, the `BL-437` collision, is the observed instance of exactly this).

**Mitigation ruled here (§3, Decision R5):** Stage 1 requires every `backlog_create_item` call for
family `BL` in this repo to pass an explicit `idOverride` sourced from a repo-local counter that
Stage 1 itself introduces — not `computeNextHumanId`'s auto-allocation — until BL-476 is fixed
upstream or the "seed on cutover" runbook step is re-verified immediately before each future
migration. This makes B4 a Stage-1-survivable risk rather than a Stage-1 blocker, at the cost of
one new small artifact (§4, Stage 1, item 4).

### B5 — `CHANGELOG.md`'s two heading grammars (measured fresh, 2026-08-06)

Verified directly against the live file rather than trusting the dispatch brief's numbers:

```
$ grep -noE '^### BL-[0-9]+' CHANGELOG.md | sed -E 's/.*(BL-[0-9]+)/\1/' | sort -u | wc -l
198
$ grep -noE '^## \[Unreleased\] — BL-[0-9]+' CHANGELOG.md | sed -E 's/.*(BL-[0-9]+)/\1/' | sort -u | wc -l
60
$ (grep -noE '^### BL-[0-9]+' CHANGELOG.md | sed -E 's/.*(BL-[0-9]+)/\1/'; \
   grep -noE '^## \[Unreleased\] — BL-[0-9]+' CHANGELOG.md | sed -E 's/.*(BL-[0-9]+)/\1/') | sort -u | wc -l
252
$ grep -noE '^#{2,3}.*BL-[0-9]+' CHANGELOG.md | grep -oE 'BL-[0-9]+' | sort -u | wc -l
325
```

**252 distinct ids own a resolved heading** across the two grammars (`### BL-N —` at 198,
`## [Unreleased] — BL-N:` at 60, with overlap between them); **325 distinct ids are named somewhere
in a `##`/`###` heading line.** The gap (73 ids mentioned in a heading without owning one under
either counted grammar — narrower headings, e.g. `## [Unreleased] — BL-416/BL-446/BL-454: …` listing
several ids in one heading, undercount both single-id regexes above) confirms the dispatch brief's
core finding — **any tool keying on a single heading grammar misses real resolved population** —
even though the exact figures differ from the brief's stated 310/324/14 (measured fresh here rather
than reused, per this ADR's "cite what you personally opened" rule). This is a Stage-1 blocker for
any script that would try to derive "is `BL-N` closed" from `CHANGELOG.md` grammar; Stage 1
sidesteps it entirely by not needing that derivation at all (§4).

## Decisions, ruled

Each decision below is final for this ADR. A losing alternative is recorded with the reason it
loses, per house convention (ADR-0010's form).

### R1 — Stage 1 (the first cutover) is: new `BL-*` items only, filed through the tool, with a companion patch to the three markdown-reading scripts so they see tool-filed items too

**Ruling:** The first thing that stops being hand-written is **new item creation**. Existing open
items already in `BACKLOG.md` are **not** bulk-migrated to tool-only status transitions in Stage 1
— they keep being hand-edited in place (claim, transition, resolve, move-to-CHANGELOG) until Stage
3 retires the file. Only brand-new `BL-*` items, from the moment this ADR lands, are filed via
`backlog_create_item` instead of a hand-edited `### BL-<n>` heading.

**What must exist first:** the id-allocator mitigation (B4/R5) and the companion patch making
`check-bl-id-integrity.mjs` and `plan-status.mjs` treat a tool-filed item as counted (§4, Stage 1
items 2–4) — without these, a tool-filed item is invisible to the open-count header and to
collision protection, which is exactly the split-brain this whole migration exists to end.

**Rejected alternative — flag-day cutover (stop all `BACKLOG.md` writes at once, migrate every
open item's status to the tool simultaneously).** Loses because it turns every one of the repo's
own gates red the same day: `plan-status.mjs`'s derived `PLAN.md`/`STATE.md` blocks
(`tools/plan-status.mjs:173-248`) are load-bearing for "what to work on next" across the whole
memory program, and nothing reads the graph yet (B1) — a flag day would either (a) leave those
blocks silently stale (the exact BL-435 failure mode the tool exists to prevent) or (b) require
Stage 2's graph-sourcing to land in the same breath as Stage 1's filing-convention change, which
is two independent, individually risky changes compressed into one commit with no rollback
boundary between them.

**Rejected alternative — migrate by BL-id range (e.g. "everything above BL-480 is tool-only,
everything below stays markdown").** Loses because status transitions do not respect id order —
an old open item (say `BL-99`, still open per `BACKLOG.md:9`'s summary) can be worked and resolved
at any time regardless of when it was filed, so a range split would still require *some* items
below the cutoff to transition through the tool eventually, reintroducing the exact ambiguity ("is
this specific id markdown-authoritative or tool-authoritative right now?") that a clean "new vs.
existing" split avoids. New-vs-existing is a property of the item's origin, permanent and
unambiguous the moment it is created; an id-range split is a property of a counter value that says
nothing about the item's actual lifecycle state.

### R2 — Stage 2 re-sources `PLAN.md`/`STATE.md`'s derived blocks to read the graph directly; `BACKLOG.md` is left to wither rather than regenerated

**Ruling, choosing among the three explicitly-asked alternatives:**

1. ~~Point the checkers at the graph~~ — not chosen as the Stage-2 mechanism (see below; it is
   partially subsumed by R1 already, for id-integrity specifically, but the *derived-status*
   checkers are a different question, resolved by option 3).
2. ~~Make the markdown generated~~ — **rejected**, same reasoning as ADR-0009's rejection of
   regeneration, still fully valid per B3: the renderer's grammar cannot satisfy
   `check-backlog-markers.mjs`'s rules without an upstream fix this ADR does not authorize, and even
   if it could, generating a file whose only consumer is a human reader adds a build step for zero
   functional gain once §3 below the fold reads the graph directly.
3. **Source `PLAN.md`/`STATE.md`'s derived blocks from the graph, and let `BACKLOG.md` wither** —
   **chosen.** `plan-status.mjs`'s `readBacklogStatuses` (`tools/plan-status.mjs:102-119`) is
   replaced with a graph query (`backlog_list_items` or `backlog_export_json`, filtered
   `repo:'sox-ecosystem', family:'BL'`) that produces the same `{id → status}` map its callers
   already consume; `renderPlanBlock`/`renderStateBlock` and the audit machinery
   (`auditProse`, `auditedRegions`) are otherwise **unchanged** — they consume the map, not the file
   format, so this is a narrow, load-bearing-but-contained edit.

**Why option 3 beats option 1 (point the checkers at the graph) as the Stage-2 mechanism, even
though option 1 is exactly what Stage 1 already does for `check-bl-id-integrity.mjs`:**
`check-bl-id-integrity.mjs`'s job (collision detection) is naturally per-write and cheap to check
against a live tool call at filing time. `plan-status.mjs`'s job (deriving a full status table for
every id in scope) is naturally a batch read best served by one `backlog_list_items` call rather
than one lookup per id — so "point the checkers at the graph" is really two different shaped
changes wearing one description, and separating them by stage (id-integrity in Stage 1, status
derivation in Stage 2) matches how each is actually used rather than forcing one uniform mechanism.

**Why `BACKLOG.md` is left to *wither*, not deleted, at the end of Stage 2:** deleting it
immediately removes the one artifact every existing citation, cross-link, and habit in the repo
still points at (`AGENTS.md`'s own Routing section says "defects in `BACKLOG.md`" as of this
writing). Withering means: Stage 2 stops writing it (no tool, no agent, no script touches it),
Stage 3 (§4) is the point where it is either converted to a redirect stub or removed outright, and
that decision is explicitly deferred to Stage 3 rather than ruled now, because it depends on
observations Stage 2 has not produced yet (how many stray external readers exist — see §3, Decision
R6).

### R3 — the two stores are kept from diverging during the transition by making `BACKLOG.md` read-only the instant Stage 1 lands, not by periodic reconciliation

**The dangerous window, named explicitly:** between Stage 1 landing and Stage 3 removing
`BACKLOG.md`, two things are simultaneously true — new items are tool-only, existing items are
still markdown-editable (R1) — so an agent could in principle still hand-edit `BACKLOG.md` to add a
new item out of habit, and nothing in Stage 1 alone stops that except convention.

**Ruling:** Stage 1's companion patch to `check-bl-id-integrity.mjs` (§4, item 3) adds a **new
guard rule**, not merely a read-path change: any newly-staged `### BL-<n>` heading in a commit
where `id > <the Stage-1 cutover watermark>` fails the pre-commit hook with an explicit message
pointing at `backlog_create_item`. This converts "please use the tool" from a convention into a
mechanically enforced boundary at the exact point ADR-0009's own evidence shows conventions alone
have failed (three separate BL-id collision incidents predate this ADR, `check-bl-id-integrity.mjs:5-13`).
No periodic reconciliation job is introduced — a hard filing-time gate is strictly stronger than a
sweep that discovers divergence after the fact, and a sweep would need to solve id-collision
detection anyway, at which point it is only the gate with added latency.

**Rejected alternative — periodic reconciliation (e.g. nightly `backlog_import_from_markdown`
sweep, as ADR-0009 already runs manually).** Loses because it accepts a window, however short,
where the two stores disagree and something downstream (a report, an agent, a dashboard) can read
either one and be correct only by luck. The whole premise of this migration is ending exactly that
condition; a sweep that merely shortens the window without closing it is not "not diverging," it is
"diverging less."

### R4 — Stage boundaries are individually revertible; no stage depends on a later stage's code shipping to be safe to leave half-finished

**Ruling:** Stage 1 (filing convention + guard) is safe to leave running indefinitely on its own —
it does not require Stage 2 or 3 to ever land; the repo simply accrues tool-filed new items forever
if nobody continues the migration. Stage 2 (graph-sourced `PLAN.md`/`STATE.md`) is likewise safe to
leave indefinitely once landed, independent of Stage 3. This is a deliberate design property, not
an accident: each stage's rollback is "stop running the new code path, revert to the prior commit,"
never "undo data that only the new path could have produced," because R1 and R3 together ensure no
stage destroys or moves data the prior stage owned — Stage 1 adds a new source of truth for new
items without touching the old one's data; Stage 2 changes what two files *read*, not what any
store *holds*.

**Rollback mechanics per stage, named explicitly (Risk-adjacent, cross-referenced from §6):**

- **Stage 1 rollback:** revert the companion patch commit. `check-bl-id-integrity.mjs` stops
  enforcing tool-only filing; any tool-filed items already created remain valid graph nodes (they
  are never deleted by a revert) but simply become invisible to the markdown-side tooling again,
  exactly as they were pre-ADR. No data loss — worst case, an agent has to re-file a duplicate in
  `BACKLOG.md` for an item the graph already has, which `check-bl-id-integrity.mjs`'s existing
  advisory Files-overlap check (rule 4, `tools/check-bl-id-integrity.mjs:35-48`) is already
  positioned to flag.
- **Stage 2 rollback:** revert the `plan-status.mjs` data-source patch. The derived blocks resume
  reading `BACKLOG.md`; because Stage 1 never stopped existing-item transitions from being
  markdown-driven (R1), `BACKLOG.md` never went stale for existing items during Stage 2 — only new
  items filed in the interim are missing from it, which is the known, accepted state of the world
  at Stage 1 already.
- **Stage 3 rollback:** restoring a withered/removed `BACKLOG.md` from git history and re-running
  `backlog_render_to_markdown` — or, if Stage 3 chose the redirect-stub shape (R2's deferred
  decision), simply reverting the stub commit. Either shape is a plain `git revert`.

### R5 — id-allocation for tool-filed `BL-*` items uses an explicit `idOverride` from a repo-local counter, never `computeNextHumanId`'s auto-allocation, until BL-476 is closed

Ruled and justified in full under B4 above. Restated here as a decision because it is the one
piece of new infrastructure Stage 1 introduces beyond a filing-convention change: a small
repo-local next-id counter (implementation detail left to the implementer — a file under
`docs/reporting/memory/` or a tools script reading the same `BACKLOG.md`+`CHANGELOG.md` high-water
mark B5 already knows how to compute, cross-checked against the graph's own max before each
allocation) that Stage 1's filing helper consults and passes as `idOverride`.

**Rejected alternative — trust `computeNextHumanId` and re-run the "seed on cutover" backfill
before every Stage-1 filing.** This is ADR-0009's own §"Fix sketch" candidate 1, and BL-476 already
recommends it as the immediate mitigation. It loses here specifically because "before every
filing" does not scale — Stage 1 is meant to make tool-filing the routine path for potentially many
agents per day, and a manual backfill step per filing reintroduces exactly the friction that made
hand-editing `BACKLOG.md` directly (skipping the tool) attractive in the first place. A standing
local counter, computed once at Stage-1 rollout and incremented on each Stage-1 filing thereafter,
gets the same collision-avoidance property without a repeated manual step.

### R6 — what is explicitly NOT decided by this ADR

- **Whether `BACKLOG.md` is deleted outright or reduced to a redirect stub at Stage 3.** Deferred
  to Stage 3 planning, informed by how many external readers (dashboards, other repos' tooling,
  human muscle memory) are observed depending on the file's existence during Stages 1–2. Do not
  infer either outcome from this ADR.
- **The exact shape of the Stage-1 id-counter artifact** (file format, location, whether it is a
  tools script or a flat file) — implementation detail for the implementer, not an architectural
  fork worth an owner ruling.
- **Whether non-`BL-*` families in this repo's graph (`BUG-*`/`DEBT-*`/`FEAT-*`/`INVESTIGATION-*`,
  already graph-native per ADR-0009) are affected.** They are not — this ADR is scoped to the
  `BL-*` series exactly as ADR-0009 was.
- **A firm calendar date for Stage 3.** Sequenced (§4) but not scheduled; Stage 3 starts when Stage
  2 has been running stably and B4's mitigation (R5) has been either superseded by an upstream
  `@adhd/backlog` fix or has demonstrated zero collisions over the Stage-1/2 window — an
  observation, not a date.
- **Whether the eventual `~/.claude/CLAUDE.md:45` disclosure-protocol wording is edited by an agent
  or by the owner directly.** §5 only specifies the recommended text; it does not authorize the
  edit.

## The sequencing plan (dispatchable)

### Stage 0 — prerequisite, must complete before Stage 1 begins

1. Confirm the in-flight CHANGELOG→graph migration referenced in the dispatch brief has landed and
   that `backlog_list_items({repo:'sox-ecosystem', family:'BL'})` returns items with
   `importedFrom: '/Users/nix/dev/ai/sox-ecosystem/BACKLOG.md'` for the full open set (spot-checked
   live during this ADR's authoring — confirmed present for `BL-215`, `BL-202`, `BL-163`, `BL-99`,
   each carrying that `importedFrom` field and a reconciliation note dated 2026-08-06).
2. Compute and record the Stage-1 id watermark: `max(highest BL-N in BACKLOG.md headings, highest
   BL-N in either CHANGELOG.md grammar, highest BL-N live in the graph)`. This is the seed value
   for R5's counter and the cutover threshold for R3's new guard rule.

### Stage 1 — new items only, filed through the tool; existing items keep transitioning in markdown

Blocked on: Stage 0. Blocks: Stage 2.

1. Introduce the R5 id-counter artifact, seeded from Stage 0's watermark.
2. Document (in `CONTRIBUTING.md` or an equivalent process doc — implementer's call, not an
   architectural fork) the new filing procedure: `backlog_create_item` with explicit `idOverride`
   from the counter, family `BL`, repo `sox-ecosystem`.
3. Patch `tools/check-bl-id-integrity.mjs` per R3: add the watermark-based guard rejecting any
   newly-staged `### BL-<n>` heading with `n` above the Stage-1 watermark.
4. Patch `tools/check-bl-id-integrity.mjs` (or the id-counter artifact itself) so a tool-filed item
   is counted for collision-detection purposes — the existing collision check
   (`tools/check-bl-id-integrity.mjs`, check 2, markdown-vs-`CHANGELOG.md`) must also see ids the
   counter has already issued, or a human filing a markdown item directly (still legal for existing
   items under R1) could collide with a tool-issued id the checker never saw.
5. Verify: file one real new Stage-1-era `BL-*` item through the tool during implementation, and
   confirm `check-bl-id-integrity.mjs` and `check-backlog-markers.mjs` both still pass on a commit
   that does *not* add a markdown heading for it (proving the two stores can coexist without the
   pre-commit hook demanding the item exist in both places).

### Stage 2 — `PLAN.md`/`STATE.md` re-sourced to the graph

Blocked on: Stage 1 running stably for at least one full pass of `plan-status.mjs --check` against
a mix of markdown-era and tool-era items (i.e., Stage 2 cannot be validated until at least one
Stage-1-filed item exists to prove the graph read-path sees it). Blocks: Stage 3.

1. Replace `tools/plan-status.mjs`'s `readBacklogStatuses` with a graph-backed equivalent per R2,
   preserving its exact output shape (`Map<number, status-string>`) so every downstream consumer
   (`isOpen`, `classify`, `renderPlanBlock`, `renderStateBlock`, `auditProse`) needs zero changes.
2. Keep `BACKLOG.md` unwritten from this point forward by any script or agent for `BL-*` purposes;
   it becomes a frozen historical artifact of everything filed before the Stage-1 watermark, plus
   whatever pre-Stage-3 minority of existing items are still transitioning in it per R1.
3. Verify: `plan-status.mjs --check` passes reading the graph, and its output is byte-identical to
   the pre-Stage-2 markdown-sourced output for the set of ids common to both (a regression test, not
   an eyeball comparison — the acceptance criteria in the implementer's spec must name this).

### Stage 3 — retire `BACKLOG.md`/`CHANGELOG.md` for `BL-*`

Blocked on: Stage 2 stable, plus the B4 mitigation exit condition from R6 (upstream fix or a
zero-collision observation window). Blocks: nothing — terminal stage.

1. Decide (at Stage-3 time, informed by R6's deferred observation) whether `BACKLOG.md` is deleted
   or reduced to a redirect stub.
2. Migrate any still-markdown-transitioning existing items (the R1 minority) to tool-driven
   transitions, or explicitly grandfather them as historical/closed if they have not moved in the
   observation window.
3. Retire `tools/allocate-bl-id.mjs`, the R5 counter artifact, and the R3 watermark guard — they
   exist only to bridge Stages 1–2; once nothing writes `BACKLOG.md` for `BL-*` at all, id-collision
   between the two stores is structurally impossible rather than guarded-against.
4. Amend `~/.claude/CLAUDE.md:45` per the exact recommendation in §5 (owner-executed, not
   agent-executed, per this ADR's constraints).

### What is blocked on the external repo, and what is not

- **Blocked on `@adhd/backlog`:** nothing in Stages 0–3 above requires an upstream change to ship.
  B3 (renderer grammar) is sidestepped by R2's "never regenerate" ruling; B4 (id-allocator
  collision) is mitigated in-repo by R5's counter without needing `computeNextHumanId` fixed.
- **Would benefit from, but is not blocked by:** an upstream fix to BL-476 (making
  `computeNextHumanId` markdown-aware) would let Stage 3 retire the R5 counter earlier/more simply,
  but Stage 3's retirement of the counter (item 3 above) works equally well as "delete unused code"
  if the upstream fix never lands, since by Stage 3 nothing writes markdown for `BL-*` anymore and
  the collision surface the counter exists to guard against no longer exists either way.

## Recommendation for `~/.claude/CLAUDE.md:45` (owner-executed only)

Current text (`~/.claude/CLAUDE.md:45`):

> `- **Backlog** All deferrals and bugs discovered should be stored to the projects BACKLOG.md at the time of discovery (do not ask the user if you should). If you are working from a plan in the docs/plan/<plan> you must also append the IDs to docs/plan/<plan>/BACKLOG.md`

This is unconditional and repo-blind — it tells every agent, in every project, to hand-edit a file
named `BACKLOG.md` regardless of whether that repo has adopted this ADR's migration. Recommended
replacement (phase-aware rather than repo-aware, since this file is global):

> `- **Backlog** All deferrals and bugs discovered should be filed at the time of discovery (do not ask the user if you should). If the project has an ADR or equivalent ruling establishing a backlog tool as the write destination (e.g. sox-ecosystem's ADR-0011), file through that tool. Otherwise, store to the project's BACKLOG.md. If you are working from a plan in docs/plan/<plan>, also append the IDs to docs/plan/<plan>/BACKLOG.md unless that plan directory's own convention says otherwise.`

`~/.claude/CLAUDE.md:49` ("Completed items move to CHANGELOG.md") needs the same phase-aware
qualifier once Stage 3 lands here; not amended now, since Stage 3 has not landed and premature
wording would assert a state that is not yet true.

## Risks

- **Data destruction:** none of Stages 0–3 delete graph data, and Stage 3 is the only stage that
  removes a markdown artifact — by which point R4's rollback story and R6's deferred
  delete-vs-stub decision both exist specifically to make that removal reversible via `git revert`.
  No stage runs a destructive `nx build`/`nx test` sequence against a `dist/` artifact; this is a
  markdown/graph/tooling change, not a build-artifact change, so BL-235/BL-456 do not apply directly
  — the implementer's spec should still name the exact test commands per the gate below so a suite
  result is attributable (BL-456's rule applies to whatever project hosts the new tests, if any).
- **The dangerous divergence window (R3):** addressed by making the guard block-at-commit-time
  rather than detect-after-the-fact — see R3's full reasoning.
- **Id collision (B4/R5):** addressed by the counter; residual risk is a bug in the counter's own
  seeding (Stage 0 item 2) undercounting the true watermark. The implementer's acceptance criteria
  must include a live collision-probe test: attempt to file an id below the computed watermark and
  confirm the guard rejects it before any real collision can land.
- **Pre-commit hook regressions:** `tools/check-bl-id-integrity.mjs` and `tools/check-backlog-markers.mjs`
  are both invoked unconditionally or near-unconditionally from `.husky/pre-commit` — any bug in the
  Stage-1 patch blocks every commit that touches `BACKLOG.md`/`CHANGELOG.md`/`PLAN.md`/`STATE.md`
  repo-wide, for every concurrent agent. This is the single highest-blast-radius risk in this whole
  migration and is why Stage 1's acceptance criteria (owed by the implementer's spec, not this ADR)
  must be validated against a real commit attempt, not just a script invocation in isolation.

## The gate

This ADR ships no code, so it has no test suite of its own. The implementer's spec (the next
dispatch) must name, at minimum:

- `node tools/check-backlog-markers.mjs` and `node tools/check-bl-id-integrity.mjs`, run directly
  (these are plain node scripts, not nx targets — confirmed by their shebang and by
  `.husky/pre-commit`'s invocation, which calls them with bare `node`, never `npx nx run ...`).
- `npx nx test memory-core` (or whichever project ends up hosting any new regression test for the
  Stage-1 counter or Stage-2 graph-sourcing logic) plus
  `node tools/check-suite-tree-state.mjs --project <that project>` quoted alongside the result, per
  the repo-wide BL-456 rule.
- If `tools/plan-status.mjs` gains a test file (it currently has none — confirmed by
  `find . -iname '*plan-status*'` returning only the script itself), that new spec file's project
  and its `npx nx test <project>` invocation must be named explicitly in the implementer's spec.
- **Never** `npx nx build` on any project as a diagnostic step (BL-235) and never `--skip-nx-cache`
  (owner instruction) — neither applies naturally to this work since it targets `tools/*.mjs`
  scripts outside the nx build graph, but the implementer's spec must still say so explicitly if a
  touched file turns out to belong to an nx project.

---

## Acceptance for this ADR itself

- `docs/decisions/0011-backlog-tool-write-destination.md` exists, follows the house form (context /
  decision / consequences / alternatives, per ADR-0009 and ADR-0010's shape).
- `docs/decisions/0009-backlog-source-of-truth.md`'s header carries `SUPERSEDED BY 0011`; its body
  is otherwise byte-identical to its pre-ADR-0011 state.
- Every blocker named in the dispatch brief (B1–B5 above) appears with its measured current state,
  plus one additional blocker found during authoring (none beyond the brief's own list turned up
  independently — B1–B5 map 1:1 onto the brief's four numbered blockers, with B5 split out from the
  brief's blocker 4 since it is a measurement in its own right).
- The sequencing plan (§4) is specific enough to dispatch Stage 1 directly: it names the exact
  files to patch (`tools/check-bl-id-integrity.mjs`), the exact new artifact to introduce (R5's
  counter), and the exact verification step (file one real item, prove the two checkers both still
  pass without a markdown heading for it).
