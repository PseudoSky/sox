/**
 * db.spec.ts — BL-41: a leading `~`/`~/` in db_path is expanded to $HOME at the
 * file-create sink, so the literal string the skill docs show
 * (`db_path: "~/.memory/memory.db"`) writes under $HOME/.memory and NEVER creates a
 * literal `~` directory relative to cwd.
 *
 * The expansion is THE single canonical expander (`expandDbPath`) applied inside
 * `openDb`/`openDbReadOnly`/the daemon constructor, so every consumer is covered
 * regardless of whether the caller pre-expanded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, openDbReadOnly, expandDbPath } from './db.js';

beforeEach(() => { process.env['SOX_EMBED_BACKEND'] = 'hash'; });
afterEach(() => { delete process.env['SOX_EMBED_BACKEND']; });

describe('expandDbPath — BL-41 tilde expansion', () => {
  it('expands a bare ~ to homedir', () => {
    expect(expandDbPath('~')).toBe(os.homedir());
  });

  it('expands ~/.memory/x.db to $HOME/.memory/x.db', () => {
    expect(expandDbPath('~/.memory/x.db')).toBe(
      path.join(os.homedir(), '.memory', 'x.db'),
    );
  });

  it('is idempotent for already-absolute paths', () => {
    const abs = path.join(os.tmpdir(), 'mem', 'y.db');
    expect(expandDbPath(abs)).toBe(abs);
  });

  it('does NOT expand a ~ that is not a path prefix (e.g. ~foo)', () => {
    // ~user-style home expansion is out of scope; only `~` and `~/` expand.
    expect(expandDbPath('~foo/x.db')).toBe('~foo/x.db');
  });
});

describe('openDb — BL-41 no literal ~ dir is created', () => {
  // Run with HOME pointed at a throwaway dir, cwd at another throwaway dir, so we
  // can prove (a) the db lands under $HOME/.memory and (b) no `~` dir appears in cwd.
  let tmpHome: string;
  let tmpCwd: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-cwd-'));
    origHome = process.env['HOME'];
    origUserProfile = process.env['USERPROFILE'];
    origCwd = process.cwd();
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env['HOME']; else process.env['HOME'] = origHome;
    if (origUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = origUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('opening "~/.memory/memory.db" writes under $HOME/.memory and leaves no "~" dir in cwd', () => {
    const db = openDb('~/.memory/memory.db');
    db.close();

    const expected = path.join(tmpHome, '.memory', 'memory.db');
    expect(fs.existsSync(expected)).toBe(true);

    // The exact BL-41 regression: a literal `~` directory relative to cwd.
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
    expect(fs.existsSync(path.join(tmpCwd, '~', '.memory'))).toBe(false);
  });

  it('openDbReadOnly also expands ~ (opens the same expanded file)', () => {
    // Create the file first via openDb, then re-open read-only with the tilde form.
    openDb('~/.memory/ro.db').close();
    const ro = openDbReadOnly('~/.memory/ro.db');
    ro.close();
    expect(fs.existsSync(path.join(tmpHome, '.memory', 'ro.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
  });
});
