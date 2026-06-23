/**
 * vitest.setup.ts — BL-35 test-isolation guard for the install-engine suite.
 *
 * Several specs drive the REAL `install()` / `upsertInstallRecord()` path (e.g.
 * integrity.scope.spec.ts, lifecycle.spec.ts, verify-integrity.spec.ts). Those
 * writes route through `installRegistryPath()` → `dataRoot('user')` →
 * `$SOX_ECOSYSTEM_HOME` (ADR-0004 §D7). Without an override that resolves to the
 * developer's REAL `~/.adhd/sox-ecosystem/` — so a unit run leaks fixture install
 * records (the `adr3-scope-*` roots) into live user state (BL-35: observed grown to
 * ~480 leaked records, which then fan `upgrade --all --force` out across dead roots).
 *
 * Fix at the source: point the ENTIRE user data root (install-registry, ledger,
 * ownership) at a throwaway dir for the whole test process, set synchronously at
 * setup-file load so it is in place before any spec body runs. This isolates EVERY
 * spec — including ones not yet written — so the leak cannot regress. Specs that set
 * `SOX_ECOSYSTEM_HOME` themselves (e.g. mcp-project-sync.spec.ts) still override it
 * locally and restore back to this sandbox, which is harmless.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ie-spec-home-'));
process.env['SOX_ECOSYSTEM_HOME'] = sandboxHome;
// SOX_HOME is retired (ADR-0004) but unset it too so no legacy resolver escapes.
delete process.env['SOX_HOME'];

afterAll(() => {
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
