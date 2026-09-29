#!/usr/bin/env node
/**
 * agent-failure-report.mjs
 *
 * Attributes every tool failure in the opencode transcript store to
 * (agent x failure-type x tool) with counts and recovery-token sums, then
 * distils the result into findings an **agent-manager** can act on:
 *
 *   - PROMPT SIGNAL      a tool an agent's system prompt teaches or recommends
 *                        that the agent then systematically mis-calls
 *                        (schema-validation, edit-mismatch clusters).
 *   - PERMISSION SIGNAL  a permission rule rejecting an agent's calls, with the
 *                        deny-family and the offending command head. If the
 *                        rejected command is also written verbatim in a tracked
 *                        doc (AGENTS.md, an agent prompt), the tool reports a
 *                        DOC/CONFIG CONTRADICTION — the org tells the agent to
 *                        run the very command the permission layer blocks.
 *
 * Why it exists: a one-off analysis (2026-09-29) found 1,364 tool failures /
 * 170M recovery-tokens in 14 days, 40% of them one infra fault and 19% one
 * over-broad `rm -rf *` permission rule. This script makes that analysis
 * re-runnable, so prompt/permission regressions are caught from evidence
 * instead of re-derived by hand.
 *
 * Cost model: "recovery tokens" = input + cache-read tokens of the assistant
 * turn(s) that had to react to a failure. Attribution is NON-OVERLAPPING — a
 * recovery turn is charged to at most one failure (the most recent one before
 * it) — so the sum is a defensible floor, not an inflated overlap. Use
 * `--window` to widen it toward a ceiling when you want an upper bound.
 *
 * Usage:
 *   node tools/agent-failure-report.mjs \
 *     [--db <path>]            opencode transcript sqlite (default ~/.local/share/opencode/opencode.db)
 *     [--days <n>]             look-back window, default 14
 *     [--agent <name>]         restrict to one agent
 *     [--agents-dir <path>]    scan <dir>/**\/*.md for prompt<->failure signals
 *     [--docs <a,b,...>]       docs to check for permission contradictions (default AGENTS.md,CLAUDE.md)
 *     [--top <n>]              table rows to print, default 30
 *     [--out <file>]           write the full cube as CSV
 *     [--json]                 emit the machine-readable report to stdout
 *     [--window <n>]           recovery turns per failure for the upper-bound estimate (default 1 = floor)
 *     [--fail-on-permission]   exit 1 if any permission denial is found
 *     [--fail-on-rate <pct>]   exit 1 if overall tool-error rate >= pct
 *     [--strict]               exit 1 if the transcript DB is missing
 *
 * Exit codes: 0 clean, 1 a --fail-on* threshold tripped, 2 usage/IO error.
 *
 * Dependencies: node builtins only (node:sqlite, node:fs). No npm packages.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_DB = path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

/**
 * Closed failure-class vocabulary. Order matters: the first match wins.
 * Exported so tests (and any consumer) can rely on the exact strings.
 * @type {{name: string, test: (e: string) => boolean}[]}
 */
export const FAILURE_CLASSES = [
  { name: 'MCP timeout', test: (e) => /32001.*timed out/i.test(e) || /backend unavailable/i.test(e) },
  { name: 'permission/consent', test: (e) => /rule which prevents|rejected permission|user rejected|user dismissed/i.test(e) },
  { name: 'schema (output)', test: (e) => /Structured content does not match/i.test(e) },
  { name: 'schema (input)', test: (e) => /additional properties|Validation failed|must have required property/i.test(e) },
  { name: 'edit mismatch', test: (e) => /oldString|and newString are identical|multiple matches for oldString/i.test(e) },
  { name: 'ripgrep', test: (e) => /Ripgrep|ripgrep/i.test(e) },
  { name: 'file not found', test: (e) => /File not found/i.test(e) },
  { name: 'agent/model/skill not found', test: (e) => /not found/i.test(e) && /Agent |Model |Skill |AGENT_NOT_FOUND/i.test(e) },
  { name: 'memory missing-arg', test: (e) => /E_MISSING_PROJECT_PATH|E_MISSING_CONTENT|E_MISSING_INPUT/i.test(e) },
  { name: 'db lock/WAL', test: (e) => /database is locked|E_BUSY|\bWAL\b|FOREIGN_SQLITE/i.test(e) },
  { name: 'gitnexus ambiguity', test: (e) => /Multiple repositories indexed/i.test(e) },
  { name: 'aborted/cancelled', test: (e) => /aborted|Task cancelled|cancelled/i.test(e) },
  { name: 'codespace misuse', test: (e) => /CodeMode/i.test(e) },
  { name: 'other', test: () => true },
];

