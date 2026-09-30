/**
 * e2540535-release-envelope.spec.ts — C1 (plan 7326b4af), backlog `e2540535…`,
 * BL-225.
 *
 * The defect this closes: the durable log/span/event ENVELOPE (`emitRecord`,
 * the single path every `log.*` and every `JsonlSpanProcessor` record passes
 * through) carried `service`/`role`/`pid`/`trace_id` but nothing that named the
 * RELEASE that produced the record. A production error or span could therefore
 * not be attributed to a build. S3 (`5ac0a1a8…`) gave the durable
 * `metrics.snapshot`/`metrics.rollup` rows a `release` identity; this extends
 * the SAME identity to the event envelope so "which release produced this
 * error/span/snapshot" is answerable from ONE field on every record.
 *
 * The null contract is the whole point (BL-433 spirit): an absent value is
 * `null` — NEVER `''`, never `undefined`. `''` is the BL-319/BL-347
 * absent-field ambiguity (a legal-looking string indistinguishable from a real
 * value). The identity is normalised once at `initTelemetry` and copied
 * verbatim onto every record.
 *
 * Red→green (BL-225): with the `release: { ...st.release }` line removed from
 * `emitRecord`, every `record['release']` below is `undefined` and both cases
 * fail; restore it and they pass. The RED/GREEN transcripts are recorded in the
 * change report, not in-file.
 *
 * Hermeticity mirrors `metrics-snapshot-release-identity.spec.ts`: `beforeAll`
 * pins `SOX_ECOSYSTEM_HOME` at a fresh `mkdtempSync('e2540535-')` for the whole
 * file (restored in `afterAll`), and `afterAll` fails the file if the real
 * production service dir was ever created for this run's unique service name.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initTelemetry,
  log,
  withSpan,
  otelReady,
  _resetTelemetryForTest,
} from './index.js';

/** A service name no real composition root uses — its absence under the real
 *  root is an unambiguous "a test leaked to production" signal. */
const SERVICE = 'e2540535-release-envelope';
const ROLE = 'test';

/** The exact value the envelope must round-trip, byte for byte. */
const RELEASE = {
  version: '4.5.6',
  artifact_sha256: `sha256:${'c'.repeat(64)}`,
  git_sha: 'd'.repeat(40),
} as const;

const REAL_SERVICE_DIR = path.join(os.homedir(), '.adhd', 'sox-ecosystem', SERVICE);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function logDirFor(home: string): string {
  return path.join(home, SERVICE, 'logs');
}

/** Every persisted EVENT-stream record (every `*.jsonl` line), EXCLUDING the
 *  snapshot and rollup component files — this spec is about the event
 *  envelope, not the metrics components. */
function readEventRecords(logDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => !f.includes('.metrics-snapshot-') && !f.includes('.metrics-rollup-'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(logDir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
}

let scratchHome: string;
let savedEcosystemHome: string | undefined;
let savedTestEcosystemHome: string | undefined;

beforeAll(() => {
  savedEcosystemHome = process.env['SOX_ECOSYSTEM_HOME'];
  savedTestEcosystemHome = process.env['SOX_TEST_ECOSYSTEM_HOME'];
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'e2540535-'));
  process.env['SOX_ECOSYSTEM_HOME'] = scratchHome;
  process.env['SOX_TEST_ECOSYSTEM_HOME'] = scratchHome;
});

afterEach(() => {
  _resetTelemetryForTest();
  fs.rmSync(path.join(scratchHome, SERVICE), { recursive: true, force: true });
});

afterAll(() => {
  _resetTelemetryForTest();
  if (savedEcosystemHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = savedEcosystemHome;
  if (savedTestEcosystemHome === undefined) delete process.env['SOX_TEST_ECOSYSTEM_HOME'];
  else process.env['SOX_TEST_ECOSYSTEM_HOME'] = savedTestEcosystemHome;
  fs.rmSync(scratchHome, { recursive: true, force: true });
  // The real production root must never have gained this run's unique service.
  expect(fs.existsSync(REAL_SERVICE_DIR), `test wrote the real ${REAL_SERVICE_DIR}`).toBe(false);
});

describe('e2540535 — release identity on the durable log/span/event envelope', () => {
  it('e2540535: a plain log record AND a span record each carry all three release fields (deep-equal to the value passed)', async () => {
    const logDir = logDirFor(scratchHome);

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: true,
      snapshotEveryMs: 0,
      snapshotEveryRecords: 0,
      release: RELEASE,
    });

    // A plain emitted record, straight through `emitRecord`.
    log.info('e2540535.log', {});
    // A span record, straight through the SAME `emitRecord` (via the OTel
    // `JsonlSpanProcessor`), proving the envelope is shared.
    await otelReady();
    await withSpan('e2540535.span', { k: 1 }, async () => undefined);
    await sleep(20); // let the durable sink settle (writes are writeSync)

    const records = readEventRecords(logDir);
    const logRec = records.find((r) => r['event'] === 'e2540535.log');
    const spanStart = records.find((r) => r['event'] === 'e2540535.span.start');
    const spanFinish = records.find((r) => r['event'] === 'e2540535.span.finish');

    expect(logRec, 'the log record was not written').toBeDefined();
    expect(spanStart, 'the span .start record was not written').toBeDefined();
    expect(spanFinish, 'the span .finish record was not written').toBeDefined();

    for (const rec of [logRec, spanStart, spanFinish]) {
      // The whole identity round-trips verbatim.
      expect(rec!['release']).toEqual(RELEASE);
      const rel = rec!['release'] as Record<string, unknown>;
      // The envelope fields are unchanged — release is ADDITIVE.
      expect(rec!['service']).toBe(SERVICE);
      expect(rec!['role']).toBe(ROLE);
      expect(typeof rec!['pid']).toBe('number');
      // BL-433: none of the three may be the empty string.
      expect(rel['version']).not.toBe('');
      expect(rel['artifact_sha256']).not.toBe('');
      expect(rel['git_sha']).not.toBe('');
    }
  });

  it('e2540535: with release omitted the three fields are null — explicitly NOT "" and not undefined', async () => {
    const logDir = logDirFor(scratchHome);

    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      otel: false,
      snapshotEveryMs: 0,
      snapshotEveryRecords: 0,
    });

    log.info('e2540535.norelease', {});
    await sleep(20);

    const rec = readEventRecords(logDir).find((r) => r['event'] === 'e2540535.norelease');
    expect(rec, 'the log record was not written').toBeDefined();

    const rel = rec!['release'] as Record<string, unknown> | undefined;
    // Present as a well-formed object (not `undefined`)...
    expect(rel, 'release must still be present as an object').toBeDefined();
    expect(rel!['version']).toBeNull();
    expect(rel!['artifact_sha256']).toBeNull();
    expect(rel!['git_sha']).toBeNull();
    // ...and never the empty string (the BL-433 anti-regression).
    expect(rel!['version']).not.toBe('');
    expect(rel!['artifact_sha256']).not.toBe('');
    expect(rel!['git_sha']).not.toBe('');
  });
});
