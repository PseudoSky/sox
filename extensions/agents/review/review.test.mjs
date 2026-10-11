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

/** A negative control must be rejected for the EXPECTED reason: `notDeepEqual(findings, [])` passes on any unrelated finding. */
function assertFinding(findings, expected, label) {
  assert.ok(findings.some((f) => expected.test(f)), `${label}: expected a finding matching ${expected}, got ${JSON.stringify(findings)}`);
  assert.ok(findings.length > 0);
}

// ---- AC1 -------------------------------------------------------------------------------
test('2f81569f T11.AC1 shipped manifest is read-only', () => {
  assert.deepEqual(checkReadOnly(manifest), []);
});

for (const [label, mutate, expected] of [
  ['edit tool added', (m) => m.agent.tools.push('edit'), /agent\.tools declares "edit"/],
  ['write tool added', (m) => m.agent.tools.push('write'), /agent\.tools declares "write"/],
  ['bash tool added', (m) => m.agent.tools.push('bash'), /agent\.tools declares "bash"/],
  ['apply_patch added', (m) => m.agent.tools.push('apply_patch'), /agent\.tools declares "apply_patch"/],
  ['claude Write added', (m) => m.render.claude.tools.push('Write'), /render\.claude\.tools declares "Write"/],
  ['claude NotebookEdit added', (m) => m.render.claude.tools.push('NotebookEdit'), /render\.claude\.tools declares "NotebookEdit"/],
  ['edit permission loosened', (m) => { m.agent.permission.edit = 'allow'; }, /^permission\.edit is not "deny"/],
  ['bash permission loosened', (m) => { m.agent.permission.bash = { '*': 'allow' }; }, /^permission\.bash is not "deny"/],
  ['memory server tool added', (m) => m.agent.tools.push({ logical: 'memory', server: 'memory-server' }), /agent\.tools declares a non-core tool object/],
  ...['task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'].map((k) => [`${k} permission loosened`, (m) => { m.agent.permission[k] = 'allow'; }, new RegExp(`^permission\\.${k} is not "deny"`)]),
  ...['task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'].map((k) => [`${k} permission removed`, (m) => { delete m.agent.permission[k]; }, new RegExp(`^permission\\.${k} is not "deny"`)]),
  ['render.opencode.permission replaces the map with edit allowed', (m) => { m.render.opencode.permission = { edit: 'allow', write: 'deny', bash: 'deny' }; }, /render\.opencode\.permission replaces the IR map and omits "edit: deny"/],
  ['render.opencode.permission replaces the map and omits denies', (m) => { m.render.opencode.permission = { read: 'allow' }; }, /render\.opencode\.permission replaces the IR map and omits "write: deny"/],
  ['render.agent-mcp.permissions loosens edit', (m) => { m.render['agent-mcp'].permissions = { edit: 'allow' }; }, /render\.agent-mcp\.permissions\.edit is not "deny"/],
  ['render.agent-mcp grants an MCP server', (m) => { m.render['agent-mcp'].mcpServers = { fs: { command: 'x' } }; }, /render\.agent-mcp\.mcpServers grants MCP servers/],
  ['render.agent-mcp.tools declares bash', (m) => { m.render['agent-mcp'].tools = ['bash']; }, /render\.agent-mcp\.tools declares "bash"/],
]) {
  test(`2f81569f T11.AC1 negative control: ${label} is rejected`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    assertFinding(checkReadOnly(m), expected, label);
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

// ---- cac771f8 AC2 ----------------------------------------------------------------------
// agent-mcp.ts deriveTooling(): `override?.permission` (singular) replaces the IR map and an explicit
// render.agent-mcp.nativeTooling.<member> wins over the derived one, so check-readonly must guard both.
for (const [label, mutate, expected] of [
  ['nativeTooling.shell:true', (m) => { m.render['agent-mcp'].nativeTooling = { shell: true }; }, /nativeTooling\.shell enables shell/],
  ['nativeTooling.shell as an allowCommands object', (m) => { m.render['agent-mcp'].nativeTooling = { shell: { allowCommands: ['ls'] } }; }, /nativeTooling\.shell enables shell/],
  ['nativeTooling.dispatch:true', (m) => { m.render['agent-mcp'].nativeTooling = { dispatch: true }; }, /nativeTooling\.dispatch enables dispatch/],
  ['nativeTooling.dispatch as a gated object', (m) => { m.render['agent-mcp'].nativeTooling = { dispatch: { permissions: { 'agent-mcp.task': 'ask' } } }; }, /nativeTooling\.dispatch enables dispatch/],
  ['nativeTooling.fs:true (fs write)', (m) => { m.render['agent-mcp'].nativeTooling = { fs: true }; }, /nativeTooling\.fs grants fs write/],
  ['nativeTooling.fs object without readOnly', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { permissions: {} } }; }, /nativeTooling\.fs is not readOnly:true/],
  ['nativeTooling.fs readOnly:false', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { readOnly: false } }; }, /nativeTooling\.fs is not readOnly:true/],
  ['nativeTooling.fs readOnly with write_file allowed', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { readOnly: true, permissions: { 'fs.write_file': 'allow' } } }; }, /fs\.permissions\.fs\.write_file is not "deny"/],
  ['nativeTooling.hitl:true', (m) => { m.render['agent-mcp'].nativeTooling = { hitl: true }; }, /nativeTooling\.hitl enables human-input/],
  ['nativeWebTools:true', (m) => { m.render['agent-mcp'].nativeWebTools = true; }, /nativeWebTools enables web access/],
  ['render.agent-mcp.permission (singular) loosens edit', (m) => { m.render['agent-mcp'].permission = { ...m.agent.permission, edit: 'allow' }; }, /render\.agent-mcp\.permission replaces the IR map and omits "edit: deny"/],
  ['render.agent-mcp.permission (singular) omits every deny', (m) => { m.render['agent-mcp'].permission = { read: 'allow' }; }, /render\.agent-mcp\.permission replaces the IR map and omits "bash: deny"/],
  ['render.claude.permission (singular) loosens bash', (m) => { m.render.claude.permission = { ...m.agent.permission, bash: { '*': 'allow' } }; }, /render\.claude\.permission replaces the IR map and omits "bash: deny"/],
  ['render.agent-mcp.permission grants memory_*', (m) => { m.render['agent-mcp'].permission = { ...m.agent.permission, 'memory_*': 'allow' }; }, /render\.agent-mcp\.permission\.memory_\* is not "deny"/],
  ['render.opencode.permissions grants mcp__x__*', (m) => { m.render.opencode.permissions = { 'mcp__x__*': 'allow' }; }, /render\.opencode\.permissions\.mcp__x__\* is not "deny"/],
]) {
  test(`cac771f8 AC2 negative control: ${label} is rejected`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    assertFinding(checkReadOnly(m), expected, label);
  });
}

