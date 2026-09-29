import { Worker, isMainThread, parentPort, MessageChannel } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
if (!isMainThread) {
  parentPort.on('message', (m) => { if (m && m.port) { m.port.on('message', x => m.port.postMessage(x)); return; } parentPort.postMessage(m); });
} else {
  const w = new Worker(new URL(import.meta.url));
  const row = i => ({ id: i, name: 'node-' + i, content: 'x'.repeat(200), score: Math.random(), tags: 'a,b,c' });
  const payloads = { 'small {op,id,sql}': { op: 'get', id: 1, sql: 'SELECT * FROM t WHERE id=?', args: [42] },
    '10 rows (~250B each)': Array.from({length:10}, (_, i) => row(i)),
    '1k rows': Array.from({length:1000}, (_, i) => row(i)),
    '10k rows': Array.from({length:10000}, (_, i) => row(i)) };
  async function bench(port, label, p, n) {
    const rt = () => new Promise(r => { port.once('message', r); port.postMessage(p); });
    for (let i = 0; i < Math.min(n, 200); i++) await rt();
    const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); await rt(); ts.push(performance.now() - t); }
    ts.sort((a,b)=>a-b); const q = k => (ts[Math.floor(k*(ts.length-1))]*1000).toFixed(0);
    console.log(`${label.padEnd(12)} ${Object.keys(payloads).find(k=>payloads[k]===p).padEnd(22)} p50=${q(.5)}us p99=${q(.99)}us`);
  }
  for (const p of Object.values(payloads)) await bench(w, 'parentPort', p, p.length >= 10000 ? 50 : 2000);
  const { port1, port2 } = new MessageChannel(); w.postMessage({ port: port2 }, [port2]);
  for (const p of Object.values(payloads)) await bench(port1, 'MsgChannel', p, p.length >= 10000 ? 50 : 2000);
  // SAB+Atomics sync RTT
  await w.terminate();
  const sab = new SharedArrayBuffer(8); const a = new Int32Array(sab);
  const w2 = new Worker(`const { workerData } = require('node:worker_threads'); const a = new Int32Array(workerData); for(;;){ Atomics.wait(a,0,0); if (a[0]===2) break; a[0]=0; Atomics.store(a,1,1); Atomics.notify(a,1); }`, { eval: true, workerData: sab });
  await new Promise(r => setTimeout(r, 100));
  const ts = []; for (let i = 0; i < 20000; i++) { const t = performance.now(); Atomics.store(a,1,0); Atomics.store(a,0,1); Atomics.notify(a,0); Atomics.wait(a,1,0); ts.push(performance.now()-t); }
  ts.sort((x,y)=>x-y); console.log(`SAB+Atomics.wait ping (no payload): p50=${(ts[10000]*1000).toFixed(1)}us p99=${(ts[19800]*1000).toFixed(1)}us`);
  a[0]=2; Atomics.notify(a,0); await w2.terminate();
}
