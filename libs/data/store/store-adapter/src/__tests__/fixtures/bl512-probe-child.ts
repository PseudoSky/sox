/**
 * BL-512 probe child — runs in a FRESH process (cold module cache) so the
 * better-sqlite3 interception below is authoritative.
 *
 * Patches `Module._load` to count/refuse 'better-sqlite3' BEFORE importing
 * the adapter, then runs the full writable connect→write→close ceremony
 * against `process.argv[2]`. Prints:
 *   BSQL3_LOADS=<n>          — times better-sqlite3 was required
 *   BSQL3_CONSTRUCTIONS=<n>  — times its Database constructor was invoked
 *   CONNECT_OK=<n>           — rows written (1 per successful cycle)
 *
 * On the pre-BL-512 code, `readApplicationId` ran pragma-first, so the
 * connect loaded AND constructed better-sqlite3 (the legacy opener that made
 * concurrent multiprocess-wal turso opens refuse). On the fixed code
 * (header-first) the whole ceremony must touch better-sqlite3 ZERO times.
 */
import Module from 'node:module';

const dbPath = process.argv[2] ?? '';

interface ModuleLoadHook {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
}

const moduleWithLoad = Module as unknown as ModuleLoadHook;
const origLoad = moduleWithLoad._load;
let betterSqlite3Loads = 0;
let constructions = 0;
moduleWithLoad._load = function patched(
  this: unknown,
  request: string,
  parent: NodeModule | null,
  isMain: boolean,
) {
  if (request === 'better-sqlite3') {
    betterSqlite3Loads++;
    return class Boom {
      constructor() {
        constructions++;
        throw new Error(
          'BL-512: better-sqlite3 must not be constructed during a multiprocess-wal connect',
        );
      }
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const { TursoAdapterImpl } = await import('../../turso-adapter.js');

let writes = 0;
try {
  const a = await TursoAdapterImpl.connect({ dbPath });
  await a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  await a.executeRun('INSERT INTO t (v) VALUES (?)', ['persist-me']);
  await a.close();
  writes = 1;
} catch (err) {
  console.error('CONNECT_ERR ' + (err instanceof Error ? err.message.split('\n')[0] : String(err)));
}

console.log(`BSQL3_LOADS=${betterSqlite3Loads}`);
console.log(`BSQL3_CONSTRUCTIONS=${constructions}`);
console.log(`CONNECT_OK=${writes}`);
process.exit(0);
