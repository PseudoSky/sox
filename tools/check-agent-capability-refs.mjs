#!/usr/bin/env node
// check-agent-capability-refs.mjs — ADR-0026
//
// Fails an agent BODY that names a concrete third-party tool instead of a capability.
// A capability (backlog, memory, code-intel) is bound to a tool in the project's
// `## Capabilities` section; the body must never carry the tool's name or host prefix.
//
// Scope: the manifest's entrypoint file only. CHANGELOG.md / README.md / extension.json
// are not agent bodies and are never scanned.
//
// Exit 0 = clean. Exit 1 = a body names a tool, or the detector self-test failed.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const AGENTS_DIR = join(ROOT, 'extensions', 'agents');

// Deliberately narrow: `*_` verbs, host prefixes, and known tool / CLI names.
const PATTERNS = [
  /\bbacklog_[a-z0-9_]+\b/,
  /\bmemory_[a-z0-9_]+\b/,
  /\bgitnexus_[a-z0-9_]+\b/,
  /\bmcp__[A-Za-z0-9_-]+\b/,
  /\badhd-backlog\b/,
  /\bmemory-server_[a-z0-9_]+\b/,
  /\bmemory-server\b/,
  /\bgitnexus\b/,
];

function matchesAny(line) {
  return PATTERNS.some((re) => re.test(line));
}

// Self-test: the authentic pre-fix shapes must match; capability-phrased lines must not.
// If this fails the detector is broken and must not be used to grade anyone.
const MUST_HIT = [
  'call backlog_create to file it',
  'use memory_recall for context',
  'mcp__backlog__backlog_query',
  'run adhd-backlog backlog create',
  'gitnexus_impact on the symbol',
];
const MUST_MISS = [
  'record this in the backlog',
  'recall context with the memory capability',
  'load the code-intel usage skill',
];
if (!MUST_HIT.every(matchesAny) || MUST_MISS.some(matchesAny)) {
  console.error(
    'check-agent-capability-refs: SELF-TEST FAILED — detector does not match the pre-fix ' +
      'shape, or matches a capability-phrased line. Refusing to grade.',
  );
  process.exit(1);
}

if (!existsSync(AGENTS_DIR)) {
  console.log('check-agent-capability-refs: no extensions/agents — nothing to check.');
  process.exit(0);
}

const failures = [];
for (const dirent of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const dir = join(AGENTS_DIR, dirent.name);
  const manifestPath = join(dir, 'extension.json');
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    failures.push(`${dirent.name}/extension.json: unparseable (${err.message})`);
    continue;
  }

  const entry = manifest.entrypoint || `${dirent.name}.md`;
  const bodyPath = join(dir, entry);
  if (!existsSync(bodyPath)) {
    failures.push(`${dirent.name}/${entry}: entrypoint missing`);
    continue;
  }

  const lines = readFileSync(bodyPath, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (matchesAny(line)) failures.push(`${dirent.name}/${entry}:${i + 1}: ${line.trim()}`);
  });
}

if (failures.length > 0) {
  console.error(
    `check-agent-capability-refs: ${failures.length} raw tool reference(s) in agent bodies ` +
      '(ADR-0026: reference the capability, bind the tool in the project `## Capabilities` section):',
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log('check-agent-capability-refs: OK — no agent body names a third-party tool.');
