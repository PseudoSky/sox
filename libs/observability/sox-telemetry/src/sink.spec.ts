/**
 * sink.spec.ts — c536ce29 L2-AC-D: the additive DurableJsonlSink options leave
 * the default behaviour byte-compatible, and the retention anchor accepts the
 * new per-process / .gz names while keeping the BL-351 full-shape anchor.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableJsonlSink, componentFileAnchor, sweepComponentFiles } from './sink.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-sink-spec-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const utc = (): string => new Date().toISOString().slice(0, 10);

describe('c536ce29 L2-AC-D default sink file names are unchanged', () => {
  it('c536ce29 L2-AC-D no new options: shared name <component>-<UTC date>.jsonl, rotation <..>.<epoch>-<seq>.jsonl, no pid/label, no gz', async () => {
    const sink = new DurableJsonlSink({ dir, component: 'svc.live', maxBytes: 1, maxFiles: 50 });
    sink.write('{"a":1}\n');
    expect(path.basename(sink.currentPath())).toBe(`svc.live-${utc()}.jsonl`);
    expect(path.basename(sink.plannedPath())).toBe(`svc.live-${utc()}.jsonl`);
    sink.write('{"a":2}\n');
    await sink.flush();
    sink.close();
    for (const f of fs.readdirSync(dir)) {
      expect(f).toMatch(/^svc\.live-\d{4}-\d{2}-\d{2}(\.\d+-\d+)?\.jsonl$/);
    }
    expect(fs.readdirSync(dir).length).toBeGreaterThan(1);
  });

  it('c536ce29 L2-AC-D write() still returns void-equivalent and tryWrite reports success', () => {
    const sink = new DurableJsonlSink({ dir, component: 'svc.try' });
    expect(sink.write('{"a":1}\n')).toBeUndefined();
    expect(sink.tryWrite('{"a":2}\n')).toBe(true);
    sink.close();
  });

  it('c536ce29 L2-AC-D per-process scope names the file <component>-<date>.<label>.<pid>.jsonl with a sanitised label', () => {
    const sink = new DurableJsonlSink({ dir, component: 'svc.pp', fileScope: 'per-process', fileLabel: 'my label!' });
    sink.write('{"a":1}\n');
    expect(path.basename(sink.currentPath())).toBe(`svc.pp-${utc()}.my_label_.${process.pid}.jsonl`);
    sink.close();
  });
});

describe('c536ce29 L2-AC-D retention anchor', () => {
  const a = componentFileAnchor('svc');
  it('c536ce29 L2-AC-D accepts legacy, per-process, rotated and .gz shapes', () => {
    for (const ok of [
      'svc-2026-08-01.jsonl',
      'svc-2026-08-01.1700000000000-3.jsonl',
      'svc-2026-08-01.lbl.1234.jsonl',
      'svc-2026-08-01.lbl.1234.1700000000000-3.jsonl',
      'svc-2026-08-01.lbl.1234.1700000000000-3.jsonl.gz',
      'svc-2026-08-01.jsonl.gz',
    ]) expect(a.test(ok), ok).toBe(true);
  });
  it('c536ce29 L2-AC-D keeps the BL-351 full-shape anchor: a longer component or stray suffix never matches', () => {
    for (const no of [
      'svc.live-2026-08-01.jsonl',
      'svc-live-2026-08-01.jsonl',
      'svc-2026-08-01.lbl.1234.jsonl.gz.tmp',
      'svc-2026-08-01.lbl.jsonl',
      'svc-2026-08-01.jsonl.bak',
      'xsvc-2026-08-01.jsonl',
      'svc-notes.txt',
    ]) expect(a.test(no), no).toBe(false);
  });
  it('c536ce29 L2-AC-D sweepComponentFiles with only maxFiles keeps the legacy newest-N-by-name behaviour', () => {
    for (const d of ['01', '02', '03', '04']) fs.writeFileSync(path.join(dir, `svc-2026-08-${d}.jsonl`), 'x\n');
    fs.writeFileSync(path.join(dir, 'svc.live-2026-08-01.jsonl'), 'keep\n');
    const n = sweepComponentFiles({ dir, component: 'svc', maxFiles: 2 });
    expect(n).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['svc-2026-08-03.jsonl', 'svc-2026-08-04.jsonl', 'svc.live-2026-08-01.jsonl']);
  });
  it('c536ce29 L2-AC-D sweeping a missing directory is a no-op', () => {
    expect(sweepComponentFiles({ dir: path.join(dir, 'nope'), component: 'svc', maxFiles: 1 })).toBe(0);
  });
});
