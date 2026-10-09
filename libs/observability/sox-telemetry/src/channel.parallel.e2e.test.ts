/**
 * channel.parallel.e2e.test.ts — c536ce29 L3: the log channel under REAL
 * processes, against the BUILT `dist/` (the artifact a consumer installs).
 *
 * Lane: `*.e2e.test.ts` is excluded from the unit `test` target
 * (vitest.config.ts) and collected only by `vitest.e2e.config.ts`, run via
 * `npx nx run sox-telemetry:e2e` (dependsOn `build`). Nothing here is gated on
 * an environment variable: a missing `dist/` or an uninstallable 0.4.1 copy
 * fails the suite loudly.
 *
 *  - TRC-AC12   4 child processes x 5,000 records into ONE dir
 *  - TRC-AC14b  SIGKILL mid-write in `sync` durability loses no acknowledged record
 *  - TRC-AC20   the published 0.4.1 copy and the new build share one runtime/context
 *  - TRC-AC22   gzip rotation of ~10 MB repetitive JSON: ratio < 0.2, lossless
 */
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(HERE, '..', 'dist', 'index.js');

let root: string;
const mk = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));

beforeAll(() => {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(`dist missing at ${DIST_ENTRY}: run \`npx nx run sox-telemetry:build\` (the e2e target dependsOn it)`);
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-channel-e2e-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every record in `dir`, in file order; `.gz` files are decompressed. */
function readAll(dir: string): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.jsonl(\.gz)?$/.test(f)) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    const text = f.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    for (const line of text.split('\n')) if (line.length > 0) out.push({ file: f, line });
  }
  return out;
}

function writeScript(name: string, body: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
  return p;
}

