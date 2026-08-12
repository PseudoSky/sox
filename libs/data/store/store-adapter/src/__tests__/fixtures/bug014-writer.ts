/**
 * BUG-014 writer fixture — reproduces the incident's failing tshm state with
 * the REAL engine, in a FRESH process (spawned with `--import tsx`).
 *
 * The mechanism behind the BUG-014 deadlock (proven by triage probes
 * 2026-08-12): a `-tshm` that SURVIVES a WAL truncation while carrying real
 * coordination state — a nonzero frame extent, a checkpoint/backfill history,
 * populated frame-index blocks — makes every fresh open short-read against the
 * now-0-byte WAL. This fixture builds exactly that state:
 *
 *   1. opens the store with multiprocess_wal (creates/negotiates the -tshm),
 *   2. writes 600 rows (populates the frame-index blocks),
 *   3. PASSIVE-checkpoints (writes the durable backfill-proof / reader-slot
 *      region — the discriminator bytes 76..112), then
 *   4. writes 300 more rows (repopulates the index over the checkpoint), and
 *   5. HOLDS the connection until the test SIGKILLs it — the crash (no clean
 *      close) is what leaves the tshm's state frozen on disk while the test
 *      truncates the WAL out from under it.
 *
 * The test then fs-truncates `<db>-wal` to 0 (the "dead truncator" from the
 * incident) and asserts the fresh open short-reads pre-reconcile and succeeds
 * post-reconcile. Without the checkpoint step the tshm self-heals on the next
 * open (verified empirically — the backfill-proof region is the discriminator
 * the engine trusts); with it, the incident shape reproduces deterministically.
 *
 * Prints `READY` via the marker file once the state is written.
 */
import { writeFileSync } from 'node:fs';
import { connect } from '@tursodatabase/database';

const dbPath = process.argv[2] ?? '';
const ready = process.argv[3] ?? '';

const db = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
await db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
for (let i = 0; i < 600; i++) {
  await db.run('INSERT INTO t (v) VALUES (?)', 'v'.repeat(400) + i);
}
await db.all('PRAGMA wal_checkpoint(PASSIVE)');
for (let i = 0; i < 300; i++) {
  await db.run('INSERT INTO t (v) VALUES (?)', 'v'.repeat(400) + 'x' + i);
}
writeFileSync(ready, 'ready\n');
// Hold the connection open until the test SIGKILLs us — the crash is what
// freezes the tshm state on disk.
setInterval(() => {}, 1000);
