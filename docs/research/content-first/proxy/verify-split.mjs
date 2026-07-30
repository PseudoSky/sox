#!/usr/bin/env node
/**
 * verify-split.mjs — Test that splitSystemPrompt correctly separates
 * shared boilerplate from agent-specific role content.
 *
 * Usage: node proxy/verify-split.mjs [proxy-cf-v4-flash.jsonl]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Copy of splitSystemPrompt from cf-proxy.mjs ──

const AGENT_DIR = path.join(process.env.HOME || '/Users/nix', '.config', 'opencode', 'agents');

function loadAgentBodies() {
  const agents = [];
  try {
    for (const file of fs.readdirSync(AGENT_DIR)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
      const body = raw.replace(/^---[\s\S]*?---\n+/, '').trim();
      if (body.length > 100) agents.push({ name: file.replace('.md', ''), body });
    }
  } catch (e) { console.error('Failed to load agents:', e.message); }
  return agents;
}
const _agentBodies = loadAgentBodies();

function splitSystemPrompt(system) {
  if (!system) return { shared: '', agentRole: '', method: 'empty' };

  let bestMatch = '';
  let bestName = '';
  for (const agent of _agentBodies) {
    if (system.startsWith(agent.body)) {
      if (agent.body.length > bestMatch.length) {
        bestMatch = agent.body;
        bestName = agent.name;
      }
    }
  }

  if (bestMatch.length > 50) {
    return {
      agentRole: bestMatch,
      shared: system.slice(bestMatch.length).trim(),
      method: `matched agent "${bestName}" (${bestMatch.length} chars)`,
    };
  }

  return { shared: '', agentRole: system, method: 'fallback (no match)' };
}

// ── Main ──

const logFile = process.argv[2];
if (!logFile) {
  // No arg: use the latest proxy log from proxy/ dir
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.jsonl') && f.startsWith('proxy-'))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error('No proxy log files found. Usage: verify-split.mjs <jsonl-file>');
    process.exit(1);
  }
  // Use the latest one
  process.argv.push(path.join(__dirname, files[0]));
}

const data = fs.readFileSync(process.argv[2], 'utf8');
const lines = data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

console.log(`\nLoaded ${lines.length} calls from ${process.argv[2]}\n`);

for (let i = 0; i < lines.length; i++) {
  const d = lines[i];
  const system = d.system || '';
  const result = splitSystemPrompt(system);

  console.log(`Call ${i}: ${d.passthrough ? 'RF (passthrough)' : 'CF (rewrite)'}  depth=${d.conversation_depth}`);
  console.log(`  Method: ${result.method}`);

  // Check where the agent role lands in the forwarded messages
  const userStart = d.user_first || '';
  const userEnd = d.user_last || '';

  if (result.method.startsWith('matched')) {
    const roleInUser = !d.passthrough && userEnd.includes(result.agentRole.slice(0, 20));
    const roleInSystem = result.agentRole && system.includes(result.agentRole.slice(0, 20));

    console.log(`  ✅ SPLIT OK`);
    console.log(`     Shared boilerplate: ${result.shared.length} chars (${Math.round(result.shared.length / 4)}t)`);
    console.log(`     Agent role:         ${result.agentRole.length} chars (${Math.round(result.agentRole.length / 4)}t)`);
    console.log(`     System start: ${result.shared.slice(0, 80).replace(/\n/g, ' ')}`);
    console.log(`     System end:   ...${result.shared.slice(-80).replace(/\n/g, ' ')}`);

    // Confirm agent role is in user message (not in system prompt)
    if (roleInSystem) {
      console.log(`  ❌ Agent role FOUND in system prompt — split reversed?`);
    } else {
      console.log(`  ✅ Agent role NOT in system prompt`);
    }
    if (roleInUser) {
      console.log(`  ✅ Agent role CONFIRMED at end of user message:`);
      console.log(`     ...${userEnd.replace(/\n/g, ' ')}`);
    } else {
      console.log(`  ⚠️  Could not confirm agent role in user_last, checking user_first...`);
      // The role might be long; check if user_start starts with the task
      console.log(`     user_start: ${userStart.replace(/\n/g, ' ')}`);
    }
  } else {
    console.log(`  ❌ SPLIT FAILED`);
    console.log(`     System prompt: ${system.length} chars`);
    console.log(`     First 80: ${system.slice(0, 80).replace(/\n/g, ' ')}`);
  }

  // Token numbers from the proxy
  if (d.cf_tokens) {
    console.log(`     Tokens: ${d.cf_tokens}t in, ${d.cf_cached}t cached (${d.cf_output}t out)`);
  }
  if (d.rf_tokens) {
    console.log(`     Tokens: ${d.rf_tokens}t in, ${d.rf_cached}t cached (${d.rf_output}t out)`);
  }
  console.log('');
}

// Summary
const withSplit = lines.filter(l => splitSystemPrompt(l.system || '').method.startsWith('matched'));
const failed = lines.filter(l => !splitPrompt(l.system || '').method.startsWith('matched'));

function splitPrompt(s) { return splitSystemPrompt(s); }

console.log(`--- Summary ---`);
console.log(`Total calls: ${lines.length}`);
console.log(`Split OK:    ${withSplit.length}`);
console.log(`Split FAIL:  ${failed.length}`);

if (withSplit.length > 0) {
  const avgRole = withSplit.reduce((s, l) => s + splitPrompt(l.system).agentRole.length, 0) / withSplit.length;
  const avgShared = withSplit.reduce((s, l) => s + splitPrompt(l.system).shared.length, 0) / withSplit.length;
  console.log(`Avg agent role:     ${Math.round(avgRole)} chars (${Math.round(avgRole / 4)}t)`);
  console.log(`Avg shared boilerplate: ${Math.round(avgShared)} chars (${Math.round(avgShared / 4)}t)`);
  console.log(`Avg savings per agent switch: ${Math.round(avgShared / (avgRole + avgShared) * 100)}% of prompt cached`);
}
