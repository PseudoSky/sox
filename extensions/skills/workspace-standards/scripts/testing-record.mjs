#!/usr/bin/env node
// 595965cc T17.AC1-AC3: the filing-boundary check of the testing record (formats/testing-record.md).
// usage: testing-record.mjs --file <item body>
// Exit 0 when the body carries a valid `## Testing record`; exit 1 with the named missing or invalid
// field (backlog-operator returns ESCALATE, or refuses an invalid change-class); exit 64 on usage.
import fs from 'node:fs';

export const CHANGE_CLASSES = ['new-behavior', 'defect-fix', 'refactor', 'configuration', 'dependency', 'boundary-contract', 'no-code', 'test-maintenance'];
export const RIGORS = ['none', 'light', 'standard', 'deep'];

/** Fields of the `## Testing record` section, or null when the body has none. */
export function parseTestingRecord(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Testing record\s*$/.test(l));
  if (start === -1) return null;
  const fields = {};
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(lines[i].trim());
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  return fields;
}

/** Filing-boundary verdict: { ok, errors } where each error names the missing or invalid field. */
export function checkTestingRecord(body) {
  const f = parseTestingRecord(body);
  if (f === null) return { ok: false, errors: ['no "## Testing record" section: the item cannot be filed without one'] };
  const errors = [];
  if (!CHANGE_CLASSES.includes(f['change-class'])) errors.push(`change-class "${f['change-class'] ?? ''}" is not one of ${CHANGE_CLASSES.join(', ')}`);
  if (!RIGORS.includes(f.rigor)) errors.push(`rigor "${f.rigor ?? ''}" is not one of ${RIGORS.join(', ')}`);
  if (!/\bAC\d+\b/.test(f.ac ?? '')) errors.push('ac: names no AC id (expected AC1 <criterion> ; ...)');
  if (!f.plan) errors.push('plan: is missing');
  // formats/testing-record.md: not-testing is required at Standard and Deep, and "none" is a valid answer.
  const notTesting = f['not-testing'];
  const strict = ['standard', 'deep'].includes(f.rigor);
  if (strict && (notTesting === undefined || notTesting === '')) errors.push('not-testing: is missing (required at standard and deep)');
  return { ok: errors.length === 0, errors };
}

function main(argv) {
  const i = argv.indexOf('--file');
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', exit: 64, message: 'usage: testing-record.mjs --file <item body>' } }) + '\n');
    return 64;
  }
  const verdict = checkTestingRecord(fs.readFileSync(argv[i + 1], 'utf8'));
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('testing-record.mjs')) process.exit(main(process.argv.slice(2)));