test('cac771f8 AC2 read-only render overrides are accepted (no over-rejection)', () => {
  const m = structuredClone(manifest);
  m.render['agent-mcp'].nativeTooling = {
    shell: false,
    dispatch: false,
    hitl: false,
    fs: { readOnly: true, permissions: { 'fs.write_file': 'deny', 'fs.edit_file': 'deny' } },
  };
  m.render['agent-mcp'].nativeWebTools = false;
  m.render['agent-mcp'].permission = { ...m.agent.permission };
  assert.deepEqual(checkReadOnly(m), []);
  m.render['agent-mcp'].nativeTooling = { fs: false };
  assert.deepEqual(checkReadOnly(m), []);
});

test('cac771f8 AC2 the CLI exits 1 on a nativeTooling.shell:true manifest and 0 on the shipped one', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const script = join(here, 'check-readonly.mjs');
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 0);
  const bad = structuredClone(manifest);
  bad.render['agent-mcp'].nativeTooling = { shell: true };
  const f = join(mkdtempSync(join(tmpdir(), 'review-ro-')), 'extension.json');
  writeFileSync(f, JSON.stringify(bad));
  const r = spawnSync(process.execPath, [script, f], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nativeTooling\.shell enables shell/);
});

// ---- cac771f8 AC2 hardening (static-review findings) -----------------------------------
// Fail-closed: capabilities are checked against an allow-list, so names the checker has never seen are findings.
for (const [label, mutate, expected] of [
  ['wildcard permission rule "*": allow', (m) => { m.agent.permission['*'] = 'allow'; }, /^permission\.\* is a wildcard rule/],
  ['wildcard permission rule "*": ask', (m) => { m.agent.permission['*'] = 'ask'; }, /^permission\.\* is a wildcard rule/],
  ['glob-suffixed wildcard "tool_*": allow', (m) => { m.agent.permission['tool_*'] = 'allow'; }, /^permission\.tool_\* is a wildcard rule/],
  ['patch permission allowed', (m) => { m.agent.permission.patch = 'allow'; }, /^permission\.patch grants an unrecognised capability/],
  ['multiedit permission allowed', (m) => { m.agent.permission.multiedit = 'allow'; }, /^permission\.multiedit grants an unrecognised capability/],
  ['apply_patch permission allowed', (m) => { m.agent.permission.apply_patch = 'allow'; }, /^permission\.apply_patch grants an unrecognised capability/],
  ['github permission allowed', (m) => { m.agent.permission.github = 'allow'; }, /^permission\.github grants an unrecognised capability/],
  ['render.opencode.permission wildcard allow', (m) => { m.render.opencode.permission = { ...m.agent.permission, '*': 'allow' }; }, /^render\.opencode\.permission\.\* is a wildcard rule/],
  ['render.agent-mcp.permissions wildcard allow', (m) => { m.render['agent-mcp'].permissions = { '*': 'allow' }; }, /^render\.agent-mcp\.permissions\.\* is a wildcard rule/],
  ['agent.tools declares dispatch', (m) => { m.agent.tools.push('dispatch'); }, /agent\.tools declares "dispatch"/],
  ['agent.tools declares shell', (m) => { m.agent.tools.push('shell'); }, /agent\.tools declares "shell"/],
  ['agent.tools declares agent-catalog (dispatch capability)', (m) => { m.agent.tools.push('agent-catalog'); }, /agent\.tools declares "agent-catalog"/],
  ['agent.tools declares multiedit', (m) => { m.agent.tools.push('multiedit'); }, /agent\.tools declares "multiedit"/],
  ['render.claude.tools declares Task', (m) => { m.render.claude.tools.push('Task'); }, /render\.claude\.tools declares "Task"/],
  ['render.claude.tools declares Bash', (m) => { m.render.claude.tools.push('Bash'); }, /render\.claude\.tools declares "Bash"/],
  ['permission.task as an allow-list map (spawns a writer)', (m) => { m.agent.permission.task = { '*': 'deny', typescript: 'allow' }; }, /^permission\.task delegates to typescript/],
  ['render.opencode.permission.task as an allow-list map', (m) => { m.render.opencode.permission = { ...m.agent.permission, task: { debug: 'allow' } }; }, /^render\.opencode\.permission\.task delegates to debug/],
  ['render.agent-mcp.permissions.allowedAgents', (m) => { m.render['agent-mcp'].permissions = { allowedAgents: ['typescript'] }; }, /permissions\.allowedAgents delegates to other agents/],
  ['render.agent-mcp.permissions.allowedAgents as a non-array', (m) => { m.render['agent-mcp'].permissions = { allowedAgents: 'typescript' }; }, /permissions\.allowedAgents delegates to other agents/],
  ['nativeTooling.fs.permissions wildcard allow', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { readOnly: true, permissions: { 'fs.*': 'allow' } } }; }, /fs\.permissions\.fs\.\* is not "deny"/],
  ['nativeTooling.fs.permissions move_file allowed', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { readOnly: true, permissions: { 'fs.move_file': 'ask' } } }; }, /fs\.permissions\.fs\.move_file is not "deny"/],
  ['nativeTooling unknown native member', (m) => { m.render['agent-mcp'].nativeTooling = { git: true }; }, /nativeTooling\.git grants an unrecognised native member/],
  ['claudecli provider allowedBuiltinTools grants Bash', (m) => { m.render['agent-mcp'].provider = { type: 'claudecli', allowedBuiltinTools: ['Read', 'Bash'] }; }, /allowedBuiltinTools declares "Bash"/],
  ['claudecli provider allowedBuiltinTools grants Write', (m) => { m.render['agent-mcp'].provider = { type: 'claudecli', allowedBuiltinTools: ['Write'] }; }, /allowedBuiltinTools declares "Write"/],
]) {
  test(`cac771f8 AC2 hardening: ${label} is rejected`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    assertFinding(checkReadOnly(m), expected, label);
  });
}

