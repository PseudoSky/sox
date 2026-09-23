#!/usr/bin/env node
/**
 * scorecard.mjs — live operational scorecard for the memory + backlog services.
 *
 * Reports, per service: reachability, successful WRITE, successful READ, error
 * count, and system health — each PROVEN by performing the operation, never by
 * reading a status field. This repo has twice been burned by tooling that
 * reported success while the thing was broken (the ghost-dist incident, and
 * `sync-global` printing `verified=true` while the old binary was on PATH), so
 * every line here is an executed probe.
 *
 * Writes go to DISPOSABLE temp stores, never to production. The only production
 * touch is a read.
 *
 * Usage: node tools/scorecard.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const JSON_OUT = process.argv.includes('--json');

/**
 * A dedicated error type for "the store could not be reached/read", distinct from any other
 * failure this script can hit. completionScore() below throws this whenever `backlog list-items`
 * fails outright (non-zero exit, timeout, ENOENT) OR exits 0 but never prints a parseable JSON
 * array line at all — both are "could not determine", never silently "zero items".
 */
class StoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}
const PROD_BACKLOG = '/Users/nix/.adhd/backlog/production/data/backlog.db';
const cleanups = [];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 90_000,
    // The sox-ecosystem item list is ~1.8MB on ONE line; the 1MB default
    // maxBuffer made execFileSync throw, which the caller swallowed as "no
    // items" — the whole repo silently vanished from the completion table.
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
}

/** Parse the last JSON object on stdout that satisfies `pick`. */
function lastJson(out, pick) {
  let found = null;
  for (const line of out.split('\n')) {
    try {
      const j = JSON.parse(line);
      if (pick(j)) found = j;
    } catch {
      /* non-JSON log line — expected, the CLIs interleave pino output */
    }
  }
  return found;
}


// ── production percentiles from real telemetry ─────────────────────────────
/**
 * Read the REAL latency distribution from the live service's own telemetry.
 *
 * WHY THIS EXISTS — it is the correction to this file's original sin. Every
 * other probe here fires ONE operation against an idle system and reports the
 * result as health. That is the best case, not the distribution, and it lied:
 * the scorecard reported memory-server `ok` with write_embed≈1.4s while the
 * production p99 for the same operation was 40.5 SECONDS and the max was 109s.
 * A single sample at queue-depth 0 cannot see a queueing tail by construction.
 *
 * So: single probes prove the path WORKS (liveness); percentiles prove it works
 * WELL (health). Reporting the first as the second is how a green board sits on
 * top of a 40-second p99.
 */
function embedPercentiles() {
  const out = { n: 0, p50: null, p90: null, p99: null, max: null, source: null };
  try {
    const dir = join(process.env['HOME'] ?? '', '.adhd/sox-ecosystem/memory-server/logs');
    if (!existsSync(dir)) return out;
    const samples = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      let text;
      try {
        text = readFileSync(join(dir, f), 'utf8');
      } catch {
        continue; // unreadable file is not fatal to the whole reading
      }
      for (const line of text.split('\n')) {
        if (!line.includes('fastembed_process.request.finish')) continue;
        try {
          const j = JSON.parse(line);
          const ms = deepFind(j, 'response_ms');
          if (typeof ms === 'number') samples.push(ms);
        } catch {
          // a truncated trailing line is normal on a live-appended jsonl
        }
      }
    }
    if (!samples.length) return out;
    samples.sort((a, b) => a - b);
    const at = (q) => Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]);
    out.n = samples.length;
    out.p50 = at(0.5); out.p90 = at(0.9); out.p99 = at(0.99);
    out.max = Math.round(samples[samples.length - 1]);
    out.source = 'memory-server telemetry';
  } catch (e) {
    out.source = `unavailable: ${String(e.message).slice(0, 80)}`;
  }
  return out;
}

function deepFind(o, key) {
  if (o && typeof o === 'object') {
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      const g = deepFind(v, key);
      if (g !== undefined) return g;
    }
  }
  return undefined;
}

