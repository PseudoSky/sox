#!/usr/bin/env node
// 595965cc T41.AC6 (name independence) and T41.AC7 (unbound roles): the testing-specific checks of `review testing`.
// usage: testing-review.mjs --agents-dir <dir> --roles <roles.md> --strategy <STRATEGY.md> [--doc <file>]...
// Exit 1 when a document names an installed agent outside the purpose tags of STRATEGY §2.3. Unbound and
// closeness-0 roles are listed as review debt and do not fail the run.
import fs from 'node:fs';
import { loadAgents, parseRoles, resolveRole, takeOption } from './lib.mjs';

/** The purpose-tag names of STRATEGY §2.3 (the first column of that section's table, every backticked token). */
export function purposeTags(strategyText) {
  const m = /^### 2\.3\b[^\n]*\n([\s\S]*?)(?=^#{1,3} )/m.exec(strategyText);
  if (!m) return null;
  const tags = new Set();
  for (const line of m[1].split('\n')) {
    const first = /^\|([^|]*)\|/.exec(line);
    if (!first) continue;
    for (const t of first[1].matchAll(/`([^`]+)`/g)) tags.add(t[1].split(':')[0].trim());
  }
  return tags;
}

/** Backticked tokens that equal an installed agent name, excluding purpose tags. */
export function nameIndependence({ text, agentNames, exempt }) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const name = m[1].trim();
      if (agentNames.has(name) && !exempt.has(name)) findings.push({ line: i + 1, name });
    }
  });
  return findings;
}

/** Roles that no installed agent holds with coverage: unbound, or held only at closeness 0 (review debt). */
export function unboundRoles({ roles, agents }) {
  const debt = [];
  for (const role of roles) {
    const r = resolveRole(role, agents);
    if (r.holder === null) debt.push({ role: role.name, status: 'unbound', holder: null, obligations: role.obligations.map((o) => o.id) });
    else if (r.rank === 0) debt.push({ role: role.name, status: 'no-declared-coverage', holder: r.holder, obligations: role.obligations.map((o) => o.id) });
  }
  return debt;
}

function main(argv) {
  const agentsOpt = takeOption(argv, '--agents-dir');
  const rolesOpt = takeOption(argv, '--roles');
  const strategyOpt = takeOption(argv, '--strategy');
  const docs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--doc') { docs.push(argv[i + 1]); i++; }
  }
  const usage = agentsOpt.error ?? rolesOpt.error ?? strategyOpt.error
    ?? (!agentsOpt.value || !rolesOpt.value || !strategyOpt.value ? 'usage: testing-review.mjs --agents-dir <dir> --roles <roles.md> --strategy <STRATEGY.md> [--doc <file>]...' : null);
  if (usage) return fail(64, 'E_USAGE', usage);
  const tags = purposeTags(fs.readFileSync(strategyOpt.value, 'utf8'));
  if (!tags) return fail(65, 'E_STRATEGY', 'STRATEGY has no §2.3 purpose-tag section');
  const agents = loadAgents(agentsOpt.value);
  const agentNames = new Set(agents.map((a) => a.agent));
  const roles = parseRoles(fs.readFileSync(rolesOpt.value, 'utf8')).roles;
  const names = [];
  for (const doc of docs) {
    for (const f of nameIndependence({ text: fs.readFileSync(doc, 'utf8'), agentNames, exempt: tags })) names.push({ doc, ...f });
  }
  const unbound = unboundRoles({ roles, agents });
  const ok = names.length === 0;
  process.stdout.write(JSON.stringify({ ok, nameIndependence: names, exemptPurposeTags: [...tags].sort(), reviewDebt: unbound }, null, 2) + '\n');
  return ok ? 0 : 1;
}

function fail(exit, code, message) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code, exit, message } }) + '\n');
  return exit;
}

if (process.argv[1] && process.argv[1].endsWith('testing-review.mjs')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: err.message } }) + '\n');
    process.exit(70);
  }
}
