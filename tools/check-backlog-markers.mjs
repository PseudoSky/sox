#!/usr/bin/env node
/**
 * [BL-224 / BL-225] Structural guard for BACKLOG.md.
 *
 * The "Current status" header is DERIVED from each `### BL-<n>` heading's status marker.
 * That only works if the marker grammar holds. It has broken three times:
 *
 *   - a `[TRIAGE] Open (...)` prefix made BL-163 invisible to the parser (silently dropped
 *     from the open count);
 *   - a second bold span in a heading (`**0.055s**`, `**binary-differing corrupted file**`)
 *     became the "last marker", so BL-176 and BL-245 were misclassified;
 *   - six IDs were reused for different bugs, so an ID was not an addressable dispatch target.
 *
 * Each failure was silent. This script makes them loud. Run it after editing BACKLOG.md.
 *
 * Rules enforced:
 *   1. Every `### BL-<n>` / `### TQ-<n>` heading has EXACTLY ONE `**...**` bold span.
 *   2. That span starts with a recognised status word.
 *   3. No ID appears as a `###` heading twice (duplicates must be demoted to `####`).
 *   4. The header's `**Total open: N.**` equals the count derived from the markers.
 *   5. (BL-454, advisory unless `--fix`) The `Total open` annotation's trailing parenthetical
 *      does not carry exact-duplicate clauses. See the Rule 5 block below for the heuristic.
 *
 * [BL-416] Registry semantics — SHARED, not per-worktree. Per the owner ruling (2026-08-06,
 * verbatim: "Backlog can be shared."), this script always validates the ONE canonical
 * `BACKLOG.md` that lives at the MAIN checkout's path — never the invoking worktree's own
 * copy — regardless of which worktree (or the main checkout itself) this is run from. The root
 * is resolved via `git rev-parse --git-common-dir` + `path.resolve(..., '..')`: every worktree
 * shares one `.git/worktrees/...` gitlink structure whose common dir sits at the main checkout,
 * so this expression always lands on the same absolute path no matter where it's invoked from.
 * This mirrors `allocate-bl-id.mjs`'s resolution (see that file's header for the full rationale
 * and why the losing alternative, `--show-toplevel`, reopens BL-359's id-collision race for the
 * shared allocation lock — the same reasoning applies here for a single consistent target file).
 * A caller in a worktree validating THEIR OWN uncommitted `BACKLOG.md` edits must be aware this
 * always reports on the main checkout's copy — the resolved path is echoed to stderr on every
 * run specifically so this is never assumed silently.
 *
 * Usage:
 *   node tools/check-backlog-markers.mjs               # validate, exit 1 on any Rule 1-4 violation
 *   node tools/check-backlog-markers.mjs --fix          # also rewrite Rule 5 duplicate clauses (see below)
 *   node tools/check-backlog-markers.mjs --help | -h    # print this usage, no git/file I/O at all
 *
 * Exit 0 = clean. Exit 1 = a violation, with the offending IDs printed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const USAGE = `check-backlog-markers — structural guard for the shared BACKLOG.md

Usage:
  node tools/check-backlog-markers.mjs               # validate, exit 1 on any Rule 1-4 violation
  node tools/check-backlog-markers.mjs --fix          # also rewrite Rule 5 duplicate clauses
  node tools/check-backlog-markers.mjs --help | -h    # print this usage, no git/file I/O at all

Always validates the MAIN checkout's BACKLOG.md (git-common-dir based), never
the invoking worktree's own copy — see the BL-416 header comment in this
file for why.`;

// [BL-446] Parse argv BEFORE any git/file I/O — --help must never touch git
// or the filesystem, and an unrecognized flag must never fall through to
// running the full check silently (the pre-fix bug: `--help` ran the check
// instead of printing usage).
const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const FIX = args.includes('--fix');
const recognized = new Set(['--help', '-h', '--fix']);
const unrecognized = args.filter((a) => !recognized.has(a));

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`check-backlog-markers: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// [BL-416] SHARED registry root — see header comment. Reverted from
// `--show-toplevel` (per-worktree) back to `--git-common-dir` + '..'
// (shared across every worktree and the main checkout), per the owner's
// 2026-08-06 ruling.
const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const FILE = path.join(REPO_ROOT, 'BACKLOG.md');
console.error(`[check-backlog-markers] validating -> ${FILE}`);

const STATUS =
  /^(open|reopened|blocked|resolved|fixed|closed|withdrawn|wontfix|obsolete|superseded|migrated|invalid)/i;
const OPEN = /^(open|reopened|blocked)/i;

const lines = readFileSync(FILE, 'utf8').split('\n');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};

const seen = new Map();
let derivedOpen = 0;

lines.forEach((line, i) => {
  const m = line.match(/^###\s*((?:BL|TQ)-\d+)\s*—\s*(.*)$/);
  if (!m) return;
  const [, id, rest] = m;
  const ln = i + 1;

  // Rule 3 — no duplicate ### headings for one ID.
  if (seen.has(id)) {
    fail(`${id}: duplicate '###' heading (lines ${seen.get(id)} and ${ln}). ` +
      `Two different bugs must not share an ID; a restatement must be demoted to '####'.`);
  } else {
    seen.set(id, ln);
  }

  // Rule 1 — exactly one bold span.
  const spans = [...rest.matchAll(/\*\*([^*]+)\*\*/g)].map((x) => x[1]);
  if (spans.length === 0) {
    fail(`${id} (line ${ln}): heading has NO status marker. It is invisible to the header.`);
    return;
  }
  if (spans.length > 1) {
    fail(`${id} (line ${ln}): heading has ${spans.length} bold spans. The parser reads the LAST ` +
      `one ("${spans[spans.length - 1].slice(0, 40)}") as the status. Use exactly one.`);
    return;
  }

  // Rule 2 — marker starts with a status word.
  const marker = spans[0];
  if (!STATUS.test(marker)) {
    fail(`${id} (line ${ln}): marker "${marker.slice(0, 48)}" does not start with a status word. ` +
      `A '[TRIAGE]' prefix silently drops the item from the open count.`);
    return;
  }
  if (OPEN.test(marker)) derivedOpen++;
});

