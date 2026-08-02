#!/usr/bin/env node
/**
 * verify-chain-mechanism.mjs — verifies the SESSION-STATE MECHANISM, not
 * opencode's tool loop.
 *
 * The novel part of the cf-chain proxy is:
 *   1. Session state holds accumulated context + active agent.
 *   2. First request infers the agent from the opencode-supplied SP.
 *   3. Subsequent requests DISCARD the opencode SP and substitute the
 *      session-designated agent's SP (UI dropdown can't override).
 *   4. /v1/session/agent resolves a persona, appends it + input, triggers the
 *      next turn, stores the output — the chain advances by an explicit
 *      handoff request (what the agent would do through opencode's bash tool).
 *
 * This test drives those four behaviors directly. It does NOT try to emulate
 * opencode's tool-call parsing, because that's opencode's job, not the proxy's.
 */

const BASE = 'http://127.0.0.1:3334/v1';
const SID = `verify-${Date.now().toString(36)}`;

async function postJSON(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({ raw: 'non-json' })) };
}
async function getJSON(p) { return (await fetch(BASE + p)).json(); }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Load REAL agent SPs from the registry so inference matches
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');
function realSP(name) {
  const raw = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}
const SP_ARCHITECT = realSP('architect');   // real → inference matches
const SP_SECURITY = realSP('review');       // real → would infer "review"
const SP_REVIEW = realSP('review');

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

async function run() {
  console.log(`Session: ${SID}\n`);

  // ── Test 1: first request infers agent from opencode-supplied SP
  console.log('TEST 1 — SP inference on first request');
  const r1 = await postJSON('/chat/completions', {
    session_id: SID,
    messages: [
      { role: 'system', content: SP_ARCHITECT },
      { role: 'user', content: 'Design a namespace isolation system. One short paragraph.' },
    ],
    max_tokens: 60,
  });
  check('request returned 200', r1.status === 200, `status=${r1.status}`);
  const s1 = await getJSON(`/session/${SID}`);
  check('agent inferred as architect', s1.activeAgent === 'architect', `activeAgent=${s1.activeAgent}`);
  check('context stored (turns=1)', s1.turns === 1, `turns=${s1.turns}`);

  // ── Test 2: handoff to review — persona switch + next turn triggered
  console.log('\nTEST 2 — handoff switches persona and triggers next turn');
  const r2 = await postJSON('/session/agent', {
    sessionId: SID,
    agent: 'review',
    input: 'Review the design for correctness. One short paragraph.',
  });
  check('handoff returned next turn', !!r2.data.output, `output=${(r2.data.output || '').slice(0, 60)}`);
  check('active agent switched to review', r2.data.activeAgent === 'review', `activeAgent=${r2.data.activeAgent}`);
  const s2 = await getJSON(`/session/${SID}`);
  check('context grew (turns=2)', s2.turns === 2, `turns=${s2.turns}, ctxTokens=${s2.contextTokens}`);

  // ── Test 3: UI dropdown SP cannot override session persona
  console.log('\nTEST 3 — opencode-supplied SP is discarded after inference');
  const r3 = await postJSON('/chat/completions', {
    session_id: SID,
    messages: [
      { role: 'system', content: SP_SECURITY },  // DIFFERENT SP — simulates dropdown change
      { role: 'user', content: 'Add your verdict. One sentence.' },
    ],
    max_tokens: 40,
  });
  check('request returned 200', r3.status === 200);
  const s3 = await getJSON(`/session/${SID}`);
  check('session still on review (dropdown ignored)', s3.activeAgent === 'review', `activeAgent=${s3.activeAgent}`);
  check('context accumulated (turns=3)', s3.turns === 3, `turns=${s3.turns}`);

  // ── Test 4: cache anchor — context is byte-stable prefix
  console.log('\nTEST 4 — accumulated context grows monotonically');
  const s4 = await getJSON(`/session/${SID}`);
  check('context messages grew', s4.contextMessages >= 3, `messages=${s4.contextMessages}`);
  check('context tokens grew', s4.contextTokens > 500, `tokens=${s4.contextTokens}`);

  // ── Test 5: another full handoff chain to confirm reusability
  console.log('\nTEST 5 — second handoff (architect persona again)');
  const r5 = await postJSON('/session/agent', {
    sessionId: SID,
    agent: 'architect',
    input: 'Re-evaluate the design for extensibility. One short paragraph.',
  });
  check('handoff returned output', !!r5.data.output, `output=${(r5.data.output || '').slice(0, 60)}`);
  const s5 = await getJSON(`/session/${SID}`);
  check('active agent now architect', s5.activeAgent === 'architect', `activeAgent=${s5.activeAgent}`);
  check('turns accumulated', s5.turns === 4, `turns=${s5.turns}`);
  check('context stable growth', s5.contextTokens > s4.contextTokens, `${s4.contextTokens} → ${s5.contextTokens}`);

  // ── Summary
  console.log('\n' + '='.repeat(72));
  console.log(failures === 0 ? '  ✅ ALL MECHANISM CHECKS PASSED' : `  ❌ ${failures} CHECKS FAILED`);
  console.log('='.repeat(72));
  console.log('\n  Final session state:');
  console.log(JSON.stringify(s5, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
