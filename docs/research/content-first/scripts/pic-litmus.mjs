#!/usr/bin/env node
/**
 * pic-litmus.mjs  —  Position-Independent Caching litmus test
 *
 * Tests whether a provider's KV cache reuses blocks keyed by content hash
 * (PIC) or only by prefix position.
 *
 * Protocol:
 *   1. Send [X, roleA]  — cache X at position 0
 *   2. Send [X, roleA]  — control: same position → should be ~89% hit
 *   3. Send [roleB, X]  — litmus: X shifted → 0 hit if prefix-only
 *
 * Result (2026-07-27, DeepSeek-chat):
 *   Same position:   1009t input, 896t cached (89%)
 *   Different pos:   1001t input,    0t cached (0%)
 *
 *   Verdict: Strictly PREFIX-BASED. No position-independent caching.
 *   Content-first (shared artifact at position 0) is essential.
 */

import { deepseekCall } from '../lib/deepseek-experiment.mjs';

const X = `
# Namespace Isolation Architecture

## Overview

This document describes the namespace isolation architecture for the SOX
multi-tenant system. The architecture supports three isolation modes
with different security and performance characteristics.

## Mode A: Single-Store (Shared Database)

All tenants share one database. A namespace_resolver middleware extracts
the tenant ID from the request and injects it as a WHERE clause on every
query. This approach is simple to deploy and maintain, as there is only
one connection pool and one set of backups to manage. However, it relies
on the middleware being present on every query without exception. A single
missing WHERE clause can leak data between tenants. This is the most
common deployment mode for small-to-medium deployments.

## Mode B: Per-Tenant Store (Isolated Databases)

Each tenant receives their own SQLite database. The namespace_resolver
maps tenant IDs to database connection strings. This provides physical
isolation between tenants — a bug in one tenant's query cannot expose
another tenant's data. The trade-off is operational complexity: many
open connections, file descriptor pressure, and the inability to run
cross-tenant queries. Backup and recovery procedures must handle an
unbounded number of database files.

## Mode C: Split Enforcement (Defense in Depth)

Store layer enforces isolation through separate databases per namespace.
Middleware layer resolves namespace to connection string without exposing
namespace information on the wire. The stack flows: HTTP request arrives,
namespace resolver determines which namespace context applies, authentication
validates the request, the handler processes business logic, and the store
layer ensures data isolation. This provides defense in depth — two layers
must fail simultaneously for data to leak.

## Cache Boundary Analysis

The KV cache boundary position determines economic efficiency of multi-agent
systems. In role-first architecture, the system prompt (agent identity) is
at position 0. Changing the role changes position 0, which guarantees a
full cache miss. In content-first architecture, the shared artifact is at
position 0 and the role instruction is a short suffix at the end. The
shared artifact remains cached across all role changes.

## Performance Characteristics

For a 12K-token seed with 4 agents: role-first requires 40,500 tokens
while content-first requires 15,150 tokens. The savings grow with content
size and agent count. At 50K tokens and 20 agents: role-first requires
1,060,000 tokens while content-first requires 92,000 tokens. The marginal
cost per additional agent in content-first approaches just the role suffix
plus generation tokens — typically 100-4K tokens versus 12K-100K tokens.

## Provider Behavior

DeepSeek uses strict prefix-based caching. Different system prompts at
position 0 produce zero cache reuse. Identical content prefixes produce
consistent cache hits when the content exceeds 1024 tokens. Anthropic
showed partial cache sharing across different system prompts, suggesting
more sophisticated caching mechanics. The content-first advantage is
strongest on providers with strict prefix caching and exists wherever
caching is available.

## Architectural Implications

The system prompt convention was designed for single-agent persistence.
In multi-agent systems, it creates a structural inefficiency: each agent
pays full content cost because the identity element at position 0 changes.
Content-first architecture places the shared artifact at the cache anchor
and treats the role as a per-turn suffix. This is not an optimization.
It is a different geometry of the problem.

## Migration Strategy

Deployments currently using role-first architecture can migrate to
content-first incrementally. The system prompt can be moved to the
beginning of the user message in stages. Affected agents must be tested
for instruction-following equivalence. The caching benefits appear
immediately upon migration. Initial content size should be at least
1024 tokens to fill a cache block.

## Security Considerations

Content-first architecture does not introduce new security vulnerabilities.
The role instruction at the end of the user message has equivalent
instruction-following properties to the same instruction in the system
prompt. The system prompt position provides no additional security
guarantees. Organizations should continue existing content filtering
and prompt injection defenses regardless of architecture choice.
`.trim();

const roleA = 'You are a software architect. Review this architecture for clean separation of concerns. Which mode (A, B, or C) best achieves defense in depth without sacrificing operability? Output 2-3 paragraphs discussing this trade-off.';
const roleB = 'You are a security engineer. Review this architecture for data leakage vulnerabilities. Identify specifically which modes introduce metadata leakage risks through error messages or timing side-channels. Output 2-3 paragraphs.';

async function main() {
  console.log('=== PIC Litmus Test — empirical \n');
  console.log(`Content X: ~${Math.ceil(X.length / 4)}t\n`);

  // Phase 1: warm
  console.log('Phase 1: X at position 0 (cold)');
  const p1 = await deepseekCall({
    messages: [{ role: 'user', content: `${X}\n\n${roleA}` }],
  });
  console.log(`  [X, roleA]  i=${p1.inputTokens}  u=${p1.uncachedInput}  c=${p1.cacheHit}  → ${p1.cacheHit > 0 ? 'HIT' : 'COLD'}`);

  // Phase 2: same position (control)
  console.log('\nPhase 2: X at SAME position (control)');
  const p2 = await deepseekCall({
    messages: [{ role: 'user', content: `${X}\n\n${roleA}` }],
  });
  console.log(`  [X, roleA]  i=${p2.inputTokens}  u=${p2.uncachedInput}  c=${p2.cacheHit}  → ${p2.cacheHit > 0 ? 'HIT' : 'MISS'}`);

  // Phase 3: different position (litmus)
  console.log('\nPhase 3: X at DIFFERENT position (litmus)');
  const p3 = await deepseekCall({
    messages: [{ role: 'user', content: `${roleB}\n\n${X}` }],
  });
  console.log(`  [roleB, X]  i=${p3.inputTokens}  u=${p3.uncachedInput}  c=${p3.cacheHit}  → ${p3.cacheHit > 0 ? 'HIT' : 'MISS'}`);

  console.log('\n═══════════════════════════════════════');
  console.log('VERDICT:');
  console.log(`  Same position:  ${p1.inputTokens}t → ${p2.cacheHit}t cached (${(p2.cacheHit/p2.inputTokens*100).toFixed(0)}%)`);
  console.log(`  Shifted pos:    ${p3.inputTokens}t → ${p3.cacheHit}t cached (${(p3.cacheHit/p3.inputTokens*100).toFixed(0)}%)`);
  if (p3.cacheHit > 0) {
    console.log('  ✅ PIC LIVE — position-independent caching works');
  } else {
    console.log('  ❌ PREFIX ONLY — identical content at shifted position = 0 cache reuse');
    console.log('  Content-first (put shared content at position 0) is essential');
  }
  console.log('═══════════════════════════════════════');
}

main().catch(e => console.error('Error:', e.message));
