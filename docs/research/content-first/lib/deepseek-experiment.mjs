/**
 * deepseek-experiment.mjs
 *
 * Shared library for content-first vs role-first experiments.
 *
 * Provides:
 *   - DeepSeek API client (direct, no agent-mcp)
 *   - RoundResult class for tracking per-round metrics
 *   - runRF() / runCF() runners with seed-prefix isolation
 *   - Pricing constants and formatting utilities
 *
 * Seed-prefix isolation: each paradigm gets a unique first-token prefix
 * so the DeepSeek cache keys never overlap between phases.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────── Configuration ────────

export const DS_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET;
export const DS_BASE = 'https://api.deepseek.com/v1';
export const DS_MODEL = 'deepseek-chat';
export const DS_MAX_OUTPUT = 600;
export const DS_TEMPERATURE = 0;

// ──────── Real OpenCode Agent System Prompts ────────

const OPCODE_DIR = path.join(process.env.HOME || '/Users/nix', '.config', 'opencode', 'agents');

function loadOC(name) {
  try {
    const content = fs.readFileSync(path.join(OPCODE_DIR, name + '.md'), 'utf8');
    // Strip YAML frontmatter (---\n...\n---) — it's configuration, not system prompt
    const match = content.match(/^---\n([\s\S]*?)\n---\n\n?/);
    return match ? content.slice(match[0].length).trim() : content.trim();
  } catch {
    return 'You are a ' + name + ' specialist.';
  }
}

/**
 * Real opencode agent system prompts, loaded at module init.
 * Keys: architect, backend, review, product, test, debug, researcher, typescript
 */
export const OPENCODE_AGENTS = {
  architect:   loadOC('architect'),
  backend:     loadOC('backend'),
  review:      loadOC('review'),
  product:     loadOC('product'),
  test:        loadOC('test'),
  debug:       loadOC('debug'),
  researcher:  loadOC('researcher'),
  typescript:  loadOC('typescript'),
};

export const PRICING = {
  inputPer1K: 0.00027,
  cacheHitPer1K: 0.00007,
  outputPer1K: 0.00110,
};

// ──────── DeepSeek API Client ────────

