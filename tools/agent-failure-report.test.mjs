#!/usr/bin/env node
/**
 * agent-failure-report.test.mjs
 *
 * Regression test for tools/agent-failure-report.mjs. Proves the two things
 * that make the report trustworthy — the failure classifier and the
 * NON-OVERLAPPING recovery attribution — plus the permission deny-family
 * matcher used by the prompt/permission findings.
 *
 * Run: node tools/agent-failure-report.test.mjs
 * Plain node:test, fabricated in-memory sqlite — no live transcript, no repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  classifyFailure, denyFamily, buildCube, loadRows, toolsReferenced,
  serverOf, FIX_ROUTING, FAILURE_CLASSES, trendIndex,
} from './agent-failure-report.mjs';

test('classifyFailure maps each failure class and defaults to other', () => {
  assert.equal(classifyFailure('MCP error -32001: Request timed out'), 'MCP timeout');
  assert.equal(classifyFailure('The user has specified a rule which prevents you…'), 'permission/consent');
  assert.equal(classifyFailure('MCP error -32602: Structured content does not match the tool\'s output schema'), 'schema (output)');
  assert.equal(classifyFailure('Validation failed: /data/input must NOT have additional properties'), 'schema (input)');
  assert.equal(classifyFailure('Could not find oldString in the file.'), 'edit mismatch');
  assert.equal(classifyFailure('Ripgrep JSON record exceeded 65536 bytes'), 'ripgrep');
  assert.equal(classifyFailure('File not found: /x/y.md'), 'file not found');
  assert.equal(classifyFailure('{"code":"E_MISSING_PROJECT_PATH","message":"…"}'), 'memory missing-arg');
  assert.equal(classifyFailure('{"code":"E_BUSY","message":"database is locked"}'), 'db lock/WAL');
  assert.equal(classifyFailure('AGENT_NOT_FOUND], Agent \'researcher\' not found'), 'agent/model/skill not found');
  assert.equal(classifyFailure('something totally unrecognised'), 'other');
  assert.equal(classifyFailure(null), null);
});

test('denyFamily matches inside compound/multiline commands (the 119/161 case)', () => {
  assert.equal(denyFamily('rm -rf dist/smoke && node scripts/smoke-test.mjs'), 'rm -rf');
  assert.equal(denyFamily('set -e\nT=$(mktemp -d)\nrm -rf "$T"\n'), 'rm -rf');
  assert.equal(denyFamily('cd /x && git stash'), 'git stash');
  assert.equal(denyFamily('git add -A .'), 'git add -A/.');
  assert.equal(denyFamily('git push --no-verify -u origin x'), 'git push --no-verify');
  assert.equal(denyFamily('git push --force-with-lease=x:y'), 'git push --force');
  assert.equal(denyFamily('ls -la'), null);
});

test('toolsReferenced extracts backticked and call-style tool names', () => {
  const refs = toolsReferenced('call `memory-server_memory_recall` or memory_write() — see `read`.');
  assert.ok(refs.has('memory-server_memory_recall'));
  assert.ok(refs.has('memory_write'));
  assert.ok(refs.has('read'));
});

/** Build a synthetic transcript DB matching the opencode `session`/`message`/`part` shape. */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    create table session (id text primary key, agent text, time_created integer);
    create table message (id text primary key, session_id text, data text, time_created integer);
    create table part (session_id text, message_id text, time_created integer, data text);
  `);
  const now = Date.now();
  db.prepare('insert into session values (?,?,?)').run('s1', 'alpha', now);
  const msg = (id, tokens, cost, ts) =>
    db.prepare('insert into message values (?,?,?,?)').run(
      id, 's1', JSON.stringify({ role: 'assistant', agent: 'alpha', tokens, cost }), ts);
  const tool = (mid, ts, name, status, error) =>
    db.prepare('insert into part values (?,?,?,?)').run(
      's1', mid, ts, JSON.stringify({ type: 'tool', tool: name, state: { status, error, input: {} } }));

  // mA issues a failing recall; mB is the recovery turn; mC a later turn.
  msg('mA', { input: 100, cache: { read: 1000 } }, 0.01, now + 1);
  msg('mB', { input: 50, cache: { read: 500 } }, 0.005, now + 2);
  msg('mC', { input: 10, cache: { read: 100 } }, 0.001, now + 3);
  tool('mA', now + 1, 'memory-server_memory_recall', 'error', 'MCP error -32001: Request timed out');
  tool('mB', now + 2, 'read', 'completed', null);
  tool('mC', now + 3, 'read', 'completed', null);
  return db;
}

test('serverOf routes each tool to its owning subsystem', () => {
  assert.equal(serverOf('memory-server_memory_recall'), 'memory-server');
  assert.equal(serverOf('backlog_backlog_query'), 'backlog');
  assert.equal(serverOf('search_agent_search'), 'search');
  assert.equal(serverOf('gitnexus_impact'), 'gitnexus');
  assert.equal(serverOf('agent_task'), 'agent-mcp');
  assert.equal(serverOf('read'), 'host');
});

test('every failure class has a fix-routing entry (a triager never hits an unrouted finding)', () => {
  for (const c of FAILURE_CLASSES) assert.ok(FIX_ROUTING[c.name], `missing FIX_ROUTING for ${c.name}`);
});

test('buildCube carries a reproducible example error/input/session and a per-day histogram', () => {
  const db = makeDb();
  const loaded = loadRows(db, 0, null);
  const r = buildCube(loaded, 1)[0];
  assert.match(r.example_error, /32001|timed out/);
  assert.ok(r.example_session);                       // a session id a triager can open
  assert.deepEqual(Object.keys(r.byDay).length, 1);   // one day bucket
});

test('trendIndex groups by agent x failure-type', () => {
  const idx = trendIndex([
    { agent: 'a', failure_type: 'MCP timeout', count: 2, recovery_tokens: 10 },
    { agent: 'a', failure_type: 'MCP timeout', tool: 'x', count: 3, recovery_tokens: 5 },
    { agent: 'b', failure_type: 'ripgrep', count: 1, recovery_tokens: 4 },
  ]);
  assert.equal(idx.get('a\u0000MCP timeout').count, 5);
  assert.equal(idx.get('a\u0000MCP timeout').tokens, 15);
  assert.equal(idx.get('b\u0000ripgrep').count, 1);
});

test('buildCube charges the recovery turn once (non-overlapping floor)', () => {
  const db = makeDb();
  const loaded = loadRows(db, 0, null);
  const cube = buildCube(loaded, 1);
  assert.equal(cube.length, 1);
  const r = cube[0];
  assert.deepEqual([r.agent, r.failure_type, r.tool, r.count], ['alpha', 'MCP timeout', 'memory-server_memory_recall', 1]);
  // mB (50+500) is the single recovery turn; mC is not charged.
  assert.equal(r.recovery_tokens, 550);
  assert.equal(Number(r.recovery_usd.toFixed(3)), 0.005);
  assert.equal(loaded.calls.get('alpha'), 3);
});

test('buildCube window>1 gives the overlapping upper bound', () => {
  const db = makeDb();
  const loaded = loadRows(db, 0, null);
  const cube = buildCube(loaded, 2);
  // both following turns mB (550) + mC (110) charged to the one failure
  assert.equal(cube[0].recovery_tokens, 660);
});

test('buildCube counts every error even when several share one message', () => {
  const db = makeDb();
  const now = Date.now();
  // two failing calls in the SAME assistant message mA
  db.prepare('insert into part values (?,?,?,?)').run('s1', 'mA', now + 4,
    JSON.stringify({ type: 'tool', tool: 'edit', state: { status: 'error', error: 'Could not find oldString in the file.', input: {} } }));
  const loaded = loadRows(db, 0, null);
  const cube = buildCube(loaded, 1);
  const total = cube.reduce((a, r) => a + r.count, 0);
  assert.equal(total, 2); // recall (mA) + edit (mA)
  // the next message (mB) is charged to only ONE of them — the floor, not both
  const sumTok = cube.reduce((a, r) => a + r.recovery_tokens, 0);
  assert.equal(sumTok, 550);
});
