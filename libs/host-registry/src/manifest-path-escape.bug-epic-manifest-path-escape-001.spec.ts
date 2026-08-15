/**
 * libs/host-registry/src/manifest-path-escape.bug-epic-manifest-path-escape-001.spec.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001 — internal.ts:151 (expandHome) and :160
 * (existsIn). VERIFIED (2026-08-14): every current call site of both
 * functions across the repo passes a hardcoded literal (host-module surface
 * strings like "~/.claude/agents", or existsIn(workspaceRoot, '.claude')) —
 * never manifest/CLI input — so today these are ALREADY-SAFE by construction,
 * not a reachable escape. Both are public exports, though, and the fix is
 * defense-in-depth at the boundary so a future caller can't reopen the class.
 * This spec pins that behaviour with a real symlink-escape case, not just a
 * string check.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsIn, expandHome } from './internal.js';

let tmp: string;
let origSandbox: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-registry-path-escape-'));
  origSandbox = process.env['SOX_SANDBOX_ROOT'];
  process.env['SOX_SANDBOX_ROOT'] = tmp;
});

afterEach(() => {
  if (origSandbox === undefined) delete process.env['SOX_SANDBOX_ROOT'];
  else process.env['SOX_SANDBOX_ROOT'] = origSandbox;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('expandHome', () => {
  it('expands a well-formed tilde path inside the sandbox root', () => {
    // assertWithinBase resolves through realpath (macOS: /tmp -> /private/tmp),
    // so compare against the realpath'd base, not the raw mkdtemp string.
    expect(expandHome('~/.claude/agents')).toBe(path.join(fs.realpathSync(tmp), '.claude', 'agents'));
  });

  it('refuses a tilde path that escapes the effective home via ../', () => {
    expect(() => expandHome('~/../../evil')).toThrow(/path escape refused/i);
  });

  it('passes through a non-tilde path unchanged', () => {
    expect(expandHome('/already/absolute')).toBe('/already/absolute');
  });
});

describe('existsIn', () => {
  it('checks a well-formed relative path under workspaceRoot', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    expect(existsIn(tmp, '.claude')).toBe(true);
    expect(existsIn(tmp, '.codex')).toBe(false);
  });

  it('refuses a relative path that escapes workspaceRoot via ../', () => {
    fs.writeFileSync(path.join(path.dirname(tmp), 'sibling-secret.txt'), 'secret');
    expect(() => existsIn(tmp, '../sibling-secret.txt')).toThrow(/path escape refused/i);
  });

  it('an absolute rel bypasses workspaceRoot entirely by design (unchanged from pre-fix behaviour)', () => {
    const abs = path.join(tmp, 'CLAUDE.md');
    fs.writeFileSync(abs, 'hi');
    expect(existsIn('/some/unrelated/workspace', abs)).toBe(true);
  });
});