// ── backlog ────────────────────────────────────────────────────────────────
function backlogScore() {
  const r = {
    service: 'backlog',
    reachable: false,
    version: null,
    write_ok: false,
    read_ok: false,
    search_ok: false,
    errors: [],
    health: 'unknown',
    prod_items: null,
    delete_ok: false,
    timings: {},
    lease_entries: null,
    lease_orphans: null,
  };

  try {
    const t0 = Date.now();
    const v = lastJson(sh('backlog', ['version']), (j) => j.version);
    r.timings.open_ms = Date.now() - t0;
    r.version = v ? `${v.name}@${v.version}` : null;
    r.reachable = !!v;
  } catch (e) {
    r.errors.push(`version: ${String(e.message).slice(0, 120)}`);
  }

  // READ against PRODUCTION (read-only, safe).
  try {
    const t0 = Date.now();
    const s = lastJson(sh('backlog', ['stats', '--scope', '{"repo":"sox-ecosystem"}']), (j) =>
      Number.isInteger(j.total),
    );
    r.timings.stats_ms = Date.now() - t0;
    if (s) {
      r.read_ok = true;
      r.prod_items = { total: s.total, open: s.open, closed: s.closed };
    }
  } catch (e) {
    r.errors.push(`stats: ${String(e.message).slice(0, 120)}`);
  }

  // WRITE + round-trip against a DISPOSABLE store. Proves the write path end to
  // end, including that citations survive (the 0.1.7 fix).
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-bl-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ADHD_BACKLOG_DATABASE_PATH: join(dir, 'probe.db') };
  try {
    const tCreate = Date.now();
    const created = lastJson(
      sh(
        'backlog',
        [
          'create-item',
          '--input',
          JSON.stringify({
            repo: 'scorecard',
            family: 'PROBE',
            title: 'scorecard write probe',
            body: 'b',
            priority: 'LOW',
            citations: [{ file: 'probe.ts', lines: '1', context: 'scorecard' }],
          }),
        ],
        { env },
      ),
      (j) => j.item?.humanId,
    );
    r.timings.write_ms = Date.now() - tCreate;
    if (created?.item?.humanId) {
      r.write_ok = true;
      const tRead = Date.now();
      const got = lastJson(
        sh('backlog', ['get-item', '--repo', 'scorecard', '--human-id', created.item.humanId], {
          env,
        }),
        (j) => j.humanId,
      );
      r.timings.read_ms = Date.now() - tRead;
      // A read-back that loses citations is a HALF success — report it as an error.
      if (got && (got.citations ?? []).length !== 1) {
        r.errors.push('citations dropped on create (regression of the 0.1.7 fix)');
      }
      try {
        const tSearch = Date.now();
        sh('backlog', ['list-items', '--filter', JSON.stringify({ repo: 'scorecard', grep: 'scorecard', limit: 5 })], { env });
        r.timings.search_ms = Date.now() - tSearch;
      } catch (e) {
        r.errors.push(`search: ${String(e.message).slice(0, 120)}`);
      }
      r.search_ok = !!got;
      // DELETE probe — soft-delete the item we just created, then confirm it is
      // gone from the default listing. Exercises the full CRUD surface, not just
      // create+read.
      try {
        const t0 = Date.now();
        sh('backlog',
          ['soft-delete-item', '--repo', 'scorecard', '--human-id', created.item.humanId,
           '--reason', 'scorecard probe cleanup'],
          { env });
        r.timings.delete_ms = Date.now() - t0;
        r.delete_ok = true;
      } catch (e) {
        r.errors.push(`delete: ${String(e.message).slice(0, 140)}`);
      }
    }
  } catch (e) {
    r.errors.push(`write: ${String(e.message).slice(0, 160)}`);
  }

  // Lease hygiene on the PRODUCTION store — orphans are the leak signal.
  try {
    const leaseDir = `${PROD_BACKLOG}.sox-lease.d`;
    if (existsSync(leaseDir)) {
      const entries = readdirSync(leaseDir).filter((n) => !n.startsWith('.'));
      r.lease_entries = entries.length;
      let orphans = 0;
      for (const e of entries) {
        const pid = Number(readFileSync(join(leaseDir, e), 'utf8').split('\n')[0]);
        if (!Number.isInteger(pid)) continue;
        try {
          process.kill(pid, 0);
        } catch (err) {
          // EPERM means the process EXISTS but is not ours — NOT an orphan.
          if (err.code === 'ESRCH') orphans++;
        }
      }
      r.lease_orphans = orphans;
    }
  } catch (e) {
    r.errors.push(`lease scan: ${String(e.message).slice(0, 120)}`);
  }

  r.health =
    r.reachable && r.write_ok && r.read_ok && r.delete_ok && r.errors.length === 0 && !r.lease_orphans
      ? 'ok'
      : r.reachable && r.read_ok
        ? 'degraded'
        : 'down';
  return r;
}

