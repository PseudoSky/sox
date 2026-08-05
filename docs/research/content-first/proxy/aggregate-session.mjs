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
 * Metrics (correct terminology — "savings" is reserved for cross-arm comparison):
 *   - cached read pct  = prompt_cache_hit_tokens / prompt_tokens  (per-session efficiency)
 *   - cache miss (writes) = prompt_cache_miss_tokens — tokens charged at miss rate
 *     and written to the provider cache
 *   - TIME metrics per stage, EXCLUDING dead time (gaps > DEAD_GAP_MS between
 *     consecutive turns — e.g. proxy server outage — are subtracted).
 *     total stage time, avg turn duration, and humanized formatting.
 *
 * Handoff cold-start penalty = sum of first-turn uncached over the CHRONOLOGICAL
 * agent-swap sequence (every agent change incl. re-entries; the session's first
 * turn is excluded). NOTE: the penalty reflects the MECHANISM (the persona that
 * was actually active), so attribution-fixed logs can under-count a mid-stage
 * corruption blow — on ses_035ef41f5 the corruption turn (142,140 uncached) was
 * relabeled 'typescript' by the attribution fix, hiding the real typescript→
 * SDLC-CF persona swap. The raw (pre-fix) log reports the mechanically-correct
 * 389,267; the fixed log reports 248,151. Both are preserved: the raw backup is
 * at /tmp/cf-session-backup.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A gap between consecutive turns longer than this is DEAD TIME (server
// outage, operator pause) — excluded from stage time totals. The proxy crash
// pause on 031bd2a82 (turns 16→17, ~7.5 min) is the canonical example.
const DEAD_GAP_MS = 120_000; // 2 minutes

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
  const dir = __dirname;
  const dispatcherFile = path.join(dir, `proxy-ses_${sessionId}.jsonl`);
  if (!fs.existsSync(dispatcherFile)) return [sessionId];

  const dispatcherTurns = loadSessionTurns(sessionId);
  if (dispatcherTurns.length === 0) return [sessionId];

  const firstTs = new Date(dispatcherTurns[0]._ts).getTime();
  const lastTs = new Date(dispatcherTurns[dispatcherTurns.length - 1]._ts).getTime();
  const windowStart = firstTs - 60000;   // 1 min before dispatch
  const windowEnd = lastTs + 300000;     // 5 min after last dispatcher turn

  const related = [sessionId];
  const sessionFiles = fs.readdirSync(dir)
    .filter(f => f.startsWith('proxy-ses_') && f.endsWith('.jsonl') && !f.includes('test_'));

  for (const f of sessionFiles) {
    const sid = f.replace('proxy-ses_', '').replace('.jsonl', '');
    if (sid === sessionId) continue;
    const stat = fs.statSync(path.join(dir, f));
    const mtime = stat.mtimeMs;
    if (mtime < windowStart || mtime > windowEnd) continue;
    const turns = loadSessionTurns(sid);
    const models = new Set(turns.map(t => t.model).filter(Boolean));
    if (models.has('rf')) related.push(sid);
  }
  return related;
}

/** Humanize a millisecond duration: 61_000 → "1m 1s"; 900 → "900ms"; 3_600_000 → "1h 0m". */
function humanize(ms) {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Compute stage timing from a session's sorted turns.
 * Returns { totalMs (dead-excluded wall time), deadMs, avgTurnMs }.
 * Dead time = gaps > DEAD_GAP_MS between consecutive turns.
 */
function computeTiming(turns) {
  const times = turns.map(t => new Date(t._ts).getTime()).filter(Number.isFinite);
  if (times.length < 2) return { totalMs: 0, deadMs: 0, avgTurnMs: null };
  times.sort((a, b) => a - b);
  let totalMs = 0, deadMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > DEAD_GAP_MS) deadMs += gap;
    else totalMs += gap;
  }
  const activeTurns = times.length - 1;
  return { totalMs, deadMs, avgTurnMs: activeTurns > 0 ? totalMs / activeTurns : null };
}

