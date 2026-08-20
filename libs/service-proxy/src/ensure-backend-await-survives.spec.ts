/**
 * BUG-SOX-UPGRADE-DIES-SILENTLY-AT-ENSUREBACKEND — a caller awaiting
 * `ensureBackend` must still be alive to observe the result.
 *
 * WHY A SUBPROCESS TEST. The defect is not observable in-process: vitest keeps
 * its own handles referenced, so an unref'd timer inside the module under test
 * never gets the chance to let the loop drain. Reproducing it REQUIRES a bare
 * node process whose only pending work is the await — which is precisely the
 * situation `soxe upgrade`'s rolling-restart pass is in after `child.unref()`.
 * An in-process assertion here would pass against the broken code.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('BUG-SOX-UPGRADE-DIES-SILENTLY-AT-ENSUREBACKEND', () => {
  it('a bare process awaiting the readiness sleep reaches the statement after the await', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-backend-await-'));
    const script = path.join(dir, 'probe.mjs');

    // Mirrors spawnUnderLock's shape exactly: release every referenced handle,
    // then await the sleep and print AFTER it. If the timer is unref'd the
    // process exits 0 here having printed nothing — the exact production
    // failure, where the post-await OS-unit re-enable never ran.
    fs.writeFileSync(
      script,
      [
        'const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });',
        'async function main() {',
        '  await sleep(120);',
        '  process.stdout.write("REACHED_AFTER_AWAIT");',
        '}',
        'main();',
      ].join('\n'),
      'utf8',
    );

    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 15000 });
    expect(out).toBe('REACHED_AFTER_AWAIT');
  });

  it('an UNREFd sleep loses the race — documents the defect so it cannot silently return', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-backend-await-unref-'));
    const script = path.join(dir, 'probe-unref.mjs');

    fs.writeFileSync(
      script,
      [
        'const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());',
        'async function main() {',
        '  await sleep(120);',
        '  process.stdout.write("REACHED_AFTER_AWAIT");',
        '}',
        'main();',
      ].join('\n'),
      'utf8',
    );

    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 15000 });
    // Empty output AND exit 0 — a silent, successful-looking death mid-await.
    // This is the shape that made `soxe upgrade --all` report success while
    // skipping 5 of 6 consumers and leaving an OS unit unloaded.
    expect(out).toBe('');
  });
});
