# SPEC — ADR-0011 "Stage 2": close the three enforcement holes Stage 1 left open

**Author:** architect (this dispatch). **Implementer:** next dispatch, same worktree/branch.
**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/adr0011-stage2-write-off`
**Branch:** `feat/adr0011-stage2-write-off`

**Naming note, so nobody chases a mismatch:** the dispatch brief calls this "ADR-0011 Stage 2."
The ADR's own §4 numbers Stage 2 as "re-source `PLAN.md`/`STATE.md` to the graph"
(`docs/decisions/0011-backlog-tool-write-destination.md:368-382`, R2). **This work is NOT that.**
It is hardening of the ADR's own Stage 1 (`docs/decisions/0011-backlog-tool-write-destination.md:348-366`)
so the ruling it was supposed to enforce — *"All future backlog writes must be migrated to the
backlog tool. Progressively deprecate the files."* — is actually true, not just true-shaped. Do not
touch `tools/plan-status.mjs`'s data source; that is explicitly out of scope (dispatch brief, "What
you must NOT break," bullet 1) and belongs to the ADR's real Stage 2, later.

---

## 1. Root cause (three holes, each independently sufficient to make the ruling false)

### Hole 1 — the guard is inert wherever `.bl-id-counter.json` is absent

`tools/check-bl-id-integrity.mjs:229-239` reads `.bl-id-counter.json` and, if it does not exist,
sets `counterState = null` and **the entire watermark/issued-id block (checks 4 and 5,
`tools/check-bl-id-integrity.mjs:241-277`) is skipped** — no failure, no warning, just silent
no-op. The file is gitignored (`.gitignore:32`, comment at `.gitignore:25` citing ADR-0011 R5) and
lives only on whichever machine ran `tools/bl-id-counter.mjs --seed` (confirmed live: only the main
checkout at `/Users/nix/dev/ai/sox-ecosystem/.bl-id-counter.json` has it, watermark `478`, next
`480`, `issued: [{id: "BL-479", ...}]` — read directly 2026-08-06). A fresh clone, a CI runner, or
any of the sixteen other worktrees listed by `git worktree list` today that never ran the seeder
has **zero enforcement** for the very check that is supposed to be Stage 1's mechanically-enforced
boundary (ADR-0011 R3, `docs/decisions/0011-backlog-tool-write-destination.md:250-258`).

### Hole 2 — `tools/allocate-bl-id.mjs` still writes `RESERVED` stubs into the shared `BACKLOG.md`

`tools/allocate-bl-id.mjs:179-204` (`main()`, non-`--dry-run` branch) still does exactly what it
did before ADR-0011: acquire the shared lock, compute `maxBlId() + 1`
(`tools/allocate-bl-id.mjs:141-151`), and `appendFileSync(BACKLOG, placeholder)`
(`tools/allocate-bl-id.mjs:193-199`) — a brand-new `### BL-<n>` heading, hand-written, into the one
shared `BACKLOG.md` at the main-checkout root. This is precisely the write path ADR-0011 exists to
retire, and it is a **live, currently-firing defect**: BL-475 (`BACKLOG.md:3228-3262`, filed
2026-08-06) documents this tool breaking the shared pre-commit gate for every concurrent agent
twice in one day — once aborting a `git merge` into `main`, once leaving a `BL-479` stub that
tripped `check-backlog-markers.mjs`'s Rule 4 (header-count mismatch) until cleared by hand.
`--dry-run` (`tools/allocate-bl-id.mjs:180-185`) does not write, but it still computes and prints a
"the next markdown id is BL-N" answer, which is the wrong workflow to be advertising at all now.

### Hole 3 — only *new, above-watermark* `BACKLOG.md` headings are guarded; everything else that
changes the shared record is not

`tools/check-bl-id-integrity.mjs`'s checks 1-5 cover: duplicate heading (1), cross-file id reuse
(2), abandoned reservation stub (3), a heading whose id is numerically above the watermark (4), a
heading whose id the counter already issued (5). None of the five inspects:

- an **edit to an existing `### BL-<n>` heading's title/body** (id ≤ 478) — an agent can rewrite
  `BL-99`'s content into an unrelated new defect and every check passes, because check 4 only fires
  on `n > watermark` and check 1-3/5 do not compare against any prior state at all.
- **any `CHANGELOG.md` edit** — the entire file is read only for check 2's cross-reference lookup
  (`tools/check-bl-id-integrity.mjs:177-197`); nothing rejects a hand-written brand-new
  `## [...] — BL-<n>: ...` entry for an id that never existed anywhere.
- **deleting a heading** — `check-backlog-markers.mjs` validates whatever is *currently* in the
  file; removing a `### BL-<n>` block (e.g. discarding an open item without resolving it) produces
  a file that is still internally consistent and passes every rule.

Worse, `CONTRIBUTING.md:208-210` ("Legacy fallback... write the discovered bug ... to `BACKLOG.md`
at discovery time") **actively documents the below-watermark loophole as sanctioned policy** — it
tells every agent that a *newly discovered* item, if its author judges it "pre-ADR-0011" in spirit,
should be hand-written as a new heading. That is exactly the write path the owner's ruling stops.
This line must be corrected in the same change (§2, file 5 below) or the new guard (§3, Rule G1)
will constantly contradict the repo's own onboarding doc.

---

## 2. The change, file by file

### File 1 — `tools/check-bl-id-integrity.mjs` (extend; primary implementation surface)

Add four new rules, numbered 7-10 in the existing docstring's scheme (checks 1-6 are unchanged —
**do not renumber them**, other tooling/tests may cite them by number). Full rule design in §3.
This is the only file where new *enforcement logic* is written.

