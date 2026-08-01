/**
 * index.spec.ts — memory-cli discovery regression tests.
 *
 * BL-95 ("status markers record intent, not outcome"): cmdStatus was fixed to
 * discover bare, unregistered `~/.memory/*.db` stores (a live store at
 * `~/.memory/memory.db` predates the scope-naming convention and is invisible
 * to a registry-only lookup). cmdList was NOT touched in that fix — it still
 * only looked at `<basePath || cwd>/.memory`, so `memory-cli list` with no
 * `--base-path` kept failing to find `~/.memory/memory.db`, which was the
 * original reported symptom, just in the sibling command.
 *
 * This suite is red→green for that gap: it fails against the pre-fix
 * `cmdList` (which only checks `<cwd>/.memory`, never `~/.memory`) and passes
 * once `cmdList` shares `cmdStatus`'s discovery via `discoverStorePaths()`.
 *
 * Both HOME and process.cwd() are sandboxed to disposable tmpdirs for every
 * test — never touch the real `~/.memory` (see BL-35 precedent:
 * libs/install-engine/vitest.setup.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initScope, openDb } from '@adhd/sox-memory-core';
import { runCli } from './index';

describe('memory-cli discovery (BL-95)', () => {
  let sandboxHome: string;
  let sandboxCwd: string;
  let savedHome: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-cli-home-'));
    sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-cli-cwd-'));

    savedHome = process.env['HOME'];
    process.env['HOME'] = sandboxHome;

    // Hermetically isolate process.cwd() too: cmdStatus/cmdList's "no --base-path"
    // branch also reads <cwd>/.memory as part of discovery. Pinning cwd to an
    // empty scratch dir guarantees the test only ever sees the fixture store we
    // create under sandboxHome, regardless of what invokes the test runner.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sandboxCwd);

    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    if (savedHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = savedHome;
    }
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(sandboxCwd, { recursive: true, force: true });
  });

  /** Create a bare, unregistered `<dir>/<name>.db` store with one live node. */
  async function seedBareStore(dir: string, name: string, uid: string, content: string): Promise<string> {
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `${name}.db`);
    const adapter = await openDb(dbPath);
    await initScope(adapter, 'user', 'test-scope-id');
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`,
      [uid, 'episode', content, new Date().toISOString()],
    );
    await adapter.close();
    return dbPath;
  }

  it('`list` finds ~/.memory/memory.db with no --base-path (regression for BL-95)', async () => {
    const memDir = path.join(sandboxHome, '.memory');
    await seedBareStore(memDir, 'memory', 'n1', 'hello world');

    await runCli(['list']);

    const output = logs.join('\n');
    expect(output).not.toContain('No memory stores found');
    expect(output).not.toContain('No .memory directory found');
    expect(output).toContain('memory.db');
    expect(output).toContain('n1');
    // BL-95: an unregistered bare store must be flagged, same as cmdStatus.
    expect(output).toContain('(unregistered/memory)');
    expect(output).toContain('unregistered store(s) found');
  });

  it('`list` and `status` agree on discovered stores (no divergent strategy)', async () => {
    const memDir = path.join(sandboxHome, '.memory');
    await seedBareStore(memDir, 'memory', 'n2', 'parity check');

    await runCli(['list']);
    const listOutput = logs.join('\n');
    logs.length = 0;

    await runCli(['status']);
    const statusOutput = logs.join('\n');

    expect(listOutput).toContain('memory.db');
    expect(statusOutput).toContain('memory.db');
    expect(listOutput).toContain('(unregistered/memory)');
    expect(statusOutput).toContain('(unregistered/memory)');
  });

  it('`list` still finds stores under an explicit --base-path', async () => {
    const explicitBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-cli-base-'));
    try {
      await seedBareStore(path.join(explicitBase, '.memory'), 'project', 'n3', 'explicit base-path store');

      await runCli(['list', '--base-path', explicitBase]);

      const output = logs.join('\n');
      expect(output).toContain('project.db');
      expect(output).toContain('n3');
    } finally {
      fs.rmSync(explicitBase, { recursive: true, force: true });
    }
  });

  it('`list` reports "No memory stores found." (parity with `status`) when nothing exists', async () => {
    await runCli(['list']);
    expect(logs.join('\n')).toContain('No memory stores found.');
  });
});

describe('memory-cli init/status/list on the Turso adapter (BL-380)', () => {
  // BL-380: cmdInit, cmdStatus, and cmdList reached around StoreAdapter via
  // `(adapter as any).unwrap()` and drove the raw better-sqlite3 handle
  // synchronously. On the default (turso) backend `.prepare().get()/.all()`
  // return Promises, not rows/objects — `db.prepare(...).get()` throws
  // `db.prepare is not a function` (TursoAdapter.unwrap() doesn't exist) and
  // the CLI is unusable on the default backend. This suite pins
  // STORE_ADAPTER=turso explicitly (belt-and-suspenders — factory.ts already
  // defaults to turso when unset) and exercises `init`, `status`, `list`
  // end-to-end against a real Turso-backed store to prove the adapter's
  // async executeGet/executeAll/executeRun API is used instead.
  let sandboxHome: string;
  let sandboxCwd: string;
  let savedHome: string | undefined;
  let savedAdapter: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-cli-turso-home-'));
    sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-cli-turso-cwd-'));

    savedHome = process.env['HOME'];
    process.env['HOME'] = sandboxHome;
    savedAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';

    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sandboxCwd);

    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    if (savedHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = savedHome;
    }
    if (savedAdapter === undefined) {
      delete process.env['STORE_ADAPTER'];
    } else {
      process.env['STORE_ADAPTER'] = savedAdapter;
    }
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(sandboxCwd, { recursive: true, force: true });
  });

  it('`init` creates a scope on Turso without throwing through unwrap() (BL-380)', async () => {
    await runCli(['init', '--scope', 'project', '--path', sandboxCwd]);

    const output = logs.join('\n');
    expect(output).toContain('Created:');
    expect(output).toContain('scope_id:');
    expect(output).toContain('embed_model:');
    expect(fs.existsSync(path.join(sandboxCwd, '.memory', 'project.db'))).toBe(true);
  });

  it('`init` is idempotent on a second run against the same Turso store (BL-380)', async () => {
    await runCli(['init', '--scope', 'project', '--path', sandboxCwd]);
    logs.length = 0;
    await runCli(['init', '--scope', 'project', '--path', sandboxCwd]);

    expect(logs.join('\n')).toContain('Already exists (idempotent)');
  });

  it('`status` reads scope + node count off Turso via executeGet, not a sync unwrap (BL-380)', async () => {
    await runCli(['init', '--scope', 'project', '--path', sandboxCwd]);
    logs.length = 0;

    await runCli(['status', '--path', sandboxCwd]);

    const output = logs.join('\n');
    expect(output).toContain('project.db');
    expect(output).toContain('scope=project');
    expect(output).toContain('nodes=0');
  });

  it('`list` reads nodes off Turso via executeAll, not a sync unwrap (BL-380)', async () => {
    await runCli(['init', '--scope', 'project', '--path', sandboxCwd]);
    logs.length = 0;

    await runCli(['list', '--path', sandboxCwd]);

    expect(logs.join('\n')).toContain('project.db');
  });
});
