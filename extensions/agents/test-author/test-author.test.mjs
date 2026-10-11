// Tests for the test-author extension (595965cc T22). Unit tests spawn no process and touch no network.
// The two live-model checks (T22.AC1 refusal, T22.AC5 golden-set A/B) are registered as skipped with
// their reason; they run at the later testing run, not here. Run: node --test extensions/agents/test-author/test-author.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AUTHORING, SCOPE_CASES, card } from './eval/cases.mjs';
import { MUTANTS } from './eval/mutants.mjs';
import { classifyHeader, judgeRedRecord, STUB_MARKER_TOKEN } from './support/red-record.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const manifest = JSON.parse(rd('extension.json'));
const body = rd('test-author.md');
const readme = rd('README.md');
const std = join(here, '..', '..', 'skills', 'workspace-standards', 'standards', 'testing');
const CARDS = ['plan-bucket', 'author-new-behavior', 'author-regression', 'author-contract', 'characterize', 'select-checks', 'maintain'];
const fixture = (name) => readFileSync(join(here, 'support', 'fixtures', name), 'utf8');

const LIVE_AC1 = 'live-model; confirm at the later testing run: test-author refuses a seeded brief to edit a production path';
const LIVE_AC5 = 'live-model A/B; re-measure at the later testing run (recorded A/B missed AC1)';

test('595965cc T22.AC1 manifest: mode all, claude version tracks version, prose-only body, task and git-stash denied', () => {
  assert.equal(manifest.agent.mode, 'all');
  assert.equal(manifest.render.opencode.mode, 'all');
  assert.equal(manifest.render.claude.version, `v${manifest.version}`);
  assert.ok(!body.startsWith('---'), 'prose only, no frontmatter');
  assert.equal(manifest.agent.permission.task, 'deny');
  assert.equal(manifest.agent.permission.bash['git stash*'], 'deny');
});

test('595965cc T22.AC1 body forbids production edits, states the write scope it received, and names the refusal lines', () => {
  assert.match(body, /production code is never yours to change/);
  assert.match(body, /REFUSED: production path/);
  assert.match(body, /REFUSED: production edit requested/);
  assert.match(body, /write-scope: <as received>/);
  const ids = SCOPE_CASES.filter((c) => c.ac === 'AC1').map((c) => c.id);
  assert.deepEqual(ids.sort(), ['R1-prod-path-in-scope', 'R2-asked-to-fix-prod', 'R3-no-write-scope']);
});

test('595965cc T22.AC1 live: test-author refuses a seeded brief to edit a production path', { skip: LIVE_AC1 }, () => {});

test('595965cc T22.AC2 each of the seven cards is at most 4096 bytes, is inlined verbatim, and the body copies none of its steps', () => {
  for (const c of CARDS) {
    const txt = readFileSync(join(std, 'cards', 'test-author', `${c}.md`), 'utf8');
    assert.ok(Buffer.byteLength(txt) <= 4096, `${c}: ${Buffer.byteLength(txt)} bytes`);
    for (const line of txt.split('\n').filter((l) => /^\d+\. /.test(l))) assert.ok(!body.includes(line.slice(3, 60)), `${c} step copied into body`);
  }
  assert.ok(AUTHORING.includes(card('author-new-behavior')), 'the brief inlines the card verbatim');
  assert.match(body, /only strategy text/);
});

test('595965cc T22.AC3 plan-bucket caps a dispatch at five items; authoring is one bounded dispatch per unit with fan-out above five and a 100-call stop', () => {
  assert.match(card('plan-bucket'), /At most 5 items per dispatch; split larger buckets by cohesion/);
  assert.match(body, /bucket of <n> items exceeds 5; split by cohesion/);
  assert.match(body, /one bounded dispatch per unit/);
  assert.match(body, /above five the dispatcher fans out/);
  assert.match(body, /after about 100 sequential tool calls, stop and return `remaining: <list>`/i);
  assert.ok(SCOPE_CASES.some((c) => c.id === 'R4-bucket-over-five' && c.ac === 'AC3'));
});

test('595965cc T22.AC4 red record: body demands command, non-zero exit, assertion or stub marker; the judge accepts real red output and rejects structural failure', () => {
  assert.match(body, /cmd: <test command run against the stub commit>/);
  assert.match(body, /exit: <non-zero>/);
  assert.match(body, /failing assertion \| marker error the stub raised/);
  assert.match(body, /missing symbol, import error, or compile\/syntax error is not red/);
  assert.deepEqual(judgeRedRecord({ exit: 1, output: fixture('stub-marker.txt') }).red, true, 'stub marker is red');
  assert.deepEqual(judgeRedRecord({ exit: 1, output: fixture('assertion.txt') }).red, true, 'assertion is red');
  const structural = judgeRedRecord({ exit: 1, output: fixture('missing-export.txt') });
  assert.equal(structural.red, false);
  assert.match(structural.reason, /structural failure/);
  assert.equal(judgeRedRecord({ exit: 0, output: fixture('assertion.txt') }).red, false, 'exit 0 has no teeth');
});

test('595965cc T22.AC4 judge is per failing test: a mixed run is rejected, an assertion that names a missing binding is accepted', () => {
  const mixed = judgeRedRecord({ exit: 1, output: fixture('mixed-red.txt') });
  assert.equal(mixed.red, false, 'one structural block rejects the record');
  assert.deepEqual(mixed.verdicts, ['marker', 'structural']);
  const fp = judgeRedRecord({ exit: 1, output: fixture('assertion-names-missing-binding.txt') });
  assert.equal(fp.red, true, 'free text "is not defined" inside an AssertionError message is not structural');
  assert.deepEqual(fp.verdicts, ['assertion']);
});

