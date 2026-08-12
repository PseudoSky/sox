/**
 * store-lease — the pure-JS cross-process lease registry (adapter-race-fix plan §4,
 * BUG-007/008/009 for 0.5.7).
 *
 * One entry file per connection lives in `<dbPath>.sox-lease.d/`; quiescence =
 * "no OTHER live lease entry exists". This spec pins the contract with no driver
 * and no store:
 *   1. acquire creates the entry; storeQuiescence with the caller's own token
 *      excluded is quiescent — a process's own lease never counts against itself.
 *   2. Two acquires in the same process → NOT quiescent with exactly one live
 *      peer — the registry counts lease ENTRIES, not processes (the discriminator
 *      that makes the close()-TRUNCATE gate work for multiprocess stores).
 *   3. release() removes the entry and is idempotent (double release, ENOENT
 *      ignored) → quiescent again.
 *   4. A dead-pid entry (a just-exited child) is swept as a side effect of the
 *      probe: quiescent AND the entry file is gone.
 *   5. An absent lease dir → `{ quiescent: true, livePeers: [] }`, never throws
 *      (pinned so remote-URL/undecided callers can probe unconditionally).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireStoreLease, storeQuiescence, leaseDirPath } from '../store-lease.js';

/** Fresh scratch db path per test — no two tests share a lease dir. */
function tempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `store-lease-${label}-`));
  return join(dir, 'store.db');
}

describe('store-lease — cross-process lease registry (adapter-race-fix §4)', () => {
  it('acquire creates the entry; storeQuiescence excluding the own token is quiescent', async () => {
    const dbPath = tempDbPath('own');
    const lease = await acquireStoreLease(dbPath);

    // Exactly one entry file, named by the token, content `<pid>\n<openedAtIso>\n`.
    const dir = leaseDirPath(dbPath);
    expect(readdirSync(dir)).toEqual([lease.token]);

    const content = readFileSync(join(dir, lease.token), 'utf8');
    const [pidLine, openedAtLine] = content.split('\n');
    expect(pidLine).toBe(String(process.pid));
    expect(openedAtLine, 'entry must carry a parseable openedAtIso').toBeTruthy();
    expect(Number.isNaN(Date.parse(openedAtLine ?? ''))).toBe(false);

    // The caller's own lease must never count against itself.
    const q = storeQuiescence(dbPath, lease.token);
    expect(q.quiescent).toBe(true);
    expect(q.livePeers).toEqual([]);

    await lease.release();
  });

  it('two acquires → not quiescent with exactly one live peer — counts entries, not processes', async () => {
    const dbPath = tempDbPath('two');
    const a = await acquireStoreLease(dbPath);
    const b = await acquireStoreLease(dbPath);

    // Same process, two entries: excluding A's own token leaves B as the one live peer.
    const qExcludingA = storeQuiescence(dbPath, a.token);
    expect(qExcludingA.quiescent).toBe(false);
    expect(qExcludingA.livePeers).toEqual([{ token: b.token, pid: process.pid }]);

    // Without an exclusion both entries count.
    const qAll = storeQuiescence(dbPath);
    expect(qAll.quiescent).toBe(false);
    expect(qAll.livePeers).toHaveLength(2);

    await a.release();
    await b.release();
  });

  it('release removes the entry, is idempotent (ENOENT ignored), and quiescence returns', async () => {
    const dbPath = tempDbPath('release');
    const a = await acquireStoreLease(dbPath);
    const b = await acquireStoreLease(dbPath);

    await b.release();
    expect(existsSync(join(leaseDirPath(dbPath), b.token))).toBe(false);

    const q1 = storeQuiescence(dbPath, a.token);
    expect(q1.quiescent).toBe(true);
    expect(q1.livePeers).toEqual([]);

    // Double release must not throw — the unlink is ENOENT-ignored.
    await expect(b.release()).resolves.toBeUndefined();

    await a.release();
  });

  it('a dead-pid entry is swept: quiescent AND the entry file is gone', async () => {
    const dbPath = tempDbPath('deadpid');
    const lease = await acquireStoreLease(dbPath);

    // A child that exits immediately — its pid is dead by the time spawnSync returns.
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    const deadPid = child.pid;
    if (deadPid === undefined) {
      throw new Error('spawnSync returned no pid');
    }

    const deadToken = 'dead-pid-entry';
    const deadEntryPath = join(leaseDirPath(dbPath), deadToken);
    writeFileSync(deadEntryPath, `${deadPid}\n${new Date().toISOString()}\n`, { flag: 'wx' });

    const q = storeQuiescence(dbPath, lease.token);
    expect(q.quiescent).toBe(true);
    expect(q.livePeers).toEqual([]);
    expect(existsSync(deadEntryPath), 'the dead entry must be swept as a side effect').toBe(false);

    await lease.release();
  });

  it('an absent lease dir is quiescent and never throws', () => {
    const dbPath = tempDbPath('absent');
    expect(existsSync(leaseDirPath(dbPath))).toBe(false);

    let q: { quiescent: boolean; livePeers: { token: string; pid: number }[] };
    expect(() => {
      q = storeQuiescence(dbPath);
    }).not.toThrow();
    expect(q!).toEqual({ quiescent: true, livePeers: [] });
  });
});