### File 2 — `tools/allocate-bl-id.mjs` (retire the write path; keep `--help` working)

- Delete `maxBlId`, `acquireLock`, `releaseLock`, and the body of `main()`'s reservation logic.
  Delete the `REPO_ROOT`/`BACKLOG`/`CHANGELOG`/`LOCK_DIR` resolution and `echoResolvedPaths` — none
  of it is needed once the tool performs zero file/lock I/O. This is a deliberate simplification,
  not just a behavior change: it removes the `git rev-parse` subprocess call too, so the retired
  tool has no dependency on being run inside a git checkout at all.
- Keep argv parsing byte-for-byte: `HELP`, `DRY_RUN`, `recognized`, `unrecognized`, and the
  BL-446 ordering invariant (**parse before any I/O**; `--help` exits 0 with zero I/O;
  an unrecognized flag exits 1 with zero I/O) — `tools/allocate-bl-id.mjs:106-121` stays as-is.
- After that block, for **every remaining invocation** (default mode AND `--dry-run` — both are
  retired, see Decision D3 below), print the retirement message (exact text below) to **stderr**
  and exit **1**. Zero filesystem writes, zero git calls, in any of these paths.
- Update the module header docstring: keep the historical "why this existed" prose (useful
  archaeology for BL-359/BL-416/BL-475 readers) but prepend a `RETIRED (ADR-0011 Stage 2, see
  SPEC-ADR-0011-S2.md)` banner. Update `USAGE` to reflect retirement.

Exact retirement message (implementer may wrap lines, must not change the substance or drop the
`idOverride` warning):

```
allocate-bl-id: RETIRED (ADR-0011 Stage 2). This tool used to reserve a BL-<n> and append a
RESERVED placeholder heading to BACKLOG.md — that write is exactly what ADR-0011 stops (see
docs/decisions/0011-backlog-tool-write-destination.md). File new BL-* items through the backlog
tool instead:

  1. node tools/bl-id-counter.mjs                 # reserve the next id, e.g. BL-479
  2. mcp__backlog__backlog_create_item({
       data: {
         input: {
           family: "BL",
           title: "<short title>",
           body: "<full item body>",
           repo: "sox-ecosystem",
           idOverride: "BL-479",   // from step 1 — never trust the tool's own auto-allocation
         },
       },
     })

See CONTRIBUTING.md §1.9 for the full procedure. No BACKLOG.md write occurred.
```

### File 3 — `tools/test-adr0011-bl-id-counter.mjs` (surgical edit to one arm, cite why)

Arm 6 (`tools/test-adr0011-bl-id-counter.mjs:223-236`) currently asserts that staging a **brand
new** `### BL-102 —` heading (below the watermark, never issued) **passes**. That assertion
documents Stage 1's intentional below-watermark exemption, which this dispatch closes (Hole 3 /
Rule G1, §3). Left unedited, this arm becomes a false assertion the moment Rule G1 ships — a stale
green test asserting behavior that is no longer true, which is exactly the BL-167/BL-225 shape this
repo has been burned by before. This is not "weakening a test to make it pass" (banned) — it is
correcting a test whose premise this spec deliberately invalidates, with the replacement behavior
covered by a *new* dedicated red→green arm elsewhere (§4, AC-G1).

Required edit: change arm 6's scenario from "stage a new BL-102 heading" to "stage an **edit to an
existing heading's status marker only**" (e.g. flip `BL-101`'s `**Open**` to `**Resolved**` while
its title stays identical) — this is the actually-still-legitimate case, and it must keep passing.
Rename the arm's log lines and comment to match (`arm6: editing an existing heading's status marker
(no new heading, no title change) still PASSES`). Do not delete or renumber arms 1-5.

### File 4 — new: `tools/test-adr0011-stage2-write-off.mjs`

New test file, same shape as `tools/test-adr0011-bl-id-counter.mjs` (scratch git repo per arm,
`execFileSync`, `assertTrue`/`ok`/`FAIL` reporting, non-zero exit on any failure). Ten arms,
specified exactly in §4. This is the acceptance harness for this entire dispatch.

### File 5 — `CONTRIBUTING.md` (correct the stale "legacy fallback" carve-out)

`CONTRIBUTING.md:208-210` currently reads:

> Legacy fallback (pre-ADR-0011 items, or items whose id is at/below the Stage-1 watermark, still
> open in `BACKLOG.md`): write the discovered bug, deferral, or limitation to `BACKLOG.md` at
> discovery time. Format: `- [ ] <area>: <description> (discovered <date> during <change>)`

Replace with (exact text, implementer may adjust only whitespace/wrapping):

> **There is no discovery-time exception.** Every newly discovered `BL-*` item, regardless of
> whether it concerns pre- or post-ADR-0011 code, is filed through the tool (step 1-2 above) — the
> pre-commit guard (`tools/check-bl-id-integrity.mjs`, Rule G1) now rejects *any* new
> `### BL-<n>` heading in `BACKLOG.md`, not only ones above the watermark. To add information to an
> **existing** open item (still markdown-native, id ≤ the Stage-1 watermark), edit that heading's
> body in place — do not create a new heading for it, and do not create a new heading to hold an
> unrelated new finding.

