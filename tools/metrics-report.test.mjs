#!/usr/bin/env node
/**
 * tools/metrics-report.test.mjs — red→green for [Durable metrics S6]
 * 0a3faad7-48e4-4635-98c7-13bd37663f7b, the pure-read rollup report CLI.
 *
 * Exercises the CLI END-TO-END as a child process against a throwaway temp data
 * root, proving the four load-bearing properties:
 *   1. `--report` emits one entry per (service, role, release) using the NEWEST
 *      row (max ts) and surfaces that row's trailing window + the group's oldest
 *      rollup ts (the coverage horizon).
 *   2. `--report` MUTATES NOTHING — the temp tree's file list and bytes are
 *      byte-identical before and after (the read-only contract; no `index.json`).
 *   3. `--compare <A> <B>` prints a per-series delta (absolute and %) for a
 *      series present in both releases' newest rows, and accepts both the
 *      `version` string and a full `artifact_sha256` (with/without `sha256:`).
 *   4. a `--compare` naming a release with no rollup row exits non-zero and the
 *      error names the missing release.
 * Plus: the data-root resolution honours `--root` over `SOX_ECOSYSTEM_HOME`, a
 * rotated (`.<epoch>-<seq>.jsonl`) file is read, and a malformed/partial line
 * never breaks the run.
 *
 * Run: node --test tools/metrics-report.test.mjs
 *      (plain node:test — the sibling `tools/*.test.mjs` convention; each file
 *       is also runnable directly as `node tools/metrics-report.test.mjs`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const UID = '0a3faad7-48e4-4635-98c7-13bd37663f7b';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'metrics-report.mjs');

/** Spawn the CLI and capture status + streams (never throws on non-zero). */
function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: env ?? process.env,
  });
}

/** Release identities with distinct versions and artifact shas. */
const REL = {
  a: { version: '1.4.2', artifact_sha256: 'a'.repeat(64), git_sha: '1'.repeat(40) },
  b: { version: '1.4.3', artifact_sha256: 'b'.repeat(64), git_sha: '2'.repeat(40) },
  c: { version: '1.4.4', artifact_sha256: 'c'.repeat(64), git_sha: '3'.repeat(40) },
};

function series(rss) {
  return {
    'process.rss_bytes': { agg: 'gauge', samples: 3, min: rss, mean: rss, p50: rss, p99: rss, max: rss, sum: rss * 3, value: rss },
    'cpu.percent': { agg: 'gauge', samples: 3, min: 1, mean: 1, p50: 1, p99: 1, max: 1, sum: 3, value: 1 },
    'write_latency_ms': { agg: 'max_of_percentiles', samples: 2, min: 2, mean: 3, p50: 2, p99: 5, max: 5, sum: null, value: 5 },
  };
}

function rollupRow({ service, role, ts, release, rss, processPid = 1234 }) {
  return {
    ts,
    level: 'info',
    event: 'metrics.rollup',
    service,
    role,
    pid: 999,
    process_pid: processPid,
    release,
    reason: 'interval',
    window: { from: Date.parse(ts) - 3_600_000, to: Date.parse(ts), kind: 'trailing' },
    snapshots_in_window: 12,
    series: series(rss),
    self_check: { stages_declared: 3, stages_with_zero_samples: [], paths_with_zero_samples: [] },
    otel: { state: 'ready' },
  };
}

/**
 * A throwaway data root containing:
 *   alpha.live  — release 1.4.2 (two rows: older 04:00Z + newer 05:00Z) and
 *                 release 1.4.3 (one row 05:00Z), plus deliberate junk lines;
 *   beta.worker — release 1.4.4, newest in the dated file, an older row in a
 *                 ROTATED (.<epoch>-<seq>) file.
 * Total: 3 (service, role, release) groups.
 */
