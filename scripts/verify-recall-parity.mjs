#!/usr/bin/env node
/**
 * scripts/verify-recall-parity.mjs — Cross-backend recall parity checker.
 *
 * Opens two pre-populated memory stores (one SqliteAdapter, one TursoAdapter),
 * generates random queries from episode content, runs memoryRecall on both,
 * and verifies that top-K rank order matches within a configurable threshold.
 *
 * Usage:
 *   node scripts/verify-recall-parity.mjs --sqlite <path> --turso <path>
 *
 * Flags:
 *   --sqlite <path>   Path to SqliteAdapter store (.db file)
 *   --turso <path>    Path to TursoAdapter store (.db file)
 *   --queries <N>     Number of random queries to run (default: 50)
 *   --k <N>           Top-K results to compare per query (default: 10)
 *   --threshold <N>   Pass threshold percentage (default: 98)
 *   --help            Print this usage message and exit
 *
 * Exit codes:
 *   0 — pass rate meets or exceeds threshold
 *   1 — pass rate below threshold, or error
 *
 * NOTE on workspace imports:
 * pnpm does not hoist workspace packages to the root node_modules.
 * The script imports memory-core's CJS dist bundle via a file:// URL so its
 * internal require() calls resolve through pnpm's isolated linker
 * (each workspace package has its own node_modules with deps).
 * Build memory-core before first use:  npx nx build memory-core
 */

// ── CLI ────────────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);

function flagValue(name) {
  const i = ARGV.indexOf(name);
  if (i === -1) return null;
  const v = ARGV[i + 1];
  if (v === undefined || v.startsWith('-')) {
    console.error(`[verify-recall-parity] flag ${name} requires a value`);
    process.exit(2);
  }
  return v;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/verify-recall-parity.mjs --sqlite <path> --turso <path> [options]

Flags:
  --sqlite <path>     Path to SqliteAdapter store (.db file)              [required]
  --turso <path>      Path to TursoAdapter store (.db file)               [required]
  --queries <N>       Number of random queries to run                     [default: 50]
  --k <N>             Top-K results to compare per query                  [default: 10]
  --threshold <N>     Pass threshold percentage                           [default: 98]
  --help              Print this usage message and exit

Examples:
  node scripts/verify-recall-parity.mjs \\
    --sqlite /path/to/sqlite/memory.db \\
    --turso /path/to/turso/memory.db

  node scripts/verify-recall-parity.mjs \\
    --sqlite /path/to/sqlite/memory.db \\
    --turso /path/to/turso/memory.db \\
    --queries 100 --k 5 --threshold 95
`);
}

if (ARGV.includes('--help') || ARGV.includes('-h')) {
  printHelp();
  process.exit(0);
}

const sqlitePath = flagValue('--sqlite');
const tursoPath = flagValue('--turso');

if (!sqlitePath || !tursoPath) {
  console.error('[verify-recall-parity] --sqlite and --turso are required');
  printHelp();
  process.exit(2);
}

const numQueries = parseInt(flagValue('--queries') ?? '50', 10);
const topK = parseInt(flagValue('--k') ?? '10', 10);
const thresholdPct = parseInt(flagValue('--threshold') ?? '98', 10);

// ── Imports ────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Import @adhd/sox-memory-core via its CJS dist bundle at a file:// URL.
 * This works because the CJS `require()` calls inside memory-core's
 * compiled output resolve through pnpm's isolated linker
 * (memory-core/node_modules/@adhd/*) — CJS resolution walks upward from
 * the calling file's directory, finding every workspace dependency.
 */
const _scriptDir = new URL('.', import.meta.url).pathname;
const _memoryCorePath = _scriptDir + '../libs/memory-core/dist/index.js';
const _memoryCore = await import(_memoryCorePath);

const {
  memoryRecall,
  openDbReadOnly,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
} = _memoryCore;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Open a store read-only by setting the STORE_ADAPTER env var to the desired type,
 * calling openDbReadOnly, then restoring the original env. Returns the adapter.
 */
async function openAdapter(dbPath, type) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Store not found: ${dbPath}`);
  }
  const resolved = path.resolve(dbPath);
  const prev = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = type;
  try {
    return await openDbReadOnly(resolved);
  } finally {
    if (prev === undefined) {
      delete process.env['STORE_ADAPTER'];
    } else {
      process.env['STORE_ADAPTER'] = prev;
    }
  }
}

