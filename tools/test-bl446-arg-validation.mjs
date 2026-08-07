#!/usr/bin/env node
/**
 * tools/test-bl446-arg-validation.mjs
 *
 * Red->green contract pin for BL-446, updated for [ADR-0011] Stage 3 (SPEC-DELETE-FILES.md D4 /
 * AC-D4-retirement-help / AC-D4-retirement-default).
 *
 * `allocate-bl-id.mjs` is DELETED in this same change (its retirement message referenced
 * `bl-id-counter.mjs`, itself also deleted — keeping the stub around would make it
 * self-contradictory). Its case is dropped from this test entirely.
 *
 * `check-backlog-markers.mjs` and `check-bl-id-integrity.mjs` are retired IN PLACE, following the
 * exact `--help`/unrecognized-flag/zero-arg contract shape `allocate-bl-id.mjs` established:
 *   1. `--help` / `-h` — exit 0, stdout contains "Usage", ZERO git/filesystem I/O at all (no
 *      BACKLOG.md/CHANGELOG.md fixture needs to exist in the scratch dir for this to pass).
 *   2. An unrecognized flag — exit non-zero.
 *   3. Zero-arg (default) invocation — exit 1, stderr contains a retirement message naming
 *      `plan-status.mjs`/the graph as the replacement. This is the NEW zero-arg contract — the
 *      OLD one (check-backlog-markers.mjs exits 0 on a clean fixture; check-bl-id-integrity.mjs
 *      "skips" and exits 0 with nothing staged) is gone along with the files it used to read.
 *
 * Both scripts are run against a scratch git repo with NO BACKLOG.md/CHANGELOG.md fixture at all
 * — proving the retired script never tries to read one (the RED arm below is exactly this: the
 * pre-retirement scripts throw an unhandled ENOENT/`git rev-parse` failure in this same scratch
 * dir, because they unconditionally resolve and read BACKLOG.md/CHANGELOG.md before ever
 * inspecting argv for --help).
 *
 * Usage: node tools/test-bl446-arg-validation.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Env-var overrides let the red-before-green check point at a materialized pre-fix copy of a
// script (e.g. `git show HEAD~N:tools/check-backlog-markers.mjs` written to a scratch path)
// without touching the default, which always resolves to the sibling file in this directory.
const CHECK_MARKERS = process.env.BL446_CHECK_MARKERS
  ? path.resolve(process.env.BL446_CHECK_MARKERS)
  : path.join(HERE, 'check-backlog-markers.mjs');
const CHECK_INTEGRITY = process.env.BL446_CHECK_INTEGRITY
  ? path.resolve(process.env.BL446_CHECK_INTEGRITY)
  : path.join(HERE, 'check-bl-id-integrity.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Deliberately NO BACKLOG.md/CHANGELOG.md fixture — a retired script must never need one, at any
// argv shape, not even --help.
function scratchRepo(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bl446-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch\n');
  sh(['add', 'README.md'], dir);
  sh(['commit', '-q', '-m', 'chore: seed'], dir);
  return dir;
}

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const scripts = [
  { name: 'check-backlog-markers.mjs', script: CHECK_MARKERS },
  { name: 'check-bl-id-integrity.mjs', script: CHECK_INTEGRITY },
];

for (const { name, script } of scripts) {
  // ---------------------------------------------------------------------
  // 1. --help / -h — zero I/O, must work even with no BACKLOG.md/CHANGELOG.md in the scratch dir.
  // ---------------------------------------------------------------------
  for (const flag of ['--help', '-h']) {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-${flag.replace(/\W/g, '')}`);

    const r = run(script, [flag], dir);

    report(
      `BL-446 ${name} ${flag}: exit code 0`,
      r.code === 0,
      `code=${r.code} stdout=${JSON.stringify(r.out.slice(0, 200))} stderr=${JSON.stringify(r.err.slice(0, 200))}`,
    );
    report(
      `BL-446 ${name} ${flag}: stdout contains the literal substring 'Usage'`,
      r.out.includes('Usage'),
      `stdout=${JSON.stringify(r.out.slice(0, 200))}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // 2. Unrecognized argument
  // ---------------------------------------------------------------------
  {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-unrec`);

    const r = run(script, ['--this-is-not-a-flag'], dir);

    report(
      `BL-446 ${name} --this-is-not-a-flag: exit code is non-zero`,
      r.code !== 0,
      `code=${r.code} stdout=${JSON.stringify(r.out.slice(0, 200))} stderr=${JSON.stringify(r.err.slice(0, 200))}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // 3. Zero-arg (default) invocation — [AC-D4-retirement-default] NEW contract: retired, exit 1,
  //    a retirement message pointing at plan-status.mjs/the graph. No BACKLOG.md/CHANGELOG.md
  //    fixture exists in this scratch dir, proving the retired script doesn't try to read one.
  // ---------------------------------------------------------------------
  {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-zero`);
    const r = run(script, [], dir);
    report(
      `BL-446/AC-D4-retirement-default ${name} (no args): retired — exit 1, stderr names the graph/plan-status.mjs replacement`,
      r.code === 1 && /RETIRED/i.test(r.err) && /plan-status/i.test(r.err),
      `code=${r.code} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err.slice(0, 300))}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? '\nAll BL-446 assertions passed.' : `\n${failed} BL-446 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
