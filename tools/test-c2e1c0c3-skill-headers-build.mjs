#!/usr/bin/env node
/**
 * tools/test-c2e1c0c3-skill-headers-build.mjs
 *
 * c2e1c0c3: the Tier 1 `skill-headers` guard (tools/check-skill-frontmatter.mjs) fails closed when
 * libs/host-registry/dist is missing — by design — but run-guards.mjs never built anything for a
 * Tier 1 guard, so staging any extensions/skills|agents|bundles file in a fresh worktree failed the
 * pre-commit hook. The fix: `needsBuild: ['host-registry']` on the registration, honoured by
 * runTier1 (shared ensureBuilt with Tier 2); a failed build is a FAIL.
 *
 * Unit tests spawn NO real build: the build runner is injected via run-guards `--build-runner`.
 *
 *   AC1  fresh scratch checkout, dist absent, staged SKILL.md -> `run-guards --tier1` exits 0 and
 *        the builder ran first (negative control: same guard WITHOUT needsBuild -> exit 1).
 *   AC3  builder fails -> non-zero, guard process never ran (fail-closed preserved).
 *   AC4  the XML-tag rule is documented in the checker header; its behavior (incl. documented false
 *        positives) is exercised by running check-skill-frontmatter.test.mjs's AC4 test.
 *   (AC2, the manifest-level XML-tag leg, is in tools/check-skill-frontmatter.test.mjs.)
 *   Wiring: the real manifest registers skill-headers with needsBuild ['host-registry'].
 *
 * Usage: node tools/test-c2e1c0c3-skill-headers-build.mjs   (exit 0 iff every assertion holds)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(TOOLS_DIR, 'run-guards.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const GIT_ENV = { ...process.env };
for (const k of Object.keys(GIT_ENV)) {
  if (/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|CONFIG)/.test(k)) delete GIT_ENV[k];
}
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

/** Scratch repo with a staged skill file and a fixture manifest/guard/builder. */
function scenario({ needsBuild, builderOk }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c2e1c0c3-')));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'c2e1c0c3'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-q', '-m', 'base'], dir);

  fs.mkdirSync(path.join(dir, 'extensions/skills/foo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extensions/skills/foo/SKILL.md'), '# foo\n\nbody\n');
  git(['add', 'extensions/skills/foo/SKILL.md'], dir);

  const distMarker = path.join(dir, 'libs/host-registry/dist/index.js');
  const ranLog = path.join(dir, 'guard-ran.log');
  const buildLog = path.join(dir, 'build.log');

  // Stands in for check-skill-frontmatter.mjs: exits 1 unless the renderer dist exists.
  const guard = path.join(dir, 'fixture-guard.mjs');
  fs.writeFileSync(
    guard,
    `import * as fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(ranLog)}, 'ran\\n');
process.exit(fs.existsSync(${JSON.stringify(distMarker)}) ? 0 : 1);
`,
  );
  // Injected build runner: records the dep, creates the dist marker iff builderOk.
  const builder = path.join(dir, 'fixture-builder.mjs');
  fs.writeFileSync(
    builder,
    `import * as fs from 'node:fs';
import * as path from 'node:path';
fs.appendFileSync(${JSON.stringify(buildLog)}, process.argv[2] + '\\n');
if (${builderOk ? 'true' : 'false'}) {
  fs.mkdirSync(path.dirname(${JSON.stringify(distMarker)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(distMarker)}, '');
  process.exit(0);
}
console.error('simulated build failure');
process.exit(1);
`,
  );
  const manifest = path.join(dir, 'fixture-manifest.mjs');
  fs.writeFileSync(
    manifest,
    `export const GUARDS = [{
  id: 'skill-headers', tier: 1, script: ${JSON.stringify(guard)},
  ${needsBuild ? "needsBuild: ['host-registry']," : ''}
  watch: ['extensions/skills/'],
}];
`,
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [RUNNER, '--tier1', '--manifest', manifest, '--cwd', dir, '--build-runner', builder],
      { encoding: 'utf8' },
    );
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, run, builds: () => read(buildLog), guardRuns: () => read(ranLog), distExists: () => fs.existsSync(distMarker) };
}

