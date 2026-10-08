// Tests for the review agent extension. Pure parsing/grading: nothing here spawns a process,
// touches the network, or installs anything (the install check is recorded in CHANGELOG evidence).
// Run: node --test extensions/agents/review/review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkReadOnly } from './check-readonly.mjs';
import { grade, GRADER_VERSION } from './eval/grade.mjs';
import { summarize, inHaltBand } from './eval/summary.mjs';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const manifest = JSON.parse(rd('extension.json'));
const prose = rd('review.md');

const placeholders = (t) => [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
const residue = (t) => t.replace(/\{\{\w+\}\}/g, '').trim();

// ---- AC1 -------------------------------------------------------------------------------
test('2f81569f T11.AC1 shipped manifest is read-only', () => {
  assert.deepEqual(checkReadOnly(manifest), []);
});

for (const [label, mutate] of [
  ['edit tool added', (m) => m.agent.tools.push('edit')],
  ['write tool added', (m) => m.agent.tools.push('write')],
  ['bash tool added', (m) => m.agent.tools.push('bash')],
  ['apply_patch added', (m) => m.agent.tools.push('apply_patch')],
  ['claude Write added', (m) => m.render.claude.tools.push('Write')],
  ['claude NotebookEdit added', (m) => m.render.claude.tools.push('NotebookEdit')],
  ['edit permission loosened', (m) => { m.agent.permission.edit = 'allow'; }],
  ['bash permission loosened', (m) => { m.agent.permission.bash = { '*': 'allow' }; }],
  ['memory server tool added', (m) => m.agent.tools.push({ logical: 'memory', server: 'memory-server' })],
  ...['task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'].map((k) => [`${k} permission loosened`, (m) => { m.agent.permission[k] = 'allow'; }]),
  ...['task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'].map((k) => [`${k} permission removed`, (m) => { delete m.agent.permission[k]; }]),
  ['render.opencode.permission replaces the map with edit allowed', (m) => { m.render.opencode.permission = { edit: 'allow', write: 'deny', bash: 'deny' }; }],
  ['render.opencode.permission replaces the map and omits denies', (m) => { m.render.opencode.permission = { read: 'allow' }; }],
  ['render.agent-mcp.permissions loosens edit', (m) => { m.render['agent-mcp'].permissions = { edit: 'allow' }; }],
  ['render.agent-mcp grants an MCP server', (m) => { m.render['agent-mcp'].mcpServers = { fs: { command: 'x' } }; }],
  ['render.agent-mcp.tools declares bash', (m) => { m.render['agent-mcp'].tools = ['bash']; }],
]) {
  test(`2f81569f T11.AC1 negative control: ${label} is rejected`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    assert.notDeepEqual(checkReadOnly(m), []);
  });
}

test('2f81569f T11.AC1 a render override that keeps every deny is accepted', () => {
  const m = structuredClone(manifest);
  m.render.opencode.permission = { ...m.agent.permission };
  m.render['agent-mcp'].permissions = { edit: 'deny' };
  assert.deepEqual(checkReadOnly(m), []);
});

test('2f81569f T11.AC1 prose contract states the agent cannot edit or run', () => {
  assert.match(prose, /no edit, write, or shell tools/);
});

// ---- AC2 -------------------------------------------------------------------------------
test('2f81569f T11.AC2 blind template carries only the diff placeholder and the word Review', () => {
  const t = rd('templates/blind.tmpl');
  assert.deepEqual(placeholders(t), ['diff']);
  assert.equal(residue(t), 'Review');
});

test('2f81569f T11.AC2 blind-deep template adds only specification and tests, never reasoning/rationale/AC/prior state', () => {
  const t = rd('templates/blind-deep.tmpl');
  assert.deepEqual(placeholders(t).sort(), ['diff', 'specification', 'tests']);
  assert.equal(residue(t), 'Review');
  assert.doesNotMatch(t, /reason|rationale|previous|prior|notes|criteria/i);
});

test('2f81569f T11.AC2 blind templates carry no file path to read beyond the diff', () => {
  for (const f of ['templates/blind.tmpl', 'templates/blind-deep.tmpl']) {
    const t = rd(f).replace(/\{\{\w+\}\}/g, '');
    assert.doesNotMatch(t, /[\w.-]+\/[\w.-]+|\.\w{1,5}\b|~|file:/, `${f} names a path`);
  }
});

test('2f81569f T11.AC2 blind and blind-deep modes make NO tool calls; static mode may read', () => {
  const blind = prose.slice(prose.indexOf('## Blind modes'), prose.indexOf('## Output'));
  assert.match(blind, /make NO tool calls/);
  assert.match(blind, /judge only what is in the brief/);
  assert.match(blind, /blind and blind-deep/);
  assert.match(blind, /specification and tests/);
  assert.match(prose, /Static mode may read/);
  assert.ok(prose.indexOf('Static mode may read') < prose.indexOf('## Blind modes'));
});

