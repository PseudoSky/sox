#!/usr/bin/env node
/**
 * content-first-quality.mjs  —  IHE-1 Generation Layer
 *
 * Generates RF/CF output pairs for 6 quality scenarios.
 * Does NOT evaluate — only writes session files for eval/ layer.
 *
 * Protocol:
 *   - 6 scenarios (A-F), 5 trials each, 2 paradigms (RF, CF)
 *   - 60 DeepSeek API calls total
 *   - Random A/B blind labeling per trial
 *   - Output: JSON session file with full inputs, outputs, and metadata
 *
 * Usage:
 *   export DEEPSEEK_API_KEY="sk-..."
 *   node scripts/content-first-quality.mjs
 */

import { deepseekCall, writeSession, OPENCODE_AGENTS } from '../lib/deepseek-experiment.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRIALS = 5;
const DS_MODEL = 'deepseek-chat';
const DS_TEMP = 0;

// ──────── Seed Content ────────

function readFile(relPath) {
  const base = process.env.SOX_PROTOCOL_PATH || '/Users/nix/dev/ai/sox-protocol';
  try {
    return fs.readFileSync(path.join(base, relPath), 'utf-8').trim();
  } catch { return null; }
}

// Scenario A seed: namespace isolation spec (~4K chars = ~1K tokens)
const SEED_A = readFile('spec/primitives/namespace.md') || '# Namespace spec unavailable';

// Scenario B seed: paper abstract (~2K chars)
const SEED_B = `
## Paper: Don't Break the Cache (Lumer et al., arXiv 2601.06007, 2026)
We evaluate prompt caching across three major LLM providers and compare three
caching strategies. Strategic prompt cache block control, such as placing
dynamic content at the end of the system prompt, provides more consistent
benefits than naive full-context caching. Prompt caching reduces API costs
by 41-80% and improves TTFT by 13-31% across providers. We also identify
cases where caching degrades output quality due to stale KV state.
`.trim();

// Scenario C seed: supervisor state machine code
const SEED_C = readFile('libs/host-runtime/src/supervisor.ts') ||
`// Supervisor state machine
enum State { INIT, RUNNING, DEGRADED, STOPPED }
interface Transition { from: State; to: State; action: string; }
const TRANSITIONS: Transition[] = [
  { from: State.INIT, to: State.RUNNING, action: 'start' },
  { from: State.RUNNING, to: State.DEGRADED, action: 'degrade' },
  { from: State.DEGRADED, to: State.RUNNING, action: 'recover' },
  { from: State.RUNNING, to: State.STOPPED, action: 'stop' },
  { from: State.DEGRADED, to: State.STOPPED, action: 'stop' },
  { from: State.INIT, to: State.STOPPED, action: 'cancel' },
];`;

// Scenario E seed: synthetic product requirements (~3K chars)
const SEED_E = `
PRODUCT REQUIREMENTS: AI Code Review Assistant

Feature: Automated pull request analysis that runs before human review.
The system scans every line of each changed file, classifies changes by risk
level, and flags specific lines that need attention.

Constraint A (Scope Creep Risk): Users will want to add inline fix suggestions,
automated patch generation, CI integration rules, custom lint configurations,
team-specific scoring, and historical trend analysis. Each feature request is
reasonable alone but collectively delays the minimum viable product.

Constraint B (Fast MVP): The fastest path to a shippable v0.1 is: accept a
markdown diff, run deterministic pattern matching (not ML), output a risk
classification per file. No inline fixes. No CI integration. No custom config.

The tension: users won't pay for something that only does diff scanning (too
many existing tools). But building the AI-powered features they would pay for
takes 6+ months of ML investment.
`.trim();

// Scenario F seed: TypeScript code listing
const SEED_F = `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class HashCache {
  private store = new Map<string, { hash: string; content: string }>();

  add(key: string, content: string): string {
    const hash = createHash('sha256').update(content).digest('hex');
    this.store.set(key, { hash, content });
    return hash;
  }

  get(key: string): string | null {
    return this.store.get(key)?.content ?? null;
  }

  verify(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    const current = createHash('sha256').update(entry.content).digest('hex');
    return current === entry.hash;
  }

  remove(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}
`.trim();

// ──────── Scenario Definitions ────────

