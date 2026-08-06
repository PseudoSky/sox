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
 * [BL-416] Registry semantics — SHARED, not per-worktree. Per the owner
 * ruling (2026-08-06, verbatim: "Backlog can be shared."), this script
 * always reserves against the ONE canonical `BACKLOG.md`/`CHANGELOG.md`
 * that live at the MAIN checkout's path — never the invoking worktree's own
 * copy — regardless of which worktree (or the main checkout itself) this is
 * run from. The root is resolved via `git rev-parse --git-common-dir` +
 * `path.resolve(..., '..')`: every worktree shares one `.git/worktrees/...`
 * gitlink structure whose common dir sits at the main checkout, so this
 * expression always lands on the same absolute path no matter where it's
 * invoked from. This also means the id-allocation LOCK (`LOCK_DIR`, derived
 * from the same root) is genuinely shared across every worktree, which is
 * load-bearing: two worktrees allocating concurrently must serialize on the
 * *same* lock directory, or they can independently compute the same "next"
 * id (this is BL-359's race, reopened by a prior revision of this file that
 * used `--show-toplevel` instead — see BL-416).
 *
 * One structural consequence that follows mechanically and is easy to miss:
 * a worktree's own on-disk `BACKLOG.md` is a DIFFERENT FILE from the one
 * this script reads and writes. The reservation placeholder lands in the
 * main checkout's copy, not the invoking worktree's — a caller working in a
 * worktree must separately reconcile their own worktree's `BACKLOG.md` when
 * writing the real item content. The reservation only guarantees the
 * *number* is unique, not that the placeholder lives where the caller will
 * actually commit their work. Every write, and every failure that reaches
 * the point of needing a path, echoes the three resolved paths to stderr
 * (BACKLOG.md / CHANGELOG.md / lock dir) so no caller is left assuming the
 * tool operated on the copy checked out in its own `cwd`.
 *
 * Usage:
 *   node tools/allocate-bl-id.mjs                 # reserve + print the new id
 *   node tools/allocate-bl-id.mjs --dry-run        # compute only, no write, no lock held past the read
 *   node tools/allocate-bl-id.mjs --help | -h      # print this usage, no git/file I/O at all
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

const USAGE = `allocate-bl-id — reserve the next BL-<n> in the shared BACKLOG.md/CHANGELOG.md

Usage:
  node tools/allocate-bl-id.mjs                 # reserve + print the new id
  node tools/allocate-bl-id.mjs --dry-run        # compute only, no write, no lock held past the read
  node tools/allocate-bl-id.mjs --help | -h      # print this usage, no git/file I/O at all

Always targets the MAIN checkout's BACKLOG.md/CHANGELOG.md (git-common-dir
based), never the invoking worktree's own copy — see the BL-416 header
comment in this file for why. Output (stdout, single line, on a real or
--dry-run reservation): BL-<n>.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git
// or the filesystem, and an unrecognized flag must never fall through to
// the mutating write path (the pre-fix bug: any typo'd flag silently
// reserved an id and appended a placeholder).
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const DRY_RUN = args.includes('--dry-run');
const recognized = new Set(['--help', '-h', '--dry-run']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`allocate-bl-id: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// [BL-416] SHARED registry root — see header comment. Reverted from
// `--show-toplevel` (per-worktree, reopens BL-359) back to
// `--git-common-dir` + '..' (shared across every worktree and the main
// checkout), per the owner's 2026-08-06 ruling.
const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const BACKLOG = path.join(REPO_ROOT, 'BACKLOG.md');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');
const LOCK_DIR = path.join(REPO_ROOT, '.bl-id.lock');

function echoResolvedPaths() {
  console.error(`[allocate-bl-id] BACKLOG.md  -> ${BACKLOG}`);
  console.error(`[allocate-bl-id] CHANGELOG.md -> ${CHANGELOG}`);
  console.error(`[allocate-bl-id] lock dir    -> ${LOCK_DIR}`);
}

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
        echoResolvedPaths();
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
    echoResolvedPaths();
    const next = maxBlId() + 1;
    console.log(`BL-${next}`);
    return;
  }

  echoResolvedPaths();
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