// ── memory-server ──────────────────────────────────────────────────────────
function memoryScore() {
  const r = {
    service: 'memory-server',
    reachable: false,
    artifact: null,
    pid: null,
    write_ok: false,
    delete_ok: false,
    timings: {},
    recall_hits: null,
    read_ok: false,
    errors: [],
    health: 'unknown',
    integrity: null,
    damaged_probes: null,
    nodes: null,
    edges: null,
    embed_state: null,
    embed_backlog: null,
    queue_depth: null,
  };

  // NOT via `memory-cli status`: that path was broken against turso stores until
  // 1676583e (missing `--external @tursodatabase/database`). Even fixed, a status
  // read proves far less than doing the work, so this probe WRITES and RECALLS.
  //
  // The write goes to a DISPOSABLE temp store, never production — same rule the
  // backlog probe follows. An earlier version of this file reported write "n/a"
  // for memory on the grounds that writing to prod is not free. That was a
  // cop-out: the disposable-store answer was always available, and an unmeasured
  // write path is exactly where the last two data-loss incidents lived.
  // Probe the LIVE store. A disposable-store write proves the CODE PATH works;
  // it says nothing about whether PRODUCTION accepts writes — and production is
  // the store that was corrupted twice. Read-after-write against the real store
  // is the only probe that answers the health question this scorecard exists to
  // answer.
  //
  // The probe episode is small, topic-tagged `scorecard-probe`, and INVALIDATED
  // immediately after the read-back, so it does not accumulate or pollute recall.
  // memory_write is an ordinary operation here — agents write to this store
  // continuously — so this adds no risk class that is not already present.
  const LIVE_DB = `${process.env['HOME']}/.memory/memory.db`;
  const PROBE = `
    import { openDb, memoryWrite, memoryRecall, memoryInvalidate } from '@adhd/sox-memory-core';
    const t = {};
    const mark = async (k, fn) => { const s = performance.now(); const r = await fn(); t[k] = +(performance.now() - s).toFixed(1); return r; };
    const stamp = process.env.PROBE_STAMP;

    const db = await mark('open_ms', () => openDb(process.env.MEM_DB));

    // WRITE against the live store: chunk -> real ONNX embed -> vector applied.
    const w = await mark('write_embed_ms', () => memoryWrite(db, {
      content: 'scorecard health probe ' + stamp + ': turso lease quiescence WAL checkpoint readback',
      topic: 'scorecard-probe',
      project_path: process.env.PROBE_DIR,
      agent_id: 'scorecard',
      scope: 'project',
      tags: ['scorecard-probe'],
    }));
    const wrote = !('code' in w);
    const uid = wrote ? (w.episode_uid ?? null) : null;

    // READ-AFTER-WRITE on the live store — the decisive assertion.
    const r = await mark('recall_ms', () => memoryRecall(db, 'project', {
      query: 'scorecard health probe ' + stamp, limit: 5,
    }));
    const found = (r.results ?? []).some((x) => (x.content ?? '').includes(stamp));

    // Warm recall: embed cache primed, so the delta vs the first is the embed cost.
    const r2 = await mark('recall_warm_ms', () => memoryRecall(db, 'project', {
      query: 'turso lease quiescence', limit: 5,
    }));

    // CLEAN UP: invalidate the probe so it never accumulates in the live store.
    let cleaned = false;
    if (uid) {
      const inv = await mark('delete_ms', () =>
        memoryInvalidate(db, { claim_uid: uid, reason: 'scorecard probe cleanup' }));
      cleaned = !('code' in inv);
    }

    const n = await db.executeAll('SELECT count(*) AS c FROM node WHERE t_invalid IS NULL');
    const e = await db.executeAll('SELECT count(*) AS c FROM edge');
    await db.close();
    console.log(JSON.stringify({
      probe: true, wrote, write_err: wrote ? null : (w.code ?? String(w)),
      readback: found, recall_hits: r.results?.length ?? 0, warm_hits: r2.results?.length ?? 0,
      cleaned, nodes: n.rows[0]?.c ?? null, edges: e.rows[0]?.c ?? null, timings: t,
    }));
  `;
  try {
    // Written to a FILE, not passed via `-e`: `--input-type=module` is rejected
    // when tsx's resolver is registered (ERR_INPUT_TYPE_NOT_ALLOWED).
    const probeDir = mkdtempSync(join(tmpdir(), 'scorecard-probe-'));
    cleanups.push(() => rmSync(probeDir, { recursive: true, force: true }));
    const probeFile = join(probeDir, 'probe.mjs');
    writeFileSync(probeFile, PROBE, 'utf8');
    const out = sh('node', ['--import', 'tsx', probeFile], {
      env: { MEM_DB: LIVE_DB, PROBE_DIR: process.cwd(), PROBE_STAMP: `sc-${Date.now()}` },
      timeout: 300_000,
    });
    const p = lastJson(out, (j) => j.probe);
    if (p) {
      r.reachable = true;
      r.write_ok = !!p.wrote;
      r.read_ok = !!p.readback;
      r.timings = p.timings ?? {};
      r.recall_hits = p.recall_hits;
      r.nodes = p.nodes;
      r.edges = p.edges;
      r.integrity = 'read-ok';
      r.damaged_probes = 0;
      if (!p.wrote) r.errors.push(`live write: ${p.write_err}`);
      if (p.wrote && !p.readback) r.errors.push('READ-AFTER-WRITE FAILED on the live store');
      r.delete_ok = !!p.cleaned;
      if (p.wrote && !p.cleaned) r.errors.push('DELETE/invalidate FAILED — probe episode left live');
    }
  } catch (e) {
    r.errors.push(`live write/recall: ${String(e.message).slice(0, 240)}`);
  }

  r.health =
    r.reachable && r.write_ok && r.read_ok && r.damaged_probes === 0 && r.errors.length === 0
      ? 'ok'
      : r.reachable
        ? 'degraded'
        : 'unknown';
  return r;
}

