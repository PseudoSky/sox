#!/usr/bin/env node
/**
 * optional-load-guard.mjs — child-process probe for @adhd/sox-hybrid-search's
 * optional-loadability invariant (ADR-0019).
 *
 * THE INVARIANT
 * `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` are OPTIONAL
 * dependencies, each of which drags a native chain (vector-store → sqlite-vec /
 * better-sqlite3 / lancedb; embedding-provider → onnxruntime / fastembed). The
 * pure surface (`fuse` / `normalize` / `rrfFuse`) and `StoreSearchBackend` over
 * constructor-injected backends must load and run with neither present, so on
 * that path neither specifier may be RESOLVED — not merely "not executed". The
 * cross-encoder is the only path that resolves embedding-provider, and only on
 * first `createCrossEncoder()`.
 *
 * WHY A CHILD PROCESS WITH A RESOLVE HOOK
 * ESM resolution is not observable from inside the module being tested, and a
 * CJS `Module._load` patch would see nothing at all: the built artifact is ESM,
 * so its static imports never pass through `Module._load`. `module.register()`
 * installs a real ESM resolve hook that sees every specifier the graph resolves,
 * which is the only mechanism that can prove a NEGATIVE ("never requested").
 *
 * TWO MODES (argv[4]) — kept separate so each assertion is clean:
 *   - `pure` (default): loads `dist/index.js` and exercises the pure surface +
 *     `StoreSearchBackend` over a REAL `@adhd/sox-graph-store` backend. The hook
 *     log must contain `@adhd/sox-graph-store` (positive control — the hook
 *     demonstrably observed real resolutions) and NEITHER heavy specifier. The
 *     cross-encoder is deliberately NOT touched here, so a heavy resolution in
 *     this mode can only be a regression.
 *   - `cross-encoder`: loads `dist/index.js` and calls `createCrossEncoder()`.
 *     The hook throws on `@adhd/sox-embedding-provider`, and the probe proves
 *     the failure is the honest, named-specifier degradation (not a bare
 *     ERR_MODULE_NOT_FOUND) and that it does not poison the pure surface.
 *
 * POSITIVE CONTROL
 * hybrid-search's own emitted graph is type-only against `@adhd/sox-graph-store`
 * (erased at emit), so importing `dist/index.js` alone resolves no bare
 * specifier. The `pure` probe therefore drives `StoreSearchBackend` over a REAL
 * graph backend (built from a real `@adhd/sox-store-adapter`), exactly as a
 * consumer does — which resolves `@adhd/sox-graph-store` and proves the hook
 * observed real resolutions, so the heavy-specifier negatives are not vacuous.
 *
 * Usage: node optional-load-guard.mjs <dist-entry> <log-file> [pure|cross-encoder]
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

const [, , distEntry, logFile, mode = 'pure'] = process.argv;
if (!distEntry || !logFile || (mode !== 'pure' && mode !== 'cross-encoder')) {
  fail('usage: node optional-load-guard.mjs <dist-entry> <log-file> [pure|cross-encoder]');
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
// libraries are forbidden"). A test harness is not part of the library's
// dependency graph, so it must not register an edge in it.
const HARNESS_GRAPH_STORE = '@adhd/sox-graph-store';
const HARNESS_STORE_ADAPTER = '@adhd/sox-store-adapter';

const mod = await import(pathToFileURL(distEntry).href);

let exitCode = 0;

if (mode === 'cross-encoder') {
  // The hook throws on `@adhd/sox-embedding-provider`, so this must reject with
  // the named-specifier message from embeddingProviderRuntime().
  let encoderError = null;
  try {
    await mod.createCrossEncoder({ modelId: 'probe' });
    fail('createCrossEncoder unexpectedly succeeded while embedding-provider is unreachable');
    exitCode = 6;
  } catch (e) {
    encoderError = { name: e?.name, message: e?.message, code: e?.code ?? null };
  }

  if (exitCode === 0) {
    // The failure must not poison the pure surface.
    const fusedAfter = mod.fuse([{ id: 1, textScore: 1 }]);
    emit(1, JSON.stringify({ ok: true, encoderError, fusedAfter: fusedAfter.map((r) => r.id) }));
  }
} else {
  const { createGraphBackend } = await import(HARNESS_GRAPH_STORE);
  const { createStoreAdapter } = await import(HARNESS_STORE_ADAPTER);

  const dir = mkdtempSync(join(tmpdir(), 'sox-hybrid-optional-'));
  const adapter = await createStoreAdapter({ dbPath: join(dir, 't.db') });

  /** A minimal in-memory vector backend — the injected live object (ADR-0006 DI). */
  const mockVectorBackend = {
    async listSpaces() {
      return [];
    },
    async knn() {
      return [];
    },
  };

  try {
    const graph = createGraphBackend(adapter);
    await graph.applySchema();
    await graph.writeNode('hybrid search probe alpha', { kind: 'generic', name: 'probe' });

    // 1. The pure functions — no storage, no native chain.
    const fused = mod.fuse([
      { id: 1, textScore: 1 },
      { id: 2, textScore: 2 },
    ]);
    const normalized = mod.normalize([1, 2, 3], 'min_max');
    const rrf = mod.rrfFuse(
      new Map([
        ['text', [1, 2]],
        ['vec', [2, 3]],
      ]),
      new Map([
        ['text', 1],
        ['vec', 1],
      ]),
    );

    // 2. StoreSearchBackend over a REAL graph backend + an injected mock vector
    //    backend. This is the consumer path the adhd backlog takes.
    const backend = new mod.StoreSearchBackend(mockVectorBackend, graph);
    const ranked = await backend.searchRanked(
      { text: 'hybrid', signals: [{ kind: 'text' }] },
      5,
    );
    if (ranked.length < 1) {
      fail(
        `StoreSearchBackend.searchRanked returned no results over a real graph: ${JSON.stringify(ranked)}`,
      );
      exitCode = 5;
    } else {
      emit(
        1,
        JSON.stringify({
          ok: true,
          fused: fused.map((r) => r.id),
          normalized,
          rrf: rrf.map((r) => r.id),
          ranked: ranked.map((r) => r.id),
        }),
      );
    }
  } catch (err) {
    fail(`probe threw: ${err instanceof Error ? err.stack : String(err)}`);
    exitCode = 4;
  } finally {
    try {
      await adapter.close();
    } catch {
      /* the probe's own teardown must not mask the result */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exitCode);
