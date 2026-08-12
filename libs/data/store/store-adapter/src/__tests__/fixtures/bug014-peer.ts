/**
 * BUG-014 peer fixture — a REAL long-lived connection (the MCP-server shape
 * from the incident), spawned in a FRESH process with `--import tsx`.
 *
 * The triage's Probe D proved open-after-reconcile is safe under a live peer
 * using only a LEASE FILE; the BUG-014 fix demanded the stronger proof: a
 * genuinely long-lived engine connection surviving the reconcile. This
 * fixture opens the store with the real driver, registers a read, and holds —
 * exactly how the live MCP serve processes held the incident store. The test
 * truncates the WAL + reconciles the tshm under this peer, then signals it
 * (`.stop` marker) to run a final query and report whether it still serves.
 *
 * Prints `peer:<count>` to the ready marker once open, then
 * `peer-final:<count>` (or `peer-final:FAIL:<msg>`) after the stop signal.
 */
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { connect } from '@tursodatabase/database';

const dbPath = process.argv[2] ?? '';
const ready = process.argv[3] ?? '';

const db = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
const r = await db.all('SELECT COUNT(*) AS c FROM t');
writeFileSync(ready, `peer:${r[0].c}\n`);
// Hold until the test signals stop (creates the `.stop` marker).
while (true) {
  if (existsSync(ready + '.stop')) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
try {
  const r2 = await db.all('SELECT COUNT(*) AS c FROM t');
  writeFileSync(ready, `peer-final:${r2[0].c}\n`);
} catch (err) {
  writeFileSync(ready, `peer-final:FAIL:${err instanceof Error ? err.message : String(err).slice(0, 80)}\n`);
}
await db.close();
process.exit(0);
