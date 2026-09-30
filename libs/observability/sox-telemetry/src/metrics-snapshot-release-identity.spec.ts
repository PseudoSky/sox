/**
 * metrics-snapshot-release-identity.spec.ts — durable-metrics S3
 * (`5ac0a1a8-dbad-486a-824c-cec3660e91a5`), BL-225.
 *
 * The defect this closes: a durable `metrics.snapshot` line named the service,
 * the role, the pid and the process-start window, but NOTHING that identifies
 * WHICH RELEASE produced it. Two snapshots a release apart were therefore
 * bitwise indistinguishable in the field that matters for comparison — you
 * could not tell a regression in a new build from a config change on the old
 * one, nor diff the same series across a cutover. S3 makes the persisted record
 * carry a `release` identity: `{ version, artifact_sha256, git_sha }`.
 *
 * The null contract is the whole point of the type (BL-433 spirit): an absent
 * value is `null` — NEVER `''`, never `undefined`. `''` is the BL-319/BL-347
 * absent-field ambiguity (a legal-looking string that means "unknown"), and it
 * cannot be distinguished from a real value by a downstream comparison. The
 * three fields are resolved to `null` at `initTelemetry` time so every snapshot
 * row carries a well-formed, comparable object regardless of what the caller
 * passed.
 *
 * ## Root pinning / hermeticity
 *
 * `beforeAll` pins `SOX_ECOSYSTEM_HOME` at a fresh `mkdtempSync('s3-')` for the
 * WHOLE file (restored in `afterAll`) — stronger than the package default, and
 * proves the `ecosystemHome()` resolver (not a hardcoded path) is what routes
 * every write. It also scrubs `SOX_TRACE_SNAPSHOT_MS` / `SOX_TRACE_SNAPSHOT_EVERY`
 * for the file (`dbcaffb4`: the suite is not hermetic against the ambient
 * interval override, and an interval snapshot assertion must be deterministic).
 * Instead of racing the live production writers (a recursive real-root equality
 * check is flaky while a real memory-server is running), the teardown asserts
 * (a) the unique test service dir never appeared under the real root, and
 * (b) no NEW file appeared under the real root at all.
 *
 * ## Why the four `*_TELEMETRY_INIT_OPTIONS` constants are source-read
 *
 * Acceptance (3) covers the four production composition-root option constants
 * (`SOX_CLI_*`, `MEMORY_SERVER_*`, `MEMORY_CLI_*`, `MEMORY_FLUSH_*`). Three of
 * them live in OTHER nx projects, and `apps/sox/src/main.ts` is an unconditional
 * entrypoint (`void main()` at module top level — its own spec, bl511, drives the
 * COMPILED `dist/apps/sox/main.js` as a subprocess, never imports it). Importing
 * any of these from a `sox-telemetry` spec would either execute a CLI or violate
 * the nx project graph. So the constants are asserted the only honest way from
 * this package: read each defining file, assert its exported option object
 * carries NO `logDir`, extract its `service`, and then — behaviourally — prove
 * that a config with that exact `service`/`logSink:'file'` and no `logDir` lands
 * its snapshot under `<SOX_ECOSYSTEM_HOME>/<service>/logs/`. Together that is
 * "the resolver wins, not a hardcoded path", for each of the four.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initTelemetry,
  snapshotMetrics,
  rollupMetrics,
  telemetrySelfCheck,
  _resetTelemetryForTest,
} from './index.js';

/** The service this file writes under. Deliberately one no real composition
 *  root uses, so its absence under the real root is an unambiguous leak signal. */
const SERVICE = 's3-release';
const ROLE = 'live-service';

/** The exact value the release path must round-trip, byte for byte. */
const RELEASE = {
  version: '1.2.3',
  artifact_sha256: `sha256:${'a'.repeat(64)}`,
  git_sha: 'deadbeefcafe0123456789abcdef0123456789ab',
} as const;

const REAL_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem');
const REAL_SERVICE_DIR = path.join(REAL_ROOT, SERVICE);