/** @param {string|null|undefined} err @returns {string|null} */
export function classifyFailure(err) {
  if (!err || typeof err !== 'string') return null;
  for (const c of FAILURE_CLASSES) if (c.test(err)) return c.name;
  return null;
}

/**
 * Permission deny-families. Each is matched against the *denied command text*
 * so the report can name the rule a caller tripped. Kept in sync by eye with
 * the machine-global opencode config; extend as rules change.
 */
export const DENY_FAMILIES = [
  { name: 'rm -rf', test: (c) => /\brm\s+-[rf]{1,2}\b/.test(c) },
  { name: 'git stash', test: (c) => /\bgit\s+stash\b/.test(c) },
  { name: 'git add -A/.', test: (c) => /\bgit\s+add\s+(-A|--all|\.)\b/.test(c) },
  { name: 'git reset --hard', test: (c) => /\bgit\s+reset\s+--hard\b/.test(c) },
  { name: 'git push --force', test: (c) => /\bgit\s+push\b.*--force/.test(c) },
  { name: 'git push --no-verify', test: (c) => /\bgit\s+push\b.*--no-verify/.test(c) },
];

/** @param {string} cmd */
export function denyFamily(cmd) {
  if (!cmd) return null;
  for (const f of DENY_FAMILIES) if (f.test(cmd)) return f.name;
  return null;
}

/** Tool-name prefix -> the MCP server / subsystem that owns it. Drives infra routing. */
export const SERVER_SIDE = new Set(['memory-server', 'backlog', 'search']);
export function serverOf(tool) {
  if (!tool) return 'host';
  if (tool.startsWith('memory-server_')) return 'memory-server';
  if (tool.startsWith('backlog_')) return 'backlog';
  if (tool.startsWith('search_agent_') || tool.startsWith('search_')) return 'search';
  if (tool.startsWith('gitnexus_')) return 'gitnexus';
  if (/^agent[-_]/.test(tool)) return 'agent-mcp';
  return 'host';
}

/**
 * Fix routing — for each failure class, who owns it and the standing hypothesis.
 * This is what lets a triager act without re-deriving the cause. `gate` is the
 * kind of change a fix needs: infra | config | tool | prompt | ignore | review.
 */
export const FIX_ROUTING = {
  'MCP timeout': { owner: 'runtime/service', gate: 'infra', hypothesis: 'server contention or a wedged window — check duplicate server processes, main-thread blocks, embed-host respawn; do NOT raise the client timeout' },
  'db lock/WAL': { owner: 'runtime/service', gate: 'infra', hypothesis: 'SQLite WAL/lock contention on the shared store — co-resident writer or stale sidecar' },
  'permission/consent': { owner: 'permission config', gate: 'config', hypothesis: 'over-broad deny/ask rule, OR a tracked doc instructing a denied command (see docContradictions)' },
  'schema (input)': { owner: 'tool schema / prompt', gate: 'tool', hypothesis: 'caller guessing the arg shape — tighten the tool description or make the validation error name the bad key' },
  'schema (output)': { owner: 'tool server', gate: 'tool', hypothesis: 'declared outputSchema does not match the actual response — fix the server schema' },
  'edit mismatch': { owner: 'agent workflow', gate: 'prompt', hypothesis: 'stale read / no re-read before edit — reinforce read-before-edit and exact-match guidance' },
  ripgrep: { owner: 'agent guidance', gate: 'prompt', hypothesis: 'grep hitting a >64 KiB line (usually tool-output spill files) — scope the search or use --max-columns' },
  'file not found': { owner: 'agent guidance', gate: 'prompt', hypothesis: 'bad path — wrong worktree/cwd; verify the path before reading' },
  'memory missing-arg': { owner: 'tool contract', gate: 'tool', hypothesis: 'a required field (project_path/content) was omitted — the tool already rejects it; improve the message or the caller' },
  'agent/model/skill not found': { owner: 'config/routing', gate: 'config', hypothesis: 'agent/model/skill name mismatch between caller and registry' },
  'gitnexus ambiguity': { owner: 'tool config', gate: 'config', hypothesis: 'no --repo supplied and multiple repos are indexed' },
  'aborted/cancelled': { owner: 'n/a', gate: 'ignore', hypothesis: 'user/session interruption — not a defect' },
  'codespace misuse': { owner: 'agent guidance', gate: 'prompt', hypothesis: 'CodeMode API misuse (thenable/loop) — prompt or harness' },
  other: { owner: 'review', gate: 'review', hypothesis: 'unclassified — inspect the example error' },
};

