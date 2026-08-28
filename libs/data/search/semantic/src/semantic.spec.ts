import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';

import { createSemanticBackend } from './index.js';
import type { SemanticBackend } from './index.js';

function makeVec(dim: number, text: string): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = (h >> i) & 1 ? 1 : 0.05;
  let n = 0;
  for (let i = 0; i < dim; i++) n += vec[i]! * vec[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i]! / n;
  return vec;
}

function mockProvider(): EmbeddingProvider {
  return {
    metadata: { modelId: 'mock', dimensions: 4, maxTokens: 512, isRemote: false, isDeterministic: true },
    async embedSingle(text: string): Promise<Float32Array> { return makeVec(4, text); },
    async *embedBatch(texts: string[]): AsyncIterable<Float32Array> {
      for (const t of texts) yield makeVec(4, t);
    },
    async warmUp(): Promise<void> {},
    health() {
      return { configured: 'mock', active: 'mock', state: 'real', dimensions: 4, last_error: null };
    },
  };
}

function hasTursoDriver(): boolean {
  try { require.resolve('@tursodatabase/database'); return true; } catch { return false; }
}

describe('createSemanticBackend (turso, mock provider)', () => {
  let adapter: StoreAdapter;
  let cleanup: () => Promise<void>;
  let graph: GraphBackend;
  let backend: SemanticBackend;
  const skip = !hasTursoDriver();

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-test-'));
    adapter = await createStoreAdapter({ dbPath: path.join(dir, 't.db') });
    cleanup = async () => {
      try { await adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    graph = createGraphBackend(adapter);
    await graph.applySchema();
    const result = await createSemanticBackend({
      adapter,
      embedding: { type: 'fastembed', model: 'unused' }, // not used — provider injected
      embeddingProvider: mockProvider(),
      space: { modelId: 'mock', dim: 4 },
    });
    expect(result.ok).toBe(true);
    backend = (result as { ok: true; backend: SemanticBackend }).backend;
  });

  afterEach(async () => { await cleanup(); });

  it('round-trips embed → upsert → semanticSearchNodes (ranked by similarity)', { skip, timeout: 20000 }, async () => {
    const id1 = await graph.writeNode('hello world', { kind: 'generic' });
    const id2 = await graph.writeNode('completely different', { kind: 'generic' });
    await backend.upsertVector(id1, await backend.embedQuery('hello world'));
    await backend.upsertVector(id2, await backend.embedQuery('completely different'));

    const results = await backend.semanticSearchNodes('hello world', { limit: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Deterministic mock: the query text matches node 1's content exactly → ranks first.
    expect(results[0]!.node.id).toBe(id1);
    // FEAT-022: the score is now an RRF reciprocal-rank magnitude (not cosine in [0,1]).
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('semanticSearchNodes honors nodeFilter via queryNodes → knn({ids}) → rejoin (DEBT-011 parity)', { skip, timeout: 20000 }, async () => {
    const id1 = await graph.writeNode('hello world', { kind: 'generic', namespace: 'scope-a' });
    const id2 = await graph.writeNode('hello world again', { kind: 'generic', namespace: 'scope-b' });
    await backend.upsertVector(id1, await backend.embedQuery('hello world'));
    await backend.upsertVector(id2, await backend.embedQuery('hello world again'));

    const results = await backend.semanticSearchNodes('hello world', {
      limit: 10,
      nodeFilter: { namespace: 'scope-a' },
    });
    // Only the scope-a node is a candidate, even though the other is near.
    expect(results.map((r) => r.node.id)).toEqual([id1]);
  });

  it('semanticSearchNodes matching zero nodes yields zero hits (never "no filter applied")', { skip, timeout: 20000 }, async () => {
    const id1 = await graph.writeNode('hello world', { kind: 'generic', namespace: 'scope-a' });
    await backend.upsertVector(id1, await backend.embedQuery('hello world'));

    const results = await backend.semanticSearchNodes('hello world', {
      limit: 10,
      nodeFilter: { namespace: 'scope-does-not-exist' },
    });
    expect(results).toEqual([]);
  });

  it('FEAT-022: a title-text match surfaces in top-K even when its vector is far (vector-only baseline would miss it)', { skip, timeout: 20000 }, async () => {
    const a = await graph.writeNode('alpha beta', { kind: 'generic', namespace: 'scope-a' });
    const b = await graph.writeNode('zzz', { kind: 'generic', namespace: 'scope-a' });
    // A's vector is FAR from the query; B's is NEAR — a vector-only baseline
    // returns B, not A. The text channel (added by FEAT-022) surfaces A.
    await backend.upsertVector(a, makeVec(4, 'zzzzzzzz'));
    await backend.upsertVector(b, makeVec(4, 'alpha'));

    const results = await backend.semanticSearchNodes('alpha', {
      limit: 10,
      nodeFilter: { namespace: 'scope-a' },
    });
    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(a); // text channel surfaces the title match
    expect(ids).toContain(b); // vec channel surfaces the near vector
  });

  it('batch embedDocuments yields per-index results', { skip, timeout: 20000 }, async () => {
    const out: Array<{ index: number; vec?: Float32Array; error?: string }> = [];
    for await (const r of backend.embedDocuments(['a', 'b', 'c'])) out.push(r);
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.every((r) => r.vec && r.vec.length === 4)).toBe(true);
  });

  it('health() reflects the injected provider', { skip }, async () => {
    expect(backend.health().state).toBe('real');
    expect(backend.dim).toBe(4);
    expect(backend.modelId).toBe('mock');
  });
});

describe('createSemanticBackend — failure taxonomy', () => {
  it('returns provider_failed for an unknown provider type (never throws)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-fail-'));
    const adapter = await createStoreAdapter({ dbPath: path.join(dir, 't.db') });
    try {
      const result = await createSemanticBackend({
        adapter,
        embedding: { type: 'bogus-provider', model: 'x' },
        space: { modelId: 'mock', dim: 4 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.reason).toBe('provider_failed');
    } finally {
      try { await adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