/** Repo root, derived from this file's own location (libs/observability/
 *  sox-telemetry/src/ → four levels up). Never cwd-dependent. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** One check phase — enough for the deferred startup snapshot to land. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function logDirFor(home: string, service: string): string {
  return path.join(home, service, 'logs');
}

/** Every persisted `metrics.snapshot` row under `logDir`, across all rotated
 *  snapshot files. Only the snapshot component is read — never the event stream. */
function readSnapshots(logDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((f) => f.includes('.metrics-snapshot-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(logDir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

/** Every persisted `metrics.rollup` row under the `rollup/` subdir of a logDir. */
function readRollupRows(rollupDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(rollupDir)) return [];
  return fs
    .readdirSync(rollupDir)
    .filter((f) => f.includes('.metrics-rollup-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(rollupDir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out.sort();
}

let scratchHome: string;
let savedEcosystemHome: string | undefined;
let savedTraceMs: string | undefined;
let savedTraceEvery: string | undefined;
let realRootBefore: string[] = [];

beforeAll(() => {
  // dbcaffb4: the suite is not hermetic against these ambient overrides — scrub
  // and restore so the interval cadence asserted below is deterministic.
  savedTraceMs = process.env['SOX_TRACE_SNAPSHOT_MS'];
  savedTraceEvery = process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  delete process.env['SOX_TRACE_SNAPSHOT_MS'];
  delete process.env['SOX_TRACE_SNAPSHOT_EVERY'];

  savedEcosystemHome = process.env['SOX_ECOSYSTEM_HOME'];
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 's3-'));
  process.env['SOX_ECOSYSTEM_HOME'] = scratchHome;

  realRootBefore = listFilesRecursive(REAL_ROOT);
});

afterEach(() => {
  _resetTelemetryForTest();
  // Clear this file's service dirs between cases so a later case's row set is
  // never polluted by an earlier one's snapshots.
  for (const svc of [SERVICE, 'sox', 'memory-server', 'memory-cli', 'memory-flush']) {
    fs.rmSync(path.join(scratchHome, svc), { recursive: true, force: true });
  }
});

afterAll(() => {
  _resetTelemetryForTest();

  const added = listFilesRecursive(REAL_ROOT).filter((p) => !realRootBefore.includes(p));

  if (savedEcosystemHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = savedEcosystemHome;
  if (savedTraceMs === undefined) delete process.env['SOX_TRACE_SNAPSHOT_MS'];
  else process.env['SOX_TRACE_SNAPSHOT_MS'] = savedTraceMs;
  if (savedTraceEvery === undefined) delete process.env['SOX_TRACE_SNAPSHOT_EVERY'];
  else process.env['SOX_TRACE_SNAPSHOT_EVERY'] = savedTraceEvery;

  fs.rmSync(scratchHome, { recursive: true, force: true });

  // The real root must have gained NOTHING from this run. A live production
  // writer may APPEND to (or prune) existing files, so this checks additions
  // only — a NEW path is the only shape a leaked test write can take.
  expect(added, `test telemetry leaked new files under ${REAL_ROOT}`).toEqual([]);
  expect(fs.existsSync(REAL_SERVICE_DIR), `test wrote the real ${REAL_SERVICE_DIR}`).toBe(false);
});

describe('S3 — release identity on every metrics.snapshot (5ac0a1a8…)', () => {
  it('5ac0a1a8-dbad-486a-824c-cec3660e91a5: every persisted snapshot carries release identity (null, never empty string, when unset)', async () => {
    const logDir = logDirFor(scratchHome, SERVICE);

    // ── WITH release: every reason's row carries all three fields exactly. ──
    const handle = initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 25,
      release: RELEASE,
    });

    await tick(); // 'startup' — the deferred baseline snapshot
    await snapshotMetrics('pull'); // 'pull'
    await sleep(140); // 'interval'
    handle.close(); // 'shutdown'
    await sleep(50);

    const withRelease = readSnapshots(logDir);
    const reasons = new Set(withRelease.map((r) => r['reason']));
    for (const reason of ['startup', 'pull', 'interval', 'shutdown']) {
      expect(reasons.has(reason), `no ${reason} snapshot was written`).toBe(true);
    }
    expect(withRelease.length).toBeGreaterThanOrEqual(4);
    // EVERY row — whatever its reason — carries the release identity verbatim.
    for (const row of withRelease) {
      expect(row['release']).toEqual(RELEASE);
      const rel = row['release'] as Record<string, unknown>;
      expect(rel['version']).not.toBe('');
      expect(rel['artifact_sha256']).not.toBe('');
      expect(rel['git_sha']).not.toBe('');
    }

    // ── WITHOUT release: all three are null — never `''`, never `undefined`. ──
    _resetTelemetryForTest();
    fs.rmSync(path.join(scratchHome, SERVICE), { recursive: true, force: true });
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    await snapshotMetrics('pull');

    const withoutRelease = readSnapshots(logDir);
    expect(withoutRelease.length).toBeGreaterThanOrEqual(1);
    for (const row of withoutRelease) {
      const rel = row['release'] as Record<string, unknown> | undefined;
      expect(rel, 'release must still be present as an object').toBeDefined();
      // toBeNull() is the contract; not.toBe('') is the BL-433 anti-regression.
      expect(rel!['version']).toBeNull();
      expect(rel!['artifact_sha256']).toBeNull();
      expect(rel!['git_sha']).toBeNull();
      expect(rel!['version']).not.toBe('');
      expect(rel!['artifact_sha256']).not.toBe('');
      expect(rel!['git_sha']).not.toBe('');
    }

    // BL-433 must NOT have regressed: no snapshot sink ⇒ `file` is null, not ''.
    expect(telemetrySelfCheck().metric_persistence.file).not.toBe('');
  });

  it('acceptance (2): an omitted inner field is null, not inherited from a sibling init', async () => {
    // A partial release (one field only) must fill the rest with null — the
    // normaliser is per-field, not all-or-nothing.
    const logDir = logDirFor(scratchHome, SERVICE);
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: { version: '9.9.9', artifact_sha256: null, git_sha: null },
    });
    await snapshotMetrics('pull');

    const rel = readSnapshots(logDir)[0]!['release'] as Record<string, unknown>;
    expect(rel['version']).toBe('9.9.9');
    expect(rel['artifact_sha256']).toBeNull();
    expect(rel['git_sha']).toBeNull();
    expect(rel['artifact_sha256']).not.toBe('');
    expect(rel['git_sha']).not.toBe('');
  });

  it('acceptance (4): initialising telemetry on the release path adds no process.env key (ADR-0013)', () => {
    _resetTelemetryForTest();
    const before = new Set(Object.keys(process.env));
    initTelemetry({
      service: SERVICE,
      role: 'test',
      logSink: 'file',
      otel: false,
      snapshotEveryMs: 0,
      release: RELEASE,
    });
    const added = Object.keys(process.env).filter((k) => !before.has(k));
    expect(added).toEqual([]);
  });

  it('acceptance (5): rollupMetrics exists and every rollup row carries the deep-equal-to-the-snapshot release identity (S8)', async () => {
    // S8 (6df0d673…) lands the rollup. This is the release-contract proof: a
    // rollup row's `release` must be DEEP-EQUAL to the snapshot's — the S3
    // identity, consumed verbatim — and null-filled (never `''`) when unset.
    const mod = (await import('./index.js')) as Record<string, unknown>;
    expect(typeof mod['rollupMetrics']).toBe('function');

    const logDir = logDirFor(scratchHome, SERVICE);
    const rollupDir = path.join(logDir, 'rollup');

    // ── WITH release: the rollup row carries it verbatim. ──
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: RELEASE,
      rollupWindowMs: 3_600_000,
    });
    await snapshotMetrics('pull');
    await rollupMetrics('interval');

    const withRelease = readRollupRows(rollupDir);
    expect(withRelease.length).toBeGreaterThanOrEqual(1);
    for (const row of withRelease) {
      expect(row['event']).toBe('metrics.rollup');
      expect(row['release']).toEqual(RELEASE);
    }

    // ── WITHOUT release: null-filled, never `''`. ──
    _resetTelemetryForTest();
    fs.rmSync(path.join(scratchHome, SERVICE), { recursive: true, force: true });
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });
    await snapshotMetrics('pull');
    await rollupMetrics('interval');

    const withoutRelease = readRollupRows(rollupDir);
    expect(withoutRelease.length).toBeGreaterThanOrEqual(1);
    for (const row of withoutRelease) {
      const rel = row['release'] as Record<string, unknown>;
      expect(rel['version']).toBeNull();
      expect(rel['artifact_sha256']).toBeNull();
      expect(rel['git_sha']).toBeNull();
      expect(rel['version']).not.toBe('');
      expect(rel['artifact_sha256']).not.toBe('');
      expect(rel['git_sha']).not.toBe('');
    }
  });
});

