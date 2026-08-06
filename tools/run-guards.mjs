#!/usr/bin/env node
/**
 * tools/run-guards.mjs — BL-466: wires the `tools/test-bl*.mjs` regression guards
 * (tools/guards-manifest.mjs) to a real trigger (pre-commit hook, nx targets, CI).
 *
 * See SPEC-BL-466.md for the full design and rulings. Summary of the contract:
 *
 *   --tier1                 run Tier 1 (hermetic) guards. Default mode is FILTERED: only guards
 *                            whose `watch` globs (or own script path) intersect the changed-file
 *                            set are run; everything else is reported NOT_APPLICABLE (non-blocking).
 *   --tier2                 run Tier 2 (dist-dependent) guards.
 *   --all                    disable Tier 1 filtering — run every Tier 1 guard unconditionally.
 *   --isolate-worktree       (Tier 2 only) build deps + run isolable guards inside a disposable
 *                            `.worktrees/guards-tier2-<pid>-<iso8601>` worktree, torn down on exit.
 *                            bl231 (isolable:false) is ALWAYS run in place regardless of this flag.
 *   --keep                   (with --isolate-worktree) do not remove the worktree on exit.
 *   --allow-skip             a runner-level SKIP does not fail the exit code (mirrors bl266/bl469).
 *   --base <ref> --head <ref>
 *                            compute the changed-file set from `git diff --name-only <base> <head>`
 *                            instead of `git diff --cached --name-only` (CI context).
 *   --manifest <path>        override the guards manifest module (testing only — BL-466-g fixture).
 *   --cwd <dir>              run git/guard invocations rooted at <dir> instead of process.cwd()
 *                            (testing only).
 *
 * Tri-state + NOT_APPLICABLE contract (BL-466-d, BL-466-g, extends BL-469):
 *   PASS            guard process ran, exit 0.
 *   FAIL            guard process ran, exit non-zero.
 *   SKIP            the runner chose not to execute the guard's process at all, even though it was
 *                   in scope (e.g. a Tier 2 `needsBuild` dependency failed to build first). Blocks
 *                   the exit code unless --allow-skip.
 *   N/A             the guard was filtered OUT of scope entirely (Tier 1, unfiltered-diff, --all
 *                   not passed, no watched file changed). Never blocks the exit code.
 *
 * Exit code: non-zero if any FAIL. Non-zero if any SKIP unless --allow-skip. Zero otherwise.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(TOOLS_DIR, '..');

// --------------------------------------------------------------------------------------------
// Arg parsing
// --------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    tier1: argv.includes('--tier1'),
    tier2: argv.includes('--tier2'),
    all: argv.includes('--all'),
    isolateWorktree: argv.includes('--isolate-worktree'),
    keep: argv.includes('--keep'),
    allowSkip: argv.includes('--allow-skip'),
  };
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  args.base = flagVal('--base');
  args.head = flagVal('--head');
  args.manifest = flagVal('--manifest');
  args.cwd = flagVal('--cwd');
  return args;
}

// BL-479 — strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR so every git call
// below resolves purely via -C/cwd as intended, never via an ambient env var left set by whatever
// invoked this process (the exact mechanism that let a scratch-fixture guard corrupt the real
// checkout's index — see BL-479).
const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;

const args = parseArgs(process.argv.slice(2));
const REPO_ROOT = args.cwd ? path.resolve(args.cwd) : DEFAULT_REPO_ROOT;

if (!args.tier1 && !args.tier2) {
  console.error('usage: node tools/run-guards.mjs (--tier1 | --tier2) [--all] [--isolate-worktree] [--keep] [--allow-skip] [--base <ref> --head <ref>] [--manifest <path>] [--cwd <dir>]');
  process.exit(2);
}

// --------------------------------------------------------------------------------------------
// Manifest loading
// --------------------------------------------------------------------------------------------
async function loadManifest() {
  const manifestPath = args.manifest
    ? path.resolve(args.manifest)
    : path.join(TOOLS_DIR, 'guards-manifest.mjs');
  const mod = await import(pathToFileURL(manifestPath).href);
  return mod.GUARDS;
}

function resolveScript(guard, root = REPO_ROOT) {
  // BL-466 bug fix: a Tier 2 guard run inside an isolated worktree must be invoked from THAT
  // worktree's own copy of the script — the script's internal root-resolution (e.g.
  // `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` in bl214/bl313) is
  // derived from the script FILE's own location, not from `cwd`. Resolving against REPO_ROOT
  // unconditionally (the invoking checkout) made a Tier 2 guard run in an isolated worktree look
  // for prebuilt dist/ in the wrong checkout — the one that was never built — and fail for a
  // reason that had nothing to do with the guard's own assertions.
  return path.isAbsolute(guard.script) ? guard.script : path.join(root, 'tools', guard.script);
}

// --------------------------------------------------------------------------------------------
// Changed-file set (for Tier 1 filtering)
// --------------------------------------------------------------------------------------------
function getChangedFiles() {
  try {
    if (args.base && args.head) {
      const out = execFileSync('git', ['-C', REPO_ROOT, 'diff', '--name-only', args.base, args.head], {
        encoding: 'utf8',
        env: SAFE_GIT_ENV,
      });
      return out.split('\n').filter(Boolean);
    }
    const out = execFileSync('git', ['-C', REPO_ROOT, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      env: SAFE_GIT_ENV,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function guardWatchSet(guard) {
  const watch = [...(guard.watch || [])];
  // A guard editing its own script always runs — but only meaningfully for repo-relative
  // scripts; fixture manifests (BL-466-g) use absolute paths and opt out of this by construction.
  if (!path.isAbsolute(guard.script)) {
    watch.push(path.posix.join('tools', guard.script));
  }
  return watch;
}

function matchesDiff(guard, changedFiles) {
  const watch = guardWatchSet(guard);
  return changedFiles.some((f) => watch.some((w) => f === w || f.startsWith(w.replace(/\/$/, '') + '/')));
}

// --------------------------------------------------------------------------------------------
// Guard execution
// --------------------------------------------------------------------------------------------
function runGuardProcess(guard, { cwd, extraArgs = [] } = {}) {
  const script = resolveScript(guard, cwd || REPO_ROOT);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: cwd || REPO_ROOT,
    encoding: 'utf8',
  });
  const ms = Date.now() - t0;
  const status = res.status === 0 ? 'PASS' : 'FAIL';
  return { status, ms, stdout: res.stdout || '', stderr: res.stderr || '', exit: res.status };
}

const results = []; // { id, status, ms, detail }

function record(id, status, detail, ms = 0) {
  results.push({ id, status, detail, ms });
  const msStr = ms ? ` (${ms}ms)` : '';
  console.log(`[${status}] ${id} — ${detail}${msStr}`);
}

// --------------------------------------------------------------------------------------------
// Tier 1
// --------------------------------------------------------------------------------------------
async function runTier1(GUARDS) {
  const tier1 = GUARDS.filter((g) => g.tier === 1);
  const changedFiles = args.all ? null : getChangedFiles();

  for (const guard of tier1) {
    if (!args.all) {
      if (!matchesDiff(guard, changedFiles)) {
        record(guard.id, 'N/A', 'not in scope — no watched file changed', 0);
        continue;
      }
    }
    const { status, ms, exit } = runGuardProcess(guard);
    record(guard.id, status, status === 'PASS' ? 'ran, exit 0' : `ran, exit ${exit}`, ms);
  }
}

// --------------------------------------------------------------------------------------------
// Tier 2
// --------------------------------------------------------------------------------------------
function nxBuild(depName, cwd) {
  const t0 = Date.now();
  const res = spawnSync('npx', ['nx', 'build', depName], { cwd, encoding: 'utf8' });
  const ms = Date.now() - t0;
  return { ok: res.status === 0, ms, stderr: res.stderr || '', stdout: res.stdout || '' };
}

function iso8601() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Derive bl266's driver args for real from memory-server's own build command (Decision 6). */
function buildBl266Args(cwd) {
  const memberRoot = path.join(
    cwd,
    'extensions/bundles/sox-memory-bundle/members/memory-server',
  );
  const projectJsonPath = path.join(memberRoot, 'project.json');
  const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  const buildCmd = projectJson.targets.build.options.commands[0];
  const externalsMatch = [...buildCmd.matchAll(/--external\s+(\S+)/g)].map((m) => m[1]);
  const outdir = path.join(memberRoot, 'dist');
  return [
    '--outdir', outdir,
    '--externals', externalsMatch.join(','),
    '--build-cmd', buildCmd,
    '--source', path.join(memberRoot, 'src/index.ts'),
    '--rebuild-cmd', buildCmd,
  ];
}

