#!/usr/bin/env node

/**
 * content-first-verify.mjs
 *
 * QUICK SMOKE TEST — verifies content-first vs role-first behavior
 * against DeepSeek with a single scenario. Redirect of the original
 * agent-mcp-based verifier to direct DeepSeek API calls.
 *
 * Runs the Tenant Isolation scenario (4 rounds) in both paradigms,
 * measures cache behavior, reports structured comparison.
 *
 * Usage:
 *   node scripts/content-first-verify.mjs
 *   node scripts/content-first-verify.mjs --verbose
 *
 * Requires: DEEPSEEK_API_KEY
 */

import {
  deepseekCall, RoundResult, runRF, runCF,
  formatCost, formatTokens, formatPct,
  aggregate, comparisonTable, writeSession,
  makeRound, OPENCODE_AGENTS,
  DS_API_KEY, DS_MODEL, DS_TEMPERATURE,
} from '../lib/deepseek-experiment.mjs';

const SCENARIO = {
  name: 'Tenant Isolation (verify, real SPs)',
  seed: `Namespace isolation decision:

Option A (single store): All tenants share one database. WHERE clause on every query.
Option B (per-tenant store): Each tenant gets their own database.
Option C (split enforcement): Store enforces, middleware resolves.

Decision: Option C. Defense in depth.`,
  rounds: [
    makeRound('review', 'You are a senior code reviewer. Review the namespace isolation options for security vulnerabilities and correctness. Output 2-3 paragraphs.'),
    makeRound('architect', 'You are a spec-only architecture agent. Evaluate namespace isolation options for clean boundaries. Output 2-3 paragraphs.'),
    makeRound('backend', 'You are a senior backend developer. Review namespace isolation options for operational complexity and scalability. Output 2-3 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Review namespace isolation options for developer experience. Output 2-3 paragraphs.'),
  ],
};

async function main() {
  if (!DS_API_KEY) { console.error('\n  ERROR: DEEPSEEK_API_KEY not set\n'); process.exit(1); }

  const verbose = process.argv.includes('--verbose');

  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  CONTENT-FIRST VERIFY`);
  console.log(`  ${DS_MODEL} | ${SCENARIO.name} (${SCENARIO.rounds.length} rounds)`);
  console.log(`════════════════════════════════════════════════════\n`);

  // Phase 1: RF
  console.log(`  RF (${SCENARIO.rounds.length} rounds)...`);
  const { results: rfR } = await runRF(SCENARIO);
  for (const r of rfR) console.log(`    ${r.summary('RF')}`);

  // Phase 2: CF
  console.log(`\n  CF (${SCENARIO.rounds.length} rounds)...`);
  const { results: cfR } = await runCF(SCENARIO);
  for (const r of cfR) console.log(`    ${r.summary('CF')}`);

  // Comparison
  console.log(comparisonTable(SCENARIO, rfR, cfR));

  // Write session record
  const sessionPath = writeSession(SCENARIO, rfR, cfR, 'content-first-verify');
  console.log(`\n  Session written: ${sessionPath}`);

  // Verification summary
  const rfA = aggregate(rfR);
  const cfA = aggregate(cfR);

  console.log('\n  Verification:');
  console.log(`  ${cfA.totalCached > 0 ? '✅' : '❌'} CF cached tokens > 0 (${cfA.totalCached})`);
  console.log(`  ${cfA.totalUncached < rfA.totalUncached ? '✅' : '❌'} CF uncached < RF uncached (${cfA.totalUncached} vs ${rfA.totalUncached})`);
  console.log(`  ${rfA.totalCached === 0 || SCENARIO.rounds.length > 4 ? '✅' : '⚠️'} RF cross-role cache = ${rfA.totalCached}`);
  console.log(`  ${cfA.cachingRatio > rfA.cachingRatio ? '✅' : '❌'} CF cache ratio (${(cfA.cachingRatio * 100).toFixed(1)}%) > RF (${(rfA.cachingRatio * 100).toFixed(1)}%)`);
  console.log(`  ${rfR[0].cacheHit === 0 ? '✅' : '⚠️'} RF R1 cold start (0 cache)`);
  console.log(`  ${cfR[0].cacheHit === 0 ? '✅' : '⚠️'} CF R1 cold start (0 cache)`);

  console.log(`\n  Result: ${cfA.totalCached > rfA.totalCached ? '✅ CONTENT-FIRST ADVANTAGE CONFIRMED' : '⚠️ INCONCLUSIVE'}`);
  console.log('');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
