#!/usr/bin/env node
/**
 * runtime-metrics.mjs — mandatory runtime telemetry for agent iterations (v9+).
 *
 * Extracts cost / token / tool-call / wall-clock metrics for one or more opencode
 * sessions from the local session DB and reports them as a markdown table, with
 * optional baseline-vs-variant delta thresholds.
 *
 * Why this exists: 2026-08-11 process failure — an agent iteration was promoted on
 * quality/policy metrics alone while silently regressing runtime (debug v1->v2 used
 * 1.4–1.9x tool calls, 1.4–2.1x wall-clock). This script makes the measurement
 * deterministic and 1-call, so "no metric regressed" can never be claimed without
 * the table.
 *
 * Usage:
 *   node scripts/runtime-metrics.mjs <ses_id> [<ses_id> ...] [--pairs sesA:sesB ...] [--label sesID:label ...]
 *   node scripts/runtime-metrics.mjs --all --limit 10          # recent sessions
 *   node scripts/runtime-metrics.mjs ses_abc ses_def --pairs ses_abc:ses_def
 *
 * Flags:
 *   --pairs a:b   compute delta + threshold verdict between two session IDs/prefixes
 *   --label id:l  give a session a short display label (used in pair verdict output)
 *   --all         list recent sessions (id, title) instead of metrics
 *   --limit N     with --all, max sessions (default 10)
 *   --db PATH     override session DB path (default ~/.local/share/opencode/opencode.db)
 *   --json        emit raw JSON (machine-readable) instead of markdown
 *
 * Example:
 *   node scripts/runtime-metrics.mjs ses_aaa ses_bbb \
 *     --label ses_aaa:T1-v1 --label ses_bbb:T1-v2 --pairs ses_aaa:ses_bbb
 *
 * Thresholds (per agent-manager-refs §12): tool calls <=1.25x, wall-clock <=1.25x,
 * cost <=1.15x baseline. Thresholds can be overridden with --tool-max, --time-max,
 * --cost-max.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

function parseArgs(argv) {
  const args = { sessions: [], pairs: [], labels: {}, all: false, limit: 10, db: DEFAULT_DB, json: false, toolMax: 1.25, timeMax: 1.25, costMax: 1.15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairs") { while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { args.pairs.push(argv[++i]); } }
    else if (a === "--label") { while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { const [id, label] = argv[++i].split(":"); args.labels[id] = label || id; } }
    else if (a === "--all") { args.all = true; }
    else if (a === "--limit") { args.limit = parseInt(argv[++i], 10); }
    else if (a === "--db") { args.db = argv[++i]; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--tool-max") { args.toolMax = parseFloat(argv[++i]); }
    else if (a === "--time-max") { args.timeMax = parseFloat(argv[++i]); }
    else if (a === "--cost-max") { args.costMax = parseFloat(argv[++i]); }
    else if (a.startsWith("--")) { throw new Error(`Unknown flag: ${a}`); }
    else { args.sessions.push(a); }
  }
  return args;
}

function sql(db, query, ...params) {
  const quoted = params.map((p) => (typeof p === "number" ? String(p) : `'${String(p).replace(/'/g, "''")}'`)).join(", ");
  const full = quoted ? `${query} ${quoted.length ? "" : ""}`.trim() : query;
  // build a parameterized-ish query: replace ? with quoted params
  let q = query;
  params.forEach((p) => { q = q.replace("?", typeof p === "number" ? String(p) : `'${String(p).replace(/'/g, "''")}'`); });
  const out = execFileSync("sqlite3", ["-separator", "\t", db, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim();
}

function fetchSession(db, id) {
  const row = sql(db,
    `SELECT id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
            ROUND((time_updated-time_created)/1000.0,1) AS dur_s,
            (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id AND json_extract(p.data,'$.type')='tool') AS tool_calls,
            (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s WHERE s.id = ?`, id);
  if (!row) return null;
  const [sid, cost, tin, tout, treason, tcacheread, dur, tools, msgs] = row.split("\t");
  return {
    id: sid, cost: parseFloat(cost || 0), tokens_input: parseInt(tin || 0, 10),
    tokens_output: parseInt(tout || 0, 10), tokens_reasoning: parseInt(treason || 0, 10),
    tokens_cache_read: parseInt(tcacheread || 0, 10), dur_s: parseFloat(dur || 0),
    tool_calls: parseInt(tools || 0, 10), messages: parseInt(msgs || 0, 10),
  };
}

function listRecent(db, limit) {
  const out = sql(db,
    `SELECT id, substr(title,1,60), ROUND((time_updated-time_created)/1000.0,1),
            cost, (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id AND json_extract(p.data,'$.type')='tool')
     FROM session s ORDER BY time_created DESC LIMIT ?`, limit);
  return out.split("\n").filter(Boolean).map((l) => l.split("\t"));
}

function mdTable(rows) {
  const headers = ["session", "tool_calls", "wall_clock_s", "cost_$", "in_tok", "out_tok", "reasoning", "cache_read", "msgs"];
  const fmt = (r) => [r.id.slice(0, 12), r.tool_calls, r.dur_s, r.cost.toFixed(4), r.tokens_input, r.tokens_output, r.tokens_reasoning, r.tokens_cache_read, r.messages];
  const body = rows.map((r) => fmt(r).join(" | "));
  return ["| " + headers.join(" | ") + " |", "|" + headers.map(() => "---").join("|") + "|", ...body.map((b) => "| " + b + " |")].join("\n");
}

function verdict(rows, pairs, tMax, labels) {
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const label = (id) => labels[id] ?? id.slice(0, 12);
  const out = [];
  for (const p of pairs) {
    const [idA, idB] = p.split(":");
    const a = byId[idA] ?? rows.find((r) => r.id.startsWith(idA));
    const b = byId[idB] ?? rows.find((r) => r.id.startsWith(idB));
    if (!a || !b) { out.push(`⚠️  pair ${p}: session not found (${idA}=${!!a}, ${idB}=${!!b})`); continue; }
    const d = (x, y) => (y === 0 ? (x === 0 ? 0 : Infinity) : x / y);
    const toolD = d(b.tool_calls, a.tool_calls);
    const timeD = d(b.dur_s, a.dur_s);
    const costD = d(b.cost, a.cost);
    const inD = d(b.tokens_input, a.tokens_input);
    const flags = [];
    if (toolD > tMax.toolMax) flags.push(`tool_calls ${toolD.toFixed(2)}x > ${tMax.toolMax}x ❌`);
    if (timeD > tMax.timeMax) flags.push(`wall_clock ${timeD.toFixed(2)}x > ${tMax.timeMax}x ❌`);
    if (costD > tMax.costMax) flags.push(`cost ${costD.toFixed(2)}x > ${tMax.costMax}x ❌`);
    out.push(`\n**Pair ${label(idA)} → ${label(idB)}:** tool ${toolD.toFixed(2)}x | time ${timeD.toFixed(2)}x | cost ${costD.toFixed(2)}x | input_tok ${inD.toFixed(2)}x`);
    out.push(flags.length ? `  ${flags.join("  ")}` : `  ✅ all runtime deltas within thresholds`);
  }
  return out.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    const rows = listRecent(args.db, args.limit);
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log("Recent sessions (id | title | dur_s | cost | tool_calls):");
    console.log(rows.map((r) => r.join(" | ")).join("\n"));
    return;
  }
  if (!args.sessions.length) { console.error("usage: node runtime-metrics.mjs <ses_id> [...] [--pairs a:b ...]"); process.exit(1); }
  const rows = args.sessions.map((id) => fetchSession(args.db, id)).filter(Boolean);
  const missing = args.sessions.filter((id) => !rows.find((r) => r.id === id));
  if (missing.length) console.error(`⚠️  not found in DB: ${missing.join(", ")}`);
  if (!rows.length) process.exit(1);
  if (args.json) { console.log(JSON.stringify({ runs: rows, pairs: args.pairs }, null, 2)); return; }
  console.log("## Runtime metrics (from opencode session DB)");
  console.log(mdTable(rows));
  if (args.pairs.length) console.log(verdict(rows, args.pairs, args, args.labels));
  // threshold legend
  console.log(`\nThresholds (refs §12): tool <=${args.toolMax}x · wall_clock <=${args.timeMax}x · cost <=${args.costMax}x baseline.`);
}

main();
