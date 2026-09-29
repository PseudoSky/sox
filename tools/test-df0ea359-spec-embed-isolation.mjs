#!/usr/bin/env node
/**
 * tools/test-df0ea359-spec-embed-isolation.mjs
 *
 * BL-df0ea359 acceptance: `bl404-telemetry-composition-root.spec.ts` and
 * `bl401-stages-declared-live.spec.ts` (memory-server) spawn the REAL
 * `src/index.ts` entrypoint via `tsx` to exercise `require.main === module` for
 * real (BL-404/BL-401's whole point). That entrypoint unconditionally fires
 * `warmupEmbed()` on startup (BL-89), which resolves the real fastembed backend
 * and can spawn a real embedding-host CHILD PROCESS. Before this fix, both specs
 * spread the CALLING process's `process.env` verbatim into that spawn (only
 * overriding `SOX_ECOSYSTEM_HOME`), so `libs/memory-core/src/embed.ts`'s
 * `resolveConfig()` fell through to `homedir()`/`XDG_CACHE_HOME` and the spawned
 * host ran with the OPERATOR's real `HOME` and `--cache-dir=<home>/.cache/sox/models`
 * — observed live: pids 21798/21856/22069 with `HOME=/Users/nix`.
 *
 * Two independent checks, both required:
 *
 *   1. STRUCTURAL (static, source-level): both spec files must build their
 *      spawn env via `buildScratchEmbedEnv()` from
 *      `test-support/bl-df0ea359-embed-host-isolation.ts`, spawn through
 *      `spawnRealEntrypoint()` (own process group), stop the whole tree via
 *      `teardownRealEntrypoint()` and ASSERT the report via `assertCleanTeardown()`
 *      — and must NOT still contain the pre-fix `{ ...process.env,
 *      SOX_ECOSYSTEM_HOME: ... }` spawn-env pattern or a wrapper-only
 *      `child.kill('SIGKILL')` (the tsx wrapper does not relay SIGKILL, which
 *      orphaned the real memory-server grandchild to ppid 1). Run with
 *      `--ref <gitref>` to check the spec files AT THAT REF instead of on disk.
 *
 *   2. DYNAMIC (real code, real fallback env): actually calls the real
 *      `buildScratchEmbedEnv()` (via `node --import tsx`, never re-implemented)
 *      with an operator-shaped env (`HOME=/Users/nix`, no `XDG_CACHE_HOME`/
 *      `SOX_EMBED_CACHE_DIR` set) and asserts the resulting env's `HOME` and
 *      `SOX_EMBED_CACHE_DIR` are scratch paths, never the operator's real
 *      `~/.cache/sox/models`.
 *
 * Usage:
 *   node tools/test-df0ea359-spec-embed-isolation.mjs                  # GREEN: checks the working tree
 *   node tools/test-df0ea359-spec-embed-isolation.mjs --ref 80261908   # RED: the pinned pre-fix base
 * Exit 0 iff every check for the checked ref passes.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MEMBER_DIR = 'extensions/bundles/sox-memory-bundle/members/memory-server/src';
// BL-7e5be7e8: the operator-store-env scrub spec SIGTERMs the real entrypoint too, so it is held
// to the same whole-tree teardown contract (no wrapper-only SIGKILL, asserted clean teardown).
// BL-26291f21 (section 1c below) covers the in-process real-backend project, which spawns its
// embed host from inside the vitest worker rather than through a tsx child.
const SPEC_RELPATHS = [
  `${MEMBER_DIR}/bl404-telemetry-composition-root.spec.ts`,
  `${MEMBER_DIR}/bl401-stages-declared-live.spec.ts`,
  `${MEMBER_DIR}/bl-7e5be7e8-operator-store-env-scrub.spec.ts`,
];
const HELPER_RELPATH = `${MEMBER_DIR}/test-support/bl-df0ea359-embed-host-isolation.ts`;

const refArg = process.argv.indexOf('--ref');
const ref = refArg !== -1 ? process.argv[refArg + 1] : null;

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' — ' + String(detail) : ''}`);
  if (!ok) failed++;
}

/** Read a repo-relative file either from disk (ref === null) or from `git show <ref>:<path>`. */
function readAtRef(relPath) {
  if (ref === null) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  }
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // A path absent at that ref (e.g. the helper module itself, pre-fix) reads as null; anything
    // else (bad ref, git failure) is traced so a broken probe is never mistaken for a RED.
    console.error(`[TRACE] git show ${ref}:${relPath} failed: ${String(err?.stderr ?? err).trim()}`);
    return null;
  }
}

