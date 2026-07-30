#!/usr/bin/env node

/**
 * deepseek-comprehensive.mjs
 *
 * COMPREHENSIVE EMPIRICAL VALIDATION of content-first vs role-first economics.
 *
 * Replaces the simulation in content-first-proof.mjs with real DeepSeek API calls.
 * Measures actual cache hit/miss tokens per round from the provider's response.
 *
 * MODES:
 *   (default)           Run only the 6-round sequential comparison
 *   --scenario <name>   Run a specific scenario by name
 *   --all               Run all scenarios (expensive — 50+ API calls)
 *   --list              List available scenarios
 *
 * Each scenario runs in two phases:
 *   Phase 1: Role-first (different system prompt per role)
 *   Phase 2: Content-first (empty system, role suffix at end)
 *   Phases are separated by a 60-second cache cooldown to isolate measurements.
 *
 * SCENARIO: 6-Round Sequential Loop (realistic dev cycle)
 *   R1: Architect proposes design
 *   R2: Security engineer reviews
 *   R3: Architect revises based on security feedback
 *   R4: Platform engineer reviews for operational concerns
 *   R5: Architect revises for platform
 *   R6: Compliance officer final review
 *
 *   This alternates roles (architect↔other) to stress the "same system prompt
 *   cache hit" claim in role-first. The architect repeats on R1, R3, R5 with
 *   the same system prompt but growing context — tests whether prefix caching
 *   helps when the prompt content changes substantially.
 *
 * Requires: DEEPSEEK_API_KEY environment variable
 */

import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET;
const BASE = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-chat';
const CACHE_COOLDOWN_MS = 60_000; // Between RF and CF phases
const MAX_OUTPUT_TOKENS = 600;    // Keep responses manageable for sequential loop
const TEMPERATURE = 0;            // Deterministic

const PRICING = {
  // DeepSeek pricing (as of July 2026)
  // https://api-docs.deepseek.com/quick_start/pricing
  inputPer1K: 0.00027,      // Cache miss
  cacheHitPer1K: 0.00007,   // Cache hit (~74% discount)
  outputPer1K: 0.00110,
};

// ─────────────────────────────────────────────────────────────
// DeepSeek API Client
// ─────────────────────────────────────────────────────────────

async function deepseekCall({ system, messages }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    messages: system
      ? [{ role: 'system', content: system }, ...messages]
      : messages,
  };

  const start = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const elapsed = Date.now() - start;

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }

  const u = data.usage || {};
  return {
    inputTokens: u.prompt_tokens || 0,
    cacheHit: u.prompt_cache_hit_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    uncachedInput: (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0),
    latencyMs: elapsed,
    text: data.choices?.[0]?.message?.content || '',
  };
}

// ─────────────────────────────────────────────────────────────
// Round Result
// ─────────────────────────────────────────────────────────────

class RoundResult {
  constructor(label, response, roleName) {
    this.label = label;
    this.roleName = roleName;
    this.inputTokens = response.inputTokens;
    this.cacheHit = response.cacheHit;
    this.uncachedInput = response.uncachedInput;
    this.outputTokens = response.outputTokens;
    this.latencyMs = response.latencyMs;
    this.text = response.text;
  }

  get cacheHitRate() {
    return this.inputTokens > 0 ? this.cacheHit / this.inputTokens : 0;
  }

  get cost() {
    const uncachedCost = this.uncachedInput / 1000 * PRICING.inputPer1K;
    const cachedCost = this.cacheHit / 1000 * PRICING.cacheHitPer1K;
    const outputCost = this.outputTokens / 1000 * PRICING.outputPer1K;
    return uncachedCost + cachedCost + outputCost;
  }

  formatCost() {
    return `$${this.cost.toFixed(6)}`;
  }

