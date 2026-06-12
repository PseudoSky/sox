#!/usr/bin/env node
/**
 * tools/test-graphify.js — P4 acceptance: graphify import bridge (design.md §4 G4).
 *
 * Assertions:
 *   (a) Good fixture (v1 shape): loads successfully, nodes + edges imported
 *   (b) Good fixture (v2 shape): loads successfully
 *   (c) Mutated-schema fixture (unknown fields): REFUSES import (non-zero, no partial write)
 *   (d) Unknown top-level shape: REFUSES import (non-zero, no partial write)
 *
 * G4 invariant: NEVER partial-import on unknown shape — fail loud, no partial write.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  openDb, initScope,
  graphifyImport, fingerprintGraphifyShape, SUPPORTED_GRAPHIFY_SHAPES,
} from '../extensions/mcp-servers/memory-server/dist/lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp-graphify');
const DB_PATH = path.join(TMP_DIR, '.memory', 'project.db');

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  OK: ${msg}`);
}

function assertEq(a, b, msg) {
  if (a !== b) {
    console.error(`FAIL: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    process.exit(1);
  }
  console.log(`  OK: ${msg} (got: ${JSON.stringify(a)})`);
}

async function main() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  console.log('test-graphify.js: setting up test database...');
  const db = openDb(DB_PATH);
  initScope(db, 'project', 'test-graphify-scope');

  // ── Verify SUPPORTED_GRAPHIFY_SHAPES is exported and has expected shapes ──────
  console.log('\n--- Shape registry check ---');
  assert(typeof SUPPORTED_GRAPHIFY_SHAPES === 'object', 'SUPPORTED_GRAPHIFY_SHAPES is exported');
  assert('v1' in SUPPORTED_GRAPHIFY_SHAPES, 'v1 shape defined');
  assert('v2' in SUPPORTED_GRAPHIFY_SHAPES, 'v2 shape defined');

  // ── (a) Good v1 fixture ───────────────────────────────────────────────────────
  console.log('\n--- (a) Good v1 fixture ---');

  const goodV1 = {
    nodes: [
      { id: 'n1', type: 'entity', content: 'Alice is a software engineer', name: 'Alice' },
      { id: 'n2', type: 'entity', content: 'Bob is a data scientist', name: 'Bob' },
      { id: 'n3', type: 'episode', content: 'Alice and Bob worked on a project together' },
    ],
    edges: [
      { src: 'n1', dst: 'n3', rel: 'MENTIONS' },
      { src: 'n2', dst: 'n3', rel: 'MENTIONS' },
      { src: 'n1', dst: 'n2', rel: 'RELATES_TO' },
    ],
  };

  // Verify fingerprint
  const v1Shape = fingerprintGraphifyShape(goodV1);
  assertEq(v1Shape, 'v1', 'v1 fixture fingerprints as v1');

  const v1Result = graphifyImport(db, goodV1, { scope: 'project' });
  assertEq(v1Result.ok, true, 'v1 good fixture import returns ok:true');
  assert(v1Result.imported >= 3, `v1 imported >= 3 nodes (got ${v1Result.imported})`);
  assert(v1Result.edges_imported >= 1, `v1 imported edges (got ${v1Result.edges_imported})`);
  assertEq(v1Result.shape, 'v1', 'result.shape = v1');

  // Verify nodes are in DB
  const aliceNode = db.prepare(`SELECT uid, name, kind FROM node WHERE name = 'Alice' AND t_invalid IS NULL`).get();
  assert(aliceNode !== undefined, 'Alice entity node in DB after v1 import');
  assertEq(aliceNode.kind, 'entity', 'Alice node has kind=entity');

  // ── (b) Good v2 fixture ───────────────────────────────────────────────────────
  console.log('\n--- (b) Good v2 fixture ---');

  // Use a fresh DB for v2 test to avoid dedup collisions
  const DB_PATH_V2 = path.join(TMP_DIR, '.memory', 'project-v2.db');
  const dbV2 = openDb(DB_PATH_V2);
  initScope(dbV2, 'project', 'test-graphify-scope-v2');

  const goodV2 = {
    version: 2,
    nodes: [
      { uid: 'node-charlie', kind: 'entity', content: 'Charlie is a product manager', name: 'Charlie' },
      { uid: 'node-diana', kind: 'entity', content: 'Diana is a designer', name: 'Diana' },
      { uid: 'node-ep1', kind: 'episode', content: 'Charlie and Diana co-led the UX redesign' },
    ],
    edges: [
      { src: 'node-charlie', dst: 'node-ep1', rel: 'MENTIONS', weight: 0.9 },
      { src: 'node-diana', dst: 'node-ep1', rel: 'MENTIONS', weight: 0.9 },
    ],
  };

  const v2Shape = fingerprintGraphifyShape(goodV2);
  assertEq(v2Shape, 'v2', 'v2 fixture fingerprints as v2');

  const v2Result = graphifyImport(dbV2, goodV2, { scope: 'project' });
  assertEq(v2Result.ok, true, 'v2 good fixture import returns ok:true');
  assert(v2Result.imported >= 3, `v2 imported >= 3 nodes (got ${v2Result.imported})`);
  assertEq(v2Result.shape, 'v2', 'result.shape = v2');

  const charlieNode = dbV2.prepare(`SELECT uid, name, kind FROM node WHERE name = 'Charlie' AND t_invalid IS NULL`).get();
  assert(charlieNode !== undefined, 'Charlie entity node in DB after v2 import');
  // v2 preserves the uid from the fixture
  assertEq(charlieNode.uid, 'node-charlie', 'v2 node uid preserved from fixture');

  dbV2.close();

  // ── (c) Mutated-schema fixture: unknown fields → refuse, no partial write ─────
  console.log('\n--- (c) Mutated-schema fixture: unknown fields → FAIL LOUD ---');

  // DB for this test — check count before/after
  const DB_PATH_MUT = path.join(TMP_DIR, '.memory', 'project-mutated.db');
  const dbMut = openDb(DB_PATH_MUT);
  initScope(dbMut, 'project', 'test-graphify-mutated');

  const mutatedV1 = {
    nodes: [
      { id: 'n1', type: 'entity', content: 'Known content', name: 'KnownEntity',
        UNKNOWN_FIELD: 'this field should not be here' }, // <-- unknown field
    ],
    edges: [
      { src: 'n1', dst: 'n1', rel: 'RELATES_TO' },
    ],
  };

  const preCount = dbMut.prepare(`SELECT COUNT(*) as cnt FROM node`).get();
  const mutResult = graphifyImport(dbMut, mutatedV1, { scope: 'project' });

  assertEq(mutResult.ok, false, 'mutated fixture import returns ok:false (fail-loud)');
  assert(mutResult.error?.includes('UNKNOWN_FIELD') || mutResult.error?.includes('unknown fields'),
    `error message mentions unknown field (got: "${mutResult.error?.substring(0, 100)}")`);
  assertEq(mutResult.partial, false, 'partial=false confirms no partial write');

  // Verify NO nodes were written (no partial write)
  const postCount = dbMut.prepare(`SELECT COUNT(*) as cnt FROM node`).get();
  assertEq(postCount.cnt, preCount.cnt, `no partial write: node count unchanged (${preCount.cnt} before, ${postCount.cnt} after)`);

  // Test with missing required field (content present so fingerprinting works, but an edge is missing src)
  const missingRequired = {
    nodes: [
      { id: 'n1', type: 'entity', content: 'Known node' }, // valid node
    ],
    edges: [
      { dst: 'n1', rel: 'RELATES_TO' }, // src is required — missing
    ],
  };

  const missingResult = graphifyImport(dbMut, missingRequired, { scope: 'project' });
  assertEq(missingResult.ok, false, 'missing required field import returns ok:false');
  assert(missingResult.error?.includes('src') || missingResult.error?.includes('required'),
    `error mentions missing required field (got: "${missingResult.error?.substring(0, 100)}")`);

  // ── (d) Unknown top-level shape → refuse ─────────────────────────────────────
  console.log('\n--- (d) Unknown top-level shape → FAIL LOUD ---');

  const DB_PATH_UNK = path.join(TMP_DIR, '.memory', 'project-unknown.db');
  const dbUnk = openDb(DB_PATH_UNK);
  initScope(dbUnk, 'project', 'test-graphify-unknown');

  // Shape with wrong node key structure (uid+kind but no version=2)
  const unknownShape = {
    nodes: [
      { uid: 'n1', kind: 'entity', content: 'Should refuse' }, // looks like v2 but no version field
    ],
    edges: [],
  };

  const unkShape = fingerprintGraphifyShape(unknownShape);
  assert(unkShape === null, 'ambiguous shape fingerprinted as null (unknown)');

  const preCountUnk = dbUnk.prepare(`SELECT COUNT(*) as cnt FROM node`).get();
  const unkResult = graphifyImport(dbUnk, unknownShape, { scope: 'project' });

  assertEq(unkResult.ok, false, 'unknown shape import returns ok:false (fail-loud)');
  assert(unkResult.error?.includes('Unknown graphify shape') || unkResult.error?.includes('REFUSING'),
    `error message indicates unknown shape refusal (got: "${unkResult.error?.substring(0, 120)}")`);
  assertEq(unkResult.partial, false, 'partial=false on unknown shape');

  const postCountUnk = dbUnk.prepare(`SELECT COUNT(*) as cnt FROM node`).get();
  assertEq(postCountUnk.cnt, preCountUnk.cnt, `no partial write on unknown shape (count unchanged: ${preCountUnk.cnt})`);

  // Also test completely wrong structure
  const wrongStructure = {
    graph_nodes: [{ id: 'n1' }],  // wrong key names
    graph_edges: [],
  };
  const wrongResult = graphifyImport(dbUnk, wrongStructure, { scope: 'project' });
  assertEq(wrongResult.ok, false, 'completely wrong structure returns ok:false');

  dbMut.close();
  dbUnk.close();
  db.close();

  console.log('\ntest-graphify.js: ALL ASSERTIONS PASSED');
  console.log('  (a) v1 good fixture loads successfully');
  console.log('  (b) v2 good fixture loads successfully, uid preserved');
  console.log('  (c) mutated-schema fixture refuses import (fail-loud, no partial write)');
  console.log('  (d) unknown top-level shape refuses import (fail-loud, no partial write)');
  process.exit(0);
}

main().catch(err => {
  console.error('test-graphify.js FAILED:', err);
  process.exit(1);
});