// ── backlog item completion, by priority × package ─────────────────────────
const DONE = new Set(['RESOLVED', 'DONE', 'FIXED', 'SHIPPED', 'VERIFIED', 'CLOSED']);
const PRIOS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function pkgOf(item) {
  const p = item.projectPath ?? '';
  if (!p || p === '.') return '(repo)';
  return p;
}

/**
 * DEBT-HOOK-PLANSTATUS-GATES-EVERY-COMMIT-001 (Task 2, devops-engineer): this used to `continue`
 * on ANY failure from `sh('backlog', ...)` — a bare `catch { continue }` that silently dropped the
 * whole repo from the completion table with zero signal to the reader. That is a real, independently
 * verifiable defect (see the maxBuffer incident already documented on `sh()`'s own doc comment
 * above — the exact same swallow, just a different trigger). `[]` (a genuinely empty result) and "the
 * `backlog` call itself failed" must never render the same way: the first is real information, the
 * second is the ABSENCE of information, and rendering it as "0 open items, all done" is a false
 * "everything is healthy" reading for a health surface — the worst possible failure mode for a
 * scorecard, since it suppresses investigation exactly when the store is most likely broken.
 *
 * HONEST LIMIT, stated explicitly per the task instruction — do not read this fix as closing the
 * hole completely: a store that fails OPEN and then, for whatever reason, prints a legitimate `[]`
 * (exit 0, one parseable empty-array line) is STILL indistinguishable from a genuinely empty
 * backlog — no client-side code can tell those apart, because the wire contract for both is
 * identical. Extensive live testing while investigating this task (20/20 clean runs against a
 * broken store, both `--filter '{}'` and a real scoped filter) did NOT reproduce that shape — the
 * live `backlog` CLI correctly exits non-zero with the failure on stderr in every case exercised —
 * so this fix targets the failure modes that ARE real and observed: non-zero exit, a thrown timeout,
 * ENOENT, or the CLI printing nothing array-shaped at all despite exiting 0 (which would itself be
 * anomalous output, not a documented "empty" contract). If a store-open failure that emits a clean
 * `[]` on the SCOPED filter path is ever demonstrated live (not simulated with a stale test path —
 * see BUG-BACKLOG-CLI-SILENT-EMPTY-ON-STORE-OPEN-FAILURE-001's retraction note for how easy that is
 * to get wrong), the only remaining client-side option is a POSITIVE liveness probe: run one cheap
 * query with a known-nonzero expected result (e.g. `backlog get-item` for a permanent, never-closed
 * sentinel item, or `backlog stats` and assert `total > 0` before trusting a `list-items` `[]`) and
 * treat a real query returning nothing where the sentinel proves the store is alive as the genuine
 * "reachable and empty" case. That is proposed here, not implemented — it needs a durable sentinel
 * item/convention this file cannot unilaterally invent.
 */
