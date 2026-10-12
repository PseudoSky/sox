// 595965cc T41.AC5: the conformance level from a binding table, with unbound owners lowering it (T41.AC7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBindingTable, computeLevel, LEVEL_GATES } from '../scripts/testing-level.mjs';

const table = (rows) => [
  '# IMPLEMENTATION', '', '## Binding table', '',
  '| clause | mechanism | command or path | owner | status |', '|---|---|---|---|---|',
  ...rows.map(([clause, owner, status, cmd = 'npm run check']) => `| ${clause} | C2 | ${cmd} | ${owner} | ${status} |`),
].join('\n');
const gates = (ids, owner = 'qa', status = 'enforced') => ids.map((g) => [g, owner, status]);
const ALL = [...LEVEL_GATES.L1, ...LEVEL_GATES.L2, ...LEVEL_GATES.L3];

test('595965cc T41.AC5 the binding table parses by its clause and status header, not by position', () => {
  const rows = parseBindingTable(table(gates(['G1'])));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clause, 'G1');
  assert.equal(rows[0]['command or path'], 'npm run check');
  assert.equal(parseBindingTable('no table here'), null);
});

test('595965cc T41.AC5 every gate of a level enforced gives that level; one missing gate lowers it', () => {
  assert.equal(computeLevel({ rows: parseBindingTable(table(gates(LEVEL_GATES.L1))) }).level, 'L1');
  assert.equal(computeLevel({ rows: parseBindingTable(table(gates([...LEVEL_GATES.L1, ...LEVEL_GATES.L2]))) }).level, 'L2');
  assert.equal(computeLevel({ rows: parseBindingTable(table(gates(ALL))) }).level, 'L3');
  const gap = computeLevel({ rows: parseBindingTable(table(gates(LEVEL_GATES.L1.filter((g) => g !== 'G4')))) });
  assert.equal(gap.level, 'none');
  assert.deepEqual(gap.missing.L1, [{ gate: 'G4', reason: 'no binding row' }]);
});

test('595965cc T41.AC5 an obligation (status not enforced) or a row with no command counts toward no level', () => {
  const r = computeLevel({ rows: parseBindingTable(table([...gates(LEVEL_GATES.L1.slice(1)), ['G1', 'qa', 'obligation']])) });
  assert.equal(r.level, 'none');
  assert.match(r.missing.L1[0].reason, /status "obligation"/);
  const nocmd = parseBindingTable(table(gates(LEVEL_GATES.L1)).replace('| G1 | C2 | npm run check | qa | enforced |', '| G1 | C2 |  | qa | enforced |'));
  assert.equal(computeLevel({ rows: nocmd }).level, 'none');
});

test('595965cc T41.AC7 an owner whose role is unbound or closeness-0 lowers the level', () => {
  const rows = parseBindingTable(table(gates(LEVEL_GATES.L1, 'auditor')));
  assert.equal(computeLevel({ rows, unboundRoles: ['auditor'] }).level, 'none');
  assert.equal(computeLevel({ rows, unboundRoles: [] }).level, 'L1');
});

test('595965cc T41.AC5 the result always lists the manual L1 clauses no row proves', () => {
  const r = computeLevel({ rows: parseBindingTable(table(gates(LEVEL_GATES.L1))) });
  assert.ok(r.manualL1Clauses.length >= 4);
});

test('595965cc T41.AC5 the separator forms | --- | and |:---| and a capitalised status all parse and count', () => {
  const md = ['| clause | mechanism | command or path | owner | status |', '| --- | --- | --- | --- | --- |', '| G1 | C2 | npm run check | qa | Enforced |'].join('\n');
  assert.equal(parseBindingTable(md)[0].clause, 'G1');
  const aligned = md.replace('| --- | --- | --- | --- | --- |', '|:---|:---:|---|---|---:|');
  assert.equal(parseBindingTable(aligned)[0].status, 'Enforced');
  assert.equal(computeLevel({ rows: parseBindingTable(aligned) }).missing.L1.some((m) => m.gate === 'G1'), false, 'G1 counts (Enforced is case-insensitive)');
  assert.equal(computeLevel({ rows: parseBindingTable(table(gates(LEVEL_GATES.L1))).map((r) => ({ ...r, status: 'Enforced' })) }).level, 'L1');
});

test('595965cc T41.AC5 --unbound with no value is E_USAGE (exit 64), not a crash', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const fs2 = await import('node:fs');
  const os = await import('node:os');
  const path2 = await import('node:path');
  const dir = fs2.mkdtempSync(path2.join(os.tmpdir(), 'lvl-'));
  const f = path2.join(dir, 'IMPL.md');
  fs2.writeFileSync(f, table(gates(LEVEL_GATES.L1)));
  const cli = path2.join(path2.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'testing-level.mjs');
  const r = spawnSync(process.execPath, [cli, '--implementation', f, '--unbound'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.equal(JSON.parse(r.stderr).error.code, 'E_USAGE');
});