function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('c536ce29 TRC-AC12 real processes', () => {
  it('c536ce29 TRC-AC12 4 real processes x 5000 records into one dir: every line parses, per-pid counts exact, no .tmp residue, sweeper survives', async () => {
    const dir = mk('ac12');
    const worker = writeScript(
      'ac12-worker.cjs',
      `
const { createLogChannel } = require(process.argv[2]);
const dir = process.argv[3];
const ch = createLogChannel({
  dir, component: 'e2e.api', fileLabel: 'w',
  maxBytes: 256 * 1024,            // ~6 rotations each, so gzip + sweeper run concurrently
  maxDirBytes: 512 * 1024 * 1024,  // sweeper active but never evicts here
});
(async () => {
  for (let i = 0; i < 5000; i++) {
    ch.logEvent('e2e.tick', { i, pad: 'x'.repeat(120) });
    if (i % 250 === 0) await new Promise((r) => setImmediate(r)); // interleave with siblings
  }
  await ch.close();
  process.send && process.send({ pid: process.pid, stats: ch.stats() });
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(3); });
`,
    );
    const results: Array<{ pid: number; stats: { written: number; dropped: number; serializeErrors: number } }> = [];
    const stderrs: string[] = [];
    const exits = await Promise.all(
      Array.from({ length: 4 }, () => {
        const c = fork(worker, [DIST_ENTRY, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        c.stderr?.on('data', (d: Buffer) => stderrs.push(d.toString('utf8')));
        c.on('message', (m) => results.push(m as (typeof results)[number]));
        return waitExit(c);
      }),
    );
    expect(exits.map((e) => e.code)).toEqual([0, 0, 0, 0]);
    expect(stderrs.join('')).toBe('');
    expect(results).toHaveLength(4);
    expect(new Set(results.map((r) => r.pid)).size).toBe(4);
    for (const r of results) expect(r.stats).toMatchObject({ written: 5000, dropped: 0, serializeErrors: 0 });

    const all = readAll(dir);
    const perPid = new Map<number, number[]>();
    for (const { line } of all) {
      const rec = JSON.parse(line) as { pid: number; i: number; event: string };
      expect(rec.event).toBe('e2e.tick');
      const arr = perPid.get(rec.pid) ?? [];
      arr.push(rec.i);
      perPid.set(rec.pid, arr);
    }
    expect([...perPid.keys()].sort()).toEqual(results.map((r) => r.pid).sort());
    for (const [, is] of perPid) {
      expect(is).toHaveLength(5000);
      expect(new Set(is).size).toBe(5000); // no loss, no duplicate
    }
    expect(all).toHaveLength(20_000);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.jsonl.gz'))).toBe(true); // rotation really happened
  }, 120_000);
});

describe('c536ce29 TRC-AC14b kill -9', () => {
  it('c536ce29 TRC-AC14b SIGKILL mid-write in sync mode: every acknowledged record is on disk and every line parses', async () => {
    const dir = mk('ac14b');
    const worker = writeScript(
      'ac14b-worker.cjs',
      `
const { createLogChannel } = require(process.argv[2]);
const ch = createLogChannel({ dir: process.argv[3], component: 'e2e.kill', fileLabel: 'k', durability: { mode: 'sync' }, gzipRotated: false });
(async () => {
  for (let n = 1; n <= 2000000; n++) {
    ch.logEvent('e2e.kill', { n, pad: 'y'.repeat(200) });
    // logEvent returned: record n is acknowledged. Report every 10th.
    if (n % 10 === 0) { process.send({ acked: n }); await new Promise((r) => setImmediate(r)); }
  }
})();
`,
    );
    const child = fork(worker, [DIST_ENTRY, dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let acked = 0;
    const exited = waitExit(child);
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('message', (m) => {
        acked = Math.max(acked, (m as { acked: number }).acked);
        if (acked >= 3000) resolve(); // deterministic trigger: a record-count milestone, not a timer
      });
      void exited.then(() => reject(new Error('child exited before the kill milestone')));
    });
    child.kill('SIGKILL');
    const { signal } = await exited;
    expect(signal).toBe('SIGKILL');

    const all = readAll(dir);
    const ns = all.map(({ line }) => (JSON.parse(line) as { n: number }).n); // throws on a torn line
    expect(acked).toBeGreaterThanOrEqual(3000);
    expect(all.length).toBeGreaterThanOrEqual(acked);
    // Dense prefix: no hole before the highest acknowledged record.
    expect(new Set(ns).size).toBe(ns.length);
    for (let n = 1; n <= acked; n++) if (!ns.includes(n)) throw new Error(`acknowledged record ${n} missing`);
  }, 60_000);
});

describe('c536ce29 TRC-AC20 cross-copy', () => {
  /** An installed npm @adhd/sox-telemetry@0.4.1: installed under the OS temp dir (no publish). */
  function installOld(): string {
    const fx = mk('old041');
    fs.writeFileSync(path.join(fx, 'package.json'), '{"name":"fx","version":"1.0.0","private":true}');
    let r = spawnSync('pnpm', ['add', '@adhd/sox-telemetry@0.4.1', '--prefer-offline'], { cwd: fx, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`pnpm add @adhd/sox-telemetry@0.4.1 failed: ${r.stderr}`);
    const pkg = path.join(fx, 'node_modules', '@adhd', 'sox-telemetry');
    const v = (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { version: string }).version;
    expect(v).toBe('0.4.1');
    r = spawnSync('node', ['-e', `require(${JSON.stringify(path.join(pkg, 'dist', 'index.js'))})`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return path.join(pkg, 'dist', 'index.js');
  }

  it('c536ce29 TRC-AC20 one runtime and one currentLogContext() across the 0.4.1 copy and two copies of the new build; an old-shaped slot is accepted, not replaced', () => {
    const oldEntry = installOld();
    // A second, physically distinct copy of the new build (distinct module instances).
    const copyDir = mk('newcopy');
    fs.cpSync(path.resolve(HERE, '..', 'dist'), path.join(copyDir, 'dist'), { recursive: true });
    fs.symlinkSync(path.resolve(HERE, '..', 'node_modules'), path.join(copyDir, 'node_modules'));
    const copyEntry = path.join(copyDir, 'dist', 'index.js');
    const logDir = mk('ac20-log');

    const script = writeScript(
      'ac20-probe.cjs',
      `
const assert = require('node:assert');
const [oldE, newE, copyE, logDir] = process.argv.slice(2);
const RT = Symbol.for('@adhd/sox-telemetry.runtime.v1');
const CTX = Symbol.for('@adhd/sox-telemetry/log-context');
// 1. the OLD copy creates the runtime slot and the (old-shaped, als-less) context slot.
const oldC = require(oldE);
oldC.initTelemetry({ service: 'old-copy', role: 'test', logSink: 'none', otel: false });
const rtSlot = globalThis[RT];
assert.ok(rtSlot, 'old copy installed the runtime slot');
const legacyCtxSlot = { legacyField: true };
globalThis[CTX] = legacyCtxSlot;
// 2. two copies of the NEW build load afterwards.
const a = require(newE);
const b = require(copyE);
assert.notStrictEqual(a.createLogChannel, b.createLogChannel, 'distinct module instances');
assert.strictEqual(globalThis[RT], rtSlot, 'runtime slot not replaced by a later copy');
// 3. one log context across both new copies; legacy slot accepted and extended in place.
a.withLogContext({ request_id: 'r-1' }, () => {
  assert.deepStrictEqual({ ...b.currentLogContext() }, { request_id: 'r-1' });
  b.withLogContext({ extra: 2 }, () => {
    assert.deepStrictEqual({ ...a.currentLogContext() }, { request_id: 'r-1', extra: 2 });
  });
});
assert.strictEqual(globalThis[CTX], legacyCtxSlot, 'context slot identity preserved');
assert.strictEqual(legacyCtxSlot.legacyField, true);
assert.ok(legacyCtxSlot.als, 'als lazily added to the old slot');
assert.deepStrictEqual({ ...a.currentLogContext() }, {});
// 4. runtime identity as the new copy sees it comes from the OLD copy's init, and
//    a channel in the new copy stamps it plus the shared context.
const ch = b.createLogChannel({ dir: logDir, component: 'e2e.cross', fileLabel: 'x' });
a.withLogContext({ request_id: 'r-2' }, () => ch.logEvent('cross.evt', {}));
ch.close().then(() => {
  assert.strictEqual(globalThis[RT], rtSlot);
  process.stdout.write('OK');
});
`,
    );
    const r = spawnSync('node', [script, oldEntry, DIST_ENTRY, copyEntry, logDir], { encoding: 'utf8' });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: 'OK', stderr: '' });
    const recs = readAll(logDir).map(({ line }) => JSON.parse(line) as Record<string, unknown>);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ event: 'cross.evt', service: 'old-copy', role: 'test', request_id: 'r-2' });
  }, 120_000);
});

describe('c536ce29 TRC-AC22 gzip rotation replay', () => {
  it('c536ce29 TRC-AC22 ~10 MB repetitive JSON rotated through the channel: gz ratio < 0.2 and byte-identical on decompress', async () => {
    const dir = mk('ac22');
    const worker = writeScript(
      'ac22-worker.cjs',
      `
const { createLogChannel } = require(process.argv[2]);
const ch = createLogChannel({ dir: process.argv[3], component: 'e2e.replay', fileLabel: 'r', maxBytes: 2 * 1024 * 1024, durability: { mode: 'sync' } });
const dest = ch.destination();
(async () => {
  for (let i = 0; i < 50000; i++) {
    dest.write(JSON.stringify({ seq: i, event: 'wire.request', method: 'POST', url: 'https://api.example.test/v1/chat/completions', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: 'lorem ipsum dolor sit amet '.repeat(5) }) + '\\n');
    if (i % 1000 === 0) await new Promise((r) => setImmediate(r));
  }
  await ch.close();
})();
`,
    );
    const c = fork(worker, [DIST_ENTRY, dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    expect((await waitExit(c)).code).toBe(0);

    // The source, regenerated here with the same recipe.
    const source: string[] = [];
    for (let i = 0; i < 50000; i++) {
      source.push(
        JSON.stringify({ seq: i, event: 'wire.request', method: 'POST', url: 'https://api.example.test/v1/chat/completions', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: 'lorem ipsum dolor sit amet '.repeat(5) }) + '\n',
      );
    }
    const sourceText = source.join('');
    expect(Buffer.byteLength(sourceText)).toBeGreaterThan(9 * 1024 * 1024);

    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const rotatedGz = files.filter((f) => f.endsWith('.jsonl.gz'));
    expect(rotatedGz.length).toBeGreaterThanOrEqual(4);
    const seqOf = (f: string): number => Number(/\.\d+-(\d+)\.jsonl\.gz$/.exec(f)?.[1]);
    rotatedGz.sort((x, y) => seqOf(x) - seqOf(y));
    const live = files.filter((f) => f.endsWith('.jsonl'));

    const gzBytes = rotatedGz.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    const parts = rotatedGz.map((f) => gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8'));
    const rawRotatedBytes = parts.reduce((n, p) => n + Buffer.byteLength(p), 0);
    const ratio = gzBytes / rawRotatedBytes;
    expect(ratio).toBeLessThan(0.2);

    const replay = parts.join('') + live.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(replay === sourceText).toBe(true); // byte-identical, in order
  }, 120_000);
});
