#!/usr/bin/env node
/**
 * tools/test-run-guards-hook-index-fail-closed.mjs
 *
 * Red->green contract pin for two related run-guards.mjs defects found while fixing fc2735f0:
 *
 *   f1dc4926 (MEDIUM): `getChangedFiles()` stripped GIT_INDEX_FILE (BL-479) and always read the
 *   SHARED `.git/index`. In a pathspec commit the hook hands the process a PRIVATE next-index
 *   (F10) — the shared index can hold another agent's staged paths and miss the paths actually
 *   being committed. The Tier 1 filter therefore ran guards watching the WRONG files.
 *   Fix: honor GIT_INDEX_FILE, but only when it resolves inside the target repo's own git dir —
 *   never blindly, or an unrelated scratch/fixture guard could point run-guards at a foreign
 *   index (the exact hazard BL-479 exists to prevent, from the other direction).
 *
 *   fbdfe55e (MEDIUM): `getChangedFiles()`'s catch block was `catch { return []; }` — untraced
 *   (CLAUDE.md forbids empty catches) and fails OPEN: an empty change set makes every Tier 1
 *   guard read N/A and the hook exits 0 as if everything were fine. Fix: trace the error and
 *   fail CLOSED — non-zero exit, never silently continue as if nothing were staged.
 *
 * This test can run against EITHER the fixed script (green, default) or a copy of the pre-fix
 * script via RUN_GUARDS_SCRIPT_PATH env override, so the same assertions serve as the red->green
 * pin required by BL-225.
 *
 * Usage: node tools/test-run-guards-hook-index-fail-closed.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const RUNNER = process.env.RUN_GUARDS_SCRIPT_PATH
  ? path.resolve(process.env.RUN_GUARDS_SCRIPT_PATH)
  : path.join(TOOLS_DIR, 'run-guards.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;
// See test-fc2735f0-precommit-lint-scope.mjs's identical comment: `git -c key=val` propagates
// via GIT_CONFIG_* env vars to every child git process unless stripped.
for (const key of Object.keys(SAFE_GIT_ENV)) {
  if (/^GIT_CONFIG/.test(key)) delete SAFE_GIT_ENV[key];
}

function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: SAFE_GIT_ENV }).trim();
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// =====================================================================================
// f1dc4926 — staged list under a pathspec commit must be the COMMITTED paths, not the
// shared index's paths.
// =====================================================================================
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f1dc4926-')));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@example.com'], dir);
  sh(['config', 'user.name', 'f1dc4926 test'], dir);

  writeFile(dir, 'libs/x/c.ts', 'export const c = 1;\n');
  writeFile(dir, 'libs/y/d.ts', 'export const d = 1;\n');
  sh(['add', '-A'], dir);
  sh(['commit', '-q', '-m', 'base'], dir);

  // Fixture guard scripts that just record they ran.
  const cGuardScript = path.join(dir, 'guard-c.mjs');
  const dGuardScript = path.join(dir, 'guard-d.mjs');
  const ranLog = path.join(dir, 'ran.log');
  const ranLogJson = JSON.stringify(ranLog);
  fs.writeFileSync(cGuardScript, `import * as fs from 'node:fs'; fs.appendFileSync(${ranLogJson}, 'c\\n'); process.exit(0);\n`);
  fs.writeFileSync(dGuardScript, `import * as fs from 'node:fs'; fs.appendFileSync(${ranLogJson}, 'd\\n'); process.exit(0);\n`);

  const manifestPath = path.join(dir, 'fixture-manifest.mjs');
  fs.writeFileSync(
    manifestPath,
    `export const GUARDS = [
  { id: 'guard-c', tier: 1, script: ${JSON.stringify(cGuardScript)}, watch: ['libs/x/c.ts'] },
  { id: 'guard-d', tier: 1, script: ${JSON.stringify(dGuardScript)}, watch: ['libs/y/d.ts'] },
];
`,
  );

  // The real pre-commit hook: run-guards --tier1, exactly as .husky/pre-commit invokes it, from
  // a hook so git actually sets GIT_INDEX_FILE to a private next-index for the pathspec commit.
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh
set -e
node ${JSON.stringify(RUNNER)} --tier1 --manifest ${JSON.stringify(manifestPath)} --cwd ${JSON.stringify(dir)}
`,
  );
  fs.chmodSync(hookPath, 0o755);

  // Stage BOTH files (simulating "someone else" already having c.ts staged), then commit ONLY d.ts
  // by pathspec — the mandated form (CLAUDE.md).
  writeFile(dir, 'libs/x/c.ts', 'export const c = 2;\n');
  writeFile(dir, 'libs/y/d.ts', 'export const d = 2;\n');
  sh(['add', 'libs/x/c.ts', 'libs/y/d.ts'], dir);

  const res = spawnSync('git', ['commit', '-m', 'pathspec: libs/y/d.ts only', '--', 'libs/y/d.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: SAFE_GIT_ENV,
  });

  const ran = fs.existsSync(ranLog) ? fs.readFileSync(ranLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  report('f1dc4926: pathspec commit itself succeeded', res.status === 0, `exit=${res.status} stderr=${res.stderr}`);
  report(
    'f1dc4926: only the committed guard (guard-d) ran, not guard-c (another agent\'s staged path)',
    ran.includes('d') && !ran.includes('c'),
    JSON.stringify(ran),
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// =====================================================================================
// fbdfe55e — a forced git failure while computing the changed-file set must exit non-zero
// with a traced message, never silently return [] (fail-open, all guards read N/A, exit 0).
// =====================================================================================
{
  // A directory that is NOT a git repo at all: `git -C <dir> diff --cached` fails hard.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fbdfe55e-')));

  const naScript = path.join(dir, 'guard-na.mjs');
  fs.writeFileSync(naScript, `console.log('should never run'); process.exit(0);\n`);
  const manifestPath = path.join(dir, 'fixture-manifest.mjs');
  fs.writeFileSync(
    manifestPath,
    `export const GUARDS = [
  { id: 'guard-na', tier: 1, script: ${JSON.stringify(naScript)}, watch: ['never/matched.ts'] },
];
`,
  );

  const res = spawnSync(
    process.execPath,
    [RUNNER, '--tier1', '--manifest', manifestPath, '--cwd', dir],
    { encoding: 'utf8' },
  );

  report('fbdfe55e: forced git failure exits non-zero (fail closed)', res.status !== 0, `exit=${res.status}`);
  const combined = `${res.stdout || ''}${res.stderr || ''}`;
  report(
    'fbdfe55e: failure is traced — stderr/stdout names the git failure, not silent',
    /git|diff|fatal|not a git repository/i.test(combined),
    combined.slice(0, 400),
  );
  report(
    'fbdfe55e: does NOT silently report the guard as N/A with an all-clear summary',
    !/1\/1 guards ran, 1 passed, 0 failed, 0 skipped, 0 not-applicable/.test(combined) || res.status !== 0,
    combined.slice(-300),
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(
  failed === 0
    ? 'ALL f1dc4926 / fbdfe55e ASSERTIONS PASS'
    : `${failed} f1dc4926/fbdfe55e ASSERTION(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
