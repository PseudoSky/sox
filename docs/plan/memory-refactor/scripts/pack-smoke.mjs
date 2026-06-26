#!/usr/bin/env node
/**
 * pack-smoke.mjs — standalone-consumption acceptance for the PUBLIC data/* packages.
 *
 * The affirmative proof of the memory-refactor thesis: each data/* package is reusable by
 * a 3rd party via plain `npm i`. This is the explicit guard for the BL-87 failure class —
 * a package that is boundary-clean (passes the eslint depConstraints + the dist-grep
 * checks in audit_memrefactor.py) but BROKEN on install because a runtime dep was declared
 * only in-workspace (exactly how the live memory-server shipped without `fastembed`).
 *
 * For each public package:
 *   1. `npm pack`  → a .tgz with ONLY what `files`/deps declare.
 *   2. `npm install <tgz>` into a clean tmp dir OUTSIDE the workspace (no parent
 *      node_modules reaching back into libs/ — otherwise a missing dep resolves against
 *      the workspace and the guard silently passes a broken package).
 *   3. import-and-exercise the installed package (native carriers prove their native deps
 *      resolve + a real round-trip; pure-JS three import + one call).
 *
 * Run from repo root (after `nx run-many -t build` so dist/ exists):
 *   node docs/plan/memory-refactor/scripts/pack-smoke.mjs
 *   node docs/plan/memory-refactor/scripts/pack-smoke.mjs --only vector-store
 *
 * Exit code == number of packages that failed their smoke. READ-ONLY w.r.t. the repo
 * (operates entirely in os.tmpdir()); a failure is fixed in the package's package.json
 * dependencies / esbuild externalize config, NEVER by weakening this smoke.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;

// Public data/* packages. `smoke` is an ESM snippet run from inside the clean install dir;
// it must throw on any failure. Native carriers assert their declared native deps resolve
// FROM THE TARBALL (the BL-87 guard) and exercise a real round-trip.
const PACKAGES = [
  {
    name: 'embedding-provider', group: 'embed', kind: 'native',
    smoke: `
      const m = await import('@adhd/sox-embedding-provider');
      // BL-87 guard: the real provider's native runtime must resolve from declared deps.
      const real = await m.resolveProvider({ backend: 'real' });
      const a = await real.embed('the cat sat on the mat');
      const b = await real.embed('quarterly financial derivatives report');
      if (a.length !== real.dim) throw new Error('dim mismatch');
      const cos = cosine(a, b);
      if (!(cos < 0.5)) throw new Error('cosine-sanity failed: ' + cos);
      const det = await m.resolveProvider({ backend: 'hash' });
      if (det.isDeterministic !== true) throw new Error('deterministic flag');
      function cosine(x,y){let d=0,nx=0,ny=0;for(let i=0;i<x.length;i++){d+=x[i]*y[i];nx+=x[i]*x[i];ny+=y[i]*y[i];}return d/(Math.sqrt(nx)*Math.sqrt(ny));}
    `,
  },
  {
    name: 'vector-store', group: 'vectors', kind: 'native',
    smoke: `
      const m = await import('@adhd/sox-vector-store');
      // BL-87 guard: better-sqlite3 + sqlite-vec must resolve from declared deps.
      const db = m.openVectorStore(':memory:', { dim: 4 });
      m.applyVecSchema(db, { dim: 4, modelId: 'smoke' });
      m.upsertVector(db, 1, Float32Array.from([1,0,0,0]), { modelId: 'smoke' });
      m.upsertVector(db, 2, Float32Array.from([0,1,0,0]), { modelId: 'smoke' });
      const hits = m.knn(db, Float32Array.from([0.9,0.1,0,0]), 1);
      if (hits[0].nodeId !== 1) throw new Error('knn round-trip failed');
    `,
  },
  {
    name: 'graph-store', group: 'graph', kind: 'native',
    smoke: `
      const m = await import('@adhd/sox-graph-store');
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(':memory:');
      m.applyGraphSchema(db);
      const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node'").get();
      if (!r) throw new Error('applyGraphSchema did not create node table');
    `,
  },
  {
    name: 'hybrid-search', group: 'search', kind: 'pure',
    smoke: `
      const m = await import('@adhd/sox-hybrid-search');
      if (typeof (m.search ?? m.hybridRecall) !== 'function') throw new Error('no ranker export');
    `,
  },
  {
    name: 'analysis', group: 'analysis', kind: 'pure',
    smoke: `
      const m = await import('@adhd/sox-analysis');
      if (typeof m.computeImportance !== 'function') throw new Error('no computeImportance export');
    `,
  },
  {
    name: 'ingest', group: 'ingest', kind: 'pure',
    smoke: `
      const m = await import('@adhd/sox-ingest');
      const h1 = m.contentHash('hello'); const h2 = m.contentHash('hello');
      if (h1 !== h2) throw new Error('contentHash not deterministic');
    `,
  },
];

let failures = 0;
for (const p of PACKAGES) {
  if (ONLY && p.name !== ONLY) continue;
  const pkgDir = path.join(REPO, 'libs', 'data', p.group, p.name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `packsmoke-${p.name}-`));
  try {
    if (!fs.existsSync(path.join(pkgDir, 'dist'))) {
      throw new Error(`dist/ missing — run \`nx build ${p.name}\` first (BL-4)`);
    }
    // 1. pack
    const tgzName = execFileSync('npm', ['pack', '--silent'], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop();
    const tgz = path.join(pkgDir, tgzName);
    // 2. clean install OUTSIDE the workspace
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: `smoke-${p.name}`, private: true, type: 'module' }) + '\n');
    execFileSync('npm', ['install', '--no-save', '--install-links', tgz], { cwd: tmp, stdio: 'pipe' });
    fs.rmSync(tgz, { force: true });
    // 3. import-and-exercise
    const runner = path.join(tmp, 'smoke.mjs');
    fs.writeFileSync(runner, p.smoke);
    execFileSync('node', [runner], { cwd: tmp, stdio: 'pipe', timeout: 120000 });
    console.log(`  PASS  [${p.name}] (${p.kind}) standalone install + exercise`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  [${p.name}] (${p.kind}) — ${String(e.message || e).split('\n')[0]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`\npack-smoke: ${PACKAGES.length - failures}/${PACKAGES.length} pass, ${failures} fail`);
if (failures) console.log('BL-87 guard: a failure means a runtime dep is missing from the package.json or wrongly externalized — fix the package, not this smoke.');
process.exit(failures);
