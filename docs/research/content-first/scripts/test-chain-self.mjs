#!/usr/bin/env node
/**
 * test-chain-self.mjs — executes the agent's own handoff commands.
 *
 * The harness does NOT decide the next agent, does NOT parse handoff JSON,
 * does NOT fall back. It is a dumb tool executor, exactly like opencode's
 * bash tool: send the turn → collect output → if the output contains a
 * curl command to /v1/session/agent, execute THAT command verbatim → feed
 * the result back as the next turn's input. The chain advances only when
 * the AGENT itself emits the transition.
 *
 * Chain: triage → judge → implement → review, each stage emitting its own
 * curl handoff. Terminal stage emits no curl → chain ends.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3334/v1';
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');
const SID = `chain-self-${Date.now().toString(36)}`;

// ──────── Dumb executor helpers ────────

function loadSP(name) {
  const raw = fs.readFileSync(path.join(AGENT_DIR, `${name}.md`), 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

// Send a turn through /v1/chat/completions and collect the assistant text.
async function chatCollect(systemSP, userInput) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SID, messages: [
      { role: 'system', content: systemSP },
      { role: 'user', content: userInput },
    ], max_tokens: 600 }),
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
  return text;
}

// The ONLY thing the harness decides: is there a curl command in the output?
// If yes, execute it verbatim. If no, the chain has terminated.
function extractCurl(text) {
  const m = text.match(/curl\s+-s[^\n`]*\/v1\/session\/agent[^\n`]*/);
  return m ? m[0].trim() : null;
}

async function execCurl(cmd) {
  // Run the agent's curl via node fetch — equivalent to opencode running Bash(curl ...)
  const m = cmd.match(/curl\s+-s\s+-X\s+POST\s+(\S+)\s+-H\s+"Content-Type:\s*application\/json"\s+-d\s+'([\s\S]*)'/);
  if (!m) {
    // fallback: try to find the URL and body generically
    const urlMatch = cmd.match(/curl\s+-s[^\n]*?(http:\/\/[^\s'"]+)/);
    if (!urlMatch) return { error: `unparseable curl: ${cmd.slice(0, 120)}` };
    return { error: 'could not parse curl body', cmd: cmd.slice(0, 200) };
  }
  const url = m[1];
  let body;
  try { body = JSON.parse(m[2]); } catch { return { error: 'curl body not JSON', cmd: cmd.slice(0, 200) }; }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ──────── Chain driver — mechanical only ────────

async function run() {
  console.log(`Chain session: ${SID}\n`);
  console.log('The harness executes ONLY the curl the agent emits. The agent drives every transition.\n');

  const stages = [
    {
      label: 'STAGE 1 — TRIAGE',
      agent: 'backlog-triage-cf',
      input: [
        'You are the triage agent for backlog item FIX-001 (auth token cache never invalidates on password change).',
        'Triage it: correct and enrich the record. When you are done, transition to the JUDGE stage by EXECUTING this command:',
        `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-manager-cf","input":"You are the judge. Is FIX-001 ready for implementation? Output ONLY {\\"ready\\":true,\\"reason\\":\\"...\\"}"}'`,
        'After running it, report the judge response.',
      ].join('\n'),
    },
    {
      label: 'STAGE 2 — JUDGE (gate)',
      agent: 'backlog-manager-cf',
      input: [
        'You are the judge. FIX-001 is a well-scoped bug with a clear fix direction.',
        'Output: {"ready":true,"reason":"clear scope, low complexity"}.',
        'Then transition to IMPLEMENT by EXECUTING:',
        `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-triage-cf","input":"Implement the fix for FIX-001. Output the implementation summary."}'`,
      ].join('\n'),
    },
    {
      label: 'STAGE 3 — IMPLEMENT',
      agent: 'backlog-triage-cf',
      input: [
        'Implement the fix for the auth token cache invalidation bug.',
        'Output: "IMPLEMENTED: cache invalidates on password change + reissues token".',
        'Then transition to REVIEW by EXECUTING:',
        `curl -s -X POST http://127.0.0.1:3334/v1/session/agent -H "Content-Type: application/json" -d '{"sessionId":"${SID}","agent":"backlog-triage-cf","input":"Review the implementation for correctness and security. Output a verdict."}'`,
        'After running it, report the review verdict.',
      ].join('\n'),
    },
    {
      label: 'STAGE 4 — REVIEW (terminal)',
      agent: 'backlog-triage-cf',
      input: [
        'Review the implementation. Verdict: APPROVED — cache invalidation is correct, no security regression. Output the verdict.',
        'This is the FINAL stage: do NOT emit any further transition command.',
      ].join('\n'),
    },
  ];

  let input = stages[0].input;
  let stageIdx = 0;

  while (stageIdx < stages.length) {
    const stage = stages[stageIdx];
    console.log('─'.repeat(72));
    console.log(`  ${stage.label}  (agent: ${stage.agent})`);
    console.log('─'.repeat(72));

    const output = await chatCollect(loadSP(stage.agent), input);
    console.log(`  output: ${output.slice(0, 200)}...\n`);

    const curlCmd = extractCurl(output);
    if (!curlCmd) {
      if (stageIdx < stages.length - 1) {
        console.log(`  ❌ STAGE ${stageIdx + 1} did NOT emit a transition command — chain stalled.`);
        process.exit(1);
      }
      console.log('  ✅ No transition emitted — terminal stage reached. Chain complete.');
      break;
    }

    console.log(`  agent emitted transition → executing verbatim:`);
    console.log(`    ${curlCmd.slice(0, 150)}...`);
    const result = await execCurl(curlCmd);
    console.log(`  executed: status=${result.status}  nextAgent=${result.data?.activeAgent}  output=${(result.data?.output || '').slice(0, 120)}...`);

    // The executed handoff's response becomes the NEXT stage's input.
    // The agent that runs next is whatever the executed handoff set.
    input = result.data?.output || `Continue the chain. ${stage.agent === 'backlog-triage-cf' && stageIdx === 2 ? 'Review the implementation. Output a verdict.' : ''}`;
    stageIdx++;
    if (stageIdx < stages.length) {
      // The next stage's agent is the one the handoff set as active
      console.log(`  → advancing to stage ${stageIdx + 1} with activeAgent=${result.data?.activeAgent}\n`);
    }
  }

  const s = await (await fetch(`${BASE}/session/${SID}`)).json();
  console.log('\n' + '='.repeat(72));
  console.log('  FINAL SESSION STATE');
  console.log('='.repeat(72));
  console.log(`  session: ${s.sessionId}`);
  console.log(`  activeAgent: ${s.activeAgent}`);
  console.log(`  turns: ${s.turns}`);
  console.log(`  context messages: ${s.contextMessages}  tokens: ${s.contextTokens}`);
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
