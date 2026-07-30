#!/usr/bin/env node

/**
 * content-first-tests.mjs
 *
 * HYPOTHESIS TEST SUITE — content-first vs role-first economics.
 *
 * Each test is a named hypothesis. Tests run the given scenario against
 * DeepSeek (both RF and CF), then assert the expected outcome.
 *
 * Uses the shared deepseek-experiment library for API calls, runners,
 * and seed-prefix isolation between RF and CF phases.
 *
 * Usage:
 *   node scripts/content-first-tests.mjs                    # Run all tests
 *   node scripts/content-first-tests.mjs --list             # List tests only
 *   node scripts/content-first-tests.mjs --test H1          # Run one test
 *   node scripts/content-first-tests.mjs --scenario <name>  # Run all tests on a specific scenario
 *   node scripts/content-first-tests.mjs --verbose          # Show per-round data
 *
 * Hypotheses:
 *   H1  RF has zero cache reuse across different roles
 *   H2  CF has non-zero cache reuse for subsequent rounds
 *   H3  CF uses fewer uncached input tokens overall
 *   H4  RF same-role repeats get cache hits (same system prompt)
 *   H5  CF cache grows monotonically with round count
 *   H6  CF subsequent-round cache hit rate > 50%
 *   H7  RF uncached tokens grow per round (context accumulates)
 *   H8  CF uncached tokens stable after first round
 *   H9  First-round costs are comparable (within 2×)
 *   H10 Output quality comparable (no refusals in either paradigm)
 *
 * Requires: DEEPSEEK_API_KEY environment variable
 */

import {
  deepseekCall, RoundResult, runRF, runCF,
  formatCost, formatTokens, aggregate, writeSession,
  makeRound, OPENCODE_AGENTS,
  DS_API_KEY,
} from '../lib/deepseek-experiment.mjs';

const SCENARIO_1 = {
  name: 'Tenant Isolation (real SPs)',
  seed: `Namespace isolation architecture:

Option A (single store): All tenants share one database. A namespace_resolver
middleware extracts the tenant ID from the request and injects it as a WHERE
clause on every query. Pros: Simple, single connection pool. Cons: No physical
isolation, WHERE clause must be present on EVERY query.

Option B (per-tenant store): Each tenant gets their own SQLite database.
Pros: Physical isolation, no WHERE clause risk. Cons: Many open connections,
file descriptor pressure, no cross-tenant queries.

Option C (split enforcement): Store layer enforces isolation. Middleware layer
resolves namespace to connection string. No namespace info on the wire.
Pros: Defense in depth. Cons: Two components to operate.`,
  rounds: [
    makeRound('review', 'You are a senior code reviewer. Review the namespace isolation options for security vulnerabilities and correctness. Output 2-3 paragraphs.'),
    makeRound('architect', 'You are a spec-only architecture agent. Evaluate the namespace isolation options for clean boundaries and abstraction. Output 2-3 paragraphs.'),
    makeRound('backend', 'You are a senior backend developer. Review the namespace options for operational complexity and scalability. Output 2-3 paragraphs.'),
    makeRound('product', 'You are a senior product manager. Review the namespace options for developer experience and enterprise readiness. Output 2-3 paragraphs.'),
  ],
};

// ──────── Test infrastructure ────────

const SCENARIOS = { 'tenant-isolation': SCENARIO_1 };
let PASSED = 0;
let FAILED = 0;
let VERBOSE = false;
let SCENARIO_FILTER = null;
let TEST_FILTER = null;

function name(ok) { return ok ? '✅ PASS' : '❌ FAIL'; }

// ──────── Tests ────────

const TESTS = {};

TESTS.H1 = {
  name: 'H1 — RF has zero cache reuse across different roles',
  async run() {
    const scenario = SCENARIO_FILTER || SCENARIO_1;
    const { results } = await runRF(scenario);
    // Every role switch should get zero cache (different system prompts)
    const roleSwitches = results.slice(1);
    const zeroHits = roleSwitches.filter(r => r.cacheHit === 0);
    const passed = zeroHits.length === roleSwitches.length;
    if (VERBOSE) for (const r of results) console.log(`     ${r.summary('RF')}`);
    console.log(`    ${passed ? '✅' : '❌'} RF: ${roleSwitches.length} role switches, ${zeroHits.length} had 0 cache`);
    return passed;
  }
};

TESTS.H2 = {
  name: 'H2 — CF has non-zero cache reuse for subsequent rounds',
  async run() {
    const { results } = await runCF(SCENARIO_FILTER || SCENARIO_1);
    const subsequent = results.slice(1);
    const hasHits = subsequent.filter(r => r.cacheHit > 0);
    const passed = hasHits.length >= subsequent.length - 1; // at least all but 1
    if (VERBOSE) for (const r of results) console.log(`     ${r.summary('CF')}`);
    console.log(`    ${passed ? '✅' : '❌'} CF: ${subsequent.length} subsequent rounds, ${hasHits.length} had cache hits`);
    return passed;
  }
};

