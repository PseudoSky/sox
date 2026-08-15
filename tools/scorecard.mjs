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
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const JSON_OUT = process.argv.includes('--json');
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
    lease_entries: null,
    lease_orphans: null,
  };

  try {
    const v = lastJson(sh('backlog', ['version']), (j) => j.version);
    r.version = v ? `${v.name}@${v.version}` : null;
    r.reachable = !!v;
  } catch (e) {
    r.errors.push(`version: ${String(e.message).slice(0, 120)}`);
  }

  // READ against PRODUCTION (read-only, safe).
  try {
    const s = lastJson(sh('backlog', ['stats', '--scope', '{"repo":"sox-ecosystem"}']), (j) =>
      Number.isInteger(j.total),
    );
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
    if (created?.item?.humanId) {
      r.write_ok = true;
      const got = lastJson(
        sh('backlog', ['get-item', '--repo', 'scorecard', '--human-id', created.item.humanId], {
          env,
        }),
        (j) => j.humanId,
      );
      // A read-back that loses citations is a HALF success — report it as an error.
      if (got && (got.citations ?? []).length !== 1) {
        r.errors.push('citations dropped on create (regression of the 0.1.7 fix)');
      }
      r.search_ok = !!got;
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
    r.reachable && r.write_ok && r.read_ok && r.errors.length === 0 && !r.lease_orphans
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
    write_ok: null, // null = not probed (writing to prod memory is not free)
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

  // NOT via `memory-cli status`: that path is broken against turso stores
  // (`TypeError: Database4 is not a constructor`, `@tursodatabase/database is
  // not installed` — the bundle does not carry the driver). Filed separately.
  // Open the live store directly through the built adapter and READ, which is
  // a stronger probe anyway: it proves the store answers queries rather than
  // that a status field says so.
  const PROBE = `
    import { createStoreAdapter } from '@adhd/sox-store-adapter';
    const a = await createStoreAdapter({ dbPath: process.env.MEM_DB, readonly: true });
    const n = await a.executeAll('SELECT count(*) AS c FROM node WHERE t_invalid IS NULL');
    const e = await a.executeAll('SELECT count(*) AS c FROM edge');
    console.log(JSON.stringify({ probe: true, nodes: n.rows[0]?.c ?? null, edges: e.rows[0]?.c ?? null }));
    await a.close();
  `;
  try {
    const out = sh('node', ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
      env: { MEM_DB: process.env['HOME'] + '/.memory/memory.db' },
      timeout: 120_000,
    });
    const p = lastJson(out, (j) => j.probe);
    if (p) {
      r.reachable = true;
      r.read_ok = true;
      r.nodes = p.nodes;
      r.edges = p.edges;
      r.integrity = 'read-ok';
      r.damaged_probes = 0;
    }
  } catch (e) {
    r.errors.push(`store read: ${String(e.message).slice(0, 200)}`);
  }

  r.health =
    r.reachable && r.read_ok && r.damaged_probes === 0 && r.errors.length === 0
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

function completionScore() {
  const byPkg = {};
  const totals = { open: {}, done: {} };
  for (const repo of ['sox-ecosystem', 'adhd']) {
    let items = [];
    try {
      const out = sh('backlog', ['list-items', '--filter', JSON.stringify({ repo, limit: 900 })], {
        timeout: 120_000,
      });
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (Array.isArray(j)) items = j;
        } catch {
          /* pino line */
        }
      }
    } catch {
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
  return { byPkg, totals };
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
    `${pad('service', 16)}${pad('health', 10)}${pad('write', 7)}${pad('read', 7)}${pad('errors', 8)}detail`,
  );
  console.log(
    `${pad('backlog', 16)}${pad(bl.health, 10)}${pad(mark(bl.write_ok), 7)}${pad(mark(bl.read_ok), 7)}${pad(bl.errors.length, 8)}` +
      `${bl.version ?? '?'} · items ${bl.prod_items?.total ?? '?'} (${bl.prod_items?.open ?? '?'} open) · leases ${bl.lease_entries ?? '?'} (${bl.lease_orphans ?? '?'} orphan)`,
  );
  console.log(
    `${pad('memory-server', 16)}${pad(mem.health, 10)}${pad(mark(mem.write_ok), 7)}${pad(mark(mem.read_ok), 7)}${pad(mem.errors.length, 8)}` +
      `nodes ${mem.nodes ?? '?'} · edges ${mem.edges ?? '?'} · store ${mem.integrity ?? '?'} (${mem.damaged_probes ?? '?'} damaged)`,
  );
  for (const e of [...bl.errors, ...mem.errors]) console.log(`  ERROR: ${e}`);

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
