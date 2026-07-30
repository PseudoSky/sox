#!/usr/bin/env node

/**
 * content-first-mcp.mjs
 *
 * MCP-COMPATIBLE RUNNER — content-first vs role-first with JSON output.
 *
 * Runs a single scenario against DeepSeek (both CF and RF), outputs
 * structured JSON for programmatic consumption. Useful for piping into
 * MCP hosts, charting tools, or CI pipelines.
 *
 * Usage:
 *   node scripts/content-first-mcp.mjs                          # Run with default scenario
 *   node scripts/content-first-mcp.mjs --pretty                  # Pretty-print output
 *   node scripts/content-first-mcp.mjs --output results.json     # Write to file
 *   node scripts/content-first-mcp.mjs --scenario 5-round        # Use scenario key
 *
 * Output shape:
 *   {
 *     "meta": { "model", "temperature", "scenario", "rounds", "timestamp" },
 *     "phases": {
 *       "roleFirst":  { "rounds": [...], "aggregate": { "totalCached", ... } },
 *       "contentFirst": { "rounds": [...], "aggregate": { "totalCached", ... } }
 *     },
 *     "comparison": { "cfVsRfMultiplier", "costSavings", "cachingRatios" },
 *     "claims": { "h1": ..., "h3": ..., "h6": ... }
 *   }
 *
 * Requires: DEEPSEEK_API_KEY
 */

import fs from 'fs';
import {
  runRF, runCF,
  formatCost, aggregate, writeSession,
  makeRound, OPENCODE_AGENTS,
  DS_API_KEY, DS_MODEL, DS_TEMPERATURE,
} from '../lib/deepseek-experiment.mjs';

const SCENARIO = {
  name: 'Tenant Isolation (5-round MCP, real SPs)',
  seed: `Namespace isolation decision:

Option A (single store): All tenants share one database. WHERE clause on every query.
Option B (per-tenant store): Each tenant gets their own database.
Option C (split enforcement): Store enforces, middleware resolves.

Decision: Option C. Defense in depth.`,
  rounds: [
    makeRound('review', 'You are a senior code reviewer. Review the namespace design for security vulnerabilities and correctness. Output 2-3 paragraphs.'),
    makeRound('architect', 'You are a spec-only architecture agent. Evaluate the namespace design boundaries and abstraction. Output 2-3 paragraphs.'),
    makeRound('backend', 'You are a senior backend developer. Review operational complexity and scalability. Output 2-3 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Review developer impact and enterprise readiness. Output 2-3 paragraphs.'),
    makeRound('test', 'You are a senior QA expert. Review the design for testability and edge cases. Output 2-3 paragraphs.'),
  ],
};

function roundToObj(r) {
  return {
    name: r.name,
    label: r.label || r.name,
    inputTokens: r.inputTokens,
    cacheHit: r.cacheHit,
    uncachedInput: r.uncachedInput,
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    cacheHitRate: r.cacheHitRate,
    cost: r.cost,
  };
}

function aggToObj(a) {
  return { ...a, cachingRatio: a.cachingRatio };
}

async function main() {
  if (!DS_API_KEY) {
    console.error(JSON.stringify({ error: 'DEEPSEEK_API_KEY not set' }));
    process.exit(1);
  }

  const pretty = process.argv.includes('--pretty');
  const outFile = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
  const indent = pretty ? 2 : 0;

  // Run phases
  const { results: rfR } = await runRF(SCENARIO);
  const { results: cfR } = await runCF(SCENARIO);

  const rfA = aggregate(rfR);
  const cfA = aggregate(cfR);

  // Write session record
  const sessionPath = writeSession(SCENARIO, rfR, cfR, 'content-first-mcp');

  // Build output (includes session path reference)
  const output = {
    sessionFile: sessionPath,
    meta: {
      model: DS_MODEL,
      temperature: DS_TEMPERATURE,
      scenario: SCENARIO.name,
      rounds: SCENARIO.rounds.length,
      timestamp: new Date().toISOString(),
      api: 'deepseek-direct',
      isolation: 'seed-prefix',
    },
    phases: {
      roleFirst: {
        rounds: rfR.map(roundToObj),
        aggregate: aggToObj(rfA),
      },
      contentFirst: {
        rounds: cfR.map(roundToObj),
        aggregate: aggToObj(cfA),
      },
    },
    comparison: {
      cfVsRfCachedMultiplier: rfA.totalCached > 0 ? cfA.totalCached / rfA.totalCached : Infinity,
      cfVsRfUncachedRatio: rfA.totalUncached > 0 ? cfA.totalUncached / rfA.totalUncached : 0,
      costSavingsPercent: rfA.totalCost > 0 ? (1 - cfA.totalCost / rfA.totalCost) * 100 : 0,
      rfCachingRatio: rfA.cachingRatio,
      cfCachingRatio: cfA.cachingRatio,
    },
    claims: {
      h1_cf_caches_more: cfA.totalCached > rfA.totalCached,
      h3_cf_less_uncached: cfA.totalUncached < rfA.totalUncached,
      h6_cf_cache_persists: cfR.slice(1).some(r => r.cacheHit > 0),
      h9_cost_comparable: rfA.totalCost > 0 && (cfA.totalCost / rfA.totalCost) < 2,
      rf_pure_role_switch: rfR.filter((_, i) => i > 0 && SCENARIO.rounds[i].name !== SCENARIO.rounds[i - 1]?.name).every(r => r.cacheHit === 0),
    },
  };

  const json = JSON.stringify(output, null, indent);

  if (outFile) {
    fs.writeFileSync(outFile, json);
    console.log(`Written to ${outFile}`);
  } else {
    console.log(json);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