describe('S3 — acceptance (3): the four production telemetry-init option constants', () => {
  interface Probe {
    label: string;
    constName: string;
    file: string;
  }

  const BUNDLE = 'extensions/bundles/sox-memory-bundle/members';
  const PROBES: Probe[] = [
    {
      label: 'sox',
      constName: 'SOX_CLI_TELEMETRY_INIT_OPTIONS',
      file: path.join(REPO_ROOT, 'apps/sox/src/main.ts'),
    },
    {
      label: 'memory-server',
      constName: 'MEMORY_SERVER_TELEMETRY_INIT_OPTIONS',
      file: path.join(REPO_ROOT, BUNDLE, 'memory-server/src/index.ts'),
    },
    {
      label: 'memory-cli',
      constName: 'MEMORY_CLI_TELEMETRY_INIT_OPTIONS',
      file: path.join(REPO_ROOT, BUNDLE, 'memory-cli/src/index.ts'),
    },
    {
      label: 'memory-flush',
      constName: 'MEMORY_FLUSH_TELEMETRY_INIT_OPTIONS',
      file: path.join(REPO_ROOT, BUNDLE, 'memory-flush/src/index.ts'),
    },
  ];

  /** Slice the exported option object literal out of a source file. The object
   *  is flat at the top level (nested literals close with `},`, never `\n};`),
   *  so the first `\n};` after the opening brace is the object's own close. */
  function extractConstBlock(src: string, name: string): string {
    const start = src.indexOf(`export const ${name}`);
    expect(start, `${name} not found in source`).toBeGreaterThanOrEqual(0);
    const open = src.indexOf('{', start);
    const close = src.indexOf('\n};', open);
    expect(close, `${name} object literal unterminated`).toBeGreaterThan(open);
    return src.slice(open, close);
  }

  for (const probe of PROBES) {
    it(`${probe.constName} carries no logDir and resolves under <SOX_ECOSYSTEM_HOME>/<service>/logs/`, async () => {
      const src = fs.readFileSync(probe.file, 'utf8');
      const block = extractConstBlock(src, probe.constName);

      // (a) none carries a logDir — the source of truth for a file we cannot
      // import here (see the file header for why).
      expect(block, `${probe.label}: ${probe.constName} must not carry a logDir`).not.toMatch(
        /\blogDir\b/,
      );
      // It must still name the service the resolver uses.
      const serviceMatch = block.match(/service:\s*'([^']+)'/);
      expect(serviceMatch, `${probe.label}: ${probe.constName} must set a string service`).not.toBeNull();
      const service = serviceMatch![1]!;

      // (b) behaviourally: an option of that exact `service` + `logSink:'file'`
      // with no `logDir` resolves its snapshot under `<home>/<service>/logs/` —
      // i.e. `ecosystemHome()` wins, never a hardcoded path.
      _resetTelemetryForTest();
      initTelemetry({ service, role: 'test', logSink: 'file', otel: false, snapshotEveryMs: 0 });
      const planned = telemetrySelfCheck().metric_persistence.file;
      expect(planned, `${service}: no snapshot path was planned`).not.toBeNull();
      expect(planned).not.toBe('');
      const expectedDir = logDirFor(scratchHome, service);
      expect(planned!.startsWith(expectedDir + path.sep)).toBe(true);

      await snapshotMetrics('pull');
      expect(readSnapshots(expectedDir).length).toBeGreaterThanOrEqual(1);
      // The unique test service is never one of these; the real root stays clean.
      expect(fs.existsSync(REAL_SERVICE_DIR)).toBe(false);
    });
  }
});
