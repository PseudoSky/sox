#!/usr/bin/env node
/**
 * bl-id-counter — [ADR-0011 R5 / B4 / BL-476] repo-local next-id counter for tool-filed `BL-*`
 * items, standing in for `computeNextHumanId` until BL-476 (the graph-only allocator's blindness
 * to markdown history) is fixed upstream.
 *
 * WHY THIS EXISTS
 * ---------------
 * `computeNextHumanId` (`~/dev/sdlc-experiments/arm-rf/rf-run/entrypoint/backlog/src/store/ids.ts:25-55`)
 * derives the next id as `MAX(live graph nodes' humanId) + 1` and has zero visibility into
 * markdown-only history in `BACKLOG.md`/`CHANGELOG.md`. That already produced one live collision
 * (`BL-437`, `BACKLOG.md:3307`). ADR-0011 §3 Decision R5 rules that every `backlog_create_item`
 * call for family `BL` in this repo, from Stage 1 onward, must pass an explicit `idOverride`
 * sourced from THIS counter — never trust the graph-only auto-allocation.
 *
 * SEEDING (Stage 0)
 * ------------------
 * The watermark is `max(highest BL-N in BACKLOG.md headings, highest BL-N in either CHANGELOG.md
 * grammar, highest BL-N live in the graph)`. The graph figure cannot be computed by this script (it
 * has no MCP client) — it must be supplied by the caller via `--seed <n>` after cross-checking a
 * live `backlog_export_json`/`backlog_list_items` call. `--seed` refuses to lower an existing
 * watermark (a seed can only move forward) and refuses to run at all if the counter file already
 * exists with a HIGHER watermark than requested, which would silently reissue already-issued ids.
 *
 * SHARED ROOT — same semantics as allocate-bl-id.mjs / check-bl-id-integrity.mjs / check-backlog-
 * markers.mjs (BL-416): the counter file and its lock live at the git-common-dir-resolved MAIN
 * checkout root, never a worktree's own copy, so every worktree and the main checkout race on (and
 * see) the SAME counter.
 *
 * FILE FORMAT (`.bl-id-counter.json`, at REPO_ROOT):
 *   {
 *     "watermark": 478,                          // Stage-0 seed; ids <= this are pre-ADR-0011 markdown history
 *     "next": 479,                                // next id this counter will issue
 *     "seededAt": "2026-08-06T...",
 *     "seededFrom": { "backlogMax": 478, "changelogMax": 472, "graphMax": 478 },
 *     "issued": [ { "id": "BL-479", "at": "2026-08-06T...", "note": "..." } ]
 *   }
 *
 * `issued` is the authoritative list `check-bl-id-integrity.mjs` cross-checks new/edited
 * `### BL-<n>` markdown headings against (ADR-0011 §4 Stage 1 item 4) — a human hand-filing an id
 * this counter already issued is exactly the split-brain collision this migration exists to end.
 *
 * Usage:
 *   node tools/bl-id-counter.mjs --seed <n> [--backlog-max <n> --changelog-max <n> --graph-max <n>]
 *                                            # Stage-0 only: create the counter file. Fails if it
 *                                            # already exists (use --reseed to force, dangerous).
 *   node tools/bl-id-counter.mjs                # reserve + print the next id (BL-<n>), increments
 *                                                # `next` and appends to `issued` under a lock.
 *   node tools/bl-id-counter.mjs --peek          # print the next id WITHOUT reserving it (read-only)
 *   node tools/bl-id-counter.mjs --watermark      # print the seeded watermark, read-only
 *   node tools/bl-id-counter.mjs --issued         # print the issued ids as a JSON array, read-only
 *   node tools/bl-id-counter.mjs --note "<text>"  # attach a note to the reservation (with default reserve)
 *   node tools/bl-id-counter.mjs --help | -h
 *
 * Exit 0 = success (id or requested data on stdout). Exit 1 = usage or state error.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const USAGE = `bl-id-counter — repo-local next-id counter for tool-filed BL-* items (ADR-0011 R5)

Usage:
  node tools/bl-id-counter.mjs --seed <n> [--backlog-max <n> --changelog-max <n> --graph-max <n>]
                                            # Stage-0 only: create the counter file (fails if it exists)
  node tools/bl-id-counter.mjs                # reserve + print the next id (BL-<n>)
  node tools/bl-id-counter.mjs --peek          # print the next id, read-only, no reservation
  node tools/bl-id-counter.mjs --watermark      # print the seeded watermark, read-only
  node tools/bl-id-counter.mjs --issued         # print issued ids as JSON, read-only
  node tools/bl-id-counter.mjs --note "<text>"  # attach a note when reserving (default reserve mode)
  node tools/bl-id-counter.mjs --reseed <n> ... # DANGEROUS: force-overwrite an existing counter file
  node tools/bl-id-counter.mjs --help | -h

Always targets the MAIN checkout's counter file (git-common-dir based), never the invoking
worktree's own copy — same shared-root semantics as allocate-bl-id.mjs (BL-416).`;

const args = process.argv.slice(2);
const HELP = args.includes('--help') || args.includes('-h');
const PEEK = args.includes('--peek');
const WATERMARK = args.includes('--watermark');
const ISSUED = args.includes('--issued');

function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return v;
}

const SEED = flagValue('--seed');
const RESEED = flagValue('--reseed');
const BACKLOG_MAX = flagValue('--backlog-max');
const CHANGELOG_MAX = flagValue('--changelog-max');
const GRAPH_MAX = flagValue('--graph-max');
const NOTE = flagValue('--note');

const recognized = new Set([
  '--help', '-h', '--peek', '--watermark', '--issued',
  '--seed', '--reseed', '--backlog-max', '--changelog-max', '--graph-max', '--note',
]);
const positionalConsumers = new Set(['--seed', '--reseed', '--backlog-max', '--changelog-max', '--graph-max', '--note']);
const unrecognized = args.filter((a, i) => {
  if (recognized.has(a)) return false;
  // value tokens consumed by a preceding flag are not "unrecognized"
  const prev = args[i - 1];
  if (positionalConsumers.has(prev)) return false;
  return true;
});

if (HELP) {
  console.log(USAGE);
  process.exit(0);
}
if (unrecognized.length > 0) {
  for (const a of unrecognized) {
    console.error(`bl-id-counter: unrecognized argument '${a}'. Run with --help for usage.`);
  }
  process.exit(1);
}

// [BL-416] SHARED registry root — same resolution as allocate-bl-id.mjs / check-bl-id-integrity.mjs.
const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..',
);
const COUNTER_FILE = path.join(REPO_ROOT, '.bl-id-counter.json');
const LOCK_DIR = path.join(REPO_ROOT, '.bl-id-counter.lock');

function echoResolvedPaths() {
  console.error(`[bl-id-counter] counter file -> ${COUNTER_FILE}`);
  console.error(`[bl-id-counter] lock dir     -> ${LOCK_DIR}`);
}

function readCounter() {
  if (!existsSync(COUNTER_FILE)) {
    throw new Error(
      `bl-id-counter: no counter file at ${COUNTER_FILE}. Run with --seed <n> first (Stage 0).`,
    );
  }
  return JSON.parse(readFileSync(COUNTER_FILE, 'utf8'));
}

function writeCounter(state) {
  writeFileSync(COUNTER_FILE, JSON.stringify(state, null, 2) + '\n');
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
          `bl-id-counter: could not acquire lock at ${LOCK_DIR} within ${timeoutMs}ms — another ` +
            `reservation is in progress (or a prior run crashed and left the lock behind).`,
        );
      }
      execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${pollMs})`]);
    }
  }
}

function releaseLock() {
  if (existsSync(LOCK_DIR)) rmdirSync(LOCK_DIR);
}

function doSeed(seedValueRaw, { force }) {
  const seedValue = Number(seedValueRaw);
  if (!Number.isInteger(seedValue) || seedValue < 1) {
    throw new Error(`--seed/--reseed value must be a positive integer, got '${seedValueRaw}'`);
  }
  echoResolvedPaths();
  acquireLock();
  try {
    if (existsSync(COUNTER_FILE) && !force) {
      const existing = readCounter();
      throw new Error(
        `bl-id-counter: counter file already exists (watermark ${existing.watermark}, next ` +
          `${existing.next}). Refusing to reseed without --reseed (which requires re-invoking with ` +
          `the --seed flag replaced by --reseed, and is dangerous — it can reissue already-issued ` +
          `ids if the new watermark is lower than 'next' - 1).`,
      );
    }
    if (existsSync(COUNTER_FILE) && force) {
      const existing = readCounter();
      if (seedValue < existing.watermark) {
        throw new Error(
          `bl-id-counter: refusing --reseed ${seedValue} — lower than the existing watermark ` +
            `${existing.watermark}. A seed can only move forward.`,
        );
      }
    }
    const state = {
      watermark: seedValue,
      next: seedValue + 1,
      seededAt: new Date().toISOString(),
      seededFrom: {
        backlogMax: BACKLOG_MAX !== undefined ? Number(BACKLOG_MAX) : null,
        changelogMax: CHANGELOG_MAX !== undefined ? Number(CHANGELOG_MAX) : null,
        graphMax: GRAPH_MAX !== undefined ? Number(GRAPH_MAX) : null,
      },
      issued: [],
    };
    writeCounter(state);
    console.log(`bl-id-counter: seeded watermark=${seedValue}, next=${state.next} -> ${COUNTER_FILE}`);
  } finally {
    releaseLock();
  }
}

function doReserve(note) {
  echoResolvedPaths();
  acquireLock();
  try {
    const state = readCounter();
    const id = `BL-${state.next}`;
    state.issued.push({ id, at: new Date().toISOString(), note: note ?? null });
    state.next += 1;
    writeCounter(state);
    console.log(id);
  } finally {
    releaseLock();
  }
}

function doPeek() {
  const state = readCounter();
  console.log(`BL-${state.next}`);
}

function doWatermark() {
  const state = readCounter();
  console.log(String(state.watermark));
}

function doIssued() {
  const state = readCounter();
  console.log(JSON.stringify(state.issued.map((e) => e.id)));
}

function main() {
  if (SEED !== undefined) return doSeed(SEED, { force: false });
  if (RESEED !== undefined) return doSeed(RESEED, { force: true });
  if (PEEK) return doPeek();
  if (WATERMARK) return doWatermark();
  if (ISSUED) return doIssued();
  return doReserve(NOTE);
}

main();