TESTS.H3 = {
  name: 'H3 — CF uses fewer uncached input tokens overall',
  async run() {
    const scenario = SCENARIO_FILTER || SCENARIO_1;
    const { results: rfResults } = await runRF(scenario);
    const { results: cfResults } = await runCF(scenario);
    const sp = writeSession(scenario, rfResults, cfResults, 'test-H3');
    const rfUnc = aggregate(rfResults).totalUncached;
    const cfUnc = aggregate(cfResults).totalUncached;
    const passed = cfUnc < rfUnc;
    if (VERBOSE) {
      console.log(`    RF uncached: ${rfUnc}, CF uncached: ${cfUnc}`);
    }
    const ratio = (cfUnc / rfUnc * 100).toFixed(0);
    console.log(`    ${passed ? '✅' : '❌'} CF uses ${ratio}% of RF's uncached tokens`);
    console.log(`    Session: ${sp}`);
    return passed;
  }
};

TESTS.H4 = {
  name: 'H4 — RF same-role repeats get cache hits',
  async run() {
    // Use scenario 6 (sequential loop) which has 3 same-role repeats
    const seqScenario = {
      name: 'Sequential Loop (3 same-role repeats)',
      seed: SCENARIO_1.seed,
      rounds: [
        { name: 'Architect', label: 'Architect (1)', sysPrompt: 'You are a software architect.', roleSuffix: 'You are a software architect. Evaluate. Output 1 paragraph.' },
        { name: 'Security', label: 'Security', sysPrompt: 'You are a security engineer.', roleSuffix: 'You are a security engineer. Review. Output 1 paragraph.' },
        { name: 'Architect', label: 'Architect (2)', sysPrompt: 'You are a software architect.', roleSuffix: 'You are a software architect. Revise. Output 1 paragraph.' },
        { name: 'Platform', label: 'Platform', sysPrompt: 'You are a platform engineer.', roleSuffix: 'You are a platform engineer. Review. Output 1 paragraph.' },
        { name: 'Architect', label: 'Architect (3)', sysPrompt: 'You are a software architect.', roleSuffix: 'You are a software architect. Finalize. Output 1 paragraph.' },
      ],
    };
    const { results } = await runRF(seqScenario);
    // Architect repeats on rounds 0, 2, 4 (1-indexed: R1, R3, R5)
    const architectRounds = [results[0], results[2], results[4]];
    const repeatsHadCache = architectRounds.slice(1).filter(r => r.cacheHit > 0);
    const passed = repeatsHadCache.length >= 1; // at least one repeat got cache
    if (VERBOSE) {
      console.log(`    Architect R1 (cold): cache_hit=${results[0].cacheHit}`);
      console.log(`    Architect R3: cache_hit=${results[2].cacheHit}`);
      console.log(`    Architect R5: cache_hit=${results[4].cacheHit}`);
    }
    console.log(`    ${passed ? '✅' : '❌'} RF: ${repeatsHadCache.length}/2 architect repeats got cache hits`);
    return passed;
  }
};

TESTS.H5 = {
  name: 'H5 — CF cache grows monotonically with round count',
  async run() {
    const { results } = await runCF(SCENARIO_FILTER || SCENARIO_1);
    const hits = results.map(r => r.cacheHit);
    const monotonic = hits.every((h, i) => i === 0 || h >= hits[i - 1]);
    const passed = monotonic;
    if (VERBOSE) console.log(`    Cache hits per round: ${hits.join(' → ')}`);
    console.log(`    ${passed ? '✅' : '❌'} CF cache is${monotonic ? '' : ' NOT'} monotonically increasing`);
    return passed;
  }
};

TESTS.H6 = {
  name: 'H6 — CF subsequent-round cache hit rate > 50%',
  async run() {
    const { results } = await runCF(SCENARIO_FILTER || SCENARIO_1);
    const subsequent = results.slice(1);
    const agg = aggregate(subsequent);
    const rate = agg.totalInput > 0 ? agg.totalCached / agg.totalInput : 0;
    const passed = rate > 0.5;
    console.log(`    ${passed ? '✅' : '❌'} CF subsequent-round cache hit rate: ${(rate * 100).toFixed(1)}% (target >50%)`);
    return passed;
  }
};

TESTS.H7 = {
  name: 'H7 — RF uncached tokens grow per round',
  async run() {
    const { results } = await runRF(SCENARIO_FILTER || SCENARIO_1);
    const uncached = results.map(r => r.uncachedInput);
    const growing = uncached.every((u, i) => i === 0 || u >= uncached[i - 1]);
    const passed = growing;
    if (VERBOSE) console.log(`    Uncached per round: ${uncached.join(' → ')}`);
    console.log(`    ${passed ? '✅' : '❌'} RF uncached tokens ${growing ? 'grow' : 'do NOT grow'} monotonically`);
    return passed;
  }
};

