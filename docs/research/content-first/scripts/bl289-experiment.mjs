#!/usr/bin/env node
/**
 * bl289-experiment.mjs  —  BL-289 Dispatch Loop Experiment
 *
 * Runs a 5-agent dispatch loop (Typescript → Reviewer → Typescript → Reviewer → Tester)
 * on the same BL-289 dead-code cleanup task, in either role-first or content-first mode.
 *
 * Each agent runs for as many turns as it needs, signaling completion with TASK COMPLETE.
 * The script feeds each agent's output into the next agent's context.
 *
 * Usage:
 *   # Role-first (system at position 0, direct to DeepSeek)
 *   node scripts/bl289-experiment.mjs --mode rf
 *
 *   # Content-first (via proxy — rewrites system→suffix)
 *   node scripts/bl289-experiment.mjs --mode cf --proxy http://localhost:3333/v1
 *
 * Output:
 *   - Per-turn token usage printed to stdout
 *   - Full session saved to sessions/bl289-<mode>-<timestamp>.json
 *   - Summary table with cache hit rates per agent
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// ──────── Reuse the library's agent prompts + pricing ────────

const { OPENCODE_AGENTS, PRICING } = await import('../lib/deepseek-experiment.mjs');

const DS_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET;
const DS_BASE = 'https://api.deepseek.com/v1';
const DS_MODEL = 'deepseek-chat';
const MAX_TOKENS = 2000;

// ──────── Configuration ────────

const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'rf';
const PROXY_URL = process.argv.includes('--proxy') ? process.argv[process.argv.indexOf('--proxy') + 1] : null;
const MAX_TURNS_PER_AGENT = 10;
const COMPLETION_MARKER = 'TASK COMPLETE';

if (MODE !== 'rf' && MODE !== 'cf') {
  console.error('Usage: node bl289-experiment.mjs --mode rf|cf [--proxy <url>]');
  process.exit(1);
}
if (MODE === 'cf' && !PROXY_URL) {
  console.error('CF mode requires --proxy <url> (e.g. http://localhost:3333/v1)');
  process.exit(1);
}

// ──────── BL-289 Task Context ────────

const BL289_FILES = `
## BL-289: Delete dead memory-core/src/embedWorker.ts + fix stale doc

### Problem
\`libs/memory-core/src/embedWorker.ts\` is dead code:
- Explicitly excluded from the build in \`tsconfig.lib.json\`
- Superseded by embedding-provider's shared ONNX worker host
- \`index.ts\` BL-11 doc-comment still describes it as the active isolation mechanism

### Files involved

**1. libs/memory-core/src/embedWorker.ts** — dead file, excluded from build at tsconfig.lib.json:15

**2. libs/memory-core/tsconfig.lib.json** — line 15 excludes embedWorker.ts from the build:
  \`"exclude": ["src/**/*.spec.ts", "src/**/*.test.ts", "src/embedWorker.ts", "node_modules"]\`

**3. libs/memory-core/src/index.ts** — lines 12-13 have a stale BL-11 doc block:
  \`"Use the embed worker thread — embed() in this library already routes through embedWorker.ts (worker_threads), keeping ONNX isolated from the main thread."\`

**4. libs/memory-core/src/embed.ts** — the actual current embed isolation mechanism (for reference):
  \`"This is a thin ping/stats adapter over @adhd/sox-embedding-provider. The old embed.ts + embedWorker.ts have been replaced by the canonical [shared ONNX worker host]."\`
  Imports \`createEmbeddingProvider\`/\`EmbeddingProvider\` from \`@adhd/sox-embedding-provider\`, not from any local \`embedWorker.ts\`.

### Fix required
1. Delete \`libs/memory-core/src/embedWorker.ts\`
2. Remove \`"src/embedWorker.ts"\` from \`tsconfig.lib.json\`'s exclude array
3. Rewrite \`index.ts:9-19\` BL-11 doc to describe the actual current mechanism (embed isolation via embedding-provider's shared ONNX worker, not a local embedWorker.ts)

### Acceptance criteria
- File embedWorker.ts no longer exists
- \`grep -rn "embedWorker" libs/memory-core/src/*.ts\` returns zero matches
- \`nx build memory-core\` and \`nx test memory-core\` pass unchanged
`;

// ──────── Dispatch loop definition ────────

