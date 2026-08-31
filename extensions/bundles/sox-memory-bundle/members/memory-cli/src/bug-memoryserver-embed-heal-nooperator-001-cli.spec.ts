/**
 * bug-memoryserver-embed-heal-nooperator-001-cli.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the `pipeline` CLI verbs.
 *
 * RED→GREEN (BL-225): before this item there was NO operator surface for the
 * embed/enrich pipeline beyond `reheal_stale` — a stuck backlog could only be
 * drained by an agent reading memory_ping and guessing. The `pipeline
 * status|drain|reset|resume` verbs are the lifetime operational control plane:
 * `status` prints the honest verdict + ledger + alarm, `drain --dry-run`
 * previews the backlog without mutating, `drain` clears it, `reset` clears the
 * ledger/alarm/poison, and `resume` re-arms escalation. All idempotent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '@adhd/sox-memory-core';
import { runCli } from './index.js';

const cleanups: Array<() => void> = [];

let savedAdapter: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];

beforeEach(() => {
  process.env.STORE_ADAPTER = 'sqlite';
  savedAdapter = process.env['STORE_ADAPTER'];
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  if (savedAdapter === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = savedAdapter;
  for (const c of cleanups.splice(0)) c();
});

/** Seed a store with one live episode missing its vec row (backlog > 0). */
async function seedStore(name: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cli-pipeline-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, `${name}.db`);
  const adapter = await openDb(dbPath);
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [`cli-orphan-${name}`, `pipeline cli orphan for ${name}`, `hash-${name}`],
  );
  await adapter.close();
  return dbPath;
}

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — `pipeline` CLI verbs', () => {
  it('`pipeline status` prints the honest verdict + ledger + alarm', async () => {
    const dbPath = await seedStore('status');
    await runCli(['pipeline', 'status', '--db', dbPath]);

    const out = logs.join('\n');
    expect(out).toContain('verdict.state:');
    expect(out).toContain('stalled'); // backlog > 0, no successful pass yet
    expect(out).toContain('poisoned_rows:');
    expect(out).toContain('alarm:');
  });

  it('`pipeline drain --dry-run` previews the backlog without mutating; real `drain` clears it', async () => {
    const dbPath = await seedStore('drain');
    await runCli(['pipeline', 'drain', '--db', dbPath, '--dry-run']);
    expect(logs.join('\n')).toContain('DRY-RUN');
    expect(logs.join('\n')).toContain('remaining=1');

    logs.length = 0;
    await runCli(['pipeline', 'drain', '--db', dbPath]);
    const out = logs.join('\n');
    expect(out).toContain('complete');
    expect(out).toContain('remaining=0');
    expect(out).toContain('fully_drained=true');

    // Idempotent second drain.
    logs.length = 0;
    await runCli(['pipeline', 'drain', '--db', dbPath]);
    expect(logs.join('\n')).toContain('remaining=0');
  });

  it('`pipeline reset` clears ledger/alarm/poison; `pipeline resume` is idempotent (healthy → still resumed)', async () => {
    const dbPath = await seedStore('reset');
    await runCli(['pipeline', 'reset', '--db', dbPath]);
    expect(logs.join('\n')).toContain('ledger=true');
    expect(logs.join('\n')).toContain('alarm=true');

    logs.length = 0;
    await runCli(['pipeline', 'resume', '--db', dbPath]);
    expect(logs.join('\n')).toContain('resumed');
  });
});
