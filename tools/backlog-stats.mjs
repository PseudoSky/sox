#!/usr/bin/env node
// backlog-stats.mjs — filing-rate and topic statistics for BACKLOG.md.
//
// WHY THIS EXISTS. Items are filed faster than they are fixed, and nobody could say
// which areas produce them or why. This turns "we keep finding bugs" into a measured
// series, so a spike in one topic is visible as a spike rather than as a vague sense
// that the week was rough.
//
// Reads BACKLOG.md (open items) and git history (all filings, including items that
// have since been resolved and moved to CHANGELOG.md). Writes a report to stdout, or
// to --out <path>.
//
// Usage:
//   node tools/backlog-stats.mjs                        # report to stdout
//   node tools/backlog-stats.mjs --out docs/reporting/memory/FILING-STATS.md
//   node tools/backlog-stats.mjs --since 2026-07-01     # limit the git-history window
//   node tools/backlog-stats.mjs --json                 # machine-readable
//
// NOTE: this writes a DERIVED artifact. Per the lesson it exists to measure, it is
// regenerated, never hand-edited. If you find yourself editing FILING-STATS.md by
// hand, that is the very defect class this file is counting.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (has('--help') || has('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 20).join('\n'));
  process.exit(0);
}
for (const a of argv) {
  if (a.startsWith('-') && !['--out', '--since', '--json', '--help', '-h'].includes(a)) {
    console.error(`backlog-stats: unrecognized argument "${a}"`);
    process.exit(2);
  }
}

// Shared registry root (BL-416): the allocator and checkers resolve the shared
// BACKLOG.md via --git-common-dir + '..', never the per-worktree --show-toplevel.
const REPO_ROOT = resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const BACKLOG = resolve(REPO_ROOT, 'BACKLOG.md');
const SINCE = val('--since', '2026-07-01');

// ---------------------------------------------------------------------------
// Topic classification.
//
// Ordered, first-match-wins, applied to the HEADING TEXT ONLY. Body matching was
// tried first and over-counted badly: "spec.ts" and "test" appear in nearly every
// body, so a body scan classified 41/92 items as test-infra. Narrow, subject-bearing
// patterns first; broad ones last.
// ---------------------------------------------------------------------------
const TOPICS = [
  ['backlog/plan/doc tooling', /BACKLOG|CHANGELOG|PLAN\.md|STATE\.md|allocate-bl-id|check-backlog|plan-status|bl-id|ADR|docs?\b/i],
  ['git / commit / worktree', /\bgit\b|commit|worktree|pathspec|branch|staged|index\b/i],
  ['build / registry / release', /registry|checksum|\bdist\b|publish|changeset|bundle|smoke|nx build|release|export|publint/i],
  ['store / adapter / schema', /adapter|DDL|CHECK|sqlite|turso|schema|migrat|rebuild|\bfts\b|\bwal\b|integrity|backup/i],
  ['embed / enrich / cluster', /embed|enrich|cluster|vector|fastembed|drain|mutex|threshold|calibrat|topic|recall/i],
  ['service lifecycle / proc', /service|supervis|launchd|daemon|shutdown|reaper|proxy|process|spawn|singleton/i],
  ['observability / telemetry', /telemetry|metric|\blog\b|trace|observab|counter|ping/i],
  ['test harness & guard validity', /test|spec|guard|assert|vacuit|skip|flak|red.?green|coverage|harness|runner/i],
];

function classify(title) {
  for (const [name, re] of TOPICS) if (re.test(title)) return name;
  return '(unclassified)';
}

// ---------------------------------------------------------------------------
// The systemic-signature probe.
//
// Hypothesis under test: the dominant recurring root cause is ONE FACT STORED IN TWO
// PLACES WITH NOTHING KEEPING THEM IN SYNC. This is a keyword proxy and it is WEAK
// EVIDENCE ON ITS OWN — prose style alone can trip it. It is reported as a signal to
// investigate, never as a verdict. Read the items before believing the number.
// ---------------------------------------------------------------------------
const DUP_SIGNATURE =
  /derived|regenerat|out of sync|\bin sync\b|drift|stale|split.?brain|source of truth|duplicat|mismatch|two (copies|places|sources|grammars|tables|stores|systems|parsers)|hand-(edit|maintain|written)|never re-?run|silently (diverg|fork)|copy of/i;

