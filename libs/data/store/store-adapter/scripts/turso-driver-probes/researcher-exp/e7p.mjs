import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { connect } from '@tursodatabase/database';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
const f = new URL('./e5.db', import.meta.url).pathname;
const MODE = process.argv[2] || 'insert';
if (isMainThread) {
  for (const s of ['', '-wal', '-shm', '-tshm']) try { fs.rmSync(f+s) } catch {}
  const db = await connect(f, { experimental: ['index_method','multiprocess_wal'], timeout: 5000 });
  await db.exec('PRAGMA journal_mode=WAL');
  await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
  await db.exec('INSERT INTO t(v) SELECT hex(randomblob(32)) FROM generate_series(1,1000)');
  const w = new Worker(new URL(import.meta.url), { workerData: { f, MODE }, argv: [MODE] });
  await new Promise(r => w.once('message', r));
  const ins = db.prepare('INSERT INTO t(v) VALUES (?)');
  let maxStep = 0, n = 0, maxGap = 0, last = performance.now(), fin = false, errs = 0;
  const iv = setInterval(() => { const x = performance.now(); maxGap = Math.max(maxGap, x-last); last = x; }, 1);
  w.once('message', m => { fin = m; });
  while (!fin) {
    {
    const s0 = performance.now(); try { await ins.run('m'+n); } catch (e) { errs++; } maxStep = Math.max(maxStep, performance.now()-s0); }
    n++; await new Promise(r => setImmediate(r));
  }
  clearInterval(iv);
  console.log(`[${MODE}] worker: ${JSON.stringify(fin)} | main: ${n} point reads, longest main stepSync=${maxStep.toFixed(1)}ms, max timer gap=${maxGap.toFixed(1)}ms, errors=${errs}`);
  await w.terminate();
} else {
  const db = await connect(workerData.f, { experimental: ['index_method','multiprocess_wal'], timeout: 5000 });
  if (workerData.MODE === 'fts') { try { await db.exec("CREATE TABLE ft(id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX ftidx ON ft USING fts (v)"); } catch (e) { parentPort.postMessage('ready'); parentPort.postMessage({ err: 'fts5 create: ' + e.message }); throw e; } }
  parentPort.postMessage('ready');
  await new Promise(r => setTimeout(r, 50));
  const t0 = performance.now(); let err;
  try {
    if (workerData.MODE === 'fts') await db.exec("INSERT INTO ft(v) SELECT hex(randomblob(40)) || ' hello world ' || value FROM generate_series(1,100000)");
    else await db.exec("INSERT INTO t(v) SELECT hex(randomblob(32)) FROM generate_series(1,400000)");
  } catch (e) { err = e.message; }
  parentPort.postMessage({ writeMs: Math.round(performance.now()-t0), err });
}
