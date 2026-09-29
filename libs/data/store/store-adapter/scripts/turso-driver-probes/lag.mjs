import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
const DRV = '/Users/nix/dev/ai/sox-ecosystem/node_modules/.pnpm/@tursodatabase+database@0.7.1/node_modules/@tursodatabase/database/dist/promise.js';
const OPTS = { timeout: 5000, experimental: ['index_method', 'multiprocess_wal'] };
const N = 300;
async function work(path) {
  const { connect } = await import(DRV);
  const db = await connect(path, OPTS);
  await db.exec("CREATE TABLE IF NOT EXISTS n(id INTEGER PRIMARY KEY, body TEXT)");
  await db.exec("CREATE INDEX IF NOT EXISTS n_fts ON n USING fts (body)");
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await db.run("INSERT INTO n(body) VALUES (?)", ["alpha beta gamma " + i + " lorem ipsum ".repeat(20)]);
  const ms = performance.now() - t0; await db.close(); return ms;
}
if (!isMainThread) { parentPort.postMessage(await work(workerData.path)); }
else {
  const mode = process.argv[2]; const path = process.argv[3];
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable(); let ticks=0, gap=0, lt=performance.now(); const iv=setInterval(()=>{const n=performance.now(); gap=Math.max(gap,n-lt); lt=n; ticks++;},10);
  // RPC round-trip cost: echo worker
  let ms;
  if (mode === 'inline') ms = await work(path);
  else { const w = new Worker(new URL(import.meta.url), { workerData: { path } }); ms = await new Promise((r, j) => { w.on('message', r); w.on('error', j); }); await w.terminate(); }
  h.disable(); clearInterval(iv); gap=Math.max(gap,performance.now()-lt);
  console.log(JSON.stringify({ mode, writes: N, total_ms: Math.round(ms), per_write_ms: +(ms / N).toFixed(2), timer_ticks: ticks, longest_gap_ms: Math.round(gap), loop_delay_p99_ms: +(h.percentile(99) / 1e6).toFixed(1) }));
}
