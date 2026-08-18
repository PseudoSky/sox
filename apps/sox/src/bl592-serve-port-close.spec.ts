/**
 * bl592-serve-port-close.spec.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part D.
 *
 * `waitForServePortSignal` (factored out of `cmdServe`'s `--port` branch into
 * `serve-shutdown.ts` for testability — `main.ts` runs `void main()` at import
 * time, so it cannot be imported directly by a unit test) MUST call
 * `handle.close()` before its returned promise resolves on SIGTERM/SIGINT.
 *
 * RED against pre-fix code: the `--port` branch resolved on SIGTERM/SIGINT and
 * fell through to `process.exit(0)` WITHOUT ever calling `handle.close()` — an
 * injectable `FrontShimHandle` test double would have recorded ZERO calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForServePortSignal } from './serve-shutdown.js';

describe('BL-592 §8.1a part D — waitForServePortSignal calls handle.close() on signal', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('RED (pre-fix: 0 calls to handle.close()) — SIGTERM triggers exactly one handle.close() call before resolving', async () => {
    const close = vi.fn();
    const handle = { close };

    const p = waitForServePortSignal(handle);
    process.emit('SIGTERM');
    await p;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('SIGINT also triggers handle.close()', async () => {
    const close = vi.fn();
    const handle = { close };

    const p = waitForServePortSignal(handle);
    process.emit('SIGINT');
    await p;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('close() is called strictly BEFORE the promise resolves (not raced/discarded)', async () => {
    const order: string[] = [];
    const handle = {
      close: () => {
        order.push('close');
      },
    };

    const p = waitForServePortSignal(handle).then(() => {
      order.push('resolved');
    });
    process.emit('SIGTERM');
    await p;

    expect(order).toEqual(['close', 'resolved']);
  });
});
