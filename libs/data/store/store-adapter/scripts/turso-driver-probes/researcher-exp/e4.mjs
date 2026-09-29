import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { connect } from '@tursodatabase/database';
import { execSync } from 'node:child_process';
const f = new URL('./e2.db', import.meta.url).pathname;
if (isMainThread) {
  const db = await connect(f); await db.prepare('SELECT 1').get();
  const cnt = () => execSync(`lsof -p ${process.pid} | grep -c 'e2.db' || true`).toString().trim();
  console.log('fds on e2.db* with main conn only:', cnt());
  const w = new Worker(new URL(import.meta.url)); await new Promise(r => w.once('message', r));
  console.log('fds after worker opened same file:', cnt());
  console.log(execSync(`lsof -p ${process.pid} | grep 'e2.db'`).toString());
  await w.terminate();
} else { const db = await connect(f); await db.prepare('SELECT 1').get(); parentPort.postMessage(1); await new Promise(()=>{}); }
