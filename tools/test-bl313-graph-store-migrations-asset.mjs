#!/usr/bin/env node
/**
 * tools/test-bl313-graph-store-migrations-asset.mjs — regression test for BL-313.
 *
 * BL-313: @adhd/sox-graph-store's SqliteGraphBackend.applySchema() resolves its
 * Drizzle migrations folder via `fileURLToPath(new URL('../drizzle/migrations',
 * import.meta.url))` — relative to wherever the CURRENTLY EXECUTING file lives.
 * That's correct for graph-store's own unbundled dist/index.js (drizzle/migrations
 * is a sibling of dist/, per graph-store's own package.json "files" list), but once
 * esbuild inlines graph-store's source into a consumer's single-file bundle (e.g.
 * memory-server), import.meta.url at runtime is the CONSUMER's dist/index.js — the
 * same relative path now resolves to a sibling of the CONSUMER's dist/, which was
 * never populated. drizzle-orm's migrate() then throws "Can't find meta/_journal.json
 * file" for every caller that constructs a SqliteGraphBackend inside a bundled
 * artifact. Discovered live 2026-07-18: memory_stats and memory_list_entities failed
 * against the deployed memory-server bundle while memory_write/memory_topics
 * (which don't touch SqliteGraphBackend) worked fine.
 *
 * vitest never caught this because it runs from source via tsx, where
 * import.meta.url is graph-store's own file and the relative path is correct by
 * construction — only the BUNDLED artifact was broken (the same "tests bypass the
 * artifact" trap as BL-87/BL-89/BL-259).
 *
 * Fix: tools/bundle-extension.cjs auto-discovers `sox.assets` declared in any
 * inlined package's package.json (graph-store declares `["drizzle/migrations"]`)
 * and copies each into the bundle's own outdir-sibling position, reproducing the
 * unbundled layout the runtime path resolution already assumes.
 *
 * Covers, against the REAL memory-server entry point (not a synthetic probe —
 * un-aliased @adhd/sox-* resolution depends on which package's own node_modules
 * symlinks are in scope, so a probe outside memory-core's dependency tree can't
 * reproduce the real resolution path):
 *   1. End-to-end build of extensions/bundles/sox-memory-bundle/members/memory-server
 *      into a scratch outdir — proves drizzle/migrations lands as a sibling of it.
 *   2. require()ing the built artifact and calling handleToolCall('memory_stats', ...)
 *      and handleToolCall('memory_list_entities', ...) against a scratch DB — both
 *      construct a SqliteGraphBackend internally; proves neither throws
 *      "Can't find meta/_journal.json file".
 *   3. Regression check on the fix's own failure mode: temporarily renaming the
 *      committed asset dir away reproduces the original throw (proves the test
 *      actually exercises the code path it claims to, not a vacuous pass).
 *
 * Run: node tools/test-bl313-graph-store-migrations-asset.mjs
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_SERVER_ENTRY = 'extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts';
const MEMORY_SERVER_TSCONFIG = 'extensions/bundles/sox-memory-bundle/members/memory-server/tsconfig.json';

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

console.log('BL-313 — graph-store Drizzle migrations folder missing from bundled artifacts\n');

console.log('[1] end-to-end: build the real memory-server entry point into a scratch outdir');

const SCRATCH_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bl313-memsrv-out-'));
const scratchDbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bl313-probe-db-')) + '/probe.db';

// The build's own bundle-swap logic derives the asset dir's final location from
// path.dirname(outdir) — SCRATCH_OUT must therefore be a leaf dir we own, not a
// bare mkdtemp root, so the sibling drizzle/ dir doesn't land in shared /tmp.
const buildOutdir = path.join(SCRATCH_OUT, 'dist');

// better-sqlite3 etc. are externalized (lazy-required at first use) — Node's CJS
// resolution for that require() walks up from the REQUIRING FILE's own directory,
// not process.cwd(). Symlink the real memory-server's node_modules in so the
// scratch build resolves them exactly like the real deployed dist/ does.
fs.symlinkSync(
  path.join(ROOT, 'extensions/bundles/sox-memory-bundle/members/memory-server/node_modules'),
  path.join(SCRATCH_OUT, 'node_modules'),
);

try {
  const buildRes = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'bundle-extension.cjs'),
    '--entry', MEMORY_SERVER_ENTRY,
    '--outdir', buildOutdir,
    '--tsconfig', MEMORY_SERVER_TSCONFIG,
    '--external', 'better-sqlite3',
    '--external', 'sqlite-vec',
    '--external', 'fastembed',
    '--external', 'onnxruntime-node',
  ], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

  ok(buildRes.status === 0, `build exits 0 (got ${buildRes.status})`);
  if (buildRes.status !== 0) {
    console.log('  --- build stderr (tail) ---');
    console.log(buildRes.stderr.split('\n').slice(-30).map((l) => '  ' + l).join('\n'));
  }
  ok(fs.existsSync(path.join(buildOutdir, 'index.js')), 'bundle artifact was produced');

  const assetDir = path.join(SCRATCH_OUT, 'drizzle', 'migrations');
  ok(fs.existsSync(path.join(assetDir, 'meta', '_journal.json')), `drizzle/migrations/meta/_journal.json exists as a sibling of outdir (${assetDir})`);

  console.log('\n[2] end-to-end: require() the built artifact and call the previously-broken tools');
  const script = `
    const mod = require(${JSON.stringify(path.join(buildOutdir, 'index.js'))});
    (async () => {
      const dbPath = ${JSON.stringify(scratchDbPath)};
      const stats = await mod.handleToolCall('memory_stats', { db_path: dbPath });
      const entities = await mod.handleToolCall('memory_list_entities', { db_path: dbPath, limit: 5 });
      console.log('BL313_STATS_RESULT:' + JSON.stringify(stats));
      console.log('BL313_ENTITIES_RESULT:' + JSON.stringify(entities));
    })().catch((err) => {
      console.error('BL313_THREW:', err && err.message ? err.message : String(err));
      process.exit(1);
    });
  `;
  const runRes = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });

  if (runRes.status !== 0 || !runRes.stdout.includes('BL313_STATS_RESULT')) {
    console.log('  --- run stdout ---');
    console.log(runRes.stdout);
    console.log('  --- run stderr ---');
    console.log(runRes.stderr);
  }
  ok(runRes.status === 0, `calling memory_stats + memory_list_entities against the bundled artifact exits 0 (got ${runRes.status})`);
  ok(runRes.stdout.includes('BL313_STATS_RESULT'), 'memory_stats returned a result');
  ok(!/"isError":true/.test(runRes.stdout.split('BL313_STATS_RESULT:')[1]?.split('\n')[0] ?? ''), 'memory_stats did not return isError:true');
  ok(runRes.stdout.includes('BL313_ENTITIES_RESULT'), 'memory_list_entities returned a result');
  ok(!/"isError":true/.test(runRes.stdout.split('BL313_ENTITIES_RESULT:')[1]?.split('\n')[0] ?? ''), 'memory_list_entities did not return isError:true');
  ok(!runRes.stdout.includes("Can't find meta/_journal.json") && !runRes.stderr.includes("Can't find meta/_journal.json"), 'no "Can\'t find meta/_journal.json file" error anywhere in output');

  // ── 3. Prove the test is not vacuous: removing the committed asset dir
  // reproduces the exact original failure. ───────────────────────────────
  console.log('\n[3] negative control: removing the asset dir reproduces the original bug');
  const assetBackup = `${assetDir}.bl313-negctl-backup`;
  fs.renameSync(assetDir, assetBackup);
  try {
    const negRes = spawnSync(process.execPath, ['-e', script.replace(/probe\.db/, 'probe-negctl.db')], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60000,
    });
    const negOut = negRes.stdout + negRes.stderr;
    ok(
      negOut.includes("Can't find meta/_journal.json") || /"isError":true/.test(negOut),
      'without the asset dir, the original failure reproduces (proves this test is not vacuous)',
    );
  } finally {
    fs.renameSync(assetBackup, assetDir);
  }
} finally {
  fs.rmSync(SCRATCH_OUT, { recursive: true, force: true });
  fs.rmSync(path.dirname(scratchDbPath), { recursive: true, force: true });
}

console.log(
  failed === 0
    ? '\nBL-313 regression: ALL PASS'
    : `\nBL-313 regression: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
