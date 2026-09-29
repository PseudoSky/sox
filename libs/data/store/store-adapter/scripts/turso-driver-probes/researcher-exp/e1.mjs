import { connect } from '@tursodatabase/database';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
const f = './e1.db'; for (const s of ['', '-wal', '-shm', '-tshm']) try { fs.rmSync(f+s) } catch {}
const db = await connect(f);
await db.exec('PRAGMA journal_mode=WAL');
await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
let ticks = 0; const iv = setInterval(() => ticks++, 1);
// A: one big statement (recursive CTE insert) = many steps, all in one statement
let t0 = performance.now();
await db.exec(`INSERT INTO t(v) SELECT hex(randomblob(32)) FROM generate_series(1,400000)`);
let dA = performance.now() - t0;
console.log(`A insert 400k rows in one stmt: ${dA.toFixed(0)}ms, 1ms-interval ticks during=${ticks}, evloop max delay=${(h.max/1e6).toFixed(0)}ms`);
h.reset(); ticks = 0;
// B: all() over many rows -> many STEP_ROW steps; does the loop yield to macrotasks?
t0 = performance.now();
const rows = await db.prepare('SELECT v FROM t').all();
let dB = performance.now() - t0;
console.log(`B all() ${rows.length} rows: ${dB.toFixed(0)}ms ticks=${ticks} max delay=${(h.max/1e6).toFixed(0)}ms`);
h.reset(); ticks = 0;
// C: single long step: aggregate returning one row
const nat = db.db; // native
const st = nat.prepare('SELECT count(*), sum(length(v)) FROM t a WHERE a.id % 7 = 3 AND v LIKE \'%ab%\'');
let maxStep = 0, n = 0; while (true) { const s0 = performance.now(); const r = st.stepSync(); const d = performance.now() - s0; if (d > maxStep) maxStep = d; n++; if (r === 2) break; }
console.log(`C aggregate: ${n} native steps, longest single stepSync=${maxStep.toFixed(1)}ms`);
// D: count step result codes for the big insert-style statement at native level
await db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, v TEXT)');
const st2 = nat.prepare(`INSERT INTO u(v) SELECT hex(randomblob(32)) FROM generate_series(1,200000)`);
const codes = {}; maxStep = 0; t0 = performance.now();
while (true) { const s0 = performance.now(); const r = st2.stepSync(); const d = performance.now()-s0; if (d>maxStep) maxStep=d; codes[r]=(codes[r]||0)+1; if (r===2) break; }
console.log(`D native insert 200k: total ${(performance.now()-t0).toFixed(0)}ms, step codes ${JSON.stringify(codes)}, longest step ${maxStep.toFixed(1)}ms`);
clearInterval(iv); await db.close();