/**
 * Read all episode content from a store via the adapter.
 * Returns an array of rows with uid and content.
 */
async function readAllEpisodes(adapter) {
  const result = await adapter.executeAll(
    `SELECT uid, content FROM node WHERE kind = 'episode' AND content IS NOT NULL AND content != ''`,
  );
  return result.rows;
}

/**
 * Pick N random queries by selecting random episode content snippets.
 * For each query we take up to maxLen characters from the episode content.
 */
function generateQueries(episodes, count, maxLen = 120) {
  if (episodes.length === 0) return [];

  const queries = new Set();
  const attempts = Math.max(count * 10, 100);
  let tries = 0;

  while (queries.size < count && tries < attempts) {
    tries++;
    const ep = episodes[Math.floor(Math.random() * episodes.length)];
    const content = ep.content ?? '';
    if (content.length < 10) continue;

    // Pick a random start position and extract a snippet
    const snippetLen = Math.min(maxLen, content.length);
    const start = content.length <= snippetLen
      ? 0
      : Math.floor(Math.random() * (content.length - snippetLen));
    const snippet = content.slice(start, start + snippetLen).trim();
    if (snippet.length >= 5) {
      queries.add(snippet);
    }
  }

  return [...queries].slice(0, count);
}

/**
 * Run memoryRecall on a given adapter with the given query.
 */
async function runRecall(adapter, query, k) {
  const response = await memoryRecall(adapter, 'project', {
    query,
    limit: k,
  });
  return response.results;
}

/**
 * Compare two result arrays for rank-order parity.
 * Returns { match, matchingPositions, totalPositions, sqliteUids, tursoUids, mismatches }.
 */
function compareResults(sqliteResults, tursoResults, k) {
  const sqliteUids = sqliteResults.slice(0, k).map((r) => r.uid);
  const tursoUids = tursoResults.slice(0, k).map((r) => r.uid);

  const maxLen = Math.max(sqliteUids.length, tursoUids.length);

  let matchingPositions = 0;
  const mismatches = [];

  for (let i = 0; i < maxLen; i++) {
    const s = sqliteUids[i];
    const t = tursoUids[i];
    if (s !== undefined && t !== undefined && s === t) {
      matchingPositions++;
    } else {
      mismatches.push({
        position: i,
        sqlite_uid: s ?? null,
        turso_uid: t ?? null,
      });
    }
  }

  const match =
    matchingPositions === maxLen &&
    maxLen > 0 &&
    sqliteUids.length === tursoUids.length;

  return {
    match,
    matchingPositions,
    totalPositions: maxLen,
    sqliteUids,
    tursoUids,
    mismatches: mismatches.length > 0 ? mismatches : undefined,
  };
}

/**
 * Format a JSON result for the final report.
 */
