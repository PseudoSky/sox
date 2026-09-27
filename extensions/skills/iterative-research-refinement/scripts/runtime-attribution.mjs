#!/usr/bin/env node
/**
 * runtime-attribution.mjs — WHERE the runtime went, for one or more opencode sessions.
 *
 * Companion to runtime-metrics.mjs. That script answers "did the variant regress?";
 * this one answers "what specifically added the time, and in which process" — by
 * decomposing each session's wall-clock into tool-execution time vs model-latency time,
 * per tool, and diffing two runs call-for-call.
 *
 * Why this exists: 2026-09-25 — an A/B showed a variant at 1.29x wall-clock and the
 * mechanism was narrated from intuition ("more steps") which the telemetry then refuted:
 * tool-busy was flat, the entire delta was model round-trips. A ratio alone invites a
 * wrong causal story. Decompose before you explain.
 *
 * Method:
 *   span       = session.time_updated - session.time_created
 *   tool-busy  = measure of the UNION of every tool part's [start,end] interval
 *                (union, not sum, so parallel tool calls are not double-counted)
 *   model-wait = span - tool-busy   (inference + queueing between tool results)
 *   per extra call = Δspan / Δtool_calls  (seconds a single added round-trip costs)
 * Timestamps come from each tool part's state.time.{start,end} (ms, epoch).
 *
 * Usage:
 *   node scripts/runtime-attribution.mjs <ses_id> [...] [--pairs a:b ...] [--label id:l ...]
 *   node scripts/runtime-attribution.mjs ses_a ses_b --pairs ses_a:ses_b --calls
 *
 * Flags:
 *   --pairs a:b   decompose the delta between two session IDs/prefixes
 *   --label id:l  short display label for a session
 *   --calls       also list each session's ordered tool calls (what the extra call WAS)
 *   --db PATH     override session DB path (default ~/.local/share/opencode/opencode.db)
 *   --json        emit raw JSON instead of markdown
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const ID_RE = /^[A-Za-z0-9_-]+$/;

function parseArgs(argv) {
  const a = { sessions: [], pairs: [], labels: {}, calls: false, db: DEFAULT_DB, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--pairs") { while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a.pairs.push(argv[++i]); }
    else if (f === "--label") { while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { const [id, l] = argv[++i].split(":"); a.labels[id] = l || id; } }
    else if (f === "--calls") a.calls = true;
    else if (f === "--db") a.db = argv[++i];
    else if (f === "--json") a.json = true;
    else if (f.startsWith("--")) throw new Error(`Unknown flag: ${f}`);
    else a.sessions.push(f);
  }
  return a;
}

function sqlJson(db, query) {
  const out = execFileSync("sqlite3", ["-json", db, query], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

/** Union length (s) of possibly-overlapping [start,end] ms intervals. */
function unionSeconds(intervals) {
  const iv = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s).sort((x, y) => x[0] - y[0]);
  if (!iv.length) return 0;
  let total = 0, [cs, ce] = iv[0];
  for (const [s, e] of iv.slice(1)) {
    if (s > ce) { total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e;
  }
  return (total + (ce - cs)) / 1000;
}

function collect(db, sessions) {
  const ids = sessions.filter((s) => ID_RE.test(s));
  if (!ids.length) throw new Error("no valid session ids");
  const inList = ids.map((i) => `'${i}'`).join(",");

  const sess = sqlJson(db,
    `SELECT id, time_created AS t0, time_updated AS t1, cost,
            tokens_reasoning AS reasoning, tokens_input AS in_tok, tokens_output AS out_tok
     FROM session WHERE id IN (${inList});`);

  const parts = sqlJson(db,
    `SELECT session_id, json_extract(data,'$.tool') AS tool,
            json_extract(data,'$.state.time.start') AS s,
            json_extract(data,'$.state.time.end')   AS e,
            COALESCE(json_extract(data,'$.state.input.command'),
                     json_extract(data,'$.state.input.filePath'),
                     json_extract(data,'$.state.input.pattern'),
                     json_extract(data,'$.state.input.description')) AS target
     FROM part
     WHERE session_id IN (${inList}) AND json_extract(data,'$.type')='tool'
     ORDER BY session_id, time_created;`);

  return ids.map((id) => {
    const s = sess.find((r) => r.id === id) ?? {};
    const mine = parts.filter((p) => p.session_id === id);
    const perTool = {};
    for (const p of mine) {
      const t = (perTool[p.tool ?? "?"] ??= { n: 0, ms: 0 });
      t.n++;
      if (Number.isFinite(p.s) && Number.isFinite(p.e)) t.ms += p.e - p.s;
    }
    const span = (s.t1 - s.t0) / 1000;
    const toolBusy = unionSeconds(mine.map((p) => [p.s, p.e]));
    return {
      id, span, calls: mine.length, toolBusy,
      modelWait: Math.max(0, span - toolBusy),
      reasoning: s.reasoning ?? 0, cost: s.cost ?? 0, in_tok: s.in_tok ?? 0, out_tok: s.out_tok ?? 0,
      perTool, sequence: mine.map((p) => ({ tool: p.tool, ms: Number.isFinite(p.e) && Number.isFinite(p.s) ? p.e - p.s : null, target: (p.target ?? "").replace(/\s+/g, " ").slice(0, 78) })),
    };
  });
}

