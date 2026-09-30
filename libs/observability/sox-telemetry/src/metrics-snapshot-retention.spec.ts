/**
 * metrics-snapshot-retention.spec.ts — durable-metrics S2 (`0fdaaef6…`), BL-225.
 *
 * The defect this closes: the SNAPSHOT component shared the EVENT component's
 * retention cap (`sink.ts`'s default of 7). A snapshot is the CHECKPOINT the
 * event stream is recomputable FROM (§5.8), so a 7-file budget on the snapshot
 * series was backwards — the checkpoint was pruned at the same age as the
 * high-volume events it exists to outlive, and the durable series could not
 * span a release. S2 gives snapshots their OWN cap (default 30) and makes the
 * pruner structurally unable to delete the newest file (`Math.max(1, maxFiles)`).
 *
 * Two levels are covered:
 *   - the RUNTIME precedence (`snapshotMaxFiles ?? maxFiles ?? 30`) through
 *     `initTelemetry` + the real snapshot sink, and
 *   - the PRUNER's hard floor directly on `DurableJsonlSink`.
 *
 * `vitest.setup.ts` pins `SOX_ECOSYSTEM_HOME` at a per-file temp root; the
 * `beforeEach`/`afterEach` pair below is the belt-and-braces proof that every
 * case resolves its root under that scratch dir and never adds a file to the
 * real `~/.adhd/sox-ecosystem` (acceptance (6)).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initTelemetry,
  log,
  snapshotMetrics,
  _resetTelemetryForTest,
  type InitTelemetryOptions,
} from './index.js';
import { DurableJsonlSink } from './sink.js';

/** The real, production data root — no test may ever add a file here. */
const REAL_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem');

const dirs: string[] = [];
let realRootBefore: string[] = [];

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-snapret-'));
  dirs.push(d);
  return d;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** A deterministic `YYYY-MM-DD` string `offset` days after 2020-01-01. */
function dateStr(offset: number): string {
  const d = new Date(Date.UTC(2020, 0, 1 + offset));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function todayDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function readdir(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Recursive file listing (absolute paths, sorted) — used to prove the real
 *  root gained nothing. Returns `[]` when the root does not exist. */
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

/** Seed `offsets.length` correctly-anchored `<component>-<date>.jsonl` files.
 *  Names ascend with `offset`, so name order == chronological order; mtimes are
 *  set distinctly too, so "newest" is unambiguous either way (acceptance (3)). */
function seed(dir: string, component: string, offsets: number[]): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  offsets.forEach((off) => {
    const name = `${component}-${dateStr(off)}.jsonl`;
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{"event":"seed"}\n');
    const t = new Date(Date.UTC(2020, 0, 1 + off));
    fs.utimesSync(p, t, t);
    names.push(name);
  });
  return names;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  // The package-wide sandbox must be active: a test that resolved the REAL root
  // would write production telemetry (03be90c3).
  const home = process.env['SOX_ECOSYSTEM_HOME'];
  expect(home, 'SOX_ECOSYSTEM_HOME must be pinned by vitest.setup.ts').toBeDefined();
  expect(home!.startsWith(os.tmpdir())).toBe(true);
  realRootBefore = listFilesRecursive(REAL_ROOT);
});

afterEach(() => {
  _resetTelemetryForTest();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  // Acceptance (6): nothing was written or pruned outside the resolved root.
  expect(listFilesRecursive(REAL_ROOT)).toEqual(realRootBefore);
});

