#!/usr/bin/env node
/**
 * tools/test-scorecard-unreachable-repo.mjs
 *
 * Red->green regression pin for DEBT-HOOK-PLANSTATUS-GATES-EVERY-COMMIT-001 (Task 2):
 * `tools/scorecard.mjs`'s `completionScore()` used to `continue` on ANY `backlog list-items`
 * failure — a bare `catch { continue }` that silently dropped the whole repo from the completion
 * table with zero signal to the reader (the exact same swallow-shape as the maxBuffer incident
 * already documented on `sh()`'s own doc comment, just triggered a different way). A repo whose
 * `backlog` query failed rendered IDENTICALLY to a repo that is genuinely 100% done — the worst
 * failure mode for a health surface (silently reads as "everything is fine").
 *
 * This test does NOT touch the production backlog store. It intercepts ONLY the specific
 * `list-items --filter {repo:"sox-ecosystem",...}` call `completionScore()` makes, via a fake
 * `backlog` shim placed earlier on PATH than the real one; every other invocation (including the
 * `adhd` repo's own completion query, and every other section of scorecard.mjs — backlogScore(),
 * memoryScore(), etc.) execs straight through to the REAL `backlog` binary unmodified, so this is a
 * live end-to-end run of the actual script, not a mocked unit test.
 *
 * GREEN (current code): the intercepted repo appears in `completion.unreachable` with a reason;
 *   the completion table renders a loud "⚠ UNKNOWN" line naming it; `completion.byPkg` contains
 *   NO entries for that repo (so it can never silently read as "0 open, all done").
 * RED (pre-fix shape, reconstructed via source mutation on a scratch copy — same technique
 *   `tools/test-plan-status-graph-source.mjs` already uses for its own swallow-variant RED arm):
 *   the identical fake-`backlog` failure produces NO `unreachable` entry, NO warning, and
 *   `completion.byPkg`/`totals` simply omit the repo with no signal at all.
 *
 * Usage: node tools/test-scorecard-unreachable-repo.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCORECARD_SCRIPT = path.join(HERE, 'scorecard.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const REAL_BACKLOG = execFileSync('which', ['backlog'], { encoding: 'utf8' }).trim();
if (!REAL_BACKLOG) {
  console.log('[SKIP] no `backlog` binary on PATH — cannot construct the pass-through shim; skipping.');
  process.exit(0);
}

/**
 * A `backlog` PATH-shim: intercepts ONLY `list-items --filter {"repo":"sox-ecosystem",...}` (the
 * exact shape `completionScore()` issues) and fails it; execs the REAL backlog for everything else,
 * inheriting argv/stdio/exit code exactly.
 */
