#!/usr/bin/env node
/**
 * tools/test-3ebd7ecb-smoke-model-cache-seed.mjs
 *
 * Red->green pin for backlog 3ebd7ecb ("smoke: every run cold-downloads the
 * ~219 MB embedding model into TEST_ROOT and re-hashes it on every step").
 * 26121495 correctly pinned the run's model cache inside the run
 * (XDG_CACHE_HOME=<TEST_ROOT>/sox-data-root/xdg-cache), but left it empty, so
 * every run downloaded bge-base-en-v1.5 and snapshotFiles() sha256'd all of it
 * before and after every soxe step.
 *
 * Invariants pinned:
 *   A. seedModelCache clones the operator's model dir into the run (distinct
 *      inodes — never hardlinks), leaves the source byte- and stat-identical,
 *      and a write through the seeded copy never reaches the source;
 *   B. a missing source seeds nothing (the run downloads as before);
 *   C. walkFiles never descends into an excluded directory;
 *   D. harness wiring: seeding happens in main() before the first soxe spawn,
 *      snapshotFiles excludes the model cache and TMPDIR, and the run end
 *      records a model-cache-no-download step.
 *
 * Usage:
 *   node tools/test-3ebd7ecb-smoke-model-cache-seed.mjs                      # green
 *   node tools/test-3ebd7ecb-smoke-model-cache-seed.mjs --code-root <dir>   # red demo: <dir> holds 82ef7b9d's scripts/
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
const fsLibPath = path.join(CODE_ROOT, 'scripts/lib/smoke-fs.mjs');
const fsLib = fs.existsSync(fsLibPath) ? await import(pathToFileURL(fsLibPath).href) : {};
const src = fs.readFileSync(path.join(CODE_ROOT, 'scripts/smoke-test.mjs'), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const has = (n) => typeof fsLib[n] === 'function';
const hashTree = (root) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); out[path.relative(root, f)] = `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}:${st.ino}:${st.mtimeMs}:${st.mode}`; }
    }
  };
  walk(root);
  return JSON.stringify(out);
};

console.log(`3ebd7ecb — code under test: ${CODE_ROOT}`);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sox-3ebd7ecb-'));
try {
  console.log('A. seed from the operator cache: clone, read-only on the source');
  if (!has('seedModelCache')) check('A0 3ebd7ecb: seedModelCache is exported', false);
  else {
    const srcDir = path.join(scratch, 'operator', '.cache', 'sox', 'models', 'fast-bge-base-en-v1.5');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'model_optimized.onnx'), crypto.randomBytes(256 * 1024));
    fs.writeFileSync(path.join(srcDir, 'tokenizer.json'), '{"t":1}');
    fs.chmodSync(path.join(srcDir, 'tokenizer.json'), 0o644);
    const before = hashTree(srcDir);
    const dst = path.join(scratch, 'run', 'sox-data-root', 'xdg-cache', 'sox', 'models', 'fast-bge-base-en-v1.5');
    const r = fsLib.seedModelCache({ src: srcDir, dst });
    check('A1 3ebd7ecb: the model is seeded (by clone or copy) with every file', r.seeded && ['clone', 'copy'].includes(r.method) && r.files === 2, JSON.stringify(r));
    if (process.platform === 'darwin') check('A2 3ebd7ecb: on macOS the seed is an APFS clone (cp -c)', r.method === 'clone', r.method);
    const sIno = fs.statSync(path.join(srcDir, 'model_optimized.onnx')).ino;
    const dIno = fs.statSync(path.join(dst, 'model_optimized.onnx')).ino;
    check('A3 3ebd7ecb: seeded files are distinct inodes under the run (never hardlinks)', sIno !== dIno && fs.statSync(path.join(dst, 'model_optimized.onnx')).nlink === 1);
    fs.writeFileSync(path.join(dst, 'model_optimized.onnx'), 'truncated by a misbehaving fastembed');
    fs.chmodSync(path.join(dst, 'tokenizer.json'), 0o600);
    check('A4 3ebd7ecb: the operator source is byte-, inode-, mtime- and mode-identical after seeding AND after writes through the copy', hashTree(srcDir) === before);
    const again = fsLib.seedModelCache({ src: srcDir, dst });
    check('A5 3ebd7ecb: an existing destination is left alone', again.seeded === false && /already exists/.test(again.reason));
    const libSrc = fs.readFileSync(fsLibPath, 'utf8');
    const seeder = libSrc.slice(libSrc.indexOf('export function seedModelCache'));
    check('A6 3ebd7ecb: the seeder never hardlinks', seeder.length > 0 && !/(?:^|[^A-Za-z])(?:linkSync|link)\(|['"]ln['"]/.test(seeder));
  }

  console.log('B. missing source falls back to the download');
  if (has('seedModelCache')) {
    const dst = path.join(scratch, 'run2', 'models', 'fast-bge-base-en-v1.5');
    const r = fsLib.seedModelCache({ src: path.join(scratch, 'nope'), dst });
    check('B1 3ebd7ecb: no source → nothing seeded, no destination created', r.seeded === false && !fs.existsSync(dst), JSON.stringify(r));
  }

  console.log('C. the per-step snapshot never walks the excluded dirs');
  if (!has('walkFiles')) check('C0 3ebd7ecb: walkFiles is exported', false);
  else {
    const root = path.join(scratch, 'walk');
    for (const d of ['sox-data-root/xdg-cache/sox/models', 'sox-data-root/tmp/sox-uds', 'sox-data-root/run']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'sox-data-root/xdg-cache/sox/models/model_optimized.onnx'), 'x');
    fs.writeFileSync(path.join(root, 'sox-data-root/tmp/sox-uds/x'), 'x');
    fs.writeFileSync(path.join(root, 'sox-data-root/run/lock'), 'x');
    fs.writeFileSync(path.join(root, 'log.json'), '{}');
    const got = [];
    for await (const f of fsLib.walkFiles(root, { exclude: [path.join(root, 'sox-data-root/xdg-cache'), path.join(root, 'sox-data-root/tmp')] })) got.push(path.relative(root, f));
    check('C1 3ebd7ecb: only non-excluded files are walked', JSON.stringify(got.sort()) === JSON.stringify(['log.json', 'sox-data-root/run/lock']), JSON.stringify(got));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('D. harness wiring');
{
  const a = src.indexOf('async function main()');
  const main = src.slice(a, src.indexOf('\n}\n', a));
  const iSeed = main.indexOf('seedModelCache(');
  const iFirstSpawn = main.search(/await runCmd\(/);
  check('D1 3ebd7ecb: main() seeds the model cache before the first soxe spawn', iSeed !== -1 && iFirstSpawn !== -1 && iSeed < iFirstSpawn);
  check('D2 3ebd7ecb: the seed source is the operator cache resolved like the product, the destination is under the run\'s XDG cache',
    /OPERATOR_MODEL_DIR = path\.join\(operatorModelCacheDir\(process\.env\), SMOKE_MODEL_NAME\)/.test(src) && /SMOKE_MODEL_DIR = path\.join\(SMOKE_XDG_CACHE_HOME, 'sox', 'models', SMOKE_MODEL_NAME\)/.test(src));
  const snap = src.slice(src.indexOf('async function snapshotFiles('), src.indexOf('function diffSnapshots('));
  check('D3 3ebd7ecb: snapshotFiles excludes the model cache and TMPDIR',
    /exclude: SNAPSHOT_EXCLUDE/.test(snap) && /const SNAPSHOT_EXCLUDE = \[SMOKE_XDG_CACHE_HOME, SMOKE_TMPDIR_PHYSICAL\]/.test(src));
  check('D4 3ebd7ecb: the run end records model-cache-no-download from the seeded file\'s identity', /test_id: 'model-cache-no-download'/.test(main) && /fileIdentity\(onnx\)/.test(main));
}

console.log(failed === 0 ? 'PASS 3ebd7ecb: all cases pass' : `FAIL 3ebd7ecb: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
