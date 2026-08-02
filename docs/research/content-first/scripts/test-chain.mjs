#!/usr/bin/env node
/**
 * test-chain.mjs — tests the cf-chain session-state proxy
 *
 * Flow:
 *   1. POST /v1/chat/completions with a REAL agent SP → proxy infers active agent
 *   2. GET /v1/session/:id → confirm agent inferred, context stored
 *   3. POST /v1/session/agent with next persona → proxy switches + triggers next turn
 *   4. GET /v1/session/:id → confirm context grew, agent switched
 *   5. POST /v1/chat/completions again → confirm UI-dropdown SP is IGNORED (session persona wins)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3334/v1';
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');

function loadSP(name) {
  const raw = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function get(p) {
  const res = await fetch(BASE + p);
  return res.json();
}

const SID = `chain-test-${Date.now().toString(36)}`;
const architectSP = loadSP('architect');
const reviewSP = loadSP('review');

console.log(`Session: ${SID}\n`);

// Step 1: first chat request with real architect SP
console.log('STEP 1 — first request, architect SP (should infer "architect")');
const r1 = await post('/chat/completions', {
  session_id: SID,
  messages: [
    { role: 'system', content: architectSP },
    { role: 'user', content: 'Design a tenant isolation system. Output one short paragraph.' },
  ],
  max_tokens: 60,
});
console.log(`  status=${r1.status}`);
if (r1.data.raw) console.log(`  response: ${r1.data.raw}`);
const s1 = await get(`/session/${SID}`);
console.log(`  activeAgent=${s1.activeAgent}  turns=${s1.turns}  ctxMessages=${s1.contextMessages}  ctxTokens=${s1.contextTokens}`);

// Step 3: handoff to review (triggers next turn)
console.log('\nSTEP 3 — handoff to "review" (triggers next turn)');
const r3 = await post('/session/agent', {
  sessionId: SID,
  agent: 'review',
  input: 'Review the tenant isolation design for correctness. Output one short paragraph.',
});
console.log(`  status=${r3.status}  activeAgent=${r3.data.activeAgent}  turn=${r3.data.turn}`);
console.log(`  output: ${(r3.data.output || '').slice(0, 120)}`);

const s3 = await get(`/session/${SID}`);
console.log(`  after handoff: activeAgent=${s3.activeAgent}  turns=${s3.turns}  ctxMessages=${s3.contextMessages}  ctxTokens=${s3.contextTokens}`);

// Step 5: send a DIFFERENT SP (simulating a UI dropdown change) — session persona should WIN
console.log('\nSTEP 5 — client sends "product" SP but session is on "review" → review must win');
const r5 = await post('/chat/completions', {
  session_id: SID,
  messages: [
    { role: 'system', content: 'You are a product manager.' },  // different SP
    { role: 'user', content: 'Summarize the current design state. One sentence.' },
  ],
  max_tokens: 40,
});
console.log(`  status=${r5.status}`);
const s5 = await get(`/session/${SID}`);
console.log(`  activeAgent=${s5.activeAgent} (expected "review")  turns=${s5.turns}`);

console.log('\nDone.');