function parseArgs(argv) {
  const o = { db: DEFAULT_DB, days: 14, top: 30, window: 1, json: false, strict: false,
    agent: null, agentsDir: null, docs: ['AGENTS.md', 'CLAUDE.md'], out: null,
    failOnPermission: false, failOnRate: null, failOnClass: null, failThreshold: 1, compare: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') o.db = next();
    else if (a === '--days') o.days = Number(next());
    else if (a === '--agent') o.agent = next();
    else if (a === '--agents-dir') o.agentsDir = next();
    else if (a === '--docs') o.docs = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--top') o.top = Number(next());
    else if (a === '--window') o.window = Number(next());
    else if (a === '--compare') o.compare = true;
    else if (a === '--out') o.out = next();
    else if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--fail-on-permission') o.failOnPermission = true;
    else if (a === '--fail-on-rate') o.failOnRate = Number(next());
    else if (a === '--fail-on-class') o.failOnClass = next();
    else if (a === '--fail-threshold') o.failThreshold = Number(next());
    else if (a === '-h' || a === '--help') { printUsage(); process.exit(0); }
    else { console.error(`unknown option: ${a}\n`); printUsage(); process.exit(2); }
  }
  return o;
}

function printUsage() {
  console.error(
    'usage: node tools/agent-failure-report.mjs [--db <path>] [--days <n>] [--agent <name>]\n' +
    '         [--agents-dir <path>] [--docs a,b] [--top <n>] [--out <file>] [--json]\n' +
    '         [--window <n>] [--compare] [--fail-on-permission] [--fail-on-rate <pct>]\n' +
    '         [--fail-on-class <type>] [--fail-threshold <n>] [--strict]',
  );
}

/**
 * Read a transcript DB into the normalised shapes the attribution needs.
 * Exported so a test can feed a synthetic DatabaseSync.
 *
 * @param {DatabaseSync} db
 * @param {number} since epoch-ms lower bound
 * @param {string|null} onlyAgent
 */
export function loadRows(db, since, onlyAgent, until = Number.MAX_SAFE_INTEGER) {
  const agents = new Map();   // message_id -> agent
  const tokens = new Map();   // message_id -> [recoveryTokens, costUsd]
  const msgRows = db.prepare(
    `select m.id as id, m.data as data, s.agent as sag
       from message m join session s on s.id = m.session_id
      where json_extract(m.data,'$.role')='assistant' and m.time_created > ? and m.time_created <= ?`,
  ).all(since, until);
  for (const r of msgRows) {
    let j = {}; try { j = JSON.parse(r.data); } catch { /* keep defaults */ }
    const agent = j.agent || r.sag || '?';
    const t = j.tokens || {}; const cache = t.cache || {};
    const recovery = (t.input || 0) + (cache.read || 0);
    agents.set(r.id, agent);
    tokens.set(r.id, [recovery, j.cost || 0]);
  }
  const partRows = db.prepare(
    `select session_id, message_id, time_created,
            json_extract(data,'$.tool') tool,
            json_extract(data,'$.state.status') status,
            json_extract(data,'$.state.error') error,
            json_extract(data,'$.state.input') input
       from part
      where json_extract(data,'$.type')='tool' and time_created > ? and time_created <= ?
      order by session_id, time_created`,
  ).all(since, until);
  const calls = new Map();   // agent -> count
  const sessions = new Map(); // session_id -> [{ts,mid,tool,error,input}]
  for (const r of partRows) {
    const agent = agents.get(r.message_id) || '?';
    calls.set(agent, (calls.get(agent) || 0) + 1);
    if (onlyAgent && agent !== onlyAgent) continue;
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
    sessions.get(r.session_id).push({ ts: r.time_created, mid: r.message_id, sid: r.session_id, agent, tool: r.tool, error: r.error, input: r.input });
  }
  return { agents, tokens, calls, sessions };
}

