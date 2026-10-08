#!/usr/bin/env node
// 9024e9ac T14.AC8
// usage: review-all.mjs [--root <skill root>] [--allow-planned]
// Iterates the registry and reports each registered target lacking a playbook, a conformance
// specification, an apply template, or a declaration. Exit 1 on any finding. A planned standard
// is a finding; --allow-planned demotes findings that are only "planned" to exit 0 (still printed).
import { reviewAll, reviewAllExit, SKILL_ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const root = ri === -1 ? SKILL_ROOT : args[ri + 1];
const allowPlanned = args.includes('--allow-planned');
try {
  const { findings, checked } = reviewAll({ root });
  const code = reviewAllExit(findings, { allowPlanned });
  process.stdout.write(JSON.stringify({ ok: code === 0, checked, allowPlanned, findings }, null, 2) + '\n');
  process.exit(code);
} catch (err) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: err.message } }) + '\n');
  process.exit(1);
}
