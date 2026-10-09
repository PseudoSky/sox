/**
 * channel.spec.ts — c536ce29 L2: createLogChannel (TRC-AC12/13/14 unit level,
 * L2-AC-A flood breaker, L2-AC-B redaction canary, L2-AC-C never-throws).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogChannel, type LogChannel } from './channel.js';
import { captureBody } from './body.js';
import { withLogContext } from './context.js';
import { createRedactor, identityRedactor } from './redact.js';
import { _resetTelemetryForTest, initTelemetry, log } from './index.js';

let dir: string;
let open: LogChannel[] = [];

const track = (c: LogChannel): LogChannel => {
  open.push(c);
  return c;
};
const files = (): string[] => fs.readdirSync(dir).sort();
const lines = (file: string): string[] => {
  const raw = file.endsWith('.gz') ? gunzipSync(fs.readFileSync(path.join(dir, file))).toString('utf8') : fs.readFileSync(path.join(dir, file), 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
};
const allText = (): string => files().map((f) => lines(f).join('\n')).join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-channel-spec-'));
});
afterEach(async () => {
  for (const c of open) await c.close();
  open = [];
  _resetTelemetryForTest();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('c536ce29 TRC-AC12 per-process files', () => {
  it('c536ce29 TRC-AC12 two channels with different labels in one dir write separate per-process files, every line parses, counts exact', async () => {
    const a = track(createLogChannel({ dir, component: 'spec.api', fileLabel: 'alpha' }));
    const b = track(createLogChannel({ dir, component: 'spec.api', fileLabel: 'beta' }));
    for (let i = 0; i < 200; i++) {
      a.logEvent('a.evt', { i });
      b.logEvent('b.evt', { i });
    }
    await a.flush();
    await b.flush();
    const fa = files().filter((f) => f.includes('.alpha.'));
    const fb = files().filter((f) => f.includes('.beta.'));
    expect(fa).toHaveLength(1);
    expect(fb).toHaveLength(1);
    expect(fa[0]).toMatch(new RegExp(`^spec\\.api-\\d{4}-\\d{2}-\\d{2}\\.alpha\\.${process.pid}\\.jsonl$`));
    const ra = lines(fa[0]!).map((l) => JSON.parse(l) as Record<string, unknown>);
    const rb = lines(fb[0]!).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ra).toHaveLength(200);
    expect(rb).toHaveLength(200);
    expect(ra.every((r) => r['event'] === 'a.evt')).toBe(true);
    expect(rb.every((r) => r['event'] === 'b.evt')).toBe(true);
    expect(a.stats().written).toBe(200);
  });

  it('c536ce29 TRC-AC12 record envelope: schema, stream, pid, release, merged log context; fields cannot overwrite the envelope', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.env', fileLabel: 'e' }));
    withLogContext({ task_id: 't1', turn: 3, service: 'evil' }, () => {
      c.logEvent('env.evt', { call_id: 'c1', pid: 1, schema: 9, stream: 'x' }, 'warn');
    });
    await c.flush();
    const rec = JSON.parse(lines(files()[0]!)[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ level: 'warn', event: 'env.evt', schema: 1, stream: 'spec.env', pid: process.pid, task_id: 't1', turn: 3, call_id: 'c1' });
    expect(rec['service']).not.toBe('evil');
    expect(rec['release']).toEqual({ version: null, artifact_sha256: null, git_sha: null });
    expect(typeof rec['ts']).toBe('string');
    expect(rec).toHaveProperty('trace_id');
  });
});

describe('c536ce29 TRC-AC13 rotation, gzip, retention', () => {
  it('c536ce29 TRC-AC13 rotates at maxBytes and gzip yields a readable .gz of the rotated file; no record lost', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.rot', fileLabel: 'r', maxBytes: 1500, gzipRotated: true }));
    const N = 60;
    for (let i = 0; i < N; i++) c.logEvent('rot.evt', { i, pad: 'x'.repeat(100) });
    await c.flush();
    const names = files();
    const gz = names.filter((f) => f.endsWith('.jsonl.gz'));
    expect(c.stats().rotated).toBeGreaterThan(0);
    expect(gz.length).toBe(c.stats().rotated);
    expect(names.some((f) => f.endsWith('.gz.tmp'))).toBe(false);
    // every rotated file is gzip-only (the plain original was replaced)
    expect(names.filter((f) => /\.\d+-\d+\.jsonl$/.test(f))).toHaveLength(0);
    expect(gz[0]).toMatch(new RegExp(`\\.r\\.${process.pid}\\.\\d+-\\d+\\.jsonl\\.gz$`));
    const idx: number[] = [];
    for (const f of names) for (const l of lines(f)) idx.push((JSON.parse(l) as { i: number }).i);
    expect(idx.sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('c536ce29 TRC-AC13 age sweep deletes old matching files, never unrelated names or the live file', async () => {
    const old = path.join(dir, 'spec.age-2020-01-01.dead.2000000000.jsonl');
    const unrelated = [path.join(dir, 'spec.age.other-2020-01-01.jsonl'), path.join(dir, 'spec.age-notes.txt'), path.join(dir, 'unrelated-2020-01-01.jsonl')];
    fs.writeFileSync(old, '{"e":1}\n');
    for (const u of unrelated) fs.writeFileSync(u, 'x\n');
    const past = new Date(Date.now() - 40 * 86_400_000);
    for (const f of [old, ...unrelated]) fs.utimesSync(f, past, past);
    const c = track(createLogChannel({ dir, component: 'spec.age', fileLabel: 'a', maxAgeDays: 7 }));
    c.logEvent('age.evt');
    await c.flush();
    expect(fs.existsSync(old)).toBe(false);
    for (const u of unrelated) expect(fs.existsSync(u)).toBe(true);
    expect(files().filter((f) => f.startsWith('spec.age-') && f.includes('.a.'))).toHaveLength(1);
  });

  it('c536ce29 TRC-AC13 dir-byte sweep deletes oldest-first, spares newer files and the live file', async () => {
    const mk = (n: number, ageDays: number): string => {
      const f = path.join(dir, `spec.bytes-2020-01-0${n}.p.2000000000.jsonl`);
      fs.writeFileSync(f, 'y'.repeat(1000));
      const t = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(f, t, t);
      return f;
    };
    const f1 = mk(1, 3);
    const f2 = mk(2, 2);
    const f3 = mk(3, 1);
    const c = track(createLogChannel({ dir, component: 'spec.bytes', fileLabel: 'b', maxAgeDays: 3650, maxDirBytes: 1500 }));
    c.logEvent('bytes.evt');
    await c.flush();
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(false);
    expect(fs.existsSync(f3)).toBe(true);
    expect(files().some((f) => f.includes('.b.'))).toBe(true);
  });

  it('c536ce29 TRC-AC13 the newest file of a LIVE pid survives an age sweep; its older files do not', async () => {
    const live = process.ppid;
    const older = path.join(dir, `spec.live-2020-01-01.p.${live}.jsonl`);
    const newest = path.join(dir, `spec.live-2020-01-02.p.${live}.jsonl`);
    fs.writeFileSync(older, 'a\n');
    fs.writeFileSync(newest, 'b\n');
    const t1 = new Date(Date.now() - 50 * 86_400_000);
    const t2 = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(older, t1, t1);
    fs.utimesSync(newest, t2, t2);
    const c = track(createLogChannel({ dir, component: 'spec.live', fileLabel: 'l', maxAgeDays: 7 }));
    c.logEvent('live.evt');
    await c.flush();
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newest)).toBe(true);
  });

  it('c536ce29 TRC-AC13 sweeping is idempotent when two channels sweep the same dir', async () => {
    const old = path.join(dir, 'spec.idem-2020-01-01.p.2000000000.jsonl');
    fs.writeFileSync(old, 'z\n');
    const past = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(old, past, past);
    const a = track(createLogChannel({ dir, component: 'spec.idem', fileLabel: 'x', maxAgeDays: 7 }));
    const b = track(createLogChannel({ dir, component: 'spec.idem', fileLabel: 'y', maxAgeDays: 7 }));
    expect(() => {
      a.logEvent('i');
      b.logEvent('i');
    }).not.toThrow();
    await Promise.all([a.flush(), b.flush()]);
    expect(fs.existsSync(old)).toBe(false);
  });
});

describe('c536ce29 TRC-AC14 durability', () => {
  it('c536ce29 TRC-AC14 sync mode: the record is on disk immediately, before any flush (0 lost on abrupt close)', () => {
    const c = track(createLogChannel({ dir, component: 'spec.sync', fileLabel: 's', durability: { mode: 'sync' } }));
    for (let i = 0; i < 25; i++) c.logEvent('sync.evt', { i, pad: 'p'.repeat(200_000 * (i === 5 ? 1 : 0)) });
    // no flush(), no await, no close(): read straight from disk
    const ls = lines(files()[0]!);
    expect(ls).toHaveLength(25);
    expect(ls.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('c536ce29 TRC-AC14 hybrid: small records are sync, a record > syncMaxBytes is queued and on disk after flush(); order preserved', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.hyb', fileLabel: 'h', durability: { mode: 'hybrid', syncMaxBytes: 600 } }));
    c.logEvent('small', { n: 1 });
    c.logEvent('large', { n: 2, pad: 'L'.repeat(2000) });
    const file = (): string => files()[0]!;
    expect(lines(file()).map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['small']); // large is queued
    c.logEvent('small', { n: 3 }); // drains the queue first, then writes itself
    expect(lines(file()).map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([1, 2, 3]);
    c.logEvent('large', { n: 4, pad: 'L'.repeat(2000) });
    c.logEvent('large', { n: 5, pad: 'L'.repeat(2000) });
    expect(lines(file())).toHaveLength(3);
    await c.flush();
    expect(lines(file()).map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([1, 2, 3, 4, 5]);
    expect(c.stats()).toMatchObject({ written: 5, dropped: 0 });
  });

  it('c536ce29 TRC-AC14 queue overflow drops the oldest queued records and counts them', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.q', fileLabel: 'q', durability: { mode: 'hybrid', syncMaxBytes: 100 }, queueMaxBytes: 5000 }));
    for (let i = 0; i < 6; i++) c.logEvent('big', { i, pad: 'Q'.repeat(2000) });
    await c.flush();
    const got = lines(files()[0]!).map((l) => (JSON.parse(l) as { i: number }).i);
    expect(got).toEqual([4, 5]);
    expect(c.stats().dropped).toBe(4);
    expect(c.stats().written).toBe(2);
  });

  it('c536ce29 TRC-AC14 the timer drains the queue without flush()', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.timer', fileLabel: 't', durability: { mode: 'hybrid', syncMaxBytes: 100 } }));
    c.logEvent('big', { pad: 'T'.repeat(500) });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (files().length === 0 || lines(files()[0]!).length === 0)) await new Promise((r) => setTimeout(r, 10));
    expect(lines(files()[0]!)).toHaveLength(1);
  });
});

describe('c536ce29 L2-AC-A flood breaker', () => {
  it('c536ce29 L2-AC-A trips once; later logRaw records are digest-only with sha256/bytes preserved', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.flood', fileLabel: 'f', floodBreaker: { windowMs: 600_000, maxBytes: 3000 }, durability: { mode: 'sync' } }));
    const bodies = Array.from({ length: 6 }, (_, i) => captureBody(`body-${i}-` + 'B'.repeat(1000), { maxBytes: 1 << 20 }));
    bodies.forEach((b, i) => c.logRaw('wire.request', { headers: { 'content-type': 'application/json' }, body: b, call_id: `c${i}` }));
    await c.flush();
    const recs = lines(files()[0]!).map((l) => JSON.parse(l) as Record<string, unknown>);
    const tripped = recs.filter((r) => r['event'] === 'log.budget_tripped');
    expect(tripped).toHaveLength(1);
    const raw = recs.filter((r) => r['event'] === 'wire.request');
    expect(raw).toHaveLength(6);
    expect(raw[0]!['body']).toBe(bodies[0]!.body); // under budget: verbatim
    const digestOnly = raw.filter((r) => r['body'] === null);
    expect(digestOnly.length).toBeGreaterThanOrEqual(3);
    for (const r of digestOnly) {
      const i = Number((r['call_id'] as string).slice(1));
      expect(r['body_sha256']).toBe(bodies[i]!.body_sha256);
      expect(r['body_bytes']).toBe(bodies[i]!.body_bytes);
      expect(r['digest_only']).toBe(true);
    }
    expect(c.stats().floodTripped).toBe(true);
    // logEvent is never subject to the breaker
    c.logEvent('still.logged');
    expect(lines(files()[0]!).some((l) => l.includes('still.logged'))).toBe(true);
  });
});

describe('c536ce29 L2-AC-B redaction', () => {
  const HEADER = 'sk-ant-api03-HEADERCANARY0000000001';
  const BODY = 'sk-ant-api03-BODYCANARY00000000002';
  const EXTRA = 'EXTRACANARYTOKEN0003';
  const REG = 'registered-secret-value-0004';
  const emit = (c: LogChannel): void => {
    c.registerSecret(REG);
    c.logRaw('wire.request', {
      headers: { authorization: `Bearer ${HEADER}`, 'content-type': 'application/json' },
      body: captureBody(JSON.stringify({ messages: [{ role: 'user', content: `my key is ${BODY}` }] }), { maxBytes: 1 << 20 }),
      token: EXTRA,
      note: `free text ${REG} end`,
    });
    c.destination().write(JSON.stringify({ level: 30, msg: `pino ${BODY}` }) + '\n');
  };

  it('c536ce29 L2-AC-B a canary in a header, a body, an extra field, a registered secret and the pino destination never reaches the file', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.red', fileLabel: 'r' }));
    emit(c);
    await c.flush();
    const text = allText();
    expect(text.length).toBeGreaterThan(0);
    for (const canary of [HEADER, BODY, EXTRA, REG]) expect(text).not.toContain(canary);
    expect(text).toContain('[REDACTED:');
  });

  it('c536ce29 L2-AC-B negative control: identityRedactor WOULD have written every canary', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.redctl', fileLabel: 'r', redactor: identityRedactor }));
    c.logRaw('wire.request', {
      headers: { authorization: `Bearer ${HEADER}` },
      body: captureBody(`my key is ${BODY}`, { maxBytes: 1 << 20 }),
      token: EXTRA,
    });
    await c.flush();
    const text = allText();
    for (const canary of [HEADER, BODY, EXTRA]) expect(text).toContain(canary);
  });

  it('c536ce29 L2-AC-B InitTelemetryOptions.redactor redacts the existing log.* stream; absent redactor leaves it unchanged', () => {
    const d1 = path.join(dir, 'with');
    const h1 = initTelemetry({ service: 'spec-red', role: 'test', logDir: d1, redactor: createRedactor() });
    log.info('evt', { token: EXTRA, other: BODY });
    const t1 = fs.readFileSync(h1.currentLogFilePath()!, 'utf8');
    expect(t1).not.toContain(EXTRA);
    expect(t1).not.toContain(BODY);
    _resetTelemetryForTest();
    const d2 = path.join(dir, 'without');
    const h2 = initTelemetry({ service: 'spec-red', role: 'test', logDir: d2 });
    log.info('evt', { token: EXTRA });
    expect(fs.readFileSync(h2.currentLogFilePath()!, 'utf8')).toContain(EXTRA);
  });
});

describe('c536ce29 L2-AC-C never throws', () => {
  it('c536ce29 L2-AC-C circular and BigInt payloads become log.serialize_error records, not exceptions', async () => {
    const raw = track(createLogChannel({ dir, component: 'spec.err', fileLabel: 'e', redactor: identityRedactor, durability: { mode: 'sync' } }));
    const circ: Record<string, unknown> = {};
    circ['self'] = circ;
    expect(() => raw.logEvent('circ', { circ })).not.toThrow();
    const def = track(createLogChannel({ dir, component: 'spec.err2', fileLabel: 'e', durability: { mode: 'sync' } }));
    expect(() => def.logEvent('big', { n: 10n })).not.toThrow();
    expect(() => def.logRaw('bigraw', { n: 10n })).not.toThrow();
    expect(raw.stats().serializeErrors).toBe(1);
    expect(def.stats().serializeErrors).toBe(2);
    await raw.flush();
    await def.flush();
    expect(allText().split('\n').filter((l) => l.includes('log.serialize_error'))).toHaveLength(3);
    // the original event name is preserved, its payload is not
    expect(allText()).toContain('"original_event":"circ"');
  });

  it('c536ce29 L2-AC-C an unwritable directory yields dropped counters and ONE rate-limited stderr line, never an exception', async () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const c = track(createLogChannel({ dir: path.join(blocker, 'sub'), component: 'spec.bad', durability: { mode: 'sync' } }));
    expect(() => {
      for (let i = 0; i < 20; i++) c.logEvent('lost', { i });
    }).not.toThrow();
    await expect(c.flush()).resolves.toBeUndefined();
    expect(c.stats()).toMatchObject({ written: 0, dropped: 20 });
    const ours = spy.mock.calls.filter((a) => String(a[0]).includes("log channel 'spec.bad'"));
    expect(ours).toHaveLength(1);
  });

  it('c536ce29 L2-AC-C hostile inputs and use-after-close are inert', async () => {
    const c = track(createLogChannel({ dir, component: 'spec.hostile', fileLabel: 'h' }));
    expect(() => {
      c.registerSecret(undefined as unknown as string);
      c.destination().write(undefined as unknown as string);
      c.logRaw('x', { body: null as unknown as never });
      c.logEvent(undefined as unknown as string, null as unknown as undefined);
    }).not.toThrow();
    await c.close();
    await expect(c.close()).resolves.toBeUndefined();
    expect(() => c.logEvent('after.close')).not.toThrow();
    expect(c.stats().dropped).toBeGreaterThanOrEqual(1);
    expect(allText()).not.toContain('after.close');
  });
});
