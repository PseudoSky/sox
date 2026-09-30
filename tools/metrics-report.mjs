#!/usr/bin/env node
/**
 * metrics-report.mjs — [Durable metrics S6, 0a3faad7-48e4-4635-98c7-13bd37663f7b]
 * a PURE-READ reporter and comparer for the LIBRARY-WRITTEN rollup stream.
 *
 * WHAT IT READS
 * -------------
 * Since S8 (`@adhd/sox-telemetry`, commit 557e3f09) the telemetry library folds
 * the durable `metrics.snapshot` stream continuously and writes one rollup row
 * per `(release, process instance)` per interval tick to
 *
 *   <dataRoot>/<service>/logs/rollup/<service>.<role>.metrics-rollup-<UTC-date>.jsonl
 *
 * where the production `<dataRoot>` is `~/.adhd/sox-ecosystem` and the sink may
 * size-rotate a file to a `…<date>.<epoch>-<seq>.jsonl` suffix. Each line is one
 * `event:"metrics.rollup"` object carrying `release` identity, a `window`
 * (`{from,to,kind:"trailing"}`), `snapshots_in_window`, and a `series` map. A
 * trailing window OVERLAPS by design, so several rows per `(service,role,release)`
 * exist and the NEWEST row (max `ts`) is the current reading — exactly the rule
 * this tool applies, never stitching rows together.
 *
 * WHY IT IS READ-ONLY
 * -------------------
 * The earlier design carried a human-invoked `--apply --confirm` step that
 * "performed the rollup". That shape is gone: the LIBRARY writes continuously
 * now, so a human rollup step is both redundant and a mutation surface. Only
 * `--report` and `--compare` survive, and this module performs ZERO writes — no
 * file is created, rewritten, or deleted (no `index.json`, no rollup, no raw
 * snapshot). The prohibition is by construction, not convention: the module
 * contains no write primitive and the test asserts the tree is byte-identical
 * before and after.
 *
 * USAGE
 *   node tools/metrics-report.mjs [--report] [--root <dir>] [--json]
 *   node tools/metrics-report.mjs --compare <releaseA> <releaseB> [--root <dir>] [--json]
 *   node tools/metrics-report.mjs --help
 *
 * RELEASE SELECTOR (for --compare)
 *   A selector is matched against each group's newest rollup row, in this order:
 *     1. the `version` string, matched exactly (e.g. `1.4.2`); then
 *     2. the full `artifact_sha256`, with or without its `sha256:` prefix
 *        (e.g. `e2b4…` or `sha256:e2b4…` — the prefix is stripped from both the
 *        selector and the stored value before comparison).
 *   If the selector resolves to several `(service,role)` groups the newest is
 *   used (and its service/role is printed so the choice is visible). If EITHER
 *   selector resolves to nothing, an error naming the missing release is printed
 *   and the process exits non-zero — a comparison against an absent release is
 *   never silently a no-op.
 *
 * EXIT CODES
 *   0  a report (even an empty one) or a complete comparison
 *   1  a comparison naming a release with no rollup row (data condition)
 *   2  a usage error (unknown flag, missing argument)
 *
 * DATA ROOT
 *   `--root <dir>` wins when given; otherwise `$SOX_ECOSYSTEM_HOME`; otherwise
 *   `~/.adhd/sox-ecosystem`. This mirrors `libs/host-runtime/src/data-paths.ts`
 *   `userDataRoot()` and deliberately does NOT hard-code a bare `os.homedir()`
 *   the way `tools/snapshot-gc.mjs` does — the override and the env var MUST win,
 *   or a test/alternate-root run would silently read production.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

/** The production data subdir under the user home (ADR-0004 §D1). */
const DATA_SUBDIR = path.join('.adhd', 'sox-ecosystem');

/**
 * The rollup file name shape the S8 sink produces: `<service>.<role>.
 * metrics-rollup-<UTC-date>[.<epoch>-<seq>].jsonl`. Anchored on the full shape
 * (not a bare `.metrics-rollup-` substring) so a foreign file that merely embeds
 * the token is never mistaken for a rollup.
 */
const ROLLUP_FILE_RE = /\.metrics-rollup-\d{4}-\d{2}-\d{2}(\.\d+-\d+)?\.jsonl$/;

/**
 * Resolve the data root: explicit `--root` > `$SOX_ECOSYSTEM_HOME` > the user
 * home default. Mirrors host-runtime's `userDataRoot()` (an empty string is
 * treated as unset, exactly as that module does).
 */
export function resolveDataRoot({ root } = {}) {
  if (typeof root === 'string' && root !== '') return root;
  const override = process.env['SOX_ECOSYSTEM_HOME'];
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), DATA_SUBDIR);
}