test('cac771f8 AC2 hardening: read-only grants stay accepted (allow-list is not over-strict)', () => {
  const m = structuredClone(manifest);
  m.agent.tools.push('list', 'Glob');
  m.agent.permission.list = 'allow';
  m.agent.permission.external_directory = 'allow';
  m.render['agent-mcp'].permissions = { allowedAgents: [] };
  m.render['agent-mcp'].provider = { type: 'claudecli', allowedBuiltinTools: ['Read', 'Grep', 'Glob'] };
  m.render['agent-mcp'].nativeTooling = { fs: { readOnly: true, permissions: { 'fs.read_file': 'allow', 'fs.list_directory': 'ask', 'fs.search_files': 'allow', 'fs.write_file': 'deny' } } };
  assert.deepEqual(checkReadOnly(m), []);
});

// A null/garbled field must yield a NAMED `malformed:` finding, never a thrown TypeError.
for (const [label, mutate, expected] of [
  ['render.opencode.permission: null', (m) => { m.render.opencode.permission = null; }, /^malformed: render\.opencode\.permission must be an object \(got null\)/],
  ['render.agent-mcp.permissions: null', (m) => { m.render['agent-mcp'].permissions = null; }, /^malformed: render\.agent-mcp\.permissions must be an object \(got null\)/],
  ['agent.permission: null', (m) => { m.agent.permission = null; }, /^malformed: agent\.permission must be an object \(got null\)/],
  ['agent.permission: array', (m) => { m.agent.permission = []; }, /^malformed: agent\.permission must be an object \(got an array\)/],
  ['agent.tools: a string (would iterate characters)', (m) => { m.agent.tools = 'read'; }, /^malformed: agent\.tools must be an array \(got string\)/],
  ['agent.tools: null', (m) => { m.agent.tools = null; }, /^malformed: agent\.tools must be an array \(got null\)/],
  ['render.claude.tools: an object', (m) => { m.render.claude.tools = { 0: 'Read' }; }, /^malformed: render\.claude\.tools must be an array/],
  ['render.claude: null', (m) => { m.render.claude = null; }, /^malformed: render\.claude must be an object \(got null\)/],
  ['render: null', (m) => { m.render = null; }, /^malformed: render must be an object \(got null\)/],
  ['agent: null', (m) => { m.agent = null; }, /^malformed: agent must be an object \(got null\)/],
  ['render.agent-mcp.nativeTooling: null', (m) => { m.render['agent-mcp'].nativeTooling = null; }, /^malformed: render\.agent-mcp\.nativeTooling must be an object \(got null\)/],
  ['nativeTooling.fs.permissions: null', (m) => { m.render['agent-mcp'].nativeTooling = { fs: { readOnly: true, permissions: null } }; }, /^malformed: render\.agent-mcp\.nativeTooling\.fs\.permissions must be an object/],
  ['provider.allowedBuiltinTools: a string', (m) => { m.render['agent-mcp'].provider = { type: 'claudecli', allowedBuiltinTools: 'Bash' }; }, /^malformed: render\.agent-mcp\.provider\.allowedBuiltinTools must be an array/],
]) {
  test(`cac771f8 AC2 hardening: ${label} is a named malformed finding, not a crash`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    let findings;
    assert.doesNotThrow(() => { findings = checkReadOnly(m); });
    assertFinding(findings, expected, label);
  });
}

