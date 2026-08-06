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
 * Advisory (never fails the commit):
 *
 *   4. Files-overlap warning. `Agent(pkt-17)` was asked to consider a
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

import { readFileSync } from 'node:fs';
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

// ── 4. advisory: newly-added item's Files: line exactly matches an existing one ─
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

if (failures > 0) {
  console.error(`\ncheck-bl-id-integrity: ${failures} violation(s). BL-359.`);
  process.exit(1);
}
console.log('check-bl-id-integrity: OK — no duplicate or cross-file BL-id collisions.');