/** A finite number, else `null` (NaN/Infinity included). */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalise a raw `release` to the all-present BL-433 shape (never `''`). */
function normalizeRelease(raw) {
  const rel = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    version: str(rel['version']),
    artifact_sha256: str(rel['artifact_sha256']),
    git_sha: str(rel['git_sha']),
  };
}

/** Epoch-ms for an ISO `ts`, or `null` when absent/unparseable. */
function tsMs(ts) {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * Discover rollup files under `<dataRoot>/<service>/logs/rollup/`. An async
 * two-level walk (`readdir` + `readdir`), never a sync recursive scan. A missing
 * root or a service with no `rollup/` dir is normal (a service that has never
 * rolled up) and yields no files, never an error.
 */
export async function discoverRollupFiles(dataRoot) {
  const files = [];
  let services;
  try {
    services = await fs.promises.readdir(dataRoot, { withFileTypes: true });
  } catch {
    // A data root that does not exist yet is the ordinary first-run state, not
    // a failure: nothing has rolled up, so there is nothing to report.
    return files;
  }
  for (const ent of services) {
    if (!ent.isDirectory()) continue;
    const rollupDir = path.join(dataRoot, ent.name, 'logs', 'rollup');
    let names;
    try {
      names = await fs.promises.readdir(rollupDir);
    } catch {
      // A service directory with no rollup/ subdir (never rolled up, or rolled
      // away) is expected churn — skip it and keep walking.
      continue;
    }
    for (const name of names) {
      if (!ROLLUP_FILE_RE.test(name)) continue;
      files.push({ service: ent.name, file: name, fullPath: path.join(rollupDir, name) });
    }
  }
  return files;
}

/**
 * Read every `metrics.rollup` row from the discovered files. A malformed or
 * partial line — one still being appended, or a file rotating under the reader
 * — is NORMAL churn in a live stream and is skipped, never thrown on: the whole
 * point of a read-only reporter is that it cannot be broken by a concurrent
 * writer.
 */
export async function readRollupRows(files) {
  const rows = [];
  for (const f of files) {
    let text;
    try {
      text = await fs.promises.readFile(f.fullPath, 'utf8');
    } catch {
      // Rotated or pruned between the directory walk and this read — churn.
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A half-written trailing line, or a foreign non-JSON line: skip it and
        // read the next — the stream is append-only and self-healing.
        continue;
      }
      if (parsed !== null && typeof parsed === 'object' && parsed['event'] === 'metrics.rollup') {
        rows.push(parsed);
      }
    }
  }
  return rows;
}

/**
 * Group rows by `(service, role, release identity)` and reduce each group to its
 * NEWEST row (max `ts`) plus the oldest `ts` observed — the coverage horizon a
 * reader needs to judge how much of the group's life the newest row's trailing
 * window actually spans.
 */
export function groupRollups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const release = normalizeRelease(r['release']);
    const service = typeof r['service'] === 'string' ? r['service'] : null;
    const role = typeof r['role'] === 'string' ? r['role'] : null;
    const key = JSON.stringify([service, role, release.version, release.artifact_sha256, release.git_sha]);
    const ts = typeof r['ts'] === 'string' ? r['ts'] : null;
    const t = tsMs(ts);
    let g = groups.get(key);
    if (g === undefined) {
      g = { service, role, release, newest: r, newestMs: t, newestTs: ts, oldestMs: t, oldestTs: ts };
      groups.set(key, g);
      continue;
    }
    if (t !== null) {
      if (g.newestMs === null || t > g.newestMs) {
        g.newestMs = t;
        g.newestTs = ts;
        g.newest = r;
      }
      if (g.oldestMs === null || t < g.oldestMs) {
        g.oldestMs = t;
        g.oldestTs = ts;
      }
    }
  }
  return [...groups.values()];
}

/** Project one group to the plain object the reporter and JSON emit. */
export function toEntry(g) {
  const row = g.newest ?? {};
  const series = row['series'] && typeof row['series'] === 'object' ? row['series'] : {};
  return {
    service: g.service,
    role: g.role,
    release: g.release,
    newest_ts: g.newestTs,
    oldest_rollup_ts: g.oldestTs,
    window: row['window'] ?? null,
    process_pid: finite(row['process_pid']),
    snapshots_in_window: finite(row['snapshots_in_window']),
    otel: row['otel'] && typeof row['otel'] === 'object' ? row['otel']['state'] ?? null : null,
    series,
  };
}

/**
 * Resolve a release selector to ONE entry. The `version` string is matched
 * first, then the full `artifact_sha256` (with or without a `sha256:` prefix).
 * Several matching groups (a release live on more than one service/role) resolve
 * to the newest; none resolves to `null`.
 */
