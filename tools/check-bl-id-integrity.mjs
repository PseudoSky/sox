#!/usr/bin/env node
/**
 * check-bl-id-integrity — [BL-359] pre-commit guard against BL-id collisions.
 *
 * Two distinct failure modes have hit this repo repeatedly in one day
 * (2026-07-31 → 2026-08-01): BL-344 (twice), BL-354 (four times, three
 * renumbers), BL-395 (collided with an already-resolved CHANGELOG.md
 * entry, renumbered to BL-396), BL-403 (filed as a new id for a defect
 * already covered by BL-388, retracted). This script catches the
 * mechanical half of that (id collisions); it cannot judge semantic
 * duplication (BL-403's kind of mistake) — see the advisory check at the
 * bottom for the closest cheap approximation of that, which is warn-only
 * by design.
 *
 * Checks (all exit 1 on violation):
 *
 *   1. No duplicate `### BL-<n>` heading in BACKLOG.md.
 *      Delegates to check-backlog-markers.mjs, which already enforces this
 *      (Rule 3) as part of its broader heading-grammar check — reusing it
 *      rather than re-parsing the same headings a second time.
 *
 *   2. No BL-<n> id is claimed in BOTH BACKLOG.md (as a `### BL-<n>`
 *      heading) AND CHANGELOG.md (as a `## ... — BL-<n>` release header or
 *      a `**BL-<n> — ...**` per-item paragraph). This is the exact shape
 *      of the BL-395 collision: an id that already has a resolved
 *      CHANGELOG.md record was reused for something new because the
 *      allocator that produced it never looked at CHANGELOG.md.
 *
 *   3. No abandoned `tools/allocate-bl-id.mjs` reservation ships. A
 *      reservation appends a `RESERVED (RESERVED)` placeholder heading
 *      that the caller is supposed to replace with the real item; if one
 *      is still present, the commit is rejected rather than shipping a
 *      dangling placeholder.
 *
 *   4. [ADR-0011 R3 / §4 Stage 1 item 3] Watermark guard. Any newly-staged `### BL-<n>` heading
 *      whose `n` is ABOVE `tools/bl-id-counter.mjs`'s seeded watermark is rejected. Per ADR-0011,
 *      new `BL-*` items are filed through `backlog_create_item` (with an `idOverride` from
 *      `bl-id-counter.mjs`) from the watermark forward — a hand-added heading above the watermark
 *      is exactly the "please use the tool" convention this check makes mechanically enforced
 *      rather than advisory (the dangerous window named in ADR-0011 §3 R3).
 *
 *   5. [ADR-0011 §4 Stage 1 item 4] Issued-id collision guard. Any staged `### BL-<n>` heading
 *      whose `n` is already present in `bl-id-counter.mjs`'s `issued` list is rejected — a human
 *      hand-filing an id the tool already issued (still legal syntactically for ids at/below the
 *      watermark, since those are the pre-ADR-0011 markdown-native range) would otherwise collide
 *      silently with a tool-issued item the original check 2 (markdown-vs-CHANGELOG) never sees,
 *      because the tool-filed item lives only in the graph, not in CHANGELOG.md.
 *
 * Advisory (never fails the commit):
 *
 *   6. Files-overlap warning. `Agent(pkt-17)` was asked to consider a
 *      guard for duplicate-CONTENT filing (BL-403's failure mode: a
 *      genuinely new id for an already-filed defect, found by searching
 *      error strings and missing the existing item because it lived under
 *      a different symptom description). A guard cannot judge semantic
 *      duplication, but it can cheaply flag when a *newly added* item's
 *      `**Files:**` line is an exact match for an existing open item's
 *      `**Files:**` line — that is a strong (if narrow) signal, and false
 *      positives are legitimate ("same file, unrelated bug") often enough
 *      that this stays advisory-only. It only inspects items added in
 *      this commit (via `git diff --cached`), so it costs nothing on
 *      unrelated commits.
 *
 * [ADR-0011 Stage 2, see SPEC-ADR-0011-S2.md] Checks 7-10 close the three holes Stage 1 left open
 * (Hole 1: checks 4/5 above are inert without `.bl-id-counter.json`; Hole 2: `allocate-bl-id.mjs`
 * used to write straight into the shared file, retired separately; Hole 3: only new,
 * above-watermark headings were guarded — edits, deletions, and CHANGELOG.md additions were not).
 * All four read `git diff --cached -U0` against the INVOKING worktree's own `HEAD` (never the
 * counter file, never REPO_ROOT's live on-disk content as a diff baseline) — see D4 in the spec.
 *
 *   7. [HARD FAIL] Rule G1 — any `### BL-<n>` heading that is a pure addition in BACKLOG.md (no
 *      matching removal for the same id) is rejected, unconditionally — with or without
 *      `.bl-id-counter.json`. This is the load-bearing fix for Hole 1 and also closes Hole 3's
 *      below-watermark loophole as a deliberate side effect (D1).
 *
 *   8. [HARD FAIL] Rule G2 — a newly-added `CHANGELOG.md` release header claiming a `BL-<n>` id
 *      that was never seen anywhere (not in this commit's own `HEAD` BACKLOG.md/CHANGELOG.md, not
 *      in REPO_ROOT's current on-disk BACKLOG.md/CHANGELOG.md) is rejected — the id was invented
 *      out of thin air rather than closing out a real item (D5).
 *
 *   9. [WARN] Rule G3 — an existing `### BL-<n>` heading whose TITLE segment changed between the
 *      `-` and `+` lines of the same commit is flagged (not blocked — D3/D6). Body edits (the
 *      normal shape of close-out work: citations, root-cause notes) are never compared.
 *
 *  10. [WARN] Rule G4 — an existing `### BL-<n>` heading that is deleted (no matching `+` for the
 *      same id) without a same-commit or already-on-disk `CHANGELOG.md` record for that id is
 *      flagged (not blocked — D3/D7). The common legitimate case (resolve-and-archive, both edits
 *      in the same commit) is recognized and does not warn.
 *
 * Scope: only runs when BACKLOG.md and/or CHANGELOG.md is staged for the
 * current commit (checked via `git diff --cached --name-only`). Otherwise
 * exits 0 immediately. This repo routinely has BACKLOG.md in a transient
 * inconsistent state mid-edit (several agents touch it concurrently); an
 * unconditional gate would block unrelated commits on pre-existing noise
 * it did not introduce.
 *
 * [BL-416] Two roots, deliberately not one. Per the owner ruling (2026-08-06, verbatim: "Backlog
 * can be shared."), `BACKLOG.md`/`CHANGELOG.md` are read from the ONE canonical location at the
 * MAIN checkout's path (`REPO_ROOT`, resolved via `--git-common-dir` + '..' — see
 * `allocate-bl-id.mjs`'s header for the full rationale), never the invoking worktree's own copy.
 * But the two `git diff --cached` calls below (the staged-files scope check and the advisory
 * Files-overlap diff) answer a DIFFERENT question — "what is being committed right now, in the
 * repository this hook is actually running against" — which is a property of the INVOKING
 * process's own working directory and index, never the main checkout's. Those two calls use
 * `INVOKING_ROOT` (`--show-toplevel`) as their `cwd`, deliberately staying worktree-local even
 * though the content reads above them moved to the shared root. Redirecting them to `REPO_ROOT`
 * would make the scope-check gate answer based on whatever the MAIN checkout's index happens to
 * hold at that instant — which any other concurrently active agent can change out from under a
 * worktree's own commit, producing a false positive that blocks or misattributes on totally
 * unrelated work. Both roots are echoed to stderr on every run (even the early "skipped" exit) so
 * a caller is never left assuming a single root answers both questions.
 *
 * Usage: node tools/check-bl-id-integrity.mjs
 * Exit 0 = clean (warnings may still print). Exit 1 = a blocking violation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const USAGE = `check-bl-id-integrity — pre-commit guard against BL-id collisions

Usage:
  node tools/check-bl-id-integrity.mjs               # run the guard (this is what the pre-commit hook calls)
  node tools/check-bl-id-integrity.mjs --help | -h    # print this usage, no git/file I/O at all

Reads the shared BACKLOG.md/CHANGELOG.md at the main checkout's root (git-common-dir based), but
scopes "what is staged in this commit" to the invoking worktree's own root — see the BL-416
header comment in this file for why these are deliberately two different roots.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git or the filesystem,
// and an unrecognized flag must never fall through to running the full check silently.
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const recognized = new Set(['--help', '-h']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`check-bl-id-integrity: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// [BL-416] Canonical registry root — same shared resolution as allocate-bl-id.mjs /
// check-backlog-markers.mjs. Reverted from `--show-toplevel` back to `--git-common-dir` + '..'
// per the owner's 2026-08-06 ruling.
const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const BACKLOG = path.join(REPO_ROOT, 'BACKLOG.md');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

// The commit actually in progress lives in the INVOKING worktree, not necessarily REPO_ROOT —
// see the BL-416 header comment above for why these two `git diff --cached` calls stay
// worktree-local even though the content reads above use the shared root.
const INVOKING_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

console.error(`[check-bl-id-integrity] registry root (BACKLOG/CHANGELOG) -> ${REPO_ROOT}`);
console.error(`[check-bl-id-integrity] invoking worktree root             -> ${INVOKING_ROOT}`);

// Scope: only run when BACKLOG.md and/or CHANGELOG.md are actually part of THIS commit.
// This is a live-tested requirement, not a hypothetical: this session has several agents
// editing BACKLOG.md concurrently, and it is routinely caught mid-transition (e.g. an item
// resolved and its CHANGELOG.md entry written, but its `### BL-<n>` heading not yet deleted
// from BACKLOG.md — that transient state trips rule 2 below). A blanket, unconditional gate
// would block every commit repo-wide — including ones that touch neither file — on pre-existing
// background inconsistency it did not introduce. Verified live 2026-08-01: BL-397 was caught in
// exactly this transient state while this script was being tested.
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  cwd: INVOKING_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
if (!staged.includes('BACKLOG.md') && !staged.includes('CHANGELOG.md')) {
  console.log('check-bl-id-integrity: skipped — neither BACKLOG.md nor CHANGELOG.md is staged.');
  process.exit(0);
}

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};
const warn = (m) => console.warn(`  WARN  ${m}`);

// ── 1. delegate duplicate-heading detection to check-backlog-markers.mjs ────
try {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools/check-backlog-markers.mjs')], {
    stdio: 'inherit',
  });
} catch {
  fail('check-backlog-markers.mjs reported a violation (see above) — BL-359 rule 1.');
}

// ── 2. cross-file id collision: BACKLOG heading id also claimed in CHANGELOG ─
const backlogText = readFileSync(BACKLOG, 'utf8');
const changelogText = readFileSync(CHANGELOG, 'utf8');

const backlogHeadingIds = new Set(
  [...backlogText.matchAll(/^###\s*BL-(\d+)\s*—/gm)].map((m) => m[1]),
);

// Only the CHANGELOG's primary release header claims an id — exactly `## [...] — BL-n[, BL-n...]:`.
// Deliberately excludes:
//   - `#### BL-n` restatement headings (the established "demoted, not a separate item" convention
//     that check-backlog-markers.mjs already recognises for BACKLOG.md; CHANGELOG.md uses the same
//     idea for cross-reference notes like "#### BL-202 — RECLASSIFY note").
//   - `**BL-n — ...**` internal per-paragraph markers, which elaborate on a header's already-declared
//     id(s) and are not themselves a claim — a substring match on those produced false positives on
//     BL-202/BL-258 (ids mentioned only in another item's prose, never actually resolved themselves).
//   - `(partial)` headers — BL-388 has one: CHANGELOG explicitly documents partial progress while the
//     item is deliberately left open in BACKLOG.md. That is intentional dual-presence, not a collision.
const changelogClaimedIds = new Set();
for (const m of changelogText.matchAll(/^## \[[^\]]*\] — ((?:BL-\d+(?:,\s*)?)+)(?!.*\(partial\))/gm)) {
  for (const idMatch of m[1].matchAll(/BL-(\d+)/g)) changelogClaimedIds.add(idMatch[1]);
}

for (const id of backlogHeadingIds) {
  if (changelogClaimedIds.has(id)) {
    fail(
      `BL-${id}: heading exists in BACKLOG.md but the same id is already claimed in CHANGELOG.md ` +
        `(a resolved record). This is the BL-395 collision shape — the id was reused for a new item ` +
        `while an old resolved record for it already exists. Allocate with tools/allocate-bl-id.mjs, ` +
        `which scans both files, or pick an unused id.`,
    );
  }
}

// ── 3. abandoned allocate-bl-id.mjs reservation ──────────────────────────────
// Match the placeholder HEADING, not the string anywhere in the file. The previous test was a
// bare `/RESERVED \(RESERVED\)/` over the whole document, so any item that *quoted* the marker in
// its prose tripped the guard — which is exactly what happened to BL-416's write-up, an item
// ABOUT the reservation tooling that necessarily names the placeholder format it describes. A
// guard that blocks its own bug report gets bypassed with --no-verify, and then it protects
// nothing. Anchor on `^### BL-<n> ... RESERVED (RESERVED)` so only a real heading fails.
const abandonedReservation = backlogText.match(/^###\s*(BL-\d+)[^\n]*RESERVED \(RESERVED\)/m);
if (abandonedReservation) {
  fail(
    `${abandonedReservation[1]}: an allocate-bl-id.mjs placeholder is still in BACKLOG.md. ` +
      `Fill in the real item or delete the heading before committing.`,
  );
}

// ── 4 & 5. ADR-0011 R3/R5: watermark guard + issued-id collision, sourced from bl-id-counter.mjs ─
//
// Both guards read `.bl-id-counter.json` (same shared REPO_ROOT as BACKLOG.md/CHANGELOG.md — see
// the BL-416 header comment above). If the counter file does not exist yet (pre-Stage-0, or a repo
// that has not adopted ADR-0011), both guards are silently skipped — this script must stay usable
// before Stage 0 seeds the counter, and the counter's absence is not itself a violation.
const COUNTER_FILE = path.join(REPO_ROOT, '.bl-id-counter.json');
let counterState = null;
if (existsSync(COUNTER_FILE)) {
  try {
    counterState = JSON.parse(readFileSync(COUNTER_FILE, 'utf8'));
  } catch (err) {
    fail(`.bl-id-counter.json exists but failed to parse: ${err.message}`);
  }
}

if (counterState) {
  const watermark = Number(counterState.watermark);
  const issuedIds = new Set((counterState.issued || []).map((e) => e.id.replace(/^BL-/, '')));

  for (const id of backlogHeadingIds) {
    const n = Number(id);

    // Check 4 [ADR-0011 R3] — a `### BL-<n>` heading above the seeded watermark is hand-filing a
    // NEW item outside the tool, which ADR-0011 §4 Stage 1 forbids from the watermark forward.
    if (n > watermark) {
      fail(
        `BL-${id}: heading id (${n}) is above the ADR-0011 Stage-1 watermark (${watermark}). New ` +
          `BL-* items are filed through the tool (backlog_create_item with an idOverride from ` +
          `tools/bl-id-counter.mjs), not by hand-editing BACKLOG.md. See docs/decisions/` +
          `0011-backlog-tool-write-destination.md §4 Stage 1, and run ` +
          `'node tools/bl-id-counter.mjs' to reserve the next id through the tool instead.`,
      );
    }

    // Check 5 [ADR-0011 §4 Stage 1 item 4] — a `### BL-<n>` heading whose id the counter has
    // already issued to a tool-filed item collides with that item. This can happen even for ids
    // AT OR BELOW the watermark (the counter issues ids strictly above the watermark, so in
    // practice this only fires for ids the counter itself minted, i.e. > watermark — but the
    // check is written id-set-based, not range-based, so it stays correct even if the watermark
    // is later raised by --reseed after ids were already issued in the prior range).
    if (issuedIds.has(id)) {
      fail(
        `BL-${id}: heading exists in BACKLOG.md but this id was already issued by ` +
          `tools/bl-id-counter.mjs to a tool-filed item (ADR-0011). A human hand-filed this id in ` +
          `markdown while the tool had already claimed it — this is the exact split-brain ` +
          `collision the ADR-0011 migration exists to end. Pick an unused id below the watermark, ` +
          `or (if this heading IS the tool-filed item being restated in markdown) do not add a ` +
          `duplicate '###' heading for it — the tool is now its source of truth.`,
      );
    }
  }
}

// ── 6. advisory: newly-added item's Files: line exactly matches an existing one ─
try {
  const diff = execFileSync('git', ['diff', '--cached', '-U0', '--', 'BACKLOG.md'], {
    cwd: INVOKING_ROOT,
    encoding: 'utf8',
  });
  const addedIds = [...diff.matchAll(/^\+###\s*(BL-\d+)\s*—/gm)].map((m) => m[1]);
  if (addedIds.length > 0) {
    const filesLineByHeading = new Map();
    const blocks = backlogText.split(/(?=^###\s*BL-\d+\s*—)/m);
    for (const b of blocks) {
      const idMatch = b.match(/^###\s*(BL-\d+)\s*—/);
      const filesMatch = b.match(/^\*\*Files:\*\*\s*([^\n]+)$/m);
      if (idMatch && filesMatch) filesLineByHeading.set(idMatch[1], filesMatch[1].trim());
    }
    for (const newId of addedIds) {
      const newFiles = filesLineByHeading.get(newId);
      if (!newFiles) continue;
      for (const [existingId, existingFiles] of filesLineByHeading) {
        if (existingId === newId) continue;
        if (existingFiles === newFiles) {
          warn(
            `${newId}: **Files:** line is an exact match for ${existingId}'s. If these are the same ` +
              `defect, merge into ${existingId} instead of filing a new id (dedupe-before-file rule).`,
          );
        }
      }
    }
  }
} catch (err) {
  // advisory only — never let a diff failure (e.g. no staged changes, detached checkout) block the commit.
  warn(`Files-overlap advisory check skipped: ${err.message}`);
}

// ── 7-10. [ADR-0011 Stage 2] G1 (new heading, FAIL) / G2 (new CHANGELOG id, FAIL) /
//         G3 (title changed, WARN) / G4 (heading deleted w/o CHANGELOG record, WARN) ──────────
//
// All four read from the INVOKING worktree's own `HEAD` via `git diff --cached -U0`, never from
// REPO_ROOT's live on-disk content as a diff baseline (D4) — the committing worktree's own git
// history is the only semantically correct basis for "did THIS commit introduce a new heading."
function diffLines(file) {
  try {
    return execFileSync('git', ['diff', '--cached', '-U0', '--', file], {
      cwd: INVOKING_ROOT,
      encoding: 'utf8',
    });
  } catch {
    return ''; // no staged changes to this path, or detached checkout — same tolerance as check 6.
  }
}

function headIdsFromInvokingRootHead(file, kind) {
  let text = '';
  try {
    text = execFileSync('git', ['show', `HEAD:${file}`], { cwd: INVOKING_ROOT, encoding: 'utf8' });
  } catch {
    return new Set(); // path doesn't exist at HEAD yet (e.g. first commit adds the file).
  }
  if (kind === 'backlog') {
    return new Set([...text.matchAll(/^###\s*BL-(\d+)\s*—/gm)].map((m) => m[1]));
  }
  const ids = new Set();
  for (const m of text.matchAll(/^## \[[^\]]*\] — ((?:BL-\d+(?:,\s*)?)+)(?!.*\(partial\))/gm)) {
    for (const idMatch of m[1].matchAll(/BL-(\d+)/g)) ids.add(idMatch[1]);
  }
  return ids;
}

const backlogDiff = diffLines('BACKLOG.md');
const changelogDiff = diffLines('CHANGELOG.md');

// Collect per-id added/removed full heading lines from the BACKLOG.md diff, shared by G1/G3/G4.
const addedHeadings = new Map(); // id -> full '+' heading line
for (const m of backlogDiff.matchAll(/^\+(###\s*BL-(\d+)\s*—.*)$/gm)) {
  addedHeadings.set(m[2], m[1]);
}
const removedHeadings = new Map(); // id -> full '-' heading line
for (const m of backlogDiff.matchAll(/^-(###\s*BL-(\d+)\s*—.*)$/gm)) {
  removedHeadings.set(m[2], m[1]);
}

// Newly-added CHANGELOG.md release headers, shared by G2/G4.
const addedChangelogIds = new Set();
for (const m of changelogDiff.matchAll(
  /^\+## \[[^\]]*\] — ((?:BL-\d+(?:,\s*)?)+)(?!.*\(partial\))/gm,
)) {
  for (const idMatch of m[1].matchAll(/BL-(\d+)/g)) addedChangelogIds.add(idMatch[1]);
}

// ── 7. Rule G1 [HARD FAIL] — brand-new BACKLOG.md heading, unconditional (D1) ────────────────
for (const [id, line] of addedHeadings) {
  if (!removedHeadings.has(id)) {
    fail(
      `BL-${id}: brand-new heading in BACKLOG.md ('${line.trim()}'). Post-ADR-0011 Stage 2, there ` +
        `is no legitimate way to hand-add a new '### BL-<n>' heading, at any id, with or without ` +
        `.bl-id-counter.json present. File it through the tool: 'node tools/bl-id-counter.mjs' to ` +
        `reserve the id, then backlog_create_item with an idOverride — see CONTRIBUTING.md §1.9.`,
    );
  }
}

// ── 8. Rule G2 [HARD FAIL] — new CHANGELOG.md id never seen anywhere (D5) ────────────────────
//
// D5 unions four sources: (a)/(b) INVOKING_ROOT's own HEAD (immune to staging by construction —
// `git show HEAD:file` never reflects the index), and (c)/(d) REPO_ROOT's CURRENT on-disk
// backlogHeadingIds/changelogClaimedIds (already computed by checks 1-5 above, reused per D5's
// "costs nothing extra" rationale). (c)/(d) are only a genuinely INDEPENDENT signal — as D5
// intends, to catch a resolve-and-archive whose BACKLOG.md heading this worktree never itself
// saw fresh — when REPO_ROOT is a DIFFERENT file from what THIS commit is staging. When
// REPO_ROOT === INVOKING_ROOT (the common single-checkout case: no worktree in play, most
// ordinary commits), `readFileSync(BACKLOG/CHANGELOG)` at the top of this script reads the exact
// same working-tree file this commit just staged — so (c)/(d) would trivially "recognize" an id
// as known for no reason other than this commit having just written it, defeating G2 entirely
// for the case it exists to guard (verified live: AC-G2 is undetectable without this guard).
// (a)/(b) already fully cover "known before this commit" for that case, so excluding (c)/(d)
// there loses no legitimate signal — it only removes a self-referential false-negative.
const repoRootIsInvokingRoot = path.resolve(REPO_ROOT) === path.resolve(INVOKING_ROOT);
const knownIds = new Set([
  ...headIdsFromInvokingRootHead('CHANGELOG.md', 'changelog'),
  ...headIdsFromInvokingRootHead('BACKLOG.md', 'backlog'),
  ...(repoRootIsInvokingRoot ? [] : backlogHeadingIds),
  ...(repoRootIsInvokingRoot ? [] : changelogClaimedIds),
]);
for (const id of addedChangelogIds) {
  if (!knownIds.has(id)) {
    fail(
      `BL-${id}: new CHANGELOG.md release header claims this id, but it was never seen anywhere — ` +
        `not this commit's own prior BACKLOG.md/CHANGELOG.md, not the shared registry's current ` +
        `BACKLOG.md/CHANGELOG.md. A CHANGELOG.md entry may only close out an id that already existed ` +
        `somewhere; it may not invent a new one. File new items through the tool — see ` +
        `CONTRIBUTING.md §1.9.`,
    );
  }
}

// ── 9. Rule G3 [WARN] — existing heading's TITLE segment changed (D6, body not compared) ─────
const TITLE_RE = /^###\s*BL-\d+\s*—\s*(.*?)\s*—\s*\*\*/;
for (const [id, addedLine] of addedHeadings) {
  const removedLine = removedHeadings.get(id);
  if (removedLine === undefined) continue; // pure addition — G1's concern, not G3's.
  const addedTitle = addedLine.match(TITLE_RE)?.[1];
  const removedTitle = removedLine.match(TITLE_RE)?.[1];
  if (addedTitle !== undefined && removedTitle !== undefined && addedTitle !== removedTitle) {
    warn(
      `BL-${id}: heading title/content changed ('${removedTitle}' -> '${addedTitle}'). If this is a ` +
        `genuine content swap (a different defect reusing this id) rather than a title clarification, ` +
        `file the new defect as its own item instead of overwriting this one.`,
    );
  }
}

// ── 10. Rule G4 [WARN] — heading deleted with no CHANGELOG record anywhere (D7) ──────────────
for (const [id] of removedHeadings) {
  if (addedHeadings.has(id)) continue; // edited in place, not deleted — G3's concern, not G4's.
  if (addedChangelogIds.has(id) || changelogClaimedIds.has(id)) continue; // resolve-and-archive.
  warn(
    `BL-${id}: heading deletion — removed from BACKLOG.md but no CHANGELOG.md archival record for ` +
      `this id exists in this commit's diff or the shared registry's current CHANGELOG.md. If this ` +
      `was resolved, add its CHANGELOG.md archival entry in the same commit as the deletion; if it ` +
      `was discarded silently, reconsider.`,
  );
}

if (failures > 0) {
  console.error(`\ncheck-bl-id-integrity: ${failures} violation(s). BL-359.`);
  process.exit(1);
}
console.log('check-bl-id-integrity: OK — no duplicate or cross-file BL-id collisions.');