function formatResult(total, matching, threshold, diffs) {
  const pct = total > 0 ? (matching / total) * 100 : 0;
  const pass = pct >= threshold;

  const output = {
    total_queries: total,
    matching,
    matching_pct: Math.round(pct * 100) / 100,
    threshold_pct: threshold,
    pass,
  };

  if (!pass && diffs.length > 0) {
    output.diffs = diffs;
  }

  return output;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Phase 1: Set up deterministic test embedding provider so both stores
  // produce the same vector embeddings for the same query text.
  _resetEmbedSingleton();
  _setEmbedProviderForTest(new DeterministicTestProvider());

  // Phase 2: Open both stores read-only
  console.error(`[verify-recall-parity] Opening sqlite store: ${sqlitePath}`);
  const sqliteAdapter = await openAdapter(sqlitePath, 'sqlite');

  console.error(`[verify-recall-parity] Opening turso store: ${tursoPath}`);
  const tursoAdapter = await openAdapter(tursoPath, 'turso');

  let exitCode = 0;
  const allDiffs = [];

  try {
    // Phase 3: Read all episodes from both stores
    console.error(`[verify-recall-parity] Reading episodes from sqlite store`);
    const sqliteEpisodes = await readAllEpisodes(sqliteAdapter);
    console.error(`[verify-recall-parity]   → ${sqliteEpisodes.length} episodes`);

    console.error(`[verify-recall-parity] Reading episodes from turso store`);
    const tursoEpisodes = await readAllEpisodes(tursoAdapter);
    console.error(`[verify-recall-parity]   → ${tursoEpisodes.length} episodes`);

    // Use the larger set for query generation (more content diversity)
    const allEpisodes =
      sqliteEpisodes.length >= tursoEpisodes.length
        ? sqliteEpisodes
        : tursoEpisodes;

    if (allEpisodes.length === 0) {
      const result = formatResult(0, 0, thresholdPct, []);
      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }

    // Phase 4: Generate random queries from episode content
    const queries = generateQueries(allEpisodes, numQueries, 120);
    const actualQueryCount = queries.length;
    console.error(
      `[verify-recall-parity] Generated ${actualQueryCount} queries from ${allEpisodes.length} episodes`,
    );

    if (actualQueryCount === 0) {
      console.error(
        '[verify-recall-parity] Could not generate any queries (episode content too short?)',
      );
      const result = formatResult(0, 0, thresholdPct, []);
      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }

    // Phase 5: Run recall on both stores for each query
    let matching = 0;

    for (let i = 0; i < actualQueryCount; i++) {
      const query = queries[i];
      const recallK = Math.max(topK, 1);

      const sqliteResults = await runRecall(sqliteAdapter, query, recallK);
      const tursoResults = await runRecall(tursoAdapter, query, recallK);

      const cmp = compareResults(sqliteResults, tursoResults, recallK);

      if (cmp.match) {
        matching++;
      } else {
        allDiffs.push({
          query: query.slice(0, 80) + (query.length > 80 ? '...' : ''),
          query_index: i,
          matching_positions: cmp.matchingPositions,
          total_positions: cmp.totalPositions,
          mismatches: cmp.mismatches,
          sqlite_uids: cmp.sqliteUids,
          turso_uids: cmp.tursoUids,
        });
      }

      if ((i + 1) % 20 === 0 || i === actualQueryCount - 1) {
        console.error(
          `[verify-recall-parity]   ${i + 1}/${actualQueryCount} queries done ` +
            `(${matching} matching, ${allDiffs.length} diffs)`,
        );
      }
    }

    // Phase 6: Output result
    const result = formatResult(actualQueryCount, matching, thresholdPct, allDiffs);
    const finalPct = actualQueryCount > 0 ? (matching / actualQueryCount) * 100 : 0;

    if (result.pass) {
      console.error(
        `[verify-recall-parity] PASS: ${matching}/${actualQueryCount} ` +
          `(${finalPct.toFixed(1)}%) ≥ ${thresholdPct}%`,
      );
    } else {
      console.error(
        `[verify-recall-parity] FAIL: ${matching}/${actualQueryCount} ` +
          `(${finalPct.toFixed(1)}%) < ${thresholdPct}%`,
      );
    }

    console.log(JSON.stringify(result, null, 2));
    exitCode = result.pass ? 0 : 1;
  } finally {
    // Phase 7: Cleanup — close both adapters
    console.error('[verify-recall-parity] Closing sqlite store');
    await sqliteAdapter.close().catch((err) => {
      console.error(
        `[verify-recall-parity] WARNING: Error closing sqlite adapter: ${err.message}`,
      );
    });

    console.error('[verify-recall-parity] Closing turso store');
    await tursoAdapter.close().catch((err) => {
      console.error(
        `[verify-recall-parity] WARNING: Error closing turso adapter: ${err.message}`,
      );
    });
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[verify-recall-parity] FATAL: ${err.message}`);
  console.error(err.stack);
  const result = {
    total_queries: 0,
    matching: 0,
    matching_pct: 0,
    threshold_pct: thresholdPct,
    pass: false,
    error: err.message,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