function makeInterceptingBacklogShim(dir) {
  const script = path.join(dir, 'backlog');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
const filterIdx = argv.indexOf('--filter');
let isTargetCall = false;
if (argv[0] === 'list-items' && filterIdx !== -1) {
  try {
    const filter = JSON.parse(argv[filterIdx + 1]);
    if (filter.repo === 'sox-ecosystem') isTargetCall = true;
  } catch {
    /* not JSON — fall through to real backlog */
  }
}
if (isTargetCall) {
  process.stderr.write('shim: simulated backlog list-items failure for sox-ecosystem\\n');
  process.exit(1);
}
try {
  const out = execFileSync(${JSON.stringify(REAL_BACKLOG)}, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(out);
} catch (err) {
  if (err.stdout) process.stdout.write(err.stdout);
  process.exit(err.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  return script;
}

function runScorecardJson(backlogShimDir, scriptPath) {
  const r = spawnSync(process.execPath, [scriptPath, '--json'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${backlogShimDir}:${process.env.PATH}` },
    timeout: 150_000,
  });
  if (r.status === null) {
    throw new Error(`scorecard subprocess did not complete: signal=${r.signal} stderr=${r.stderr?.slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(`scorecard --json produced non-JSON stdout: ${err.message}\nstdout(500)=${r.stdout.slice(0, 500)}\nstderr(500)=${r.stderr.slice(0, 500)}`);
  }
  return { parsed, raw: r };
}

// ---------------------------------------------------------------------------------------------
// GREEN — current code
// ---------------------------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-shim-green-'));
  const shim = makeInterceptingBacklogShim(dir);
  try {
    const { parsed } = runScorecardJson(dir, SCORECARD_SCRIPT);
    const unreachable = parsed?.completion?.unreachable ?? [];
    const hit = unreachable.find((u) => u.repo === 'sox-ecosystem');
    report(
      'GREEN: a failed backlog list-items call surfaces in completion.unreachable',
      !!hit,
      `unreachable=${JSON.stringify(unreachable)}`,
    );
    report(
      'GREEN: the failure reason is present and non-empty',
      typeof hit?.reason === 'string' && hit.reason.length > 0,
      `reason=${JSON.stringify(hit?.reason)}`,
    );
    const byPkgKeys = Object.keys(parsed?.completion?.byPkg ?? {});
    const leakedSoxEcosystemRows = byPkgKeys.filter((k) => k.startsWith('sox-ecosystem:'));
    report(
      'GREEN: the failed repo contributes ZERO rows to byPkg (never silently "0 open, all done")',
      leakedSoxEcosystemRows.length === 0,
      `byPkg keys for sox-ecosystem: ${JSON.stringify(leakedSoxEcosystemRows)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// RED — reconstruct the pre-fix swallow shape via source mutation on a scratch copy, same
// technique tools/test-plan-status-graph-source.mjs already uses for its own RED arm.
// ---------------------------------------------------------------------------------------------
{
  const src = fs.readFileSync(SCORECARD_SCRIPT, 'utf8');
  // Replace the whole hardened try/catch body with the original bare "catch { continue }" shape —
  // matched structurally (from `let sawArrayLine` through the closing of the outer try/catch),
  // rather than by exact old text, so this stays robust to comment-only edits.
  const redSrc = src.replace(
    /let sawArrayLine = false;\s*\n\s*try \{[\s\S]*?\n\s*} catch \(err\) \{\s*\n\s*unreachable\.push\([\s\S]*?\}\);\s*\n\s*continue;\s*\n\s*\}/,
    `try {
      const out = sh('backlog', ['list-items', '--filter', JSON.stringify({ repo, limit: 900 })], {
        timeout: 120_000,
      });
      for (const line of out.split('\\n')) {
        try {
          const j = JSON.parse(line);
          if (Array.isArray(j)) items = j;
        } catch {
          /* pino line */
        }
      }
    } catch {
      continue; // [RED-ARM INJECTION] pre-fix bare swallow, must never ship
    }`,
  );
  if (redSrc === src) {
    report('RED arm — able to construct the pre-fix swallow variant', false, 'regex did not match scorecard.mjs source — script structure changed, update the RED-arm regex');
  } else {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-red-'));
    const scratchScript = path.join(scratchDir, 'scorecard.mjs');
    fs.writeFileSync(scratchScript, redSrc);
    // The RED copy still imports './plan-status.mjs' relatively — symlink it in alongside so the
    // scratch copy resolves the same module without dragging the whole tools/ tree along.
    fs.symlinkSync(path.join(HERE, 'plan-status.mjs'), path.join(scratchDir, 'plan-status.mjs'));
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-shim-red-'));
    makeInterceptingBacklogShim(shimDir);
    try {
      const { parsed } = runScorecardJson(shimDir, scratchScript);
      const unreachable = parsed?.completion?.unreachable ?? [];
      report(
        'RED arm — the pre-fix bare-swallow variant produces NO unreachable entry for the same failure (silent drop)',
        unreachable.length === 0,
        `unreachable=${JSON.stringify(unreachable)} (pre-fix code has no such field at all if this stays empty/absent)`,
      );
    } catch (err) {
      report('RED arm — scratch scorecard.mjs ran to completion', false, `threw: ${err.message}`);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  }
}

console.log(failed === 0 ? '\nAll scorecard unreachable-repo assertions passed.' : `\n${failed} scorecard unreachable-repo assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