// failures accumulated by Rules 1-3 (the heading-grammar loop above) — tracked separately from
// Rule 4 because --fix mode gates on Rules 1-3 only (a stale Rule 4 count is exactly what --fix
// is allowed to repair in the same write; see Rule 5 below).
const failuresRules123 = failures;

// Rule 4 — header total matches reality.
const rawTextForTotal = readFileSync(FILE, 'utf8');
const totalMatch = rawTextForTotal.match(/\*\*Total open: (\d+)\.\*\*/);
if (!totalMatch) {
  fail('header is missing its `**Total open: N.**` line — it cannot be checked.');
} else if (Number(totalMatch[1]) !== derivedOpen) {
  fail(`header claims ${totalMatch[1]} open; markers derive ${derivedOpen}. Regenerate the header.`);
}

// ── Rule 5 (BL-454) — duplicate-clause detection in the `Total open` annotation ────────────────
//
// Heuristic clause splitter. A clause "starts" at a `BL-<n>[, BL-<n>...] [and BL-<n>] <verb>`
// token, where <verb> is one of the recognised status verbs below. Text that does NOT open with
// a recognised `BL-<n> <verb>` token (e.g. "BL-436 registry checksum drift armed ...", which
// lacks a recognised verb immediately after the id) merges into the PRECEDING clause rather than
// starting a new one. That is safe by construction: it only ever *coarsens* the split (glues two
// genuinely distinct passages into one comparison unit), never drops text, and it cannot cause a
// false dedupe unless the merged blob is itself an exact byte-for-byte repeat elsewhere —
// vanishingly unlikely, and even then still "no unique clause dropped" in letter and effect,
// since the entire merged blob (unique content and all) would need to repeat verbatim.
const CLAUSE_START =
  /(?=\bBL-\d+(?:,\s*BL-\d+)*\s+(?:and\s+BL-\d+\s+)?(?:resolved|filed|verified|removed|RESAMPLED|REOPENED)\b)/;