/**
 * Build the (agent, failureType, tool) cube with an upper bound controlled by
 * `windowTurns`:
 *   windowTurns = 1  -> NON-OVERLAPPING floor: the next assistant turn is
 *                       charged to at most one failure (the latest before it).
 *   windowTurns > 1  -> UPPER bound: each failure is summed with up to
 *                       `windowTurns` following turns (windows may overlap).
 * Exported for tests.
 */
export function buildCube({ tokens, sessions }, windowTurns = 1) {
  const count = new Map();   // key -> n
  const tok = new Map();
  const cost = new Map();
  const meta = new Map();    // key -> { example_*, byDay }
  const key = (a, c, t) => `${a}\u0000${c}\u0000${t}`;
  const note = (k, p) => {
    let m = meta.get(k);
    if (!m) { m = { example_error: null, example_input: null, example_session: null, byDay: {} }; meta.set(k, m); }
    if (!m.example_error && p.error) m.example_error = String(p.error).replace(/\s+/g, ' ').slice(0, 240);
    if (!m.example_input && p.input && p.input !== '{}' && p.input !== 'null') m.example_input = String(p.input).replace(/\s+/g, ' ').slice(0, 240);
    if (!m.example_session) m.example_session = p.sid || null;
    const day = new Date(p.ts).toISOString().slice(0, 10);
    m.byDay[day] = (m.byDay[day] || 0) + 1;
  };
  for (const seq of sessions.values()) {
    // ordered distinct assistant messages in this session
    const order = []; const byMsg = new Map();
    for (const p of seq) {
      if (!byMsg.has(p.mid)) { byMsg.set(p.mid, []); order.push(p.mid); }
      byMsg.get(p.mid).push(p);
    }
    if (windowTurns <= 1) {
      let last = null; // key from the previous message's first error
      for (const mid of order) {
        if (last) {
          const [tk, cst] = tokens.get(mid) || [0, 0];
          tok.set(last, (tok.get(last) || 0) + tk);
          cost.set(last, (cost.get(last) || 0) + cst);
        }
        let first = null;
        for (const p of byMsg.get(mid)) {
          const c = classifyFailure(p.error);
          if (!c) continue;
          const k = key(p.agent || '?', c, p.tool);
          count.set(k, (count.get(k) || 0) + 1);
          note(k, p);
          if (!first) first = k;
        }
        last = first;
      }
    } else {
      for (let i = 0; i < seq.length; i++) {
        const c = classifyFailure(seq[i].error);
        if (!c) continue;
        const k = key(seq[i].agent || '?', c, seq[i].tool);
        count.set(k, (count.get(k) || 0) + 1);
        note(k, seq[i]);
        const seen = new Set();
        for (let j = i + 1; j < seq.length && seen.size < windowTurns; j++) {
          if (seq[j].mid === seq[i].mid || seen.has(seq[j].mid)) continue;
          seen.add(seq[j].mid);
          const [tk, cst] = tokens.get(seq[j].mid) || [0, 0];
          tok.set(k, (tok.get(k) || 0) + tk);
          cost.set(k, (cost.get(k) || 0) + cst);
        }
      }
    }
  }
  const rows = [];
  for (const [k, n] of count) {
    const [agent, failure_type, tool] = k.split('\u0000');
    const m = meta.get(k) || {};
    rows.push({ agent, failure_type, tool, count: n,
      recovery_tokens: tok.get(k) || 0, recovery_usd: cost.get(k) || 0,
      example_error: m.example_error || null, example_input: m.example_input || null,
      example_session: m.example_session || null, byDay: m.byDay || {} });
  }
  return rows;
}

/** Group cube rows by agent x failure-type — the granularity a prompt/config change moves. */
export function trendIndex(cube) {
  const m = new Map();
  for (const r of cube) {
    const k = `${r.agent}\u0000${r.failure_type}`;
    const e = m.get(k) || { count: 0, tokens: 0 };
    e.count += r.count; e.tokens += r.recovery_tokens; m.set(k, e);
  }
  return m;
}

/** Group cube rows by an accessor. */
function group(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!m.has(k)) m.set(k, { count: 0, recovery_tokens: 0, recovery_usd: 0 });
    const g = m.get(k);
    g.count += r.count; g.recovery_tokens += r.recovery_tokens; g.recovery_usd += r.recovery_usd;
  }
  return m;
}

