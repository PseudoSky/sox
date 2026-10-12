#!/usr/bin/env node
// 595965cc T41.AC5: the conformance level of a repository's testing IMPLEMENTATION, from its binding table.
// Level definitions: STRATEGY §13 (L1 Foundation, L2 Enforced, L3 Measured). The gate sets below are the gates
// each level names; manual clauses in L1 that no binding row can prove are listed, never assumed met.
// Owners whose role is unbound or held at closeness 0 do not count (D17; T41.AC7).
import fs from 'node:fs';

export const LEVEL_GATES = {
  L1: ['G1', 'G2', 'G4', 'G5', 'G6', 'G10', 'G12'],
  L2: ['G3', 'G7', 'G9', 'G11'],
  L3: ['G8'],
};
export const MANUAL_L1_CLAUSES = [
  'stage mapping implemented for at least stages B, D, and E',
  'quarantine and no unrecorded retry (§9)',
  'defect fixes carry regression tests',
  "each role's slice (§13.2) exists",
];

/** Rows of the first markdown table whose header names both `clause` and `status` (case-insensitive). */
export function parseBindingTable(md) {
  const lines = String(md ?? '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = splitRow(lines[i]);
    const sep = splitRow(lines[i + 1]);
    if (!header || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    const cols = header.map((h) => h.toLowerCase());
    if (!cols.includes('clause') || !cols.includes('status')) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitRow(lines[j]);
      if (!cells) break;
      const row = {};
      cols.forEach((c, k) => { row[c] = cells[k] ?? ''; });
      rows.push(row);
    }
    return rows;
  }
  return null;
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/**
 * Level from the binding rows. A gate counts when a row for its id has status `enforced`, a command or path,
 * and an owner that is not in `unboundRoles`. L(n) requires every gate of L1..Ln to count.
 */
export function computeLevel({ rows, unboundRoles = [] }) {
  const unbound = new Set(unboundRoles);
  const counted = new Set();
  const notCounted = {};
  for (const row of rows ?? []) {
    const id = String(row.clause ?? '').trim();
    if (!/^G\d+$/.test(id)) continue;
    const reasons = [];
    const status = String(row.status ?? '').trim().toLowerCase();
    if (status !== 'enforced') reasons.push(`status "${row.status ?? ''}"`);
    if (!row['command or path']) reasons.push('no command or path');
    if (!row.owner) reasons.push('no owner');
    else if (unbound.has(row.owner)) reasons.push(`owner ${row.owner} is unbound or held at closeness 0`);
    if (reasons.length === 0) counted.add(id);
    else notCounted[id] = reasons.join('; ');
  }
  let level = 'none';
  const missing = {};
  for (const L of ['L1', 'L2', 'L3']) {
    const gaps = LEVEL_GATES[L].filter((g) => !counted.has(g));
    if (gaps.length) { missing[L] = gaps.map((g) => ({ gate: g, reason: notCounted[g] ?? 'no binding row' })); break; }
    level = L;
  }
  return { level, missing, manualL1Clauses: MANUAL_L1_CLAUSES };
}

function main(argv) {
  const i = argv.indexOf('--implementation');
  const unboundArg = argv.indexOf('--unbound');
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', exit: 64, message: 'usage: testing-level.mjs --implementation <md> [--unbound <role>,...]' } }) + '\n');
    return 64;
  }
  const rows = parseBindingTable(fs.readFileSync(argv[i + 1], 'utf8'));
  if (rows === null) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_TABLE', exit: 65, message: 'no binding table with clause and status columns' } }) + '\n');
    return 65;
  }
  if (unboundArg !== -1 && (argv[unboundArg + 1] === undefined || argv[unboundArg + 1].startsWith('--'))) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', exit: 64, message: '--unbound needs a comma-separated value (use an empty string for none)' } }) + '\n');
    return 64;
  }
  const unboundRoles = unboundArg === -1 ? [] : argv[unboundArg + 1].split(',').map((s) => s.trim()).filter(Boolean);
  const result = computeLevel({ rows, unboundRoles });
  process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('testing-level.mjs')) process.exit(main(process.argv.slice(2)));
