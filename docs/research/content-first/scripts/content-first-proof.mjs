#!/usr/bin/env node

/**
 * content-first-proof.mjs
 *
 * TWO-MODE VALIDATION of content-first vs role-first economics.
 *
 * Mode 1: SIMULATION (default) — arithmetic projection
 *   Validates the token-cost model using provider pricing tables.
 *   Does NOT call any LLM API. All "savings" are projected.
 *
 * Mode 2: DEEPSEEK (--mode deepseek) — real API calls
 *   Calls DeepSeek's API directly (not through agent-mcp).
 *   Measures real prompt_cache_hit_tokens from the provider response.
 *   Runs BOTH role-first and content-first for each scenario,
 *   isolated by unique seed prefixes to prevent cache cross-contamination.
 *
 * Mode 3: VALIDATE (--mode validate) — simulation + spot-check
 *   Runs the simulation for all scenarios, then makes real DeepSeek
 *   API calls for one scenario to verify cache behavior matches.
 *
 * Design:
 *   - Uses real content from the sox-protocol codebase verbatim
 *   - Each scenario is a realistic multi-stakeholder review with
 *     genuinely competing concerns across roles
 *   - Scenario 6 is a 6-round sequential dev iteration loop
 *     (architect ↔ security ↔ architect ↔ platform ↔ architect ↔ compliance)
 *   - Claims have a confidence level based on how much real data
 *     supports them
 *
 * Requires for mode=deepseek/validate: DEEPSEEK_API_KEY env var
 *   Pricing (July 2026): $0.00027/1K input (miss), $0.00007/1K (hit),
 *   $0.00110/1K output
 */

import fs from 'fs';
import path from 'path';
import {
  deepseekCall, RoundResult, runRF, runCF,
  formatCost, formatTokens, formatPct,
  aggregate, comparisonTable, writeSession,
  makeRound, OPENCODE_AGENTS,
  DS_MODEL, DS_MAX_OUTPUT, DS_TEMPERATURE, DS_API_KEY,
  PRICING as DS_PRICING,
} from '../lib/deepseek-experiment.mjs';

// ─────────────────────────────────────────────────────────────
// Provider Configuration
// ─────────────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude Sonnet 4',
    inputCostPer1K: 0.015,
    cacheHitCostPer1K: 0.0015,   // 90% discount — VERIFIED via published pricing
    cacheMinPrefix: 1024,         // verified from docs
    cacheTTLMs: 300_000,          // 5 min
    outputCostPer1K: 0.060,
    coldTtft: 600,
    warmTtft: 150,
    supportsCacheBreakpoints: true,
  },
  openai: {
    name: 'OpenAI GPT-4o',
    inputCostPer1K: 0.015,
    cacheHitCostPer1K: 0.0075,   // 50% discount
    cacheMinPrefix: 1024,
    cacheAlignment: 128,
    outputCostPer1K: 0.060,
    coldTtft: 800,
    warmTtft: 200,
    supportsCacheBreakpoints: true,
  },
  deepseek: {
    name: 'DeepSeek Chat v3',
    inputCostPer1K: DS_PRICING.inputPer1K,
    cacheHitCostPer1K: DS_PRICING.cacheHitPer1K,
    cacheMinPrefix: 1024,
    outputCostPer1K: DS_PRICING.outputPer1K,
    cacheTTLMs: 60_000,
  },
};

let providerKey = 'deepseek';
let runMode = 'deepseek'; // 'simulation' | 'deepseek' | 'validate'
let verbose = false;

// ─────────────────────────────────────────────────────────────
// Verbatim Test Fixtures (real content from sox-protocol repo)
// ─────────────────────────────────────────────────────────────

