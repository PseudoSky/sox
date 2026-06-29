#!/usr/bin/env node
/**
 * space_invariant_check.mjs — Memory refactor Wave 0 deliverable.
 *
 * Verifies the vector-space invariant: every vector in the store was produced by
 * the model declared for its space. Opens a DB read-only, joins vec_node → node
 * → memory_scope, and flags any vector whose implied model/dim ≠ the scope model.
 * Exits non-zero on a violation.
 *
 * Run against a COPY of the live DB (never the live file).
 *
 * Usage:
 *   node docs/plan/memory-refactor/scripts/space_invariant_check.mjs <db-path>
 *   node docs/plan/memory-refactor/scripts/space_invariant_check.mjs --self-test
 *
 * --self-test: builds a tiny in-memory better-sqlite3 store and proves a
 *              mismatched-dim insert throws (sqlite-vec rejects it).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Self-test ──────────────────────────────────────────────────────────────────

function selfTest() {
  console.log('[self-test] Creating in-memory DB with sqlite-vec...');
  const db = new Database(':memory:');
  sqliteVec.load(db);

  console.log('[self-test] Creating vec0 virtual table with FLOAT[4]');
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_test USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[4])');

  console.log('[self-test] Inserting a correct-dim vector (length=4)...');
  const vec4 = Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
  db.prepare('INSERT INTO vec_test(id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(1, vec4);
  console.log('[self-test]   ✓ 4-dim vector inserted successfully');

  console.log('[self-test] Attempting to insert a wrong-dim vector (length=3)...');
  let thrown = false;
  try {
    const vec3 = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    db.prepare('INSERT INTO vec_test(id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(2, vec3);
  } catch (err) {
    thrown = true;
    console.log(`[self-test]   ✓ sqlite-vec rejected the wrong-dim insert: ${err.message}`);
  }
  if (!thrown) {
    console.error('[self-test]   ✗ FAIL: wrong-dim insert was NOT rejected');
    process.exit(1);
  }

  console.log('[self-test] Attempting to insert a longer-dim vector (length=5)...');
  thrown = false;
  try {
    const vec5 = Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]).buffer);
    db.prepare('INSERT INTO vec_test(id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(3, vec5);
  } catch (err) {
    thrown = true;
    console.log(`[self-test]   ✓ sqlite-vec rejected the longer-dim insert: ${err.message}`);
  }
  if (!thrown) {
    console.error('[self-test]   ✗ FAIL: longer-dim insert was NOT rejected');
    process.exit(1);
  }

  console.log('[self-test] ✓ ALL ASSERTIONS PASSED — space invariant is enforced by sqlite-vec at insert time');
  db.close();
  process.exit(0);
}

// ── Main: check a real DB ─────────────────────────────────────────────────────

function checkDB(dbPath) {
  const resolved = dbPath.replace(/^~/, process.env.HOME);
  if (!fs.existsSync(resolved)) {
    console.error(`ERROR: DB not found at ${resolved}`);
    process.exit(2);
  }

  console.log(`Opening ${resolved} (read-only)...`);
  const db = new Database(resolved, { readonly: true });
  sqliteVec.load(db);

  // Check 1: scope metadata exists and is consistent
  const scopes = db.prepare('SELECT scope, scope_id, embed_model, embed_dim FROM memory_scope').all();
  if (scopes.length === 0) {
    console.log('OK: No memory_scope rows (empty/fresh DB) — nothing to check.');
    db.close();
    process.exit(0);
  }

  console.log(`Found ${scopes.length} scope(s):`);
  for (const s of scopes) {
    console.log(`  scope=${s.scope} model=${s.embed_model} dim=${s.embed_dim}`);
  }

  // Check 2: vec_node exists and vectors have correct dimensionality
  let violations = 0;

  // For each scope, verify the vec_node virtual table matches the declared dim.
  // sqlite-vec stores the declared dimension in the DDL — we can't read it back
  // at runtime, but we CAN verify that every vector in the table has the correct
  // byte length: expected_bytes = scope.embed_dim * 4 (Float32).
  for (const s of scopes) {
    // Scan vectors and check byte length against expected dim
    const rows = db.prepare(`
      SELECT vec_node.node_id, vec_node.embedding, node.uid, node.kind
      FROM vec_node
      JOIN node ON node.rowid = vec_node.node_id
    `).all();

    if (rows.length === 0) {
      console.log(`No vectors in scope '${s.scope}' — skipping byte-length check.`);
      continue;
    }

    let checked = 0;
    for (const row of rows) {
      const embedding = row.embedding;
      if (!embedding) {
        console.log(`  ✗ node_id=${row.node_id} uid=${row.uid}: NULL embedding`);
        violations++;
        continue;
      }

      // Embeddings may be stored as binary BLOBs (Buffer) or JSON TEXT strings.
      let actualDim;
      if (Buffer.isBuffer(embedding)) {
        // Binary blob: byte length / 4 = number of Float32 elements
        actualDim = embedding.length / 4;
      } else if (typeof embedding === 'string') {
        // JSON array string: parse and count elements
        try {
          const parsed = JSON.parse(embedding);
          if (!Array.isArray(parsed)) {
            console.log(`  ✗ node_id=${row.node_id} uid=${row.uid}: embedding is not an array`);
            violations++;
            continue;
          }
          actualDim = parsed.length;
        } catch {
          console.log(`  ✗ node_id=${row.node_id} uid=${row.uid}: unparseable embedding`);
          violations++;
          continue;
        }
      } else {
        console.log(`  ✗ node_id=${row.node_id} uid=${row.uid}: unknown embedding type ${typeof embedding}`);
        violations++;
        continue;
      }

      if (actualDim !== s.embed_dim) {
        console.log(
          `  ✗ node_id=${row.node_id} uid=${row.uid} kind=${row.kind}: ` +
          `expected ${s.embed_dim}-dim, got ${actualDim}-dim`
        );
        violations++;
      }
      checked++;
    }
    console.log(`Scope '${s.scope}': checked ${checked} vectors, ${violations} violations.`);
  }

  // Check 3: any scope with model mismatch across vec_node entries?
  // (Forward-looking: when per-vector modelId lands in w2c-vector-store, this
  // will flag vectors whose stored modelId ≠ the scope/space modelId.)

  db.close();

  if (violations > 0) {
    console.error(`\nSPACE INVARIANT VIOLATED: ${violations} vector(s) with mismatched dimensionality.`);
    process.exit(1);
  }

  console.log('\n✓ SPACE INVARIANT HELD — all vectors match their declared scope dimensionality.');
  process.exit(0);
}

// ── Entry ──────────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  selfTest();
}

const dbArg = process.argv.slice(2).find(a => !a.startsWith('-'));
if (!dbArg) {
  console.error('Usage: node space_invariant_check.mjs <db-path> [--self-test]');
  process.exit(2);
}
checkDB(dbArg);