test('595965cc T22.AC4 classifier anchors on the thrown error header, never on free text', () => {
  assert.equal(classifyHeader('  ReferenceError: x is not defined'), 'structural');
  assert.equal(classifyHeader('  TypeError: shippingCost is not a function'), 'structural');
  assert.equal(classifyHeader('  TypeError: Cannot read properties of undefined'), null, 'unknown runtime error is not red');
  assert.equal(classifyHeader('  AssertionError [ERR_ASSERTION]: expected ReferenceError'), 'assertion');
  assert.equal(classifyHeader('  Error: NOT_IMPLEMENTED: shippingCost'), 'marker');
  assert.equal(classifyHeader("  'test failed'"), 'structural');
  assert.equal(classifyHeader('    + ReferenceError: diff line'), null);
});

test('595965cc T22.AC4 the stub marker is one exported constant: the stub throws it and the body names it', () => {
  assert.equal(STUB_MARKER_TOKEN, 'NOT_IMPLEMENTED');
  assert.match(rd('eval/fixture/src/shipping.stub.mjs'), new RegExp(`Error\\('${STUB_MARKER_TOKEN}`));
  assert.match(body, /STUB_MARKER_TOKEN/);
});

test('595965cc T22.AC4 eval/lib.mjs imports the shared judge and carries no second red rule', () => {
  const lib = rd('eval/lib.mjs');
  assert.match(lib, /from '\.\.\/support\/red-record\.mjs'/);
  assert.doesNotMatch(lib, /does not provide an export/);
});

test('595965cc T22.AC5 eval runner carries an unconditional HARD STOP: process.exit(64) at top level, before the first spawn and the job list, with no bypass', () => {
  const run = rd('eval/run.mjs');
  const stop = run.indexOf('// HARD STOP');
  const exit = run.indexOf('process.exit(64);');
  assert.ok(stop >= 0, 'HARD STOP block present');
  assert.ok(exit > stop, 'process.exit(64) follows the HARD STOP comment');
  assert.doesNotMatch(run.slice(stop, exit), /\bif\b/, 'the stop is not inside a conditional');
  assert.match(run, /^process\.exit\(64\);$/m, 'the exit is a top-level statement');
  assert.ok(run.search(/spawn\(/) > exit, 'stop precedes the first spawn');
  assert.ok(run.indexOf('const jobs') > exit, 'stop precedes job construction');
  assert.doesNotMatch(run, /process\.env\.(?!TA_EVAL_MODEL\b)/, 'the stop reads no environment bypass');
});

test('595965cc T22.AC5 eval headers cite a0897ba2 and 595965cc T22', () => {
  for (const f of ['run.mjs', 'lib.mjs', 'mutants.mjs', 'cases.mjs']) {
    const head = rd(`eval/${f}`).split('\n').slice(0, 3).join('\n');
    assert.match(head, /a0897ba2/, `${f} cites a0897ba2`);
    assert.match(head, /595965cc T22/, `${f} cites 595965cc T22`);
  }
});

test('595965cc T22.AC5 results.json is marked unconfirmed-stale whenever its recorded promptSha256 is not the current body hash', () => {
  const r = JSON.parse(rd('eval/results.json'));
  if (r.summary.promptSha256 !== createHash('sha256').update(body).digest('hex')) {
    assert.equal(r.status, 'unconfirmed-stale');
    assert.ok(typeof r.staleReason === 'string' && r.staleReason.length > 0, 'staleReason present');
  }
});

test('595965cc T22.AC5 fixture: at least five seeded faults, each a single-edit mutant that changes the implementation', () => {
  const impl = readFileSync(join(here, 'eval', 'fixture', 'src', 'shipping.impl.mjs'), 'utf8');
  assert.ok(MUTANTS.length >= 5, 'at least five seeded faults');
  for (const m of MUTANTS) {
    assert.ok(impl.includes(m.from), `${m.id}: pattern absent from implementation`);
    assert.notEqual(impl.replace(m.from, m.to), impl, `${m.id}: mutant changes nothing`);
  }
});

test('595965cc T22.AC5 live: golden-set A/B, separated arm >= baseline on kills', { skip: LIVE_AC5 }, () => {});

test('595965cc T22.AC6 roles-covered equals the Test author obligations in roles.md; every support file is declared in the README', () => {
  const roles = readFileSync(join(std, 'roles.md'), 'utf8');
  const sec = roles.split('## role: ').find((s) => s.startsWith('test-author'));
  const ids = [...sec.matchAll(/^- (TA\.\d+):/gm)].map((m) => m[1]);
  const schema = JSON.parse(readFileSync(join(here, '..', '..', 'skills', 'workspace-standards', 'schemas', 'roles-covered.schema.json'), 'utf8'));
  const entry = new RegExp(schema.$defs.capabilityEntry.pattern);
  const caps = manifest.capabilities.filter((c) => c.startsWith('roles-covered:'));
  assert.ok(caps.every((c) => entry.test(c)));
  assert.deepEqual(caps.map((c) => c.split(':')[1]).sort(), ids.sort());
  assert.match(body, /support: <file>\.\.\./);
  assert.match(body, /A `support:` file that only serves tests .* and that you declared is yours even when it sits beside production code/);
  assert.ok(SCOPE_CASES.some((c) => c.id === 'S1-support-beside-prod-declared' && c.ac === 'AC6'));
  const supportFiles = [
    ...readdirSync(join(here, 'support')).filter((f) => f.endsWith('.mjs')).map((f) => `support/${f}`),
    ...readdirSync(join(here, 'support', 'fixtures')).map((f) => `support/fixtures/${f}`),
  ];
  for (const f of supportFiles) assert.ok(readme.includes(f), `${f} not declared in README`);
});