/** Tools named in a markdown prompt: backticked identifiers, or `foo_bar(` call style. */
export function toolsReferenced(text) {
  const out = new Set();
  const re = /`([A-Za-z][A-Za-z0-9_-]*)`|\b([a-z][a-z0-9-]*_[a-z][a-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1] || m[2]);
  return out;
}

function walkMarkdown(dir) {
  const files = [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) rec(p);
      else if (name.endsWith('.md')) files.push(p);
    }
  };
  rec(dir);
  return files;
}

// ---------------------------------------------------------------------------

function main() {
  const o = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(o.db);
  if (!existsSync(dbPath)) {
    console.error(`transcript DB not found: ${dbPath}`);
    process.exit(o.strict ? 1 : 0);
  }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { console.error(`cannot open ${dbPath}: ${err.message}`); process.exit(2); }

  const since = Date.now() - o.days * 86_400_000;
  const loaded = loadRows(db, since, o.agent);

  // attach agent onto session entries (needed by the window>1 path)
  for (const seq of loaded.sessions.values())
    for (const p of seq) p.agent = loaded.agents.get(p.mid) || '?';

  const cube = buildCube(loaded, o.window);

  // enrich each finding with routing, temporal shape, and per-agent rate/exposure
  const exposure = new Map(); // agent -> {calls, serverCalls}
  for (const seq of loaded.sessions.values())
    for (const p of seq) {
      const a = p.agent || '?';
      const e = exposure.get(a) || { calls: 0, serverCalls: 0 };
      e.calls++; if (SERVER_SIDE.has(serverOf(p.tool))) e.serverCalls++;
      exposure.set(a, e);
    }
  for (const r of cube) {
    r.server = serverOf(r.tool);
    r.fix = FIX_ROUTING[r.failure_type] || FIX_ROUTING.other;
    const days = Object.values(r.byDay || {});
    r.days_active = days.length;
    const tot = days.reduce((a, b) => a + b, 0) || 1;
    r.burst_pct = days.length ? Math.round((100 * Math.max(...days)) / tot) : 0;
    const ex = exposure.get(r.agent);
    r.agent_rate_pct = ex && ex.calls ? Number(((100 * r.count) / ex.calls).toFixed(2)) : 0;
    r.agent_server_exposure_pct = ex && ex.calls ? Number(((100 * ex.serverCalls) / ex.calls).toFixed(1)) : 0;
  }
  // class-level day histogram (infra incidents are single-day bursts)
  const failureByDay = {};
  for (const r of cube)
    for (const [d, n] of Object.entries(r.byDay || {})) {
      failureByDay[r.failure_type] ||= {};
      failureByDay[r.failure_type][d] = (failureByDay[r.failure_type][d] || 0) + n;
    }
  // triage queue: highest recovery cost first, each row carrying everything needed to act
  const triage = [...cube].sort((a, b) => b.recovery_tokens - a.recovery_tokens).slice(0, o.top).map((r) => ({
    agent: r.agent, failure_type: r.failure_type, tool: r.tool, server: r.server,
    count: r.count, recovery_tokens: r.recovery_tokens, recovery_usd: Number(r.recovery_usd.toFixed(4)),
    agent_rate_pct: r.agent_rate_pct, agent_server_exposure_pct: r.agent_server_exposure_pct,
    days_active: r.days_active, burst_pct: r.burst_pct,
    example_error: r.example_error, example_input: r.example_input, example_session: r.example_session,
    fix: r.fix,
  }));

  // change-detection: current window vs the immediately preceding window
  let trend = null;
  if (o.compare) {
    const prev = loadRows(db, since - o.days * 86_400_000, o.agent, since);
    for (const seq of prev.sessions.values()) for (const p of seq) p.agent = prev.agents.get(p.mid) || '?';
    const prevIdx = trendIndex(buildCube(prev, 1));
    const curIdx = trendIndex(cube);
    const keys = new Set([...curIdx.keys(), ...prevIdx.keys()]);
    trend = [...keys]
      .map((k) => {
        const [agent, failure_type] = k.split('\u0000');
        const cur = curIdx.get(k) || { count: 0, tokens: 0 };
        const old = prevIdx.get(k) || { count: 0, tokens: 0 };
        return { agent, failure_type, cur_count: cur.count, prev_count: old.count, delta: cur.count - old.count, cur_tokens: cur.tokens };
      })
      .filter((t) => t.cur_count || t.prev_count)
      .sort((a, b) => b.delta - a.delta);
  }

  const totalCalls = [...loaded.calls.values()].reduce((a, b) => a + b, 0);
  const totalFail = cube.reduce((a, r) => a + r.count, 0);
  const totalTok = cube.reduce((a, r) => a + r.recovery_tokens, 0);
  const totalUsd = cube.reduce((a, r) => a + r.recovery_usd, 0);
  const errRate = totalCalls ? (100 * totalFail) / totalCalls : 0;

  const byType = [...group(cube, (r) => r.failure_type).entries()]
    .sort((a, b) => b[1].recovery_tokens - a[1].recovery_tokens);
  const byAgent = [...group(cube, (r) => r.agent).entries()]
    .sort((a, b) => b[1].recovery_tokens - a[1].recovery_tokens);

  // ---- prompt signals: mis-call clusters (schema / edit) ----
  const PROMPT_CLASSES = new Set(['schema (input)', 'schema (output)', 'edit mismatch', 'memory missing-arg']);
  const promptSignals = cube
    .filter((r) => PROMPT_CLASSES.has(r.failure_type))
    .sort((a, b) => b.recovery_tokens - a.recovery_tokens)
    .map((r) => ({ agent: r.agent, tool: r.tool, failure_type: r.failure_type, count: r.count, recovery_tokens: r.recovery_tokens }));

  // ---- permission signals ----
  const permRows = cube.filter((r) => r.failure_type === 'permission/consent');
  const deniedCommands = new Map(); // family -> Map(cmdHead -> n)
  {
    // re-scan raw parts for permission errors to recover the command text
    const since2 = since;
    const raw = db.prepare(
      `select json_extract(data,'$.state.input') input
         from part
        where json_extract(data,'$.type')='tool'
          and json_extract(data,'$.state.error') like '%rule which prevents%'
          and time_created > ?`,
    ).all(since2);
    for (const r of raw) {
      let cmd = '';
      try { cmd = (JSON.parse(r.input) || {}).command || ''; } catch { /* ignore */ }
      if (!cmd) continue;
      const fam = denyFamily(cmd) || 'other';
      // show the line that actually matched the deny family, not the first line
      const hit = cmd.split('\n').find((l) => denyFamily(l) === fam) || cmd.split('\n')[0];
      const head = hit.trim().slice(0, 70);
      if (!deniedCommands.has(fam)) deniedCommands.set(fam, new Map());
      const m = deniedCommands.get(fam);
      m.set(head, (m.get(head) || 0) + 1);
    }
  }

  // ---- doc/config contradictions ----
  // A tracked doc that puts a denied command in an executable position — a fenced
  // code block, or a prose code span that is NOT a prohibition — is instructing an
  // agent to run the very thing the permission layer rejects.
  const contradictions = [];
  const seenDoc = new Set();
  for (const doc of o.docs) {
    const p = path.resolve(doc);
    if (!existsSync(p)) continue;
    const real = realpathSync(p);
    if (seenDoc.has(real)) continue; // CLAUDE.md is a symlink to AGENTS.md
    seenDoc.add(real);
    const lines = readFileSync(p, 'utf8').split('\n');
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      const candidates = [];
      if (inFence) candidates.push(line);
      for (const span of line.match(/`[^`]+`/g) || []) candidates.push(span.slice(1, -1));
      for (const cmd of candidates) {
        const fam = denyFamily(cmd);
        if (!fam) continue;
        // skip prose that forbids the command rather than instructing it
        if (!inFence && /\b(never|do not|don't|avoid|banned|denied?|not run|prohibit)\b/i.test(line)) break;
        contradictions.push({ family: fam, file: doc, line: i + 1, text: line.trim().slice(0, 140) });
        break;
      }
    });
  }

  // ---- agents-dir: prompt recommends a tool that fails for that agent ----
  const promptRecommended = [];
  if (o.agentsDir && existsSync(o.agentsDir)) {
    const failingByAgent = new Map();
    for (const r of cube) {
      if (!failingByAgent.has(r.agent)) failingByAgent.set(r.agent, new Map());
      const m = failingByAgent.get(r.agent);
      m.set(r.tool, (m.get(r.tool) || 0) + r.count);
    }
    for (const file of walkMarkdown(o.agentsDir)) {
      const text = readFileSync(file, 'utf8');
      const base = path.basename(path.dirname(file));
      const refs = toolsReferenced(text);
      // match agent by file stem or parent dir against a failing agent name
      const agentName = [...failingByAgent.keys()].find((a) => a && (a.includes(base) || base.includes(a)) || file.includes(`/${a}.md`) || file.includes(`/${a}/`));
      if (!agentName) continue;
      const failing = failingByAgent.get(agentName) || new Map();
      for (const [tool, n] of failing)
        if (refs.has(tool) || refs.has(tool.replace(/_/g, '')))
          promptRecommended.push({ agent: agentName, tool, file: path.relative(process.cwd(), file), failures: n });
    }
    promptRecommended.sort((a, b) => b.failures - a.failures);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: dbPath,
    windowDays: o.days,
    windowTurns: o.window,
    totals: { toolCalls: totalCalls, failures: totalFail, errorRatePct: Number(errRate.toFixed(2)),
      recoveryTokens: totalTok, recoveryUsd: Number(totalUsd.toFixed(4)),
      agents: byAgent.length, estimate: o.window <= 1 ? 'non-overlapping floor' : `upper bound (${o.window} turns/failure)` },
    byType: byType.map(([failure_type, g]) => ({ failure_type, ...g, recovery_usd: Number(g.recovery_usd.toFixed(4)) })),
    byAgent: byAgent.map(([agent, g]) => ({ agent, ...g, recovery_usd: Number(g.recovery_usd.toFixed(4)) })),
    cube,
    failureByDay,
    triage,
    trend,
    promptSignals,
    permissionSignals: {
      denials: permRows.reduce((a, r) => a + r.count, 0),
      byAgent: permRows.map((r) => ({ agent: r.agent, tool: r.tool, count: r.count, recovery_tokens: r.recovery_tokens })),
      denyFamilies: [...deniedCommands.entries()].map(([family, m]) => ({
        family, count: [...m.values()].reduce((a, b) => a + b, 0),
        topCommands: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cmd, n]) => ({ cmd, n })),
      })).sort((a, b) => b.count - a.count),
    },
    docContradictions: contradictions,
    promptRecommendedFailingTools: promptRecommended,
  };

  if (o.out) {
    const head = 'agent,failure_type,tool,count,recovery_tokens,recovery_usd';
    const body = cube
      .sort((a, b) => b.recovery_tokens - a.recovery_tokens)
      .map((r) => [r.agent, r.failure_type, r.tool, r.count, r.recovery_tokens, r.recovery_usd.toFixed(4)].join(','));
    writeFileSync(o.out, [head, ...body].join('\n') + '\n');
    console.error(`cube CSV written: ${o.out} (${cube.length} rows)`);
  }

  if (o.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return finish(o, report); }

  // ---- human report ----
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  const num = (n) => n.toLocaleString('en-US');
  L.push(`agent-failure-report  |  ${dbPath}`);
  L.push(`window: last ${o.days}d   agent: ${o.agent || 'all'}   estimate: ${report.totals.estimate}`);
  L.push('');
  L.push(`tool calls ${num(totalCalls)}   failures ${num(totalFail)} (${errRate.toFixed(2)}%)   recovery ${num(totalTok)} tokens / $${totalUsd.toFixed(2)}`);
  L.push('');
  L.push('FAILURE TYPE'.padEnd(30) + 'count'.padStart(8) + 'recovery_tokens'.padStart(18));
  for (const [t, g] of byType) L.push(pad(t, 30) + String(g.count).padStart(8) + num(g.recovery_tokens).padStart(18));
  L.push('');
  L.push('AGENT'.padEnd(20) + 'count'.padStart(8) + 'recovery_tokens'.padStart(18) + 'usd'.padStart(9));
  for (const [a, g] of byAgent) L.push(pad(a, 20) + String(g.count).padStart(8) + num(g.recovery_tokens).padStart(18) + g.recovery_usd.toFixed(2).padStart(9));
  L.push('');
  L.push(`PROMPT SIGNALS — agents systematically mis-calling a tool (fix the prompt/tool-description):`);
  if (!promptSignals.length) L.push('  (none)');
  for (const s of promptSignals.slice(0, 12))
    L.push(`  ${pad(s.agent, 16)} ${pad(s.tool, 38)} ${pad(s.failure_type, 16)} n=${s.count} tok=${num(s.recovery_tokens)}`);
  L.push('');
  L.push(`TRIAGE QUEUE — ranked by recovery cost (owner <- hypothesis; act without re-deriving):`);
  if (!triage.length) L.push('  (none)');
  triage.forEach((t, i) => {
    L.push(`  #${i + 1} [${t.fix.gate}] ${t.agent} x ${t.failure_type} x ${t.tool}`);
    L.push(`      n=${t.count} tok=${num(t.recovery_tokens)} server=${t.server} agentRate=${t.agent_rate_pct}% exposure=${t.agent_server_exposure_pct}% days=${t.days_active} burst=${t.burst_pct}%`);
    L.push(`      owner=${t.fix.owner} :: ${t.fix.hypothesis}`);
    if (t.example_error) L.push(`      err: ${String(t.example_error).slice(0, 140)}`);
    if (t.example_input && ['schema (input)', 'edit mismatch', 'memory missing-arg'].includes(t.failure_type))
      L.push(`      in:  ${String(t.example_input).slice(0, 140)}`);
  });
  L.push('');
  L.push(`CHANGE vs previous ${o.days}d (regressions first):`);
  if (!trend) L.push('  (run with --compare)');
  else {
    const regress = trend.filter((t) => t.delta > 0).slice(0, 6);
    const improve = trend.filter((t) => t.delta < 0).slice(-4);
    if (!regress.length) L.push('  no regressions');
    for (const t of regress) L.push(`  ▲ ${pad(t.agent, 16)} ${pad(t.failure_type, 20)} ${t.prev_count} -> ${t.cur_count}  (+${t.delta})`);
    for (const t of improve) L.push(`  ▼ ${pad(t.agent, 16)} ${pad(t.failure_type, 20)} ${t.prev_count} -> ${t.cur_count}  (${t.delta})`);
  }
  L.push('');
  L.push(`PERMISSION SIGNALS — ${report.permissionSignals.denials} denials:`);
  for (const f of report.permissionSignals.denyFamilies)
    L.push(`  ${pad(f.family, 22)} n=${String(f.count).padStart(4)}  e.g. ${f.topCommands[0] ? f.topCommands[0].cmd : ''}`);
  L.push('');
  L.push(`DOC/CONFIG CONTRADICTIONS — a tracked doc instructs a denied command:`);
  if (!contradictions.length) L.push('  (none)');
  for (const c of contradictions.slice(0, 12)) L.push(`  ${c.family}: ${c.file}:${c.line}  ${c.text}`);
  if (o.agentsDir) {
    L.push('');
    L.push(`PROMPT-RECOMMENDED FAILING TOOLS — an agent prompt names a tool that fails for it:`);
    if (!promptRecommended.length) L.push('  (none)');
    for (const p of promptRecommended.slice(0, 12)) L.push(`  ${pad(p.agent, 16)} ${pad(p.tool, 38)} n=${p.failures}  (${p.file})`);
  }
  process.stdout.write(L.join('\n') + '\n');
  return finish(o, report);
}