export async function deepseekCall({ system, messages }) {
  const body = {
    model: DS_MODEL,
    max_tokens: DS_MAX_OUTPUT,
    temperature: DS_TEMPERATURE,
    messages: system
      ? [{ role: 'system', content: system }, ...messages]
      : messages,
  };

  const start = Date.now();
  const res = await fetch(`${DS_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const elapsed = Date.now() - start;

  if (!res.ok) {
    throw new Error(`DeepSeek API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
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

// ──────── Round Result ────────

export class RoundResult {
  constructor(round, response, inputContent) {
    this.name = round.name;
    this.label = round.label;
    this.inputTokens = response.inputTokens;
    this.cacheHit = response.cacheHit;
    this.uncachedInput = response.uncachedInput;
    this.outputTokens = response.outputTokens;
    this.latencyMs = response.latencyMs;
    this.text = response.text;
    this.inputContent = inputContent || ''; // Full input sent to the API
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

  summary(paradigm) {
    const tag = paradigm === 'RF' ? 'RF' : 'CF';
    const hit = this.cacheHit > 0 ? '✅' : '  ';
    return `${hit} ${tag} ${this.name.padEnd(20)} tokens=${this.inputTokens}  cache_hit=${this.cacheHit}  unc=${this.uncachedInput}  latency=${this.latencyMs}ms  ${this.formatCost()}`;
  }
}

// ──────── Scenario Shape ────────

/**
 * A scenario has:
 *   name: string
 *   description: string
 *   rounds: [{ name, label, sysPrompt, roleSuffix, outputTokens? }]
 *   seed: string
 *   seedTokens? (used by simulation)
 */

// ──────── Runners ────────

// ── Mode: CHAIN (sequential) ──
// Each agent builds on prior output. Context grows each round.
// Tests the CONVERGE phase — lower savings (10-20%).

/**
 * Run a scenario in role-first CHAIN mode (sequential accumulation).
 * R1: system=A, user=seed
 * R2: system=B, user=seed + "\n\n" + R1_output
 * Cache anchor = system prompt at position 0 (changes per role)
 */
export async function runRF(scenario) {
  const results = [];
  let combined = scenario.seed;

  for (const round of scenario.rounds) {
    const inputContent = combined;
    const messages = [{ role: 'user', content: inputContent }];
    const resp = await deepseekCall({ system: round.sysPrompt, messages });
    results.push(new RoundResult(round, resp, inputContent));
    combined += `\n\n${round.label}:\n${resp.text}`;
  }

  return { results, combinedAcc: combined };
}

/**
 * Run a scenario in content-first CHAIN mode (sequential accumulation).
 * R1: user=seed + "\n\n" + suffix_1
 * R2: user=seed + "\n\n" + R1_output + "\n\n" + suffix_2
 * Cache anchor = seed content at position 0 (same for all rounds)
 */
export async function runCF(scenario) {
  const results = [];
  let combined = scenario.seed;

  for (const round of scenario.rounds) {
    const inputContent = `${combined}\n\n${round.roleSuffix}`;
    const messages = [{ role: 'user', content: inputContent }];
    const resp = await deepseekCall({ messages });
    results.push(new RoundResult(round, resp, inputContent));
    combined += `\n\n${round.label}:\n${resp.text}`;
  }

  return { results, combinedAcc: combined };
}

// ── Mode: FORK (parallel) ──
// All agents receive IDENTICAL seed, independently. No accumulation.
// Tests the DIVERGE phase — high savings (85-95%).
// No prefix needed: RF and CF have structurally different message arrays
// (RF has `system` field at position 0, CF has only `user` at position 0),
// so DeepSeek cache keys already differ between paradigms.

/**
 * Run a scenario in role-first FORK mode.
 * Each agent gets: system=role, user=same_seed
 * Cache anchor = system prompt at position 0 (changes per role)
 */
export async function runForkRF(scenario) {
  const results = [];
  for (const round of scenario.rounds) {
    const inputContent = scenario.seed; // Pure seed, no prefix
    const messages = [{ role: 'user', content: inputContent }];
    const resp = await deepseekCall({ system: round.sysPrompt, messages });
    results.push(new RoundResult(round, resp, inputContent));
  }
  return { results };
}

/**
 * Run a scenario in content-first FORK mode.
 * Each agent gets: user=same_seed + "\n\n" + unique_role_suffix
 * Cache anchor = seed content at position 0 (same for all roles)
 * Agent 1: cold
 * Agents 2..N: seed cached, only suffix unique
 */
export async function runForkCF(scenario) {
  const results = [];
  for (const round of scenario.rounds) {
    const suffix = `\n\n${round.roleSuffix}`;
    const inputContent = scenario.seed + suffix; // Seed at position 0, suffix at end
    const messages = [{ role: 'user', content: inputContent }];
    const resp = await deepseekCall({ messages });
    results.push(new RoundResult(round, resp, inputContent));
  }
  return { results };
}

// ──────── Formatting ────────

export function formatCost(cost) {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(t) {
  if (t < 1000) return `${t}t`;
  if (t < 1_000_000) return `${(t / 1000).toFixed(1)}Kt`;
  return `${(t / 1_000_000).toFixed(1)}Mt`;
}

export function formatPct(r) {
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * Compute aggregate stats from an array of RoundResult.
 */
export function aggregate(results) {
  return {
    totalInput: results.reduce((s, r) => s + r.inputTokens, 0),
    totalUncached: results.reduce((s, r) => s + r.uncachedInput, 0),
    totalCached: results.reduce((s, r) => s + r.cacheHit, 0),
    totalCost: results.reduce((s, r) => s + r.cost, 0),
    totalLatency: results.reduce((s, r) => s + r.latencyMs, 0),
    cachingRatio: (() => {
      const t = results.reduce((s, r) => s + r.inputTokens, 0);
      const c = results.reduce((s, r) => s + r.cacheHit, 0);
      return t > 0 ? c / t : 0;
    })(),
  };
}

// ──────── Scenario Helpers ────────

/**
 * Make a round using an opencode agent as the system prompt.
 * @param {string} agentKey - Key into OPENCODE_AGENTS (e.g. 'architect')
 * @param {string} suffix - Role suffix for content-first mode
 * @param {object} overrides - Optional overrides for name/label
 * @returns {object} round definition
 */
export function makeRound(agentKey, suffix, overrides = {}) {
  const names = {
    architect: 'Architect',
    backend: 'Backend',
    review: 'Code Reviewer',
    product: 'Product Manager',
    test: 'QA Expert',
    debug: 'Debug Specialist',
    researcher: 'Researcher',
    typescript: 'TypeScript Developer',
  };
  return {
    name: overrides.name || agentKey.charAt(0).toUpperCase() + agentKey.slice(1),
    label: overrides.label || names[agentKey] || agentKey,
    sysPrompt: OPENCODE_AGENTS[agentKey],
    roleSuffix: suffix,
  };
}

/**
 * Write a full session record (prompts, outputs, metrics) to disk.
 * Returns the file path.
 */
export function writeSession(scenario, rfResults, cfResults, scriptName) {
  const dir = path.join(__dirname, '..', 'sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = scenario.name.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
  const filePath = path.join(dir, `${ts}-${slug}-${scriptName}.json`);

  const session = {
    meta: {
      script: scriptName,
      model: DS_MODEL,
      temperature: DS_TEMPERATURE,
      scenario: scenario.name,
      rounds: scenario.rounds.length,
      timestamp: new Date().toISOString(),
      isolation: 'seed-prefix',
    },
    rounds: scenario.rounds.map((round, i) => ({
      round: i + 1,
      name: round.name,
      label: round.label,
      isRepeat: i > 0 && round.name === scenario.rounds[i - 1].name,
      roleFirst: {
        systemPrompt: round.sysPrompt,
        inputContent: rfResults[i]?.inputContent ?? '',
        inputTokens: rfResults[i]?.inputTokens ?? 0,
        cacheHit: rfResults[i]?.cacheHit ?? 0,
        uncachedInput: rfResults[i]?.uncachedInput ?? 0,
        outputTokens: rfResults[i]?.outputTokens ?? 0,
        latencyMs: rfResults[i]?.latencyMs ?? 0,
        output: rfResults[i]?.text ?? '',
      },
      contentFirst: {
        roleSuffix: round.roleSuffix,
        inputContent: cfResults[i]?.inputContent ?? '',
        inputTokens: cfResults[i]?.inputTokens ?? 0,
        cacheHit: cfResults[i]?.cacheHit ?? 0,
        uncachedInput: cfResults[i]?.uncachedInput ?? 0,
        outputTokens: cfResults[i]?.outputTokens ?? 0,
        latencyMs: cfResults[i]?.latencyMs ?? 0,
        output: cfResults[i]?.text ?? '',
      },
    })),
    aggregates: {
      roleFirst: aggToObj(aggregate(rfResults)),
      contentFirst: aggToObj(aggregate(cfResults)),
    },
    comparison: {
      cfVsRfCachedMultiplier: aggregate(rfResults).totalCached > 0
        ? aggregate(cfResults).totalCached / aggregate(rfResults).totalCached : Infinity,
      costSavingsPercent: aggregate(rfResults).totalCost > 0
        ? (1 - aggregate(cfResults).totalCost / aggregate(rfResults).totalCost) * 100 : 0,
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

function aggToObj(a) {
  return { ...a, cachingRatio: a.cachingRatio };
}

/**
 * Generate a per-round comparison table showing content caching boundaries.
 */
export function comparisonTable(scenario, rfResults, cfResults) {
  const lines = [];
  lines.push('\n## Cache Boundary Analysis\n');
  lines.push('Cache anchor for RF = system prompt (position 0) — differs per role → content uncached.');
  lines.push('Cache anchor for CF = seed content (position 0) — same for all roles → content cached.\n');

  // Structure breakdown
  lines.push('### Per-Agent Content vs Instruction Breakdown\n');
  lines.push('| Agent | Paradigm | Total | Content | Instr | Cached | Cache anchor |');
  lines.push('|-------|----------|-------|---------|-------|--------|--------------|');

  // Estimate instruction size for RF (sys prompt size) and CF (suffix size)
  for (let i = 0; i < scenario.rounds.length; i++) {
    const round = scenario.rounds[i];
    const rf = rfResults[i];
    const cf = cfResults[i];
    // RF: instruction = sys prompt (at position 0), content = user message
    const rfInstrTokens = rf ? Math.ceil(round.sysPrompt.length / 4) : 0;
    const rfContentTokens = rf ? rf.inputTokens - rfInstrTokens : 0;
    // CF: instruction = role suffix (at end), content = user message minus suffix
    const cfInstrTokens = cf ? Math.ceil(round.roleSuffix.length / 4) : 0;
    const cfContentTokens = cf ? cf.inputTokens - cfInstrTokens : 0;

    lines.push(`| R${i+1}: ${round.name.padEnd(12)} | RF | ${rf ? rf.inputTokens : '-'}t | ~${Math.max(0, rfContentTokens)}t | ~${rfInstrTokens}t | ${rf ? rf.cacheHit : 0}t | sys prompt |`);
    lines.push(`| R${i+1}: ${round.name.padEnd(12)} | CF | ${cf ? cf.inputTokens : '-'}t | ~${Math.max(0, cfContentTokens)}t | ~${cfInstrTokens}t | ${cf ? cf.cacheHit : 0}t | seed content |`);
  }

  lines.push('\n### Per-Round Comparison\n');
  lines.push('| Round | Role | RF uncached | RF cached | RF cost | CF uncached | CF cached | CF cost |');

  for (let i = 0; i < scenario.rounds.length; i++) {
    const rf = rfResults[i];
    const cf = cfResults[i];
    const round = scenario.rounds[i];
    const isRepeat = i > 0 && round.name === scenario.rounds[i - 1].name;
    const roleLabel = isRepeat ? `${round.name} (repeat)` : round.name;
    lines.push(`| R${i + 1} | ${roleLabel} | ${rf.uncachedInput} | ${rf.cacheHit} | ${rf.formatCost()} | ${cf.uncachedInput} | ${cf.cacheHit} | ${cf.formatCost()} |`);
  }

  // Totals
  const rfA = aggregate(rfResults);
  const cfA = aggregate(cfResults);
  lines.push('|---|---|---|---|---|---|---|---|');
  lines.push(`| **Total** | | **${rfA.totalUncached}** | **${rfA.totalCached}** | **${formatCost(rfA.totalCost)}** | **${cfA.totalUncached}** | **${cfA.totalCached}** | **${formatCost(cfA.totalCost)}** |`);

  lines.push('\n### Summary\n');
  lines.push(`- **Total input:** RF = ${rfA.totalInput}, CF = ${cfA.totalInput}`);
  lines.push(`- **Total uncached:** RF = ${rfA.totalUncached}, CF = ${cfA.totalUncached}`);
  lines.push(`- **Total cached:** RF = ${rfA.totalCached}, CF = ${cfA.totalCached}`);
  lines.push(`- **Total cost:** RF = ${formatCost(rfA.totalCost)}, CF = ${formatCost(cfA.totalCost)}`);
  lines.push(`- **RF caching ratio:** ${(rfA.cachingRatio * 100).toFixed(1)}%`);
  lines.push(`- **CF caching ratio:** ${(cfA.cachingRatio * 100).toFixed(1)}%`);
  lines.push(`- **CF multiplier:** ${rfA.totalCached > 0 ? (cfA.totalCached / rfA.totalCached).toFixed(1) : '∞'}× more tokens cached`);
  lines.push(`- **Cost savings:** ${rfA.totalCost > 0 ? ((1 - cfA.totalCost / rfA.totalCost) * 100).toFixed(1) : 'N/A'}%`);

  return lines.join('\n');
}