Also update `CONTRIBUTING.md:203-206` (the paragraph right above, which currently only describes
the watermark/issued-id enforcement) to mention Rule G1's unconditional new-heading block and
Rule G2's CHANGELOG guard, so a reader sees the accurate, current enforcement surface rather than
Stage 1's narrower description. Cite `tools/check-bl-id-integrity.mjs`'s rule numbers, not prose
paraphrase, so this doc cannot drift out of sync with the code the way `PLAN.md`/`STATE.md` once did.

### Files explicitly OUT OF BOUNDS for this dispatch, and why

| File | Why untouched |
|---|---|
| `tools/plan-status.mjs` | Reads `BACKLOG.md`, not the graph — that is the ADR's *real* Stage 2 (R2), explicitly deferred. Editing it here would silently absorb a second, unrelated, higher-risk change into this dispatch. |
| `tools/check-backlog-markers.mjs` | Its Rules 1-5 (heading grammar, header-count) are orthogonal to "who is allowed to write a heading" — Rule G1/G2 below are a strictly separate concern layered on top via `check-bl-id-integrity.mjs`'s existing delegation (`tools/check-bl-id-integrity.mjs:168-174`). No change needed there. |
| `BACKLOG.md`, `CHANGELOG.md`, `PLAN.md`, `STATE.md` | Same prohibition ADR-0011 itself states (`docs/decisions/0011-backlog-tool-write-destination.md:71`) — this dispatch's own test fixtures live in scratch repos (`fs.mkdtempSync`), never the real files. The only exception is reading the real `.bl-id-counter.json`/`BACKLOG.md` for verification (read-only) — see §5 Risks. |
| `~/.claude/CLAUDE.md` | Global file, owner-executed only. The ADR already drafted the exact replacement text (`docs/decisions/0011-backlog-tool-write-destination.md:411-421`) — this spec does not redraft it; carried forward unchanged in §6. |
| `docs/decisions/0011-backlog-tool-write-destination.md` | Its own rule: body changes only when a *stage* it describes changes; this dispatch is hardening within Stage 1's already-described boundary, not a new stage. No ADR edit. |
| `@adhd/backlog` | Not authorized, per every prior dispatch in this chain. |

---

## 3. Every decision, ruled

### D1 — Hole 1's fix is NOT "make the watermark travel." It is realizing the load-bearing check
never needed the watermark at all.

**Ruling:** Add **Rule G1 (BACKLOG.md, HARD FAIL, unconditional)**: any `### BL-<n>` heading line
that appears as a pure addition (`+` with no matching `-` for the same `<n>`) in
`git diff --cached -U0 -- BACKLOG.md` (run with `cwd: INVOKING_ROOT`, exactly the existing pattern
`tools/check-bl-id-integrity.mjs:280-284` already uses for the advisory check-6 diff) is rejected —
**with or without `.bl-id-counter.json` present.** Git history is universally available on every
checkout by definition (it is not gitignored); a diff against the committing repo's own `HEAD` is
non-inert everywhere, always, with zero seeded state required. This makes the counter file's
presence irrelevant to the load-bearing part of the guard — it degrades from "the only enforcement
mechanism" (Stage 1) to "an optional, additional, richer-diagnostic layer" (checks 4/5, kept as-is,
still counter-gated, still fire *in addition to* G1 when the counter happens to be present, adding
a more specific "above the watermark" / "collides with an issued id" message alongside G1's generic
one). No commit, no data movement — literally zero code depends on `.bl-id-counter.json`'s
existence being knowable at checkout time.

**Rejected alternative — commit `.bl-id-counter.json` (or just its `watermark` field) to git.**
Loses on two counts: (a) `issued` is mutable, appended-to on every reservation across every
concurrent agent and worktree — committing the file invites exactly the merge-conflict/staleness
problem BL-416's shared-root design exists to avoid, now replicated as a git-tracked file instead
of a filesystem coordination point; (b) it is strictly weaker than G1 anyway — a committed watermark
would still only catch *above-threshold* new headings, leaving the "new heading using an unused
below-threshold number" loophole (CONTRIBUTING.md's now-corrected "legacy fallback" text) wide
open. G1 catches both shapes for free because it never reasons about numeric thresholds at all.

**Rejected alternative — derive the watermark at runtime (e.g. `git log` scan for the highest ever
`### BL-<n>` heading across history).** Loses because it is strictly more expensive and no more
correct than G1: it would still only produce a numeric threshold, inheriting the same
below-threshold gap as the alternative above, for a heavier runtime cost (full-history scan vs. a
single `--cached` diff already being computed).

**Consequence, stated plainly:** this closes the Stage-1 "legacy fallback" loophole
(CONTRIBUTING.md:208-210, corrected in §2 File 5) as a side effect — a *deliberate*, ruled behavior
change from Stage 1, not a regression. Stage 1's test arm 6 documented the old, now-superseded
behavior; §2 File 3 corrects it.

### D2 — Hole 2's fix retires both the write path and the `--dry-run` preview path, keeps `--help` only

