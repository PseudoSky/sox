/**
 * metrics-rollup-retention.spec.ts — the rollup reader's memory contract.
 *
 * WHAT IT PROVES
 * ──────────────
 * `rollupMetrics` runs on every interval tick (default 60 s) in the server
 * process. The reader used to re-read every `metrics.snapshot` JSONL under the
 * snapshot dir on each tick and retain every parsed record in
 * `rt.rollupFileCache` for the life of the process; over a copied history one
 * tick grew heap by +199,905 records. The aggregator only consumes the trailing
 * window (`rollupWindowMs`, default 1 h), so the reader must:
 *
 *   (r1) retain only records inside the trailing window, never the history;
 *   (r2) read only the bytes appended since the previous tick (byte offset);
 *   (r3) hold a partial trailing line until its newline arrives, count it once;
 *   (r4) produce rows whose `snapshots_in_window` equals the in-window records.
 *   (r5) fold a file larger than one bounded read chunk exactly — a record
 *        straddling a chunk boundary is counted once, none dropped (correctness
 *        guard for the streamed first read; memory boundedness is measured by the
 *        host-like probe, not asserted here).
 *   (r6) seek a recently written file to its window on the first read, so an
 *        aged prefix is never read (bytes read stay near the in-window tail).
 *
 * FIXTURE CHOICE
 * ──────────────
 * The fixture is a snapshot file dated YESTERDAY. The live writer only ever
 * appends to today's file, so the test never interleaves its own appends with a
 * deferred writer append (which produced a torn line the real writer cannot
 * create). The reader enumerates every file matching the component anchor, so a
 * yesterday-dated file is read exactly like today's. Records are cloned from a
 * real record the writer produced, so release/process identity is genuine.
 *
 * Observation is through `_rollupRetentionForTest()` (runtime.ts): retained
 * record count and cumulative bytes read from disk. No timers, no sleeps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, snapshotMetrics, rollupMetrics, _resetTelemetryForTest } from './index.js';
import { _rollupRetentionForTest } from './runtime.js';

const SERVICE = 'rr-retention';
const ROLE = 'live-service';
const REL_A = { version: '1.0.0', artifact_sha256: `sha256:${'a'.repeat(64)}`, git_sha: 'a'.repeat(40) } as const;
const HOUR_MS = 3_600_000;

const dirs: string[] = [];

afterEach(() => {
  _resetTelemetryForTest();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Let deferred writer work (the startup snapshot) land before we touch files. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function yesterdayUtc(): string {
  const d = new Date(Date.now() - 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Start telemetry against a fresh log dir, take one real snapshot, and return
 *  the writer's record as a template plus a yesterday-dated fixture file. */
async function fixture(): Promise<{ dir: string; file: string; today: string; template: Record<string, unknown> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-rollup-retention-'));
  dirs.push(dir);
  initTelemetry({
    service: SERVICE,
    role: ROLE,
    logSink: 'file',
    logDir: dir,
    otel: false,
    snapshotEveryRecords: 0,
    snapshotEveryMs: 0,
    release: REL_A,
  });
  await snapshotMetrics('pull');
  await quiesce();
  const today = fs.readdirSync(dir).find((f) => f.includes('.metrics-snapshot-'));
  if (today === undefined) throw new Error('writer produced no snapshot file');
  const first = fs.readFileSync(path.join(dir, today), 'utf8').split('\n').find(Boolean)!;
  const template = JSON.parse(first) as Record<string, unknown>;
  const prefix = today.replace(/-\d{4}-\d{2}-\d{2}\.jsonl$/, '');
  const file = path.join(dir, `${prefix}-${yesterdayUtc()}.jsonl`);
  fs.writeFileSync(file, '');
  return { dir, file, today: path.join(dir, today), template };
}

function line(template: Record<string, unknown>, msAgo: number): string {
  return JSON.stringify({ ...template, ts: iso(msAgo) }) + '\n';
}

/** Complete, newline-terminated records in `file` inside the trailing window —
 *  the set the reader must retain. A partial trailing fragment is never counted,
 *  matching the reader's contract. Computed from the file, never assumed. */