function report(rows, args) {
  const label = (id) => args.labels[id] ?? id.slice(0, 12);
  const L = [];
  L.push("## Runtime attribution — where the wall-clock went");
  L.push("");
  L.push("| session | span s | calls | tool-busy s | model-wait s | reasoning tok | cost $ |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${label(r.id)} | ${r.span.toFixed(1)} | ${r.calls} | ${r.toolBusy.toFixed(1)} | ${r.modelWait.toFixed(1)} | ${r.reasoning} | ${r.cost.toFixed(4)} |`);

  const tools = [...new Set(rows.flatMap((r) => Object.keys(r.perTool)))].sort();
  if (tools.length) {
    L.push("", "### per-tool (calls x seconds)");
    L.push("| session | " + tools.join(" | ") + " |");
    L.push("|---|" + tools.map(() => "---").join("|") + "|");
    for (const r of rows) L.push(`| ${label(r.id)} | ` + tools.map((t) => (r.perTool[t] ? `${r.perTool[t].n}x / ${(r.perTool[t].ms / 1000).toFixed(1)}s` : "—")).join(" | ") + " |");
  }

  for (const pair of args.pairs) {
    const [pa, pb] = pair.split(":");
    const a = rows.find((r) => r.id === pa) ?? rows.find((r) => r.id.startsWith(pa));
    const b = rows.find((r) => r.id === pb) ?? rows.find((r) => r.id.startsWith(pb));
    if (!a || !b) { L.push(`\n⚠️  pair ${pair}: session not found`); continue; }
    const dSpan = b.span - a.span, dBusy = b.toolBusy - a.toolBusy, dWait = b.modelWait - a.modelWait, dCalls = b.calls - a.calls;
    const share = (x) => (dSpan === 0 ? "n/a" : `${Math.round((Math.abs(x) / Math.abs(dSpan)) * 100)}%`);
    const perCall = dCalls > 0 ? dSpan / dCalls : null;
    L.push("", `### ${label(a.id)} → ${label(b.id)}`);
    L.push(`  span       ${a.span.toFixed(1)}s → ${b.span.toFixed(1)}s   ${dSpan >= 0 ? "+" : ""}${dSpan.toFixed(1)}s (${(b.span / a.span).toFixed(2)}x)`);
    L.push(`  tool-busy  ${a.toolBusy.toFixed(1)}s → ${b.toolBusy.toFixed(1)}s   ${dBusy >= 0 ? "+" : ""}${dBusy.toFixed(1)}s   ← ${share(dBusy)} of delta`);
    L.push(`  model-wait ${a.modelWait.toFixed(1)}s → ${b.modelWait.toFixed(1)}s   ${dWait >= 0 ? "+" : ""}${dWait.toFixed(1)}s   ← ${share(dWait)} of delta`);
    L.push(`  calls      ${a.calls} → ${b.calls}   ${dCalls >= 0 ? "+" : ""}${dCalls}`);
    if (perCall !== null) L.push(`  per extra call: ${perCall.toFixed(2)}s  (a single added round-trip)`);
    const dominant = Math.abs(dWait) >= Math.abs(dBusy) ? "MODEL-LATENCY-dominated (inference/queueing, not tool execution)" : "TOOL-EXECUTION-dominated";
    L.push(`  verdict: delta is ${dominant}`);
  }

  if (args.calls) {
    for (const r of rows) {
      L.push("", `### call sequence — ${label(r.id)}`);
      r.sequence.forEach((c, i) => L.push(`  ${String(i + 1).padStart(2)}. ${String(c.tool).padEnd(6)} ${c.ms === null ? "   ?  " : (c.ms / 1000).toFixed(2) + "s"}  ${c.target}`));
    }
  }
  return L.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessions.length) { console.error("usage: node runtime-attribution.mjs <ses_id> [...] [--pairs a:b ...] [--calls] [--json]"); process.exit(1); }
  const rows = collect(args.db, args.sessions);
  if (!rows.length) process.exit(1);
  if (args.json) { console.log(JSON.stringify({ runs: rows, pairs: args.pairs }, null, 2)); return; }
  console.log(report(rows, args));
}

main();
