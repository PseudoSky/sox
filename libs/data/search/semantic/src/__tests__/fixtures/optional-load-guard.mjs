#!/usr/bin/env node
/**
 * optional-load-guard.mjs — child-process probe for @adhd/sox-semantic's
 * optional-loadability invariant.
 *
 * THE INVARIANT
 * `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` are OPTIONAL
 * dependencies, each of which drags a native chain (vector-store → sqlite-vec /
 * better-sqlite3 / lancedb; embedding-provider → onnxruntime / fastembed). A
 * caller that injects BOTH `embeddingProvider` and `vectorBackend` must be able
 * to load and use this package without either being present. So on that path
 * neither specifier may be RESOLVED — not merely "not executed".
 *
 * WHY A CHILD PROCESS WITH A RESOLVE HOOK
 * ESM resolution is not observable from inside the module being tested, and a
 * CJS `Module._load` patch would see nothing at all: the built artifact is ESM,
 * so its static imports never pass through `Module._load`. `module.register()`
 * installs a real ESM resolve hook that sees every specifier the graph resolves,
 * which is the only mechanism that can prove a NEGATIVE ("never requested").
 *
 * Usage: node optional-load-guard.mjs <dist-entry> <log-file>
 * Prints one JSON line on success; exits non-zero on any failure.
 */
import { register } from 'node:module';
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Synchronous fd writes: `process.exit()` would truncate piped async stdout. */
const emit = (fd, text) => writeSync(fd, `${text}\n`);
const fail = (text) => emit(2, text);

const HEAVY = ['@adhd/sox-vector-store', '@adhd/sox-embedding-provider'];

const [, , distEntry, logFile] = process.argv;
if (!distEntry || !logFile) {
  fail('usage: node optional-load-guard.mjs <dist-entry> <log-file>');
  process.exit(2);
}

// Armed BEFORE the module under test is imported, so it sees the whole graph.
register('./optional-load-resolve-hook.mjs', import.meta.url, {
  data: { heavy: HEAVY, logFile },
});

// The harness packages are reached through NON-LITERAL specifiers on purpose.
// Nx's `@nx/enforce-module-boundaries` records a LITERAL dynamic import as a
// project-level *dynamic dependency*, and then rejects the library's own — and
// correct — STATIC import of that same package ("Static imports of lazy-loaded
// libraries are forbidden", raised against `src/index.ts` and
// `semantic.spec.ts`). A test harness is not part of the library's dependency
// graph, so it must not register an edge in it.
const HARNESS_GRAPH_STORE = '@adhd/sox-graph-store';
const HARNESS_STORE_ADAPTER = '@adhd/sox-store-adapter';

const { createSemanticBackend } = await import(pathToFileURL(distEntry).href);
const { createGraphBackend } = await import(HARNESS_GRAPH_STORE);
const { createStoreAdapter } = await import(HARNESS_STORE_ADAPTER);

const dir = mkdtempSync(join(tmpdir(), 'sox-semantic-optional-'));
const adapter = await createStoreAdapter({ dbPath: join(dir, 't.db') });

// Mirror a real consumer's boot order (README quick start): schema first, so
// graph-store's eager engine-identity read has a store to read from.
const graph = createGraphBackend(adapter);
await graph.applySchema();

/** A minimal in-memory provider — stands in for the injected live object. */
const mockProvider = {
  metadata: { modelId: 'mock', dimensions: 4, maxTokens: 512, isRemote: false, isDeterministic: true },
  async embedSingle() {
    return new Float32Array([1, 0, 0, 0]);
  },
  async *embedBatch(texts) {
    for (let i = 0; i < texts.length; i += 1) yield new Float32Array([1, 0, 0, 0]);
  },
  async warmUp() {},
  health() {
    return { configured: 'mock', active: 'mock', state: 'real', dimensions: 4, last_error: null };
  },
};

/** A minimal in-memory vector backend — the second injected live object. */
const mockVectorBackend = {
  async ensureSpace() {},
  async upsert() {},
  async upsertVectors() {},
  async delete() {},
  async knn() {
    return [];
  },
};

let exitCode = 0;
try {
  const result = await createSemanticBackend({
    adapter,
    // Deliberately a config that WOULD require @adhd/sox-embedding-provider —
    // the injected provider must make it irrelevant.
    embedding: { type: 'fastembed', model: 'must-never-be-loaded' },
    embeddingProvider: mockProvider,
    vectorBackend: mockVectorBackend,
    space: { modelId: 'mock', dim: 4 },
  });

  if (!result.ok) {
    fail(`injected path returned a failure: ${JSON.stringify(result.failure)}`);
    exitCode = 3;
  } else {
    // Exercise the injected surface, so "loaded" is proven by behaviour and not
    // just by construction returning ok.
    const vec = await result.backend.embedQuery('probe');
    await result.backend.upsertVector(1, vec);
    emit(
      1,
      JSON.stringify({
        ok: true,
        modelId: result.backend.modelId,
        dim: result.backend.dim,
        vecLen: vec.length,
        health: result.backend.health().state,
      }),
    );
  }
} catch (err) {
  fail(`injected path threw: ${err instanceof Error ? err.stack : String(err)}`);
  exitCode = 4;
} finally {
  try {
    await adapter.close();
  } catch {
    /* the probe's own teardown must not mask the result */
  }
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exitCode);
