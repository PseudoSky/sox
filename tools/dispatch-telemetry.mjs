#!/usr/bin/env node
/**
 * dispatch-telemetry.mjs — [DEBT-031] per-subagent-call telemetry from REAL opencode storage.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dispatcher program (`dispatch-project-orchestrator`/`pro`) routinely fans out 10+ task-tool
 * subagent calls per wave. Until now, nobody could answer "how long did that subagent actually run,
 * how many tools did it fire, what did it cost" with numbers from the real store — the reports are
 * prose, the cost comes from the provider dashboard later, and a slow/expensive agent type is a
 * hunch, not a measurement. This turns one session id into the measured JSON the dispatcher can
 * cite in its notes.
 *
 * DATA SOURCE (discovered 2026-08-12, DEBT-031)
 * ----------------------------------------------
 * This opencode host has migrated off JSONL storage: `~/.local/share/opencode/storage/` holds only
 * empty `session_diff/*.json` (`[]`) and a `migration` flag (`2`). The authoritative store is
 * `~/.local/share/opencode/opencode.db` (SQLite). Quoted schema (verified against real rows):
 *
 *   session(id, parent_id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
 *           tokens_cache_read, tokens_cache_write, time_created, time_updated, title, ...)
 *     - parent_id: subagent link. child.parent_id = the session that dispatched it (task tool).
 *     - agent:     the dispatched subagent type (typescript/debug/review/performance/...).
 *     - cost:      stored aggregate cost, USD. Verified == SUM(message.data.cost) on sampled sessions.
 *     - time_*:    ms epoch. walltime = time_updated - time_created.
 *   message(id, session_id, time_created, time_updated, data)   -- data is JSON:
 *     { role, agent, modelID, providerID, cost, tokens:{total,input,output,reasoning,
 *       cache:{read,write}}, time:{created,completed}, finish }
 *     - per-message usage/cost records. tokens.total == input+output+reasoning+cache.read+cache.write.
 *   part(id, message_id, session_id, time_created, time_updated, data)  -- data is JSON:
 *     { type:"tool", tool:"bash|edit|read|task|...", callID,
 *       state:{ status:"completed|error|running|pending",
 *               input:{command} | {filePath,...}, output, error, time:{start,end} } }
 *     - tool-call parts; per-call duration = part.time_updated - part.time_created.
 *     - failure signal: state.status === "error".
 *
 * COST BASIS
 * ----------
 *   stored — session.cost when > 0 (falls back to SUM(message.data.cost) for sessions whose
 *            aggregate was never written; the two are equal on every sampled session).
 *   computed — only when no stored cost exists anywhere: tokens × deepseek-v4-flash rates from
 *            ~/.config/opencode/opencode.json (proxy models rf/cf/fj declare input 0.00027 / 1K,
 *            output 0.0011 / 1K; cache-read assumed 10% of input, per deepseek cache-hit pricing).
 *            Every entry states which basis produced its `cost` in `costBasis`.
 *
 * BASH MAIN-BIN EXTRACTION
 * ------------------------
 * For bash tool calls the reported tool name is the MAIN BIN of the command string, not the
 * literal "bash": first command segment (split on && || ; | newline) whose first token is a real
 * executable; leading wrappers (env/time/sudo/nohup/command), VAR=value assignments, and `cd <dir>`
 * are skipped; paths reduce to basenames; `do`/`then` are skipped so `for ...; do <cmd>` resolves to
 * the loop body's bin; pure display builtins (echo/printf) and construct heads (for/if/case/...)
 * advance to the next segment. Quote-aware: quoted sections (single/double/backtick, backslash
 * escapes respected) are stripped BEFORE segmentation, so separators inside quotes
 * (`echo "a|b" && git status`) can never fabricate phantom segments; subshell parens and `!`
 * negation are stripped from tokens; option tokens starting with `-` are skipped.
 * `git -C x log && echo y` -> git; `cd x && npm i` -> npm; `(cd /x && git log)` -> git;
 * `rm -rf d && node s` -> rm; `npx nx build` -> npx. When nothing real is extractable the name
 * falls back to the literal "bash".
 *
 * Usage (one command)
 * -------------------
 *   node tools/dispatch-telemetry.mjs <sessionId>              # auto: parent -> one entry per subagent child; child -> its single entry
 *   node tools/dispatch-telemetry.mjs ses_008fdc4a9ffe...      # parent: 22 subagent calls -> 22 entries
 *   node tools/dispatch-telemetry.mjs ses_008eda3e5ffe...      # child: 1 entry
 *   node tools/dispatch-telemetry.mjs <id> --children          # force enumeration (errors if none)
 *   node tools/dispatch-telemetry.mjs <id> --self              # force single-entry mode
 *   node tools/dispatch-telemetry.mjs <id> --db <path>         # alternate opencode.db location
 *   node tools/dispatch-telemetry.mjs <id> --pretty            # indented JSON (default: compact)
 *
 * Output: a JSON ARRAY, one entry per subagent call. Exit codes: 0 ok, 1 session not found,
 * 2 not a parent and not a subagent (auto mode), 3 store error.
 */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DB = resolve(homedir(), '.local/share/opencode/opencode.db');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, mode: 'auto', pretty: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      const v = argv[++i];
      if (v === undefined) { opts.missingDbValue = true; continue; }
      opts.db = resolve(v.replace(/^~/, homedir()));
    } else if (a === '--children' || a === '--self') opts.mode = a.slice(2);
    else if (a === '--pretty') opts.pretty = true;
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { opts.unknown = a; }
    else positional.push(a);
  }
  opts.sessionId = positional[0];
  return opts;
}

