#!/usr/bin/env node
/**
 * allocate-bl-id — [BL-359] server-free reservation for the next BL-<n>.
 *
 * The prior practice was: read the current maximum `### BL-<n>` heading in
 * BACKLOG.md and add one. That has two independent failure modes, both hit
 * on 2026-07-31/2026-08-01:
 *
 *   1. RACE — two agents both read the max before either writes. Both pick
 *      the same id. Filed on the same day: BL-344 (twice), BL-354 (four
 *      times, three renumbers — "there is no BL-354 any longer").
 *   2. BLIND SPOT — an id already lives in CHANGELOG.md (the item was
 *      resolved and moved) but the allocator only ever looked at
 *      BACKLOG.md, so its "max" undercounts. BL-395 was filed this way: it
 *      already existed as a resolved CHANGELOG.md entry, so the new filing
 *      collided and had to be renumbered to BL-396.
 *
 * This script fixes both:
 *
 *   - max is computed across BOTH BACKLOG.md and CHANGELOG.md (every
 *     `BL-<n>` token in either file, not just BACKLOG headings — resolved
 *     items are recorded in CHANGELOG.md as `## [Unreleased] — BL-<n>: ...`
 *     headers and `**BL-<n> — ...**` per-item paragraphs, not as `### BL-<n>`
 *     headings, so a heading-only scan would miss them, which is exactly
 *     how BL-395 slipped through).
 *   - the id is RESERVED, not just computed: it takes an exclusive
 *     directory-based lock (mkdir is atomic on every POSIX filesystem),
 *     re-reads both files under the lock, computes the next id, and
 *     appends a placeholder `### BL-<n>` heading to BACKLOG.md in the same
 *     write — before releasing the lock. A second caller that raced in
 *     sees the placeholder heading as part of its own max-scan and gets
 *     the next id after it. There is no window where two callers can both
 *     compute the same "next" id.
 *
 * Usage:
 *   node tools/allocate-bl-id.mjs                 # reserve + print the new id
 *   node tools/allocate-bl-id.mjs --dry-run        # compute only, no write, no lock held past the read
 *
 * Output (stdout, single line): BL-<n>
 * A placeholder heading is appended to BACKLOG.md:
 *
 *   ### BL-<n> — RESERVED — placeholder from allocate-bl-id.mjs, replace before committing — **Open (RESERVED)** (<date>)
 *
 *   **Driver.** Reserved by allocate-bl-id.mjs and not yet filled in. If you are
 *   reading this in a committed BACKLOG.md, the reservation was never completed —
 *   fill in the item or delete this heading.
 *
 *   ---
 *
 * The caller MUST replace that placeholder body with the real item before
 * committing. check-bl-id-integrity.mjs (the pre-commit guard) rejects any
 * commit that still contains a `RESERVED (RESERVED)` marker, so an
 * abandoned reservation cannot ship silently — it either gets filled in or
 * must be deleted.
 */

import { readFileSync, appendFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const BACKLOG = path.join(REPO_ROOT, 'BACKLOG.md');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');
const LOCK_DIR = path.join(REPO_ROOT, '.bl-id.lock');

const DRY_RUN = process.argv.includes('--dry-run');

function maxBlId() {
  let max = 0;
  for (const file of [BACKLOG, CHANGELOG]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bBL-(\d+)\b/g)) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

function acquireLock({ timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `allocate-bl-id: could not acquire lock at ${LOCK_DIR} within ${timeoutMs}ms — ` +
            `another allocation is in progress (or a prior run crashed and left the lock behind; ` +
            `if you are certain nothing else is allocating, remove it with rmdir).`,
        );
      }
      // busy-wait with a short sleep; mkdir-based locks have no wait primitive.
      execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${pollMs})`]);
    }
  }
}

function releaseLock() {
  if (existsSync(LOCK_DIR)) rmdirSync(LOCK_DIR);
}

function main() {
  if (DRY_RUN) {
    const next = maxBlId() + 1;
    console.log(`BL-${next}`);
    return;
  }

  acquireLock();
  try {
    const next = maxBlId() + 1;
    const id = `BL-${next}`;
    const date = new Date().toISOString().slice(0, 10);
    const placeholder =
      `\n### ${id} — RESERVED — placeholder from allocate-bl-id.mjs, replace before committing — ` +
      `**Open (RESERVED)** (${date})\n\n` +
      `**Driver.** Reserved by \`tools/allocate-bl-id.mjs\` and not yet filled in. If you are ` +
      `reading this in a committed BACKLOG.md, the reservation was never completed — fill in the ` +
      `item's real content or delete this heading before committing.\n\n---\n`;
    appendFileSync(BACKLOG, placeholder);
    console.log(id);
  } finally {
    releaseLock();
  }
}

main();
