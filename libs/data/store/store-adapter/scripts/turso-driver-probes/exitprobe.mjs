import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const DRV = '/Users/nix/dev/ai/sox-ecosystem/node_modules/.pnpm/@tursodatabase+database@0.7.1/node_modules/@tursodatabase/database/dist/promise.js';
if (!isMainThread) {
  const { connect } = await import(DRV);
  const db = await connect(workerData.path, { timeout: 5000, experimental: ['index_method','multiprocess_wal'] });
  await db.exec("CREATE TABLE t(x)"); await db.exec("CREATE TABLE t2(x)"); await db.exec("INSERT INTO t VALUES (randomblob(16))");
  for (let i=0;i<22;i++) await db.exec("INSERT INTO t SELECT randomblob(16) FROM t");
  parentPort.postMessage('parking');
  const s0=Date.now(); await db.exec("INSERT INTO t2 SELECT x FROM t"); await db.exec("INSERT INTO t2 SELECT x FROM t"); await db.exec("INSERT INTO t2 SELECT x FROM t");
  parentPort.postMessage('done after '+(Date.now()-s0)+'ms');
  parentPort.postMessage('done');
} else {
  const mode = process.argv[2]; const t0 = Date.now();
  const w = new Worker(new URL(import.meta.url), { workerData: { path: process.argv[3] } });
  w.on('message', (m) => { if (m === 'parking') setTimeout(() => {
    console.log(JSON.stringify({ mode, event: 'exit-requested', at_ms: Date.now() - t0 }));
    if (mode === 'exit') process.exit(0);
    if (mode === 'terminate') { const t1 = Date.now(); w.terminate().then(() => console.log(JSON.stringify({ mode, terminate_resolved_after_ms: Date.now() - t1 }))); }
    if (mode === 'sigterm') process.kill(process.pid, 'SIGTERM');
  }, 300); else console.log(JSON.stringify({ mode, worker: m, at_ms: Date.now() - t0 })); });
  process.on('SIGTERM', () => { console.log(JSON.stringify({ mode, event: 'sigterm-handler-ran', at_ms: Date.now() - t0 })); process.exit(0); });
  process.on('exit', () => { console.error(JSON.stringify({ mode, event: 'process-exit-hook', at_ms: Date.now() - t0 })); });
}
