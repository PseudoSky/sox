import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { connect } from '@tursodatabase/database';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
const f = new URL('./e2.db', import.meta.url).pathname;
if (isMainThread) {
  for (const s of ['', '-wal', '-shm', '-tshm']) try { fs.rmSync(f+s) } catch {}
  const db = await connect(f, { timeout: 5000 });
  await db.exec('PRAGMA journal_mode=WAL');
  await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, who TEXT, v TEXT)');
  const w = new Worker(new URL(import.meta.url), { workerData: { f } });
  let ticks = 0, maxGap = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 1);
  const errs = []; let mainWrites = 0;
  const started = new Promise(r => w.once('message', r));
  await started;
  const t0 = performance.now();
  const done = new Promise(r => w.once('message', r));
  let finished = false; done.then(() => finished = true);
  while (!finished) {
    try { await db.prepare('INSERT INTO t(who,v) VALUES (?,?)').run('main', 'x'); mainWrites++; }
    catch (e) { errs.push(e.message); }
    await new Promise(r => setTimeout(r, 5));
  }
  const res = await done;
  clearInterval(iv);
  console.log(`worker: ${JSON.stringify(res)}`);
  console.log(`main during worker (${(performance.now()-t0).toFixed(0)}ms): ticks=${ticks}, max timer gap=${maxGap.toFixed(1)}ms, mainWrites=${mainWrites}, errors=${errs.length} ${[...new Set(errs)].slice(0,3).join(' | ')}`);
  const c = await db.prepare('SELECT who, count(*) n FROM t GROUP BY who').all();
  const ic = await db.prepare('PRAGMA integrity_check').all();
  console.log('counts seen by main:', JSON.stringify(c), 'integrity:', JSON.stringify(ic));
  // same-thread second connection
  const db2 = await connect(f);
  console.log('second main-thread conn sees:', JSON.stringify(await db2.prepare('SELECT count(*) n FROM t').get()));
  await w.terminate();
} else {
  const db = await connect(workerData.f);
  parentPort.postMessage('ready');
  const errs = []; let ok = 0; const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    try { await db.exec(`INSERT INTO t(who,v) SELECT 'worker', hex(randomblob(32)) FROM generate_series(1,50000)`); ok++; }
    catch (e) { errs.push(e.message); }
  }
  const seen = await db.prepare("SELECT count(*) n FROM t WHERE who='main'").get();
  parentPort.postMessage({ ok, errs: [...new Set(errs)], ms: Math.round(performance.now()-t0), workerSeesMainRows: seen.n });
}
