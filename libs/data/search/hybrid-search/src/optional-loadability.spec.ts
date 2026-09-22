import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Optional-loadability regression guard for `@adhd/sox-hybrid-search` (ADR-0019).
 *
 * `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` are optional
 * dependencies, each of which drags a native chain (`sqlite-vec` /
 * `better-sqlite3` / `lancedb`; `onnxruntime` / `fastembed`). The pure surface
 * (`fuse` / `normalize` / `rrfFuse`) and `StoreSearchBackend` over
 * constructor-injected backends must load and run with neither installed. Two
 * things therefore have to hold, and both are asserted here:
 *
 *   1. The SHIPPED artifact (`dist/index.js`) resolves neither specifier on the
 *      pure path. This is why the probe loads `dist/`, not `src/`: the failure
 *      mode is a module-graph shape, and only the built graph is what a consumer
 *      actually gets. `project.json`'s `test` target declares
 *      `dependsOn: ["^build", "build"]` so the artifact is always present.
 *   2. The manifest keeps them optional, so an install can omit them.
 *
 * The probe is a child process with an ESM resolve hook (see
 * `__tests__/fixtures/optional-load-guard.mjs`), because ESM resolution cannot
 * be observed from inside the module under test, and a CJS `Module._load` patch
 * would see nothing — the artifact is ESM, so its static imports never pass
 * through `Module._load`.
 *
 * The probe runs in TWO modes so each assertion is clean: `pure` (never touches
 * the cross-encoder) and `cross-encoder` (must honestly degrade when
 * embedding-provider is unreachable). The cross-encoder path is the ONLY path
 * that resolves embedding-provider, and only on first `createCrossEncoder()`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');
const manifestPath = path.join(packageRoot, 'package.json');
const childScript = path.join(here, '__tests__', 'fixtures', 'optional-load-guard.mjs');

const HEAVY = ['@adhd/sox-vector-store', '@adhd/sox-embedding-provider'] as const;
/** A mandatory dependency that the probe resolves for real — the positive control. */
const MANDATORY = '@adhd/sox-graph-store';

interface GuardRun {
  status: number | null;
  stdout: string;
  stderr: string;
  requested: string[];
}

function runGuard(mode: 'pure' | 'cross-encoder'): GuardRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-hybrid-guard-'));
  const logFile = path.join(dir, 'resolved.log');
  fs.writeFileSync(logFile, '');
  try {
    const res = spawnSync(process.execPath, [childScript, distEntry, logFile, mode], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const requested = fs
      .readFileSync(logFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      requested,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('optional-loadability — the pure path must not resolve the optional native chain', () => {
  beforeAll(() => {
    // Fail LOUDLY rather than skip. A skip here would read as a pass while the
    // invariant went unverified — the exact "green because it never ran" trap.
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        `built artifact missing at ${distEntry}. This probe loads the real dist (the bytes a consumer ` +
          `gets), so the 'build' target must run first — the test target declares dependsOn: ["^build", "build"].`,
      );
    }
  });

  it('loads and runs the pure surface with zero requests for the heavy two', () => {
    const run = runGuard('pure');
    const detail = `child exit=${String(run.status)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

    // The hook throws on any heavy resolution, so a clean import is the proof;
    // the recorded log below is the direct evidence.
    expect(run.stderr, detail).not.toContain('OPTIONAL-LOAD GUARD');
    expect(run.status, detail).toBe(0);

    const payload = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      fused: number[];
      normalized: number[];
      rrf: number[];
      ranked: number[];
    };
    expect(payload.ok).toBe(true);
    // fuse() and normalize() are pure functions; the StoreSearchBackend rank ran
    // over a REAL graph backend (resolved below) with an injected vector backend.
    expect(payload.fused).toEqual([2, 1]);
    expect(payload.normalized).toEqual([0, 0.5, 1]);
    expect(payload.rrf.length).toBeGreaterThan(0);
    expect(payload.ranked.length).toBeGreaterThan(0);

    // Positive control FIRST: the hook demonstrably observed a real bare-specifier
    // resolution (the probe's real graph-store backend), so the negative
    // assertions that follow are not vacuous.
    expect(run.requested).toContain(MANDATORY);
    for (const heavy of HEAVY) {
      expect(run.requested, `${heavy} must NOT be resolved on the pure path`).not.toContain(heavy);
    }
  });

  it('degrades the cross-encoder honestly — naming the specifier, not a bare ERR_MODULE_NOT_FOUND', () => {
    const run = runGuard('cross-encoder');
    const detail = `child exit=${String(run.status)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    expect(run.status, detail).toBe(0);

    const payload = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      encoderError: { name: string; message: string; code: string | null };
      fusedAfter: number[];
    };
    expect(payload.ok).toBe(true);

    // The gate was genuinely reached: the probe DID request embedding-provider
    // (the hook recorded it before throwing), so the assertion below is not
    // vacuous — it fails for the honest reason, not because nothing was tried.
    expect(run.requested).toContain('@adhd/sox-embedding-provider');

    expect(payload.encoderError.message).toContain('@adhd/sox-embedding-provider');
    // A bare module-resolution error would carry code ERR_MODULE_NOT_FOUND; the
    // honest degradation is a plain Error with a precise message + cause.
    expect(payload.encoderError.code).toBeNull();

    // The cross-encoder failure did not poison the pure surface.
    expect(payload.fusedAfter.length).toBeGreaterThan(0);
  });

  it('declares both heavy packages as optionalDependencies, not dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const heavy of HEAVY) {
      expect(pkg.optionalDependencies?.[heavy], `${heavy} must be an optionalDependency`).toBeDefined();
      expect(pkg.dependencies?.[heavy], `${heavy} must NOT be a mandatory dependency`).toBeUndefined();
    }
    expect(pkg.dependencies?.[MANDATORY], `${MANDATORY} must stay a mandatory dependency`).toBeDefined();
  });
});