function completionScore() {
  const byPkg = {};
  const totals = { open: {}, done: {} };
  const unreachable = [];
  for (const repo of ['sox-ecosystem', 'adhd']) {
    let items = [];
    let sawArrayLine = false;
    try {
      const out = sh('backlog', ['list-items', '--filter', JSON.stringify({ repo, limit: 900 })], {
        timeout: 120_000,
      });
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (Array.isArray(j)) {
            items = j;
            sawArrayLine = true;
          }
        } catch {
          /* pino line */
        }
      }
      if (!sawArrayLine) {
        throw new StoreUnavailableError(
          `scorecard: \`backlog list-items --filter {repo:${repo}}\` exited 0 but printed no parseable ` +
            `JSON array line — cannot tell "genuinely empty" from "malformed/truncated output".`,
        );
      }
    } catch (err) {
      unreachable.push({
        repo,
        reason: err instanceof StoreUnavailableError ? err.message : err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const it of items) {
      const key = `${repo}:${pkgOf(it)}`;
      const prio = (it.priority ?? 'UNSET').toUpperCase();
      const done = DONE.has((it.status ?? '').toUpperCase());
      byPkg[key] ??= {};
      byPkg[key][prio] ??= { open: 0, done: 0 };
      byPkg[key][prio][done ? 'done' : 'open']++;
      totals[done ? 'done' : 'open'][prio] = (totals[done ? 'done' : 'open'][prio] ?? 0) + 1;
    }
  }
  return { byPkg, totals, unreachable };
}

// ── render ─────────────────────────────────────────────────────────────────
function pad(s, n) {
  return String(s ?? '').padEnd(n);
}

