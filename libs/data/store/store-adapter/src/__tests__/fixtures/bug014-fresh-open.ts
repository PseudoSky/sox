/**
 * BUG-014 fresh-open probe fixture — a one-shot FRESH-process open against a
 * store (the raw-driver equivalent of a fresh CLI one-shot open). Used to
 * prove the fixture's failing state is real (pre-reconcile opens must
 * short-read, exactly like the incident's 5/5) and that post-reconcile opens
 * succeed.
 *
 * Writes `ok` or `fail:<message>` to the marker file and exits 0/1.
 */
import { writeFileSync } from 'node:fs';
import { connect } from '@tursodatabase/database';

const dbPath = process.argv[2] ?? '';
const marker = process.argv[3] ?? '';

try {
  const db = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
  writeFileSync(marker, 'ok\n');
  await db.close();
  process.exit(0);
} catch (err) {
  writeFileSync(marker, `fail:${err instanceof Error ? err.message.slice(0, 200) : String(err)}\n`);
  process.exit(1);
}