function parseBacklog() {
  const lines = readFileSync(BACKLOG, 'utf8').split('\n');
  const items = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^###\s*(BL|TQ)-(\d+)\s*—\s*(.*)$/);
    if (m) {
      const date = (l.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/) || [])[1] || null;
      const marker = [...m[3].matchAll(/\*\*([^*]+)\*\*/g)].pop();
      const status = marker ? marker[1] : '';
      const prio = (status.match(/CRITICAL|HIGH|MEDIUM|LOW/) || ['UNSET'])[0];
      cur = { id: `${m[1]}-${m[2]}`, title: m[3], date, status, prio, body: '' };
      items.push(cur);
    } else if (cur) cur.body += l + '\n';
  }
  return items;
}

// Filings per day, from git — captures items since resolved and removed from BACKLOG.md.
function filingsFromGit() {
  const log = execFileSync(
    'git',
    ['log', `--since=${SINCE}`, '--date=short', '--pretty=format:%H %ad', '--', 'BACKLOG.md'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  if (!log) return {};
  const perDay = {};
  for (const line of log.split('\n')) {
    const [sha, date] = line.split(' ');
    let diff = '';
    try {
      diff = execFileSync('git', ['show', sha, '--', 'BACKLOG.md'], {
        cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
    } catch { continue; }
    const added = (diff.match(/^\+### (?:BL|TQ)-\d+ —/gm) || []).length;
    if (added > 0) perDay[date] = (perDay[date] || 0) + added;
  }
  return perDay;
}

const items = parseBacklog();
const open = items.filter((i) => /^(open|reopened|blocked)/i.test(i.status));

const byTopic = {};
const byTopicDup = {};
for (const i of open) {
  const t = classify(i.title);
  byTopic[t] = (byTopic[t] || 0) + 1;
  if (DUP_SIGNATURE.test(i.title + ' ' + i.body)) byTopicDup[t] = (byTopicDup[t] || 0) + 1;
}
const byPrio = {};
for (const i of open) byPrio[i.prio] = (byPrio[i.prio] || 0) + 1;

const perDay = filingsFromGit();
const days = Object.keys(perDay).sort();
const totalFiled = days.reduce((a, d) => a + perDay[d], 0);
const dupTotal = open.filter((i) => DUP_SIGNATURE.test(i.title + ' ' + i.body)).length;

if (has('--json')) {
  const out = JSON.stringify(
    { generatedFrom: 'tools/backlog-stats.mjs', since: SINCE, openCount: open.length, byTopic, byTopicDup, byPrio, perDay, dupSignatureHits: dupTotal },
    null, 2,
  );
  const dest = val('--out', null);
  if (dest) writeFileSync(resolve(REPO_ROOT, dest), out + '\n');
  else console.log(out);
  process.exit(0);
}

const L = [];
L.push('# Backlog filing statistics');
L.push('');
L.push('<!-- GENERATED by tools/backlog-stats.mjs. Do not hand-edit — regenerate. -->');
L.push('');
L.push(`Open items: **${open.length}** · filings since ${SINCE} (git-derived, includes items since resolved): **${totalFiled}**`);
L.push('');
L.push('## Filings per day');
L.push('');
L.push('Counted as `+### BL-<n> —` headings added per commit touching `BACKLOG.md`, so it includes');
L.push('items that have since been resolved and moved to `CHANGELOG.md`. Spikes are sweep days');
L.push('(a multi-agent audit landing at once), not steady-state discovery.');
L.push('');
L.push('| Date | Filed |');
L.push('|---|---|');
for (const d of days) L.push(`| ${d} | ${perDay[d]} |`);
L.push('');
L.push('## Open items by topic');
L.push('');
L.push('First-match classification on the heading text only. `dup-sig` counts items whose text');
L.push('matches the duplicated-fact signature (one fact in two places, nothing syncing them) —');
L.push('a **weak keyword proxy**, reported to be investigated, not believed on its own.');
L.push('');
L.push('| Topic | Open | dup-sig |');
L.push('|---|---|---|');
for (const [t, c] of Object.entries(byTopic).sort((a, b) => b[1] - a[1])) {
  L.push(`| ${t} | ${c} | ${byTopicDup[t] || 0} |`);
}
L.push('');
L.push('## Open items by priority');
L.push('');
L.push('| Priority | Open |');
L.push('|---|---|');
for (const p of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNSET']) {
  if (byPrio[p]) L.push(`| ${p} | ${byPrio[p]} |`);
}
L.push('');
L.push(`Duplicated-fact signature: **${dupTotal} / ${open.length}** open items (${Math.round((100 * dupTotal) / open.length)}%).`);
L.push('');

const text = L.join('\n');
const dest = val('--out', null);
if (dest) {
  writeFileSync(resolve(REPO_ROOT, dest), text + '\n');
  console.error(`backlog-stats: wrote ${dest}`);
} else console.log(text);
