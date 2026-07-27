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
    const db = adapter.unwrap() as any;
    initScope(db, 'user', 'test-scope-id');
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`,
    ).run(uid, 'episode', content, new Date().toISOString());
    db.close();
    return dbPath;
  }

  it('`list` finds ~/.memory/memory.db with no --base-path (regression for BL-95)', async () => {
    const memDir = path.join(sandboxHome, '.memory');
    await seedBareStore(memDir, 'memory', 'n1', 'hello world');

    runCli(['list']);

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

    runCli(['list']);
    const listOutput = logs.join('\n');
    logs.length = 0;

    runCli(['status']);
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

      runCli(['list', '--base-path', explicitBase]);

      const output = logs.join('\n');
      expect(output).toContain('project.db');
      expect(output).toContain('n3');
    } finally {
      fs.rmSync(explicitBase, { recursive: true, force: true });
    }
  });

  it('`list` reports "No memory stores found." (parity with `status`) when nothing exists', () => {
    runCli(['list']);
    expect(logs.join('\n')).toContain('No memory stores found.');
  });
});