**Ruling:** both `main()`'s default branch and its `--dry-run` branch are retired identically (§2
File 2). **Rejected alternative — keep `--dry-run` computing a real "next markdown id" answer.**
Loses because `--dry-run`'s entire value proposition ("preview the id you'd get if you filed by
hand") is itself advertising the deprecated workflow; a caller who runs `--dry-run` today is, by
construction, about to do the wrong thing next. There is no legitimate reason left to preview a
markdown-side id once §3's Rule G1 rejects the write it would precede.

### D3 — TITLE-LOCK and DELETE-REQUIRES-RECORD are advisory (WARN), not blocking (FAIL); NEW-HEADING
and NEW-CHANGELOG-ID are blocking

**Ruling, per rule:**

- **Rule G1 (new `BACKLOG.md` heading) — HARD FAIL.** Zero ambiguity: post-cutover there is no
  legitimate reason for a brand-new heading to appear by hand, in any form, at any id. This is the
  dispatch's entire reason for existing; a WARN here would ship nothing.
- **Rule G2 (new `CHANGELOG.md` entry for a never-before-seen id) — HARD FAIL.** Same reasoning as
  G1, applied to the file that currently has *zero* coverage (Hole 3). Design in the Rule G2
  paragraph below.
- **Rule G3 (existing-heading title/content changed) — WARN, not FAIL.** An edited title is
  ambiguous in a way a brand-new heading is not: a typo fix, a title clarified after triage, or a
  genuine content swap (the thing we actually want to catch) are structurally indistinguishable to
  a text diff. The dispatch brief explicitly instructs "prefer a warning over a hard failure where
  the case is ambiguous" — this is that case. A false-positive HARD FAIL here, on a shared
  five-agent-concurrent checkout, is a repo-wide outage for a heuristic that cannot tell the two
  apart; a WARN preserves the audit trail (it prints, it is visible, a reviewer can act on it) without
  blocking legitimate work.
