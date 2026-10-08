#!/usr/bin/env node
// 9024e9ac T14.AC2 T14.AC4 T14.AC5 T14.AC6 T14.AC7
// usage: conformance.mjs <standard id> [--strategy <policy.md>] [--root <skill root>]
// Runs the standard's conformance.spec.json. Without --strategy, clause-id shape is checked but
// existence in the policy is not (the output says so). Exit 1 if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, readJson, runConformance, SKILL_ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const strategy = opt('--strategy');
const root = opt('--root') ?? SKILL_ROOT;
const [id] = args;
if (!id) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', message: 'usage: conformance.mjs <standard id> [--strategy <policy.md>]' } }) + '\n');
  process.exit(64);
}
try {
  const entry = loadRegistry(root).standards.find((s) => s.id === id);
  if (!entry || entry.status !== 'active') {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_UNKNOWN_TARGET', message: `no active standard "${id}"` } }) + '\n');
    process.exit(2);
  }
  const spec = readJson(path.join(root, entry.conformance));
  const report = runConformance({
    root,
    standardDir: path.join(root, path.dirname(entry.declaration)),
    spec,
    strategyText: strategy ? fs.readFileSync(strategy, 'utf8') : null,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: err.message } }) + '\n');
  process.exit(1);
}
