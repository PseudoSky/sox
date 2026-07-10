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
 *
 * Exit 0 = clean. Exit 1 = a violation, with the offending IDs printed.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const FILE = path.join(REPO_ROOT, 'BACKLOG.md');

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

// Rule 4 — header total matches reality.
const totalMatch = readFileSync(FILE, 'utf8').match(/\*\*Total open: (\d+)\.\*\*/);
if (!totalMatch) {
  fail('header is missing its `**Total open: N.**` line — it cannot be checked.');
} else if (Number(totalMatch[1]) !== derivedOpen) {
  fail(`header claims ${totalMatch[1]} open; markers derive ${derivedOpen}. Regenerate the header.`);
}

if (failures > 0) {
  console.error(`\ncheck-backlog-markers: ${failures} violation(s).`);
  process.exit(1);
}
console.log(`check-backlog-markers: OK — ${seen.size} items, ${derivedOpen} open, grammar intact.`);