const DISPATCH_LOOP = [
  {
    role: 'typescript',
    label: 'Typescript Agent',
    systemPrompt: OPENCODE_AGENTS.typescript,
    task: `You are the first agent in a dispatch loop for BL-289. Read the file contents above and produce the fix.

Your job:
1. Analyze what needs to change (which lines in which files)
2. Produce the exact code changes
3. Read the acceptance criteria and confirm each will be met

When you have produced your complete fix, output a line containing only: ${COMPLETION_MARKER}`,
  },
  {
    role: 'review',
    label: 'Reviewer',
    systemPrompt: OPENCODE_AGENTS.review,
    task: `Review the BL-289 fix proposed by the Typescript agent above.

Check for:
1. Completeness — are all three files addressed?
2. Correctness — does the doc comment accurately describe the actual embed isolation?
3. Coverage — will nx build and nx test memory-core still pass?
4. Anything missed — stale imports, references, or comments pointing to the deleted file?

Output your review findings. When you are done, output a line containing only: ${COMPLETION_MARKER}`,
  },
  {
    role: 'typescript',
    label: 'Typescript Agent (revise)',
    systemPrompt: OPENCODE_AGENTS.typescript,
    task: `The Reviewer has provided feedback on your BL-289 fix above.

Address each finding:
1. If the review found issues, revise your fix
2. If the review confirms correctness, confirm the fix is complete
3. Produce the final version of all changes

Output your revised fix. When you are done, output a line containing only: ${COMPLETION_MARKER}`,
  },
  {
    role: 'review',
    label: 'Reviewer (re-check)',
    systemPrompt: OPENCODE_AGENTS.review,
    task: `The Typescript agent has revised their BL-289 fix in response to your review.

Re-verify:
1. Were your findings addressed?
2. Is the revised fix complete and correct?
3. Any remaining issues?

Output your final assessment. When you are done, output a line containing only: ${COMPLETION_MARKER}`,
  },
  {
    role: 'test',
    label: 'Tester',
    systemPrompt: OPENCODE_AGENTS.test,
    task: `Verify the final BL-289 fix against the acceptance criteria:

1. ${'`'}embedWorker.ts${'`'} no longer exists in the tree — confirm the deletion
2. ${'`'}grep -rn "embedWorker" libs/memory-core/src/*.ts${'`'} returns zero references — confirm no stale imports remain
3. ${'`'}nx build memory-core${'`'} passes — confirm the build succeeds without the deleted file
4. ${'`'}nx test memory-core${'`'} passes — confirm no regressions

Output your verification report. When you are done, output a line containing only: ${COMPLETION_MARKER}`,
  },
];

// ──────── API call (both arms inline, symmetric) ────────

async function callAPI(system, messages) {
  const baseUrl = MODE === 'cf' ? PROXY_URL : DS_BASE;
  const body = {
    model: DS_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: system
      ? [{ role: 'system', content: system }, ...messages]
      : messages,
  };

  const start = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
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
    throw new Error(`API ${res.status} [${MODE}]: ${data.error?.message || JSON.stringify(data)}`);
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

// ──────── Agent conversation loop ────────

async function runAgent(step, priorOutputs) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  Agent ${step.index + 1}/${DISPATCH_LOOP.length}: ${step.label}`);
  console.log(`${'═'.repeat(72)}`);

  // Build context from prior agents' output
  let context = BL289_FILES;
  if (priorOutputs.length > 0) {
    context += '\n\n--- Prior agent outputs ---\n';
    for (const po of priorOutputs) {
      context += `\n## ${po.label}\n${po.text}\n`;
    }
  }

  const messages = [{ role: 'user', content: `${context}\n\n---\n\n${step.task}` }];
  let agentOutput = '';
  let allTurns = [];
  let turnCount = 0;
  let completed = false;

  while (turnCount < MAX_TURNS_PER_AGENT && !completed) {
    turnCount++;
    const response = await callAPI(step.systemPrompt, messages);

    const turnResult = {
      turn: turnCount,
      inputTokens: response.inputTokens,
      cacheHit: response.cacheHit,
      uncachedInput: response.uncachedInput,
      outputTokens: response.outputTokens,
      latencyMs: response.latencyMs,
      response: response.text,
    };
    allTurns.push(turnResult);

    const hit = response.cacheHit > 0 ? '✅' : '  ';
    console.log(`  ${hit} Turn ${turnCount}: in=${response.inputTokens} cache=${response.cacheHit} unc=${response.uncachedInput} out=${response.outputTokens} ${response.latencyMs}ms`);

    agentOutput += (turnCount > 1 ? '\n\n' : '') + response.text;

    if (response.text.includes(COMPLETION_MARKER)) {
      completed = true;
      console.log(`  ✓ Agent signaled completion`);
    } else {
      // Not done — prompt to continue
      messages.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: `Continue working. When you are done, output a line containing only: ${COMPLETION_MARKER}` }
      );
    }
  }

  return {
    label: step.label,
    text: agentOutput,
    completed,
    turnCount,
    turns: allTurns,
  };
}

// ──────── Formatting ────────

function fmtCost(tokens, cached, output) {
  const uncachedCost = (tokens - cached) / 1000 * PRICING.inputPer1K;
  const cachedCost = cached / 1000 * PRICING.cacheHitPer1K;
  const outputCost = output / 1000 * PRICING.outputPer1K;
  return (uncachedCost + cachedCost + outputCost).toFixed(6);
}

// ──────── Main ────────