function aggregateTurns(turns) {
  const stages = {};           // key: "agent" or "agent#N" for repeated visits
  const stageOrder = [];       // insertion order (chronological)
  const resolveAgentName = (t) => {
    const agent = t.agent || '(unassigned)';
    const model = t.model || '';
    if (agent === '(passthrough)' || agent === '(unassigned)') {
      return model === 'cf' ? 'SDLC-CF' : model === 'rf' ? 'SDLC-RF' : agent;
    }
    return agent;
  };

  // Global sort by timestamp for time accounting across stages
  const sorted = [...turns].sort((a, b) => (a._ts || '').localeCompare(b._ts || ''));

  let previousAgentName = null; // agent of the stage before the current one
  const stageSwaps = [];       // chronological (agent, firstTurnTokens, firstTurnCached) per agent change
  // Track the current stage — a stage ENDS whenever the agent changes.
  // Repeated visits to the same agent get distinct buckets (product#1, product#2)
  // so a mid-chain handoff BACK to product (correction loop) is not summed into
  // the original product stage.
  let curAgent = null;
  let lastSegmentAgent = null; // agent of the previous turn (for handoff detection)
  let curStageKey = null;      // the stage bucket current turns accumulate into
  let visitCount = {};         // agent -> how many times seen (for #N suffix)

  const stageKey = (agent, firstVisit) => {
    // First visit → plain name; later visits → name#N
    return firstVisit ? agent : `${agent}#${visitCount[agent] || 2}`;
  };

  const openStage = (agent) => {
    const isFirst = !(visitCount[agent]);
    visitCount[agent] = (visitCount[agent] || 0) + 1;
    const key = stageKey(agent, isFirst);
    if (!stages[key]) {
      stages[key] = {
        agent,               // base name (product#2 still groups under 'product' for totals)
        visit: isFirst ? 1 : visitCount[agent],
        turns: 0, tokens: 0, cached: 0, cacheMiss: 0, output: 0,
        shared_chars: 0, persona_chars: 0, context_chars: 0,
        persona_turns: 0, persona_ctx_chars: 0,
        first_turn_tokens: null, first_turn_cached: null,
        first_turn_savings: null,
        turnTimes: [],
        handoffFrom: null,   // agent this stage was handed off FROM
      };
      if (!isFirst) stages[key].handoffFrom = previousAgentName;
      stageOrder.push(key);
    }
    return key;
  };

  for (const t of sorted) {
    const agent = resolveAgentName(t);

    // Handoff-penalty detection MUST run for every turn (incl. (unassigned)
    // turns that resolve to SDLC-CF — the corruption turn was one). Do it before
    // the skip so the swap baseline stays accurate.
    if (lastSegmentAgent !== null && agent !== lastSegmentAgent) {
      stageSwaps.push({ agent, tokens: t.tokens || 0, cached: t.cached || 0 });
    }
    lastSegmentAgent = agent;

    if (agent === '(unassigned)') continue;  // skip transient title-gen turns from stage buckets

    if (agent !== curAgent) {
      // REAL agent swap — close current stage, open a new one.
      // (Turn-counter resets with the SAME agent — dispatcher pauses between
      // sub-runs, proxy restarts — are NOT stage boundaries.)
      const isOrchestrator = /^(SDLC-RF|SDLC-CF)$/.test(agent);
      if (isOrchestrator && stages[agent]) {
        // Orchestrator wake-up between dispatches — merge into its existing
        // bucket instead of opening a new visit fragment. (RF dispatcher does
        // 2-turn dispatch/wait cycles between stage agents; those are NOT
        // separate stages.)
        curAgent = agent;
        curStageKey = agent;   // accumulate into the orchestrator bucket
        previousAgentName = agent;
      } else {
        curAgent = agent;
        curStageKey = openStage(agent);
        previousAgentName = agent;
      }
    }
    const s = stages[curStageKey];
    s.turns++;
    s.tokens += (t.tokens || 0);
    s.cached += (t.cached || 0);
    s.cacheMiss += (t.cache_miss != null ? t.cache_miss : ((t.tokens || 0) - (t.cached || 0)));
    s.output += (t.output || 0);
    s.turnTimes.push(new Date(t._ts).getTime());

    s.shared_chars = Math.max(s.shared_chars, t.shared_chars || 0);
    s.persona_chars = Math.max(s.persona_chars, t.persona_chars || 0);
    s.context_chars = Math.max(s.context_chars, t.context_chars || 0);
    s.persona_turns = Math.max(s.persona_turns, t.persona_turns || 0);
    s.persona_ctx_chars = Math.max(s.persona_ctx_chars, t.persona_ctx_chars || 0);

    if (s.first_turn_tokens === null) {
      s.first_turn_tokens = t.tokens || 0;
      s.first_turn_cached = t.cached || 0;
      s.first_turn_savings = (t.tokens || 0) > 0
        ? ((t.cached || 0) / (t.tokens || 1) * 100).toFixed(1)
        : '0.0';
    }
  }

  // Per-stage timing (dead-excluded)
  for (const key of stageOrder) {
    const s = stages[key];
    s.timing = computeTiming(s.turnTimes.map(ts => ({ _ts: new Date(ts).toISOString() })));
  }
  return { stages, stageOrder, stageSwaps };
}

