import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { isBenignOnnxCoreMlWarning, attachOnnxStderrFilter } from './onnxStderrFilter.js';

/**
 * BUG-EMBED-ONNX-COREML-STDERR-NOISE-001 regression test.
 *
 * Reproduces the exact terminal noise the user reported: the fastembed child
 * process's inherited stderr prints ONNX Runtime's CoreML dim-limit warning
 * on every single `adhd-backlog` invocation. Proves the fix filters
 * PRECISELY: the benign CoreML warning is dropped, but the BL-331
 * competing-host line, the BL-432-adjacent forced-execution-provider line,
 * and an arbitrary genuine error all survive verbatim and in order.
 *
 * Negative control (recorded manually, per report instructions): with
 * `isBenignOnnxCoreMlWarning` stubbed to always return `false` (i.e.
 * reverting the fix), the first assertion in
 * "drops the benign warning line while preserving everything else" fails —
 * the collected output contains the ONNX warning line — confirming the test
 * has teeth.
 */

const REAL_ONNX_COREML_WARNING =
  '2026-09-05 00:47:51.925 node[40926:62798280] 2026-09-05 00:47:51.925344 ' +
  '[W:onnxruntime:, helper.cc:83 IsInputSupported] CoreML does not support ' +
  'input dim > 16384. Input:embeddings.word_embeddings.weight, shape: {30522,768}';

const BL432_COMPETING_HOST_LINE =
  '[fastembed] WARNING (BL-331): another fastembed host process (pid 12345, ' +
  'started 2026-09-05T00:00:00.000Z) is ALREADY RUNNING on this machine. ' +
  'Concurrent onnxruntime-node CoreML/ANE execution across separate OS processes has ' +
  'been observed to cause severe (25-50x) embed latency due to Neural Engine/hardware ' +
  'queue contention. Lock file: /tmp/sox-fastembed-host.lock';

const FORCED_PROVIDER_LINE = '[fastembed] Using forced execution provider: cpu';

const ARBITRARY_ERROR_LINE = 'Error: Cannot find module tokenizer.json at /nonexistent/path';

describe('isBenignOnnxCoreMlWarning', () => {
  it('matches the real reported ONNX CoreML dim-limit warning', () => {
    expect(isBenignOnnxCoreMlWarning(REAL_ONNX_COREML_WARNING)).toBe(true);
  });

  it('does not match the BL-331 competing-host warning line', () => {
    expect(isBenignOnnxCoreMlWarning(BL432_COMPETING_HOST_LINE)).toBe(false);
  });

  it('does not match the forced-execution-provider line', () => {
    expect(isBenignOnnxCoreMlWarning(FORCED_PROVIDER_LINE)).toBe(false);
  });

  it('does not match an arbitrary error line', () => {
    expect(isBenignOnnxCoreMlWarning(ARBITRARY_ERROR_LINE)).toBe(false);
  });
});

describe('attachOnnxStderrFilter', () => {
  function collect(): { dest: Writable; lines: () => string[] } {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    });
    return { dest, lines: () => chunks.join('').split('\n').filter((l) => l.length > 0) };
  }

  it('drops the benign warning line while preserving everything else, in order', async () => {
    const source = new PassThrough();
    const { dest, lines } = collect();
    attachOnnxStderrFilter(source, dest);

    source.write(`${FORCED_PROVIDER_LINE}\n`);
    source.write(`${REAL_ONNX_COREML_WARNING}\n`);
    source.write(`${BL432_COMPETING_HOST_LINE}\n`);
    source.write(`${ARBITRARY_ERROR_LINE}\n`);
    source.end();

    await new Promise((resolve) => source.on('end', resolve));
    // Allow the queued 'data'/'end' handlers to flush into `dest`.
    await new Promise((resolve) => setImmediate(resolve));

    const out = lines();
    expect(out).not.toContain(REAL_ONNX_COREML_WARNING);
    expect(out.some((l) => l.includes('CoreML does not support input dim'))).toBe(false);
    expect(out).toEqual([FORCED_PROVIDER_LINE, BL432_COMPETING_HOST_LINE, ARBITRARY_ERROR_LINE]);
  });

  it('splits multi-chunk writes on newline boundaries correctly (no partial-line leak)', async () => {
    const source = new PassThrough();
    const { dest, lines } = collect();
    attachOnnxStderrFilter(source, dest);

    // Write the benign warning split across two chunks, straddling the
    // newline boundary, followed by a real error line split the same way.
    const half = Math.floor(REAL_ONNX_COREML_WARNING.length / 2);
    source.write(REAL_ONNX_COREML_WARNING.slice(0, half));
    source.write(REAL_ONNX_COREML_WARNING.slice(half) + '\n');
    source.write(ARBITRARY_ERROR_LINE.slice(0, 5));
    source.write(ARBITRARY_ERROR_LINE.slice(5) + '\n');
    source.end();

    await new Promise((resolve) => source.on('end', resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines()).toEqual([ARBITRARY_ERROR_LINE]);
  });

  it('flushes and filters a trailing unterminated line on stream end', async () => {
    const source = new PassThrough();
    const { dest, lines } = collect();
    attachOnnxStderrFilter(source, dest);

    // No trailing '\n' — this is the "final write before process exit" case.
    source.write(ARBITRARY_ERROR_LINE);
    source.end();

    await new Promise((resolve) => source.on('end', resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(dest.writableLength >= 0).toBe(true); // sanity: no throw
    const out = lines();
    expect(out).toEqual([ARBITRARY_ERROR_LINE]);
  });
});
