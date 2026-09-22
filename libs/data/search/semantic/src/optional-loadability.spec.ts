import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Optional-loadability regression guard for `@adhd/sox-semantic`.
 *
 * `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` are optional
 * dependencies, each of which drags a native chain (`sqlite-vec` /
 * `better-sqlite3` / `lancedb`; `onnxruntime` / `fastembed`). A caller that
 * injects BOTH `embeddingProvider` and `vectorBackend` must be able to load and
 * use this package with neither installed.
 *
 * Two things therefore have to hold, and both are asserted here:
 *
 *   1. The SHIPPED artifact (`dist/index.js`) resolves neither specifier on the
 *      injected path. This is why the probe loads `dist/`, not `src/`: the
 *      failure mode is a module-graph shape, and only the built graph is what a
 *      consumer actually gets. `project.json`'s `test` target declares
 *      `dependsOn: ["^build", "build"]` so the artifact is always present.
 *   2. The manifest keeps them optional, so an install can omit them.
 *
 * The probe is a child process with an ESM resolve hook (see
 * `__tests__/fixtures/optional-load-guard.mjs`), because ESM resolution cannot
 * be observed from inside the module under test, and a CJS `Module._load` patch
 * would see nothing — the artifact is ESM, so its static imports never pass
 * through `Module._load`.
 *
 * Note on scope: `semanticSearchNodes` (the RRF node-join) deliberately still
 * needs `@adhd/sox-hybrid-search`, which is a MANDATORY dependency. The probe
 * therefore exercises construction + `embedQuery`/`upsertVector` — the surface a
 * DI-injected consumer needs to avoid the native chain — and does not call
 * `semanticSearchNodes`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');
const manifestPath = path.join(packageRoot, 'package.json');
const childScript = path.join(here, '__tests__', 'fixtures', 'optional-load-guard.mjs');

const HEAVY = ['@adhd/sox-vector-store', '@adhd/sox-embedding-provider'] as const;
/** A mandatory dependency that MUST be resolved — the probe's positive control. */
const MANDATORY = '@adhd/sox-graph-store';

interface GuardRun {
  status: number | null;
  stdout: string;
  stderr: string;
  requested: string[];
}

function runGuard(): GuardRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-semantic-guard-'));
  const logFile = path.join(dir, 'resolved.log');
  fs.writeFileSync(logFile, '');
  try {
    const res = spawnSync(process.execPath, [childScript, distEntry, logFile], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 60_000,
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

describe('optional-loadability — the injected path must not resolve the optional native chain', () => {
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

  it('loads and runs the injected path with zero requests for the heavy two', () => {
    const run = runGuard();
    const detail = `child exit=${String(run.status)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

    // The hook throws on any heavy resolution, so a clean import is the proof;
    // the recorded log below is the direct evidence.
    expect(run.stderr, detail).not.toContain('OPTIONAL-LOAD GUARD');
    expect(run.status, detail).toBe(0);

    const payload = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      modelId: string;
      dim: number;
      vecLen: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.modelId).toBe('mock');
    expect(payload.dim).toBe(4);
    expect(payload.vecLen).toBe(4);

    // Positive control FIRST: the hook demonstrably observed real resolutions,
    // so the negative assertions that follow are not vacuous.
    expect(run.requested).toContain(MANDATORY);
    for (const heavy of HEAVY) {
      expect(run.requested).not.toContain(heavy);
    }
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
  });
});
