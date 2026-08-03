#!/usr/bin/env node
/**
 * aggregate-session.mjs — Aggregate per-stage metrics from CF or RF run sessions.
 *
 * Usage:
 *   node aggregate-session.mjs <session-id>          # auto-detect CF or RF
 *   node aggregate-session.mjs --rf <dispatcher-id>  # aggregate RF dispatcher + all sub-sessions
 *   node aggregate-session.mjs --cf <session-id>     # aggregate single CF session
 *   node aggregate-session.mjs --json <session-id>   # JSON output for programmatic use
 *
 * For RF: finds the dispatcher session and all subagent session files (by
 * reading the dispatcher's task dispatch output), then aggregates across all.
 *
 * For CF: reads the single session's proxy-ses_*.jsonl file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(entry) {
  try { return JSON.parse(entry); } catch { return null; }
}

function loadSessionTurns(sessionId) {
  const f = path.join(__dirname, `proxy-ses_${sessionId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const turns = [];
  const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    const d = log(line);
    if (d && d.event === 'turn') turns.push(d);
  }
  return turns;
}

function findRelatedSessions(sessionId) {
  // For RF: the dispatcher creates subagent sessions.
  // Subagent session files are named proxy-ses_<subagent-id>.jsonl.
  // We find them by scanning the proxy dir for session files created around
  // the same time window as the dispatcher session.
  const dir = __dirname;
  const dispatcherFile = path.join(dir, `proxy-ses_${sessionId}.jsonl`);
  if (!fs.existsSync(dispatcherFile)) return [sessionId];

  // Get dispatcher time window
  const dispatcherTurns = loadSessionTurns(sessionId);
  if (dispatcherTurns.length === 0) return [sessionId];

  const firstTs = dispatcherTurns[0]._ts;
  const lastTs = dispatcherTurns[dispatcherTurns.length - 1]._ts;
  const windowStart = new Date(firstTs).getTime() - 60000; // 1 min before
  const windowEnd = new Date(lastTs).getTime() + 300000;   // 5 min after

  // Find all session files created in this window
  const sessionFiles = fs.readdirSync(dir)
    .filter(f => f.startsWith('proxy-ses_') && f.endsWith('.jsonl'))
    .filter(f => !f.includes('test_'));

  const related = [sessionId];
  for (const f of sessionFiles) {
    const sid = f.replace('proxy-ses_', '').replace('.jsonl', '');
    if (sid === sessionId) continue;
    const stat = fs.statSync(path.join(dir, f));
    const mtime = stat.mtimeMs;
    if (mtime >= windowStart && mtime <= windowEnd) {
      related.push(sid);
    }
  }

  return related;
}

function aggregateTurns(turns) {
  const stages = {};

  for (const t of turns) {
    const agent = t.agent || '(unassigned)';
    if (agent === '(unassigned)') continue;
    if (!stages[agent]) {
      stages[agent] = {
        turns: 0, tokens: 0, cached: 0, output: 0,
        shared_chars: 0, persona_chars: 0, context_chars: 0,
        persona_turns: 0, persona_ctx_chars: 0,
        first_turn_tokens: null, first_turn_cached: null,
        first_turn_savings: null,
      };
    }
    const s = stages[agent];
    s.turns++;
    s.tokens += (t.tokens || 0);
    s.cached += (t.cached || 0);
    s.output += (t.output || 0);
    s.shared_chars += (t.shared_chars || 0);
    s.persona_chars += (t.persona_chars || 0);
    s.context_chars += (t.context_chars || 0);
    s.persona_turns = Math.max(s.persona_turns, t.persona_turns || 0);
    s.persona_ctx_chars = Math.max(s.persona_ctx_chars, t.persona_ctx_chars || 0);

    // First turn detection: agent changed from prior turn
    if (s.first_turn_tokens === null) {
      s.first_turn_tokens = t.tokens || 0;
      s.first_turn_cached = t.cached || 0;
      s.first_turn_savings = (t.tokens || 0) > 0
        ? ((t.cached || 0) / (t.tokens || 1) * 100).toFixed(1)
        : '0.0';
    }
  }
  return stages;
}

function formatTable(stages, label) {
  const lines = [];
  lines.push(`\n=== ${label} ===`);
  lines.push(`${'Stage'.padEnd(14)} ${'Turns'.padStart(5)} ${'Tokens'.padStart(12)} ${'Cached'.padStart(12)} ${'Sav%'.padStart(6)} ${'1stSav'.padStart(7)} ${'Shared'.padStart(10)} ${'Persona'.padStart(10)} ${'Ctx'.padStart(10)}`);
  lines.push('-'.repeat(96));

  let totalTurns = 0, totalTok = 0, totalCached = 0, totalOut = 0;
  let totalShared = 0, totalPersona = 0, totalCtx = 0;
  let handoffPenalty = 0;

  for (const [agent, s] of Object.entries(stages)) {
    const sav = s.tokens > 0 ? (s.cached / s.tokens * 100).toFixed(1) : '?';
    const firstSav = s.first_turn_savings || '?';
    const sharedK = (s.shared_chars / 1000).toFixed(0);
    const personaK = (s.persona_chars / 1000).toFixed(0);
    const ctxK = (s.context_chars / 1000).toFixed(0);
    lines.push(`${agent.padEnd(14)} ${String(s.turns).padStart(5)} ${String(s.tokens.toLocaleString()).padStart(12)} ${String(s.cached.toLocaleString()).padStart(12)} ${String(sav).padStart(5)}% ${String(firstSav).padStart(6)}% ${String(sharedK).padStart(9)}K ${String(personaK).padStart(9)}K ${String(ctxK).padStart(9)}K`);
    totalTurns += s.turns;
    totalTok += s.tokens;
    totalCached += s.cached;
    totalOut += s.output;
    totalShared += s.shared_chars;
    totalPersona += s.persona_chars;
    totalCtx += s.context_chars;
    if (s.first_turn_cached !== null) {
      handoffPenalty += (s.first_turn_tokens - s.first_turn_cached);
    }
  }

  const sav = totalTok > 0 ? (totalCached / totalTok * 100).toFixed(1) : '?';
  lines.push('─'.repeat(96));
  lines.push(`${'TOTAL'.padEnd(14)} ${String(totalTurns).padStart(5)} ${String(totalTok.toLocaleString()).padStart(12)} ${String(totalCached.toLocaleString()).padStart(12)} ${String(sav).padStart(5)}% ${'—'.padStart(7)} ${String((totalShared/1000).toFixed(0)).padStart(9)}K ${String((totalPersona/1000).toFixed(0)).padStart(9)}K ${String((totalCtx/1000).toFixed(0)).padStart(9)}K`);

  return {
    text: lines.join('\n'),
    totals: { turns: totalTurns, tokens: totalTok, cached: totalCached, output: totalOut,
              shared_chars: totalShared, persona_chars: totalPersona, context_chars: totalCtx,
              handoff_penalty: handoffPenalty, savings: sav, stages },
  };
}

// ── Main ──

const args = process.argv.slice(2);
let mode = 'auto';
let sessionId = null;
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rf') { mode = 'rf'; sessionId = args[++i]; }
  else if (args[i] === '--cf') { mode = 'cf'; sessionId = args[++i]; }
  else if (args[i] === '--json') { jsonOutput = true; }
  else if (!args[i].startsWith('--')) { sessionId = args[i]; }
}

if (!sessionId) {
  console.error('Usage: node aggregate-session.mjs [--rf|--cf] <session-id> [--json]');
  process.exit(1);
}

// Auto-detect: check if this session has subagent session_files nearby
let sessionIds;
if (mode === 'rf') {
  sessionIds = findRelatedSessions(sessionId);
} else {
  sessionIds = [sessionId];
}

// Aggregate all turns
let allTurns = [];
for (const sid of sessionIds) {
  const turns = loadSessionTurns(sid);
  if (turns.length > 0) allTurns = allTurns.concat(turns);
}

if (allTurns.length === 0) {
  console.error(`No turn data found for session(s): ${sessionIds.join(', ')}`);
  process.exit(1);
}

// Sort by timestamp
allTurns.sort((a, b) => (a._ts || '').localeCompare(b._ts || ''));

const stages = aggregateTurns(allTurns);
const result = formatTable(stages, mode === 'rf' ? 'RF Run' : 'CF Run');

if (jsonOutput) {
  console.log(JSON.stringify({
    mode: mode === 'rf' ? 'rf' : 'cf',
    session_ids: sessionIds,
    ...result.totals,
    stages: result.totals.stages,
  }, null, 2));
} else {
  console.log(result.text);
  console.log(`\nSessions: ${sessionIds.join(', ')}`);
  console.log(`Handoff cold-start penalty: ${result.totals.handoff_penalty.toLocaleString()} uncached tokens`);
  console.log(`SP loading overhead: ${(result.totals.shared_chars / 1000).toFixed(0)}K chars`);
}