describe('S2 — two-tier snapshot retention cap (0fdaaef6…)', () => {
  it('0fdaaef6-f19f-4259-a817-c6dcc4153822: the snapshot component caps at 30 by default while the event component still caps at 7', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const service = 'dualm';
    // No `logDir` — the root is resolved from `ecosystemHome()`, proving the cap
    // is applied through the env-derived path, never a hardcoded one.
    const logDir = path.join(home, service, 'logs');
    const eventComponent = `${service}.live-service`;
    const snapComponent = `${service}.live-service.metrics-snapshot`;

    // 35 snapshot files (> the S2 default of 30) and 10 event files (> 7).
    const snapNames = seed(logDir, snapComponent, range(35));
    const eventNames = seed(logDir, eventComponent, range(10));

    initTelemetry({
      service,
      role: 'live-service',
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
    });

    // Deterministic snapshot write → prunes the SNAPSHOT component.
    await snapshotMetrics('pull');
    // Deterministic event write → prunes the EVENT component.
    log.info('dualm.event', {});
    // Let the deferred startup snapshot (S1) drain; it appends to the same
    // today file, so it cannot change either component's file COUNT.
    await sleep(20);

    const snapFiles = readdir(logDir).filter((f) => f.startsWith(`${snapComponent}-`));
    const eventFiles = readdir(logDir).filter((f) => f.startsWith(`${eventComponent}-`));

    // Same service, two components, two DIFFERENT caps in one run.
    expect(snapFiles.length).toBe(30);
    expect(eventFiles.length).toBe(7);

    // ...and it is the NEWEST that survive, the oldest that went.
    expect(snapFiles).toContain(snapNames[34]!);
    expect(snapFiles).not.toContain(snapNames[0]!);
    expect(eventFiles).toContain(eventNames[9]!);
    expect(eventFiles).not.toContain(eventNames[0]!);
  });

  it('acceptance (1): InitTelemetryOptions.snapshotMaxFiles is a typed optional number, defaulting to 30', () => {
    // Compile-time proof the field exists on the PUBLIC options type. A
    // non-number literal below would fail `nx typecheck`.
    const withCap: InitTelemetryOptions = { service: 't', role: 'test', snapshotMaxFiles: 12 };
    expect(withCap.snapshotMaxFiles).toBe(12);
    const withoutCap: InitTelemetryOptions = { service: 't', role: 'test' };
    expect(withoutCap.snapshotMaxFiles).toBeUndefined();

    // Runtime proof of the 30 default: the uid test above observes 30.
  });

  it('acceptance (2): maxFiles 0 or -1 still leaves exactly one file — the newest is never deleted', () => {
    for (const maxFiles of [0, -1]) {
      const dir = makeDir();
      const component = `floor${maxFiles < 0 ? 'neg' : 'zero'}`;
      seed(dir, component, range(5));

      const sink = new DurableJsonlSink({ dir, component, maxFiles });
      sink.write('{"event":"now"}\n');
      sink.close();

      const remaining = readdir(dir).filter((f) => f.startsWith(`${component}-`));
      expect(remaining.length, `maxFiles=${maxFiles} must keep exactly 1`).toBe(1);
      // The survivor is the file the sink is actively appending to (today), not
      // an arbitrarily-old seed — "never delete the newest" made structural.
      expect(remaining[0]).toBe(`${component}-${todayDateString()}.jsonl`);
    }
  });

  it('acceptance (3): seeding maxFiles + 5 files leaves exactly the maxFiles NEWEST', () => {
    const dir = makeDir();
    const component = 'cap3';
    const maxFiles = 4;
    const names = seed(dir, component, range(maxFiles + 5)); // 9 seeds

    const sink = new DurableJsonlSink({ dir, component, maxFiles });
    sink.write('{"event":"now"}\n'); // adds today's file → 10 files total
    sink.close();

    const remaining = readdir(dir).filter((f) => f.startsWith(`${component}-`));
    // Exactly `maxFiles` — not a count-only claim: assert WHICH survived.
    expect(remaining.length).toBe(maxFiles);
    // 10 files − cap 4 = 6 oldest removed (seeds 0..5).
    for (let i = 0; i <= 5; i++) expect(remaining).not.toContain(names[i]!);
    // The 3 newest seeds + today survive.
    for (let i = 6; i <= 8; i++) expect(remaining).toContain(names[i]!);
    expect(remaining).toContain(`${component}-${todayDateString()}.jsonl`);
  });

  it('acceptance (5): an explicit snapshotMaxFiles overrides the 30 default', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const service = 'over';
    const logDir = path.join(home, service, 'logs');
    const snapComponent = `${service}.live-service.metrics-snapshot`;

    const names = seed(logDir, snapComponent, range(6)); // 6 seeds

    initTelemetry({
      service,
      role: 'live-service',
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      snapshotMaxFiles: 3,
    });

    await snapshotMetrics('pull'); // + today's file = 7 → cap 3
    await sleep(20);

    const snapFiles = readdir(logDir).filter((f) => f.startsWith(`${snapComponent}-`));
    expect(snapFiles.length).toBe(3);
    // 7 files − cap 3 = 4 oldest removed (seeds 0..3).
    for (let i = 0; i <= 3; i++) expect(snapFiles).not.toContain(names[i]!);
    expect(snapFiles).toContain(names[4]!);
    expect(snapFiles).toContain(names[5]!);
    expect(snapFiles).toContain(`${snapComponent}-${todayDateString()}.jsonl`);
  });

  it('acceptance (5b): an explicit maxFiles still governs BOTH sinks when snapshotMaxFiles is unset', async () => {
    const home = process.env['SOX_ECOSYSTEM_HOME']!;
    const service = 'both';
    const logDir = path.join(home, service, 'logs');
    const eventComponent = `${service}.live-service`;
    const snapComponent = `${service}.live-service.metrics-snapshot`;

    seed(logDir, snapComponent, range(12));
    seed(logDir, eventComponent, range(12));

    initTelemetry({
      service,
      role: 'live-service',
      logSink: 'file',
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      maxFiles: 5,
    });

    await snapshotMetrics('pull');
    log.info('both.event', {});
    await sleep(20);

    const snapFiles = readdir(logDir).filter((f) => f.startsWith(`${snapComponent}-`));
    const eventFiles = readdir(logDir).filter((f) => f.startsWith(`${eventComponent}-`));
    // The pre-S2 contract: an explicit `maxFiles` governs both components.
    expect(snapFiles.length).toBe(5);
    expect(eventFiles.length).toBe(5);
  });
});