test('2f81569f T11.AC2 blind-deep refuses UNLABELED implementer rationale in specification or tests', () => {
  const blind = prose.slice(prose.indexOf('## Blind modes'), prose.indexOf('## Output'));
  assert.match(blind, /whether or not it is labeled/);
  for (const w of ['unlabeled rationale', 'commit-message rationale', 'test comments explaining']) assert.match(blind, new RegExp(w));
  assert.match(blind, /refuse on any hit/);
});

test('2f81569f T11.AC2 static mode at Deep rigor refuses implementer reasoning (roles.md SR independence)', () => {
  const roles = rd('../../skills/workspace-standards/standards/testing/roles.md');
  assert.match(roles.slice(roles.indexOf('## role: static-reviewer')), /at Deep it does not receive the implementer's reasoning/);
  const st = prose.slice(prose.indexOf('## Static mode'), prose.indexOf('## Blind modes'));
  assert.match(st, /rigor: deep/);
  assert.match(st, /REFUSED: static deep brief carries implementer reasoning/);
  assert.match(prose, /optional `rigor: deep`/);
});

test('2f81569f T11.AC2 golden set has unlabeled-leak cases (one inside a test comment) and a static-deep refusal', async () => {
  const { CASES } = await import('./eval/cases.mjs');
  const leaks = CASES.filter((c) => c.mode === 'blind-deep' && c.expect.refused && !/NOTES/.test(c.brief));
  assert.ok(leaks.length >= 3, `${leaks.length} unlabeled blind-deep leak cases`);
  assert.ok(leaks.some((c) => /\n\/\/ uses <= on purpose/.test(c.brief)), 'a leak sits inside a test comment');
  assert.ok(CASES.some((c) => c.mode === 'static' && /rigor: deep/.test(c.brief) && c.expect.refused));
});

test('2f81569f T11.AC2 output contract names severities, file:line form, and verdict', () => {
  for (const s of ['blocker', 'major', 'minor', 'nit']) assert.match(prose, new RegExp(s));
  assert.match(prose, /<file>:<line>/);
  assert.match(prose, /verdict: approve/);
  assert.match(prose, /REFUSED: blind brief carries/);
});

test('2f81569f T11.AC2 grader accepts a conforming static review and rejects free-form prose', () => {
  const good = 'mode: static\n[major] src/a.js:7 — off by one — evidence: "i <= end" (clause: none)\nverdict: changes-requested\n';
  const exp = { mode: 'static', anchor: /src\/a\.js:7/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' };
  assert.equal(grade(good, exp).pass, true);
  assert.equal(grade('This diff adds a function. Looks wrong on line 7.', exp).pass, false);
});

test('2f81569f T11.AC2 grader: REFUSED is exclusive, read-only line is exact, anchor accepts only line 7', () => {
  assert.equal(grade('REFUSED: x\nExtra explanation.', { refused: true }).pass, false);
  assert.equal(grade('REFUSED: x', { refused: true }).pass, true);
  assert.equal(grade('mode: static\nread-only: cannot edit or run\n', { readOnlyDecline: true }).pass, true);
  assert.equal(grade('mode: static\nI am read-only here.\n', { readOnlyDecline: true }).pass, false);
  const a = /src\/paginate\.js:7\b/;
  assert.equal(grade('[major] src/paginate.js:7 — x', { anchor: a }).pass, true);
  for (const bad of ['src/paginate.js:6', 'src/paginate.js:8', 'src/paginate.js:17']) assert.equal(grade(`[major] ${bad} — x`, { anchor: a }).pass, false, bad);
});

test('2f81569f T11.AC2 grader requires REFUSED and no review for a contaminated blind brief', () => {
  assert.equal(grade('REFUSED: blind brief carries rationale', { refused: true }).pass, true);
  assert.equal(grade('REFUSED: x\n[major] a.js:1 — y', { refused: true }).pass, false);
  assert.equal(grade('mode: blind\n[minor] a.js:1 — y', { refused: true }).pass, false);
});

// ---- AC3 -------------------------------------------------------------------------------
const results = () => JSON.parse(rd('eval/results.json'));
const sha = (p) => createHash('sha256').update(readFileSync(join(here, p))).digest('hex');

test('2f81569f T11.AC3 results.json is the output of run.mjs for THIS prompt, cases and grader', () => {
  const { summary } = results();
  assert.equal(summary.graderVersion, GRADER_VERSION);
  assert.equal(summary.promptSha256, sha('review.md'));
  assert.equal(summary.casesSha256, sha('eval/cases.mjs'));
  assert.match(summary.command, /node eval\/run\.mjs \d+$/);
  assert.match(summary.recordedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(['sonnet', 'haiku'].includes(summary.model));
});

test('2f81569f T11.AC3 stored rows re-grade identically and the summary is derived from them', async () => {
  const { CASES } = await import('./eval/cases.mjs');
  const { summary, results: rows } = results();
  const byId = new Map(CASES.map((c) => [c.id, c]));
  assert.equal(rows.length, 2 * CASES.length * summary.reps);
  for (const r of rows) assert.equal(grade(r.output, byId.get(r.case).expect).pass, r.pass, `${r.arm} ${r.case} #${r.rep}`);
  const d = summarize(rows, CASES);
  assert.deepEqual({ baseline: summary.baseline, variant: summary.variant, bugDetection: summary.bugDetection }, d);
});

test('2f81569f T11.AC3 blind and static rates are each >= 0.8, outside the halt band, no case at 0/n, beats baseline', () => {
  const { summary } = results();
  assert.ok(summary.reps >= 3);
  const v = summary.variant;
  for (const k of ['staticRate', 'blindRate']) {
    assert.ok(v[k] >= 0.8, `${k} ${v[k]}`);
    assert.ok(!inHaltBand(v[k]), `${k} ${v[k]} in the 0.5-0.8 halt band`);
  }
  for (const [id, frac] of Object.entries(v.perCase)) assert.ok(!frac.startsWith('0/'), `${id} ${frac}`);
  assert.ok(v.passRate - summary.baseline.passRate >= 0.5);
  assert.equal(typeof v.heldOutRate, 'number'); // reported separately
  assert.ok(summary.heldOutCases >= 3);
  assert.equal(v.emptyOutputs, 0);
});

test('2f81569f T11.AC3 golden set covers both modes and the refusal path', async () => {
  const { CASES } = await import('./eval/cases.mjs');
  assert.ok(CASES.length >= 5 && CASES.length <= 20);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  assert.ok(CASES.some((c) => c.mode === 'static'));
  assert.ok(CASES.some((c) => c.mode === 'blind'));
  assert.ok(CASES.some((c) => c.mode === 'blind-deep'));
  assert.ok(CASES.some((c) => c.expect.refused));
  assert.ok(CASES.some((c) => c.heldOut));
});

// ---- AC4 -------------------------------------------------------------------------------
test('2f81569f T11.AC4 manifest declares claude, opencode and agent-mcp with matching versions and concrete model pin', () => {
  assert.deepEqual([...manifest.install.hosts].sort(), ['agent-mcp', 'claude', 'opencode']);
  assert.equal(manifest.render.opencode.mode, 'all');
  assert.match(manifest.render.opencode.model, /^[\w-]+\/[\w.-]+$/);
  assert.equal(manifest.render.claude.version, `v${manifest.version}`);
  assert.equal(JSON.parse(rd('package.json')).version, manifest.version);
  assert.equal(manifest.entrypoint, 'review.md');
  assert.doesNotMatch(prose.slice(0, 4), /^---/); // prose only: host header is generated
  assert.deepEqual(manifest.dependencies ?? [], []);
});

// ---- AC5 -------------------------------------------------------------------------------
test('2f81569f T11.AC5 declares roles-covered:<ID> capabilities that validate against workspace-standards roles.md', () => {
  const schema = JSON.parse(readFileSync(new URL('../../skills/workspace-standards/schemas/roles-covered.schema.json', import.meta.url), 'utf8'));
  const entry = new RegExp(schema.$defs.capabilityEntry.pattern);
  const caps = (manifest.capabilities ?? []).filter((c) => c.startsWith('roles-covered:'));
  assert.ok(caps.length > 0);
  for (const c of caps) assert.match(c, entry);
  const ids = caps.map((c) => c.slice('roles-covered:'.length));
  assert.equal(new Set(ids).size, ids.length);
  const roles = readFileSync(new URL('../../skills/workspace-standards/standards/testing/roles.md', import.meta.url), 'utf8');
  const sr = roles.slice(roles.indexOf('## role: static-reviewer'), roles.indexOf('## role: auditor'));
  for (const id of ids) assert.ok(sr.includes(`- ${id}:`), `${id} is a static-reviewer obligation`);
  assert.deepEqual(ids, ['SR.1', 'SR.2', 'SR.3', 'SR.4']);
  assert.equal(manifest.agent['roles-covered'], undefined); // agent schema rejects unknown keys
});

test('2f81569f T11.AC5 blind-deep receives specification and tests and refuses implementer reasoning (D22)', () => {
  assert.match(prose, /blind-deep/);
  assert.match(prose, /specification and tests/);
  assert.match(prose, /implementer's reasoning/);
});

test('2f81569f T11.AC5 every declared SR id has a checklist line in review.md, and static mode names the SR.2 red run and SR.4 planning record', () => {
  const ids = manifest.capabilities.filter((c) => c.startsWith('roles-covered:')).map((c) => c.slice('roles-covered:'.length));
  const st = prose.slice(prose.indexOf('## Static mode'), prose.indexOf('## Blind modes'));
  for (const id of ids) assert.match(st, new RegExp(`^- \\*\\*${id.replace('.', '\\.')}\\b`, 'm'), `${id} has a checklist line`);
  assert.match(st, /SR\.2 · §6\.5.*recorded red run on a failed assertion/);
  assert.match(st, /SR\.4 · G12.*planning record is present/);
});