const SCENARIOS = [
  {
    id: 'A',
    name: 'Role Adherence',
    seed: SEED_A,
    instruction: `You are a security engineer specializing in multi-tenant isolation. Review this architecture design for security vulnerabilities. Focus specifically on data leakage paths, unauthorized cross-tenant access, and isolation boundary enforcement. Do NOT discuss performance, cost, or developer experience. Output 2-3 paragraphs.`,
    dimensions: ['ROLE_ADHERENCE', 'NEGATION_COMPLIANCE', 'SPECIFICITY', 'OVERALL'],
    maxTokens: 600,
  },
  {
    id: 'B',
    name: 'Format Compliance',
    seed: SEED_B,
    instruction: `You are a research methodology reviewer. Analyze this paper abstract. Output your analysis as a VALID JSON object with exactly these keys: "strengths" (array of strings, 2-4 items), "weaknesses" (array of strings, 2-4 items), "open_questions" (array of strings, 1-3 items), "overall_verdict" (one of "accept", "reject", "major_revision"), "confidence" (number 0.0-1.0). Output ONLY the JSON object, no markdown fences, no explanation.`,
    dimensions: ['FORMAT_COMPLIANCE', 'CONTENT_COVERAGE', 'OVERALL'],
    maxTokens: 600,
  },
  {
    id: 'C',
    name: 'Multi-Constraint',
    seed: SEED_C,
    instruction: `You are a senior backend developer performing a code review. Analyze the supervisor state machine code. Cover ALL of: CORRECTNESS (potential bugs in state transitions or error handling), SECURITY (process-escaping, resource exhaustion, privilege issues), TESTABILITY (how testable the state machine is). Use exactly three markdown headings: "## Correctness", "## Security", "## Testability". Each section must have at least one specific finding with a code pattern reference. Do not add any other sections. Output 4-6 paragraphs total.`,
    dimensions: ['CONTENT_COVERAGE', 'FORMAT_COMPLIANCE', 'SPECIFICITY', 'OVERALL'],
    maxTokens: 800,
  },
  {
    id: 'D',
    name: 'Persona Depth',
    seed: SEED_A,  // Same namespace spec, different lens
    instruction: `You are a skeptical, battle-hardened enterprise CISO who has survived three major vendor security incidents. You trust nothing you haven't verified yourself. You ask uncomfortable questions. You notice what others miss. Review this architecture decision. Write in first person. Your tone: direct, slightly cynical, evidence-driven. Output 3-5 paragraphs.`,
    dimensions: ['ROLE_ADHERENCE', 'SPECIFICITY', 'OVERALL'],
    maxTokens: 800,
  },
  {
    id: 'E',
    name: 'Trade-off Acknowledgment',
    seed: SEED_E,
    instruction: `You are an experienced product manager who has shipped 6 enterprise products. Review this requirements document and provide: (1) The SINGLE biggest risk of scope creep; (2) The SINGLE fastest path to a working MVP. These two questions intentionally pull in opposite directions. After answering both, explicitly acknowledge this tension and explain how you would navigate it as PM. CRITICAL: You MUST explicitly state that these goals are in tension. A response that answers both without acknowledging the tension is a FAIL. Output 3-5 paragraphs.`,
    dimensions: ['CONTENT_COVERAGE', 'SPECIFICITY', 'OVERALL'],
    maxTokens: 800,
  },
  {
    id: 'F',
    name: 'Negation Density',
    seed: SEED_F,
    instruction: `You are a senior code reviewer. Review this code. CRITICAL CONSTRAINTS: (1) Do NOT suggest alternative libraries, frameworks, or languages. (2) Do NOT rewrite or refactor the code. Point out issues; don't fix them. (3) Do NOT discuss performance or scalability. (4) Do NOT discuss code style, formatting, or naming conventions. (5) Focus ONLY on correctness bugs and security vulnerabilities. Output 2-3 paragraphs. If you cannot find any correctness or security issues, state that explicitly rather than discussing disallowed topics.`,
    dimensions: ['NEGATION_COMPLIANCE', 'CONTENT_COVERAGE', 'SPECIFICITY', 'OVERALL'],
    maxTokens: 600,
  },
];

// ──────── Runner ────────