function formatTable(stages, label, stageOrder = null, stageSwaps = null) {
  const lines = [];
  lines.push(`\n=== ${label} ===`);
  lines.push(`${'Stage'.padEnd(14)} ${'Turns'.padStart(5)} ${'Tokens'.padStart(12)} ${'Cached'.padStart(12)} ${'CacheW'.padStart(9)} ${'CachRd'.padStart(7)} ${'Out'.padStart(7)} ${'Out/M'.padStart(7)} ${'1stRd'.padStart(6)} ${'Time'.padStart(10)} ${'AvgTrn'.padStart(9)} ${'Dead'.padStart(8)} ${'PCtx'.padStart(8)}`);
  lines.push('-'.repeat(140));

  let totalTurns = 0, totalTok = 0, totalCached = 0, totalMiss = 0, totalOut = 0;
  let handoffPenalty = 0;
  const allTimes = [];
  let totalDeadMs = 0;

  const stageEntries = stageOrder ? stageOrder.map(k => [k, stages[k]]) : Object.entries(stages);
  for (const [agent, s] of stageEntries) {
    const cachRd = s.tokens > 0 ? (s.cached / s.tokens * 100).toFixed(1) : '?';
    const firstRd = s.first_turn_savings || '?';
    const pCtx = s.persona_ctx_chars ? ((s.persona_ctx_chars / 1000).toFixed(0) + 'K') : '—';
    const miss = s.cacheMiss || (s.tokens - s.cached);
    const { totalMs, deadMs, avgTurnMs } = s.timing || {};
    const outPerM = s.tokens > 0 ? (s.output / s.tokens * 1_000_000).toFixed(0) : '—';
    lines.push(`${agent.padEnd(14)} ${String(s.turns).padStart(5)} ${String(s.tokens.toLocaleString()).padStart(12)} ${String(s.cached.toLocaleString()).padStart(12)} ${String(miss.toLocaleString()).padStart(9)} ${String(cachRd).padStart(6)}% ${String(s.output.toLocaleString()).padStart(7)} ${String(outPerM).padStart(6)} ${String(firstRd).padStart(5)}% ${String(humanize(totalMs)).padStart(10)} ${String(avgTurnMs != null ? humanize(avgTurnMs) : '—').padStart(9)} ${String(humanize(deadMs)).padStart(8)} ${String(pCtx).padStart(8)}`);
    totalTurns += s.turns;
    totalTok += s.tokens;
    totalCached += s.cached;
    totalMiss += miss;
    totalOut += s.output;
    totalDeadMs += deadMs || 0;
    if (s.timing?.totalMs) allTimes.push(...Array(Math.max(1, s.turns - 1)).fill(s.timing.totalMs / Math.max(1, s.turns - 1)));
  }
  // Handoff cold-start penalty = sum of first-turn uncached per agent segment
  // (every real handoff incl. re-entries; excludes the session's initial cold
  // start). Uses the chronological swap sequence — not per-stage first_turn,
  // which misses re-entry handoffs.
  handoffPenalty = stageSwaps.reduce((sum, sw) => sum + (sw.tokens - sw.cached), 0);

  const cachRd = totalTok > 0 ? (totalCached / totalTok * 100).toFixed(1) : '?';
  const overallTime = allTimes.reduce((a, b) => a + b, 0);
  const overallAvg = allTimes.length > 0 ? overallTime / allTimes.length : null;
  lines.push('─'.repeat(140));
    const outPerMTot = totalTok > 0 ? (totalOut / totalTok * 1_000_000).toFixed(0) : '—';
  lines.push(`${'TOTAL'.padEnd(14)} ${String(totalTurns).padStart(5)} ${String(totalTok.toLocaleString()).padStart(12)} ${String(totalCached.toLocaleString()).padStart(12)} ${String(totalMiss.toLocaleString()).padStart(9)} ${String(cachRd).padStart(6)}% ${String(totalOut.toLocaleString()).padStart(7)} ${String(outPerMTot).padStart(6)} ${'—'.padStart(6)} ${String(humanize(overallTime)).padStart(10)} ${String(overallAvg != null ? humanize(overallAvg) : '—').padStart(9)} ${String(humanize(totalDeadMs)).padStart(8)}`);

  return {
    text: lines.join('\n'),
    totals: { turns: totalTurns, tokens: totalTok, cached: totalCached, cacheMiss: totalMiss, uncached: totalTok - totalCached, output: totalOut,
              handoff_penalty: handoffPenalty, cached_read_pct: cachRd, stages,
              time_total_ms: overallTime, time_avg_turn_ms: overallAvg, time_dead_ms: totalDeadMs },
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

let sessionIds;
if (mode === 'auto') {
  const probe = loadSessionTurns(sessionId);
  const probeModel = probe.find(t => t.model)?.model || '';
  if (probeModel === 'rf') mode = 'rf';
}

if (mode === 'rf' && sessionId.includes(',')) {
  sessionIds = sessionId.split(',').map(s => s.trim()).filter(Boolean);
} else if (mode === 'rf') {
  sessionIds = findRelatedSessions(sessionId);
} else {
  sessionIds = [sessionId];
}

let allTurns = [];
for (const sid of sessionIds) {
  const turns = loadSessionTurns(sid);
  if (turns.length > 0) allTurns = allTurns.concat(turns);
}

if (allTurns.length === 0) {
  console.error(`No turn data found for session(s): ${sessionIds.join(', ')}`);
  process.exit(1);
}

allTurns.sort((a, b) => (a._ts || '').localeCompare(b._ts || ''));

const stageAgg = aggregateTurns(allTurns);
const stages = stageAgg.stages;
let armLabel = 'CF Run';
if (mode === 'rf') {
  armLabel = 'RF Run';
} else {
  const firstTurns = loadSessionTurns(sessionIds[0]);
  const model = firstTurns.find(t => t.model)?.model || '';
  if (model === 'rf') armLabel = 'RF Run';
  else if (model === 'cf') armLabel = 'CF Run';
  else armLabel = 'Run';
}
const result = formatTable(stages, armLabel, stageAgg.stageOrder, stageAgg.stageSwaps);

if (jsonOutput) {
  console.log(JSON.stringify({
    mode: mode === 'rf' ? 'rf' : 'cf',
    session_ids: sessionIds,
    ...result.totals,
    time: { total_ms: result.totals.time_total_ms, avg_turn_ms: result.totals.time_avg_turn_ms, dead_ms: result.totals.time_dead_ms,
            total_human: humanize(result.totals.time_total_ms), avg_turn_human: result.totals.time_avg_turn_ms != null ? humanize(result.totals.time_avg_turn_ms) : null },
    stages: result.totals.stages,
  }, null, 2));
} else {
  console.log(result.text);
  console.log("Sessions: " + sessionIds.join(', '));
  console.log("Handoff cold-start penalty: " + result.totals.handoff_penalty.toLocaleString() + " uncached tokens");
  console.log("Overall time: " + humanize(result.totals.time_total_ms) + " (dead time excluded: " + humanize(result.totals.time_dead_ms) + ")");
  console.log("Avg turn duration: " + (result.totals.time_avg_turn_ms != null ? humanize(result.totals.time_avg_turn_ms) : '—'));
  const perTurnShared = result.totals.shared_chars;
  const totalT = result.totals.turns;
  if (perTurnShared && totalT) console.log("SP loading: " + (perTurnShared / 1000).toFixed(0) + "K chars/turn x " + totalT + " turns = " + (perTurnShared * totalT / 1_000_000).toFixed(0) + "M chars total");
}
