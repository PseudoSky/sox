#!/usr/bin/env node

/**
 * Direct DeepSeek experiment — bypasses agent-mcp entirely.
 * Tests both parallel fork and sequential loop directly against
 * the DeepSeek API to measure true cache behavior.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY="sk-..."
 *   node deepseek-experiment.mjs
 */

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET;
const BASE = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-chat';

// Verbatim seed content
const SEED = `# Namespace — Primitive Spec

Namespace is an isolation boundary that tags every channel and message in the backing store. Namespaces separate tenants within a single server deployment without requiring separate server processes. Cross-namespace data access is structurally impossible at the backing-store port level.

Two isolation modes: shared (single database with namespace WHERE clause) and isolated (separate database per namespace). A namespace_resolver middleware sits before authentication, mapping the claimed agent_id to a namespace. Namespaces are create-only in v1.0. The namespace is server-internal, not on the wire.

Option C (split: store-level enforcement, middleware-level resolution).`;

const ROLE_SEC = 'You are a security engineer. Evaluate: can a tenant access another tenant\'s data? Assess the split enforcement model, the shared mode WHERE-clause approach, and the absence of namespace deletion.';
const ROLE_ARCH = 'You are a software architect. Evaluate: is the split model the right boundary? Does the mode knob create unnecessary complexity? Is the federation orthogonality correct?';
const ROLE_IMPL = 'You are a TypeScript engineer. Implement a NamespaceResolver class and middleware. Output the implementation.';
const ROLE_REV = 'You are a code reviewer. Review this code for correctness, security, and style. Be specific.';

async function call(messages, system = null) {
  const body = {
    model: MODEL,
    max_tokens: 2000,
    temperature: 0,
    messages,
  };
  if (system) body.messages = [{ role: 'system', content: system }, ...messages];

  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const elapsed = Date.now() - t0;

  if (!res.ok) throw new Error(`API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);

  const u = data.usage || {};
  return {
    tokens: u.prompt_tokens || 0,
    completionTokens: u.completion_tokens || 0,
    cacheHit: u.prompt_cache_hit_tokens || 0,
    cacheMiss: u.prompt_cache_miss_tokens || u.prompt_tokens || 0,
    latencyMs: elapsed,
    text: data.choices?.[0]?.message?.content || '',
  };
}

async function testParallelFork() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  EXPERIMENT 1: PARALLEL FORK');
  console.log('══════════════════════════════════════════════════════\n');

  // — Role-first: different system prompts —
  console.log('─ Role-first (different system per role) ─');

  const rf1 = await call(
    [{ role: 'user', content: SEED }],
    ROLE_SEC
  );
  console.log(`  Round 1 (security sys):    tokens=${rf1.tokens}  cache_hit=${rf1.cacheHit}  latency=${rf1.latencyMs}ms`);

  const rf2 = await call(
    [{ role: 'user', content: SEED }],
    ROLE_ARCH
  );
  console.log(`  Round 2 (architect sys):   tokens=${rf2.tokens}  cache_hit=${rf2.cacheHit}  latency=${rf2.latencyMs}ms`);

  // — Content-first: same empty system, role in user message —
  console.log('\n─ Content-first (no system, role at end) ─');

  const cf1 = await call([
    { role: 'user', content: `${SEED}\n\n${ROLE_SEC}` }
  ]);
  console.log(`  Round 1 (security suffix): tokens=${cf1.tokens}  cache_hit=${cf1.cacheHit}  latency=${cf1.latencyMs}ms`);

  const cf2 = await call([
    { role: 'user', content: `${SEED}\n\n${ROLE_ARCH}` }
  ]);
  console.log(`  Round 2 (architect suffx): tokens=${cf2.tokens}  cache_hit=${cf2.cacheHit}  latency=${cf2.latencyMs}ms`);

  console.log('\n─ Summary ─');
  console.log(`  RF: round1=${rf1.cacheHit} cached, round2=${rf2.cacheHit} cached`);
  console.log(`  CF: round1=${cf1.cacheHit} cached, round2=${cf2.cacheHit} cached`);
  if (cf2.cacheHit > 0) console.log('  ✅ CF shows cache reuse across role switch');
  if (rf2.cacheHit === 0) console.log('  ✅ RF shows no cache reuse across role switch');
}

async function testSequentialLoop() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  EXPERIMENT 2: SEQUENTIAL LOOP');
  console.log('══════════════════════════════════════════════════════\n');

  // — Role-first: implementer → reviewer → implementer —
  console.log('─ Role-first (different sys per role, same sys on repeat) ─');

  const rfR1 = await call([{ role: 'user', content: SEED }], ROLE_IMPL);
  console.log(`  R1 (impl, cold):            tokens=${rfR1.tokens}  cache_hit=${rfR1.cacheHit}  latency=${rfR1.latencyMs}ms`);

  const rfR2 = await call([{ role: 'user', content: `${SEED}\n\n${rfR1.text}` }], ROLE_REV);
  console.log(`  R2 (rev, diff sys):         tokens=${rfR2.tokens}  cache_hit=${rfR2.cacheHit}  latency=${rfR2.latencyMs}ms`);

  const rfR3 = await call([{ role: 'user', content: `${SEED}\n\n${rfR1.text}\n\nREVIEW:\n${rfR2.text}` }], ROLE_IMPL);
  console.log(`  R3 (impl, SAME sys as R1):  tokens=${rfR3.tokens}  cache_hit=${rfR3.cacheHit}  latency=${rfR3.latencyMs}ms`);

  // — Content-first: same empty sys, role at end —
  console.log('\n─ Content-first (no system, role at end) ─');

  const cfR1 = await call([{ role: 'user', content: `${SEED}\n\n${ROLE_IMPL}` }]);
  console.log(`  R1 (impl suffix, cold):     tokens=${cfR1.tokens}  cache_hit=${cfR1.cacheHit}  latency=${cfR1.latencyMs}ms`);

  const cfR2 = await call([{ role: 'user', content: `${SEED}\n\n${cfR1.text}\n\n${ROLE_REV}` }]);
  console.log(`  R2 (rev suffix):            tokens=${cfR2.tokens}  cache_hit=${cfR2.cacheHit}  latency=${cfR2.latencyMs}ms`);

  const cfR3 = await call([{ role: 'user', content: `${SEED}\n\n${cfR1.text}\n\nREVIEW:\n${cfR2.text}\n\n${ROLE_IMPL}` }]);
  console.log(`  R3 (impl suffix, same role): tokens=${cfR3.tokens}  cache_hit=${cfR3.cacheHit}  latency=${cfR3.latencyMs}ms`);

  console.log('\n─ Summary ─');
  console.log(`  RF: R1=${rfR1.cacheHit}  R2=${rfR2.cacheHit}  R3=${rfR3.cacheHit} (R3 same sys as R1 — ${rfR3.cacheHit > 0 ? 'HIT' : 'MISS'})`);
  console.log(`  CF: R1=${cfR1.cacheHit}  R2=${cfR2.cacheHit}  R3=${cfR3.cacheHit} (R3 same role as R1 — ${cfR3.cacheHit > 0 ? 'HIT' : 'MISS'})`);
}

async function main() {
  if (!API_KEY) {
    console.error('Set DEEPSEEK_API_KEY or ADHD_AGENT_DEEPSEEK_SECRET');
    process.exit(1);
  }
  console.log(`Direct DeepSeek test — model: ${MODEL}`);
  console.log(`Seed content: ${SEED.length} chars (~${Math.round(SEED.length/4)} tokens)`);

  await testParallelFork();
  await testSequentialLoop();

  console.log('\n══════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
