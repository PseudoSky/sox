/**
 * 6fd60658 child: a dead-holder lock that CANNOT be swept (the lease dir is
 * read-only, so unlink fails with EACCES while `wx` keeps reporting EEXIST).
 * The acquire must still return within its bound. Run in a child process
 * because a regression here is a synchronous spin that would freeze the test
 * worker itself. Prints the acquire result as JSON.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquireColdOpenLock, coldOpenLockPath } from '../../cold-open-lock.js';
import { leaseDirPath } from '../../store-lease.js';

const [, , dbPath, deadPid] = process.argv;

async function main(): Promise<void> {
  if (!dbPath || !deadPid) throw new Error('usage: <dbPath> <deadPid>');
  const dir = leaseDirPath(dbPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(coldOpenLockPath(dbPath), `${deadPid}\n${new Date().toISOString()}\nnonce\n`);
  chmodSync(dir, 0o555);
  try {
    const lock = await acquireColdOpenLock(dbPath, { maxWaitMs: 500 });
    process.stdout.write(JSON.stringify({ acquired: lock.acquired, waitedMs: lock.waitedMs }) + '\n');
  } finally {
    chmodSync(dir, 0o755);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) + '\n');
    process.exit(1);
  },
);