function inWindowRecords(file: string): number {
  const now = Date.now();
  const text = fs.readFileSync(file, 'utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  let n = 0;
  for (const raw of complete.split('\n')) {
    if (raw.length === 0) continue;
    let rec: { ts?: unknown };
    try {
      rec = JSON.parse(raw) as { ts?: unknown };
    } catch {
      continue;
    }
    const t = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
    if (Number.isFinite(t) && t >= now - HOUR_MS && t <= now) n += 1;
  }
  return n;
}

describe('rollup reader retention (memory contract)', () => {
  it('r1: retains only trailing-window records, not the whole history', async () => {
    const { file, today, template } = await fixture();
    fs.appendFileSync(
      file,
      Array.from({ length: 500 }, () => line(template, 5 * HOUR_MS)).join('') +
        Array.from({ length: 20 }, () => line(template, 10 * 60_000)).join(''),
    );

    await rollupMetrics('interval');

    // Exactly the in-window records across both files are retained; the 500
    // five-hour-old records are not, in any form.
    expect(inWindowRecords(file)).toBe(20);
    expect(_rollupRetentionForTest().retainedRecords).toBe(inWindowRecords(file) + inWindowRecords(today));
  });

  it('r2: the next tick reads only the bytes appended since the previous tick', async () => {
    const { file, template } = await fixture();
    fs.appendFileSync(file, line(template, 60_000).repeat(200));

    await rollupMetrics('interval');
    const afterFirst = _rollupRetentionForTest().bytesRead;
    expect(afterFirst).toBeGreaterThanOrEqual(fs.statSync(file).size);

    const appended = line(template, 1_000).repeat(3);
    fs.appendFileSync(file, appended);
    await rollupMetrics('interval');

    expect(_rollupRetentionForTest().bytesRead - afterFirst).toBe(Buffer.byteLength(appended));
  });

  it('r3: a partial trailing line is held until its newline arrives, then counted exactly once', async () => {
    const { file, today, template } = await fixture();
    const full = line(template, 30_000);
    const cut = Math.floor(full.length / 2);
    const total = (): number => inWindowRecords(file) + inWindowRecords(today);

    fs.appendFileSync(file, full.slice(0, cut));
    await rollupMetrics('interval');
    expect(inWindowRecords(file)).toBe(0);
    expect(_rollupRetentionForTest().retainedRecords).toBe(total());
    const beforeRest = total();

    fs.appendFileSync(file, full.slice(cut));
    await rollupMetrics('interval');
    expect(inWindowRecords(file)).toBe(1);
    expect(total() - beforeRest).toBe(1);
    expect(_rollupRetentionForTest().retainedRecords).toBe(total());
  });

  it('r4: the row counts exactly the in-window records the aggregator defines', async () => {
    const { dir, file, today, template } = await fixture();
    fs.appendFileSync(file, line(template, 3 * HOUR_MS).repeat(7) + line(template, 120_000).repeat(4));

    await rollupMetrics('interval');

    const rollupDir = path.join(dir, 'rollup');
    const rows = fs
      .readdirSync(rollupDir)
      .filter((f) => f.includes('.metrics-rollup-'))
      .flatMap((f) =>
        fs.readFileSync(path.join(rollupDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    expect(rows).toHaveLength(1);
    // The aggregator's window spans every snapshot file, so the row counts both.
    expect(rows[0]!['snapshots_in_window']).toBe(inWindowRecords(file) + inWindowRecords(today));
  });

  it('r5: a file larger than one read chunk is folded exactly, including a record straddling the boundary', async () => {
    const { file, today, template } = await fixture();
    // ~3 MiB of in-window records: spans several 1 MiB read chunks, and the
    // record lengths are not aligned to the chunk size, so boundaries land
    // mid-record.
    const body = line(template, 20 * 60_000).repeat(3_000);
    fs.appendFileSync(file, body);
    expect(fs.statSync(file).size).toBeGreaterThan(3 * 1024 * 1024);

    await rollupMetrics('interval');

    expect(inWindowRecords(file)).toBe(3_000);
    expect(_rollupRetentionForTest().retainedRecords).toBe(inWindowRecords(file) + inWindowRecords(today));
  });

  it('r6: a recently written file is seeked to its window, so the aged prefix is never read', async () => {
    const { file, today, template } = await fixture();
    // A long history prefix (every record five hours old) followed by a small
    // in-window tail. The file's mtime is NOW, so the mtime skip does not apply:
    // only the bisection can keep the reader out of the prefix.
    const prefix = line(template, 5 * HOUR_MS).repeat(4_000);
    fs.appendFileSync(file, prefix + line(template, 60_000).repeat(25));
    const size = fs.statSync(file).size;

    await rollupMetrics('interval');

    expect(inWindowRecords(file)).toBe(25);
    expect(_rollupRetentionForTest().retainedRecords).toBe(inWindowRecords(file) + inWindowRecords(today));
    // The bytes read are the in-window tail (plus at most one resolution step of
    // bisection slack), never the whole file.
    expect(_rollupRetentionForTest().bytesRead).toBeLessThan(size / 4);
  });

  it('r7: re-pointing the reader at another dir drops the cache, so a same-named file is never a false hit', async () => {
    const first = await fixture();
    fs.appendFileSync(first.file, line(first.template, 60_000).repeat(5));
    await rollupMetrics('interval');

    // A second log dir with a snapshot file of the SAME basename but another
    // release identity. The first dir's cached offset and records must not leak.
    const REL_B = { version: '2.0.0', artifact_sha256: `sha256:${'b'.repeat(64)}`, git_sha: 'b'.repeat(40) } as const;
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-rollup-retention-b-'));
    dirs.push(dir2);
    initTelemetry({
      service: SERVICE,
      role: ROLE,
      logSink: 'file',
      logDir: dir2,
      otel: false,
      snapshotEveryRecords: 0,
      snapshotEveryMs: 0,
      release: REL_B,
    });
    await quiesce();
    const template2 = { ...first.template, release: REL_B };
    const file2 = path.join(dir2, path.basename(first.file));
    fs.writeFileSync(file2, line(template2, 60_000).repeat(8));

    await rollupMetrics('interval');

    const rollupDir = path.join(dir2, 'rollup');
    const rows = fs
      .readdirSync(rollupDir)
      .filter((f) => f.includes('.metrics-rollup-'))
      .flatMap((f) =>
        fs.readFileSync(path.join(rollupDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      )
      .filter((r) => r['reason'] === 'interval');
    const latestTick = rows.slice(-1);
    expect(latestTick).toHaveLength(1);
    expect(latestTick[0]!['release']).toEqual(REL_B);
    // Every in-window record in the second dir, and only those: the 5 first-dir
    // records (release A) would make this row larger and blend two releases.
    const expected = fs
      .readdirSync(dir2)
      .filter((f) => f.includes('.metrics-snapshot-'))
      .reduce((n, f) => n + inWindowRecords(path.join(dir2, f)), 0);
    expect(expected).toBeGreaterThanOrEqual(8);
    expect(latestTick[0]!['snapshots_in_window']).toBe(expected);
  });
});
