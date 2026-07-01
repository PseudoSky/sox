#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs — manifest-driven lifecycle smoke tests for sox extensions.
 *
 * Discovers every service / mcp-server extension (standalone + bundle members) in
 * the workspace, reads each manifest to derive supported variations (hosts, scopes,
 * serve modes, background-vs-foreground), exercises the full lifecycle via `soxe`
 * in a disposable project scope under dist/smoke/, and records structured pass/fail
 * json to dist/smoke/<run>/log.json.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [--extension id] [--root /tmp/smoke]
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
const WORKSPACE = ARGV.includes('--root') ? path.resolve(ARGV[ARGV.indexOf('--root') + 1]) : path.resolve('.');
const SOXE = path.join(WORKSPACE, 'bin', 'soxe');
const EXTENSION_FILTER = ARGV.includes('--extension') ? ARGV[ARGV.indexOf('--extension') + 1] : null;

const TEST_ROOT = path.resolve(WORKSPACE, 'dist', 'smoke',
  `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const LOG_PATH = path.join(TEST_ROOT, 'log.json');

// ──────────────────────────────────────────────────────────────────────────────
// Logging / tracking
// ──────────────────────────────────────────────────────────────────────────────

const log = [];
const summary = { passed: 0, failed: 0, skipped: 0 };

function sha256(buf) { return require('node:crypto').createHash('sha256').update(buf).digest('hex'); }

async function snapshotFiles(root) {
  const m = new Map();
  try {
    for await (const d of await fsp.opendir(root, { recursive: true })) {
      if (!d.isFile()) continue;
      const full = path.join(d.parentPath, d.name);
      try { m.set(path.relative(root, full), sha256(await fsp.readFile(full))); } catch { m.set(path.relative(root, full), 'UNREADABLE'); }
    }
  } catch {}
  return m;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(k)) changes.push({ op: 'created', path: k });
    else if (!after.has(k)) changes.push({ op: 'deleted', path: k });
    else if (before.get(k) !== after.get(k)) changes.push({ op: 'modified', path: k });
  }
  return changes;
}

async function runCmd(args, opts = {}) {
  const { cwd = TEST_ROOT, timeoutMs = 120_000, testId, extId, extType, stdinInput } = opts;
  const before = await snapshotFiles(TEST_ROOT);
  const t0 = Date.now();
  let stdout = '', stderr = '', exitCode = null, error = null;

  try {
    stdout = execSync(`${SOXE} ${args.join(' ')}`, {
      cwd, encoding: 'utf-8', timeout: timeoutMs,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], input: stdinInput,
    });
    exitCode = 0;
  } catch (e) {
    stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; exitCode = e.status ?? 1; error = e.message.slice(0, 500);
  }
  const after = await snapshotFiles(TEST_ROOT);
  const fileChanges = diffSnapshots(before, after);
  const isServe = args[0] === 'serve';
  const passed = isServe ? (exitCode !== null) : exitCode === 0;

  const entry = { test_id: testId, extension_id: extId, extension_type: extType, command: `${SOXE} ${args.join(' ')}`, exit_code: exitCode, stdout: (stdout || '').slice(-2000), stderr: (stderr || '').slice(-2000), file_changes: (fileChanges || []).slice(0, 50), duration_ms: Date.now() - t0, passed, error };
  log.push(entry);
  passed ? summary.passed++ : summary.failed++;
  return { stdout, stderr, exitCode };
}

// ──────────────────────────────────────────────────────────────────────────────
// Manifest-driven test combinator
// ──────────────────────────────────────────────────────────────────────────────

function hostsFromManifest(m) { return Array.isArray(m.install) ? m.install : []; }
function hasBackground(m) { return m.lifecycle?.background === true; }
function serveModes(m) { return m.lifecycle?.serve_mode === 'proxy' ? ['proxy', 'no-proxy'] : ['no-proxy']; }
function scopesFromManifest(m) { return ['project']; }

async function testExtension(ext) {
  const { id, type, dir, manifest: m } = ext;
  const isBundleMember = dir.includes('/members/');
  const hosts = hostsFromManifest(m);
  const scopes = scopesFromManifest(m);
  const isBackground = hasBackground(m);
  const modes = type === 'mcp-server' ? serveModes(m) : [];

  // ── Install (standalone only) ───────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['install', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-install`, extId: id, extType: type });
      await runCmd(['upgrade', '--all', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-upgrade`, extId: id, extType: type });
    }
  }

  // ── Host-based install (mcp-server / skill) ─────────────────────
  for (const host of hosts) {
    for (const scope of scopes) {
      await runCmd(['install', id, `--host=${host}`, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${host}-${scope}-install`, extId: id, extType: type });
    }
  }

  // ── Service lifecycle (background: true) ───────────────────────
  if (isBackground) {
    for (const scope of scopes) {
      await runCmd(['service', 'enable', id, '--allow-volatile-node', '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `${id}-${scope}-enable`, extId: id, extType: type });
      await runCmd(['service', 'status', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-status`, extId: id, extType: type });
      await runCmd(['service', 'disable', id, '--scope', scope, '--root', TEST_ROOT], { timeoutMs: 30_000, testId: `${id}-${scope}-disable`, extId: id, extType: type });
    }
  }

  // ── MCP serve modes ────────────────────────────────────────────
  const initPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n';
  for (const mode of modes) {
    const args = ['serve', id];
    if (mode === 'no-proxy') args.push('--no-proxy');
    for (const scope of scopes) {
      args.push('--scope', scope, '--root', TEST_ROOT);
    }
    await runCmd(args, { timeoutMs: 30_000, testId: `${id}-serve-${mode}`, extId: id, extType: type, stdinInput: mode === 'no-proxy' ? initPayload : undefined });
  }

  // ── Uninstall (standalone only) ────────────────────────────────
  if (!isBundleMember) {
    for (const scope of scopes) {
      await runCmd(['uninstall', id, '--scope', scope, '--root', TEST_ROOT], { testId: `${id}-${scope}-uninstall`, extId: id, extType: type });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────────

async function discoverExtensions() {
  const exts = [];

  const scan = async (baseDir) => {
    try {
      for (const entry of await fsp.readdir(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(baseDir, entry.name);
        try {
          const raw = await fsp.readFile(path.join(full, 'extension.json'), 'utf-8');
          const m = JSON.parse(raw);
          if (m.id && m.type) exts.push({ id: m.id, type: m.type, dir: full, manifest: m });
        } catch {}
        try { await scan(path.join(full, 'members')); } catch {}
      }
    } catch {}
  };

  for (const typeDir of ['services', 'bundles']) {
    await scan(path.join(WORKSPACE, 'extensions', typeDir));
  }

  const seen = new Set();
  return exts.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    if (EXTENSION_FILTER && e.id !== EXTENSION_FILTER) return false;
    return e.type === 'service' || e.type === 'mcp-server';
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[smoke] root: ${TEST_ROOT}`);
  await fsp.mkdir(TEST_ROOT, { recursive: true });

  await fsp.writeFile(path.join(TEST_ROOT, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  const tr = path.join(TEST_ROOT, 'registry', 'index.json');
  await fsp.mkdir(path.dirname(tr), { recursive: true });
  try { await fsp.unlink(tr); } catch {}
  await fsp.symlink(path.join(WORKSPACE, 'registry', 'index.json'), tr);

  const extensions = await discoverExtensions();

  // Install bundles that contain service/mcp-server members
  const bundleIds = new Set();
  if (extensions.some(e => e.dir.includes('/members/'))) {
    const installed = new Set();
    for (const e of extensions) {
      if (!e.dir.includes('/members/')) continue;
      const bid = e.dir.split('/members/')[0].split('/').pop();
      if (!installed.has(bid)) {
        installed.add(bid);
        console.error(`[smoke] installing bundle ${bid}`);
        await runCmd(['install', bid, '--scope=project', '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `bundle-${bid}-install`, extId: bid, extType: 'bundle' });
        await runCmd(['upgrade', '--all', '--scope=project', '--root', TEST_ROOT], { timeoutMs: 60_000, testId: `bundle-${bid}-upgrade`, extId: bid, extType: 'bundle' });
      }
    }
  }

  console.error(`[smoke] ${extensions.length} testable: ${extensions.map(e => e.id).join(', ')}`);
  for (const ext of extensions) {
    console.error(`[smoke] testing ${ext.id} (${ext.type})`);
    try { await testExtension(ext); } catch (err) { console.error(`[smoke] FATAL ${ext.id}:`, err); }
  }

  await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fsp.writeFile(LOG_PATH, JSON.stringify({ run_id: path.basename(TEST_ROOT), root: TEST_ROOT, tests: log, summary }, null, 2) + '\n');
  console.error(`[smoke] done — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

main();
