// Tests for the test-author extension (595965cc T22). Unit tests spawn no process and touch no network.
// The two live-model checks (T22.AC1 refusal, T22.AC5 golden-set A/B) are registered as skipped with
// their reason; they run at the later testing run, not here. Run: node --test extensions/agents/test-author/test-author.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyHeader, judgeRedRecord, STUB_MARKER_TOKEN } from './support/red-record.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const manifest = JSON.parse(rd('extension.json'));
const body = rd('test-author.md');
const readme = rd('README.md');
const std = join(here, '..', '..', 'skills', 'workspace-standards', 'standards', 'testing');
const CARDS = ['plan-bucket', 'author-new-behavior', 'author-regression', 'author-contract', 'characterize', 'select-checks', 'maintain'];
const fixture = (name) => readFileSync(join(here, 'support', 'fixtures', name), 'utf8');

const CARD_DIR = join(here, '..', '..', 'skills', 'workspace-standards', 'standards', 'testing', 'cards', 'test-author');
const card = (n) => readFileSync(join(CARD_DIR, `${n}.md`), 'utf8').trim();

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
});

test('595965cc T22.AC2 each of the seven cards is at most 4096 bytes, is inlined verbatim, and the body copies none of its steps', () => {
  for (const c of CARDS) {
    const txt = readFileSync(join(std, 'cards', 'test-author', `${c}.md`), 'utf8');
    assert.ok(Buffer.byteLength(txt) <= 4096, `${c}: ${Buffer.byteLength(txt)} bytes`);
    for (const line of txt.split('\n').filter((l) => /^\d+\. /.test(l))) assert.ok(!body.includes(line.slice(3, 60)), `${c} step copied into body`);
  }
  assert.match(body, /only strategy text/);
});

test('595965cc T22.AC3 plan-bucket caps a dispatch at five items; authoring is one bounded dispatch per unit with fan-out above five and a 100-call stop', () => {
  assert.match(card('plan-bucket'), /At most 5 items per dispatch; split larger buckets by cohesion/);
  assert.match(body, /bucket of <n> items exceeds 5; split by cohesion/);
  assert.match(body, /one bounded dispatch per unit/);
  assert.match(body, /above five the dispatcher fans out/);
  assert.match(body, /after about 100 sequential tool calls, stop and return `remaining: <list>`/i);
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
  assert.match(body, /STUB_MARKER_TOKEN/);
});

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
  const supportFiles = [
    ...readdirSync(join(here, 'support')).filter((f) => f.endsWith('.mjs')).map((f) => `support/${f}`),
    ...readdirSync(join(here, 'support', 'fixtures')).map((f) => `support/fixtures/${f}`),
  ];
  for (const f of supportFiles) assert.ok(readme.includes(f), `${f} not declared in README`);
});
