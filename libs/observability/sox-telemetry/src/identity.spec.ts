/**
 * identity.spec.ts — 621a11c5 AC1: shared process-identity span attributes.
 *
 * The worktree tests build REAL repositories (`git init`, `git worktree add`)
 * under a temp dir — no mocking of git — and pass the directory to the
 * classifier, since a vitest worker cannot `process.chdir()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SESSION_ID_ENV,
  _resetProcessIdentityForTest,
  _resetTelemetryForTest,
  classifyWorktree,
  identityAttributes,
  initTelemetry,
  prefixAttributes,
  processIdentity,
  requireTelemetryPrefix,
  resolveProcessIdentity,
  toOtelAttributes,
} from './index.js';

const roots: string[] = [];
function tmp(): string {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and git reports real paths.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-identity-')));
  roots.push(d);
  return d;
}

/** Run git with every hook-exported GIT_* variable scrubbed so it targets only `cwd`. */
function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

afterEach(() => {
  _resetProcessIdentityForTest();
  _resetTelemetryForTest();
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('621a11c5 AC1: classifyWorktree', () => {
  it("621a11c5 AC1: 'none' outside any repository", () => {
    expect(classifyWorktree(tmp())).toBe('none');
  });

  it("621a11c5 AC1: 'main' in a repository's main checkout, 'linked' in a linked worktree", () => {
    const main = path.join(tmp(), 'main');
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const linked = path.join(path.dirname(main), 'linked');
    git(main, 'worktree', 'add', '-q', linked, '-b', 'feature');

    expect(classifyWorktree(main)).toBe('main');
    expect(classifyWorktree(linked)).toBe('linked');
    // a subdirectory classifies like its checkout
    fs.mkdirSync(path.join(linked, 'sub'));
    expect(classifyWorktree(path.join(linked, 'sub'))).toBe('linked');
  });

  it("621a11c5 AC1: 'none' when the directory does not exist (probe failure never throws)", () => {
    expect(classifyWorktree(path.join(tmp(), 'does-not-exist'))).toBe('none');
  });
});

describe('621a11c5 AC1: resolveProcessIdentity / processIdentity', () => {
  it('621a11c5 AC1: session id comes from ADHD_SESSION_ID, an explicit argument wins, and blank falls back to a uuid', () => {
    const cwd = tmp();
    expect(SESSION_ID_ENV).toBe('ADHD_SESSION_ID');
    expect(resolveProcessIdentity({ ADHD_SESSION_ID: 'sess-1' }, cwd).sessionId).toBe('sess-1');
    expect(resolveProcessIdentity({ ADHD_SESSION_ID: 'sess-1' }, cwd, 'explicit').sessionId).toBe('explicit');
    const blank = resolveProcessIdentity({ ADHD_SESSION_ID: '' }, cwd).sessionId;
    expect(blank).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(resolveProcessIdentity({}, cwd).worktree).toBe('none');
  });

  it('621a11c5 AC1: processIdentity() is resolved once and stable — never per call', () => {
    const a = processIdentity();
    const b = processIdentity();
    expect(b).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    _resetProcessIdentityForTest();
    expect(processIdentity()).not.toBe(a);
  });

  it('621a11c5 AC1: two installed copies of the package agree on one session_id', async () => {
    const { vi } = await import('vitest');
    const first = processIdentity();
    vi.resetModules();
    const second = (await import('./index.js')) as typeof import('./index.js');
    expect(second.processIdentity().sessionId).toBe(first.sessionId);
  });
});

describe('621a11c5 AC1: identityAttributes', () => {
  beforeEach(() => _resetTelemetryForTest());

  it('621a11c5 AC1: stamps session_id, worktree and the LIVE runtime role as flat unprefixed OTel-safe keys', () => {
    const h = initTelemetry({ service: 'ident', role: 'harness', logSink: 'none', otel: false });
    const attrs = identityAttributes();
    expect(Object.keys(attrs).sort()).toEqual(['role', 'session_id', 'worktree']);
    expect(attrs.role).toBe('harness');
    expect(attrs.session_id).toBe(processIdentity().sessionId);
    expect(['main', 'linked', 'none']).toContain(attrs.worktree);
    expect(Object.values(attrs).every((v) => typeof v === 'string')).toBe(true);
    h.close();
  });
});

describe('621a11c5 AC1: toOtelAttributes / requireTelemetryPrefix / prefixAttributes', () => {
  it('621a11c5 AC1: toOtelAttributes keeps only string|number|boolean and drops everything else', () => {
    expect(
      toOtelAttributes({ s: 'x', n: 1, b: false, o: { a: 1 }, u: undefined, z: null, arr: [1], f: () => 1 }),
    ).toEqual({ s: 'x', n: 1, b: false });
  });

  it('621a11c5 AC1: requireTelemetryPrefix is REQUIRED — absent, blank or non-string fails loudly; valid is trimmed', () => {
    for (const bad of [undefined, null, '', '   ', 7, {}]) {
      expect(() => requireTelemetryPrefix(bad, 'my-plugin')).toThrow(/my-plugin: `prefix` is required/);
    }
    expect(requireTelemetryPrefix(' adhd ')).toBe('adhd');
  });

  it('621a11c5 AC1: prefixAttributes namespaces own keys, drops non-OTel values, and rejects a blank prefix', () => {
    expect(prefixAttributes('adhd', { op: 'run', transport: 'mcp', n: 2, nested: { a: 1 } })).toEqual({
      'adhd.op': 'run',
      'adhd.transport': 'mcp',
      'adhd.n': 2,
    });
    expect(() => prefixAttributes('', { op: 'x' })).toThrow(/prefix/);
  });
});