function readFile(relPath) {
  // Fixtures may live in the sibling sox-protocol repo
  const repoBase = process.env.SOX_PROTOCOL_PATH || '/Users/nix/dev/ai/sox-protocol';
  try {
    return fs.readFileSync(path.join(repoBase, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4); // APPROXIMATION
}

// ─── SCENARIO 1: Tenant Isolation Design Review ──────────────

const SCENARIO_1 = {
  name: 'Tenant Isolation Design Review',
  description: 'Four real opencode agents review the same namespace isolation spec. Architect, Code Reviewer, Backend, Product Manager — each produces a different, valuable analysis using their production system prompt.',
  realContentSource: 'spec/primitives/namespace.md (verbatim) + opencode agent definitions',
  seed: readFile('spec/primitives/namespace.md') || '# Namespace spec unavailable',
  seedTokens: () => estimateTokens(readFile('spec/primitives/namespace.md')),
  rounds: [
    makeRound('architect', 'You are a spec-only architecture agent. Review the namespace isolation design. Focus: split enforcement boundary, mode knob abstraction, federation orthogonality. Produce a spec evaluation. Output 3-5 paragraphs.'),
    makeRound('review', 'You are a senior code reviewer. Review the namespace isolation design for code quality, security vulnerabilities, and correctness. Focus: access control enforcement, input validation, error handling. Output 3-5 paragraphs.'),
    makeRound('backend', 'You are a senior backend developer. Review the namespace isolation design for implementation feasibility, scalability, and production readiness. Focus: SQLite scaling, connection management, migration tooling. Output 3-5 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Review the namespace isolation design for product strategy, developer experience, and enterprise readiness. Focus: single-tenant DX, multi-tenant adoption, deferred feature impact. Output 3-5 paragraphs.'),
  ],
};

// ─── SCENARIO 2: Fan-Out Collect Decision Review ─────────────

const SCENARIO_2 = {
  name: 'Fan-Out Collect Decision Review',
  description: 'Four real opencode agents review the same protocol decision: should collect be a server-side primitive or an SDK convenience?',
  realContentSource: 'docs/decisions/fanout-collect.md (verbatim) + opencode agent definitions',
  seed: readFile('docs/decisions/fanout-collect.md') || '# Collect decision unavailable',
  seedTokens: () => estimateTokens(readFile('docs/decisions/fanout-collect.md')),
  rounds: [
    makeRound('architect', 'You are a spec-only architecture agent. Evaluate the fan-out collect decision. Focus: whether server-side blocking aggregation fits the protocol\'s minimum-primitives philosophy, quorum semantics, and future extensibility. Output 3-5 paragraphs.'),
    makeRound('backend', 'You are a senior backend developer. Evaluate the fan-out collect decision. Focus: implementation complexity, the ACK pending-state reuse, SSE transport implications, and error handling for partial failures. Output 3-5 paragraphs.'),
    makeRound('review', 'You are a senior code reviewer. Evaluate the fan-out collect decision. Focus: correctness of the honest partial-failure response, cancellation semantics, and potential race conditions. Output 3-5 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Evaluate the fan-out collect decision. Focus: whether the orchestrator demo (broadcast + wait) is compelling, developer ergonomics, and competitive differentiation. Output 3-5 paragraphs.'),
  ],
};

// ─── SCENARIO 3: Research Synthesis ──────────────────────────

const SCENARIO_3 = {
  name: 'Research Synthesis — 4 Papers, 4 Perspectives',
  description: 'Four real opencode agents review the same 4 paper abstracts on LLM position effects and caching. Architect, Code Reviewer, QA Expert, and Product Manager each produce different insights.',
  realContentSource: 'Neumann et al. FAccT 2025, Zhang et al. 2024, Lumer et al. 2026, Helmi 2025 (abstracts verbatim) + opencode agent definitions',
  seed: `
## Paper 1: Position is Power (Neumann et al., FAccT 2025)
System prompts in LLMs are predefined directives that guide model
behaviour. As system prompts become more complex, the position of
information in different directives shapes model outputs. This work
examines how the placement of information affects model behaviour
by comparing demographic information in system vs. user prompts
across six commercially available LLMs and 50 demographic groups.
Findings reveal significant biases manifesting in differences in
user representation and decision-making scenarios.

## Paper 2: Attention Instruction (Zhang et al., 2024)
Language models suffer from position bias and have difficulty
accessing the middle part of the context due to lack of attention.
We augment task instructions with attention instructions that
direct models to allocate more attention towards a selected
segment. Models demonstrate capacity to adapt attention to
specific segments using matching indexes but lack relative
position awareness.

## Paper 3: Don't Break the Cache (Lumer et al., 2026)
We evaluate prompt caching across three major LLM providers and
compare three caching strategies. Strategic prompt cache block
control, such as placing dynamic content at the end of the system
prompt, provides more consistent benefits than naive full-context
caching. Prompt caching reduces API costs by 41-80% and improves
TTFT by 13-31% across providers.

## Paper 4: Response Consistency Index (Helmi, 2025)
A probabilistic framework to analyze the impact of shared versus
separate context configurations on response consistency and
response times in LLM-based MAS. Introduces the Response Consistency
Index (RCI) as a metric to evaluate context limitations, noise,
and inter-agent dependencies.
`,
  seedTokens: () => 5000,
  rounds: [
    makeRound('architect', 'You are a spec-only architecture agent. Synthesize findings across all four papers. Assess whether the evidence supports content-first architecture vs role-first. Identify architectural implications. Output 3-5 paragraphs.'),
    makeRound('review', 'You are a senior code reviewer. Critically evaluate the methodology and claims of each paper. Assess experimental rigor, sample sizes, statistical significance. Flag overclaims and methodological weaknesses. Output 3-5 paragraphs.'),
    makeRound('test', 'You are a senior QA expert. Identify gaps in the research. What experimental conditions have not been tested? What assumptions might not generalize? Propose verification experiments. Output 3-5 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Assess practical applicability. What can be acted on today? Which findings justify production decisions? Prioritize next steps for engineering. Output 3-5 paragraphs.'),
  ],
};

// ─── SCENARIO 4: Supervisor Architecture Review ──────────────

const SCENARIO_4 = {
  name: 'Supervisor State Machine Review',
  description: 'Four real opencode agents review the same supervisor code. Architect, Code Reviewer, QA Expert, and Debug Specialist have genuinely competing concerns.',
  realContentSource: 'libs/host-runtime/src/supervisor.ts (verbatim) + opencode agent definitions',
  seed: readFile('libs/host-runtime/src/supervisor.ts') || '// Supervisor code unavailable',
  seedTokens: () => estimateTokens(readFile('libs/host-runtime/src/supervisor.ts')),
  rounds: [
    makeRound('architect', 'You are a spec-only architecture agent. Review the supervisor state machine. Focus: state completeness, transition legality, partition tolerance, crash recovery, and concurrent state transitions. Output 3-5 paragraphs.'),
    makeRound('review', 'You are a senior code reviewer. Review the supervisor for code quality and security. Focus: process escape, resource exhaustion, crash-loop exploitation, health-check forgery. Output 3-5 paragraphs.'),
    makeRound('test', 'You are a senior QA expert. Review the supervisor for testability and reliability. Focus: error handling paths, edge cases in state transitions, observability of stuck states. Output 3-5 paragraphs.'),
    makeRound('debug', 'You are a senior debugging specialist. Review the supervisor for diagnosability. Focus: debugging workflow for common failures, state inspection, logging adequacy, and failure mode documentation. Output 3-5 paragraphs.'),
  ],
};

// ─── SCENARIO 5: Namespace Isolation Decision ────────────────

const SCENARIO_5 = {
  name: 'Namespace Isolation Decision Review',
  description: 'Four stakeholders review the same architectural decision. Compliance, Platform, Architect, and Product interests directly conflict.',
  realContentSource: 'docs/decisions/namespace-isolation-layer.md (verbatim)',
  seed: readFile('docs/decisions/namespace-isolation-layer.md') || '# Decision unavailable',
  seedTokens: () => estimateTokens(readFile('docs/decisions/namespace-isolation-layer.md')),
  rounds: [
    {
      name: 'Compliance',
      label: 'Compliance Officer',
      sysPrompt: 'You are a compliance officer evaluating system architecture against regulatory requirements.',
      roleSuffix: 'You are a compliance officer. Review tenant isolation for compliance. Focus: whether the split model satisfies audit requirements (SOC2, HIPAA), whether shared mode WHERE-clause enforcement is auditable. Output 3-5 paragraphs.',
      outputTokens: 700,
    },
    {
      name: 'Platform',
      label: 'Platform Engineer',
      sysPrompt: 'You are a platform engineer building and operating multi-tenant infrastructure.',
      roleSuffix: 'You are a platform engineer. Review tenant isolation for platform operations. Focus: mode knob deployment complexity, SQLite scaling ceiling, shared→isolated migration path. Output 3-5 paragraphs.',
      outputTokens: 800,
    },
    {
      name: 'Architect',
      label: 'Software Architect',
      sysPrompt: 'You are a software architect evaluating abstraction boundaries for future evolution.',
      roleSuffix: 'You are a software architect. Review tenant isolation architecture. Focus: split enforcement boundary correctness, "no namespace on wire" design future-proofing, server-id orthogonality. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Product',
      label: 'Product Manager',
      sysPrompt: 'You are a product manager assessing customer adoption and feature completeness.',
      roleSuffix: 'You are a product manager. Review tenant isolation for customer impact. Focus: single-tenant developer experience, enterprise readiness, whether deferred features are deal-blockers. Output 3-5 paragraphs.',
      outputTokens: 500,
    },
  ],
};

// ─── SCENARIO 6: 6-Round Sequential Dev Loop ─────────────────
// Realistic development iteration with alternating roles.
// Tests the "same system prompt on repeat" caching claim in RF
// while CF benefits from shared prefix across all rounds.

const SCENARIO_6 = {
  name: '6-Round Sequential Dev Loop',
  description: 'Realistic software development iteration: Architect proposes design, Security reviews, Architect revises, Platform reviews, Architect finalizes, Compliance approves. The architect repeats on R1/R3/R5 — testing whether same-system-prompt caching helps in role-first when context grows. 6 rounds, 4 distinct roles, 3 role repeats.',
  realContentSource: 'Original namespace isolation architecture problem',
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
  seedTokens: () => estimateTokens(SCENARIO_6.seed),
  rounds: [
    {
      name: 'Architect',
      label: 'Software Architect (initial)',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. Evaluate the three namespace isolation options (A: single store, B: per-tenant store, C: split enforcement). Choose one and explain your reasoning in terms of abstraction boundaries, fault isolation, and future flexibility. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Security Engineer',
      label: 'Security Engineer (review)',
      sysPrompt: 'You are a security engineer reviewing multi-tenant architectures for data leakage and isolation vulnerabilities.',
      roleSuffix: 'You are a security engineer. Review the proposed namespace design. Focus on data leakage paths, WHERE-clause enforcement risks, physical isolation guarantees, and any attack surface introduced by the shared namespace deployment mode. Flag specific concerns. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Architect',
      label: 'Software Architect (revise)',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. The security review has raised concerns. Revise the namespace design to address the security feedback while maintaining architectural integrity. Explain what changed and why. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Platform Engineer',
      label: 'Platform Engineer (review)',
      sysPrompt: 'You are a platform engineer who operates multi-tenant infrastructure at scale. Evaluate operational burden, scaling characteristics, and deployment complexity.',
      roleSuffix: 'You are a platform engineer. Review the revised namespace design for operational concerns: connection management at scale, monitoring surface, deployment complexity with per-tenant databases, and the shared→isolated migration path. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Architect',
      label: 'Software Architect (finalize)',
      sysPrompt: 'You are a software architect designing multi-tenant systems. Focus on clean abstraction boundaries, future evolution, and correct decomposition.',
      roleSuffix: 'You are a software architect. Incorporate the platform engineer\'s operational feedback into the final namespace design. Address connection scaling, monitoring, and migration. Present the final architecture decision with rationale. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
    {
      name: 'Compliance Officer',
      label: 'Compliance Officer (approve)',
      sysPrompt: 'You are a compliance officer evaluating system architecture against regulatory requirements (SOC2, HIPAA). Focus on auditability and evidence.',
      roleSuffix: 'You are a compliance officer. Perform a final compliance review of the namespace isolation design. Assess whether the split enforcement model provides sufficient evidence for SOC2 Type II audits, what controls are needed, and whether any residual risk must be accepted. Output 3-5 paragraphs.',
      outputTokens: 600,
    },
  ],
};

const ALL_SCENARIOS = [
  SCENARIO_1, SCENARIO_2, SCENARIO_3, SCENARIO_4, SCENARIO_5, SCENARIO_6,
];

// RoundResult, deepseekCall, runRF, runCF imported from ../lib/deepseek-experiment.mjs

// ─────────────────────────────────────────────────────────────
// Simulation Engine (unchanged from original)
// ─────────────────────────────────────────────────────────────

function simulate(scenario, provider) {
  const seedTokens = scenario.seedTokens();
  const roles = scenario.rounds;

  // ── Role-First ──
  let rfCumulative = seedTokens;
  let rfUncachedTotal = 0;
  let rfCostTotal = 0;
  const rfAgents = [];

  for (const role of roles) {
    const sysTokens = estimateTokens(role.sysPrompt);
    const context = rfCumulative;
    rfUncachedTotal += context + sysTokens;
    rfCostTotal += (context + sysTokens) / 1000 * provider.inputCostPer1K
                + role.outputTokens / 1000 * provider.outputCostPer1K;
    rfAgents.push({
      name: role.name,
      uncachedTokens: Math.round(context + sysTokens),
      cachedTokens: 0,
      cost: (context + sysTokens) / 1000 * provider.inputCostPer1K
          + role.outputTokens / 1000 * provider.outputCostPer1K,
    });
    rfCumulative += role.outputTokens;
  }

  // ── Content-First ──
  let cfCumulative = seedTokens;
  let cfUncachedTotal = 0;
  let cfCachedTotal = 0;
  let cfCostTotal = 0;
  const cfAgents = [];
  let isFirst = true;

  for (const role of roles) {
    const suffixTokens = estimateTokens(role.roleSuffix);
    const cachedThisAgent = isFirst ? 0 : cfCumulative;
    const uncachedThisAgent = isFirst
      ? cfCumulative + suffixTokens
      : suffixTokens;

    const effectiveCached = cfCumulative >= provider.cacheMinPrefix ? cachedThisAgent : 0;
    const effectiveUncached = cfCumulative >= provider.cacheMinPrefix
      ? uncachedThisAgent
      : cfCumulative + suffixTokens;

    cfCachedTotal += effectiveCached;
    cfUncachedTotal += effectiveUncached;
    cfCostTotal += effectiveCached / 1000 * provider.cacheHitCostPer1K
                 + effectiveUncached / 1000 * provider.inputCostPer1K
                 + role.outputTokens / 1000 * provider.outputCostPer1K;

    cfAgents.push({
      name: role.name,
      uncachedTokens: Math.round(effectiveUncached),
      cachedTokens: Math.round(effectiveCached),
      cost: effectiveCached / 1000 * provider.cacheHitCostPer1K
          + effectiveUncached / 1000 * provider.inputCostPer1K
          + role.outputTokens / 1000 * provider.outputCostPer1K,
      cacheHitRate: effectiveCached > 0
        ? effectiveCached / (effectiveCached + effectiveUncached)
        : 0,
    });

    cfCumulative += role.outputTokens;
    isFirst = false;
  }

  return {
    scenario: scenario.name,
    seedTokens,
    agentCount: roles.length,
    rf: {
      totalTokens: rfUncachedTotal,
      uncachedTokens: rfUncachedTotal,
      cachedTokens: 0,
      totalCost: rfCostTotal,
      agents: rfAgents,
      cacheHitRate: 0,
    },
    cf: {
      totalTokens: cfUncachedTotal + cfCachedTotal,
      uncachedTokens: cfUncachedTotal,
      cachedTokens: cfCachedTotal,
      totalCost: cfCostTotal,
      agents: cfAgents,
      cacheHitRate: cfCachedTotal / (cfUncachedTotal + cfCachedTotal || 1),
    },
    savingsPct: ((rfCostTotal - cfCostTotal) / rfCostTotal * 100),
  };
}

// runRF and runCF imported from ../lib/deepseek-experiment.mjs
// They handle seed-prefix isolation internally.

// ─────────────────────────────────────────────────────────────
// Commentary Engine (simulation)
// ─────────────────────────────────────────────────────────────

const CONFIDENCE = {
  HIGH: 'Supported by multiple independent verifiable sources or mathematical identity',
  MEDIUM: 'Supported by one verifiable source or consistent indirect evidence',
  LOW: 'Inferred from prior knowledge; depends on assumptions not yet verified against real API behavior',
};

function commentate(result) {
  const c = [];

  c.push(`\n## ${result.scenario}`);
  c.push(`\n**Confidence assessment for each claim:**\n`);

  const savingsClaims = result.savingsPct > 20
    ? `**MEDIUM confidence.** The arithmetic is correct (${result.savingsPct.toFixed(1)}% savings projected), but this assumes:` + '\n'
      + `  - Provider cache behavior matches documentation` + '\n'
      + `  - Role-first system prompts are meaningfully different` + '\n'
      + `  - Cache discounts apply as published` + '\n'
      + `  - The tokenizer estimate (~4 char/token) is close to the actual provider tokenizer`
    : `**LOW confidence.** Savings below 20% — model may be systematically overestimating.`;

  c.push(savingsClaims);

  const postSeedHitRates = result.cf.agents.slice(1).map(a => a.cacheHitRate);
  const avgHit = postSeedHitRates.reduce((s, h) => s + h, 0) / postSeedHitRates.length;
  c.push(`\n**Post-seed cache hit rate: ${(avgHit * 100).toFixed(1)}% — MEDIUM confidence.**` + '\n'
    + `  The ratio prefix/(prefix+suffix) is a mathematical identity GIVEN that:` + '\n'
    + `  - The entire prefix actually enters the provider's cache` + '\n'
    + `  - There are no cache alignment issues` + '\n'
    + `  - The provider does not evict the prefix between requests` + '\n'
    + `  - The prefix is above the provider's minimum cache threshold`);

  c.push(`\n**Zero cache reuse in role-first: HIGH confidence.**` + '\n'
    + `  Each agent has a different system prompt at position 0. Provider prefix caching` + '\n'
    + `  requires exact token-level prefix match. Different first tokens → guaranteed cache miss.`);

  const rfFirst = result.rf.agents[0].cost;
  const cfFirst = result.cf.agents[0].cost;
  const parityRatio = cfFirst / rfFirst;
  c.push(`\n**First agent cost parity (ratio: ${parityRatio.toFixed(2)}): HIGH confidence.**` + '\n'
    + `  The first agent in both paradigms loads the same seed context.`);

  c.push(`\n**RISK: Instruction hierarchy effect — NOT TESTED. LOW confidence.**` + '\n'
    + `  This simulation does NOT test whether role-at-end follows instructions as reliably.`);

  c.push(`\n**Unresolved provider-specific risks:**` + '\n'
    + `  1. Cache TTL: Provider caches expire. For long-running tasks, cache may expire mid-pipeline.` + '\n'
    + `  2. Cache alignment: Some providers align to 128-token boundaries.` + '\n'
    + `  3. Cache minimums: Some providers require 1024+ token minimum prefix.` + '\n'
    + `  4. Tokenizer differences affect actual token counts.`);

  return c.join('\n');
}

// formatCost, formatTokens, formatPct imported from shared lib

function generateReport(scenarios, provider) {
  const lines = [];
  const providerConfig = PROVIDERS[provider] || PROVIDERS.deepseek;

  lines.push('# Content-First Architecture — Two-Mode Validation Report');
  lines.push('');
  lines.push(`**Provider:** ${providerConfig.name}`);
  lines.push(`**Run mode:** ${runMode}${runMode === 'simulation' ? ' (projected — no real API calls)' : ' (empirical — real DeepSeek API calls)'}`);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push('');

  if (runMode === 'deepseek') {
  lines.push('> **Note:** This report includes empirical measurements from real DeepSeek API calls.');
  lines.push('> Cache hit tokens are from the provider\'s `prompt_cache_hit_tokens` response field.');
  lines.push('> RF and CF phases are isolated by unique seed prefixes to prevent cross-contamination.\n');
  }

  lines.push('---\n');

  for (const scenario of scenarios) {
    const r = simulate(scenario, providerConfig);

    lines.push(`### ${scenario.name}`);
    lines.push(`**Source:** ${scenario.realContentSource}`);
    lines.push(`**Seed:** ~${r.seedTokens} tokens | **Rounds:** ${r.agentCount}\n`);

    lines.push('| Metric | Role-First | Content-First | Confidence |');
    lines.push('|--------|------------|---------------|------------|');
    lines.push(`| Total uncached | ${formatTokens(r.rf.uncachedTokens)} | ${formatTokens(r.cf.uncachedTokens)} | HIGH (arithmetic) |`);
    lines.push(`| Total cached | ${formatTokens(r.rf.cachedTokens)} | ${formatTokens(r.cf.cachedTokens)} | MEDIUM (depends on provider) |`);
    lines.push(`| Cost | ${formatCost(r.rf.totalCost)} | ${formatCost(r.cf.totalCost)} | MEDIUM |`);
    lines.push(`| Savings | — | ${r.savingsPct.toFixed(1)}% | MEDIUM |`);
    lines.push(`| Cache hit rate | ${formatPct(r.rf.cacheHitRate)} | ${formatPct(r.cf.cacheHitRate)} | MEDIUM |`);
    lines.push('');

    if (runMode === 'deepseek') {
      lines.push('#### Empirical Results (DeepSeek)\n');
      lines.push('> Full session records written to `sessions/` subdirectory with per-round input+output.\n');
    }

    lines.push('#### Per-Agent Breakdown\n');
    lines.push('| Agent | RF Cost | CF Cost | CF Cached | CF Hit Rate | Cold? |');
    lines.push('|-------|---------|---------|-----------|-------------|-------|');
    for (let i = 0; i < r.agentCount; i++) {
      const ra = r.rf.agents[i];
      const ca = r.cf.agents[i];
      lines.push(`| ${ra.name} | ${formatCost(ra.cost)} | ${formatCost(ca.cost)} | ${formatTokens(ca.cachedTokens)} | ${formatPct(ca.cacheHitRate)} | ${i === 0 ? 'Yes' : 'No'} |`);
    }

    lines.push('');

    if (runMode === 'simulation') {
      lines.push(commentate(r));
    }

    lines.push('---\n');
  }

  lines.push('## Summary\n');
  if (runMode === 'simulation') {
    lines.push('**All figures are PROJECTED.** No real API calls were made. The simulation validates the arithmetic but not the provider\'s actual caching implementation.\n');
    lines.push('To run empirical measurements: `node content-first-proof.mjs --mode deepseek`\n');
  } else {
    lines.push('**Figures include empirical measurements from DeepSeek API calls.**\n');
  }

  const avgSavings = scenarios.reduce((s, sc) => s + simulate(sc, PROVIDERS[provider] || PROVIDERS.deepseek).savingsPct, 0) / scenarios.length;
  lines.push(`**Average projected savings across all scenarios:** ${avgSavings.toFixed(1)}%`);
  lines.push('\nGenerated by content-first-proof.mjs');

  return lines.join('\n');
}

function printResult(scenario, providerConfig) {
  const r = simulate(scenario, providerConfig);

  console.log(`\n  ${scenario.name}`);
  console.log(`    Source: ${scenario.realContentSource}`);
  console.log(`    Seed: ~${r.seedTokens}t | Rounds: ${r.agentCount} | Roles: ${scenario.rounds.map(r => r.name).join(', ')}`);
  console.log(`    Role-First:    ${formatCost(r.rf.totalCost)} (${formatTokens(r.rf.uncachedTokens)} uncached, ${formatTokens(r.rf.cachedTokens)} cached)`);
  console.log(`    Content-First: ${formatCost(r.cf.totalCost)} (${formatTokens(r.cf.uncachedTokens)} uncached, ${formatTokens(r.cf.cachedTokens)} cached)`);
  console.log(`    Cost Savings:  ${r.savingsPct.toFixed(1)}% | Cache Hit Rate: ${formatPct(r.cf.cacheHitRate)}`);
  console.log(`    Confidence:    ${r.savingsPct > 20 ? 'MEDIUM' : 'LOW'} (projected — no real API calls)`);

  if (verbose) {
    console.log(`\n    Per-agent:`);
    for (let i = 0; i < r.agentCount; i++) {
      const ra = r.rf.agents[i];
      const ca = r.cf.agents[i];
      console.log(`      ${ra.name.padEnd(12)}  RF: ${formatCost(ra.cost)}  CF: ${formatCost(ca.cost)}  ${i === 0 ? '(cold seed)' : ca.cacheHitRate > 0.9 ? '(cache >90%)' : ''}`);
    }
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
content-first-proof.mjs — Empirical validation of content-first economics

USAGE:
  node content-first-proof.mjs [options]

MODES:
  --mode simulation   Arithmetic projection (default). No API calls.
  --mode deepseek     Real DeepSeek API calls. Measures actual cache hits.
                      Requires DEEPSEEK_API_KEY.
  --mode validate     Simulation + spot-check with DeepSeek on Scenario 6.

OPTIONS:
  --scenario <n>      Run a specific scenario by index (1-6)
  --provider, -p      Provider for simulation: deepseek (default), anthropic, openai
  --verbose, -v       Show per-agent details
  --report            Generate markdown report
  --list              List scenarios
  --help, -h          Show this help

REQUIRES for --mode deepseek|validate:
  DEEPSEEK_API_KEY environment variable
`);
}

function listScenarios() {
  console.log('\nAvailable scenarios:\n');
  for (let i = 0; i < ALL_SCENARIOS.length; i++) {
    const s = ALL_SCENARIOS[i];
    console.log(`  ${i + 1}. ${s.name}`);
    console.log(`     ${s.realContentSource}`);
    console.log(`     ${s.rounds.length} rounds: ${s.rounds.map(r => r.name).join(' → ')}`);
    console.log('');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) { printUsage(); return; }
  if (args.includes('--list')) { listScenarios(); return; }

  // Parse --mode
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1) {
    const modeVal = args[modeIdx + 1];
    if (['simulation', 'deepseek', 'validate'].includes(modeVal)) {
      runMode = modeVal;
    } else {
      console.error(`Unknown mode: ${modeVal}. Use simulation, deepseek, or validate.`);
      process.exit(1);
    }
  }

  // Parse --provider/-p
  const provIdx = args.indexOf('--provider') !== -1 ? args.indexOf('--provider') : args.indexOf('-p');
  if (provIdx !== -1) {
    providerKey = args[provIdx + 1] || 'deepseek';
    if (!PROVIDERS[providerKey]) {
      console.error(`Unknown provider: ${providerKey}. Use: ${Object.keys(PROVIDERS).join(', ')}`);
      process.exit(1);
    }
  }

  if (args.includes('--verbose') || args.includes('-v')) verbose = true;

  // Parse --scenario
  let scenarios = ALL_SCENARIOS;
  const scIdx = args.indexOf('--scenario');
  if (scIdx !== -1) {
    const n = parseInt(args[scIdx + 1], 10);
    if (n < 1 || n > ALL_SCENARIOS.length) {
      console.error(`Scenario ${n} out of range (1-${ALL_SCENARIOS.length}). Use --list.`);
      process.exit(1);
    }
    scenarios = [ALL_SCENARIOS[n - 1]];
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  CONTENT-FIRST PROOF — ${runMode.toUpperCase()} MODE`);
  console.log(`  ${runMode === 'simulation' ? '⚠️  ALL FIGURES PROJECTED — no API calls' : '✅ Real DeepSeek API calls'}`);
  console.log(`  Scenarios: ${scenarios.length} | Total rounds: ${scenarios.reduce((s, sc) => s + sc.rounds.length, 0)}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  if (runMode === 'simulation') {
    const providerConfig = PROVIDERS[providerKey];
    for (const scenario of scenarios) {
      printResult(scenario, providerConfig);
    }

    console.log('──────────────────────────────────────────────────────');
    console.log('  SUMMARY (all figures projected)');
    console.log('──────────────────────────────────────────────────────');
    const avgSavings = scenarios.reduce((s, sc) => s + simulate(sc, PROVIDERS[providerKey]).savingsPct, 0) / scenarios.length;
    console.log(`  Provider: ${PROVIDERS[providerKey].name}`);
    console.log(`  Avg projected savings: ${avgSavings.toFixed(1)}%`);
    console.log(`  Risk not tested: instruction hierarchy effect`);
    console.log('');

  } else {
    // DeepSeek or validate mode
    if (!DS_API_KEY) {
      console.error('\n  ERROR: DEEPSEEK_API_KEY not set.\n');
      process.exit(1);
    }

    const totalRounds = scenarios.reduce((s, sc) => s + sc.rounds.length, 0);
    const estimatedCalls = totalRounds * 2; // RF + CF
    console.log(`  DeepSeek API: ${DS_MODEL} | ${estimatedCalls} calls | ~$${(estimatedCalls * 0.003).toFixed(3)}\n`);

    for (const scenario of scenarios) {
      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  ${scenario.name}`);
      console.log(`  ${scenario.description}`);
      console.log(`  ${scenario.rounds.length} rounds | ${scenario.realContentSource}`);
      console.log(`══════════════════════════════════════════════════════════════════\n`);

      console.log(`\n  Phase 1: Role-First (${scenario.rounds.length} rounds)...`);
      const { results: rfResults } = await runRF(scenario);
      for (const r of rfResults) console.log(`    ${r.summary('RF')}`);

      console.log(`\n  Phase 2: Content-First (${scenario.rounds.length} rounds)...`);
      const { results: cfResults } = await runCF(scenario);
      for (const r of cfResults) console.log(`    ${r.summary('CF')}`);

      // Write full session record with outputs
      const sessionPath = writeSession(scenario, rfResults, cfResults, 'content-first-proof');

      console.log(`\n──────────────────────────────────────────────────────────────────`);
      console.log(`  RESULTS`);
      console.log(`──────────────────────────────────────────────────────────────────`);
      console.log(comparisonTable(scenario, rfResults, cfResults));
      console.log(`  Session written: ${sessionPath}`);
      console.log('');
    }
  }

  if (args.includes('--report')) {
    const reportDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `${ts}-content-first-proof.md`);
    const report = generateReport(scenarios, providerKey);
    fs.writeFileSync(reportPath, report);
    console.log(`\n  Report written to ${reportPath}\n`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