export function selectEntry(entries, selector) {
  if (typeof selector !== 'string' || selector === '') return null;
  const sha = selector.startsWith('sha256:') ? selector.slice('sha256:'.length) : selector;
  const newer = (a, b) => {
    const am = a.newest_ts === null ? -Infinity : tsMs(a.newest_ts) ?? -Infinity;
    const bm = b.newest_ts === null ? -Infinity : tsMs(b.newest_ts) ?? -Infinity;
    return bm - am;
  };
  const byVersion = entries.filter((e) => e.release.version === selector).sort(newer);
  if (byVersion.length) return byVersion[0];
  const bySha = entries
    .filter((e) => {
      const v = e.release.artifact_sha256;
      if (v === null) return false;
      return (v.startsWith('sha256:') ? v.slice('sha256:'.length) : v) === sha;
    })
    .sort(newer);
  if (bySha.length) return bySha[0];
  return null;
}

/** Human-readable one-line release identity. */
function releaseLabel(release) {
  const parts = [];
  parts.push(release.version ?? 'version=unknown');
  if (release.artifact_sha256 !== null) parts.push(release.artifact_sha256);
  if (release.git_sha !== null) parts.push(`git=${release.git_sha}`);
  return parts.join(' · ');
}

/** Format a number for the human report, or `n/a` when the field is null. */
function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** A signed absolute-delta string (`+`/`-`), or `n/a`. */
function fmtDelta(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return (v >= 0 ? '+' : '') + fmtNum(v);
}

/** A signed percentage string, or `n/a` (no baseline / unusable). */
function fmtPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** The sorted union of two series maps' keys. */
function seriesUnion(a, b) {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
}

