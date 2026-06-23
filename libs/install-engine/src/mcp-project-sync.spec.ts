/**
 * mcp-project-sync.spec.ts — #16728 unit coverage for the host-registry-independent
 * surface of the MCP project auto-merge.
 *
 * NOTE: the full merge/reverse path lazily `require('@adhd/sox-host-registry')`,
 * which does NOT resolve under source-mode vitest (the same constraint documented in
 * data-paths.ts). The end-to-end merge → byte-clean reversal is reality-proven against
 * the built dist by tools/probe-mcp-project-automerge.mjs (wired into test-e2e
 * host-runtime, Section MCP). Here we test the pure install-registry projection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { knownProjectRoots } from './mcp-project-sync.js';
import { upsertInstallRecord } from './install-registry.js';

let dataHome: string;
let origEcoHome: string | undefined;

beforeEach(() => {
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mcpsync-'));
  origEcoHome = process.env['SOX_ECOSYSTEM_HOME'];
  // Point the (global) install-registry at a throwaway data root.
  process.env['SOX_ECOSYSTEM_HOME'] = dataHome;
});

afterEach(() => {
  if (origEcoHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = origEcoHome;
  fs.rmSync(dataHome, { recursive: true, force: true });
});

describe('knownProjectRoots — #16728 scope guard', () => {
  it('returns [] when no installs are recorded', () => {
    expect(knownProjectRoots()).toEqual([]);
  });

  it('returns only project-scope roots (ignores user/local)', () => {
    upsertInstallRecord({ extId: 'a', version: '1', scope: 'project', root: '/p/one', source: 'file://x' });
    upsertInstallRecord({ extId: 'b', version: '1', scope: 'user', root: '/home/u', source: 'file://x' });
    upsertInstallRecord({ extId: 'c', version: '1', scope: 'local', root: '/p/two', source: 'file://x' });
    const roots = knownProjectRoots().sort();
    expect(roots).toEqual(['/p/one']);
  });

  it('de-duplicates multiple extensions installed at the same project root', () => {
    upsertInstallRecord({ extId: 'a', version: '1', scope: 'project', root: '/p/one', source: 'file://x' });
    upsertInstallRecord({ extId: 'b', version: '1', scope: 'project', root: '/p/one', source: 'file://x' });
    upsertInstallRecord({ extId: 'c', version: '1', scope: 'project', root: '/p/two', source: 'file://x' });
    const roots = knownProjectRoots().sort();
    expect(roots).toEqual(['/p/one', '/p/two']);
  });

  it('skips ephemeral project roots under the OS temp dir (BL-35 leak guard)', () => {
    const tmpRoot = path.join(os.tmpdir(), 'adr3-scope-XXXX');
    upsertInstallRecord({ extId: 'leak', version: '1', scope: 'project', root: tmpRoot, source: 'file://x' });
    upsertInstallRecord({ extId: 'real', version: '1', scope: 'project', root: '/p/real', source: 'file://x' });
    const roots = knownProjectRoots().sort();
    expect(roots).toEqual(['/p/real']);
  });
});
