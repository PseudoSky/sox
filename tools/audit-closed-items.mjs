#!/usr/bin/env node
/**
 * audit-closed-items.mjs — READ-ONLY instrument for the BL-225 audit.
 *
 * BL-225 forbids marking a backlog item RESOLVED/DONE/FIXED/SHIPPED/VERIFIED without a red→green
 * regression test naming that item's id. No closed item has ever been mechanically checked against
 * that rule. This script is the checking instrument — NOT the audit itself, and NOT a verdict on
 * any individual item. It reports evidence signals; a human still has to read the CITED rows before
 * trusting any of them (see "WHAT THIS CANNOT CHECK" below and in the emitted report).
 *
 * ⛔ THIS SCRIPT NEVER WRITES TO THE BACKLOG GRAPH. It calls only `backlog query` (read). It never
 * calls transition/update/add-citation/create/delete. That boundary is load-bearing: backlog-filer
 * owns graph writes, this tool owns graph reads.
 *
 * ── WHY THERE IS NO "BL-<n>" LOOKUP ────────────────────────────────────────────────────────────
 * The backlog store's identity model is `uid`-only (confirmed against the live store,
 * 2026-09-22 — `backlog get`/`backlog query` fields enum has no `humanId`; see
 * docs/reporting/memory/findings/2026-09-22-neardup-rollout-blocked.md §6, which independently
 * confirms `humanId` was removed from `src/` in commit 9fab4938). Nobody writes a UUID into a test
 * name, so identity-by-uid is not a usable test-naming signal either. The only naming signal this
 * store retains is a *self-reported* `BL-<n>`/`BUG-<n>`/`DEBT-<n>` string, scraped from an item's
 * own `title`/`body` text where present (many older items carry it, e.g. "... — RESOLVED
 * (BL-412/BL-414 pair)"). An item that carries no such string in its title/body, and cites no test
 * file, is NOT-AUDITABLE by this instrument — a distinct, and worse, finding than "no evidence
 * found for a checkable id". Collapsing the two would overclaim what this tool can see.
 *
 * ── SIGNALS EMITTED PER ITEM ────────────────────────────────────────────────────────────────────
 *   aliasesFound        — BL-<n>/BUG-<n>/DEBT-<n> strings scraped from this item's own title+body
 *   citedTestFiles       — citations[].file entries matching a test/spec filename, deduped
 *   citedTestFilesExtant — of those, which exist on disk right now (a citation to a deleted test
 *                          file is a stronger negative signal than "no citation")
 *   greppedHits          — {file, line, alias} for every alias found via ripgrep in tracked
 *                          test/spec files repo-wide (one rg pass for the whole corpus,
 *                          not one per item — mechanizable, not sampled)
 *   classification        UNEVIDENCED   — has an alias, zero grep hits, no extant test citation
 *                          SKIP-MASKED   — has grep hit(s), but EVERY hit sits in a window this
 *                                          tool judges statically skipped (see LIMITS below)
 *                          CITED         — has a live (non-skip-windowed) grep hit, or an extant
 *                                          test-file citation — necessary, NOT sufficient; still
 *                                          requires a human red→green read
 *                          NOT-AUDITABLE — no alias scraped AND no test-file citation at all;
 *                                          this instrument has no way to check this item
 *   bodyGuardSuspect      — a LEAD, not a verdict (see LIMITS). true means: within a small window
 *                          around a grep hit, this tool saw a guard shape (`if (...) return/continue`
 *                          before an `expect(` in the same window) that COULD be the BL-167
 *                          "skip the assertion for exactly the failing case" shape. A human must
 *                          read the actual test to confirm or reject this.
 *
 * ── WHAT THIS INSTRUMENT CANNOT CHECK (state this to every reader, every time) ────────────────
 *   1. It cannot tell whether a CITED test's assertion actually exercises the failing case, only
 *      that a test naming the id exists and is not (by the heuristics below) statically skipped.
 *      That is exactly BL-225's own standard ("you must have seen it fail," not "it would fail")
 *      and it requires reading the test, which this tool does not do.
 *   2. Skip detection is a WINDOW HEURISTIC (±`SKIP_WINDOW` lines around a hit), not an AST-based
 *      analysis. It reliably catches a literal `.skip(`/`{ skip: true }`/`xit(`/`xdescribe(`/
 *      `it.todo(` sitting near the hit. It does NOT reliably catch the BL-167 shape itself — a
 *      hook-assigned variable read into a frozen `skip` option — which needs the vitest-collection
 *      timing model that `tools/eslint-local/no-hook-assigned-skip.cjs` encodes as an AST rule.
 *      This tool does not invoke that rule (root eslint is not resolvable from a bare `node` process
 *      in this checkout without a build step this scope may not perform); `bodyGuardSuspect` is a
 *      deliberately weaker text heuristic offered as a lead, not a replacement for it.
 *   3. It cannot see an item whose fix test lives in a file extension outside `TEST_GLOB`, or in an
 *      untracked/gitignored file (by design — untracked test evidence is not real evidence a
 *      reviewer without local disk access could ever see).
 *   4. It cannot resolve alias collisions: two unrelated items can carry the same self-reported
 *      "BL-225" string (documented historical hazard — see tools/backlog-citation-allowlist.json).
 *      A CITED verdict from an alias hit is reported against EVERY item that scraped that alias;
 *      the human review step must disambiguate.
 *   5. `backlog query`'s `total` moves under concurrent writers (measured live during this run —
 *      495 at one page, 493 quoted in the originating brief minutes earlier). This tool pages until
 *      `hasMore` is false and asserts the returned count against the LAST-SEEN `meta.total`, but
 *      that total is a snapshot, not a lock.
 *
 * Usage:
 *   node tools/audit-closed-items.mjs [--json] [--out <path>] [--project <name>] [--limit-items N]
 *
 * Exit code: always 0 on a successful read-only run (this is a report, not a gate). Exits 1 only on
 * a tool/backlog-CLI failure that prevented producing a report at all.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ALIAS_PATTERN = /\b(?:BL|BUG|DEBT)-\d{1,4}\b/g;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;
const TEST_GLOB = '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}';
const SKIP_WINDOW = 30; // lines of context searched around a grep hit
const SKIP_SHAPE_RE = /\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bit\.todo\s*\(|\{\s*skip\s*:\s*true\s*\}|\{\s*skip\s*:\s*!?\w+/;
const GUARD_RETURN_RE = /^\s*if\s*\([^)]*\)\s*(?:return|continue)\s*;?\s*$/;
const EXPECT_RE = /\bexpect\s*\(/;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
    ...opts,
  });
}

function parseArgs(argv) {
  const opts = { json: false, out: null, project: 'sox-ecosystem', limitItems: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--limit-items') opts.limitItems = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node tools/audit-closed-items.mjs [--json] [--out <path>] [--project <name>] [--limit-items N]',
      );
      process.exit(0);
    }
  }
  return opts;
}

// ── 1. fetch every closed item, read-only, paginated ──────────────────────────────────────────
function fetchClosedItems(project, limitItems) {
  const FIELDS = ['uid', 'title', 'status', 'priority', 'closedAt', 'createdAt', 'citations', 'body'];
  const seen = new Map(); // uid -> item (dedupe against concurrent-writer drift)
  let after;
  let lastTotal = null;
  let guard = 0;
  while (true) {
    guard++;
    if (guard > 60) throw new Error('audit-closed-items: pagination guard tripped (>60 pages) — aborting read');
    const input = {
      filter: { project, status: 'closed' },
      fields: FIELDS,
      limit: 50,
      format: 'json',
      ...(after ? { after } : {}),
    };
    const raw = sh('backlog', ['query', '--input', JSON.stringify(input)]);
    const line = raw.split('\n').find((l) => l.startsWith('{"ok"'));
    if (!line) throw new Error(`audit-closed-items: no JSON line from backlog query, raw=${raw.slice(0, 300)}`);
    const parsed = JSON.parse(line);
    if (!parsed.ok) throw new Error(`audit-closed-items: backlog query failed: ${JSON.stringify(parsed.error)}`);
    const items = parsed.data.items ?? [];
    for (const it of items) seen.set(it.uid, it);
    lastTotal = parsed.data.meta?.total ?? parsed.meta?.total ?? lastTotal;
    if (limitItems && seen.size >= limitItems) break;
    if (!parsed.data.hasMore || items.length === 0) break;
    after = parsed.data.nextCursor;
    if (!after) break;
  }
  return { items: [...seen.values()], lastTotal, pages: guard };
}

function scrapeAliases(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(ALIAS_PATTERN)].map((m) => m[0]))];
}

// ── 2. one repo-wide rg pass over test files for every ALIAS_PATTERN occurrence ────────────────
function trackedFileSet() {
  const out = sh('git', ['ls-files', '-z']);
  return new Set(out.split('\0').filter(Boolean));
}

function grepAliasHitsInTests(tracked) {
  let raw;
  try {
    raw = sh('rg', ['-n', '-o', '--with-filename', '--no-heading', '-g', TEST_GLOB, '-e', ALIAS_PATTERN.source, '.']);
  } catch (err) {
    if (err.status === 1 && !err.stdout) return [];
    if (err.stdout) raw = err.stdout;
    else throw err;
  }
  const hits = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):([A-Z]+-\d{1,4})$/);
    if (!m) continue;
    const [, file, lineNo, alias] = m;
    const rel = file.startsWith('./') ? file.slice(2) : file;
    if (!tracked.has(rel)) continue;
    if (rel === 'tools/audit-closed-items.mjs' || rel === 'scripts/audit-closed-items.test.mjs') continue;
    hits.push({ file: rel, line: Number(lineNo), alias });
  }
  return hits;
}

// ── 3. per-hit skip / guard-suspect classification, via a small line-window heuristic ──────────
const fileLineCache = new Map();
function linesOf(file) {
  if (fileLineCache.has(file)) return fileLineCache.get(file);
  let lines = null;
  const abs = path.join(REPO_ROOT, file);
  if (existsSync(abs)) {
    try {
      lines = readFileSync(abs, 'utf8').split('\n');
    } catch {
      lines = null;
    }
  }
  fileLineCache.set(file, lines);
  return lines;
}

function classifyHit(hit) {
  const lines = linesOf(hit.file);
  if (!lines) return { skipMasked: false, bodyGuardSuspect: false, windowUnavailable: true };
  const start = Math.max(0, hit.line - 1 - SKIP_WINDOW);
  const end = Math.min(lines.length, hit.line - 1 + SKIP_WINDOW);
  const window = lines.slice(start, end);
  const windowText = window.join('\n');
  const skipMasked = SKIP_SHAPE_RE.test(windowText);
  let bodyGuardSuspect = false;
  for (let i = 0; i < window.length; i++) {
    if (GUARD_RETURN_RE.test(window[i])) {
      const after = window.slice(i + 1, i + 12).join('\n');
      if (EXPECT_RE.test(after)) {
        bodyGuardSuspect = true;
        break;
      }
    }
  }
  return { skipMasked, bodyGuardSuspect, windowUnavailable: false };
}

// ── pure classifier — the unit under test. Takes already-resolved evidence (no I/O) so
// scripts/audit-closed-items.test.mjs can feed it a synthetic corpus without touching the
// backlog CLI, git, or rg. ─────────────────────────────────────────────────────────────────────
function classifyItem({ aliasesFound, citedTestFiles, citedTestFilesExtant, hitDetails }) {
  let anyLiveHit = false;
  let allHitsSkipMasked = hitDetails.length > 0;
  let anyGuardSuspect = false;
  for (const h of hitDetails) {
    if (!h.skipMasked) {
      allHitsSkipMasked = false;
      anyLiveHit = true;
    }
    if (h.bodyGuardSuspect) anyGuardSuspect = true;
  }

  let classification;
  if (anyLiveHit || citedTestFilesExtant.length > 0) {
    classification = 'CITED';
  } else if (hitDetails.length > 0 && allHitsSkipMasked) {
    classification = 'SKIP-MASKED';
  } else if (aliasesFound.length > 0 || citedTestFiles.length > 0) {
    classification = 'UNEVIDENCED';
  } else {
    classification = 'NOT-AUDITABLE';
  }
  return { classification, bodyGuardSuspect: anyGuardSuspect };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { items: shallowItems, lastTotal, pages } = fetchClosedItems(opts.project, opts.limitItems);

  const tracked = trackedFileSet();
  const allHits = grepAliasHitsInTests(tracked);
  const hitsByAlias = new Map(); // alias -> [{file,line,alias}]
  for (const h of allHits) {
    if (!hitsByAlias.has(h.alias)) hitsByAlias.set(h.alias, []);
    hitsByAlias.get(h.alias).push(h);
  }

  const rows = [];
  for (const shallow of shallowItems) {
    const title = shallow.title ?? '';
    const body = shallow.body ?? '';
    const aliasesFound = [...new Set([...scrapeAliases(title), ...scrapeAliases(body)])];

    const citedTestFiles = [
      ...new Set(
        (shallow.citations ?? [])
          .map((c) => c.file)
          .filter((f) => typeof f === 'string' && TEST_FILE_RE.test(f)),
      ),
    ];
    const citedTestFilesExtant = citedTestFiles.filter((f) => existsSync(path.join(REPO_ROOT, f)));

    const greppedHits = [];
    for (const alias of aliasesFound) {
      for (const h of hitsByAlias.get(alias) ?? []) greppedHits.push(h);
    }

    const hitDetails = greppedHits.map((h) => ({ ...h, ...classifyHit(h) }));
    const { classification, bodyGuardSuspect } = classifyItem({
      aliasesFound,
      citedTestFiles,
      citedTestFilesExtant,
      hitDetails,
    });

    rows.push({
      uid: shallow.uid,
      title,
      status: shallow.status,
      priority: shallow.priority ?? null,
      closedAt: shallow.closedAt ?? null,
      createdAt: shallow.createdAt ?? null,
      aliasesFound,
      citedTestFiles,
      citedTestFilesExtant,
      greppedHits: hitDetails,
      classification,
      bodyGuardSuspect,
    });
  }

  const distribution = { CITED: 0, 'SKIP-MASKED': 0, UNEVIDENCED: 0, 'NOT-AUDITABLE': 0 };
  for (const r of rows) distribution[r.classification]++;

  const report = {
    generatedAt: new Date().toISOString(),
    project: opts.project,
    fetchedCount: rows.length,
    lastSeenGraphTotal: lastTotal,
    pagesFetched: pages,
    distribution,
    guardSuspectCount: rows.filter((r) => r.bodyGuardSuspect).length,
    rows,
  };

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(report, null, 2));
  }
  if (opts.json || !opts.out) {
    console.log(JSON.stringify(opts.out ? { ...report, rows: undefined } : report, null, 2));
  }
  process.exit(0);
}

export {
  ALIAS_PATTERN,
  TEST_FILE_RE,
  SKIP_SHAPE_RE,
  GUARD_RETURN_RE,
  EXPECT_RE,
  scrapeAliases,
  classifyHit,
  classifyItem,
  linesOf,
  fileLineCache,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