function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-report-'));
  const dirA = path.join(root, 'alpha', 'logs', 'rollup');
  const dirB = path.join(root, 'beta', 'logs', 'rollup');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const aLines = [
    JSON.stringify(rollupRow({ service: 'alpha', role: 'live', ts: '2026-09-30T04:00:00.000Z', release: REL.a, rss: 900 })),
    JSON.stringify(rollupRow({ service: 'alpha', role: 'live', ts: '2026-09-30T05:00:00.000Z', release: REL.a, rss: 1000 })),
    JSON.stringify(rollupRow({ service: 'alpha', role: 'live', ts: '2026-09-30T05:00:00.000Z', release: REL.b, rss: 1100 })),
    '{"event":"metrics.rollup","service":"alpha"', // truncated trailing line (mid-write)
    'not json at all', // foreign garbage line
    JSON.stringify({ event: 'other.event', service: 'alpha', ts: '2026-09-30T05:00:00.000Z' }), // ignored
    '',
  ];
  fs.writeFileSync(path.join(dirA, 'alpha.live.metrics-rollup-2026-09-30.jsonl'), aLines.join('\n'));

  fs.writeFileSync(
    path.join(dirB, 'beta.worker.metrics-rollup-2026-09-30.jsonl'),
    JSON.stringify(rollupRow({ service: 'beta', role: 'worker', ts: '2026-09-30T05:00:00.000Z', release: REL.c, rss: 2000 })) + '\n',
  );
  // A rotated file (suffix `.<epoch>-<seq>`) holding an older row of the SAME group.
  fs.writeFileSync(
    path.join(dirB, 'beta.worker.metrics-rollup-2026-09-29.1750000000000-1.jsonl'),
    JSON.stringify(rollupRow({ service: 'beta', role: 'worker', ts: '2026-09-29T05:00:00.000Z', release: REL.c, rss: 1900 })) + '\n',
  );

  return root;
}

/** Relative-path -> file bytes, for the before/after zero-mutation check. */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

test(`${UID}: reads library-written rollups and performs zero writes`, () => {
  const root = writeFixture();
  try {
    const before = snapshotTree(root);
    const res = runCli(['--root', root, '--report']);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    // The three (service, role, release) groups are present in the human report.
    for (const token of ['alpha', 'live', '1.4.2', '1.4.3', 'beta', 'worker', '1.4.4']) {
      assert.ok(res.stdout.includes(token), `report must name ${token}`);
    }

    const after = snapshotTree(root);
    assert.deepEqual(
      [...after.entries()].sort(),
      [...before.entries()].sort(),
      'the report must not create, rewrite, or delete a single byte under the data root',
    );
    assert.ok(
      ![...after.keys()].some((p) => p.endsWith('index.json')),
      'no index.json may be written',
    );
  } finally {
    cleanup(root);
  }
});