test('cac771f8 AC2 hardening: a non-object manifest is a malformed finding (null, array, number)', () => {
  for (const bad of [null, [], 7, 'x']) {
    assert.deepEqual(checkReadOnly(bad), [`malformed: manifest must be an object (got ${bad === null ? 'null' : Array.isArray(bad) ? 'an array' : typeof bad})`]);
  }
});

test('cac771f8 AC2 hardening: CLI exit codes 0 ok / 1 violation / 2 unreadable / 3 malformed, and never a stack trace', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const script = join(here, 'check-readonly.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'review-ro-cli-'));
  const run = (content) => {
    const f = join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, content);
    return spawnSync(process.execPath, [script, f], { encoding: 'utf8' });
  };
  const ok = run(JSON.stringify(manifest));
  assert.equal(ok.status, 0);
  const violation = structuredClone(manifest);
  violation.agent.permission['*'] = 'allow';
  const v = run(JSON.stringify(violation));
  assert.equal(v.status, 1);
  assert.match(v.stderr, /wildcard rule/);
  const unreadable = run('{not json');
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /cannot read/);
  const nullPerm = structuredClone(manifest);
  nullPerm.render.opencode.permission = null;
  const mal = run(JSON.stringify(nullPerm));
  assert.equal(mal.status, 3);
  assert.match(mal.stderr, /MALFORMED[\s\S]*render\.opencode\.permission must be an object \(got null\)/);
  for (const r of [v, unreadable, mal]) assert.doesNotMatch(r.stderr, /TypeError|\n\s+at /, 'no stack trace');
  assert.equal(run('null').status, 3);
});

