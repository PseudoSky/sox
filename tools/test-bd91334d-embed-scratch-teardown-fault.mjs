#!/usr/bin/env node
/**
 * tools/test-bd91334d-embed-scratch-teardown-fault.mjs
 *
 * Red->green pin for backlog bd91334d: memory-server's
 * `vitest.global-embed-scratch.ts` teardown must FAIL THE RUN (non-zero exit) when it throws or
 * finds a problem, not silently swallow it the way a bare `try { ... } finally { rm -rf root }`
 * did — vitest 4.1.8 catches a thrown globalSetup teardown error, logs it as "error during close",
 * and still exits 0 (same class of bug as BL-bae70da4 / embedding-provider's scratch teardown).
 *
 * Drives the REAL `vitest.global-embed-scratch.ts` file as a `globalSetup` in a throwaway vitest
 * run (one trivial spec, scratch config, own scratch cwd) with the BL-bd91334d test-only injection
 * hook set (`SOX_BL_BD91334D_TEST_INJECT`, see
 * extensions/bundles/sox-memory-bundle/members/memory-server/src/test-support/
 * bl-26291f21-embed-scratch-env.ts). Runs the file IN PLACE (never copied) so its relative imports
 * (`../../../../../scripts/lib/...`) keep resolving.
 *
 * Cases:
 *   a. 'throw'         — the teardown's try body throws mid-audit. Must exit 1, report
 *                         "teardown threw", and keep the scratch root (never rm -rf it while its
 *                         state is unproven).
 *   b. 'force-problem' — a problem is recorded with no throw. Must exit 1, report the injected
 *                         problem text, and ALSO keep the root — the BL-bd91334d "keep on ANY
 *                         problem" policy, not just the old undead/psFailed-only cases.
 *   c. (no injection)  — a clean run. Must exit 0, print "teardown OK", and remove the root.
 *
 * Usage:
 *   node tools/test-bd91334d-embed-scratch-teardown-fault.mjs                     # green
 *   node tools/test-bd91334d-embed-scratch-teardown-fault.mjs --code-root <dir>  # red demo:
 *     <dir> must hold ed0618a8's pre-fix `vitest.global-embed-scratch.ts` (the bare
 *     `try { ... } finally { rm -rf root }` shape, no catch) with the ONE-LINE 'throw' injection
 *     (`if (process.env['SOX_BL_BD91334D_TEST_INJECT'] === 'throw') throw new Error(...)`) added
 *     right after the reap's `say(...)` call, PLUS `<dir>/scripts` symlinked to the repo's real
 *     `scripts/` (the file's relative imports climb 5 levels to `scripts/lib/...`) and the env
 *     module copied to `<dir>/extensions/.../test-support/bl-26291f21-embed-scratch-env.ts`. Case
 *     (a) then fails with `status=0` instead of non-zero — proving the pre-fix bug (vitest exits 0
 *     on a thrown teardown) — while (b) and (c) still pass, since they exercise no injection path
 *     the pre-fix file has any opinion about.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;

const GLOBAL_SETUP = path.join(
  CODE_ROOT,
  'extensions/bundles/sox-memory-bundle/members/memory-server/vitest.global-embed-scratch.ts',
);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

if (!fs.existsSync(GLOBAL_SETUP)) {
  check('bd91334d0: global setup file exists at the expected path', false, GLOBAL_SETUP);
  console.log('FAIL bd91334d: 1 case(s) failed');
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sox-bd91334d-guard-'));
const noopSpec = path.join(scratch, 'noop.spec.ts');
fs.writeFileSync(noopSpec, `import { it, expect } from 'vitest';\nit('noop', () => { expect(1).toBe(1); });\n`);
const cfgPath = path.join(scratch, 'vitest.config.mjs');
fs.writeFileSync(
  cfgPath,
  `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'node_modules/vitest/dist/config.js')).href)};
export default defineConfig({
  test: {
    include: [${JSON.stringify(noopSpec)}],
    globalSetup: [${JSON.stringify(GLOBAL_SETUP)}],
    environment: 'node',
    root: ${JSON.stringify(REPO_ROOT)},
  },
});
`,
);

const KEPT_ROOT_RE = /scratch root kept for inspection: (\/tmp\/sox-ms-\S+)/;
const keptRoots = [];

function run(injectValue) {
  const env = { ...process.env };
  delete env.SOX_MEMSRV_TEST_SCRATCH_ROOT;
  delete env.SOX_MEMSRV_TEST_TELEMETRY_DIR;
  delete env.SOX_MEMSRV_TEST_MODEL_SEEDED;
  if (injectValue !== undefined) env.SOX_BL_BD91334D_TEST_INJECT = injectValue;
  else delete env.SOX_BL_BD91334D_TEST_INJECT;
  const bin = path.join(REPO_ROOT, 'node_modules/.bin/vitest');
  const r = spawnSync(bin, ['run', '--config', cfgPath], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000 });
  const m = KEPT_ROOT_RE.exec(r.stderr ?? '');
  if (m) keptRoots.push(m[1]);
  return r;
}

console.log(`bd91334d — code under test: ${CODE_ROOT}`);

console.log('a. thrown teardown exception fails the run and keeps the root');
{
  const r = run('throw');
  check('a1 bd91334d: exit code is non-zero', r.status !== 0, `status=${r.status} signal=${r.signal}`);
  check('a2 bd91334d: the report names the caught throw', /teardown threw:.*forced teardown exception/.test(r.stderr ?? ''), r.stderr);
  check('a3 bd91334d: the child\'s own test still ran and passed', /1 passed \(1\)/.test(r.stdout ?? ''), r.stdout);
  check('a4 bd91334d: no unhandled "error during close" — the throw was caught, not just swallowed by vitest',
    !/error during close/.test(r.stderr ?? ''), r.stderr);
}

console.log('b. a recorded problem with no throw also fails the run and keeps the root (policy: ANY problem)');
{
  const r = run('force-problem');
  check('b1 bd91334d: exit code is non-zero', r.status !== 0, `status=${r.status}`);
  check('b2 bd91334d: the report names the injected problem', /forced problem, no throw/.test(r.stderr ?? ''), r.stderr);
  check('b3 bd91334d: the root is kept (not silently rm -rf\'d despite no throw)', /leaving scratch root .* in place/.test(r.stderr ?? ''), r.stderr);
}

console.log('c. a clean run exits 0 and removes the root');
{
  const r = run(undefined);
  check('c1 bd91334d: exit code is zero', r.status === 0, `status=${r.status} stderr=${r.stderr}`);
  check('c2 bd91334d: reports teardown OK', /teardown OK: scratch root .* removed, no problems found/.test(r.stderr ?? ''), r.stderr);
}

// Cleanup: the a/b cases deliberately keep their scratch roots (that is the behaviour under test);
// this guard, not the harness, is responsible for removing them once it has asserted on them.
for (const root of keptRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.error(`bd91334d: could not clean up kept scratch root ${root}: ${String(err)}`);
  }
}
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failed === 0 ? 'PASS bd91334d: all cases pass' : `FAIL bd91334d: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
