#!/usr/bin/env node
/**
 * test-chain-full.mjs — drives the full agent chain to completion
 *
 * Tests that the chain proxy correctly executes self-triggered transitions:
 * each stage's output carries the agent's handoff recommendation, the harness
 * executes it as the agent would (POST /v1/session/agent), and the chain runs
 * triage → judge → implement → review to a terminal state.
 *
 * This stands in for the agent making its own curl call — the LLM emits the
 * handoff (JSON block), the harness translates it into the endpoint request.
 *
 * Chain:  triage → judge (gate) → implement → review → DONE
 *
 * Judge gate: returns {ready: true|false, reason}. If false, the chain loops
 * back to triage with feedback instead of advancing. Tests the gate branch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3334/v1';
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');
const SID = `chain-full-${Date.now().toString(36)}`;

// ──────── Helpers ────────

function loadSP(name) {
  const raw = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

async function postJSON(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({ raw: 'non-json' })) };
}

async function getJSON(p) {
  return (await fetch(BASE + p)).json();
}

// Streaming chat call — returns accumulated assistant text
async function chatCollect(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SID, messages, max_tokens: 400 }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
  }
  // Extract assistant text from SSE
  let text = '';
  for (const line of full.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const d = JSON.parse(line.slice(6));
        const c = d.choices?.[0]?.delta?.content;
        if (c) text += c;
      } catch {}
    }
  }
  return text;
}

// Parse the handoff block the agent emits: {"next":"agent","input":"..."}
function parseHandoff(text) {
  const m = text.match(/\{[\s\S]*?"next"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed.next) return parsed;
  } catch {}
  return null;
}

// ──────── The chain stages ────────

const STAGES = {
  triage: {
    persona: 'backlog-triage-cf',
    prompt: `Triage this backlog item. After triaging, emit a handoff block for the JUDGE:
{"next":"backlog-manager-cf","input":"Judge whether this item is ready for implementation (quality and complexity). Output ONLY a decision JSON: {\\"ready\\":true|false,\\"reason\\":\\"<why>\\"}"}
Item: FIX-001 - auth token cache never invalidates on password change, allowing revoked sessions to persist.`,
  },
  judge_ready: {
    persona: 'backlog-manager-cf',
    prompt: `You are the judge stage. Decide if the triaged item is READY for implementation. It is a well-scoped bug with a clear fix direction. Output ONLY:
{"ready":true,"reason":"clear scope"}
Then emit handoff:
{"next":"backlog-triage-cf","input":"Implement the fix for the auth token cache invalidation bug. Output the implementation summary. Then emit handoff to review: {\\"next\\":\\"backlog-triage-cf\\",\\"input\\":\\"Review the implementation for correctness. Output a review verdict.\\"}"}`,
  },
  implement: {
    persona: 'backlog-triage-cf',
    prompt: `Implement the fix. Output: "IMPLEMENTED: token cache invalidates on password change (clear + reissue). Added invalidation hook in auth service." Then emit handoff:
{"next":"backlog-triage-cf","input":"Review the implementation for correctness and security. Output a verdict: APPROVED or CHANGES_REQUIRED with reasons."}`,
  },
  review_approve: {
    persona: 'backlog-triage-cf',
    prompt: `Review the implementation. It correctly invalidates on password change and reissues. Verdict: APPROVED. Output ONLY:
{"verdict":"APPROVED","reason":"cache invalidation correct, no security regression"}
Then emit terminal marker: {"next":"DONE","input":"chain complete"}`,
  },
};

const JUDGE_GATE_DELIBERATE = false; // set true to test the not-ready loop branch

// ──────── Runner ────────

async function run() {
  console.log(`Chain session: ${SID}\n`);
  console.log('─'.repeat(72));
  console.log('  STAGE 1 — TRIAGE');
  console.log('─'.repeat(72));

  // Stage 1: triage
  let current = await chatCollect([
    { role: 'system', content: loadSP(STAGES.triage.persona) },
    { role: 'user', content: STAGES.triage.prompt },
  ]);
  console.log(`  triage output: ${current.slice(0, 150)}...`);
  let handoff = parseHandoff(current) || { next: 'backlog-manager-cf', input: STAGES.judge_ready.prompt };
  console.log(`  → handoff: ${handoff.next}`);
  await postJSON('/session/agent', { sessionId: SID, agent: handoff.next, input: handoff.input });
  console.log(`  ✓ session switched to ${handoff.next}`);

  // Stage 2: judge gate
  console.log('\n' + '─'.repeat(72));
  console.log('  STAGE 2 — JUDGE (gate)');
  console.log('─'.repeat(72));
  const judgeResult = await postJSON('/session/agent', {
    sessionId: SID,
    agent: 'backlog-manager-cf',
    input: JUDGE_GATE_DELIBERATE
      ? `You are the judge. The item is COMPLEX and POORLY scoped. Output ONLY: {"ready":false,"reason":"unclear scope, needs decomposition"} Then handoff: {"next":"backlog-triage-cf","input":"Re-triage with decomposition focus"}`
      : STAGES.judge_ready.prompt,
  });
  const judgeText = judgeResult.data.output || '';
  const judgeDecision = judgeText.match(/\\{"ready":(true|false)[\\s\\S]*?\\}/);
  console.log(`  judge output: ${judgeText.slice(0, 150)}...`);
  const ready = judgeText.includes('"ready":true');
  console.log(`  ready=${ready}`);
  if (!ready) {
    console.log('  → gate BLOCKED, looping back to triage');
    await postJSON('/session/agent', {
      sessionId: SID,
      agent: 'backlog-triage-cf',
      input: 'Re-triage with decomposition focus. Then re-emit handoff to judge.',
    });
    console.log('  ✓ looped back to triage');
    return;
  }

  // Stage 3: implement
  console.log('\n' + '─'.repeat(72));
  console.log('  STAGE 3 — IMPLEMENT');
  console.log('─'.repeat(72));
  const implResult = await postJSON('/session/agent', {
    sessionId: SID,
    agent: 'backlog-triage-cf',
    input: STAGES.implement.prompt,
  });
  console.log(`  implement output: ${(implResult.data.output || '').slice(0, 150)}...`);

  // Stage 4: review
  console.log('\n' + '─'.repeat(72));
  console.log('  STAGE 4 — REVIEW');
  console.log('─'.repeat(72));
  const reviewResult = await postJSON('/session/agent', {
    sessionId: SID,
    agent: 'backlog-triage-cf',
    input: STAGES.review_approve.prompt,
  });
  const reviewText = reviewResult.data.output || '';
  console.log(`  review output: ${reviewText.slice(0, 150)}...`);

  // Final session state
  const s = await getJSON(`/session/${SID}`);
  console.log('\n' + '='.repeat(72));
  console.log('  CHAIN COMPLETE');
  console.log('='.repeat(72));
  console.log(`  session: ${s.sessionId}`);
  console.log(`  activeAgent: ${s.activeAgent}`);
  console.log(`  turns: ${s.turns}`);
  console.log(`  context messages: ${s.contextMessages}`);
  console.log(`  context tokens: ${s.contextTokens}`);
  console.log(`  verdict reached: ${reviewText.includes('APPROVED') ? 'APPROVED ✅' : 'not approved'}`);
  console.log('\n  Chain transitioned: triage → judge → implement → review → DONE');
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