- **Rule G4 (existing heading deleted without a corresponding CHANGELOG record) — WARN, not FAIL.**
  Same ambiguity class: a deletion could be a legitimate resolve-and-archive whose CHANGELOG record
  landed in an *earlier* commit (G4's same-commit check, defined below, cannot see that), or a
  genuine silent-discard. WARN surfaces it for review without blocking the (more common) case where
  the archival already happened.

**Rejected alternative — make G3/G4 HARD FAIL too, for full symmetry with G1/G2.** Loses for the
reason stated above per-rule, and doubly loses against the dispatch brief's explicit steer: five
concurrent workflows are committing to this shared checkout right now, several with in-flight
close-outs (the common legitimate case, named explicitly in the brief) — a false HARD FAIL on a
same-day typo-fix-during-triage would block every one of them until a human intervenes, which is a
strictly worse outcome than a WARN a reviewer skims and files away.

### D4 — Rule G1/G2/G3/G4 all read the "before" state from `INVOKING_ROOT`'s own `HEAD`, never
`REPO_ROOT`'s live on-disk file

**Ruling:** all four new rules use `git diff --cached -U0 -- <file>` with `cwd: INVOKING_ROOT`
(the pattern already established by check 6, `tools/check-bl-id-integrity.mjs:280-311`) as their
sole source of "what changed in this commit." Checks 1-5's existing REPO_ROOT-based *static content*
reads (`backlogText`, `changelogText`, `backlogHeadingIds`, `changelogClaimedIds` —
`tools/check-bl-id-integrity.mjs:130-197`) are reused **read-only**, as an additional permissive
"was this id ever known anywhere" signal for G2 (see G2's design below), never as the diff baseline.

**Why:** the committing worktree's own git history is the only semantically correct basis for "did
*this commit* introduce a new heading" — a worktree's on-disk `BACKLOG.md` and the main checkout's
shared copy are, by BL-416's own design, two different files coordinated by convention, not two
views of one file (`tools/allocate-bl-id.mjs:51-61` documents this explicitly: "a worktree's own
on-disk `BACKLOG.md` is a DIFFERENT FILE from the one this script reads and writes"). Diffing
REPO_ROOT's live content against anything would compare a file the committing agent may never have
touched at all against its own commit, misattributing other agents' concurrent edits.

**Residual risk, named, not fixed here:** if a worktree's own `BACKLOG.md` has drifted far behind
`main` (BL-475's still-open coordination problem), G1 can false-positive on a heading that is
genuinely old but simply hasn't been merged into that worktree's history yet. This risk is **smaller
after this dispatch than before it**, because Hole 2's fix (§2 File 2) removes the one write path
that used to inject drift into the shared copy out-of-band (`allocate-bl-id.mjs` no longer appends
anything anywhere) — the remaining drift source is ordinary concurrent editing of *existing* items,
which a `git pull`/rebase before committing already has to handle for any file in this repo. Do not
attempt to fix BL-475 itself in this dispatch (explicitly out of scope per the dispatch brief).

### D5 — Rule G2's "known id" baseline unions four sources, but (c)/(d) are gated to the
multi-worktree case only — **amended after implementation; the original unconditional-union
wording below was a real defect, not just prose, see the correction at the end of this section**

**Ruling:** Rule G2 rejects a newly-added CHANGELOG.md heading (`## [...] — BL-<n>...` or a
restatement `### BL-<n>`) claiming an id `<n>` **only if `<n>` appears in NONE of**: (a)
`INVOKING_ROOT`'s own `HEAD` `CHANGELOG.md` claimed ids, (b) `INVOKING_ROOT`'s own `HEAD`
`BACKLOG.md` heading ids, (c) `REPO_ROOT`'s current on-disk `backlogHeadingIds`
(`tools/check-bl-id-integrity.mjs:180-182`, already computed), (d) `REPO_ROOT`'s current on-disk
`changelogClaimedIds` (`tools/check-bl-id-integrity.mjs:194-197`, already computed) — **but (c)/(d)
apply only when `REPO_ROOT !== INVOKING_ROOT`** (see correction below). This is a union across up
to four sources specifically to minimize false positives — an id is rejected only when it is
recognized by **none** of the applicable ones, i.e. it was never a `BACKLOG.md` heading anywhere the
checker can see and never previously claimed in `CHANGELOG.md` anywhere the checker can see. That is
exactly "this id was invented out of thin air," the actual gap (Hole 3's "any `CHANGELOG.md`
edit... still unguarded").

**Rejected alternative — only check `INVOKING_ROOT`'s own history (drop (c)/(d) entirely).** Loses
because the ordinary, encouraged resolve-and-archive flow can legitimately close an item whose
`BACKLOG.md` heading the committing worktree never itself saw fresh (e.g. it was added to the
shared `main` after this worktree branched) — reusing the already-computed REPO_ROOT sets (c)/(d),
which cost nothing extra since checks 1-5 already read them, closes that false-positive path for
free in the case where `REPO_ROOT` genuinely is a different file (i.e. a worktree).

**Correction (post-implementation) — (c)/(d) must be excluded when `REPO_ROOT === INVOKING_ROOT`.**
The unconditional-union wording above was wrong as literally specified: `(c)`/`(d)` are computed by
`readFileSync(BACKLOG/CHANGELOG)` against `REPO_ROOT` at the top of the script
(`tools/check-bl-id-integrity.mjs:152-156`). In the ordinary single-checkout case — no worktree,
`REPO_ROOT === INVOKING_ROOT`, confirmed identical via `--git-common-dir`+`..` vs. `--show-toplevel`
— that read hits the *same working-tree file* the commit under test is staging, since a change must
be on disk before `git add`/`git diff --cached` can see it at all. A brand-new, fabricated
CHANGELOG id would therefore already appear in `changelogClaimedIds`, making `(c)`/`(d)`
self-referentially "recognize" it as already known and **permanently defeating G2 for the exact case
its own acceptance test (AC-G2, a plain scratch repo with no worktree) exercises**. Verified live:
without the guard, AC-G2 cannot detect the fabricated id at all.

**Ruling, corrected:** `(c)`/`(d)` are included in `knownIds` **only when `REPO_ROOT !==
INVOKING_ROOT`** (`tools/check-bl-id-integrity.mjs:421-427`, `repoRootIsInvokingRoot` guard). This
loses none of the original protection: `(a)`/`(b)` are `git show HEAD:<file>` reads, immune to
staging by construction, and already fully cover "known before this commit" for the single-checkout
case — nothing legitimate depended on `(c)`/`(d)` there. `(c)`/`(d)` retain their full value for the
genuine multi-worktree drift case this rule exists to protect (a worktree's own `HEAD` doesn't yet
contain a heading landed on `main` after it branched) — that is precisely the case where `REPO_ROOT`
is a different file from `INVOKING_ROOT`, so the guard fires exactly where the original rationale
applies and nowhere else. Verified: AC-G2 (illegitimate, single-checkout-shaped) correctly rejects
with the guard in place; AC-G2-legit (same-commit resolve-and-archive) still passes via the
`HEAD`-based `(b)` source alone.

### D6 — Rule G3 (title-lock) compares only the **title segment**, never the body

**Ruling:** extract, per changed id, the substring between `— ` and the heading's bold status span
(`### BL-<n> — <TITLE> — **status**...`) from the `-` line and the `+` line; WARN if they differ.
Body text (everything after the heading line, to the next `---`/heading) is explicitly **not**
compared. **Rejected alternative — lock the body too.** Loses because body edits are exactly what
legitimate close-out work does: appending root-cause findings, citations, resolution notes, or
"Driver" text discovered while working the item is normal and required (`CLAUDE.md`'s own
Disclosure protocol mandates citations be added to the item). Locking the body would flag — or with
a HARD FAIL, block — the single most common legitimate edit this dispatch is required to preserve.

### D7 — Rule G4 (delete-requires-record) checks only the same-commit CHANGELOG.md diff plus
REPO_ROOT's current CHANGELOG content, not full history

**Ruling:** for each id whose `### BL-<n>` heading is removed (`-` line, no matching `+` for the
same id — i.e. genuinely deleted, not edited-in-place), WARN unless `<n>` is claimed by (a) an
added (`+`) line in the same commit's `CHANGELOG.md` diff (`cwd: INVOKING_ROOT`), or (b)
`REPO_ROOT`'s current on-disk `changelogClaimedIds` (already computed, reused per D5's precedent).
**Rejected alternative — walk full git log for a prior CHANGELOG.md record.** Loses on cost/benefit:
this is an advisory WARN, not a gate that must never miss a valid case (D3) — a cheap two-source
check that catches the overwhelmingly common "resolve and archive in one commit" pattern is
proportionate; a full-history walk adds real latency to every commit that touches `BACKLOG.md` for
a signal that is already non-blocking.

---

## Rule G1/G2/G3/G4 — implementation shapes (for the docstring + code)

Insert as checks 7-10 in `tools/check-bl-id-integrity.mjs`'s existing numbered-comment scheme
(after the existing check 6 block, before the `if (failures > 0)` tail at
`tools/check-bl-id-integrity.mjs:313`). Compute the two diffs once, share them across rules:

```js
// shared diff helper, cwd: INVOKING_ROOT, mirrors the existing check-6 pattern exactly
function diffLines(file) {
  try {
    return execFileSync('git', ['diff', '--cached', '-U0', '--', file], {
      cwd: INVOKING_ROOT, encoding: 'utf8',
    });
  } catch { return ''; }  // no staged changes to this path, or detached checkout — same
                           // tolerance the existing check-6 try/catch already applies
}
const backlogDiff = diffLines('BACKLOG.md');
const changelogDiff = diffLines('CHANGELOG.md');
```

- **G1** — from `backlogDiff`, collect `added = Map<id, fullHeadingLine>` from `^\+###\s*BL-(\d+)\s*—.*$`
  and `removed = Set<id>` from `^-###\s*BL-(\d+)\s*—.*$`. For every `id` in `added` not in `removed`
  → `fail(...)`, message names the id, says "brand-new heading — file it through the tool", cites
  CONTRIBUTING.md §1.9.
- **G2** — from `changelogDiff`, collect `addedChangelogIds` from added lines matching the SAME
  regex checks 2 already uses for `changelogClaimedIds` (`tools/check-bl-id-integrity.mjs:195-197`)
  applied to `+`-prefixed lines only. `known = union(headIdsFromInvokingRootHead('CHANGELOG.md'),
  headIdsFromInvokingRootHead('BACKLOG.md'), backlogHeadingIds, changelogClaimedIds)` (D5). For
  every id in `addedChangelogIds` not in `known` → `fail(...)`.
- **G3** — from `added`/`removed` (G1's maps, reused), for ids present in BOTH, extract title via
  `/^###\s*BL-\d+\s*—\s*(.*?)\s*—\s*\*\*/` on each side; if titles differ → `warn(...)` (D6).
- **G4** — for ids in `removed` (G1) not in `added` (a true deletion, not an in-place edit), check
  membership in `addedChangelogIds ∪ changelogClaimedIds` (D7); if absent → `warn(...)`.

`headIdsFromInvokingRootHead(file)` — new small helper: `execFileSync('git', ['show', \`HEAD:${file}\`], { cwd: INVOKING_ROOT, encoding: 'utf8' })` wrapped in try/catch (returns `''` if the path
doesn't exist at `HEAD`, e.g. a repo whose very first commit adds `BACKLOG.md`), then apply the same
id-extraction regex as the corresponding `REPO_ROOT` computation.

---

## 4. Acceptance criteria — `tools/test-adr0011-stage2-write-off.mjs`, ten arms

Each arm below names its RED (must fail without the fix) and GREEN (must pass with it) explicitly,
per BL-225. All ten arms always execute — no arm may be skipped/gated behind a flag (BL-469); a
`SKIP` state does not exist in this harness, only `PASS`/`FAIL`, mirroring
`tools/test-adr0011-bl-id-counter.mjs`'s existing `assertTrue` shape exactly (reuse it, don't
reinvent).

**AC-G1a — Hole 1 is closed: guard is non-inert with NO counter file present.**
Scratch repo, commit a baseline `BACKLOG.md` with only `BL-100`/`BL-101`, **do not create
`.bl-id-counter.json` at all**. Stage a new `### BL-999 —` heading. Run
`check-bl-id-integrity.mjs`. RED (pre-fix): exit 0 — checks 4/5 are skipped
(`counterState === null`) and nothing else inspects new headings, so the violation ships silently.
GREEN (post-fix): exit 1, stderr matches `/brand-new|new heading/i` and names `BL-999`, with no
reference to "watermark" (proves G1 fired independent of the counter, not check 4).

**AC-G1b — the below-watermark loophole is closed.**
Same scratch setup as `test-adr0011-bl-id-counter.mjs` arm 4/5/6 (counter present, watermark 478).
Stage a new `### BL-102 —` heading (below watermark, never issued — the exact scenario the OLD
arm 6 asserted PASSES). RED (pre-fix, i.e. checks 1-6 only): exit 0. GREEN (post-fix, G1 active):
exit 1, stderr names `BL-102`.

**AC-G1c — legitimate status-transition edit to an EXISTING heading still passes (no counter
needed either).**
Scratch repo, no counter file. Commit baseline with `BL-100 — Title — **Open**`. Stage an edit that
changes ONLY the bold span to `**Resolved**`, title unchanged. RED is not applicable here (nothing
in the pre-fix script would have failed this — it's a positive-path proof, not a red/green pin);
assert GREEN only: exit 0, no FAIL lines. This is "Prove a legitimate close-out edit still
succeeds," required verbatim by the dispatch brief.

**AC-allocate-write — `allocate-bl-id.mjs` makes zero `BACKLOG.md` changes on default invocation.**
Scratch repo with a `BACKLOG.md` present. Snapshot its bytes. Run `node tools/allocate-bl-id.mjs`
with `cwd` inside the scratch repo (temporarily override its git-common-dir resolution is NOT
needed — since the tool no longer resolves `REPO_ROOT` at all per §2 File 2, this run doesn't even
need to be inside a git repo; use a plain `fs.mkdtempSync` directory, not a git-inited one, to prove
that too). RED (pre-fix): a `RESERVED` heading is appended, bytes change, exit 0. GREEN (post-fix):
bytes byte-identical before/after, exit 1, stderr matches `/RETIRED/`.

**AC-allocate-dryrun — `--dry-run` is retired identically.**
Same as above with `--dry-run`. RED (pre-fix): exit 0, prints a `BL-<n>` id, zero file writes (this
arm's RED is about the *behavior*, not a file mutation — assert the pre-fix script prints a bare
`BL-\d+` line). GREEN (post-fix): exit 1, stderr matches `/RETIRED/`, no `BL-\d+`-only stdout line.

**AC-allocate-help — `--help` is unbroken (BL-446 non-regression).**
Run `node tools/allocate-bl-id.mjs --help`. Assert exit 0, stdout contains `Usage:`, stdout does
NOT contain `RETIRED` on its own decision path being treated as an error (i.e. help still exits 0
and reads as a normal usage banner, not a failure message) — and, separately, assert the process
performed no git subprocess call: run it with `cwd` set to a directory that is **not** a git repo at
all (`fs.mkdtempSync`, no `git init`) and confirm it still exits 0 (proves `--help` truly does zero
git I/O, closing off any future regression where someone moves the `REPO_ROOT` resolution back above
the `HELP` check).

**AC-G3 — title-lock WARNs, does not block, on a content-swap edit.**
Scratch repo, counter absent (proves independence). Commit baseline `BL-100 — Original title —
**Open**`. Stage an edit changing the title to `BL-100 — Completely different defect — **Open**`
(status unchanged). RED (pre-fix): exit 0, zero WARN output referencing title/content. GREEN
(post-fix): exit **0** still (WARN, not FAIL — D3), but stderr contains a WARN line matching
`/title|content/i` naming `BL-100`. Assert BOTH the exit code AND the warning text — this arm is
the one place where "exit 0" is not sufficient proof of correctness; the test must also fail itself
if the WARN text is silently absent (i.e. this is the BL-469 "a skip must not report as a pass"
principle applied to a WARN that must not report as silence).

**AC-G2 — a brand-new CHANGELOG.md heading for a never-seen id is rejected.**
Scratch repo, commit baseline `BACKLOG.md` (BL-100/101 only) and `CHANGELOG.md` with no BL
references at all. Stage a NEW `CHANGELOG.md` entry `## [Unreleased] — BL-999: fabricated fix`
(BACKLOG.md unchanged/unstaged). RED (pre-fix): exit 0 (nothing today reads CHANGELOG.md for
additions at all outside check 2's cross-reference, which requires a *BACKLOG.md* heading to exist
first — this arm has none). GREEN (post-fix): exit 1, stderr matches `/BL-999/` and references
CHANGELOG.

**AC-G2-legit — a resolve-and-archive commit (BACKLOG.md heading removed, CHANGELOG.md entry
added, SAME commit) passes cleanly — the second required "legitimate close-out" proof, this time
spanning both files.**
Scratch repo, commit baseline with `BL-100 — Title — **Open**` in `BACKLOG.md`, empty
`CHANGELOG.md`. Stage: remove `BL-100`'s heading from `BACKLOG.md`, add `## [Unreleased] —
BL-100: shipped` to `CHANGELOG.md`, in the same staged commit. Assert exit 0, no FAIL lines. (G4
should not even WARN here, since G2's `addedChangelogIds` covers `BL-100` for D7's lookup — assert
no WARN naming BL-100 either, proving G1/G2/G3/G4 all correctly recognize this as the intended flow.)

**AC-G4 — deleting a heading with no CHANGELOG record anywhere WARNs.**
Scratch repo, commit baseline with `BL-100 — Title — **Open**`, empty `CHANGELOG.md`. Stage: remove
`BL-100`'s heading, no CHANGELOG.md change at all. RED (pre-fix): exit 0, no WARN. GREEN
(post-fix): exit 0 still (WARN not FAIL — D3), stderr WARN line names `BL-100`, references deletion
and archival.

---

## 5. Risks

- **Repo-wide pre-commit outage (the dispatch brief's named top risk).** Mitigated by: (a) D3's
  WARN/FAIL split — the two ambiguous rules (G3/G4) never block a commit; (b) AC-G1c and
  AC-G2-legit are mandatory proofs that the two named "common legitimate case" flows (status-only
  edit; same-commit resolve-and-archive) both pass cleanly under the new rules, run BEFORE this
  lands, not after a live incident. Implementer must run the full new suite (§6) against the exact
  scratch scenarios above and see them pass BEFORE opening any PR/merge — this is not optional
  smoke-testing, it is the gate.
- **Testing against the real, shared `BACKLOG.md`/`CHANGELOG.md`/`.bl-id-counter.json`.** All ten
  new arms and the corrected arm 6 use `fs.mkdtempSync` scratch repos exclusively — **never** stage
  or commit against the real files at `/Users/nix/dev/ai/sox-ecosystem/{BACKLOG,CHANGELOG}.md` or
  run `tools/bl-id-counter.mjs --seed/--reseed` for real. The only permitted real-repo interaction
  is a read-only smoke check: `node tools/check-bl-id-integrity.mjs` from the worktree with nothing
  staged (must print the existing "skipped — neither... staged" line, exit 0) — this proves the
  new rules don't fire spuriously when neither file is part of the commit, without touching live
  state. Do not `git add BACKLOG.md`/`CHANGELOG.md` for real at any point in this dispatch.
- **No `dist/`/build artifact is touched.** This work is entirely `tools/*.mjs` (plain node
  scripts, no nx project — confirmed: `tools/project.json` does not exist) plus `CONTRIBUTING.md`.
  BL-235 (destructive `nx build`) and BL-456 (`nx test` rebuilding upstream `dist/`) do not apply —
  do not run `nx build`/`nx test` for any project as part of this work; there is nothing to build.
- **Do not let the corrected `tools/test-adr0011-bl-id-counter.mjs` arm 6 edit bleed into arms
  1-5.** Diff the file after editing and confirm only arm 6's body/comment changed — arms 1-3 (seed
  idempotency, sequential reservation, race safety) and arms 4-5 (watermark/issued-id rejection,
  unaffected by this dispatch) must be byte-identical to their current form.

---

## 6. The gate — exactly what the implementer runs, in order

1. `node tools/check-bl-id-integrity.mjs --help` — confirm unaffected (BL-446 non-regression;
   this file's `--help` path is untouched by this spec).
2. `node tools/allocate-bl-id.mjs --help` — must print the (updated) usage banner, exit 0.
3. `node tools/allocate-bl-id.mjs` and `node tools/allocate-bl-id.mjs --dry-run`, both run from a
   scratch temp dir (not this repo) — must exit 1, print the retirement message, touch no files.
4. `node tools/test-adr0011-bl-id-counter.mjs` — must exit 0 overall; visually confirm arm 6's
   printed line now describes an edit, not a new heading, and arms 1-5's output is unchanged from
   the pre-edit run (capture both runs, diff the arm-1-5 lines).
5. `node tools/test-adr0011-stage2-write-off.mjs` — the new file, all ten arms `ok`, exit 0. Before
   this is green, watch each RED-arm assertion (AC-G1a, AC-G1b, AC-allocate-write, AC-allocate-
   dryrun, AC-G3, AC-G2, AC-G4) actually fail against the pre-fix scripts, per BL-225 — do this by
   running the new test file against a `git stash`-free checkpoint: commit the test file FIRST
   (against the current, unpatched `check-bl-id-integrity.mjs`/`allocate-bl-id.mjs`), observe the
   failures, THEN apply the rule changes and re-run to see green. (Never use `git stash` per house
   rules — a checkpoint commit on the feature branch is the substitute, and is itself fine to
   amend/rework before the final PR since it's on a private branch nobody else is building on yet.)
6. `node tools/check-backlog-markers.mjs` — read-only smoke against the real repo, must still print
   `OK` (this file is untouched, but confirm no accidental interaction from the worktree's own
   `BACKLOG.md` state).
7. `node tools/check-bl-id-integrity.mjs` from the worktree root with nothing staged — must print
   the "skipped" line, exit 0 (see §5, second bullet).
8. `npx nx affected --target=lint --base=HEAD~1 --head=HEAD` — matches `.husky/pre-commit:39`
   exactly; likely reports no affected projects (`tools/` and `CONTRIBUTING.md` are outside the nx
   project graph — confirmed no `tools/project.json` exists), but run it anyway so the pre-commit
   hook's own gate is rehearsed before a real commit hits it.
9. No `nx build`/`nx test` target applies — do not invent one. No `check-suite-tree-state.mjs`
   report is needed (BL-456 governs `nx test`, not invoked here).
10. Commit by explicit pathspec, incrementally, per house rules — suggested boundary: (a)
    `tools/check-bl-id-integrity.mjs` + `tools/test-adr0011-stage2-write-off.mjs` together (rules
    ship with their tests, never split); (b) `tools/allocate-bl-id.mjs` alone; (c)
    `tools/test-adr0011-bl-id-counter.mjs` (the arm-6 correction) alone, with a commit message
    citing this spec and explaining the behavior-change reason (not just "update test"); (d)
    `CONTRIBUTING.md` alone. Conventional-commit, lowercase subject, scope `scripts` (matches Stage
    1's own commits, `9771d553`/`379e8a33`).

---

## Recommendation for `~/.claude/CLAUDE.md:45` — carried forward unchanged from the ADR, owner-executed only

Already drafted at `docs/decisions/0011-backlog-tool-write-destination.md:411-421`. This spec does
not redraft it and the implementer must not edit that file. Restated here only so this document is
self-contained for the owner:

> `- **Backlog** All deferrals and bugs discovered should be filed at the time of discovery (do not ask the user if you should). If the project has an ADR or equivalent ruling establishing a backlog tool as the write destination (e.g. sox-ecosystem's ADR-0011), file through that tool. Otherwise, store to the project's BACKLOG.md. If you are working from a plan in docs/plan/<plan>, also append the IDs to docs/plan/<plan>/BACKLOG.md unless that plan directory's own convention says otherwise.`
