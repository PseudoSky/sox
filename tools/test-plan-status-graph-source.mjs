#!/usr/bin/env node
/**
 * tools/test-plan-status-graph-source.mjs
 *
 * [ADR-0011 Stage 3, SPEC-DELETE-FILES.md D1/D2/D3] Coverage for `readGraphStatuses` (née
 * `readBacklogStatuses`) and the new graph-status-enum open-set — the one function `plan-status.mjs`
 * had no existing test for before this packet repointed it at the `backlog` CLI instead of
 * `BACKLOG.md`.
 *
 * AC-D1-status-mapping — every value in the ruled D1 table round-trips through `isOpen()`
 *   correctly: 19 canonical status strings (8 open, 11 closed) plus 2 lowercase aliases.
 *   RED arm: the same assertions run against the OLD open-set (['OPEN','REOPENED','BLOCKED'])
 *   fail on IN_PROGRESS/PARTIAL/OUTSTANDING/DEFERRED/MIXED/UNKNOWN (wrongly read as closed).
 *
 * AC-D2-pagination — a fake `backlog` executable returning exactly PAGE(200) items on page 1 and
 *   a smaller remainder on page 2: `readGraphStatuses()`'s Map contains items from BOTH pages.
 *   RED arm: a naive single-call (no pagination) implementation is missing the page-2 item.
 *
 * AC-D3-loud-failure — a fake `backlog` binary that doesn't exist: `plan-status.mjs --check`
 *   (subprocess) exits non-zero, stderr names the failing command, and it never prints "OK".
 *   RED arm: a catch-and-swallow variant of `readGraphStatuses` returns an EMPTY Map instead of
 *   throwing on the identical missing-binary fixture — the silent "everything reads as closed"
 *   failure mode D3 forbids.
 *
 * Usage: node tools/test-plan-status-graph-source.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const modulePath = process.env.PLAN_STATUS_MODULE ? path.resolve(process.env.PLAN_STATUS_MODULE) : path.join(HERE, 'plan-status.mjs');
const PLAN_STATUS_SCRIPT = process.env.PLAN_STATUS_SCRIPT ? path.resolve(process.env.PLAN_STATUS_SCRIPT) : path.join(HERE, 'plan-status.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const { isOpen, OPEN_STATUSES, readGraphStatuses } = await import(pathToFileURL(modulePath).href);

// ---------------------------------------------------------------------------------------------
// AC-D1-status-mapping
// ---------------------------------------------------------------------------------------------
// D1's table, restated as data: [status, expectedOpen].
const D1_TABLE = [
  ['OPEN', true],
  ['IN_PROGRESS', true],
  ['PARTIAL', true],
  ['OUTSTANDING', true],
  ['DEFERRED', true],
  ['BLOCKED', true],
  ['MIXED', true],
  ['UNKNOWN', true],
  ['FIXED', false],
  ['RESOLVED', false],
  ['DONE', false],
  ['SHIPPED', false],
  ['VERIFIED', false],
  ['REMOVED', false],
  ['MITIGATED', false],
  ['SUPERSEDED', false],
  ['INVALID', false],
  ['DUPLICATE', false],
  ['WONTFIX', false],
];
{
  const statuses = new Map(D1_TABLE.map(([s], i) => [i + 1, s]));
  D1_TABLE.forEach(([s, expected], i) => {
    report(`AC-D1 isOpen(${s}) === ${expected}`, isOpen(statuses, i + 1) === expected, `got ${isOpen(statuses, i + 1)}`);
  });

  report(
    'AC-D1 OPEN_STATUSES has exactly 8 members (matches D1 table open count)',
    OPEN_STATUSES.size === 8,
    `got ${OPEN_STATUSES.size}: ${[...OPEN_STATUSES].join(',')}`,
  );
}

// D1's lowercase-alias row: `isOpen()` itself is a pure, case-sensitive Set lookup (deliberately —
// D7 forbids changing its signature/behavior beyond the membership set). Case-insensitivity is
// achieved one layer up, in `readGraphStatuses()`, which upper-cases every status string before
// storing it — so a graph item literally carrying `status: "open"` reaches `isOpen()` already
// normalized to `"OPEN"`. Proven end-to-end below via the fake-CLI fixture (AC-D2 section reuses
// `makeFakeBacklog`), not by calling `isOpen()` directly with a lowercase key (which would test a
// normalization contract `isOpen()` does not itself carry).

// RED arm — the OLD open-set, applied to the same D1 table. Demonstrates the six named statuses
// were wrongly read as closed before this fix.
{
  const OLD_OPEN = new Set(['OPEN', 'REOPENED', 'BLOCKED']);
  const oldIsOpen = (statuses, id) => OLD_OPEN.has(statuses.get(id) ?? 'ABSENT');
  const statuses = new Map(D1_TABLE.map(([s], i) => [i + 1, s]));
  const shouldHaveFailed = ['IN_PROGRESS', 'PARTIAL', 'OUTSTANDING', 'DEFERRED', 'MIXED', 'UNKNOWN'];
  let redFailures = 0;
  D1_TABLE.forEach(([s, expected], i) => {
    if (oldIsOpen(statuses, i + 1) !== expected) redFailures += 1;
  });
  report(
    `AC-D1 RED arm — the pre-fix open-set misclassifies exactly the ${shouldHaveFailed.length} named statuses`,
    redFailures === shouldHaveFailed.length,
    `pre-fix open-set produced ${redFailures} mismatch(es) against the ruled table (expected ${shouldHaveFailed.length}: ${shouldHaveFailed.join(',')})`,
  );
}

// ---------------------------------------------------------------------------------------------
// Fixture: a fake `backlog` CLI executable understanding only `query --input <json>`.
// ---------------------------------------------------------------------------------------------
function makeFakeBacklog(dir, { page1Count, page2Count, pageSize = 200, page1Status = 'OPEN', page2Status = 'OPEN' }) {
  const script = path.join(dir, 'backlog');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
const inputIdx = argv.indexOf('--input');
const input = JSON.parse(argv[inputIdx + 1]);
const offset = input.offset ?? 0;
const PAGE1 = ${page1Count};
const PAGE2 = ${page2Count};
let items = [];
if (offset === 0) {
  items = Array.from({ length: PAGE1 }, (_, i) => ({ humanId: 'BL-' + (i + 1), status: ${JSON.stringify(page1Status)} }));
} else if (offset === PAGE1) {
  items = Array.from({ length: PAGE2 }, (_, i) => ({ humanId: 'BL-' + (PAGE1 + i + 1), status: ${JSON.stringify(page2Status)} }));
}
process.stdout.write(JSON.stringify({ ok: true, data: { view: 'list', items }, meta: { total: items.length } }));
`,
    { mode: 0o755 },
  );
  return script;
}

// readGraphStatuses() reads its target binary from a module-level const evaluated at import time
// (BACKLOG_BIN, frozen from process.env.PLAN_STATUS_BACKLOG_BIN at process start) — exactly the
// same way the real `--check` subprocess picks it up. Exercising it therefore requires a FRESH
// process with the env var set before it starts, not an env mutation after this test's own
// top-level `await import(...)` already ran (which would be silently ignored, since the const was
// already frozen). `runGraphStatusesJson` spawns node once per fixture for this reason.
function runGraphStatusesJson(backlogBin) {
  const r = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(pathToFileURL(PLAN_STATUS_SCRIPT).href)}).then(m => { console.log(JSON.stringify([...m.readGraphStatuses()])); });`],
    { encoding: 'utf8', env: { ...process.env, PLAN_STATUS_BACKLOG_BIN: backlogBin } },
  );
  if (r.status !== 0) throw new Error(`runGraphStatusesJson subprocess failed: code=${r.status} stderr=${r.stderr}`);
  return new Map(JSON.parse(r.stdout));
}

function makeMissingBacklog(dir) {
  // A path that simply does not exist — the "binary not found" arm of D3.
  return path.join(dir, 'no-such-backlog-binary');
}

// ---------------------------------------------------------------------------------------------
// AC-D2-pagination
// ---------------------------------------------------------------------------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-page-')));
  const fake = makeFakeBacklog(dir, { page1Count: 200, page2Count: 17 });
  try {
    const statuses = runGraphStatusesJson(fake);
    report('AC-D2 readGraphStatuses() returns items from page 1 (id 1 present)', statuses.has(1), `size=${statuses.size}`);
    report(
      'AC-D2 readGraphStatuses() returns items from page 2 (id 217, the last item, present)',
      statuses.has(217),
      `size=${statuses.size}, has(217)=${statuses.has(217)}`,
    );
    report('AC-D2 readGraphStatuses() total size is 217 (200 + 17, both pages)', statuses.size === 217, `size=${statuses.size}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// D1 lowercase-alias, end-to-end: readGraphStatuses() must upper-case a lowercase status string
// from the CLI before it reaches isOpen().
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-alias-'));
  const fake = makeFakeBacklog(dir, { page1Count: 1, page2Count: 0, page1Status: 'open' });
  try {
    const statuses = runGraphStatusesJson(fake);
    report(
      "AC-D1 alias — readGraphStatuses() upper-cases a lowercase 'open' status so isOpen() reads it as open",
      isOpen(statuses, 1) === true && statuses.get(1) === 'OPEN',
      `stored value=${JSON.stringify(statuses.get(1))}, isOpen=${isOpen(statuses, 1)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// RED arm — a naive single-call (no pagination loop) implementation against the identical fixture.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-page-naive-'));
  const fake = makeFakeBacklog(dir, { page1Count: 200, page2Count: 17 });
  const naiveOut = execFileSync(fake, ['query', '--input', JSON.stringify({ view: 'list', filter: { repo: 'sox-ecosystem', family: 'BL', excludeArchived: false, status: 'all' }, limit: 200, offset: 0 })], {
    encoding: 'utf8',
  });
  const naiveItems = JSON.parse(naiveOut).data.items;
  const naiveMap = new Map(naiveItems.map((i) => [Number(i.humanId.replace(/^BL-/, '')), i.status]));
  report(
    'AC-D2 RED arm — a naive single-call implementation is missing the page-2-only item (id 217)',
    !naiveMap.has(217),
    `naive map has(217)=${naiveMap.has(217)} (should be false pre-pagination-fix)`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// AC-D3-loud-failure
// ---------------------------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-missing-bin-'));
  const missing = makeMissingBacklog(dir);
  const r = spawnSync(process.execPath, [PLAN_STATUS_SCRIPT, '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLAN_STATUS_BACKLOG_BIN: missing },
  });
  report('AC-D3 plan-status.mjs --check exits non-zero when the backlog binary is missing', r.status !== 0, `code=${r.status}`);
  report(
    'AC-D3 stderr names the failing command (mentions "query" or the binary path)',
    r.stderr.includes('query') || r.stderr.includes(missing),
    `stderr=${JSON.stringify(r.stderr.slice(0, 400))}`,
  );
  report('AC-D3 stderr does NOT print the normal OK line', !/plan-status: OK/.test(r.stderr) && !/plan-status: OK/.test(r.stdout), `stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// RED arm — a catch-and-swallow readGraphStatuses variant would return an EMPTY Map on a CLI
// failure instead of throwing, which is the exact worst-case failure mode D3 forbids (every id
// silently reads as absent-therefore-closed). Demonstrate the swallow itself directly — via
// `readGraphStatuses()`'s return value on a missing binary — rather than routing through
// `main()`'s "OK"/"STALE" print, which is coupled to whatever PLAN.md/STATE.md currently contain
// and would report STALE-not-OK on an empty Map today anyway (this repo currently has open work),
// masking the actual defect being demonstrated. The empty-Map return IS the defect: with it,
// `isOpen()` reads every id as closed regardless of what the derived blocks currently say.
{
  const src = fs.readFileSync(PLAN_STATUS_SCRIPT, 'utf8');
  const swallowSrc = src.replace(
    /\} catch \(err\) \{\s*\n\s*const timedOut[\s\S]*?\);\s*\n(\s*)\}/,
    (whole, indent) => `} catch (err) {\n${indent}return statuses; // [RED-ARM INJECTION] catch-and-swallow, must never ship\n${indent}}`,
  );
  if (swallowSrc === src) {
    report('AC-D3 RED arm — able to construct a catch-and-swallow variant of the throw site', false, 'regex did not match plan-status.mjs source — script structure changed');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-status-swallow-bin-'));
    // Written as a SIBLING of the real plan-status.mjs (not under os.tmpdir()) purely so a
    // dynamic `import()` of it resolves cleanly; cleaned up in `finally` regardless of outcome.
    const swallowPath = path.join(HERE, `.tmp-swallow-plan-status-${process.pid}.mjs`);
    fs.writeFileSync(swallowPath, swallowSrc);
    const missing = makeMissingBacklog(dir);
    try {
      const r = spawnSync(
        process.execPath,
        ['-e', `import(${JSON.stringify(pathToFileURL(swallowPath).href)}).then(m => { console.log(JSON.stringify([...m.readGraphStatuses()])); });`],
        { encoding: 'utf8', env: { ...process.env, PLAN_STATUS_BACKLOG_BIN: missing } },
      );
      const swallowedMap = r.status === 0 ? new Map(JSON.parse(r.stdout)) : null;
      report(
        'AC-D3 RED arm — the catch-and-swallow variant returns an EMPTY Map (silent "everything is closed") instead of throwing on the same missing-binary fixture',
        r.status === 0 && swallowedMap !== null && swallowedMap.size === 0,
        `code=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 200))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
      );
    } finally {
      fs.rmSync(swallowPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(failed === 0 ? '\nAll plan-status graph-source assertions passed.' : `\n${failed} plan-status graph-source assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