test('cac771f8 AC2 hardening: the shipped review manifest passes its own check via the CLI path (exit 0, no stderr)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(here, 'check-readonly.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
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
  assert.match(prose, /Static mode uses only Read, Grep, and Glob/);
  assert.ok(prose.indexOf('Static mode uses only Read') <prose.indexOf('## Blind modes'));
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

test('2f81569f T11.AC3 + 595965cc T22 eval/run.mjs carries an unconditional HARD STOP: process.exit(64) at top level, before any spawn, with no bypass', () => {
  const run = readFileSync(join(here, 'eval/run.mjs'), 'utf8');
  const stop = run.indexOf('// HARD STOP');
  const exit = run.indexOf('process.exit(64);');
  assert.ok(stop >= 0 && exit > stop, 'HARD STOP block precedes process.exit(64)');
  assert.doesNotMatch(run.slice(stop, exit), /\bif\b/, 'the stop is not inside a conditional');
  assert.match(run, /^process\.exit\(64\);$/m, 'the exit is a top-level statement');
  assert.ok(run.search(/spawn\(/) > exit, 'stop precedes the first spawn');
  assert.doesNotMatch(run, /process\.env\.\w*ALLOW/, 'no environment bypass exists');
});

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

// ---- review correction (blind-review C2) ----------------------------------------------------
test('2f81569f T11 review.md: static-tools sentence is well formed and the +start rule covers a context first line', () => {
  assert.doesNotMatch(prose, /Static mode may read:/);
  assert.match(prose, /Static mode uses only Read, Grep, and Glob; Read every cited file before judging it\./);
  assert.match(prose, /`\+start` is the number of the hunk's first body line, whether that line is context or added/);
  assert.match(prose, /removed \(`-`\) lines are never counted/);
});