async function runTier2(GUARDS) {
  const tier2 = GUARDS.filter((g) => g.tier === 2);
  const isolable = tier2.filter((g) => g.isolable !== false);
  const nonIsolable = tier2.filter((g) => g.isolable === false);

  let worktreeDir = null;
  const runCwdFor = (guard) => (guard.isolable === false ? REPO_ROOT : (worktreeDir || REPO_ROOT));

  if (args.isolateWorktree) {
    const branch = `guards-tier2-${process.pid}-${iso8601()}`;
    worktreeDir = path.join(REPO_ROOT, '.worktrees', branch);
    fs.mkdirSync(path.join(REPO_ROOT, '.worktrees'), { recursive: true });
    console.log(`[INFO] creating isolated worktree ${worktreeDir}`);
    const addRes = spawnSync('git', ['worktree', 'add', worktreeDir, '-b', branch, 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: SAFE_GIT_ENV,
    });
    if (addRes.status !== 0) {
      console.error(`[FAIL] worktree setup — ${addRes.stderr}`);
      for (const g of tier2) record(g.id, 'SKIP', 'worktree setup failed', 0);
      finishAndExit();
      return;
    }
    console.log('[INFO] pnpm install in isolated worktree');
    const installRes = spawnSync('pnpm', ['install'], { cwd: worktreeDir, encoding: 'utf8' });
    if (installRes.status !== 0) {
      console.error(`[FAIL] pnpm install in worktree — ${installRes.stderr}`);
      for (const g of tier2) record(g.id, 'SKIP', 'worktree pnpm install failed', 0);
      teardownWorktree(worktreeDir);
      finishAndExit();
      return;
    }
  }

  // Build each unique dep exactly once, per the cwd it will actually be consumed from.
  const depFailed = new Set(); // `${cwd}::${dep}` marked failed
  async function ensureBuilt(dep, cwd) {
    const key = `${cwd}::${dep}`;
    if (ensureBuilt._done?.has(key)) return !depFailed.has(key);
    ensureBuilt._done = ensureBuilt._done || new Set();
    ensureBuilt._done.add(key);
    console.log(`[INFO] nx build ${dep} (cwd=${cwd})`);
    const { ok, ms, stderr } = nxBuild(dep, cwd);
    if (!ok) {
      depFailed.add(key);
      console.error(`[FAIL] build ${dep} — ${stderr.split('\n').slice(-5).join(' | ')}`);
    } else {
      console.log(`[INFO] build ${dep} ok (${ms}ms)`);
    }
    return ok;
  }

  for (const guard of tier2) {
    const cwd = runCwdFor(guard);
    let buildOk = true;
    for (const dep of guard.needsBuild || []) {
      // bl231 never builds — read-only (Decision 4).
      if (guard.id === 'bl231') continue;
      const ok = await ensureBuilt(dep, cwd);
      if (!ok) buildOk = false;
    }
    if (!buildOk) {
      record(guard.id, 'SKIP', 'a needsBuild dependency failed to build', 0);
      continue;
    }
    const extraArgs = guard.driverArgs && guard.id === 'bl266' ? buildBl266Args(cwd) : [];
    const { status, ms, exit } = runGuardProcess(guard, { cwd, extraArgs });
    const isolationNote = guard.id === 'bl231'
      ? 'RAN (shared-checkout, read-only)'
      : guard.isolable === false
        ? 'RAN (shared-checkout, read-only)'
        : args.isolateWorktree
          ? 'RAN (isolated)'
          : 'RAN (in-place)';
    record(
      guard.id,
      status,
      `${isolationNote} — ${status === 'PASS' ? 'exit 0' : `exit ${exit}`}`,
      ms,
    );
  }

  if (worktreeDir && !args.keep) {
    teardownWorktree(worktreeDir);
  } else if (worktreeDir) {
    console.log(`[INFO] --keep passed, leaving worktree at ${worktreeDir}`);
  }
}

function teardownWorktree(worktreeDir) {
  console.log(`[INFO] removing isolated worktree ${worktreeDir}`);
  const res = spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: SAFE_GIT_ENV,
  });
  if (res.status !== 0) {
    console.error(`[WARN] failed to remove worktree ${worktreeDir}: ${res.stderr}`);
  }
}

// --------------------------------------------------------------------------------------------
// Summary + exit
// --------------------------------------------------------------------------------------------
function finishAndExit() {
  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const na = results.filter((r) => r.status === 'N/A').length;
  const ran = passed + failed;

  console.log('');
  console.log(
    `${ran}/${total} guards ran, ${passed} passed, ${failed} failed, ${skipped} skipped, ${na} not-applicable`,
  );

  const shouldFail = failed > 0 || (skipped > 0 && !args.allowSkip);
  process.exit(shouldFail ? 1 : 0);
}

// --------------------------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------------------------
const GUARDS = await loadManifest();

if (args.tier1) {
  await runTier1(GUARDS);
}
if (args.tier2) {
  await runTier2(GUARDS);
}

finishAndExit();
