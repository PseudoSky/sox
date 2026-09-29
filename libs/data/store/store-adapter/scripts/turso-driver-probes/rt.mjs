import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
if (!isMainThread) parentPort.on('message', (m) => parentPort.postMessage(m));
else { const t0=performance.now(); const w = new Worker(new URL(import.meta.url)); await new Promise(r=>w.once('online',r)); const boot=performance.now()-t0;
  const row = { id: 1, body: 'x'.repeat(200), v: new Uint8Array(1536) };
  for (const [label, payload] of [['small', { sql: 'SELECT 1', args: [1] }], ['row+1.5KB blob', { rows: [row] }], ['100 rows', { rows: Array.from({length:100},()=>row) }]]) {
    for (let i=0;i<200;i++){ w.postMessage(payload); await new Promise(r=>w.once('message',r)); }
    const K=2000, t=performance.now(); for (let i=0;i<K;i++){ w.postMessage(payload); await new Promise(r=>w.once('message',r)); }
    console.log(JSON.stringify({ label, rt_us: +((performance.now()-t)/K*1000).toFixed(1) })); }
  console.log(JSON.stringify({ worker_boot_ms: +boot.toFixed(1) })); await w.terminate(); }
