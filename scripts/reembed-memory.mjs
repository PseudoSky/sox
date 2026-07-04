#!/usr/bin/env node
/**
 * scripts/reembed-memory.mjs — re-embed a sox-memory store with the active REAL model.
 *
 * Thin wrapper over @adhd/sox-vector-store.reembed() — does NOT re-implement the SQL walk.
 *
 * Why: records written while the embedding backend was on the degenerate hash fallback
 * (BL-86/87/89) carry hash vectors in `vec_node`. Once the real BGE backend is engaged,
 * those rows must be re-embedded so semantic recall uses the same vector space as new
 * writes.
 *
 * Safety contract:
 *   - Backs up the DB (+ -wal/-shm) BEFORE any write (skip with --no-backup).
 *   - --dry-run performs ZERO writes; it reports what WOULD change.
 *   - Idempotent: reembeds only when the scope model differs from the target model
 *     (override with --force); re-embedding is UPDATE-only.
 *
 * Usage:
 *   node scripts/reembed-memory.mjs [db_path] [--dry-run] [--force] [--no-backup]
 *                                   [--backend real|auto] [--limit N]
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

// Force the embedding backend BEFORE importing (config is read at first embed).
process.env.SOX_EMBED_BACKEND = opts.backend;

// ── load dependencies from built dist ─────────────────────────────────────────
async function main() {
  const coreDist = path.resolve(__dirname, '..', 'libs', 'memory-core', 'dist', 'index.js');
  if (!fs.existsSync(coreDist)) die(`memory-core not built: ${coreDist} (run: npx nx build memory-core)`);
  const core = await import(pathToFileURL(coreDist).href);

  const vsDist = path.resolve(__dirname, '..', 'libs', 'data', 'vectors', 'vector-store', 'dist', 'index.js');
  if (!fs.existsSync(vsDist)) die(`vector-store not built: ${vsDist} (run: npx nx build vector-store)`);
  const { SqliteVectorBackend, reembed } = await import(pathToFileURL(vsDist).href);

  const epDist = path.resolve(__dirname, '..', 'libs', 'data', 'embed', 'embedding-provider', 'dist', 'index.js');
  if (!fs.existsSync(epDist)) die(`embedding-provider not built: ${epDist} (run: npx nx build embedding-provider)`);
  const { createEmbeddingProvider, ResolutionError } = await import(pathToFileURL(epDist).href);

  // ── warm up the real backend (fail loud if unavailable) ─────────────────────
  log(`[reembed] target db     : ${dbPath}`);
  log(`[reembed] backend forced: ${opts.backend}`);

  // The hash backend was removed (2026-07); fastembed bge-base-en-v1.5 is the only
  // real model. The old model id 'fast-bge-base-en-v1.5' (the fastembed cache-dir
  // name) is NOT a valid createEmbeddingProvider model id — use 'bge-base-en-v1.5'.
  let provider;
  try {
    provider = await createEmbeddingProvider({
      type: 'fastembed',
      model: 'bge-base-en-v1.5',
    });
  } catch (err) {
    if (err instanceof ResolutionError || err?.name === 'ResolutionError') {
      die(`fastembed provider not available: ${err.message}`);
    }
    die(`embedding provider creation failed: ${err.message}`);
  }

  log(`[reembed] active model  : ${provider.metadata.modelId}`);
  log(`[reembed] dimensions     : ${provider.metadata.dimensions}`);

  // ── open db via memory-core (domain glue: schema + sqlite-vec load) ─────────
  const db = core.openDb(dbPath);
  const backend = new SqliteVectorBackend(db);

  const scopes = db.prepare(`SELECT scope, embed_model, embed_dim FROM memory_scope`).all();
  log(`[reembed] scopes        : ${JSON.stringify(scopes)}`);

  const targetModelId = provider.metadata.modelId;
  const allReal = scopes.length > 0 && scopes.every((s) => s.embed_model === targetModelId);
  if (allReal && !opts.force && !opts.dryRun) {
    log(`[reembed] all scopes already on '${targetModelId}' — nothing to do (use --force to re-embed anyway).`);
    db.close();
    process.exit(0);
  }

  // ── backup ──────────────────────────────────────────────────────────────────
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

  // ── reembed via vector-store ────────────────────────────────────────────────
  const targetSpace = { modelId: targetModelId, dim: provider.metadata.dimensions };
  backend.ensureSpace(targetSpace);

  const getText = (id) => {
    const row = db.prepare(`SELECT content, name FROM node WHERE rowid = ?`).get(id);
    if (!row) return null;
    return [row.content, row.name].filter(Boolean).join(' ') || null;
  };

  // If --limit is set, filter the source vectors
  let sourceModelId;
  if (opts.limit > 0) {
    // Find any space that isn't the target
    sourceModelId = scopes.find((s) => s.embed_model !== targetModelId)?.embed_model
      ?? scopes[0]?.embed_model;
  }

  log(`[reembed] re-embedding with model '${targetModelId}'...`);

  const reembedOpts = {
    targetSpace,
    sourceModelId,
    dryRun: opts.dryRun,
    getText,
  };

  // reembed from vector-store uses iter() which respects the source space
  const result = await reembed(backend, provider, reembedOpts);

  if (opts.dryRun) {
    log(`[reembed] DRY-RUN: would migrate ${result.migrated} nodes, skip ${result.skipped}. No writes performed.`);
  } else {
    log(`[reembed] DONE: migrated ${result.migrated} nodes, skipped ${result.skipped}, errors ${result.errors.length}.`);
    if (result.errors.length > 0) {
      for (const e of result.errors.slice(0, 10)) {
        log(`[reembed]   error: node ${e.id} — ${e.error}`);
      }
    }
    if (scopes.length > 0 && result.migrated > 0) {
      db.prepare(`UPDATE memory_scope SET embed_model = ?, embed_dim = ?`).run(targetModelId, provider.metadata.dimensions);
      log(`[reembed] memory_scope.embed_model -> '${targetModelId}'`);
    }
  }

  db.close();
  process.exit(0);
}

main().catch((err) => die(err.message));
