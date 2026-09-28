/**
 * scripts/lib/smoke-fs.mjs — filesystem plumbing for the smoke harness's run
 * root (e5cf17a0, 3ebd7ecb). Node builtins only; every side effect is either
 * injected or confined to paths the caller names, so
 * tools/test-e5cf17a0-*.mjs and tools/test-3ebd7ecb-*.mjs pin it without a build.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * e5cf17a0: claim a short, run-unique `/tmp` alias (a symlink to the run's
 * data root). The name carries only 4 random bytes, so a collision with another
 * run's live alias (or a stale one) is possible; `symlinkSync` refuses with
 * EEXIST and the claim retries under a new name instead of aborting the run —
 * and, because the colliding path is not ours, it is never removed on exit.
 *
 * @param {{ target: string, dir?: string, prefix?: string, attempts?: number,
 *           randomHex?: () => string, symlinkSync?: (target:string, p:string, type:string)=>void,
 *           log?: (s:string)=>void }} o
 * @returns {string} the alias path this call created (and therefore owns)
 */
export function claimShortAlias(o) {
  const dir = o.dir ?? '/tmp';
  const prefix = o.prefix ?? 'sox-smoke-';
  const attempts = o.attempts ?? 16;
  const randomHex = o.randomHex ?? (() => crypto.randomBytes(4).toString('hex'));
  const symlink = o.symlinkSync ?? ((t, p, type) => fs.symlinkSync(t, p, type));
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const candidate = path.join(dir, `${prefix}${randomHex()}`);
    try {
      symlink(o.target, candidate, 'dir');
      return candidate;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      last = candidate;
      if (o.log) o.log(`short alias ${candidate} already exists (another run's, or stale) — retrying with a new name`);
    }
  }
  throw new Error(`could not claim a short alias under ${dir} after ${attempts} attempts (last collision: ${last})`);
}

/**
 * Remove an alias this run claimed — only while it still points at `target`, so
 * a path another process re-created under the same name is left alone.
 * @returns {'removed'|'absent'|'foreign'}
 */
export function releaseShortAlias(alias, target) {
  let cur;
  try {
    cur = fs.readlinkSync(alias);
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'absent';
    throw e;
  }
  if (cur !== target) return 'foreign';
  fs.unlinkSync(alias);
  return 'removed';
}

/**
 * Every regular file under `root`, skipping any directory in `exclude`
 * (absolute paths). 3ebd7ecb: the run's model cache (~219 MB) and its TMPDIR are
 * excluded from the per-step snapshot — hashing them on every step was most of
 * the harness's I/O and neither is evidence of an isolation property.
 *
 * @param {string} root
 * @param {{ exclude?: string[], onError?: (p:string, e:unknown)=>void }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* walkFiles(root, opts = {}) {
  const exclude = new Set((opts.exclude ?? []).map((p) => path.resolve(p)));
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (exclude.has(dir)) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (opts.onError) opts.onError(dir, e);
      continue;
    }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile()) yield full;
    }
  }
}

/** `ino:birthtimeMs:size` of a file — changes if it is rewritten, replaced or re-downloaded. */
export function fileIdentity(p) {
  const st = fs.statSync(p);
  return `${st.ino}:${st.birthtimeMs}:${st.size}`;
}

/** Stat-only fingerprint of a tree (relative path → identity); never reads content. */
export function treeFingerprint(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[path.relative(root, full)] = fileIdentity(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The operator's model cache dir, resolved exactly as the product resolves it
 * (libs/data/embed/embedding-provider/src/index.ts: SOX_EMBED_CACHE_DIR →
 * $XDG_CACHE_HOME/sox/models → $HOME/.cache/sox/models), from the harness's OWN
 * environment — the operator's, never the smoke children's.
 */
export function operatorModelCacheDir(env) {
  if (env.SOX_EMBED_CACHE_DIR) return env.SOX_EMBED_CACHE_DIR;
  return path.join(env.XDG_CACHE_HOME ?? path.join(env.HOME ?? '', '.cache'), 'sox', 'models');
}

/**
 * 3ebd7ecb: seed the run's model cache from the operator's so a smoke run does
 * not cold-download ~219 MB. The copy is a copy-on-write CLONE (`cp -c` /
 * clonefile(2) on APFS, `cp --reflink=auto` elsewhere): the bytes are shared
 * physically, but the seeded files are distinct inodes living under the run
 * root, so containment (every --cache-dir inside the smoke root) still holds
 * and a write by fastembed can never reach the operator's file. Hardlinks are
 * deliberately NOT used: a hardlink IS the operator's inode, so any truncate,
 * rewrite or chmod through it would modify the operator cache.
 *
 * The source is only ever read. If it is missing, nothing is seeded and the run
 * downloads as before. If the clone fails, a plain copy is attempted; if that
 * fails too, the partial destination is removed and the run downloads.
 *
 * @param {{ src: string, dst: string, platform?: string, exec?: typeof execFileSync, log?: (s:string)=>void }} o
 * @returns {{ seeded: boolean, method: 'clone'|'copy'|null, reason: string, files: number, bytes: number }}
 */
export function seedModelCache(o) {
  const exec = o.exec ?? execFileSync;
  const log = o.log ?? (() => {});
  if (!fs.existsSync(path.join(o.src, 'model_optimized.onnx'))) {
    return { seeded: false, method: null, reason: `source ${o.src} has no model_optimized.onnx — the run will download`, files: 0, bytes: 0 };
  }
  if (fs.existsSync(o.dst)) {
    return { seeded: false, method: null, reason: `destination ${o.dst} already exists — left as is`, files: 0, bytes: 0 };
  }
  fs.mkdirSync(path.dirname(o.dst), { recursive: true });
  const cloneArgs = (o.platform ?? process.platform) === 'darwin' ? ['-c', '-R'] : ['--reflink=auto', '-R'];
  let method = null;
  try {
    exec('cp', [...cloneArgs, o.src, o.dst], { stdio: ['ignore', 'ignore', 'pipe'] });
    method = 'clone';
  } catch (e) {
    log(`clone of ${o.src} failed (${(e && e.message) ?? e}); falling back to a plain copy`);
    try {
      fs.rmSync(o.dst, { recursive: true, force: true });
      fs.cpSync(o.src, o.dst, { recursive: true });
      method = 'copy';
    } catch (e2) {
      log(`plain copy of ${o.src} failed (${(e2 && e2.message) ?? e2}); the run will download`);
      fs.rmSync(o.dst, { recursive: true, force: true });
      return { seeded: false, method: null, reason: `clone and copy both failed: ${(e2 && e2.message) ?? e2}`, files: 0, bytes: 0 };
    }
  }
  const fp = treeFingerprint(o.dst);
  let bytes = 0;
  for (const rel of Object.keys(fp)) bytes += fs.statSync(path.join(o.dst, rel)).size;
  return { seeded: true, method, reason: `seeded from ${o.src}`, files: Object.keys(fp).length, bytes };
}