  summary() {
    return `${this.label.padEnd(30)} tokens=${this.inputTokens}  cache_hit=${this.cacheHit}  uncached=${this.uncachedInput}  latency=${this.latencyMs}ms  cost=${this.formatCost()}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Scenario: 6-Round Sequential Dev Loop
// ─────────────────────────────────────────────────────────────

const SEQUENTIAL_6 = {
  name: '6-Round Sequential Dev Loop',
  description: [
    'Realistic software development iteration: Architect proposes, Security reviews,',
    'Architect revises, Platform reviews, Architect revises, Compliance approves.',
    'The architect repeats on R1, R3, R5 — testing whether same-system-prompt caching',
    'helps in role-first when the context grows each round.',
  ].join(' '),
  seed: `
Namespace isolation architecture decision:

Option A (single store): All tenants share one database. A namespace_resolver middleware
extracts the tenant ID from the request and injects it as a WHERE clause on every query.
Pros: Simple, single connection pool, easy to deploy. Cons: No physical isolation, WHERE
clause must be present on EVERY query — a missing WHERE leaks data.

Option B (per-tenant store): Each tenant gets their own SQLite database. The namespace_resolver
opens a connection to the correct database file. Pros: Physical isolation, no WHERE clause
risk, databases can be backed up independently. Cons: Many open connections, file descriptor
pressure, no cross-tenant queries.

Option C (split enforcement): Store layer enforces isolation (separate databases per namespace).
Middleware layer resolves namespace to connection string. No namespace info ever appears on
the wire. The stack is: HTTP → namespace_resolver → auth → handler → store.
Pros: Defense in depth (two layers must fail), clean separation. Cons: Two components to
operate, namespace_resolver is a mandatory middleware in every route.

Decision: Option C for v1.0. The mandatory middleware is acceptable because every route
requires namespace context anyway. Per-tenant databases provide the strongest isolation
guarantee. Migration path: shared namespace for development, isolated for production.
  `,
  rounds: [
    {
      label: 'R1: Architect',
      roleName: 'Architect',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. Evaluate the three namespace isolation options (A: single store, B: per-tenant store, C: split enforcement). Choose one and explain your reasoning in terms of abstraction boundaries, fault isolation, and future flexibility. Output 3-5 paragraphs.',
    },
    {
      label: 'R2: Security Review',
      roleName: 'Security Engineer',
      sysPrompt: 'You are a security engineer reviewing multi-tenant architectures for data leakage and isolation vulnerabilities.',
      roleSuffix: 'You are a security engineer. Review the proposed namespace design. Focus on data leakage paths, WHERE-clause enforcement risks, physical isolation guarantees, and any attack surface introduced by the shared namespace deployment mode. Flag specific concerns. Output 3-5 paragraphs.',
    },
    {
      label: 'R3: Architect Revise',
      roleName: 'Architect',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. The security review has raised concerns. Revise the namespace design to address the security feedback while maintaining architectural integrity. Explain what changed and why. Output 3-5 paragraphs.',
    },
    {
      label: 'R4: Platform Review',
      roleName: 'Platform Engineer',
      sysPrompt: 'You are a platform engineer who operates multi-tenant infrastructure at scale. Evaluate operational burden, scaling characteristics, and deployment complexity.',
      roleSuffix: 'You are a platform engineer. Review the revised namespace design for operational concerns: connection management at scale, monitoring surface, deployment complexity with per-tenant databases, and the shared→isolated migration path. Output 3-5 paragraphs.',
    },
    {
      label: 'R5: Architect Finalize',
      roleName: 'Architect',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. Incorporate the platform engineer\'s operational feedback into the final namespace design. Address connection scaling, monitoring, and migration. Present the final architecture decision with rationale. Output 3-5 paragraphs.',
    },
    {
      label: 'R6: Compliance Approve',
      roleName: 'Compliance Officer',
      sysPrompt: 'You are a compliance officer evaluating system architecture against regulatory requirements (SOC2, HIPAA). Focus on auditability and evidence.',
      roleSuffix: 'You are a compliance officer. Perform a final compliance review of the namespace isolation design. Assess whether the split enforcement model provides sufficient evidence for SOC2 Type II audits, what controls are needed, and whether any residual risk must be accepted. Output 3-5 paragraphs.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────
// Scenario Runner
// ─────────────────────────────────────────────────────────────

async function runRoleFirst(scenario) {
  console.log(`\n  ── Role-First (different system prompt per round) ──`);
  const results = [];
  let combined = scenario.seed;

  for (let i = 0; i < scenario.rounds.length; i++) {
    const round = scenario.rounds[i];
    const messages = [{ role: 'user', content: combined }];

    const resp = await deepseekCall({ system: round.sysPrompt, messages });
    const result = new RoundResult(
      `${round.label}  sys="${round.sysPrompt.split('.')[0].slice(0, 50)}"`,
      resp,
      round.roleName
    );
    results.push(result);
    console.log(`    ${result.summary()}`);

    // Append this round's output for the next round
    combined += `\n\n${round.roleName} output:\n${resp.text}`;
  }

  return results;
}

async function runContentFirst(scenario) {
  console.log(`\n  ── Content-First (empty system, role suffix at end) ──`);
  const results = [];
  let combined = scenario.seed;

  for (let i = 0; i < scenario.rounds.length; i++) {
    const round = scenario.rounds[i];
    const content = `${combined}\n\n${round.roleSuffix}`;
    const messages = [{ role: 'user', content }];

    const resp = await deepseekCall({ messages }); // No system prompt
    const result = new RoundResult(
      `${round.label}`,
      resp,
      round.roleName
    );
    results.push(result);
    console.log(`    ${result.summary()}`);

    // Append this round's output for the next round
    combined += `\n\n${round.roleName} output:\n${resp.text}`;
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// Comparison Report
// ─────────────────────────────────────────────────────────────

function formatCost(cost) {
  return `$${cost.toFixed(6)}`;
}

function generateComparison(scenario, rfResults, cfResults) {
  const lines = [];

  lines.push(`\n══════════════════════════════════════════════════════════════════`);
  lines.push(`  ${scenario.name}`);
  lines.push(`══════════════════════════════════════════════════════════════════\n`);

  lines.push('  Per-Round Comparison:');
  lines.push('  ─────────────────────────────────────────────────────────────────────────────');
  lines.push('  Round          │  RF: uncached/cached(cost)        │  CF: uncached/cached(cost)');
  lines.push('  ───────────────┼────────────────────────────────────┼────────────────────────────────────');

  for (let i = 0; i < scenario.rounds.length; i++) {
    const rf = rfResults[i];
    const cf = cfResults[i];
    const role = scenario.rounds[i].roleName;

    const rfStr = `${rf.uncachedInput}t unc / ${rf.cacheHit}t cached (${rf.formatCost()})`;
    const cfStr = `${cf.uncachedInput}t unc / ${cf.cacheHit}t cached (${cf.formatCost()})`;
    const rfRole = role === scenario.rounds[i-1]?.roleName ? ' (repeat)' : '';

    lines.push(`  ${`R${i+1}: ${role}${rfRole}`.padEnd(16)}│  ${rfStr.padEnd(36)}│  ${cfStr}`);
  }

  lines.push('  ───────────────┴────────────────────────────────────┴────────────────────────────────────');

  // Totals
  const rfTotalUncached = rfResults.reduce((s, r) => s + r.uncachedInput, 0);
  const rfTotalCached = rfResults.reduce((s, r) => s + r.cacheHit, 0);
  const rfTotalTokens = rfResults.reduce((s, r) => s + r.inputTokens, 0);
  const rfTotalLatency = rfResults.reduce((s, r) => s + r.latencyMs, 0);
  const rfTotalCost = rfResults.reduce((s, r) => s + r.cost, 0);

  const cfTotalUncached = cfResults.reduce((s, r) => s + r.uncachedInput, 0);
  const cfTotalCached = cfResults.reduce((s, r) => s + r.cacheHit, 0);
  const cfTotalTokens = cfResults.reduce((s, r) => s + r.inputTokens, 0);
  const cfTotalLatency = cfResults.reduce((s, r) => s + r.latencyMs, 0);
  const cfTotalCost = cfResults.reduce((s, r) => s + r.cost, 0);

  const savings = rfTotalCost > 0 ? (1 - cfTotalCost / rfTotalCost) * 100 : 0;

  lines.push('');
  lines.push('  Summary:');
  lines.push(`    Total input tokens:   RF=${rfTotalTokens}  CF=${cfTotalTokens}`);
  lines.push(`    Total uncached:       RF=${rfTotalUncached}  CF=${cfTotalUncached}`);
  lines.push(`    Total cached:         RF=${rfTotalCached}  CF=${cfTotalCached}`);
  lines.push(`    Total latency (ms):   RF=${rfTotalLatency}  CF=${cfTotalLatency}`);
  lines.push(`    Total cost:           RF=${formatCost(rfTotalCost)}  CF=${formatCost(cfTotalCost)}`);
  lines.push(`    CF caching ratio:     ${(cfTotalCached / cfTotalTokens * 100).toFixed(1)}% of input tokens cached`);
  lines.push(`    RF caching ratio:     ${(rfTotalCached / rfTotalTokens * 100).toFixed(1)}% of input tokens cached`);
  lines.push(`    Cost savings:         ${savings.toFixed(1)}%`);

  // Round-level analysis
  lines.push('');
  lines.push('  Round-by-round cache analysis:');
  for (let i = 0; i < scenario.rounds.length; i++) {
    const rf = rfResults[i];
    const cf = cfResults[i];
    const role = scenario.rounds[i].roleName;
    const isRepeat = i > 0 && role === scenario.rounds[i-1].roleName;

    const rfStatus = rf.cacheHit > 0
      ? `✅ cached ${rf.cacheHit}t (${(rf.cacheHit / rf.inputTokens * 100).toFixed(0)}%)`
      : `❌ 0 cached`;
    const cfStatus = cf.cacheHit > 0
      ? `✅ cached ${cf.cacheHit}t (${(cf.cacheHit / cf.inputTokens * 100).toFixed(0)}%)`
      : `❌ 0 cached`;

    lines.push(`    R${i+1} ${role.padEnd(18)} RF: ${rfStatus.padEnd(30)} CF: ${cfStatus}${isRepeat ? '  (same role as earlier round)' : ''}`);
  }

  // Key claims
  lines.push('');
  lines.push('  Claims:');

  // Claim 1: CF caches more than RF in sequential loop
  if (cfTotalCached > rfTotalCached) {
    lines.push(`    ✅ CF cached ${cfTotalCached}t vs RF cached ${rfTotalCached}t — ${((cfTotalCached - rfTotalCached) / rfTotalCached * 100).toFixed(0)}% more`);
  } else {
    lines.push(`    ⚠️  RF cached ${rfTotalCached}t vs CF cached ${cfTotalCached}t`);
  }

  // Claim 2: RF same-role repeats get cache hits
  const rfRepeats = rfResults.filter((_, i) => i > 0 && scenario.rounds[i].roleName === scenario.rounds[i-1].roleName);
  const rfRepeatHits = rfRepeats.filter(r => r.cacheHit > 0);
  if (rfRepeatHits.length > 0) {
    lines.push(`    ✅ RF same-role repeats: ${rfRepeatHits.length}/${rfRepeats.length} got cache hits`);
  } else if (rfRepeats.length > 0) {
    lines.push(`    ❌ RF same-role repeats: 0/${rfRepeats.length} got cache hits (context grew past cache) — KEY FINDING`);
  }

  // Claim 3: CF role switches get cache hits
  const cfFirstRound = cfResults[0];
  const cfLaterRounds = cfResults.slice(1);
  const cfHits = cfLaterRounds.filter(r => r.cacheHit > 0);
  lines.push(`    ✅ CF role switches: ${cfHits.length}/${cfLaterRounds.length} subsequent rounds got cache hits`);

  // Claim 4: Each round compounds
  const cfCompounding = cfResults.slice(2).filter((r, i) => r.cacheHit > cfResults[i+1]?.cacheHit);
  // Actually let me check if cache hits increase monotonically
  const cfMonotonic = cfResults.slice(1).every((r, i) => i === 0 || r.cacheHit >= cfResults[i].cacheHit);
  if (cfMonotonic && cfResults.length > 2) {
    lines.push(`    ✅ CF cache grows monotonically: each round cached more (or equal) than the last`);
  }

  // Claim 5: Cost comparison
  if (savings > 0) {
    lines.push(`    ✅ CF saves ${savings.toFixed(1)}% over RF ($${(rfTotalCost - cfTotalCost).toFixed(6)} absolute)`);
  }

  lines.push('');
  lines.push(`  Model: ${MODEL} | Temperature: ${TEMPERATURE} | Cooldown: ${CACHE_COOLDOWN_MS}ms`);
  lines.push(`  Seed: ${scenario.seed.trim().length} chars | Max output: ${MAX_OUTPUT_TOKENS}t per round`);
  lines.push('');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Run one scenario
// ─────────────────────────────────────────────────────────────

async function runScenario(scenario) {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  ${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(`  ${scenario.rounds.length} rounds in sequence`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  // Phase 1: Role-first
  console.log(`  Phase 1: Starting RF (cold cache)...`);
  const rfResults = await runRoleFirst(scenario);

  console.log(`\n  Phase 1 complete. Waiting ${CACHE_COOLDOWN_MS / 1000}s for cache expiry...`);
  await new Promise(r => setTimeout(r, CACHE_COOLDOWN_MS));

  // Phase 2: Content-first
  console.log(`\n  Phase 2: Starting CF (cold cache, after cooldown)...`);
  const cfResults = await runContentFirst(scenario);

  // Comparison
  console.log(generateComparison(scenario, rfResults, cfResults));

  return { rfResults, cfResults };
}

// ─────────────────────────────────────────────────────────────
// Available Scenarios
// ─────────────────────────────────────────────────────────────

const ALL_SCENARIOS = {
  'sequential-6': SEQUENTIAL_6,
};

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
deepseek-comprehensive.mjs — Empirical validation of content-first vs role-first

USAGE:
  node deepseek-comprehensive.mjs [options]

OPTIONS:
  (default)           Run the 6-round sequential experiment only
  --scenario <name>   Run a specific scenario by name
  --all               Run all available scenarios
  --list              List available scenarios
  --help, -h          Show this help

REQUIRES:
  DEEPSEEK_API_KEY environment variable

PRICING (DeepSeek, July 2026):
  Cache miss input:  $0.00027/1K tokens
  Cache hit input:   $0.00007/1K tokens
  Output:            $0.00110/1K tokens

  Estimated cost per scenario: ~$0.01-0.02 (12 API calls × ~500-3000 tokens)
`);
}