// AC1 — c2e1c0c3 AC1: dist absent + staged SKILL.md -> builds first, exits 0.
{
  const s = scenario({ needsBuild: true, builderOk: true });
  const before = s.distExists();
  const res = s.run();
  report('c2e1c0c3 AC1: fresh checkout starts with host-registry dist absent', before === false);
  report('c2e1c0c3 AC1: run-guards --tier1 exits 0 with staged SKILL.md', res.status === 0, `exit=${res.status} ${res.stdout}${res.stderr}`);
  report('c2e1c0c3 AC1: host-registry was built (exactly once) before the guard ran', JSON.stringify(s.builds()) === '["host-registry"]' && s.guardRuns().length === 1, JSON.stringify(s.builds()));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

// Negative control (BL-225): same guard, build step removed -> must go RED.
{
  const s = scenario({ needsBuild: false, builderOk: true });
  const res = s.run();
  report('c2e1c0c3 AC1 negative control: without needsBuild the guard fails (exit 1, nothing built)', res.status === 1 && s.builds().length === 0, `exit=${res.status}`);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

// AC3 — c2e1c0c3 AC3: a failing build is fail-closed.
{
  const s = scenario({ needsBuild: true, builderOk: false });
  const res = s.run();
  const out = `${res.stdout}${res.stderr}`;
  report('c2e1c0c3 AC3: failed build exits non-zero', res.status !== 0, `exit=${res.status}`);
  report('c2e1c0c3 AC3: guard process never ran after a failed build', s.guardRuns().length === 0);
  report('c2e1c0c3 AC3: failure is reported as FAIL naming the build', /\[FAIL\] skill-headers/.test(out) && /failed to build/.test(out), out.slice(-300));
  fs.rmSync(s.dir, { recursive: true, force: true });
}

// A guard out of scope must not trigger a build.
{
  const s = scenario({ needsBuild: true, builderOk: true });
  git(['reset', '-q', 'extensions/skills/foo/SKILL.md'], s.dir);
  const res = s.run();
  report('c2e1c0c3: out-of-scope guard (nothing staged) builds nothing and exits 0', res.status === 0 && s.builds().length === 0, `exit=${res.status}`);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

// Wiring: the REAL manifest registers the dependency.
{
  const mod = await import(pathToFileURL(path.join(TOOLS_DIR, 'guards-manifest.mjs')).href);
  const g = mod.GUARDS.find((x) => x.id === 'skill-headers');
  report(
    'c2e1c0c3: real manifest registers skill-headers (tier 1) with needsBuild including host-registry',
    g !== undefined && g.tier === 1 && Array.isArray(g.needsBuild) && g.needsBuild.includes('host-registry'),
  );
}

// AC4 — c2e1c0c3 AC4: the XML-tag rule (and its documented false positives) is documented in the
// checker header (one presence test); its behavior is pinned by check-skill-frontmatter.test.mjs.
{
  const src = fs.readFileSync(path.join(TOOLS_DIR, 'check-skill-frontmatter.mjs'), 'utf8');
  const header = src.slice(0, src.indexOf('import '));
  report(
    'c2e1c0c3 AC4: checker header documents the XML-tag rule, skillcheck parity and false positives',
    /XML-tag rule/.test(header) && /frontmatter\.description\.xml-tags/.test(header) && /Array<string>/.test(header) && /a<b and c>d/.test(header),
  );
  // Behavioral: run the AC4 cases in the checker's own test suite.
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-name-pattern=c2e1c0c3 AC4', path.join(TOOLS_DIR, 'check-skill-frontmatter.test.mjs')],
    { encoding: 'utf8' },
  );
  report(
    'c2e1c0c3 AC4: check-skill-frontmatter.test.mjs AC4 test passes (flags <a|b>, Array<string>, a<b and c>d; not x < 5 / <5)',
    res.status === 0 && /\bpass 1\b/.test(res.stdout) && /\bfail 0\b/.test(res.stdout),
    `exit=${res.status} ${res.stdout.slice(-300)}${res.stderr.slice(-200)}`,
  );
}

process.exit(failed === 0 ? 0 : 1);