TESTS.H8 = {
  name: 'H8 — CF uncached tokens stable after first round',
  async run() {
    const { results } = await runCF(SCENARIO_FILTER || SCENARIO_1);
    const afterFirst = results.slice(1);
    const uncached = afterFirst.map(r => r.uncachedInput);
    // The uncached portion should be roughly equal (just the role suffix)
    const max = Math.max(...uncached);
    const min = Math.min(...uncached);
    const variance = max - min;
    const passed = variance < 400; // role suffixes should be within 400t of each other
    if (VERBOSE) console.log(`    CF uncached tokens after R1: ${uncached.join(', ')} (range: ${variance})`);
    console.log(`    ${passed ? '✅' : '❌'} CF uncached variance: ${variance}t (target <400t)`);
    return passed;
  }
};

TESTS.H9 = {
  name: 'H9 — First-round costs comparable (within 2×)',
  async run() {
    const scenario = SCENARIO_FILTER || SCENARIO_1;
    const { results: rfResults } = await runRF(scenario);
    const { results: cfResults } = await runCF(scenario);
    const sp = writeSession(scenario, rfResults, cfResults, 'test-H9');
    const rfFirst = rfResults[0].cost;
    const cfFirst = cfResults[0].cost;
    const ratio = Math.max(rfFirst, cfFirst) / Math.min(rfFirst, cfFirst);
    const passed = ratio < 2;
    if (VERBOSE) console.log(`    RF first: ${rfResults[0].formatCost()}, CF first: ${cfResults[0].formatCost()}, ratio: ${ratio.toFixed(2)}`);
    console.log(`    ${passed ? '✅' : '❌'} First-round cost ratio: ${ratio.toFixed(2)} (target <2×)`);
    console.log(`    Session: ${sp}`);
    return passed;
  }
};

TESTS.H10 = {
  name: 'H10 — Output quality comparable (no refusals)',
  async run() {
    const scenario = SCENARIO_FILTER || SCENARIO_1;
    const { results: rfResults } = await runRF(scenario);
    const { results: cfResults } = await runCF(scenario);
    const sp = writeSession(scenario, rfResults, cfResults, 'test-H10');
    const allText = [...rfResults, ...cfResults].map(r => r.text);
    const refusalPatterns = [
      /cannot (assist|help|complete|fulfill)/i,
      /I('m| am) (sorry|unable|not able)/i,
      /as an AI (assistant|language model)/i,
      /I cannot (provide|generate|write|create)/i,
    ];
    const refusals = allText.filter(t => refusalPatterns.some(p => p.test(t)));
    const passed = refusals.length === 0;
    if (VERBOSE && !passed) console.log(`    Refusals: ${refusals.length}`);
    console.log(`    ${passed ? '✅' : '❌'} ${refusals.length} refusals across ${allText.length} responses (target: 0)`);
    console.log(`    Session: ${sp}`);
    return passed;
  }
};

// ──────── Runner ────────

async function runAllTests() {
  const testEntries = Object.entries(TESTS).filter(([id]) => !TEST_FILTER || id === TEST_FILTER);

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  CONTENT-FIRST HYPOTHESIS TEST SUITE`);
  console.log(`  ${testEntries.length} test(s) | Scenario: ${SCENARIO_FILTER ? 'custom' : 'tenant-isolation (4 roles)'}`);
  console.log(`══════════════════════════════════════════════════════════════════\n`);

  for (const [id, test] of testEntries) {
    process.stdout.write(`  ${id}: ${test.name}...\n`);
    try {
      const passed = await test.run();
      if (passed) PASSED++; else FAILED++;
    } catch (err) {
      console.log(`    ${err.message}`);
      FAILED++;
    }
    console.log('');
  }

  console.log(`──────────────────────────────────────────────────────`);
  console.log(`  RESULTS: ${PASSED} passed, ${FAILED} failed, ${PASSED + FAILED} total`);
  console.log(`  ${FAILED === 0 ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('');
}

// ──────── CLI ────────

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
content-first-tests.mjs — Hypothesis test suite

Usage:
  node scripts/content-first-tests.mjs              # Run all tests
  node scripts/content-first-tests.mjs --test H1    # Run one test
  node scripts/content-first-tests.mjs --scenario n # Run tests on specific scenario
  node scripts/content-first-tests.mjs --list       # List tests
  node scripts/content-first-tests.mjs --verbose    # Show per-round data

Tests: ${Object.keys(TESTS).join(', ')}
`);
  process.exit(0);
}
if (args.includes('--list')) {
  console.log('\nTests:\n');
  for (const [id, test] of Object.entries(TESTS)) {
    console.log(`  ${id}: ${test.name}`);
  }
  console.log('');
  process.exit(0);
}
if (args.includes('--verbose')) VERBOSE = true;
const tIdx = args.indexOf('--test');
if (tIdx !== -1) TEST_FILTER = args[tIdx + 1];
const sIdx = args.indexOf('--scenario');
if (sIdx !== -1) {
  const name = args[sIdx + 1];
  SCENARIO_FILTER = SCENARIOS[name];
  if (!SCENARIO_FILTER) { console.error(`Unknown scenario: ${name}`); process.exit(1); }
}

if (!DS_API_KEY) {
  console.error('\n  ERROR: DEEPSEEK_API_KEY not set.\n');
  process.exit(1);
}

runAllTests().catch(err => { console.error('Error:', err); process.exit(1); });