function listScenarios() {
  console.log('\nAvailable scenarios:\n');
  for (const [key, scenario] of Object.entries(ALL_SCENARIOS)) {
    console.log(`  ${key}`);
    console.log(`    ${scenario.description}`);
    console.log(`    ${scenario.rounds.length} rounds`);
    console.log('');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (args.includes('--list')) {
    listScenarios();
    return;
  }

  if (!API_KEY) {
    console.error('\n  ERROR: DEEPSEEK_API_KEY not set.');
    console.error('  Set it in your environment: export DEEPSEEK_API_KEY="sk-..."\n');
    process.exit(1);
  }

  let scenariosToRun;

  if (args.includes('--all')) {
    scenariosToRun = Object.entries(ALL_SCENARIOS);
  } else if (args.includes('--scenario')) {
    const idx = args.indexOf('--scenario');
    const name = args[idx + 1];
    if (!ALL_SCENARIOS[name]) {
      console.error(`Unknown scenario: ${name}`);
      listScenarios();
      process.exit(1);
    }
    scenariosToRun = [[name, ALL_SCENARIOS[name]]];
  } else {
    // Default: 6-round sequential
    scenariosToRun = [['sequential-6', ALL_SCENARIOS['sequential-6']]];
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  DEEPSEEK COMPREHENSIVE EXPERIMENT`);
  console.log(`  Model: ${MODEL} | Temperature: ${TEMPERATURE}`);
  console.log(`  Scenarios: ${scenariosToRun.length} | Rounds: ${scenariosToRun.reduce((s, [,sc]) => s + sc.rounds.length, 0)}`);
  console.log(`  Estimated cost: ~$${((scenariosToRun.reduce((s, [,sc]) => s + sc.rounds.length, 0) * 2 * 0.003)).toFixed(3)}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  for (const [name, scenario] of scenariosToRun) {
    await runScenario(scenario);
  }

  console.log(`\n  All experiments complete.`);
  console.log(`  Total API calls: ${scenariosToRun.reduce((s, [,sc]) => s + sc.rounds.length * 2, 0)}`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
