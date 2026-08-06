#!/usr/bin/env node
/**
 * tools/test-bl446-arg-validation.mjs
 *
 * Red->green contract pin for BL-446: none of `allocate-bl-id.mjs`, `check-backlog-markers.mjs`,
 * `check-bl-id-integrity.mjs` inspected `process.argv` for `--help`/an unrecognized flag before
 * falling through to their default path — for `allocate-bl-id.mjs` that default path MUTATES
 * (acquires the lock, appends a `RESERVED` placeholder to `BACKLOG.md`), so a typo'd flag (or an
 * agent reasonably trying `--help` to learn the interface) silently reserved a real id. Confirmed
 * live this week per the task brief: `check-backlog-markers.mjs --help` ran the full check
 * instead of printing usage.
 *
 * For each of the three scripts, against a fresh scratch repo per script:
 *   1. `--help` / `-h` — exit 0, stdout contains "Usage", and (allocate-bl-id.mjs only)
 *      BACKLOG.md's content hash is unchanged.
 *   2. An unrecognized flag — exit non-zero, and (allocate-bl-id.mjs only) BACKLOG.md's content
 *      hash is unchanged.
 *   3. Zero-arg regression guard — re-run with no arguments at all and assert the pre-existing
 *      zero-arg behavior still holds (allocate-bl-id.mjs still allocates; check-backlog-markers.mjs
 *      and check-bl-id-integrity.mjs still exit 0 on a clean fixture, with
 *      check-bl-id-integrity.mjs still delegating to check-backlog-markers.mjs).
 *
 * Usage: node tools/test-bl446-arg-validation.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Env-var overrides let the red-before-green check point at a materialized pre-fix copy of a
// script (e.g. `git show HEAD:tools/allocate-bl-id.mjs` written to a scratch path) without
// touching the default, which always resolves to the sibling file in this directory.
const ALLOCATE = process.env.BL446_ALLOCATE
  ? path.resolve(process.env.BL446_ALLOCATE)
  : path.join(HERE, 'allocate-bl-id.mjs');
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

// BL-479 — strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR so this scratch
// repo's git commands can never resolve against the invoking checkout's real index (git prefers
// these env vars over cwd-based repo discovery).
const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;
const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: SAFE_GIT_ENV });

function scratchRepo(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bl446-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# BACKLOG\n\n**Total open: 0.**\n\n---\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n');
  sh(['add', 'BACKLOG.md', 'CHANGELOG.md'], dir);
  sh(['commit', '-q', '-m', 'chore: seed'], dir);
  return dir;
}

const hashOf = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const scripts = [
  { name: 'allocate-bl-id.mjs', script: ALLOCATE, mutating: true },
  { name: 'check-backlog-markers.mjs', script: CHECK_MARKERS, mutating: false },
  { name: 'check-bl-id-integrity.mjs', script: CHECK_INTEGRITY, mutating: false },
];

for (const { name, script, mutating } of scripts) {
  // ---------------------------------------------------------------------
  // 1. --help / -h
  // ---------------------------------------------------------------------
  for (const flag of ['--help', '-h']) {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-${flag.replace(/\W/g, '')}`);
    const backlogPath = path.join(dir, 'BACKLOG.md');
    const hashBefore = hashOf(backlogPath);

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
    if (mutating) {
      const hashAfter = hashOf(backlogPath);
      report(
        `BL-446 ${name} ${flag}: BACKLOG.md content hash unchanged (no side effect)`,
        hashAfter === hashBefore,
        `before=${hashBefore} after=${hashAfter}`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // 2. Unrecognized argument
  // ---------------------------------------------------------------------
  {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-unrec`);
    const backlogPath = path.join(dir, 'BACKLOG.md');
    const hashBefore = hashOf(backlogPath);

    const r = run(script, ['--this-is-not-a-flag'], dir);

    report(
      `BL-446 ${name} --this-is-not-a-flag: exit code is non-zero`,
      r.code !== 0,
      `code=${r.code} stdout=${JSON.stringify(r.out.slice(0, 200))} stderr=${JSON.stringify(r.err.slice(0, 200))}`,
    );
    if (mutating) {
      const hashAfter = hashOf(backlogPath);
      report(
        `BL-446 ${name} --this-is-not-a-flag: BACKLOG.md content hash unchanged (no side effect)`,
        hashAfter === hashBefore,
        `before=${hashBefore} after=${hashAfter}`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // 3. Zero-arg regression guard
  // ---------------------------------------------------------------------
  {
    const dir = scratchRepo(`${name.replace(/\W/g, '')}-zero`);
    const r = run(script, [], dir);
    if (name === 'allocate-bl-id.mjs') {
      report(
        'BL-446 allocate-bl-id.mjs (no args): still allocates — stdout matches /^BL-\\d+$/',
        r.code === 0 && /^BL-\d+\s*$/.test(r.out),
        `code=${r.code} stdout=${JSON.stringify(r.out)}`,
      );
    } else if (name === 'check-backlog-markers.mjs') {
      report(
        'BL-446 check-backlog-markers.mjs (no args): still exits 0 on a clean fixture',
        r.code === 0,
        `code=${r.code} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err)}`,
      );
    } else {
      // check-bl-id-integrity.mjs: nothing staged on a fresh clean checkout -> "skipped", exit 0.
      report(
        'BL-446 check-bl-id-integrity.mjs (no args): still skips and exits 0 with nothing staged',
        r.code === 0 && /skipped/.test(r.out),
        `code=${r.code} stdout=${JSON.stringify(r.out)} stderr=${JSON.stringify(r.err)}`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? '\nAll BL-446 assertions passed.' : `\n${failed} BL-446 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