function normalizeClause(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function dedupeClauses(clauses) {
  const seenNorm = new Set();
  const out = [];
  for (const c of clauses) {
    const n = normalizeClause(c);
    if (seenNorm.has(n)) continue;
    seenNorm.add(n);
    out.push(c);
  }
  return out;
}

/**
 * Locate the `**Total open: N.**` bold span and its trailing parenthetical within the raw text.
 * Returns null if there is no such span, or if the span has no trailing `(...)` on the same
 * physical line (nothing to check — Rule 5 is skipped entirely per spec).
 */
function findAnnotation(text) {
  const boldMatch = text.match(/\*\*Total open: \d+\.\*\*/);
  if (!boldMatch) return null;
  const boldEnd = boldMatch.index + boldMatch[0].length;
  const lineEnd = text.indexOf('\n', boldEnd);
  const searchEnd = lineEnd === -1 ? text.length : lineEnd;
  const parenStart = text.indexOf('(', boldEnd);
  if (parenStart === -1 || parenStart >= searchEnd) return null;
  const parenEnd = text.lastIndexOf(')', searchEnd);
  if (parenEnd === -1 || parenEnd < parenStart) return null;
  const body = text.slice(parenStart + 1, parenEnd);
  const clauses = body.split(CLAUSE_START).map((c) => c.trim()).filter(Boolean);
  return { boldMatch, boldEnd, parenStart, parenEnd, body, clauses };
}

const annotation = findAnnotation(rawTextForTotal);
let rule5DupCount = 0;
if (annotation) {
  const deduped = dedupeClauses(annotation.clauses);
  rule5DupCount = annotation.clauses.length - deduped.length;

  if (!FIX) {
    // Advisory only — never increments `failures`, never changes the exit code (D6 / Risk R1:
    // the live BACKLOG.md already carries duplicate clauses; a hard fail here would break every
    // worktree's pre-commit hook the instant this ships).
    if (rule5DupCount > 0) {
      console.warn(
        `  WARN  Total open annotation carries ${rule5DupCount} duplicate clause(s) of ` +
          `${annotation.clauses.length}; run 'node tools/check-backlog-markers.mjs --fix' to regenerate.`,
      );
    }
  } else {
    // --fix mode: Rules 1-3 must be clean before touching the file — a broken heading grammar
    // must not be papered over by a clause rewrite that trusts a `derivedOpen` count computed
    // from that same broken input.
    if (failuresRules123 > 0) {
      console.error(
        `\ncheck-backlog-markers --fix: refusing to write — ${failuresRules123} Rule 1-3 ` +
          `violation(s) above must be fixed first.`,
      );
      process.exit(1);
    }
    if (rule5DupCount === 0) {
      console.log('check-backlog-markers --fix: no duplicate clauses found, nothing to fix.');
    } else {
      const newLine = `**Total open: ${derivedOpen}.** (${deduped.join(' ')})`;
      const oldSpanStart = annotation.boldMatch.index;
      const oldSpanEnd = annotation.parenEnd + 1;
      const before = rawTextForTotal;
      const after = before.slice(0, oldSpanStart) + newLine + before.slice(oldSpanEnd);
      writeFileSync(FILE, after);
      console.log(
        `check-backlog-markers --fix: rewrote Total open annotation — ` +
          `${annotation.clauses.length} -> ${deduped.length} clauses, ` +
          `${before.length} -> ${after.length} bytes.`,
      );
    }
    process.exit(0);
  }
} else if (FIX) {
  if (failuresRules123 > 0) {
    console.error(
      `\ncheck-backlog-markers --fix: refusing to write — ${failuresRules123} Rule 1-3 ` +
        `violation(s) above must be fixed first.`,
    );
    process.exit(1);
  }
  console.log('check-backlog-markers --fix: no Total open annotation parenthetical found, nothing to fix.');
  process.exit(0);
}

if (failures > 0) {
  console.error(`\ncheck-backlog-markers: ${failures} violation(s).`);
  process.exit(1);
}
console.log(`check-backlog-markers: OK — ${seen.size} items, ${derivedOpen} open, grammar intact.`);