test('--report emits one entry per (service, role, release) using the newest row', () => {
  const root = writeFixture();
  try {
    const res = runCli(['--root', root, '--report', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const body = parseJson(res.stdout);
    assert.equal(body.root, root);
    assert.equal(body.groups.length, 3, 'exactly three groups');

    const a = body.groups.find((g) => g.service === 'alpha' && g.role === 'live' && g.release.version === '1.4.2');
    assert.ok(a, 'alpha/live/1.4.2 group present');
    assert.equal(a.newest_ts, '2026-09-30T05:00:00.000Z', 'newest row (max ts) is used');
    assert.equal(a.oldest_rollup_ts, '2026-09-30T04:00:00.000Z', 'oldest rollup ts is the coverage horizon');
    assert.equal(a.window.kind, 'trailing');
    assert.equal(a.window.to, Date.parse('2026-09-30T05:00:00.000Z'), 'window comes from the newest row');
    assert.equal(a.series['process.rss_bytes'].value, 1000, 'newest row wins the value, not the older 900');

    // The rotated file is read: beta's group horizon reaches back to 09-29.
    const beta = body.groups.find((g) => g.service === 'beta');
    assert.ok(beta, 'beta group present');
    assert.equal(beta.newest_ts, '2026-09-30T05:00:00.000Z');
    assert.equal(beta.oldest_rollup_ts, '2026-09-29T05:00:00.000Z');
  } finally {
    cleanup(root);
  }
});

test('--compare prints a per-series delta (absolute and %) for a series in both releases', () => {
  const root = writeFixture();
  try {
    // Human output: the delta and its percentage are both present.
    const human = runCli(['--root', root, '--compare', '1.4.2', '1.4.3']);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes('process.rss_bytes'), 'names the compared series');
    assert.ok(human.stdout.includes('+100'), 'absolute delta B-A is +100');
    assert.ok(human.stdout.includes('+10.00%'), 'percentage delta is +10.00%');

    // JSON output pins the exact numbers.
    const json = runCli(['--root', root, '--compare', '1.4.2', '1.4.3', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const body = parseJson(json.stdout);
    assert.equal(body.a.release.version, '1.4.2');
    assert.equal(body.b.release.version, '1.4.3');
    const rss = body.series.find((s) => s.name === 'process.rss_bytes');
    assert.deepEqual(
      { a: rss.a, b: rss.b, delta: rss.delta, pct: rss.delta_pct },
      { a: 1000, b: 1100, delta: 100, pct: 10 },
    );
  } finally {
    cleanup(root);
  }
});

test('--compare accepts a full artifact_sha256, with and without the sha256: prefix', () => {
  const root = writeFixture();
  try {
    const withPrefix = runCli(['--root', root, '--compare', `sha256:${REL.a.artifact_sha256}`, REL.b.artifact_sha256, '--json']);
    assert.equal(withPrefix.status, 0, withPrefix.stderr);
    const body = parseJson(withPrefix.stdout);
    assert.equal(body.a.release.version, '1.4.2', 'sha256:-prefixed sha resolves to release A');
    assert.equal(body.b.release.version, '1.4.3', 'bare sha resolves to release B');

    const bare = runCli(['--root', root, '--compare', REL.a.artifact_sha256, `sha256:${REL.b.artifact_sha256}`, '--json']);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(parseJson(bare.stdout).a.release.version, '1.4.2');
  } finally {
    cleanup(root);
  }
});

test('--compare exits non-zero and names the missing release', () => {
  const root = writeFixture();
  try {
    const res = runCli(['--root', root, '--compare', '1.4.2', '9.9.9']);
    assert.notEqual(res.status, 0, 'a comparison against an absent release must fail');
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /9\.9\.9/, 'the error must name the missing release');

    // A release absent from BOTH sides fails too, and still exits non-zero.
    const both = runCli(['--root', root, '--compare', '9.9.8', '9.9.9']);
    assert.notEqual(both.status, 0);
    assert.match(`${both.stdout}\n${both.stderr}`, /9\.9\.8/);
  } finally {
    cleanup(root);
  }
});

test('data root: --root wins over SOX_ECOSYSTEM_HOME; SOX_ECOSYSTEM_HOME is honoured alone', () => {
  const root = writeFixture();
  try {
    // --root wins even when SOX_ECOSYSTEM_HOME points somewhere else entirely.
    const viaRoot = runCli(['--root', root, '--report', '--json'], {
      ...process.env,
      SOX_ECOSYSTEM_HOME: path.join(root, 'does-not-exist'),
    });
    assert.equal(viaRoot.status, 0, viaRoot.stderr);
    assert.equal(parseJson(viaRoot.stdout).groups.length, 3, '--root must win over the env var');

    // With no --root, SOX_ECOSYSTEM_HOME is the root.
    const viaEnv = runCli(['--report', '--json'], { ...process.env, SOX_ECOSYSTEM_HOME: root });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(parseJson(viaEnv.stdout).root, root, 'env var root is honoured');
    assert.equal(parseJson(viaEnv.stdout).groups.length, 3);
  } finally {
    cleanup(root);
  }
});

test('--help documents the subcommands, the selector forms and the data root', () => {
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  for (const token of ['--report', '--compare', 'sha256:', 'SOX_ECOSYSTEM_HOME', '.adhd/sox-ecosystem', '--root']) {
    assert.ok(res.stdout.includes(token), `help must document ${token}`);
  }
});

test('a malformed or partial line is skipped, never thrown on', () => {
  const root = writeFixture();
  try {
    // The fixture file already carries a truncated JSON line and a garbage line;
    // the run must still succeed and read the valid rows.
    const res = runCli(['--root', root, '--report', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(parseJson(res.stdout).groups.length, 3);
  } finally {
    cleanup(root);
  }
});

test('--report on an empty root exits 0 with a clear "nothing to report" line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-report-empty-'));
  try {
    const res = runCli(['--root', root, '--report']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no rollup rows found/);
  } finally {
    cleanup(root);
  }
});
