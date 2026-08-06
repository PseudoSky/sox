/**
 * (BL-338) The "server" under sustained write load — the process the crash
 * test SIGKILLs.
 *
 * This is deliberately the ordinary production open path
 * (`TursoAdapterImpl.connect()`), not a hand-rolled driver call — the claim
 * under test ("committed writes survive a hard kill; damage is auto-repaired
 * and visible on the next open") is a claim about what a real consumer gets,
 * and only holds if the writer used the same path a real consumer uses.
 *
 * Behaviour:
 * - Creates `crash_node(id, payload, meta)` and inserts rows 1..N,
 *   sequentially, awaiting each `executeRun` before moving on — so "this id
 *   was printed" means "this INSERT's promise resolved", i.e. Turso itself
 *   says the write committed.
 * - After every successful insert, writes the id to stdout via
 *   `fs.writeSync(1, …)` — bypassing Node's stream buffering — so the parent's
 *   "how far did it get" signal is never stale relative to what is actually on
 *   disk.
 * - At `DAMAGE_AT_ID`, deliberately blanks the JSON `meta` column of an
 *   already-committed row via an ordinary `UPDATE` through the SAME adapter.
 *   This is genuine store content by the time the process is killed — not
 *   damage injected out-of-band afterward — and it is exactly the
 *   `json_column_valid` (BL-342) repairable shape: a blank string where the
 *   column is otherwise JSON. It exists so the restart's auto-repair
 *   assertion is proven non-vacuous: without the repair path this finding
 *   would still be there on the next open.
 * - No signal handlers are installed. The parent sends a real, external
 *   SIGKILL; this process never kills itself and never gets a chance to run
 *   `close()`, `markCleanShutdown()`, or clear the BL-361 open marker — which
 *   is exactly the "previous session did not end cleanly" population BL-338
 *   is about.
 *
 * Usage: `node --import tsx bl338-writer.ts <dbPath>`
 */
import { writeSync } from 'node:fs';
import { TursoAdapterImpl } from '../../turso-adapter.js';

const [, , dbPath] = process.argv;

/** Row id whose `meta` gets blanked mid-stream. Small and fixed so the parent
 *  never has to race to reach it before killing — by the time the parent's
 *  kill threshold (hundreds of rows) is reached, this write is long committed. */
const DAMAGE_AT_ID = 10;

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bl338-writer <dbPath>');

  const adapter = await TursoAdapterImpl.connect({ dbPath });
  await adapter.exec(
    'CREATE TABLE IF NOT EXISTS crash_node (id INTEGER PRIMARY KEY, payload TEXT, meta TEXT)',
  );

  const payload = 'x'.repeat(200);
  for (let i = 1; i <= 2_000_000; i++) {
    await adapter.executeRun('INSERT INTO crash_node (id, payload, meta) VALUES (?, ?, ?)', [
      i,
      payload,
      '{}',
    ]);
    if (i === DAMAGE_AT_ID) {
      await adapter.executeRun('UPDATE crash_node SET meta = ? WHERE id = ?', ['', DAMAGE_AT_ID]);
    }
    writeSync(1, `${i}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