async function main() {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  BL-289 Dispatch Loop Experiment                ║`);
  console.log(`  ║  Mode: ${MODE === 'rf' ? 'Role-First (direct)' : 'Content-First (via proxy)'}${' '.repeat(18)}║`);
  console.log(`  ║  Proxy: ${PROXY_URL || '(none — direct to DeepSeek)'}${' '.repeat(8)}║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);

  const startTime = new Date().toISOString();
  const results = [];
  let priorOutputs = [];

  for (let i = 0; i < DISPATCH_LOOP.length; i++) {
    const step = { index: i, ...DISPATCH_LOOP[i] };
    const result = await runAgent(step, priorOutputs);
    results.push(result);
    priorOutputs.push({ label: result.label, text: result.text });
    console.log(`  → ${result.label}: ${result.turnCount} turns, ${result.completed ? 'completed' : 'max turns reached'}`);
  }

  // ──────── Summary ────────

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  SUMMARY — ${MODE === 'rf' ? 'Role-First' : 'Content-First'}`);
  console.log(`${'═'.repeat(72)}`);

  let totalInput = 0, totalCached = 0, totalOutput = 0;

  console.log(`\n  ${'Agent'.padEnd(28)} ${'Input'.padEnd(8)} ${'Cached'.padEnd(8)} ${'Uncached'.padEnd(10)} ${'Output'.padEnd(8)} ${'Cost'.padEnd(10)} ${'Rate'}`);
  console.log(`  ${''.padEnd(28, '─')} ${''.padEnd(8, '─')} ${''.padEnd(8, '─')} ${''.padEnd(10, '─')} ${''.padEnd(8, '─')} ${''.padEnd(10, '─')} ${''.padEnd(4, '─')}`);

  for (const result of results) {
    const turns = result.turns;
    const input = turns.reduce((s, t) => s + t.inputTokens, 0);
    const cached = turns.reduce((s, t) => s + t.cacheHit, 0);
    const output = turns.reduce((s, t) => s + t.outputTokens, 0);
    const cost = fmtCost(input, cached, output);
    totalInput += input;
    totalCached += cached;
    totalOutput += output;

    const firstTurn = turns[0];
    const lastTurn = turns[turns.length - 1];
    const hitRate = input > 0 ? (cached / input * 100).toFixed(1) : '0.0';
    const firstHit = firstTurn.cacheHit > 0 ? '✅' : '  ';

    console.log(`  ${result.label.padEnd(28)} ${String(input).padEnd(8)} ${String(cached).padEnd(8)} ${String(input - cached).padEnd(10)} ${String(output).padEnd(8)} $${cost.padEnd(7)} ${hitRate}%${firstHit}`);
    console.log(`  ${''.padEnd(28)} Turns: ${result.turnCount}  First: ${firstTurn.inputTokens}t ${firstTurn.cacheHit > 0 ? `cached ${firstTurn.cacheHit}` : '0 cached'}  Last: ${lastTurn.inputTokens}t ${lastTurn.cacheHit > 0 ? `cached ${lastTurn.cacheHit}` : '0 cached'}`);
  }

  const totalCost = fmtCost(totalInput, totalCached, totalOutput);
  const totalHitRate = totalInput > 0 ? (totalCached / totalInput * 100).toFixed(1) : '0.0';

  console.log(`\n  ${''.padEnd(28, '─')} ${''.padEnd(8, '─')} ${''.padEnd(8, '─')} ${''.padEnd(10, '─')} ${''.padEnd(8, '─')} ${''.padEnd(10, '─')} ${''.padEnd(4, '─')}`);
  console.log(`  ${'TOTAL'.padEnd(28)} ${String(totalInput).padEnd(8)} ${String(totalCached).padEnd(8)} ${String(totalInput - totalCached).padEnd(10)} ${String(totalOutput).padEnd(8)} $${totalCost.padEnd(7)} ${totalHitRate}%`);

  // Cache progression
  console.log(`\n  Cache hit rate by agent order (should grow for CF, stay flat for RF):`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const firstHit = r.turns[0].cacheHit;
    const allHits = r.turns.reduce((s, t) => s + t.cacheHit, 0);
    const allIn = r.turns.reduce((s, t) => s + t.inputTokens, 0);
    const rate = allIn > 0 ? (allHits / allIn * 100).toFixed(1) : '0.0';
    const marker = i === 0 ? ' (cold seed)' : firstHit > 0 ? ' ✅ cached after switch' : ' ❌ 0 after switch';
    console.log(`    Agent ${i + 1} (${r.label}): ${rate}% hit rate${marker}`);
  }

  // ──────── Save session ────────

  const sessionFile = path.join(SESSIONS_DIR, `bl289-${MODE}-${startTime.replace(/[:.]/g, '-')}.json`);
  const session = {
    experiment: 'BL-289 dispatch loop',
    mode: MODE,
    proxy: PROXY_URL,
    timestamp: startTime,
    agents: DISPATCH_LOOP.map((a, i) => ({
      index: i,
      role: a.role,
      label: a.label,
    })),
    results: results.map(r => ({
      label: r.label,
      completed: r.completed,
      turnCount: r.turnCount,
      turns: r.turns,
    })),
    totals: {
      inputTokens: totalInput,
      cachedTokens: totalCached,
      uncachedTokens: totalInput - totalCached,
      outputTokens: totalOutput,
      cost: totalCost,
      hitRate: totalHitRate,
    },
  };
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  console.log(`\n  Session saved: ${sessionFile}`);
}

main().catch(err => {
  console.error('Experiment failed:', err);
  process.exit(1);
});
