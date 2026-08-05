#!/usr/bin/env node
/**
 * verify-split.mjs — Test that splitSystemPrompt correctly separates
 * shared boilerplate from agent-specific role content.
 *
 * Uses the REAL splitSystemPrompt from cf-rewrite.mjs (no inline copy — the
 * old inline copy rotted when the function moved; this was "Split FAIL: 2"
 * testing a dead function against a stale untracked fixture).
 *
 * Validates against CURRENT per-session logs: raw_request.full_body.messages
 * (system prompt at role=system). Usage:
 *   node verify-split.mjs [proxy-ses_<id>.jsonl]
 *   node verify-split.mjs --selftest   (no log file needed)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { splitSystemPrompt } from './cf-rewrite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Real agent bodies (registry) — for the selftest assertions ──
const AGENT_DIR = path.join(process.env.HOME || '/Users/nix', '.config', 'opencode', 'agents');
const _agentBodies = [];
try {
  for (const file of fs.readdirSync(AGENT_DIR)) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
    const body = raw.replace(/^---[\s\S]*?---\n+/, '').trim();
    if (body.length > 100) _agentBodies.push({ name: file.replace('.md', ''), body });
  }
} catch (e) { console.error('Failed to load agents:', e.message); }

// ── Extract (system, user_last) pairs from a CURRENT per-session log ──
// Current format: raw_request.full_body.messages[] with role=system first.
function extractRequests(logFile) {
  const requests = [];
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    let messages = null;
    if (d.event === 'raw_request' && d.full_body?.messages) messages = d.full_body.messages;
    else if (d.messages) messages = d.messages; // legacy flat format
    if (!messages) continue;
    const sys = messages.find(m => m.role === 'system');
    if (!sys) continue;
    const userMsgs = messages.filter(m => m.role === 'user');
    requests.push({
      system: typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content),
      user_last: userMsgs.length ? (typeof userMsgs[userMsgs.length - 1].content === 'string'
        ? userMsgs[userMsgs.length - 1].content : JSON.stringify(userMsgs[userMsgs.length - 1].content)) : '',
    });
  }
  return requests;
}

// ── Self-test: no log file required. Builds synthetic SPs from the real
//    agent registry and asserts the split contract. ──
function selftest() {
  let pass = 0, fail = 0;
  const results = [];
  for (const agent of _agentBodies.slice(0, 6)) {
    const shared = '# Shared boilerplate\n## Rules\n- never write outside worktree\n\n## Disclosure\n- log bugs to BACKLOG.md\n';
    const sp = `${agent.body}\n\n${shared}`;
    const r = splitSystemPrompt(sp, new Map(_agentBodies.map(a => [a.name, { systemPrompt: a.body }])));
    const ok = r.agentRole.length > 0 && r.shared.includes('Shared boilerplate');
    const method = r.agentRole.length > 50 ? 'matched' : 'fallback';
    results.push({ agent: agent.name, ok, roleLen: r.agentRole.length, sharedLen: r.shared.length, method });
    ok ? pass++ : fail++;
  }
  console.log(`\n── Self-test (${pass + fail} agent SPs, no log file) ──`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.agent}: role=${r.roleLen}c shared=${r.sharedLen}c (${r.method})`);
  }
  console.log(`Self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ── Main ──
if (process.argv[2] === '--selftest') {
  process.exit(selftest() ? 0 : 1);
}

const logFile = process.argv[2];
if (!logFile) {
  // No arg: use the most recent per-session log in proxy/
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.jsonl') && f.startsWith('proxy-ses_'))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error('No per-session proxy log files found. Pass one explicitly, or use --selftest.');
    process.exit(1);
  }
  process.argv.push(path.join(__dirname, files[0]));
}

const requests = extractRequests(process.argv[2]);
console.log(`\nLoaded ${requests.length} requests from ${process.argv[2]}`);

let ok = 0, failed = 0;
const agentMap = new Map(_agentBodies.map(a => [a.name, { systemPrompt: a.body }]));

for (let i = 0; i < requests.length; i++) {
  const { system, user_last } = requests[i];
  const result = splitSystemPrompt(system, agentMap);
  const isMatch = result.agentRole.length > 50;
  console.log(`Request ${i}: method=${isMatch ? 'matched' : 'fallback'} | shared=${result.shared.length}c role=${result.agentRole.length}c`);
  if (isMatch) {
    console.log(`  ✅ SPLIT OK — role NOT in system: ${!system.includes(result.agentRole.slice(0, 30))}`);
    ok++;
  } else {
    console.log(`  ❌ SPLIT FAILED — system=${system.length}c`);
    failed++;
  }
}

console.log(`\n--- Summary ---`);
console.log(`Total requests: ${requests.length}`);
console.log(`Split OK:       ${ok}`);
console.log(`Split FAIL:     ${failed}`);
process.exit(failed === 0 ? 0 : 1);