function renderReport(entries, dataRoot) {
  const lines = [];
  lines.push(`metrics-report — rollup stream under ${dataRoot}`);
  if (entries.length === 0) {
    lines.push('');
    lines.push('no rollup rows found (no <service>/logs/rollup/*.metrics-rollup-*.jsonl).');
    return lines.join('\n');
  }
  lines.push(`${entries.length} group(s) — one per (service, role, release), newest row each:`);
  for (const e of entries) {
    const win = e.window ?? {};
    lines.push('');
    lines.push(`▸ ${e.service ?? '?'} / ${e.role ?? '?'} — ${releaseLabel(e.release)}`);
    lines.push(`    newest ts           ${e.newest_ts ?? 'n/a'}`);
    lines.push(`    oldest rollup ts    ${e.oldest_rollup_ts ?? 'n/a'}`);
    lines.push(`    window              ${win['from'] ?? '?'} → ${win['to'] ?? '?'} (${win['kind'] ?? '?'})`);
    lines.push(`    process_pid         ${e.process_pid ?? 'n/a'}`);
    lines.push(`    snapshots_in_window ${e.snapshots_in_window ?? 'n/a'}`);
    lines.push(`    otel                ${e.otel ?? 'n/a'}`);
    const names = Object.keys(e.series).sort();
    if (names.length === 0) {
      lines.push('    series              (none)');
    } else {
      lines.push('    series:');
      for (const name of names) {
        const s = e.series[name] ?? {};
        lines.push(
          `      ${name.padEnd(26)} ${String(s['agg'] ?? '?').padEnd(18)} ` +
            `value=${fmtNum(s['value'])} samples=${fmtNum(s['samples'])}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/** Build the per-series comparison rows for two entries. */
export function buildComparison(a, b) {
  const rows = [];
  for (const name of seriesUnion(a.series, b.series)) {
    const av = finite(a.series?.[name]?.['value']);
    const bv = finite(b.series?.[name]?.['value']);
    const delta = av !== null && bv !== null ? bv - av : null;
    const pct = delta !== null && av !== 0 ? (delta / av) * 100 : null;
    rows.push({ name, a: av, b: bv, delta, delta_pct: pct });
  }
  return rows;
}

function renderCompare(a, b, rows) {
  const lines = [];
  lines.push(`metrics-report — compare ${releaseLabel(a.release)} → ${releaseLabel(b.release)}`);
  lines.push('');
  lines.push(`  A  ${a.service ?? '?'} / ${a.role ?? '?'} — ${releaseLabel(a.release)} (newest ${a.newest_ts ?? 'n/a'})`);
  lines.push(`  B  ${b.service ?? '?'} / ${b.role ?? '?'} — ${releaseLabel(b.release)} (newest ${b.newest_ts ?? 'n/a'})`);
  lines.push('');
  lines.push(`${'series'.padEnd(28)}${'A'.padStart(14)}${'B'.padStart(14)}${'delta'.padStart(14)}${'delta%'.padStart(12)}`);
  for (const r of rows) {
    lines.push(
      `${r.name.padEnd(28)}${fmtNum(r.a).padStart(14)}${fmtNum(r.b).padStart(14)}` +
        `${fmtDelta(r.delta).padStart(14)}${fmtPct(r.delta_pct).padStart(12)}`,
    );
  }
  lines.push('');
  lines.push('delta = B − A; delta% is relative to A (n/a when both are not finite or A = 0).');
  return lines.join('\n');
}

const HELP = `metrics-report — pure-read reporter/comparer for the library-written rollup stream.

USAGE
  node tools/metrics-report.mjs [--report] [--root <dir>] [--json]
  node tools/metrics-report.mjs --compare <releaseA> <releaseB> [--root <dir>] [--json]
  node tools/metrics-report.mjs --help

SUBCOMMANDS
  --report (default)   Discover <dataRoot>/<service>/logs/rollup/*.metrics-rollup-*.jsonl and
                       print one entry per (service, role, release) using the NEWEST row (max ts)
                       of each, with that row's trailing window (from/to) and the oldest rollup ts
                       observed for the group (its coverage horizon).
  --compare <A> <B>    For each series present in both releases' newest rows, print the per-series
                       delta (absolute and %) from A to B. If either release has no rollup row,
                       print an error naming the missing release and exit non-zero.

RELEASE SELECTOR (--compare arguments)
  1. the release \`version\` string, matched exactly (e.g. 1.4.2); else
  2. the full \`artifact_sha256\`, with or without the \`sha256:\` prefix (the prefix is stripped
     from both the selector and the stored value before comparison).
  A selector matching several (service, role) groups resolves to the newest; its service/role is
  printed so the choice is visible.

OPTIONS
  --root <dir>   Data root to read. Default: $SOX_ECOSYSTEM_HOME, else ~/.adhd/sox-ecosystem.
  --json         Machine-readable output instead of the human report.
  --help, -h     Print this help.

DATA ROOT
  This tool reads ONLY the library-written rollup stream under
  <dataRoot>/<service>/logs/rollup/. The production data root is
  $SOX_ECOSYSTEM_HOME or ~/.adhd/sox-ecosystem (ADR-0004). It never reads or writes snapshot files,
  never writes an index.json, and performs no writes of any kind.

EXIT CODES
  0  report emitted, or comparison completed
  1  a --compare release has no rollup row (the error names it)
  2  usage error`;

function parseArgs(argv) {
  const opts = { command: 'report', root: undefined, json: false, help: false, compare: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--report') opts.command = 'report';
    else if (a === '--json') opts.json = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined) { opts.error = '--root needs a directory argument'; break; }
      opts.root = v;
    } else if (a === '--compare') {
      const a1 = argv[++i];
      const a2 = argv[++i];
      if (a1 === undefined || a2 === undefined) { opts.error = '--compare needs two release selectors'; break; }
      opts.command = 'compare';
      opts.compare = [a1, a2];
    } else if (a.startsWith('-')) { opts.error = `unknown option "${a}"`; break; }
    else { opts.error = `unexpected argument "${a}"`; break; }
  }
  return opts;
}

/** Run the CLI. Returns the process exit code (never throws to the caller). */
export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.error !== null) {
    console.error(`metrics-report: ${opts.error}`);
    console.error('Run with --help for usage.');
    return 2;
  }

  const dataRoot = resolveDataRoot(opts);
  const files = await discoverRollupFiles(dataRoot);
  const rows = await readRollupRows(files);
  const entries = groupRollups(rows).map(toEntry);

  if (opts.command === 'compare') {
    const [selA, selB] = opts.compare;
    const a = selectEntry(entries, selA);
    const b = selectEntry(entries, selB);
    const missing = [];
    if (a === null) missing.push(selA);
    if (b === null) missing.push(selB);
    if (missing.length) {
      console.error(
        `metrics-report: no rollup row for release ${missing.map((m) => `"${m}"`).join(' and ')} ` +
          `under ${dataRoot}. Nothing to compare.`,
      );
      return 1;
    }
    const comp = buildComparison(a, b);
    if (opts.json) {
      console.log(JSON.stringify({ root: dataRoot, a, b, series: comp }, null, 2));
    } else {
      console.log(renderCompare(a, b, comp));
    }
    return 0;
  }

  if (opts.json) {
    console.log(JSON.stringify({ root: dataRoot, groups: entries }, null, 2));
  } else {
    console.log(renderReport(entries, dataRoot));
  }
  return 0;
}

// Only execute when invoked directly — never when imported (the test spawns the
// CLI, but a future in-process unit test must be able to import the helpers).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`metrics-report: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