function finish(o, report) {
  // NOTE: never process.exit() right after writing to stdout — process.exit()
  // does not wait for stdout to drain and truncates large JSON at the ~64 KiB
  // pipe buffer. Set exitCode and let the runtime flush + exit cleanly.
  let code = 0;
  if (o.failOnPermission && report.permissionSignals.denials > 0) {
    console.error(`FAIL: ${report.permissionSignals.denials} permission denials`); code = 1;
  }
  if (o.failOnRate != null && report.totals.errorRatePct >= o.failOnRate) {
    console.error(`FAIL: error rate ${report.totals.errorRatePct}% >= ${o.failOnRate}%`); code = 1;
  }
  if (o.failOnClass) {
    const g = report.byType.find((t) => t.failure_type === o.failOnClass);
    if (g && g.count > o.failThreshold) { console.error(`FAIL: ${o.failOnClass} = ${g.count} > ${o.failThreshold}`); code = 1; }
  }
  process.exitCode = code;
}

// Run only when invoked directly (so the test can import this module).
// Compare REAL paths: a symlinked entry point (e.g. ~/.local/bin/agent-failure-report)
// gives process.argv[1] = the symlink while import.meta.url is the real module.
const _invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return path.resolve(process.argv[1]); } })() : '';
if (_invoked && _invoked === fileURLToPath(import.meta.url)) main();
