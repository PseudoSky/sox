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
