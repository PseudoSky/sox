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
// Part 2 (the tie to installs, ADR-0026 D2/D5): the root `AGENTS.md` `## Capabilities`
// section must carry exactly one row per distinct `agent.tools[].logical` an installed
// agent declares — no key no manifest declares, none missing. The manifests are the
// source of truth; `soxe install` renders the same logical→server pair into each agent
// body, so the section and the installed agents cannot disagree.
//
// Exit 0 = clean. Exit 1 = a body names a tool, the section disagrees with the
// manifests, or a self-test failed.

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
const declared = new Set();
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

  for (const tool of manifest?.agent?.tools ?? []) {
    if (tool && typeof tool === 'object' && typeof tool.logical === 'string') {
      declared.add(tool.logical);
    }
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

// Parse the capability keys from an `## Capabilities` markdown table.
// Returns a Set of keys, or null when the section has no table.
function readCapabilitySection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Capabilities\s*$/.test(l.trim()));
  if (start === -1) return null;
  const found = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const key = cells[1];
    if (!key || /^-+$/.test(key) || key.toLowerCase() === 'capability') continue;
    found.add(key);
  }
  return found;
}

// Section-parser self-test (the authentic pre-fix shape: a section missing a declared key).
const SECTION_PRE_FIX =
  '## Capabilities\n\n| capability | tool | usage |\n|---|---|---|\n' +
  '| backlog | backlog | `backlog` skill |\n';
const parsedPreFix = readCapabilitySection(SECTION_PRE_FIX);
if (
  !parsedPreFix ||
  !parsedPreFix.has('backlog') ||
  parsedPreFix.has('memory')
) {
  console.error(
    'check-agent-capability-refs: SELF-TEST FAILED — the `## Capabilities` parser does ' +
      'not read the table correctly. Refusing to grade.',
  );
  process.exit(1);
}

const agentsMdPath = join(ROOT, 'AGENTS.md');
if (existsSync(agentsMdPath)) {
  const section = readCapabilitySection(readFileSync(agentsMdPath, 'utf8'));
  if (section === null) {
    failures.push('AGENTS.md: missing the `## Capabilities` section (ADR-0026 D2)');
  } else {
    for (const key of declared) {
      if (!section.has(key)) {
        failures.push(`AGENTS.md ## Capabilities: no row for declared capability '${key}'`);
      }
    }
    for (const key of section) {
      if (!declared.has(key)) {
        failures.push(
          `AGENTS.md ## Capabilities: row '${key}' is not a logical any agent manifest declares`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-agent-capability-refs: ${failures.length} capability-ref defect(s) ` +
      '(ADR-0026: bodies name capabilities; the project `## Capabilities` section binds ' +
      'exactly the logicals the manifests declare):',
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  'check-agent-capability-refs: OK — no agent body names a third-party tool, and ' +
    `AGENTS.md ## Capabilities binds exactly the ${declared.size} declared logical(s).`,
);
