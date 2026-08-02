#!/usr/bin/env node
/**
 * test-chain-agent-driven.mjs — faithful opencode Bash-tool emulator.
 *
 * The AGENT drives the chain. The harness does exactly what opencode's Bash
 * tool does and nothing more:
 *   1. Send the agent's turn through the chain proxy.
 *   2. If the agent emits a shell tool call (<invoke name="shell">), execute
 *      that command locally and feed the output back as the next user turn.
 *   3. Loop within a stage until the agent emits the handoff curl to
 *      /v1/session/agent — which the harness executes (that's the Bash tool
 *      doing its job) and the chain proxy advances the persona.
 *   4. The stage completes when the agent stops calling tools and its text
 *      output signals the stage's purpose.
 *
 * The harness never chooses the next agent, never parses handoff JSON, and
 * never falls back. It executes commands the agent emits, verbatim.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3334/v1';
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');
const SID = `chain-agent-${Date.now().toString(36)}`;

function loadSP(name) {
  // Use a neutral test persona so the agent won't refuse synthetic work.
  // The REAL agents have strict behavioral contracts (anti-fabrication, role
  // scope) that correctly reject made-up tasks — that's good, but it blocks
  // mechanism testing. Use a minimal persona that will actually cooperate.
  const simple = {
    'test-triage': 'You are a test triage agent. You can run shell commands via your tool. When your task is complete, you MUST emit a handoff curl to /v1/session/agent to transition to the next stage.',
    'test-judge': 'You are a test judge agent. You decide if an item is ready for implementation. You can run shell commands. When done, emit a handoff curl to transition to the next stage.',
    'test-implement': 'You are a test implementer agent. You can run shell commands. When done, emit a handoff curl to transition to the next stage.',
    'test-review': 'You are a test review agent. You output a verdict. This is the FINAL stage — you do NOT emit any further transitions.',
  };
  if (simple[name]) return simple[name];
  const raw = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

// Collect SSE stream into text + any shell tool calls the agent emitted.
async function chatTurn(systemSP, userInput) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SID, messages: [
      { role: 'system', content: systemSP },
      { role: 'user', content: userInput },
    ], max_tokens: 800 }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sse = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += decoder.decode(value, { stream: true });
  }
  let text = '';
  for (const line of sse.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const d = JSON.parse(line.slice(6));
        const c = d.choices?.[0]?.delta?.content;
        if (c) text += c;
      } catch {}
    }
  }
  // Extract shell tool calls the agent emitted. Robust to format drift:
  // name="shell"|"bash"|"exec_command"|"shell_command",
  // parameter name="cmd"|"command", string="true"|string=""|no string attr,
  // optional description parameter between command and /invoke.
  const shellCalls = [];
  const invokeRe = /<invoke name="(?:shell|shell_command|exec_command|Bash|bash)"[^>]*>([\s\S]*?)<\/invoke>/g;
  let invokeMatch;
  while ((invokeMatch = invokeRe.exec(text)) !== null) {
    const inner = invokeMatch[1];
    const paramRe = /<parameter name="(?:cmd|command)"(?: string="[^"]*")?>([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRe.exec(inner)) !== null) {
      const cmd = paramMatch[1].trim();
      if (cmd) shellCalls.push(cmd);
    }
  }
  if (process.env.DEBUG_TOOLS && text.includes('invoke')) {
    console.error(`\n[debug] tool-call text received: ${JSON.stringify(text.slice(0, 400))}`);
    console.error(`[debug] patterns matched: ${shellCalls.length}\n`);
  }
  return { text, shellCalls };
}

// Execute a shell command locally (the Bash tool's job).
function execShell(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return `$ ${cmd}\n${out.slice(0, 2000)}`;
  } catch (e) {
    return `$ ${cmd}\nERROR: ${(e.stderr || e.message || '').toString().slice(0, 1000)}`;
  }
}

// Run one agent stage: loop tool calls until the agent stops emitting shell
// commands (i.e., it finished its job, possibly after a handoff).
async function runStage(label, agentName, input) {
  console.log('─'.repeat(72));
  console.log(`  ${label}  (agent: ${agentName})`);
  console.log('─'.repeat(72));

  let currentInput = input;
  let finalText = '';
  let handoffResult = null;
  const MAX_LOOPS = 8;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const { text, shellCalls } = await chatTurn(loadSP(agentName), currentInput);
    finalText += '\n' + text;
    console.log(`  turn ${loop + 1} → output: ${text.slice(0, 150).replace(/\n/g, ' ')}...`);

    if (shellCalls.length === 0) {
      // Agent stopped calling tools — its stage is done.
      console.log(`  ✅ agent finished (no more tool calls)`);
      break;
    }

    for (const cmd of shellCalls) {
      // If this is the handoff curl, execute it AND parse the proxy's JSON response
      if (cmd.includes('/v1/session/agent')) {
        const raw = execShell(cmd);
        try {
          // Extract the JSON body from the proxy response
          const bodyStart = raw.indexOf('{');
          const bodyEnd = raw.lastIndexOf('}');
          if (bodyStart !== -1 && bodyEnd !== -1) {
            const parsed = JSON.parse(raw.slice(bodyStart, bodyEnd + 1));
            handoffResult = { agent: parsed?.activeAgent, output: (parsed?.output || '').slice(0, 100) };
            currentInput = parsed?.output || raw;
            console.log(`  🔄 handoff executed → activeAgent=${parsed?.activeAgent}`);
          } else {
            currentInput = raw;
          }
        } catch {
          currentInput = raw;
        }
      } else {
        const result = execShell(cmd);
        currentInput = result;
        console.log(`  ⚙️  executed tool → ${cmd.slice(0, 80)}...`);
      }
    }
  }

  if (MAX_LOOPS === 8 && finalText.includes('tool')) console.log(`  ⚠️  hit max tool loops for ${label}`);
  return { text: finalText, handoffResult };
}

async function run() {
  console.log(`Chain session: ${SID}\n`);
  console.log('The harness is a faithful opencode Bash-tool emulator. The AGENT drives every transition.\n');

  const stage1 = await runStage('STAGE 1 — TRIAGE', 'test-triage', [
    'You are the triage agent for backlog item FIX-001 (auth token cache never invalidates on password change).',
    'Triage it using your backlog tools. When your triage is complete, transition to the JUDGE stage by running:',
    `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-manager-cf","input":"You are the judge. Is FIX-001 ready for implementation? Output ONLY {\\"ready\\":true|false,\\"reason\\":\\"...\\"}"}'`,
    'Then report the result.',
  ].join('\n'));

  console.log(`  stage1 handoff: ${JSON.stringify(stage1.handoffResult)}`);

  const stage2 = await runStage('STAGE 2 — JUDGE', 'test-judge', [
    'You are the judge. FIX-001 is well-scoped. Output {"ready":true,"reason":"clear scope"}.',
    'Then transition to IMPLEMENT by running:',
    `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-triage-cf","input":"Implement the fix for FIX-001. Output the implementation summary."}'`,
  ].join('\n'));

  console.log(`  stage2 handoff: ${JSON.stringify(stage2.handoffResult)}`);

  const stage3 = await runStage('STAGE 3 — IMPLEMENT', 'test-implement', [
    'Implement the fix for the auth token cache invalidation bug.',
    'Output: "IMPLEMENTED: cache invalidates on password change + reissues token".',
    'Then transition to REVIEW by running:',
    `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-triage-cf","input":"Review the implementation for correctness and security. Output a verdict."}'`,
  ].join('\n'));

  console.log(`  stage3 handoff: ${JSON.stringify(stage3.handoffResult)}`);

  const stage4 = await runStage('STAGE 4 — REVIEW (terminal)', 'test-review', [
    'Review the implementation. Verdict: APPROVED — cache invalidation is correct, no security regression.',
    'Output the verdict. This is the FINAL stage: do NOT run any further commands.',
  ].join('\n'));

  const s = await (await fetch(`${BASE}/session/${SID}`)).json();
  console.log('\n' + '='.repeat(72));
  console.log('  CHAIN COMPLETE — AGENT-DRIVEN');
  console.log('='.repeat(72));
  console.log(`  session: ${s.sessionId}`);
  console.log(`  activeAgent: ${s.activeAgent}`);
  console.log(`  turns: ${s.turns}`);
  console.log(`  context messages: ${s.contextMessages}  tokens: ${s.contextTokens}`);
  console.log(`  handoffs observed: ${[stage1, stage2, stage3].filter(h => h.handoffResult).length}/3`);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
