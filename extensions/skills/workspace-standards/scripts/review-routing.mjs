#!/usr/bin/env node
// 9024e9ac T14.AC10 (and T14.AC7: roles.md must parse and validate)
// usage: review-routing.mjs --agents-dir <dir of agent extensions> --roles <roles.md>
// Reports each agent with no roles-covered declaration, each declared id roles.md does not define,
// and each roles.md hint that matches no installed agent.
import fs from 'node:fs';
import { loadAgents, takeOption, obligationIds, parseRoles, reviewRouting, validateRoles } from './lib.mjs';

const args = process.argv.slice(2);
const agentsOpt = takeOption(args, '--agents-dir');
const rolesOpt = takeOption(args, '--roles');
const agentsDir = agentsOpt.value;
const rolesFile = rolesOpt.value;
const usageError = agentsOpt.error ?? rolesOpt.error ?? (!agentsDir || !rolesFile ? 'usage: review-routing.mjs --agents-dir <dir> --roles <roles.md>' : null);
if (usageError) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', exit: 64, message: usageError } }) + '\n');
  process.exit(64);
}
try {
  const parsed = parseRoles(fs.readFileSync(rolesFile, 'utf8'));
  const roleErrors = validateRoles(parsed);
  const { findings, agents } = reviewRouting({ agents: loadAgents(agentsDir), obligations: obligationIds(parsed), roles: parsed });
  const all = [...roleErrors.map((detail) => ({ agent: null, id: 'invalid-roles-md', detail })), ...findings];
  process.stdout.write(JSON.stringify({ ok: all.length === 0, agents, findings: all }, null, 2) + '\n');
  process.exit(all.length === 0 ? 0 : 1);
} catch (err) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: err.message } }) + '\n');
  process.exit(1);
}