async function runTrial(scenario, trialNum) {
  // RF: instruction in system prompt
  const rfResp = await deepseekCall({
    system: scenario.instruction,
    messages: [{ role: 'user', content: scenario.seed }],
  });

  // CF: instruction at end of user message, no system
  const cfResp = await deepseekCall({
    messages: [{ role: 'user', content: `${scenario.seed}\n\n${scenario.instruction}` }],
  });

  // Random A/B labeling
  const swap = Math.random() > 0.5;
  const aOutput = swap ? cfResp.text : rfResp.text;
  const bOutput = swap ? rfResp.text : cfResp.text;
  const aIsCF = swap;

  return {
    trial: trialNum,
    rf: {
      inputTokens: rfResp.inputTokens,
      cacheHit: rfResp.cacheHit,
      uncachedInput: rfResp.uncachedInput,
      outputTokens: rfResp.outputTokens,
      latencyMs: rfResp.latencyMs,
      output: rfResp.text,
    },
    cf: {
      inputTokens: cfResp.inputTokens,
      cacheHit: cfResp.cacheHit,
      uncachedInput: cfResp.uncachedInput,
      outputTokens: cfResp.outputTokens,
      latencyMs: cfResp.latencyMs,
      output: cfResp.text,
    },
    blind: {
      a_label: aIsCF ? 'CF' : 'RF',
      b_label: aIsCF ? 'RF' : 'CF',
      a_output: aOutput,
      b_output: bOutput,
    },
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  IHE-1 GENERATION LAYER');
  console.log(`  ${SCENARIOS.length} scenarios × ${TRIALS} trials × 2 paradigms = ${SCENARIOS.length * TRIALS * 2} API calls`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const allResults = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n── ${scenario.id}: ${scenario.name} ──`);
    const trials = [];

    for (let t = 0; t < TRIALS; t++) {
      process.stdout.write(`  Trial ${t + 1}/${TRIALS}...`);
      const trial = await runTrial(scenario, t);
      trials.push(trial);
      const costRf = (trial.rf.uncachedInput / 1000 * 0.00027).toFixed(6);
      const costCf = (trial.cf.uncachedInput / 1000 * 0.00027).toFixed(6);
      process.stdout.write(`  RF: ${trial.rf.outputTokens}t out ($${costRf})  CF: ${trial.cf.outputTokens}t out ($${costCf})\n`);
    }

    allResults.push({
      scenario: { id: scenario.id, name: scenario.name },
      instruction: scenario.instruction,
      seed: scenario.seed,
      dimensions: scenario.dimensions,
      trials,
      aggregates: {
        rf: {
          totalCached: trials.reduce((s, t) => s + t.rf.cacheHit, 0),
          totalUncached: trials.reduce((s, t) => s + t.rf.uncachedInput, 0),
          totalOutput: trials.reduce((s, t) => s + t.rf.outputTokens, 0),
        },
        cf: {
          totalCached: trials.reduce((s, t) => s + t.cf.cacheHit, 0),
          totalUncached: trials.reduce((s, t) => s + t.cf.uncachedInput, 0),
          totalOutput: trials.reduce((s, t) => s + t.cf.outputTokens, 0),
        },
      },
    });

    console.log(`  Done. RF tokens: ~${trials[0].rf.inputTokens}t each, CF: ~${trials[0].cf.inputTokens}t each`);
  }

  // Write combined output
  const outDir = path.join(__dirname, '..', 'sessions');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${ts}-ihe1-outputs.json`);

  // Write incrementally after each scenario in case of timeout
  for (const scenario of SCENARIOS) {
    console.log(`\n── ${scenario.id}: ${scenario.name} ──`);
    const trials = [];

    for (let t = 0; t < TRIALS; t++) {
      process.stdout.write(`  Trial ${t + 1}/${TRIALS}...`);
      const trial = await runTrial(scenario, t);
      trials.push(trial);
      const costRf = (trial.rf.uncachedInput / 1000 * 0.00027).toFixed(6);
      const costCf = (trial.cf.uncachedInput / 1000 * 0.00027).toFixed(6);
      process.stdout.write(`  RF: ${trial.rf.outputTokens}t out ($${costRf})  CF: ${trial.cf.outputTokens}t out ($${costCf})\n`);
    }

    allResults.push({
      scenario: { id: scenario.id, name: scenario.name },
      instruction: scenario.instruction,
      seed: scenario.seed,
      dimensions: scenario.dimensions,
      trials,
      aggregates: {
        rf: {
          totalCached: trials.reduce((s, t) => s + t.rf.cacheHit, 0),
          totalUncached: trials.reduce((s, t) => s + t.rf.uncachedInput, 0),
          totalOutput: trials.reduce((s, t) => s + t.rf.outputTokens, 0),
        },
        cf: {
          totalCached: trials.reduce((s, t) => s + t.cf.cacheHit, 0),
          totalUncached: trials.reduce((s, t) => s + t.cf.uncachedInput, 0),
          totalOutput: trials.reduce((s, t) => s + t.cf.outputTokens, 0),
        },
      },
    });

    // Write after each scenario — partial output survives timeout
    fs.writeFileSync(outPath, JSON.stringify({
      meta: {
        experiment: 'IHE-1',
        model: DS_MODEL,
        temperature: DS_TEMP,
        timestamp: new Date().toISOString(),
        scenarios: SCENARIOS.length,
        trialsPerScenario: TRIALS,
        status: allResults.length === SCENARIOS.length ? 'complete' : `partial-${allResults.length}-of-${SCENARIOS.length}`,
      },
      results: allResults,
    }, null, 2));

    console.log(`  ✓ Scenario ${scenario.id} complete (${allResults.length}/${SCENARIOS.length})`);
  }

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  GENERATION SUMMARY');
  console.log('─────────────────────────────────────────────────────────');
  for (const r of allResults) {
    const rf = r.aggregates.rf;
    const cf = r.aggregates.cf;
    const savings = rf.totalUncached > 0
      ? ((1 - cf.totalUncached / rf.totalUncached) * 100).toFixed(1)
      : 'N/A';
    console.log(`  ${r.scenario.id}: RF=${rf.totalUncached}t unc  CF=${cf.totalUncached}t unc  savings=${savings}%`);
  }
  console.log('\n  Next: run evaluation/ihe1-eval.py with the output file');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