// ── 1. Structural checks ────────────────────────────────────────────────────
for (const specRel of SPEC_RELPATHS) {
  const label = path.basename(specRel);
  const src = readAtRef(specRel);
  if (src === null) {
    report(`${label} exists at ${ref ?? 'HEAD'}`, false, 'file not found');
    continue;
  }
  const importsHelper = /from ['"]\.\/test-support\/bl-df0ea359-embed-host-isolation\.js['"]/.test(src);
  const usesBuildEnv = /buildScratchEmbedEnv\(/.test(src);
  const usesSpawn = /spawnRealEntrypoint\(/.test(src);
  const usesTeardown = /teardownRealEntrypoint\(/.test(src);
  const assertsTeardown = /assertCleanTeardown\(/.test(src);
  const wrapperOnlyKill = /child\.kill\(\s*['"]SIGKILL['"]\s*\)/.test(src);
  // The exact pre-fix pattern this BL replaces: spreading the caller's own
  // process.env into the spawn env with only SOX_ECOSYSTEM_HOME overridden —
  // this is what let the operator's real HOME/cache leak through.
  const usesPreFixRawSpread = /\{\s*\.\.\.process\.env,\s*SOX_ECOSYSTEM_HOME:/.test(src);

  report(`${label}: imports the scratch-embed isolation helper`, importsHelper);
  report(`${label}: builds its spawn env via buildScratchEmbedEnv()`, usesBuildEnv);
  report(`${label}: spawns via spawnRealEntrypoint() (own process group)`, usesSpawn);
  report(`${label}: stops the whole tree via teardownRealEntrypoint()`, usesTeardown);
  report(`${label}: asserts the teardown report via assertCleanTeardown()`, assertsTeardown);
  report(`${label}: no wrapper-only child.kill('SIGKILL') teardown`, !wrapperOnlyKill);
  report(`${label}: pre-fix raw process.env spawn-env pattern is gone`, !usesPreFixRawSpread);
}

// ── 1b. Helper structural checks: group spawn + group signal + fail-closed ps ──
{
  const helperSrc = readAtRef(HELPER_RELPATH);
  if (helperSrc === null) {
    report(`helper module exists at ${ref ?? 'HEAD'}`, false, HELPER_RELPATH);
  } else {
    report('helper spawns the entrypoint detached (own process group)', /detached:\s*true/.test(helperSrc));
    report('helper signals the whole process group (process.kill(-pgid, ...))', /process\.kill\(\s*-\s*\w+/.test(helperSrc));
    report('helper reads the process table with portable `ps -axww` (no BSD-only -E)', /'-axww'/.test(helperSrc) && !/-axEww/.test(helperSrc));
    report('helper fails closed on a ps failure (checks spawnSync error/status)', /out\.error !== undefined/.test(helperSrc) && /out\.status !== 0/.test(helperSrc));
    // BL-7e5be7e8: one scrub list for every harness — the helper must use the shared
    // scrubOperatorStoreEnv(), never a hand-maintained subset of `delete env[...]` lines.
    report('helper strips operator store config via the shared scrubOperatorStoreEnv()', /scrubOperatorStoreEnv\(env\)/.test(helperSrc));
  }
}

// ── 1c. BL-26291f21: the in-process real-backend project must not reach operator embed paths ──
//    The three 'real-backend' vitest files embed for real INSIDE a fork worker (no tsx spawn, so
//    sections 1/1b never saw them); with nothing pinning the worker env, memory-core resolved
//    ~/.cache/sox/models and the funnel bound ~/.adhd/sox-ecosystem/run/proxy-*.sock. The harness
//    now mints a run-scoped scratch root (vitest.global-embed-scratch.ts), every worker fails fast
//    if its embed paths escape it (vitest.setup.ts), and the files gate on the shared
//    isRealModelCached() instead of a re-derived `.../sox-memory/models` path (the gate/load split).
{
  const MEMBER_ROOT = 'extensions/bundles/sox-memory-bundle/members/memory-server';
  const REAL_BACKEND_RELPATHS = ['recall-sqlite.test.ts', 'turso-clean-room.test.ts', 'clustering-e2e.test.ts'].map((f) => `${MEMBER_ROOT}/${f}`);
  const cfg = readAtRef(`${MEMBER_ROOT}/vitest.config.ts`);
  report(
    'BL-26291f21: vitest.config.ts registers vitest.global-embed-scratch.ts as a globalSetup',
    cfg !== null && /globalSetup:[\s\S]*vitest\.global-embed-scratch\.ts/.test(cfg),
  );
  const gs = readAtRef(`${MEMBER_ROOT}/vitest.global-embed-scratch.ts`);
  report(
    'BL-26291f21: global setup pins SOX_EMBED_CACHE_DIR + XDG_CACHE_HOME + SOX_ECOSYSTEM_HOME into the worker env',
    gs !== null &&
      /process\.env\['SOX_EMBED_CACHE_DIR'\]\s*=/.test(gs) &&
      /process\.env\['XDG_CACHE_HOME'\]\s*=/.test(gs) &&
      /process\.env\['SOX_ECOSYSTEM_HOME'\]\s*=/.test(gs),
  );
  report(
    'BL-26291f21: global setup seeds by clone (seedModelCache) and reaps run-owned embed hosts (auditAndReapEmbedHosts)',
    gs !== null && /seedModelCache\(/.test(gs) && /auditAndReapEmbedHosts\(/.test(gs),
  );
  const setupSrc = readAtRef(`${MEMBER_ROOT}/vitest.setup.ts`);
  report(
    'BL-26291f21: vitest.setup.ts fails fast via assertEmbedPathsIsolated() at load and afterEach',
    setupSrc !== null && (setupSrc.match(/assertEmbedPathsIsolated\(/g) ?? []).length >= 2,
  );
  const guardSrc = readAtRef(`${MEMBER_ROOT}/src/test-support/bl-26291f21-embed-scratch.ts`);
  report(
    "BL-26291f21: worker guard allowlists exactly <ecosystem home>/sox-tests/logs (BL-404) under the operator root, by exact match",
    guardSrc !== null &&
      /path\.join\(operatorEmbedRoots\(\)\.ecosystemHome, 'sox-tests', 'logs'\)/.test(guardSrc) &&
      /path\.resolve\(telemetryDir\) !== sanctionedOperatorTelemetryDir\(\)/.test(guardSrc),
  );
  for (const rel of REAL_BACKEND_RELPATHS) {
    const src = readAtRef(rel);
    const label = path.basename(rel);
    report(`BL-26291f21: ${label} gates on the shared isRealModelCached()`, src !== null && /isRealModelCached\(\)/.test(src));
    report(
      `BL-26291f21: ${label} no longer re-derives the stale 'sox-memory' model cache path (gate/load mismatch)`,
      src !== null && !/'sox-memory'/.test(src),
    );
  }
}

// ── 2. Dynamic check — only meaningful (and only run) against the working tree,
//    since it needs to actually import+execute the fixed helper module. Skipped
//    entirely for a --ref probe of a commit where the helper doesn't exist yet.
if (ref === null) {
  const helperAbs = path.join(REPO_ROOT, HELPER_RELPATH);
  if (!fs.existsSync(helperAbs)) {
    report('buildScratchEmbedEnv helper module exists', false, `not found at ${HELPER_RELPATH}`);
  } else {
    const probeFile = path.join(os.tmpdir(), `bl-df0ea359-probe-${process.pid}.mjs`);
    const probeSrc = `
import { buildScratchEmbedEnv } from ${JSON.stringify(helperAbs)};
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-df0ea359-dyn-'));
const operatorEnv = {
  ...process.env,
  HOME: '/Users/nix',
  SOX_CONFIG_DB_PATH: '/Users/nix/.memory/memory.db',
  SOX_AUTO_BACKUP_DIR: '/Users/nix/.memory/backups',
  SOX_PROXY_BACKEND: '1',
};
delete operatorEnv.XDG_CACHE_HOME;
delete operatorEnv.SOX_EMBED_CACHE_DIR;
const { env, cacheDir } = buildScratchEmbedEnv(scratch, operatorEnv);
const leakedStoreKeys = ['SOX_CONFIG_DB_PATH', 'SOX_AUTO_BACKUP_DIR', 'SOX_PROXY_BACKEND'].filter((k) => k in env);
process.stdout.write(JSON.stringify({ HOME: env.HOME, SOX_EMBED_CACHE_DIR: env.SOX_EMBED_CACHE_DIR, cacheDir, scratch, leakedStoreKeys }) + '\\n');
fs.rmSync(scratch, { recursive: true, force: true });
`;
    fs.writeFileSync(probeFile, probeSrc);
    try {
      const out = execFileSync('node', ['--import', 'tsx', probeFile], { cwd: REPO_ROOT, encoding: 'utf8' });
      const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
      report('buildScratchEmbedEnv(): env.HOME is not the operator HOME (/Users/nix)', parsed.HOME !== '/Users/nix', parsed.HOME);
      report(
        'buildScratchEmbedEnv(): SOX_EMBED_CACHE_DIR is not the operator default (~/.cache/sox/models)',
        !parsed.SOX_EMBED_CACHE_DIR.includes('/Users/nix/.cache/sox/models'),
        parsed.SOX_EMBED_CACHE_DIR,
      );
      report('buildScratchEmbedEnv(): resolved cacheDir is under the given scratch root', parsed.cacheDir.startsWith(parsed.scratch), parsed.cacheDir);
      report(
        'buildScratchEmbedEnv(): no operator store config survives (SOX_CONFIG_DB_PATH / SOX_AUTO_BACKUP_DIR / SOX_PROXY_BACKEND) [BL-7e5be7e8]',
        parsed.leakedStoreKeys.length === 0,
        JSON.stringify(parsed.leakedStoreKeys),
      );
    } catch (err) {
      report('buildScratchEmbedEnv() dynamic probe ran successfully', false, String(err));
    } finally {
      fs.rmSync(probeFile, { force: true });
    }
  }

  // ── 3. RED self-demonstration — the EXACT pre-fix formula (duplicated here on
  //    purpose, matching embed.ts's resolveConfig() fallback) genuinely resolves
  //    to the operator's real cache dir when HOME is the operator's and no
  //    XDG_CACHE_HOME/SOX_EMBED_CACHE_DIR override is present. This is the
  //    mechanism the structural + dynamic checks above exist to prevent — kept
  //    here as a living demonstration, not gated on pass/fail (the pre-fix
  //    pattern is EXPECTED to leak; that expectation is exactly the bug).
  {
    const operatorHome = process.env.HOME ?? os.homedir();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-df0ea359-redcheck-'));
    const preFixEnv = { HOME: operatorHome, SOX_ECOSYSTEM_HOME: path.join(dir, 'home') }; // the old spec's only override
    const preFixResolvedCacheDir =
      preFixEnv.SOX_EMBED_CACHE_DIR ?? path.join(preFixEnv.XDG_CACHE_HOME ?? path.join(preFixEnv.HOME, '.cache'), 'sox', 'models');
    console.log(
      `[INFO] pre-fix formula would have resolved cache-dir to: ${preFixResolvedCacheDir} (operator HOME: ${operatorHome}) — this is the BL-df0ea359 regression this guard pins.`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} BL-df0ea359 check(s) FAILED${ref ? ` at ref ${ref}` : ''}.`);
  process.exit(1);
}
console.log(`\nAll BL-df0ea359 checks passed${ref ? ` at ref ${ref}` : ''}.`);