// ---------------------------------------------------------------------------
// Bash main-bin extraction
// ---------------------------------------------------------------------------
const WRAPPERS = new Set(['env', 'time', 'nohup', 'sudo', 'command', 'exec', 'builtin', 'ulimit']);
const LEADING_BUILTINS = new Set(['cd', 'pushd', 'popd', 'source', '.', 'export', 'set', 'unset']);
const DISPLAY_BUILTINS = new Set(['echo', 'printf', 'true', 'false', 'test', '[', 'local', 'readonly', 'type', 'alias', 'shift']);
// Shell control structure. A segment that OPENS a construct (for/while/if/case/...) is skipped —
// its body shows up in a later segment. `do`/`then`/`else`/`elif` merely introduce a command, so
// they are skipped and scanning continues in the same segment.
const CONTROL_HEADS = new Set(['for', 'while', 'until', 'if', 'case', 'select', 'function', 'done', 'fi', 'esac', 'in']);
const CONTROL_TAILS = new Set(['do', 'then', 'else', 'elif']);

// Drop quoted sections (single/double/backtick, respecting backslash escapes) so that separators
// INSIDE quotes (`echo "a|b" && git status`) can never fabricate phantom segments or phantom bins.
// Escaped characters are dropped as a unit — they are literal text, never separators.
function stripQuoted(text) {
  const QUOTES = new Set(['"', "'", '`']);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; } // escape sequence outside quotes: literal, skip both chars
    if (QUOTES.has(ch)) {
      const q = ch;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; } // escaped char inside quotes
        if (c === q) { i += 1; break; }       // closing quote
        i += 1;
      }
      continue; // quoted region contributes nothing
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function mainBin(command) {
  const text = stripQuoted(String(command ?? '').trim());
  if (!text) return 'bash';
  const segments = text.split(/&&|\|\||;|\n|\|/);
  for (const segRaw of segments) {
    const tokens = segRaw.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      let t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // VAR=value assignment
      t = t.replace(/^['"`]|['"`]$/g, ''); // residual surrounding quotes (quoted sections already stripped)
      t = t.replace(/^[()!]+|[()]+$/g, ''); // subshell parens ((cd …) -> cd, log) -> log) and `!` negation
      if (!t) continue;
      if (t.startsWith('-')) continue; // option/flag token (-v, -f, --all) — never a bin name
      if (WRAPPERS.has(t)) continue;
      if (CONTROL_HEADS.has(t)) break; // opens a construct; body is in a later segment
      if (CONTROL_TAILS.has(t)) continue; // `do <cmd>` / `then <cmd>` — skip the keyword
      if (LEADING_BUILTINS.has(t)) { i++; continue; } // `cd <dir>` — skip both
      if (DISPLAY_BUILTINS.has(t)) break; // whole segment is display-only; try next segment
      if (t.includes('/')) t = t.split('/').pop();
      if (t) return t;
    }
  }
  return 'bash';
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------
function openStore(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Fallback read-write open (older node / busy store). On a WAL store this can create
    // -shm/-wal sidecars if absent; accepted because every statement issued here is a read
    // (SELECT only) and the readOnly open succeeds on this host (node 24.11.1).
    return new DatabaseSync(dbPath);
  }
}

const SESSION_SQL =
  `SELECT id, parent_id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, time_created, time_updated, title
   FROM session WHERE id = ?`;

const CHILDREN_SQL =
  `SELECT id, parent_id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, time_created, time_updated, title
   FROM session WHERE parent_id = ? ORDER BY time_created`;

const TOOL_PARTS_SQL =
  `SELECT time_created, time_updated, data
   FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' ORDER BY time_created`;

const MESSAGE_COSTS_SQL =
  `SELECT json_extract(data, '$.cost') AS cost,
          json_extract(data, '$.tokens.input')     AS input,
          json_extract(data, '$.tokens.output')    AS output,
          json_extract(data, '$.tokens.reasoning') AS reasoning,
          json_extract(data, '$.tokens.cache.read') AS cache_read,
          json_extract(data, '$.tokens.cache.write') AS cache_write
   FROM message WHERE session_id = ?`;

// Fallback rates for the computed basis (USD per 1K tokens), from the machine's
// ~/.config/opencode/opencode.json proxy model declarations (deepseek-v4-flash family).
const RATES = { input: 0.00027, output: 0.0011, cacheRead: 0.000027 }; // cache-read = 10% of input

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------
function buildEntry(session, db) {
  const model = (() => {
    try { return session.model ? JSON.parse(session.model) : null; } catch { return null; }
  })();

  const toolParts = db.prepare(TOOL_PARTS_SQL).all(session.id);
  // Parse data JSON once, upfront. Malformed parts are excluded from BOTH toolCount and toolStats,
  // so toolCount always equals the sum of toolStats counts (opencode writes valid JSON, so on real
  // stores this never drops a part — it only keeps the invariant unconditional).
  const parsedParts = [];
  for (const p of toolParts) {
    try { parsedParts.push({ ...p, data: JSON.parse(p.data) }); } catch { /* malformed part: skipped */ }
  }
  const toolCount = parsedParts.length;

  // ---- tokens: session aggregate, else summed from per-message records ----
  let tokens = {
    input: session.tokens_input ?? 0,
    output: session.tokens_output ?? 0,
    reasoning: session.tokens_reasoning ?? 0,
    cacheRead: session.tokens_cache_read ?? 0,
    cacheWrite: session.tokens_cache_write ?? 0,
  };
  const allZero = Object.values(tokens).every((v) => !v);
  if (allZero) {
    const msgs = db.prepare(MESSAGE_COSTS_SQL).all(session.id);
    tokens = msgs.reduce(
      (acc, m) => ({
        input: acc.input + (m.input ?? 0),
        output: acc.output + (m.output ?? 0),
        reasoning: (acc.reasoning ?? 0) + (m.reasoning ?? 0),
        cacheRead: acc.cacheRead + (m.cache_read ?? 0),
        cacheWrite: acc.cacheWrite + (m.cache_write ?? 0),
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    );
  }
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;

  // ---- cost: stored first, else sum of stored per-message costs, else computed ----
  let cost;
  let costBasis;
  if (session.cost && session.cost > 0) {
    cost = session.cost;
    costBasis = 'stored: session.cost (verified == SUM(message.data.cost) on sampled sessions)';
  } else {
    const msgCostSum = db
      .prepare(MESSAGE_COSTS_SQL)
      .all(session.id)
      .reduce((acc, m) => acc + (m.cost ?? 0), 0);
    if (msgCostSum > 0) {
      cost = msgCostSum;
      costBasis = 'stored: SUM(message.data.cost)';
    } else {
      cost =
        (tokens.input / 1000) * RATES.input +
        (tokens.output / 1000) * RATES.output +
        (tokens.cacheRead / 1000) * RATES.cacheRead;
      costBasis =
        'computed: tokens × deepseek-v4-flash rates (input 0.00027/1K, output 0.0011/1K, cache-read 0.000027/1K) per ~/.config/opencode/opencode.json; NO stored cost present';
    }
  }

  // ---- tool stats by tool ----
  const stats = new Map();
  for (const p of parsedParts) {
    const d = p.data;
    const rawTool = d.tool || 'unknown';
    const name = rawTool === 'bash' ? mainBin(d.state?.input?.command) : rawTool;
    let st = stats.get(name);
    if (!st) { st = { name, count: 0, errors: 0, durations: [] }; stats.set(name, st); }
    st.count += 1;
    if (d.state?.status === 'error') st.errors += 1;
    let dur = (p.time_updated ?? 0) - (p.time_created ?? 0);
    if ((!dur || dur < 0) && d.state?.time?.start && d.state?.time?.end) {
      dur = d.state.time.end - d.state.time.start;
    }
    if (dur > 0) st.durations.push(dur);
  }
  const toolStats = [...stats.values()].map((s) => ({
    name: s.name,
    count: s.count,
    avgDuration: s.durations.length
      ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length)
      : null,
    errors: s.errors,
  }));
  toolStats.sort((a, b) => b.count - a.count);

  const startedMs = session.time_created ?? 0;
  const endedMs = session.time_updated ?? startedMs;
  const walltimeMs = endedMs >= startedMs ? endedMs - startedMs : 0;

  return {
    sessionId: session.id,
    agent: session.agent ?? null,
    dispatchedBy: session.parent_id ?? null,
    title: session.title ?? null,
    model: model ? { id: model.id ?? null, providerID: model.providerID ?? null } : null,
    startedAt: startedMs ? new Date(startedMs).toISOString() : null,
    endedAt: endedMs ? new Date(endedMs).toISOString() : null,
    walltimeMs,
    toolCount,
    tokens,
    cost: Number(cost.toFixed(8)),
    costBasis,
    toolStats,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const SELFTEST_CASES = [
  ['git -C /x log --oneline -5 && echo hi', 'git'],
  ['cd /x && npm i', 'npm'],
  ['rm -rf dist && node s.mjs', 'rm'],
  ['npx nx build sox', 'npx'],
  ['which backlog && backlog --help', 'which'],
  ['echo "---" && git status --porcelain', 'git'],
  ['for d in $(ls -d /x/*/); do echo "== $d"; done; ls /Users/x', 'ls'],
  ['for f in a.js b.js; do rg pattern "$f"; done', 'rg'],
  ['if [ -f x ]; then cat x; fi', 'cat'],
  ['env FOO=bar node tools/x.mjs', 'node'],
  ['node --version', 'node'],
  ['backlog get-item --repo sox-ecosystem --human-id DEBT-031', 'backlog'],
  ['sqlite3 ~/.local/share/opencode/opencode.db "SELECT 1"', 'sqlite3'],
  ['while read -r l; do echo $l; done < f.txt', 'bash'],
  ['pkill -f "node"', 'pkill'],
  ['', 'bash'],
  // DEBT-031 review: quote-internal separators / ! / -v / ( must never fabricate phantom bins
  ['echo "a|b" && git status', 'git'],
  ['echo "a;b" && git status', 'git'],
  ['echo "a && b" && git status', 'git'],
  ['echo "a\\"b" && git status', 'git'],
  ['echo "a\nb" && git status', 'git'],
  ['! git status', 'git'],
  ['command -v git && git status', 'git'],
  ['(cd /x && git log)', 'git'],
  ['cd "dir with spaces" && git status', 'git'],
  ['rm -rf "$(git rev-parse --show-toplevel)" && node s.mjs', 'rm'],
];

function selftest() {
  let fails = 0;
  for (const [cmd, want] of SELFTEST_CASES) {
    const got = mainBin(cmd);
    const ok = got === want;
    if (!ok) fails += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(cmd.slice(0, 60))} -> ${got}${ok ? '' : ` (want ${want})`}`);
  }
  console.log(fails ? `${fails} FAILURES` : 'all pass');
  return fails ? 1 : 0;
}

function usage() {
  console.error(`usage: node tools/dispatch-telemetry.mjs <sessionId> [--children|--self] [--db <path>] [--pretty]
  <sessionId>  opencode session/task id (ses_...). Parent -> one entry per subagent child;
               child/subagent -> its single entry (auto-detected; --children / --self override).
  --selftest   run the bash main-bin parser regression cases and exit.
  --db <path>  opencode.db location (default ~/.local/share/opencode/opencode.db).
  --pretty     indented JSON output (default compact).
Exit codes: 0 ok, 1 session not found, 2 not a parent and not a subagent, 3 store error.`);
}

export function run(argv) {
  const opts = parseArgs(argv);
  if (opts.missingDbValue) {
    console.error('dispatch-telemetry: --db requires a value: --db <path>');
    usage();
    return { exitCode: 2, entries: [] };
  }
  if (opts.selftest) return { exitCode: selftest(), entries: [] };
  if (opts.help || !opts.sessionId || opts.unknown) {
    if (opts.unknown) console.error(`unknown flag: ${opts.unknown}`);
    usage();
    return { exitCode: opts.help ? 0 : 2, entries: [] };
  }

  let db;
  try {
    db = openStore(opts.db);
  } catch (e) {
    console.error(`dispatch-telemetry: cannot open store ${opts.db}: ${e.message}`);
    return { exitCode: 3, entries: [] };
  }

  try {
    const main = db.prepare(SESSION_SQL).get(opts.sessionId);
    if (!main) {
      console.error(`dispatch-telemetry: no session ${opts.sessionId} in ${opts.db}`);
      return { exitCode: 1, entries: [] };
    }

    const children = db.prepare(CHILDREN_SQL).all(opts.sessionId);
    const hasParent = !!main.parent_id;

    let targets = [];
    if (opts.mode === 'children') {
      if (!children.length) {
        console.error(`dispatch-telemetry: --children but session ${opts.sessionId} has no subagent children`);
        return { exitCode: 2, entries: [] };
      }
      targets = children;
    } else if (opts.mode === 'self') {
      targets = [main];
    } else if (children.length) {
      targets = children; // parent session: one entry per subagent call
    } else if (hasParent) {
      targets = [main]; // child/subagent session: its single entry
    } else {
      console.error(
        `dispatch-telemetry: session ${opts.sessionId} is neither a parent (no children) nor a subagent (no parent_id) — nothing to measure`
      );
      return { exitCode: 2, entries: [] };
    }

    const entries = targets.map((s) => buildEntry(s, db));
    const out = opts.pretty ? JSON.stringify(entries, null, 2) : JSON.stringify(entries);
    process.stdout.write(out + '\n');
    return { exitCode: 0, entries };
  } catch (e) {
    console.error(`dispatch-telemetry: ${e.message}`);
    return { exitCode: 3, entries: [] };
  } finally {
    db.close();
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  const { exitCode } = run(process.argv.slice(2));
  process.exit(exitCode);
}
