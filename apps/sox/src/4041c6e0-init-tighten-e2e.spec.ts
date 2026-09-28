/**
 * 4041c6e0-init-tighten-e2e.spec.ts — a legacy 0775 run dir still serves after
 * CLI init (BL-4041c6e0, BL-6233c1c2).
 *
 * An older soxe, or any mkdir under umask 002, left `run/` and
 * `run/supervisors/` at 0775. The socket-dir trust check refuses that
 * (`E_UDS_DIR_UNSAFE`, reason `own-writable`), which would take down every
 * proxy-mode backend on upgrade. `soxe` calls `tightenSoxRunDirs()` once at
 * start, before verb dispatch. This spec runs that init step against a
 * pre-created 0775 tree, then does a real serveBackend + dialBackend round trip
 * in `socketDir()`.
 *
 * Runs under umask 002, restored in `finally`, with a fresh scratch
 * SOX_ECOSYSTEM_HOME. The real data root is never touched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDir, socketDir } from '@adhd/sox-host-runtime';
import { tightenSoxRunDirs } from './tighten-run-dirs.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('BL-4041c6e0 / 6233c1c2: CLI init repairs a legacy 0775 run dir', () => {
  it('4041c6e0 6233c1c2: after tightenSoxRunDirs, serveBackend + dialBackend round-trip in socketDir()', async () => {
    const proxy = await import('@adhd/sox-service-proxy');
    expect(() => process.umask()).not.toThrow(); // precondition: umask is settable here
    const prevUmask = process.umask(0o002);
    try {
      // Short paths: the socket must fit the 104-byte sun_path under tier 1.
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 's4e-'));
      const prevHome = process.env['SOX_ECOSYSTEM_HOME'];
      process.env['SOX_ECOSYSTEM_HOME'] = path.join(parent, 'r');
      cleanups.push(() => {
        if (prevHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
        else process.env['SOX_ECOSYSTEM_HOME'] = prevHome;
        fs.rmSync(parent, { recursive: true, force: true });
      });

      // The legacy shape: a bare recursive mkdir under umask 002 => 0775.
      fs.mkdirSync(socketDir(), { recursive: true });
      expect(fs.statSync(runDir()).mode & 0o777).toBe(0o775);
      expect(fs.statSync(socketDir()).mode & 0o777).toBe(0o775);

      // CLI init.
      const results = tightenSoxRunDirs();
      expect(results).toEqual([
        { dir: runDir(), outcome: 'tightened' },
        { dir: socketDir(), outcome: 'tightened' },
      ]);

      const sock = path.join(socketDir(), 'e2e.sock');
      const handle = await proxy.serveBackend({
        socketPath: sock,
        onDiagnostic: () => {},
        handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: 'pong' }),
      });
      cleanups.push(() => handle.close());
      const conn = proxy.dialBackend({ socketPath: sock, onDiagnostic: () => {} });
      cleanups.push(() => conn.close());

      const resp = await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(resp.error).toBeUndefined();
      expect(resp.result).toBe('pong');
      expect(fs.statSync(socketDir()).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prevUmask);
    }
  });
});
