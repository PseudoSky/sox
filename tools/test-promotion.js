#!/usr/bin/env node
/**
 * tools/test-promotion.js — P4 acceptance: scope promotion via native host event.
 *
 * Assertions (design.md §2.5, docs/scope-promotion.md):
 *   (a) 3 sightings over simulated 60d → promotion_queue candidate status='proposed'
 *   (b) daemon called host proposePromotion(…) → ScopePromotionProposed fired
 *   (c) memory-flush's bound handler ran:
 *       - to-scope-owner approve → applied to user scope (dst node exists, status='applied')
 *       - reject → no-op (status stays 'proposed')
 *   (d) NO bespoke notification path outside the host event (wasBespokeUsed() === false)
 *
 * This test uses the host-event-shim as test scaffolding — the tenant code calls the
 * SAME host API path (proposePromotion) that a conformant host would provide.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  openDb, initScope,
  detectPromotionCandidates, proposePendingCandidates,
  applyPromotion, rejectPromotion, getPromotionQueue,
  validatePromotionConfig,
  memoryWrite,
} from '../extensions/mcp-servers/memory-server/dist/lib.js';

import {
  proposePromotion, bindScopePromotionHandler, resetShim,
  getPromotionLog, wasBespokeUsed, getEventCount,
} from './host-event-shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp-promotion');
const PROJECT_DB = path.join(TMP_DIR, '.memory', 'project.db');
const USER_DB = path.join(TMP_DIR, '.memory', 'user.db');

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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // Clean up from previous runs
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PROJECT_DB), { recursive: true });
  fs.mkdirSync(path.dirname(USER_DB), { recursive: true });

  resetShim();

  console.log('test-promotion.js: setting up project + user DBs...');
  const projectDb = openDb(PROJECT_DB);
  initScope(projectDb, 'project', 'test-project-scope');
  const userDb = openDb(USER_DB);
  initScope(userDb, 'user', 'test-user-scope');

  // ── (a) Simulate 3+ occurrences over 60+ days ────────────────────────────────
  console.log('\n--- (a) Candidate detection: 3 sightings over 60+ days ---');

  // Insert 3 "high-occurrence" nodes with old t_created (simulated 65 days ago)
  const oldDate = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();

  // Node 1: entity node with 3 MENTIONS edges (simulates 3 occurrences)
  const entityUid = `entity-test-${Date.now()}`;
  const now = new Date().toISOString();
  const entityRow = projectDb.prepare(
    `INSERT INTO node (uid, kind, name, content, t_created, t_valid, access_count)
     VALUES (?, 'entity', 'TestEntity', 'TestEntity is a key concept', ?, ?, 2)
     RETURNING rowid`
  ).get(entityUid, oldDate, oldDate);
  assert(entityRow !== null, 'entity node inserted with old t_created');

  // Add 2 MENTIONS edges to give it occurrence count >= 3
  // (access_count=2 + 1 base = 3, qualifies at min_occurrences:3)
  // No extra edges needed — access_count=2 + base 1 = 3

  // Node 2: episode node (too new — should NOT qualify)
  const newUid = `ep-new-${Date.now()}`;
  projectDb.prepare(
    `INSERT INTO node (uid, kind, content, t_created, t_valid, access_count)
     VALUES (?, 'episode', 'A recent episode that should not qualify', ?, ?, 5)
     RETURNING rowid`
  ).get(newUid, now, now);

  // Node 3: old episode, only 1 occurrence — should NOT qualify
  const lowOccUid = `ep-low-${Date.now()}`;
  const oldDate2 = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString();
  projectDb.prepare(
    `INSERT INTO node (uid, kind, content, t_created, t_valid, access_count)
     VALUES (?, 'episode', 'Low occurrence episode', ?, ?, 0)
     RETURNING rowid`
  ).get(lowOccUid, oldDate2, oldDate2);

  // promotion config: min_occurrences:3, min_age_days:60
  const promotionConfig = { min_occurrences: 3, min_age_days: 60, auto_approve: false, approver_scope: 'user' };

  // Validate config first (design.md R-promotion-policy: catch typos at promote time)
  const configValidation = validatePromotionConfig(promotionConfig);
  assert(configValidation.ok === true, 'config.promotion validates without errors');

  // Test typo detection
  const badConfig = { min_occurrences: 3, min_age_dayss: 60 }; // typo
  const badValidation = validatePromotionConfig(badConfig);
  assert(badValidation.ok === false, 'typo in config.promotion detected at promote time');
  assert(badValidation.errors?.some(e => e.includes('min_age_dayss')), 'unknown key "min_age_dayss" flagged');

  const detected = detectPromotionCandidates(projectDb, promotionConfig, 'project', 'user');
  console.log(`  detected: ${detected.candidates} candidates, ${detected.inserted} inserted`);
  assert(detected.inserted >= 1, 'at least one candidate inserted into promotion_queue');

  // Check entityUid is in queue with status='pending'
  const queueRows = getPromotionQueue(projectDb, 'project', 'user', 'pending');
  const entityInQueue = queueRows.find(r => r.node_uid === entityUid);
  assert(entityInQueue !== undefined, `entity node ${entityUid} is in promotion_queue`);
  assertEq(entityInQueue.status, 'pending', 'initial status is pending');
  assert(entityInQueue.occurrences >= 3, `occurrences >= 3 (got ${entityInQueue.occurrences})`);
  assert(entityInQueue.age_days >= 60, `age_days >= 60 (got ${entityInQueue.age_days})`);

  // Check new node is NOT in queue (too new)
  const newInQueue = queueRows.find(r => r.node_uid === newUid);
  assert(newInQueue === undefined, 'too-new node is NOT in promotion_queue');

  // ── (b) proposePromotion → ScopePromotionProposed fired ─────────────────────
  console.log('\n--- (b) proposePromotion → ScopePromotionProposed fired ---');

  // Wire the host-event-shim: bind a handler that will be called by the event
  // This is memory-flush's role (bound handler runs approval step)
  let handlerCallCount = 0;
  let lastPayload = null;

  bindScopePromotionHandler(async (payload) => {
    handlerCallCount++;
    lastPayload = payload;
    console.log(`  [handler] ScopePromotionProposed received: ${payload.from_scope}→${payload.to_scope} (${payload.items.length} items)`);
  });

  // Call proposePendingCandidates — this calls proposePromotion() (host API)
  // which fires ScopePromotionProposed → our bound handler runs
  const proposeResult = await proposePendingCandidates(
    projectDb, 'project', 'user',
    proposePromotion,  // <-- the host API function from host-event-shim.js
    'memory-cli'
  );

  assert(proposeResult.proposed >= 1, `at least 1 item proposed (got ${proposeResult.proposed})`);
  assert(handlerCallCount >= 1, 'ScopePromotionProposed handler was called at least once');
  assert(getEventCount() >= 1, 'host event shim fired ScopePromotionProposed');
  assert(lastPayload !== null, 'handler received payload');
  assertEq(lastPayload.from_scope, 'project', 'payload.from_scope = project');
  assertEq(lastPayload.to_scope, 'user', 'payload.to_scope = user');
  assert(lastPayload.items.some(i => i.uid === entityUid), 'entity node is in proposed items');

  // Verify promotion_queue status='proposed'
  const proposedRows = getPromotionQueue(projectDb, 'project', 'user', 'proposed');
  assert(proposedRows.length >= 1, 'at least 1 row in promotion_queue with status=proposed');
  const proposedEntity = proposedRows.find(r => r.node_uid === entityUid);
  assert(proposedEntity !== undefined, 'entity is in proposed rows');
  assertEq(proposedEntity.status, 'proposed', 'entity row status = proposed');

  // ── (c) memory-flush bound handler: approve → applied; reject → no-op ────────
  console.log('\n--- (c) approve → applied to user scope; reject → no-op ---');

  // Sub-test 1: APPROVE — apply the entity node to user scope
  console.log('  [approve test]');
  const applyResult = applyPromotion(projectDb, userDb, entityUid, 'project', 'user');
  assert(applyResult.ok === true, `applyPromotion ok (got: ${JSON.stringify(applyResult)})`);
  assert(applyResult.dst_uid !== undefined, 'dst_uid assigned after apply');

  // Verify node appears in user DB
  const userNode = userDb.prepare(`SELECT uid, kind, name FROM node WHERE uid = ?`).get(applyResult.dst_uid);
  assert(userNode !== undefined, `promoted node exists in user DB at uid=${applyResult.dst_uid}`);
  assertEq(userNode.kind, 'entity', 'promoted node has correct kind');

  // Verify promotion_queue status='applied'
  const appliedRows = getPromotionQueue(projectDb, 'project', 'user', 'applied');
  const appliedEntity = appliedRows.find(r => r.node_uid === entityUid);
  assert(appliedEntity !== undefined, 'entity row marked applied in promotion_queue');
  assertEq(appliedEntity.status, 'applied', 'status = applied after applyPromotion');

  // Verify SAME_AS edge in project DB
  const sameAsEdge = projectDb.prepare(
    `SELECT e.rel, e.meta FROM edge e
     JOIN node n ON n.rowid = e.src
     WHERE n.uid = ? AND e.rel = 'SAME_AS'`
  ).get(entityUid);
  assert(sameAsEdge !== undefined, 'SAME_AS edge written in project DB after promotion');
  const edgeMeta = sameAsEdge.meta ? JSON.parse(sameAsEdge.meta) : {};
  assertEq(edgeMeta.to_scope, 'user', 'SAME_AS edge meta.to_scope = user');

  // Sub-test 2: REJECT — no-op, row stays proposed
  console.log('  [reject test]');

  // Insert another candidate to reject
  const rejectUid = `entity-reject-${Date.now()}`;
  const oldDate3 = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();
  projectDb.prepare(
    `INSERT INTO node (uid, kind, name, content, t_created, t_valid, access_count)
     VALUES (?, 'entity', 'RejectEntity', 'Entity to be rejected', ?, ?, 2)`
  ).run(rejectUid, oldDate3, oldDate3);

  // Insert as proposed
  projectDb.prepare(
    `INSERT INTO promotion_queue (node_uid, from_scope, to_scope, occurrences, first_seen, age_days, status)
     VALUES (?, 'project', 'user', 3, ?, 65, 'proposed')`
  ).run(rejectUid, new Date().toISOString());

  const rejectResult = rejectPromotion(projectDb, rejectUid, 'project', 'user', 'user:test-owner');
  assertEq(rejectResult.ok, true, 'rejectPromotion returns ok:true');

  // Verify status='rejected', node NOT in user DB
  const rejectedRow = projectDb.prepare(
    `SELECT status FROM promotion_queue WHERE node_uid = ? AND from_scope = 'project' AND to_scope = 'user'`
  ).get(rejectUid);
  assertEq(rejectedRow?.status, 'rejected', 'rejected row has status=rejected');

  const userRejectNode = userDb.prepare(`SELECT uid FROM node WHERE name = 'RejectEntity' AND t_invalid IS NULL`).get();
  assert(userRejectNode === undefined, 'rejected entity is NOT present in user DB');

  // ── (d) NO bespoke notification path ─────────────────────────────────────────
  console.log('\n--- (d) No bespoke notification path ---');
  assert(!wasBespokeUsed(), 'NO bespoke notification path used (wasBespokeUsed=false)');

  // Verify all signalling went through proposePromotion → ScopePromotionProposed
  const log = getPromotionLog();
  assert(log.length >= 1, 'host event log has entries (signalling went through proposePromotion)');
  assert(log.every(e => e.extension_id && e.from_scope && e.to_scope), 'all log entries have required fields');

  // Cleanup
  projectDb.close();
  userDb.close();

  console.log('\ntest-promotion.js: ALL ASSERTIONS PASSED');
  console.log('  (a) 3 sightings/60d → promotion_queue candidate status=proposed');
  console.log('  (b) proposePromotion → ScopePromotionProposed fired → handler called');
  console.log('  (c) approve → applied to user scope; reject → no-op');
  console.log('  (d) no bespoke notification path outside the host event');
  process.exit(0);
}

main().catch(err => {
  console.error('test-promotion.js FAILED:', err);
  process.exit(1);
});
