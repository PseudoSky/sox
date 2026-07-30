#!/usr/bin/env node

/**
 * Clean DeepSeek experiment — isolates RF and CF into separate API sessions
 * with a cooldown between them to prevent cache cross-contamination.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY="sk-..."
 *   node deepseek-clean.mjs
 */

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET;
const BASE = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-chat';

const SEED = `Namespace is an isolation boundary. Namespaces separate tenants within a single server deployment. Cross-namespace data access is structurally impossible at the backing-store port level.

Two isolation modes: shared (single database with namespace WHERE clause) and isolated (separate database per namespace). A namespace_resolver middleware sits before authentication. Namespaces are create-only in v1.0.

Option C (split: store-level enforcement, middleware-level resolution).`;

const ROLE_IMPL = 'You are a TypeScript engineer. Implement a NamespaceResolver class and middleware. Output the implementation.';
const ROLE_REV = 'You are a code reviewer. Review this code for correctness, security, and style.';

async function callApi(messages, system = null) {
  const body = { model: MODEL, max_tokens: 1000, temperature: 0, messages };
  if (system) body.messages = [{ role: 'system', content: system }, ...messages];

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data.error?.message || 'unknown'}`);
  const u = data.usage || {};
  return {
    tokens: u.prompt_tokens || 0,
    cacheHit: u.prompt_cache_hit_tokens || 0,
    text: data.choices?.[0]?.message?.content || '',
  };
}

async function runExperiment(paradigm) {
  console.log(`\n── ${paradigm} ──`);

  let r1, r2, r3, r4;

  if (paradigm === 'RF') {
    r1 = await callApi([{ role: 'user', content: SEED }], ROLE_IMPL);
    console.log(`  R1 (impl, cold):           tokens=${r1.tokens}  cache_hit=${r1.cacheHit}`);

    r2 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}` }], ROLE_REV);
    console.log(`  R2 (rev, diff sys):        tokens=${r2.tokens}  cache_hit=${r2.cacheHit}`);

    r3 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}\n\nREVIEW:\n${r2.text}` }], ROLE_IMPL);
    console.log(`  R3 (impl, SAME sys):       tokens=${r3.tokens}  cache_hit=${r3.cacheHit}`);

    r4 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}\n\nREVIEW:\n${r2.text}\n\nFIX:\n${r3.text}` }], ROLE_REV);
    console.log(`  R4 (rev, diff sys again):  tokens=${r4.tokens}  cache_hit=${r4.cacheHit}`);
  } else {
    r1 = await callApi([{ role: 'user', content: `${SEED}\n\n${ROLE_IMPL}` }]);
    console.log(`  R1 (impl suffix, cold):    tokens=${r1.tokens}  cache_hit=${r1.cacheHit}`);

    r2 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}\n\n${ROLE_REV}` }]);
    console.log(`  R2 (rev suffix):           tokens=${r2.tokens}  cache_hit=${r2.cacheHit}`);

    r3 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}\n\nREVIEW:\n${r2.text}\n\n${ROLE_IMPL}` }]);
    console.log(`  R3 (impl suffix, repeat):  tokens=${r3.tokens}  cache_hit=${r3.cacheHit}`);

    r4 = await callApi([{ role: 'user', content: `${SEED}\n\n${r1.text}\n\nREVIEW:\n${r2.text}\n\nFIX:\n${r3.text}\n\n${ROLE_REV}` }]);
    console.log(`  R4 (rev suffix, repeat):   tokens=${r4.tokens}  cache_hit=${r4.cacheHit}`);
  }

  console.log(`  Total uncached: ${r1.tokens - r1.cacheHit + r2.tokens - r2.cacheHit + r3.tokens - r3.cacheHit + r4.tokens - r4.cacheHit}`);
  console.log(`  Total cached:   ${r1.cacheHit + r2.cacheHit + r3.cacheHit + r4.cacheHit}`);
  return { r1, r2, r3, r4 };
}

async function main() {
  if (!API_KEY) { console.error('Set DEEPSEEK_API_KEY'); process.exit(1); }
  console.log(`DeepSeek: ${MODEL}`);
  console.log(`Seed: ${SEED.length} chars`);

  // Run RF first, entirely isolated
  const rf = await runExperiment('RF');

  // Wait 60 seconds for cache to expire
  console.log('\n  Waiting 60s for cache expiry before CF...');
  await new Promise(r => setTimeout(r, 60000));

  // Run CF in a clean cache state
  const cf = await runExperiment('CF');

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  COMPARISON');
  console.log('══════════════════════════════════════════════════════\n');

  console.log('                │  RF (uncached / cached)  │  CF (uncached / cached)');
  console.log('────────────────┼──────────────────────────┼──────────────────────────');
  console.log(`R1 (impl)       │  ${rf.r1.tokens - rf.r1.cacheHit}t unc / ${rf.r1.cacheHit}t cached  │  ${cf.r1.tokens - cf.r1.cacheHit}t unc / ${cf.r1.cacheHit}t cached`);
  console.log(`R2 (rev)        │  ${rf.r2.tokens - rf.r2.cacheHit}t unc / ${rf.r2.cacheHit}t cached  │  ${cf.r2.tokens - cf.r2.cacheHit}t unc / ${cf.r2.cacheHit}t cached`);
  console.log(`R3 (impl again) │  ${rf.r3.tokens - rf.r3.cacheHit}t unc / ${rf.r3.cacheHit}t cached  │  ${cf.r3.tokens - cf.r3.cacheHit}t unc / ${cf.r3.cacheHit}t cached`);
  console.log(`R4 (rev again)  │  ${rf.r4.tokens - rf.r4.cacheHit}t unc / ${rf.r4.cacheHit}t cached  │  ${cf.r4.tokens - cf.r4.cacheHit}t unc / ${cf.r4.cacheHit}t cached`);

  const rfUnc = [rf.r1, rf.r2, rf.r3, rf.r4].reduce((s, r) => s + r.tokens - r.cacheHit, 0);
  const cfUnc = [cf.r1, cf.r2, cf.r3, cf.r4].reduce((s, r) => s + r.tokens - r.cacheHit, 0);
  const rfCached = [rf.r1, rf.r2, rf.r3, rf.r4].reduce((s, r) => s + r.cacheHit, 0);
  const cfCached = [cf.r1, cf.r2, cf.r3, cf.r4].reduce((s, r) => s + r.cacheHit, 0);

  console.log(`────────────────┼──────────────────────────┼──────────────────────────`);
  console.log(`Total           │  ${rfUnc}t unc / ${rfCached}t cached  │  ${cfUnc}t unc / ${cfCached}t cached`);
  console.log(`Cost (est)      │  $${(rfUnc * 0.00025 / 1000).toFixed(6)}           │  $${(cfUnc * 0.00025 / 1000).toFixed(6)}`);
  if (cfCached > rfCached) console.log('\n  ✅ CF cached more tokens than RF');
  if (rf.r2.cacheHit === 0) console.log('  ✅ RF role switch (R1→R2): 0 cached (different sys)');
  if (rf.r3.cacheHit > 0) console.log('  ✅ RF same role repeat (R1→R3): cached (same sys)');
  if (cf.r2.cacheHit > 0) console.log('  ✅ CF role switch (R1→R2): cached (same prefix)');
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
