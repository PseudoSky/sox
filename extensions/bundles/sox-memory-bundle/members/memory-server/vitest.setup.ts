/**
 * vitest.setup.ts — memory-server test setup.
 *
 * SOX_SYNC_EMBED=1 pins the PRE-EXISTING suite to the synchronous-embed
 * composition (the kill-switch path of the 2026-07-04 two-phase write split).
 * Rationale: dozens of existing specs write via handleToolCall and immediately
 * assert vector-dependent state (near-dup edges, clustering, recall ranking).
 * Under the async default those assertions would race the fire-and-forget
 * Phase-B pipeline. The sync composition is byte-compatible with the pre-split
 * behaviour, so the 92-test baseline pins exactly what it always pinned.
 *
 * The async DEFAULT path is covered explicitly and deterministically by
 * async-embed.spec.ts, which deletes this env for its own describe blocks and
 * uses the BL-161 deterministic provider seam (no real ONNX, no timing).
 *
 * STORE_ADAPTER=sqlite pins the pre-existing suite to the SqliteAdapter.
 * The adapter factory now defaults to 'turso', but existing tests were written
 * for better-sqlite3 and may not handle TursoAdapter features. Cross-backend
 * parity is covered explicitly by recall-parity.test.ts and
 * heal-backend-agnostic.test.ts, which set STORE_ADAPTER=turso in their
 * own describe blocks.
 */
process.env['SOX_SYNC_EMBED'] = '1';
process.env['STORE_ADAPTER'] = 'sqlite';

/**
 * BL-412 whole-suite guard: no test in this project may EVER open a
 * connection (or even probe with existsSync/statSync/mkdirSync) against the
 * REAL, live, production store under `~/.memory/**`. That directory is the
 * user's actual memory database — a test process that touches it either
 * reads production data or (worse, per BL-412) registers the path into the
 * server's `openedPaths` set, enlisting the live store into this process's
 * background enrichment scheduler as a side effect of running tests.
 *
 * IMPLEMENTATION NOTE — why not `vi.spyOn(fs, 'existsSync')`:
 * `import * as fs from 'node:fs'` gives an ES module namespace object whose
 * properties are non-configurable by spec — both a plain reassignment AND
 * `vi.spyOn` throw `TypeError: Cannot redefine property` /
 * "Module namespace is not configurable in ESM" against it in this
 * environment (verified empirically; this is what made the ORIGINAL
 * `bl412-ping-no-live-store.spec.ts`, which used exactly this pattern,
 * silently unrunnable — every one of its 3 tests failed on
 * `vi.spyOn(fs, 'existsSync')` before a single assertion executed, which is
 * exactly the kind of thing BL-225 exists to catch: it was committed as a
 * regression test and never actually watched to pass).
 *
 * Fix: obtain `fs` via CommonJS `createRequire(...)('node:fs')` instead of
 * an ESM namespace import. That returns Node's actual internal
 * `module.exports` object for the `fs` module — a genuinely mutable plain
 * object, not a frozen ESM namespace — and Node's ESM/CJS interop means
 * every `import * as fs from 'node:fs'` elsewhere in the process (including
 * inside index.ts and the memory-core dist bundle) reads its properties
 * live off that SAME underlying object, so mutating it here is visible
 * everywhere. Verified with a standalone repro before wiring this in.
 */
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');

const REAL_HOME_MEMORY_DIR = path.join(os.homedir(), '.memory');
let liveStoreTouches: string[] = [];

function touchesRealStore(p: unknown): p is string {
  return typeof p === 'string' && (p === REAL_HOME_MEMORY_DIR || p.startsWith(REAL_HOME_MEMORY_DIR + path.sep));
}

const GUARDED_FNS = ['existsSync', 'readFileSync', 'statSync', 'openSync', 'mkdirSync', 'writeFileSync', 'lstatSync'] as const;
type GuardedFn = (typeof GUARDED_FNS)[number];

// Capture the true, never-wrapped originals once, at module-load time —
// before this file or any spec has a chance to wrap anything. Every
// subsequent (re-)installation of the guard always delegates to these exact
// references, so re-arming (see beforeEach below) is idempotent no matter
// how many times a test's own cleanup mutates `fs`'s properties.
const trueOriginals = {} as Record<GuardedFn, (...args: unknown[]) => unknown>;
for (const fnName of GUARDED_FNS) {
  trueOriginals[fnName] = fs[fnName] as unknown as (...args: unknown[]) => unknown;
}

function install(): void {
  for (const fnName of GUARDED_FNS) {
    const original = trueOriginals[fnName];
    (fs as unknown as Record<string, unknown>)[fnName] = function bl412Guarded(...args: unknown[]) {
      if (touchesRealStore(args[0])) {
        liveStoreTouches.push(`${fnName}(${String(args[0])})\n${new Error('BL-412 live-store touch').stack}`);
      }
      return original.apply(fs, args);
    };
  }
}

// Installed once at setup-load time. Re-installed defensively in beforeEach
// too, in case some other spec's own cleanup logic reassigns one of these
// `fs` properties back to a bare original (none currently do, but the guard
// must not depend on that staying true).
install();

beforeEach(() => {
  liveStoreTouches = [];
  install();
});

afterEach(() => {
  if (liveStoreTouches.length > 0) {
    const report = liveStoreTouches.splice(0, liveStoreTouches.length);
    throw new Error(
      `BL-412 REGRESSION: ${report.length} touch(es) to the REAL live store under ` +
        `${REAL_HOME_MEMORY_DIR} during this test:\n\n${report.join('\n---\n')}`,
    );
  }
});

/**
 * BL-404 universal-coverage: per-worker telemetry composition root. The real
 * composition root in index.ts (MEMORY_SERVER_TELEMETRY_INIT_OPTIONS) is gated
 * behind `require.main === module`, so a vitest worker importing the server
 * code NEVER runs it — every tool-call record emitted by memory-core during
 * these tests was silently dropped behind the logSink:'none' fallback (the
 * one-shot stderr warning was the only tell). `logDir` is deliberately omitted
 * so the runtime default lands records under the ecosystem home —
 * `~/.adhd/sox-ecosystem/sox-tests/logs` (honoring the `SOX_ECOSYSTEM_HOME`
 * override when a sandbox sets it) — matching the memory-server durable-JSONL
 * pattern; never a bare tmpdir. That path is outside the ~/.memory/** root the
 * BL-412 guard watches above. Role 'test' keeps the OTel SDK off in every
 * worker (otelDefaultFor in @adhd/sox-telemetry).
 */
import { initTelemetry } from '@adhd/sox-telemetry';

initTelemetry({ service: 'sox-tests', role: 'test', logSink: 'file' });
