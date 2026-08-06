/**
 * (BL-338) The "restart" — reopens a store a SIGKILLed writer left behind
 * through the ordinary production open path, then reports everything an
 * operator would need WITHOUT touching the database file by hand:
 *
 * - every row id actually present (to prove zero lost committed writes —
 *   sequential ids with no gap is a complete proof for a single sequential
 *   writer: any surviving id N implies 1..N-1 also survived),
 * - the durable integrity verdict `TursoAdapterImpl.connect()` itself just
 *   persisted into `_adapter_meta` (`readIntegrityResult`), which is exactly
 *   what a status surface (`memory_ping`/`memory_stats` equivalent) reads —
 *   this is the "visible in status without manual investigation" leg.
 *
 * Runs in its own process (matching every other fixture in this directory)
 * so that whatever `TursoAdapterImpl.connect()` decides to do — including any
 * repair DDL — happens exactly the way a real restart would, and so the
 * parent can inspect this process's stderr for the same JSON log lines an
 * operator would see (`emitIntegrityReport`'s default stderr sink).
 *
 * Usage: `node --import tsx bl338-restart.ts <dbPath>`
 */
import { TursoAdapterImpl } from '../../turso-adapter.js';
import { readIntegrityResult } from '../../integrity.js';

const [, , dbPath] = process.argv;

async function main(): Promise<void> {
  if (!dbPath) throw new Error('usage: bl338-restart <dbPath>');

  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    const rows = await adapter.executeAll<{ id: number }>('SELECT id FROM crash_node ORDER BY id');
    const ids = rows.rows.map((r) => Number(r.id));
    const maxId = ids.length > 0 ? (ids[ids.length - 1] as number) : 0;

    const present = new Set(ids);
    const missingIds: number[] = [];
    for (let i = 1; i <= maxId; i++) {
      if (!present.has(i)) missingIds.push(i);
    }

    const meta = await adapter.executeGet<{ meta: string | null }>(
      'SELECT meta FROM crash_node WHERE id = 10',
    );

    const persisted = await readIntegrityResult(adapter);

    const out = {
      rowCount: ids.length,
      maxId,
      missingIds: missingIds.slice(0, 20),
      missingCount: missingIds.length,
      metaAtDamagedId: meta?.meta ?? null,
      persisted: persisted
        ? {
            runAtMs: persisted.runAtMs,
            verifyOk: persisted.result.verify.ok,
            verifyDepth: persisted.result.verify.depth,
            damaged: persisted.result.verify.damaged.map((f) => ({
              probe: f.probe,
              object: f.object,
              detail: f.detail,
            })),
            repairRan: persisted.result.repair !== null,
            repairOk: persisted.result.repair?.ok ?? null,
            repairActions:
              persisted.result.repair?.actions.map((a) => ({
                probe: a.probe,
                object: a.object,
                action: a.action,
                ok: a.ok,
              })) ?? [],
            reverifyOk: persisted.result.repair?.verified?.ok ?? null,
            reverifyDamaged:
              persisted.result.repair?.verified?.damaged.map((f) => `${f.probe}:${f.object}`) ?? null,
          }
        : null,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