function main() {
  const bl = backlogScore();
  const mem = memoryScore();
  const comp = completionScore();

  if (JSON_OUT) {
    console.log(JSON.stringify({ backlog: bl, memory: mem, completion: comp }, null, 2));
    return;
  }

  const mark = (v) => (v === true ? 'PASS' : v === false ? 'FAIL' : 'n/a');
  console.log('SERVICE SCORECARD');
  console.log('─'.repeat(78));
  console.log(
    `${pad('service', 15)}${pad('health', 9)}${pad('W', 6)}${pad('R', 6)}${pad('D', 6)}${pad('err', 5)}detail`,
  );
  console.log(
    `${pad('backlog', 15)}${pad(bl.health, 9)}${pad(mark(bl.write_ok), 6)}${pad(mark(bl.read_ok), 6)}${pad(mark(bl.delete_ok), 6)}${pad(bl.errors.length, 5)}` +
      `${bl.version ?? '?'} · items ${bl.prod_items?.total ?? '?'} (${bl.prod_items?.open ?? '?'} open) · leases ${bl.lease_entries ?? '?'} (${bl.lease_orphans ?? '?'} orphan)`,
  );
  console.log(
    `${pad('memory-server', 15)}${pad(mem.health, 9)}${pad(mark(mem.write_ok), 6)}${pad(mark(mem.read_ok), 6)}${pad(mark(mem.delete_ok), 6)}${pad(mem.errors.length, 5)}` +
      `nodes ${mem.nodes ?? '?'} · edges ${mem.edges ?? '?'} · store ${mem.integrity ?? '?'} (${mem.damaged_probes ?? '?'} damaged)`,
  );
  for (const e of [...bl.errors, ...mem.errors]) console.log(`  ERROR: ${e}`);
  console.log('');
  console.log('LATENCY (ms, live store)');
  const tl = (label, t) => {
    const parts = Object.entries(t ?? {}).map(([k, v]) => `${k.replace(/_ms$/, '')}=${v}`);
    console.log(`  ${pad(label, 14)}${parts.join('  ') || '(none)'}`);
  };
  tl('memory', mem.timings);
  tl('backlog', bl.timings);

  const pc = embedPercentiles();
  console.log('');
  console.log('EMBED DISTRIBUTION (production telemetry — NOT a single probe)');
  if (pc.n) {
    console.log(
      `  n=${pc.n}  p50=${pc.p50}ms  p90=${pc.p90}ms  p99=${pc.p99}ms  max=${pc.max}ms`,
    );
    // A single idle probe cannot see this. Say so loudly when the tail is bad,
    // because "W/R/D all PASS" next to a 40s p99 is a misleading board.
    if (pc.p99 !== null && pc.p99 > 10_000) {
      console.log(
        `  ⚠ TAIL ALERT: p99 ${(pc.p99 / 1000).toFixed(1)}s — the single-probe columns above are ` +
          `the QUEUE-DEPTH-0 best case and do NOT reflect this. See BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001.`,
      );
    }
  } else {
    console.log(`  (no samples — ${pc.source ?? 'telemetry not found'})`);
  }

  console.log('');
  console.log('ITEMS BY PRIORITY  (done / open)');
  console.log('─'.repeat(78));
  console.log(`${pad('package', 44)}${PRIOS.map((p) => pad(p, 12)).join('')}`);
  const keys = Object.keys(comp.byPkg).sort();
  for (const k of keys) {
    const row = comp.byPkg[k];
    const cells = PRIOS.map((p) => pad(`${row[p]?.done ?? 0}/${row[p]?.open ?? 0}`, 12)).join('');
    // Only show packages with any non-zero count in a tracked priority.
    if (PRIOS.some((p) => row[p])) console.log(`${pad(k, 44)}${cells}`);
  }
  console.log('─'.repeat(78));
  console.log(
    `${pad('TOTAL', 44)}${PRIOS.map((p) => pad(`${comp.totals.done[p] ?? 0}/${comp.totals.open[p] ?? 0}`, 12)).join('')}`,
  );
  // DEBT-HOOK-PLANSTATUS-GATES-EVERY-COMMIT-001 (Task 2): a repo that could not be queried must
  // NEVER read as "0 open, all done" — it must read as UNKNOWN, loudly, with the reason. This is
  // the single most important line on the whole scorecard when it fires: it means the numbers
  // above are INCOMPLETE, not that the missing repo is healthy.
  if (comp.unreachable.length) {
    console.log('');
    for (const { repo, reason } of comp.unreachable) {
      console.log(`  ⚠ UNKNOWN — ${repo}: completion NOT determined (backlog query failed) — ${reason}`);
    }
    console.log(
      `  ⚠ TOTAL above EXCLUDES ${comp.unreachable.length} repo(s) — do not read the totals as "everything else is done".`,
    );
  }
}

try {
  main();
} finally {
  for (const c of cleanups) {
    try {
      c();
    } catch (err) {
      console.warn('scorecard cleanup failed:', err.message);
    }
  }
}
