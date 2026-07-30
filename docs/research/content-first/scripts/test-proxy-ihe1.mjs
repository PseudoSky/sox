#!/usr/bin/env node
/**
 * test-proxy-ihe1.mjs  —  Runs IHE-1 scenarios through the CF proxy
 *
 * Tests both /v1/chat/completions (transparent rewrite) and
 * /v1/chat/fork (multi-agent fork) endpoints.
 *
 * Usage:
 *   node scripts/test-proxy-ihe1.mjs
 *
 * Requires: cf-proxy.mjs running on port 3333
 */

const PROXY = 'http://localhost:3333/v1';

// ──────── Seeds from IHE-1 ────────

const SEEDS = {
  A: `# Namespace Isolation Architecture

## Overview
This document describes the namespace isolation architecture for the SOX multi-tenant system.

## Mode A: Single-Store
All tenants share one database. A namespace_resolver middleware extracts the tenant ID from the request and injects it as a WHERE clause on every query. This relies on the middleware being present on every query without exception.

## Mode B: Per-Tenant Store
Each tenant receives their own SQLite database. The namespace_resolver maps tenant IDs to database connection strings. This provides physical isolation between tenants but introduces operational complexity.

## Mode C: Split Enforcement
Store layer enforces isolation through separate databases per namespace. Middleware layer resolves namespace to connection string without exposing namespace information on the wire. This provides defense in depth.`,

  B: `## Paper: Don't Break the Cache (Lumer et al., arXiv 2601.06007, 2026)
We evaluate prompt caching across three major LLM providers and compare three caching strategies. Strategic prompt cache block control, such as placing dynamic content at the end of the system prompt, provides more consistent benefits than naive full-context caching.`,

  F: `class HashCache {
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
}`,
};

const ROLES = {
  security: 'You are a security engineer. Review this for data leakage vulnerabilities. Output 2-3 paragraphs.',
  architect: 'You are a software architect. Evaluate this for clean separation of concerns. Output 2-3 paragraphs.',
  pm: 'You are a product manager. Assess this for adoption and enterprise readiness. Output 2-3 paragraphs.',
  json: 'You are a research reviewer. Output your analysis as valid JSON with keys: strengths (array), weaknesses (array), verdict (string). Output ONLY the JSON.',
  reviewer: 'You are a code reviewer. Check for correctness bugs only. Do NOT suggest libraries or refactor. Output 2-3 paragraphs.',
};

async function chatCompletions(messages) {
  const res = await fetch(`${PROXY}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: 150 }),
  });
  return res.json();
}

async function fork(sharedContext, forks) {
  const res = await fetch(`${PROXY}/chat/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_context: sharedContext, forks }),
  });
  return res.json();
}

async function health() {
  const res = await fetch(`${PROXY}/health`);
  return res.json();
}

// ──────── Test 1: Transparent Chat Completions ────────

async function testChatCompletions() {
  console.log('═══ Test 1: Transparent /v1/chat/completions ═══\n');

  const tests = [
    { name: 'Security review', system: ROLES.security, content: SEEDS.A },
    { name: 'Architect review', system: ROLES.architect, content: SEEDS.A },
    { name: 'JSON format output', system: ROLES.json, content: SEEDS.B },
  ];

  for (const test of tests) {
    const result = await chatCompletions([
      { role: 'system', content: test.system },
      { role: 'user', content: test.content },
    ]);

    const output = result.choices?.[0]?.message?.content || '(empty)';
    const cf = result.cf_metrics || {};

    console.log(`  ${test.name}:`);
    console.log(`    RF tokens: ${cf.role_first_tokens}  CF tokens: ${cf.content_first_tokens}`);
    console.log(`    Savings: ${cf.savings_pct}%  Cached seed: ${cf.cached_seed}`);
    console.log(`    Output: ${output.slice(0, 120)}...`);
    console.log();
  }
}

// ──────── Test 2: Fork endpoint ────────

async function testFork() {
  console.log('═══ Test 2: /v1/chat/fork ═══\n');

  const result = await fork(SEEDS.A, [
    { role: ROLES.security, max_tokens: 150 },
    { role: ROLES.architect, max_tokens: 150 },
    { role: ROLES.pm, max_tokens: 150 },
  ]);

  console.log(`  Shared context: ~${result.shared_context_tokens}t`);
  console.log(`  Fork results: ${result.forks}\n`);

  for (const r of result.results) {
    console.log(`  Agent ${r.index} (${r.role.slice(0, 40)}...):`);
    console.log(`    Warm: ${r.warm_start}  Savings: ${r.estimated_savings_pct}`);
    console.log(`    Input: ${r.tokens.input}t  Output: ${r.tokens.output}t`);
    console.log(`    Output: ${r.output.slice(0, 150)}...`);
    console.log();
  }
}

// ──────── Test 3: Negation compliance through fork ────────

async function testNegationFork() {
  console.log('═══ Test 3: Negation compliance fork ═══\n');

  const result = await fork(SEEDS.F, [
    { role: ROLES.reviewer, max_tokens: 150 },
    { role: ROLES.reviewer, max_tokens: 150 }, // repeat to test warm
  ]);

  for (const r of result.results) {
    console.log(`  Agent ${r.index}: warm=${r.warm_start}, savings=${r.estimated_savings_pct}`);
    console.log(`  Output: ${r.output.slice(0, 200)}`);
    // Check for forbidden behaviors
    const forbidden = ['suggest', 'rewrite', 'refactor', 'performance', 'scalability'];
    const violations = forbidden.filter(f => r.output.toLowerCase().includes(f));
    if (violations.length > 0) {
      console.log(`  ⚠️  Forbidden terms: ${violations.join(', ')}`);
    } else {
      console.log(`  ✅ No forbidden behaviors detected`);
    }
    console.log();
  }
}

async function main() {
  // Health check
  const h = await health();
  console.log(`Proxy: ${h.ok ? '✅' : '❌'}  Mode: ${h.mode}  Target: ${h.target.model}\n`);

  await testChatCompletions();
  await testFork();
  await testNegationFork();

  // Final health with cache stats
  const h2 = await health();
  console.log(`Cache blocks: ${h2.cache.blocks}  Hits: ${h2.cache.hits}  Misses: ${h2.cache.misses}  Rate: ${h2.cache.hitRate}`);
}

main().catch(console.error);
