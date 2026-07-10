#!/usr/bin/env node
/**
 * tools/test-bl222-verify-native-abi.mjs — regression test for BL-222.
 *
 * BL-222: `tools/verify-native-abi.mjs` resolved native-addon probes against
 * REPO_ROOT (derived from its own __dirname). Inside a linked git worktree,
 * that is the WORKTREE's root — which has no node_modules/ at all (gitignored,
 * never installed per-worktree). Every probe fell into the "not installed —
 * optional dep" skip branch, and the script printed "all native addons OK"
 * and exited 0 having verified NOTHING. `git rev-parse --show-toplevel` (the
 * BL-208 fix sketch) is a no-op here — it resolves to the same worktree root
 * as __dirname/.. does.
 *
 * Fixed by resolving the install root via `git rev-parse --git-common-dir`
 * (the shared .git dir — the MAIN checkout's .git even from a linked
 * worktree) and:
 *   (a) redirecting native-addon probes to that root, and
 *   (b) hard-failing (exit 1, loud diagnostic) when even that root has no
 *       install at all, instead of silently skipping every probe.
 *
 * This test builds a fully self-contained synthetic git repo (never touches
 * the real sox-ecosystem checkout or its node_modules) with a copy of the
 * REAL tools/verify-native-abi.mjs, and drives four scenarios:
 *   A. main checkout, package installed            -> exit 0, "ok"
 *   B. main checkout, NO install at all             -> exit 1, loud fail (not skip)
 *   C. linked worktree, main checkout HAS install    -> exit 0, "ok" (resolves
 *      through the worktree to the main checkout's real install — the core
 *      BL-222 fix)
 *   D. linked worktree, main checkout has NO install -> exit 1, loud fail
 *      (not the old silent "all native addons OK")
 *
 * Run: node tools/test-bl222-verify-native-abi.mjs
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SCRIPT = path.join(ROOT, 'tools', 'verify-native-abi.mjs');

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

function sh(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0 && res.error) throw res.error;
  return res;
}

// ── Build a synthetic repo shaped like the probe path the real script uses ──
// (extensions/bundles/sox-memory-bundle/members/memory-server), so the REAL,
// unmodified verify-native-abi.mjs source runs against it unmodified.
function makeSyntheticRepo(root, { installBetterSqlite3 }) {
  fs.mkdirSync(root, { recursive: true });
  sh('git', ['init', '-q'], root);
  sh('git', ['config', 'user.email', 'test@example.com'], root);
  sh('git', ['config', 'user.name', 'test'], root);

  const toolsDir = path.join(root, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(toolsDir, 'verify-native-abi.mjs'));

  const memberDir = path.join(
    root,
    'extensions/bundles/sox-memory-bundle/members/memory-server',
  );
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'package.json'), JSON.stringify({ name: 'memory-server-fixture' }), 'utf8');

  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  sh('git', ['add', '-A'], root);
  sh('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], root);

  if (installBetterSqlite3) {
    // A fake, ABI-agnostic "better-sqlite3" that just loads successfully —
    // enough to exercise the isInstalled()+probe() "ok" path without needing
    // a real native compile. onnxruntime-node is deliberately left absent to
    // also exercise the "skip — optional dep" path in the SAME run, proving
    // that path is preserved distinctly from the "nothing installed" hard-fail.
    const pkgDir = path.join(memberDir, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }), 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    // Root-level pnpm virtual store marker, matching the real repo's layout.
    fs.mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true });
  }
}

function run(scriptCwd) {
  return spawnSync(process.execPath, [path.join(scriptCwd, 'tools', 'verify-native-abi.mjs')], {
    cwd: scriptCwd,
    encoding: 'utf8',
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl222-'));
try {
  console.log('BL-222 — verify-native-abi.mjs worktree install-root resolution\n');

  // ── A. Main checkout, package installed -> ok, exit 0 ──────────────────
  console.log('[A] main checkout, install present');
  const mainInstalled = path.join(TMP, 'main-installed');
  makeSyntheticRepo(mainInstalled, { installBetterSqlite3: true });
  const resA = run(mainInstalled);
  console.log(resA.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'));
  ok(resA.status === 0, `exit 0 (got ${resA.status})`);
  ok(resA.stdout.includes('ok    better-sqlite3'), 'better-sqlite3 probed and reported ok');
  ok(resA.stdout.includes('skip  onnxruntime-node'), 'onnxruntime-node (genuinely absent) still reports skip, not fail');

  // ── B. Main checkout, no install at all -> hard fail, exit 1 ───────────
  console.log('\n[B] main checkout, NO install at all');
  const mainBare = path.join(TMP, 'main-bare');
  makeSyntheticRepo(mainBare, { installBetterSqlite3: false });
  const resB = run(mainBare);
  console.log((resB.stdout + resB.stderr).trim().split('\n').map((l) => '  ' + l).join('\n'));
  ok(resB.status !== 0, `exit non-zero (got ${resB.status}) — the pre-fix script exits 0 here`);
  ok(resB.stderr.includes('no install found at all'), 'stderr explains no install was found');
  ok(!resB.stdout.includes('all native addons OK'), 'does NOT print the false-positive "all native addons OK"');

  // ── C. Linked worktree, main checkout HAS install -> resolves through to
  //      the main checkout and reports ok (the core BL-222 fix) ──────────
  console.log('\n[C] linked worktree off main-installed');
  const worktreeC = path.join(TMP, 'worktree-of-installed');
  sh('git', ['worktree', 'add', '--detach', '-q', worktreeC, 'HEAD'], mainInstalled);
  const resC = run(worktreeC);
  console.log(resC.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'));
  ok(resC.status === 0, `exit 0 (got ${resC.status})`);
  ok(resC.stdout.includes('linked worktree'), 'reports that it detected a linked worktree');
  ok(
    resC.stdout.includes('ok    better-sqlite3'),
    'better-sqlite3 resolved THROUGH the worktree to the main checkout install and reports ok ' +
      '(pre-fix: this printed "skip — not installed" here, a false pass)',
  );

  // ── D. Linked worktree, main checkout has NO install -> hard fail ──────
  console.log('\n[D] linked worktree off main-bare (no install anywhere)');
  const worktreeD = path.join(TMP, 'worktree-of-bare');
  sh('git', ['worktree', 'add', '--detach', '-q', worktreeD, 'HEAD'], mainBare);
  const resD = run(worktreeD);
  console.log((resD.stdout + resD.stderr).trim().split('\n').map((l) => '  ' + l).join('\n'));
  ok(resD.status !== 0, `exit non-zero (got ${resD.status}) — pre-fix this exits 0 with "all native addons OK"`);
  ok(resD.stderr.includes('no install found at all'), 'stderr explains no install was found');
  ok(!resD.stdout.includes('all native addons OK'), 'does NOT print the false-positive "all native addons OK"');
  ok(resD.stderr.includes('linked git worktree'), 'diagnostic mentions this is a worktree, pointing at the real cause');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? '\nBL-222 regression: ALL PASS'
    : `\nBL-222 regression: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
