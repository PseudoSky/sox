#!/usr/bin/env node
/**
 * check-plan-packets — the plan's task packets must stay machine-executable.
 *
 * Written 2026-08-01 after the packet section shipped in a state where it READ as
 * complete and was not:
 *   - 0 of 44 packets declared an output, while 8 of them were consumed by others
 *     (PKT-02 alone gated five downstream packets without stating its interface);
 *   - `depends_on` mixed dependency data with prose rationale, so 13 of 44 fields
 *     parsed differently depending on the parser, inventing phantom cycles
 *     (PKT-28<->PKT-29, PKT-35<->PKT-36, and a PKT-26 self-edge). An orchestrator
 *     would have deadlocked on packets that were actually free to start;
 *   - one packet's `acceptance` label was rewritten for emphasis and stopped parsing.
 *
 * Every check below exists because that specific thing was wrong. This is the same
 * discipline as tools/check-backlog-markers.mjs: the document is a machine input,
 * so a human-readable-only document is a broken one.
 *
 * Usage: node tools/check-plan-packets.mjs
 * Exit 0 = conformant. Non-zero = the state machine cannot be trusted.
 */
import { readFileSync } from 'node:fs';

const PLAN = 'docs/reporting/memory/PLAN.md';
const BACKLOG = 'BACKLOG.md';
const REQUIRED = ['requires', 'tier', 'Closes', 'Files', 'acceptance', 'budget', 'orientation'];

const plan = readFileSync(PLAN, 'utf8');
const backlog = readFileSync(BACKLOG, 'utf8');
const violations = [];

// ── parse packets ────────────────────────────────────────────────────────────
const blocks = plan.split(/(?=^### PKT-)/m).filter((b) => b.startsWith('### PKT-'));
const packets = new Map();
for (const b of blocks) {
  const id = b.match(/^### (PKT-\d+)/)[1];
  if (packets.has(id)) violations.push(`${id}: duplicate packet id`);
  const field = (name) => {
    const m = b.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*([^\\n]*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  packets.set(id, {
    requires: field('requires'),
    tier: field('tier'),
    closes: field('Closes'),
    files: field('Files'),
    acceptance: field('acceptance'),
    produces: field('Produces'),
    budget: field('budget'),
    orientation: field('orientation'),
    body: b,
  });
}

// ── 1. required fields present and parseable ─────────────────────────────────
for (const [id, p] of packets) {
  for (const f of REQUIRED) {
    const key = f === 'Closes' ? 'closes' : f === 'Files' ? 'files' : f;
    if (!p[key]) violations.push(`${id}: missing or unparseable **${f}:** field`);
  }
  // `requires` is DATA — it must be `none` or bare packet ids, never prose.
  // Rationale belongs in **sequencing:**, which is free-form by design.
  if (p.requires && p.requires !== 'none') {
    const stripped = p.requires.replace(/PKT-\d+/g, '').replace(/[,\s]/g, '');
    if (stripped.length > 0) {
      violations.push(
        `${id}: **requires:** contains prose ("${p.requires}") — put rationale in **sequencing:**. ` +
          `A parser reading this field will derive edges that do not exist.`,
      );
    }
  }
  // A budget without a hard ceiling is a suggestion, and suggestions do not stop
  // an agent at 450k holding uncommitted work.
  // A ceiling BELOW the measured orientation cost is a trap, not a budget: the
  // first dispatch gave PKT-01 120k against a 93k orientation, leaving 27k for a
  // CRITICAL architectural change, and every agent blew through immediately.
  if (p.budget && p.orientation) {
    const o = p.orientation.match(/~(\d+)k/);
    const c = p.budget.match(/ceiling ~(\d+)k/);
    if (o && c && Number(c[1]) <= Number(o[1])) {
      violations.push(
        `${id}: guidance ceiling ${c[1]}k is at or below its ${o[1]}k orientation cost — ` +
          `that leaves nothing for the work itself.`,
      );
    }
  }
  if (p.tier && !/^(haiku|sonnet|opus)\b/.test(p.tier)) {
    violations.push(`${id}: tier must start with haiku|sonnet|opus, got "${p.tier}"`);
  }
}

// ── 2. edges resolve, and the graph is a DAG ─────────────────────────────────
const edges = new Map();
for (const [id, p] of packets) {
  const deps = p.requires === 'none' ? [] : (p.requires ?? '').match(/PKT-\d+/g) ?? [];
  for (const d of deps) {
    if (!packets.has(d)) violations.push(`${id}: requires ${d}, which does not exist`);
  }
  edges.set(id, deps.filter((d) => packets.has(d)));
}
const state = new Map();
const walk = (n, stack) => {
  if (stack.includes(n)) {
    violations.push(`dependency CYCLE: ${[...stack.slice(stack.indexOf(n)), n].join(' -> ')}`);
    return;
  }
  if (state.get(n)) return;
  for (const d of edges.get(n) ?? []) walk(d, [...stack, n]);
  state.set(n, true);
};
for (const id of packets.keys()) walk(id, []);

// ── 3. anything others depend on MUST declare what it hands over ─────────────
// This is the check that would have caught PKT-02 gating five packets while
// never stating its interface.
const dependedUpon = new Set([...edges.values()].flat());
for (const id of dependedUpon) {
  if (!packets.get(id)?.produces) {
    const consumers = [...edges].filter(([, d]) => d.includes(id)).map(([c]) => c);
    violations.push(
      `${id}: ${consumers.length} packet(s) depend on it (${consumers.join(', ')}) but it declares no ` +
        `**Produces:** — a dependent cannot be written or verified against an undefined output.`,
    );
  }
}

// ── 4. every open backlog item is assigned or explicitly excluded ────────────
// Presence of the id ANYWHERE in the plan is NOT coverage — that mistake was made
// twice and reported as "FULL COVERAGE" both times.
const openIds = [...backlog.matchAll(/^### (BL-\d+) .*$/gm)]
  .filter((m) => /\*\*(Open|REOPENED|BLOCKED)/.test(m[0]))
  .map((m) => m[1]);
const closed = new Set();
for (const m of plan.matchAll(/\*\*Closes:\*\*([^\n]*)/g)) {
  for (const id of m[1].match(/BL-\d+/g) ?? []) closed.add(id);
}
const excluded = new Set();
for (const m of plan.matchAll(/(?:OUT OF SCOPE|NO packet)([\s\S]*?)(?=\n## |$)/gi)) {
  for (const id of m[1].match(/BL-\d+/g) ?? []) excluded.add(id);
}
for (const id of openIds) {
  if (!closed.has(id) && !excluded.has(id)) {
    violations.push(`${id}: open in BACKLOG.md but on no packet's **Closes:** line and in no exclusion list`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  const free = [...edges.values()].filter((d) => d.length === 0).length;
  console.log(
    `check-plan-packets: OK — ${packets.size} packets, ${free} unblocked, DAG acyclic, ` +
      `${openIds.length} open items all assigned or excluded.`,
  );
  process.exit(0);
}
for (const v of violations) console.error(`  FAIL  ${v}`);
console.error(`\ncheck-plan-packets: ${violations.length} violation(s).`);
process.exit(1);
