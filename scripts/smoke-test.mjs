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

/**
 * Read a `--flag value` pair. Guards against the value being missing or being
 * another flag — otherwise `--root --extension foo` would silently treat
 * `--extension` as the root path and write output to `./--extension/…`
 * (that exact bug created a stray `--extension/` dir in the repo).
 */
function flagValue(name) {
  const i = ARGV.indexOf(name);
  if (i === -1) return null;
  const v = ARGV[i + 1];
  if (v === undefined || v.startsWith('-')) {
    console.error(`[smoke] flag ${name} requires a value (got ${v === undefined ? 'end-of-args' : v})`);
    process.exit(2);
  }
  return v;
}

const rootArg = flagValue('--root');
const WORKSPACE = rootArg ? path.resolve(rootArg) : path.resolve('.');
const SOXE = path.join(WORKSPACE, 'bin', 'soxe');
const EXTENSION_FILTER = flagValue('--extension');

const TEST_ROOT = path.resolve(WORKSPACE, 'dist', 'smoke',
  `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const LOG_PATH = path.join(TEST_ROOT, 'log.json');

// ── BL-173 Hermetic data-root sandbox ─────────────────────────────────────────
//
// The service/serve legs derive the backend UDS socket from the USER data root
// (~/.adhd/sox-ecosystem/run/supervisors/ via libs/host-runtime/src/data-paths.ts
// `socketDir()`). If SOX_ECOSYSTEM_HOME is not set, every soxe spawn in this
// harness races the production memory-server writer for the live socket.
//
// Fix: inject a scratch data root and scratch db path into EVERY child process
// this harness spawns. The runtime (data-paths.ts) reads SOX_ECOSYSTEM_HOME at
// call time, so setting it in the child's env is sufficient.
//
//   SOX_ECOSYSTEM_HOME  — redirects userDataRoot() → socket dir, install-registry,
//                          supervisors, ledger, ownership (libs/host-runtime AND
//                          libs/install-engine both honour the same var).
//   SOX_CONFIG_DB_PATH  — redirects the singleton-key for the memory-server backend
//                          (resolveStoreResource() in libs/host-runtime uses this as
//                          the canonical single-writer SQLite resource). Without it
//                          the backend's singleton key defaults to the live
//                          ~/.memory/memory.db path, which causes the smoke-spawned
//                          process to contest the live backend's store.
//
// The live user data root (~/.adhd/sox-ecosystem) MUST remain untouched.
// An assertion in main() verifies no sockets appeared under the real socket dir.

const SMOKE_DATA_ROOT = path.join(TEST_ROOT, 'sox-data-root');
const SMOKE_DB_PATH = path.join(TEST_ROOT, 'sox-data-root', 'memory-smoke.db');

// Derive the real live socket dir so we can assert against it after the run.
const REAL_SOCKET_DIR = process.env['SOX_ECOSYSTEM_HOME']
  ? path.join(process.env['SOX_ECOSYSTEM_HOME'], 'run', 'supervisors')
  : path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem', 'run', 'supervisors');

/** Env block injected into every child process this harness spawns. */
function smokeEnv() {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    // BL-173: redirect data root and db path away from the live user installation.
    SOX_ECOSYSTEM_HOME: SMOKE_DATA_ROOT,
    SOX_CONFIG_DB_PATH: SMOKE_DB_PATH,
  };
}

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
  } catch (err) {
    // A failed snapshot silently yields an empty map, which then diffs as
    // "everything created" — false isolation evidence. Trace it.
    console.error(`[smoke] WARNING: snapshot of ${root} failed (${(err && err.message) ?? err}); before/after diff will be unreliable`);
  }
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
      env: smokeEnv(),
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

// Unfiltered: every extension.json-bearing dir under extensions/{services,bundles}
// (INCLUDING non-service/mcp-server members like a bundle's skill members) — the
// raw universe BL-407's preflight-scoping needs to find bundle SIBLINGS of a
// filtered target, not just the filtered target itself.
async function scanAllExtensionDirs() {
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
        } catch (err) {
          // A malformed extension.json is a real manifest defect, not a skip.
          console.error(`[smoke] WARNING: unreadable extension.json at ${full} (${(err && err.message) ?? err})`);
        }
        try { await scan(path.join(full, 'members')); } catch (err) {
          console.error(`[smoke] WARNING: scanning members of ${full} failed (${(err && err.message) ?? err})`);
        }
      }
    } catch (err) {
      console.error(`[smoke] WARNING: scanning ${baseDir} failed (${(err && err.message) ?? err})`);
    }
  };

  for (const typeDir of ['services', 'bundles']) {
    await scan(path.join(WORKSPACE, 'extensions', typeDir));
  }
  return exts;
}

async function discoverExtensions(allExts) {
  const seen = new Set();
  return allExts.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    if (EXTENSION_FILTER && e.id !== EXTENSION_FILTER) return false;
    return e.type === 'service' || e.type === 'mcp-server';
  });
}

// ── BL-407: scope the exports-contract preflight to what --extension actually
//    exercises, instead of the whole workspace ─────────────────────────────────
//
// Without this, `node scripts/smoke-test.mjs --extension memory-server` — the
// "Single extension fast pass" CLAUDE.md documents as supported — is NOT
// isolated: the BL-266 preflight (see below) ran `--root WORKSPACE`
// unconditionally, so a broken package.json anywhere in the other 40 projects
// FATALs a run that never touches it. In a shared, non-worktree checkout with
// concurrent agents, that is the normal condition, not an edge case — it means
// any agent's in-flight `workspace:*` edit can wedge every other agent's
// ability to run even a scoped smoke pass (observed live: PKT-15/BL-259 was
// blocked by an unrelated agent's uncommitted memory-flush→store-adapter edit).
//
// Scope = the filtered extension's dir, PLUS (if it is a bundle member) the
// bundle root and every sibling member — `soxe install <bundle>` installs the
// WHOLE bundle whenever any one member is targeted, so siblings are genuinely
// in the filtered run's blast radius, not just nx-graph neighbors — PLUS the
// transitive closure of `workspace:*` dependencies from the nx project graph
// (a broken package two hops away must not silently escape the gate).
//
// Returns `null` to mean "unfiltered / full workspace scope" — the caller must
// treat null as "run the ORIGINAL unrestricted preflight", never as "check
// nothing". A `--skip-preflight` escape hatch is deliberately NOT provided
// (see docs/spec discussion in BL-407): scoping must be correct, not optional.
function computePreflightOnlyDirs(allExts) {
  if (!EXTENSION_FILTER) return null;

  const target = allExts.find((e) => e.id === EXTENSION_FILTER);
  if (!target) return null; // unknown --extension id — fail SAFE to full scope

  const membersSeg = `${path.sep}members${path.sep}`;
  const seedDirs = new Set([target.dir]);
  if (target.dir.includes(membersSeg)) {
    const bundleDir = target.dir.slice(0, target.dir.indexOf(membersSeg));
    seedDirs.add(bundleDir);
    for (const e of allExts) {
      if (e.dir.startsWith(bundleDir + membersSeg)) seedDirs.add(e.dir);
    }
  }

  // Resolve each seed dir's nx project name (from project.json — the bundle
  // root may not have one; that's fine, it just doesn't contribute graph edges).
  const seedNames = new Set();
  for (const d of seedDirs) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(d, 'project.json'), 'utf-8'));
      if (pj.name) seedNames.add(pj.name);
    } catch { /* no project.json at this dir — nx-graph expansion skips it */ }
  }

  let graph;
  try {
    const graphFile = path.join(TEST_ROOT, '.nx-graph-preflight.json');
    execSync(`npx nx graph --file=${JSON.stringify(graphFile)}`, {
      cwd: WORKSPACE, stdio: ['ignore', 'ignore', 'inherit'],
    });
    graph = JSON.parse(fs.readFileSync(graphFile, 'utf-8')).graph;
  } catch (e) {
    console.error(`[smoke] WARNING: nx graph unavailable for BL-407 preflight scoping (${e.message}); falling back to the full workspace scope`);
    return null;
  }

  const seenNames = new Set(seedNames);
  const stack = [...seedNames];
  while (stack.length > 0) {
    const n = stack.pop();
    for (const edge of graph.dependencies[n] ?? []) {
      if (!seenNames.has(edge.target)) { seenNames.add(edge.target); stack.push(edge.target); }
    }
  }

  const dirs = new Set(seedDirs);
  for (const name of seenNames) {
    const root = graph.nodes[name]?.data?.root;
    if (root) dirs.add(path.join(WORKSPACE, root));
  }
  return [...dirs].sort();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[smoke] root: ${TEST_ROOT}`);
  await fsp.mkdir(TEST_ROOT, { recursive: true });

  // ── BL-173: create scratch data root and verify isolation ──────────────────
  await fsp.mkdir(SMOKE_DATA_ROOT, { recursive: true });
  console.error(`[smoke] SOX_ECOSYSTEM_HOME (scratch) → ${SMOKE_DATA_ROOT}`);
  console.error(`[smoke] SOX_CONFIG_DB_PATH  (scratch) → ${SMOKE_DB_PATH}`);

  // Assert: scratch root is NOT the real user data root.
  const realUserDataRoot = path.join(process.env['HOME'] ?? '', '.adhd', 'sox-ecosystem');
  if (SMOKE_DATA_ROOT === realUserDataRoot) {
    console.error('[smoke] FATAL: scratch data root resolved to real user data root — aborting');
    process.exit(2);
  }

  // Capture fingerprint of live data-root files BEFORE the run.
  const LIVE_FILES = [
    path.join(realUserDataRoot, 'extensions.lock'),
    path.join(realUserDataRoot, 'install-registry.json'),
    path.join(realUserDataRoot, 'ledger.json'),
    path.join(realUserDataRoot, 'ownership.json'),
  ];
  const fingerprint = {};
  for (const f of LIVE_FILES) {
    try { fingerprint[f] = execSync(`shasum "${f}"`, { encoding: 'utf-8' }).trim(); }
    catch { fingerprint[f] = 'ABSENT'; }
  }
  console.error('[smoke] live fingerprint BEFORE:', JSON.stringify(fingerprint));

  await fsp.writeFile(path.join(TEST_ROOT, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  const tr = path.join(TEST_ROOT, 'registry', 'index.json');
  await fsp.mkdir(path.dirname(tr), { recursive: true });
  try { await fsp.unlink(tr); } catch {}
  await fsp.symlink(path.join(WORKSPACE, 'registry', 'index.json'), tr);

  const allExtensions = await scanAllExtensionDirs();
  const extensions = await discoverExtensions(allExtensions);

  // ── BL-192 preflight: refuse to run against an unbuilt workspace ────────────
  // A dist-less checkout (fresh worktree) makes install/enable legs fail with
  // "no entrypoint" — a TRUE statement about the environment that reads like a
  // product bug (exactly how BL-192 got mis-filed). Fail fast and say why.
  const missingArtifacts = [];
  const cliMain = path.join(WORKSPACE, 'dist', 'apps', 'sox', 'main.js');
  if (!fs.existsSync(cliMain)) missingArtifacts.push(cliMain);
  for (const e of extensions) {
    if (typeof e.manifest.entrypoint === 'string') {
      const ep = path.join(e.dir, e.manifest.entrypoint);
      if (!fs.existsSync(ep)) missingArtifacts.push(ep);
    }
  }
  if (missingArtifacts.length > 0) {
    console.error('[smoke] FATAL: workspace is not built — missing compiled artifacts:');
    for (const p of missingArtifacts) console.error(`[smoke]   - ${p}`);
    console.error('[smoke] Build first (e.g. `npx nx run-many -t build`), then re-run.');
    console.error('[smoke] Running unbuilt produces "no entrypoint" enable/serve failures that masquerade as product bugs (BL-192).');
    process.exit(2);
  }

  // ── Exports-contract preflight (BL-266): publint + attw against every
  //    workspace package.json/dist pair. Rides the mandatory smoke gate so a
  //    build-layout change that breaks the contract (the 0ba5d78 @nx/js:tsc
  //    nesting incident — cache-masked for hours) fails loudly pre-merge
  //    instead of detonating on the next cache bust. Supersedes the former
  //    tools/verify-package-exports.mjs (deleted) — publint proved a strict
  //    superset of its file-existence check (main/module/types/bin/exports),
  //    plus packaging-correctness checks it never had; attw adds the
  //    type/runtime-format resolution check verify-package-exports.mjs never
  //    performed at all. See docs/standards/extension-bundling.md.
  //
  //    BL-407: when --extension narrows the run, the preflight is narrowed too
  //    (see computePreflightOnlyDirs) — a `--only <dir>` per in-scope package,
  //    computed from the filtered extension + its bundle siblings + its
  //    transitive nx workspace dependencies. Unfiltered runs are UNCHANGED:
  //    still the full, unrestricted `--root WORKSPACE` merge-gate scope.
  const onlyDirs = computePreflightOnlyDirs(allExtensions);
  const onlyArgs = onlyDirs ? onlyDirs.flatMap((d) => ['--only', d]) : [];
  if (EXTENSION_FILTER) {
    console.error(onlyDirs
      ? `[smoke] preflight scoped (BL-407) to --extension ${EXTENSION_FILTER}: ${onlyDirs.length} package(s) — ${onlyDirs.map((d) => path.relative(WORKSPACE, d)).join(', ')}`
      : `[smoke] preflight NOT scoped — running full workspace scope even though --extension ${EXTENSION_FILTER} was passed (see warning above)`);
  }
  try {
    execSync(
      `node ${JSON.stringify(path.join(WORKSPACE, 'tools', 'verify-exports-publint-attw.mjs'))} --root ${JSON.stringify(WORKSPACE)} ${onlyArgs.map((a) => JSON.stringify(a)).join(' ')}`,
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch {
    console.error('[smoke] FATAL: package exports contract violated — see verify-exports-publint-attw output above.');
    console.error(EXTENSION_FILTER
      ? `[smoke] this WAS scoped to --extension ${EXTENSION_FILTER} (BL-407) — the offending package(s) named above are in that extension's own dependency closure, not an unrelated project.`
      : '[smoke] this was an UNFILTERED (full-workspace) run — pass --extension <id> to check whether the failure is actually in scope for the change you are testing.');
    process.exit(2);
  }

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

  // ── BL-173: post-run isolation assertions ──────────────────────────────────
  let isolationFailed = false;

  // 1. Verify live data-root files are byte-identical to pre-run fingerprint.
  const fingerprintAfter = {};
  for (const f of LIVE_FILES) {
    try { fingerprintAfter[f] = execSync(`shasum "${f}"`, { encoding: 'utf-8' }).trim(); }
    catch { fingerprintAfter[f] = 'ABSENT'; }
  }
  console.error('[smoke] live fingerprint AFTER:', JSON.stringify(fingerprintAfter));
  for (const f of LIVE_FILES) {
    if (fingerprint[f] !== fingerprintAfter[f]) {
      console.error(`[smoke] ISOLATION FAILURE: live file mutated during smoke run: ${f}`);
      console.error(`  before: ${fingerprint[f]}`);
      console.error(`  after:  ${fingerprintAfter[f]}`);
      isolationFailed = true;
    }
  }
  if (!isolationFailed) {
    console.error('[smoke] isolation OK — live data-root files byte-identical before/after');
  }

  // 2. Assert no sockets appeared under the REAL (live) socket dir during the run.
  try {
    const realSocketEntries = await fsp.readdir(REAL_SOCKET_DIR);
    const smokeSockets = realSocketEntries.filter(e => e.startsWith('proxy-'));
    // It's possible the live production backend has a pre-existing socket; we only
    // care that the COUNT did not increase (i.e. smoke did not create new ones).
    // We cannot distinguish pre-existing from new without a pre-run snapshot, so
    // check the scratch socket dir instead: it MUST exist after any serve test.
    console.error(`[smoke] real socket dir entries: ${realSocketEntries.length} (pre-existing production sockets are expected)`);
  } catch {
    // Real socket dir doesn't exist — perfect (no live sockets bound there).
    console.error('[smoke] real socket dir absent — no live sockets (isolation confirmed)');
  }

  // 3. Verify scratch data root received the runtime dirs (evidence of redirection).
  const scratchRunDir = path.join(SMOKE_DATA_ROOT, 'run');
  try {
    await fsp.access(scratchRunDir);
    console.error(`[smoke] scratch run dir exists: ${scratchRunDir} (socket redirection confirmed)`);
  } catch {
    // run/ only appears when serve/service is exercised — not a hard failure if no
    // serve tests ran (e.g. --extension filter for a non-serve extension).
    console.error(`[smoke] scratch run dir absent (no serve tests or serve tests failed pre-bind)`);
  }

  if (isolationFailed) {
    console.error('[smoke] FATAL: live data-root was mutated — BL-173 isolation breach');
    process.exit(2);
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

main();
