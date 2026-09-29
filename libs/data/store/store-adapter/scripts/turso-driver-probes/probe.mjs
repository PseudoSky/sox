import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
const DRV = '/Users/nix/dev/ai/sox-ecosystem/node_modules/.pnpm/@tursodatabase+database@0.7.1/node_modules/@tursodatabase/database/dist/promise.js';
const { connect } = await import(DRV);
const OPTS = { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] };
const path = workerData?.path ?? process.argv[2];
if (isMainThread) {
  // main opens first, creates schema with FTS
  const db = await connect(path, OPTS);
  await db.exec("PRAGMA journal_mode=WAL");
  await db.exec("CREATE TABLE IF NOT EXISTS n(id INTEGER PRIMARY KEY, body TEXT)");
  await db.exec("CREATE INDEX IF NOT EXISTS n_fts ON n USING fts (body)");
  // probe (b): count io() yields during FTS writes on main
  let ioCalls = 0; const origIo = db.io.bind(db); db.io = async () => { ioCalls++; return origIo(); };
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) await db.run("INSERT INTO n(body) VALUES (?)", ["alpha beta gamma " + i + " ".repeat(50) + "delta".repeat(i % 7)]);
  const t1 = performance.now();
  console.log(JSON.stringify({ probe: 'b', writes: 200, ioCalls, ms: Math.round(t1 - t0) }));
  // probe (a): worker opens same file concurrently and writes; main keeps writing + measures loop lag
  const w = new Worker(new URL(import.meta.url), { workerData: { path } });
  let maxLag = 0, last = performance.now();
  const tick = setInterval(() => { const n = performance.now(); maxLag = Math.max(maxLag, n - last - 5); last = n; }, 5);
  const done = new Promise((res, rej) => { w.on('message', res); w.on('error', rej); });
  for (let i = 0; i < 100; i++) await db.run("INSERT INTO n(body) VALUES (?)", ["main " + i]);
  const res = await done; clearInterval(tick);
  const c = await db.get("SELECT COUNT(*) AS c FROM n");
  const blob = await db.get("SELECT x'00ff' AS b");
  console.log(JSON.stringify({ probe: 'a', worker: res, total: c.c, mainBlobIsBuffer: Buffer.isBuffer(blob.b) }));
  await db.close(); await w.terminate();
} else {
  const db = await connect(path, OPTS);
  let ok = 0; const t0 = performance.now();
  for (let i = 0; i < 100; i++) { await db.run("INSERT INTO n(body) VALUES (?)", ["worker " + i]); ok++; }
  const r = await db.get("SELECT COUNT(*) AS c FROM n WHERE body MATCH 'worker'").catch(e => ({ err: e.message }));
  const blob = await db.get("SELECT x'00ff' AS b");
  const buf = Buffer.from([1,2,3]);
  await db.exec("CREATE TABLE IF NOT EXISTS bl(b BLOB)");
  await db.run("INSERT INTO bl VALUES (?)", [new Uint8Array([9,8,7])]).catch(e=>{ok=-1});
  const back = await db.get("SELECT b FROM bl");
  // what does structured clone do to a row with a Buffer, and to a driver error?
  let errShape; try { await db.run("INSERT INTO nope VALUES (1)"); } catch (e) { errShape = { name: e.name, code: e.code, msg: e.message, keys: Object.keys(e) }; }
  await db.close();
  parentPort.postMessage({ ok, ms: Math.round(performance.now() - t0), fts: r, blobType: Object.prototype.toString.call(blob.b), u8ArgRoundTrip: back && Object.prototype.toString.call(back.b), errShape, clonedErr: (() => { try { const e = new Error('x'); e.code='GenericFailure'; return structuredClone(e); } catch (x) { return String(x); } })() });
}
