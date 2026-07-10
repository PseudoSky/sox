#!/usr/bin/env node
/**
 * tools/probe-bl41-tilde-dbpath.mjs — BL-41 reality gate.
 *
 * Drives the MATERIALIZED memory-server bundle over stdio (the real artifact a
 * Claude Code session spawns) with a `db_path` of "~/.memory/<x>.db" — the literal
 * string the skill docs show — and proves:
 *   (1) the write succeeds and the db lands at $HOME/.memory/<x>.db, and
 *   (2) NO literal `~` directory is created relative to cwd (the BL-41 regression).
 *
 * Runs the bundle in a child process with HOME = throwaway temp and cwd = a second
 * throwaway temp.
 *
 * There is no hash embedding backend to fall back to for speed (removed — see
 * libs/memory-core/src/embed.ts:43, EmbedBackend = 'auto' | 'real'; `resolveProvider()`
 * always creates the real fastembed/ONNX provider regardless of SOX_EMBED_BACKEND's
 * value). Because HOME is thrown away above, the default cacheDir
 * (`homedir()/.cache/sox-memory/models`, see embed.ts:51-60) would resolve to a fresh
 * empty temp dir on every run, forcing a full model re-download each invocation. We pin
 * SOX_EMBED_CACHE_DIR to THIS process's real (pre-override) persistent cache dir so the
 * already-downloaded bge-base-en-v1.5 ONNX model (~228MB) is reused across runs instead
 * of re-fetched from HuggingFace every time.
 *
 * Exit 0 = the gate holds.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Persistent embed-model cache dir, resolved against THIS process's real HOME/XDG env
// (before the child below gets a throwaway HOME) — mirrors libs/memory-core/src/embed.ts
// resolveConfig()'s own precedence: SOX_EMBED_CACHE_DIR > XDG_CACHE_HOME > ~/.cache.
const PERSISTENT_EMBED_CACHE_DIR =
  process.env['SOX_EMBED_CACHE_DIR'] ??
  path.join(
    process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'),
    'sox-memory',
    'models',
  );

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

// Build a self-contained memory-server bundle to a temp dir on-demand. memory-server's
// `bundle/` is build output, NOT a tracked artifact (BL-38) — esbuild inlines @adhd/sox-*;
// native addons (better-sqlite3/sqlite-vec) stay external and resolve via NODE_PATH below.
const TMP_BUNDLE = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-bundle-'));
const build = spawnSync(process.execPath, [
  path.join(ROOT, 'tools', 'bundle-extension.cjs'),
  '--entry', 'extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts',
  '--outdir', TMP_BUNDLE,
  '--external', 'better-sqlite3', '--external', 'sqlite-vec',
], { encoding: 'utf8', cwd: ROOT });
ok(build.status === 0, `built self-contained memory-server bundle (status ${build.status})`);
if (build.status !== 0) { console.error(build.stderr); process.exit(1); }
const BUNDLE = path.join(TMP_BUNDLE, 'index.js');
ok(fs.existsSync(BUNDLE), 'bundle artifact exists');
if (!fs.existsSync(BUNDLE)) { process.exit(1); }

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-home-'));
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-cwd-'));
process.on('exit', () => {
  for (const d of [TMP_HOME, TMP_CWD, TMP_BUNDLE]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const rpc = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_write', arguments: { content: 'BL-41 e2e tilde db_path', db_path: '~/.memory/bl41-e2e.db' } } }),
  '',
].join('\n');

const res = spawnSync(process.execPath, [BUNDLE], {
  cwd: TMP_CWD,
  input: rpc,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: TMP_HOME,
    USERPROFILE: TMP_HOME,
    SOX_EMBED_BACKEND: 'real',
    SOX_EMBED_CACHE_DIR: PERSISTENT_EMBED_CACHE_DIR,
    NODE_PATH: path.join(ROOT, 'node_modules'),
  },
});

ok(res.status === 0, `bundle exited 0 (got ${res.status})`);

// The write response must carry an episode_uid (success).
const wrote = (res.stdout || '').includes('episode_uid');
ok(wrote, 'memory_write returned an episode_uid');
if (!wrote && res.stderr) console.error('  stderr: ' + res.stderr.split('\n').slice(-5).join('\n'));

// (1) db landed under $HOME/.memory
ok(fs.existsSync(path.join(TMP_HOME, '.memory', 'bl41-e2e.db')),
  'db written at $HOME/.memory/bl41-e2e.db (tilde expanded)');

// (2) NO literal `~` dir relative to cwd — the exact BL-41 regression
ok(!fs.existsSync(path.join(TMP_CWD, '~')),
  'no literal "~" directory created relative to cwd');
ok(!fs.existsSync(path.join(TMP_CWD, '~', '.memory')),
  'no literal "~/.memory" directory created relative to cwd');

console.log(failed === 0
  ? '\nBL-41 tilde db_path gate: ALL PASS'
  : `\nBL-41 tilde db_path gate: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
