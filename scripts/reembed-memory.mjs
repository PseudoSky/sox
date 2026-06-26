#!/usr/bin/env node
/**
 * scripts/reembed-memory.mjs — re-embed a sox-memory store with the active REAL model.
 *
 * Why: records written while the embedding backend was on the degenerate hash fallback
 * (BL-86/87/89) carry hash vectors in `vec_node`. Once the real BGE backend is engaged,
 * those rows must be re-embedded so semantic recall uses the same vector space as new
 * writes. There is no per-record model tag yet (BL-88), so targeting is by the scope's
 * `memory_scope.embed_model` vs the active real model.
 *
 * Safety contract:
 *   - Backs up the DB (+ -wal/-shm) BEFORE any write (skip with --no-backup).
 *   - --dry-run performs ZERO writes; it reports what WOULD change plus a cosine sanity
 *     check (degenerate stored pair vs. freshly-embedded real pair).
 *   - Idempotent: only re-embeds when the scope model differs from the active real model
 *     (override with --force); re-embedding is UPDATE-only (INSERT OR REPLACE on vec_node),
 *     never a DELETE, and the real model is deterministic so repeats are no-ops.
 *
 * Usage:
 *   node scripts/reembed-memory.mjs [db_path] [--dry-run] [--force] [--no-backup]
 *                                   [--backend real|auto] [--limit N]
 *
 *   db_path        target store (default: ~/.memory/memory.db)
 *   --dry-run      report only; no backup, no writes
 *   --force        re-embed even if the scope is already on the active real model
 *   --no-backup    skip the pre-write backup (caller already backed up)
 *   --backend      embed backend to force (default 'real' — fail loud if real is unavailable)
 *   --limit N      cap the number of nodes processed (testing)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── arg parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dryRun: false, force: false, backup: true, backend: 'real', limit: 0, db: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--no-backup') opts.backup = false;
  else if (a === '--backend' && argv[i + 1]) opts.backend = argv[++i];
  else if (a === '--limit' && argv[i + 1]) opts.limit = parseInt(argv[++i], 10) || 0;
  else if (a === '--db' && argv[i + 1]) opts.db = argv[++i];
  else if (!a.startsWith('--')) opts.db = a;
}

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
const dbPath = path.resolve(expandTilde(opts.db || path.join(os.homedir(), '.memory', 'memory.db')));

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`[reembed] ERROR: ${msg}`); process.exit(1); };

if (!fs.existsSync(dbPath)) die(`db not found: ${dbPath}`);

// Force the embedding backend BEFORE importing memory-core (config is read at first embed).
process.env.SOX_EMBED_BACKEND = opts.backend;

// ── load memory-core from the built dist ────────────────────────────────────────
const coreDist = path.resolve(__dirname, '..', 'libs', 'memory-core', 'dist', 'index.js');
if (!fs.existsSync(coreDist)) die(`memory-core not built: ${coreDist} (run: npx nx build memory-core)`);
const core = await import(pathToFileURL(coreDist).href);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// ── warm up the real backend (fail loud if unavailable) ─────────────────────────
log(`[reembed] target db     : ${dbPath}`);
log(`[reembed] backend forced: ${opts.backend}`);
log(`[reembed] warming up embedding backend...`);
const health = await core.warmupEmbed().catch((e) => die(`embedding warmup failed: ${e.message}`));
log(`[reembed] embed health  : ${JSON.stringify(health)}`);
if (opts.backend === 'real' && health.state !== 'real') {
  die(`backend='real' requested but state is '${health.state}' (last_error=${health.last_error}). Aborting — refusing to write hash vectors.`);
}
const activeModel = core.getActiveEmbedModel();
log(`[reembed] active model  : ${activeModel}`);

// ── open db ─────────────────────────────────────────────────────────────────────
const db = core.openDb(dbPath);

const scopes = db.prepare(`SELECT scope, embed_model, embed_dim FROM memory_scope`).all();
log(`[reembed] scopes        : ${JSON.stringify(scopes)}`);
const allReal = scopes.length > 0 && scopes.every((s) => s.embed_model === activeModel);
if (allReal && !opts.force && !opts.dryRun) {
  log(`[reembed] all scopes already on '${activeModel}' — nothing to do (use --force to re-embed anyway).`);
  db.close();
  process.exit(0);
}

// Target = live nodes that have a vector AND non-empty content.
const targets = db.prepare(
  `SELECT n.rowid AS rowid, n.content AS content, n.uid AS uid
     FROM node n JOIN vec_node v ON v.node_id = n.rowid
    WHERE n.t_invalid IS NULL AND n.content IS NOT NULL AND TRIM(n.content) != ''
    ORDER BY n.rowid` +
  (opts.limit ? ` LIMIT ${opts.limit}` : ''),
).all();
log(`[reembed] nodes targeted: ${targets.length}`);
if (targets.length === 0) { log('[reembed] no nodes to re-embed.'); db.close(); process.exit(0); }

// ── cosine sanity BEFORE: two unrelated stored vectors ──────────────────────────
function storedVec(rowid) {
  const r = db.prepare(`SELECT vec_to_json(embedding) AS e FROM vec_node WHERE node_id = ?`).get(rowid);
  return r ? JSON.parse(r.e) : null;
}
if (targets.length >= 2) {
  const a = storedVec(targets[0].rowid);
  const b = storedVec(targets[targets.length - 1].rowid);
  if (a && b) log(`[reembed] cosine BEFORE (stored, 2 unrelated nodes): ${cosine(a, b).toFixed(4)}`);
}

// ── backup ──────────────────────────────────────────────────────────────────────
if (!opts.dryRun && opts.backup) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) {
      const dst = `${dbPath}.bak-reembed-${ts}${suffix}`;
      fs.copyFileSync(src, dst);
      log(`[reembed] backup        : ${dst}`);
    }
  }
}

// ── embed (async) then write (sync transaction) ─────────────────────────────────
log(`[reembed] embedding ${targets.length} nodes with '${activeModel}'...`);
const results = [];
let done = 0;
for (const t of targets) {
  const vec = await core.embed(t.content);           // matches the write path (embed(content))
  results.push({ rowid: t.rowid, vecJson: core.vecToJson(vec), vec });
  if (++done % 100 === 0 || done === targets.length) log(`[reembed]   embedded ${done}/${targets.length}`);
}

// cosine sanity AFTER (freshly embedded real vectors of the same 2 unrelated nodes)
if (results.length >= 2) {
  const c = cosine(results[0].vec, results[results.length - 1].vec);
  log(`[reembed] cosine AFTER  (real model, same 2 unrelated nodes): ${c.toFixed(4)}` +
      (Math.abs(c) < 0.85 ? '  (non-degenerate — real embeddings)' : '  (WARNING: still high)'));
}

if (opts.dryRun) {
  log(`[reembed] DRY-RUN: would update ${results.length} vec_node rows and set ${scopes.length} scope(s) to '${activeModel}'. No writes performed.`);
  db.close();
  process.exit(0);
}

const writeTxn = db.transaction((rows) => {
  // NB: sqlite-vec vec0 virtual tables do NOT support INSERT OR REPLACE (it raises a
  // UNIQUE PK error). UPDATE ... WHERE node_id is the correct in-place form. Targets are
  // JOINed on vec_node so every row already exists; this is UPDATE-only, never a DELETE.
  const upd = db.prepare(`UPDATE vec_node SET embedding = ? WHERE node_id = CAST(? AS INTEGER)`);
  for (const r of rows) {
    const info = upd.run(r.vecJson, r.rowid);
    if (info.changes !== 1) throw new Error(`expected 1 vec_node row for node ${r.rowid}, updated ${info.changes}`);
  }
  if (scopes.length > 0) {
    db.prepare(`UPDATE memory_scope SET embed_model = ?, embed_dim = ?`).run(activeModel, core.EMBED_DIM);
  }
});
writeTxn(results);
log(`[reembed] DONE: updated ${results.length} vec_node rows; memory_scope.embed_model -> '${activeModel}'.`);

db.close();
// Shut the embed worker down before exiting (best-effort; it is unref'd so it never
// blocks exit). Fire-and-forget then exit to avoid an unsettled-await warning.
void core._shutdownEmbedWorker?.().catch(() => {});
process.exit(0);
