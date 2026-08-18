/**
 * bl511-telemetry-composition-root.spec.ts — BL-511 acceptance.
 *
 * BEFORE this fix: `apps/sox/src/main.ts` (the `soxe` CLI harness — every
 * `soxe <verb>` invocation) never called `initTelemetry()`. A repo-wide grep
 * for `initTelemetry(` found call sites in memory-server, memory-cli, and
 * fastembedProcessHost's forked child — never in `apps/sox`. Every
 * `@adhd/sox-telemetry` `log.*` call reachable from a `soxe` invocation ran on
 * the module-level fallback (`service:'unlabeled'`, `logSink:'none'`) and was
 * silently dropped — the same root cause as BL-404, this time at the CLI
 * harness itself rather than one MCP server.
 *
 * Drives the REAL BUILT `dist/apps/sox/main.js` as a subprocess (the
 * `bl332-list-reality.spec.ts` convention — CLI specs in this project drive the
 * compiled entrypoint, not `tsx` over source, since `apps/sox` has no
 * `require.main === module` guard to black-box around: the whole file IS the
 * entrypoint, unconditionally, so running the compiled artifact through Node
 * is the real production path) against a SANDBOXED `SOX_ECOSYSTEM_HOME`.
 *
 * Proves two things:
 *
 *   1. (black-box) A real `soxe list` invocation durably persists a
 *      `service:'sox'`, `role:'cli'` JSONL record under
 *      `<SOX_ECOSYSTEM_HOME>/sox/logs/`.
 *   2. (structural role) A real `soxe serve` invocation — which fails fast
 *      (no resolvable extension in the sandbox) but reaches the composition
 *      root BEFORE that failure — persists `role:'live-service'`, proving role
 *      is derived from the verb, not a single hardcoded literal shared by
 *      every subcommand (the exact `role:'cli'`-collapses-everything failure
 *      shape documented for the backlog CLI in
 *      docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-
 *      forensics.md §1d, which this fix deliberately avoids reproducing).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let baseDir: string;
let home: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl511-'));
  home = path.join(baseDir, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(baseDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function readJsonlRecords(logDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const records: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const lines = fs
      .readFileSync(path.join(logDir, f), 'utf8')
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // non-JSONL noise would itself be a regression worth surfacing, but
        // is not this test's concern
      }
    }
  }
  return records;
}

describe('BL-511: sox CLI harness telemetry composition root', () => {
  it(
    'a real `soxe list` invocation persists a service:"sox", role:"cli" JSONL record',
    () => {
      const r = spawnSync(process.execPath, [CLI_MAIN, 'list', '--scope=user', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, SOX_ECOSYSTEM_HOME: home },
      });
      expect(r.status).not.toBeNull();

      const logDir = path.join(home, 'sox', 'logs');
      const records = readJsonlRecords(logDir);

      // THE regression: before BL-511, no call to initTelemetry() ever happened
      // in apps/sox, so logDir never even existed — every log.* emission from a
      // soxe invocation ran on logSink:'none' and produced zero files, zero
      // records, anywhere.
      expect(records.length).toBeGreaterThan(0);
      const rec = records.find((r2) => r2['service'] === 'sox');
      expect(rec).toBeDefined();
      expect(rec!['role']).toBe('cli');
    },
    20_000,
  );

  it(
    'a real `soxe serve` invocation persists role:"live-service" (structural, not a shared literal)',
    () => {
      const r = spawnSync(
        process.execPath,
        [CLI_MAIN, 'serve', 'nonexistent-ext-bl511', '--scope=user'],
        {
          encoding: 'utf8',
          env: { ...process.env, SOX_ECOSYSTEM_HOME: home },
        },
      );
      // The invocation fails fast (no resolvable extension in this sandbox) —
      // that's expected and irrelevant to what this test checks: the
      // composition root runs BEFORE that failure, on every code path, because
      // it is placed unconditionally at module top level.
      expect(r.status).not.toBeNull();

      const logDir = path.join(home, 'sox', 'logs');
      const records = readJsonlRecords(logDir);
      expect(records.length).toBeGreaterThan(0);
      const rec = records.find((r2) => r2['service'] === 'sox');
      expect(rec).toBeDefined();
      // THE structural-role regression: a hardcoded 'cli' literal (the shape
      // BL-501's own doc comment documents the backlog CLI shipping with,
      // §1d) would report 'cli' here too, indistinguishable from the `list`
      // invocation above even though this process is the one that becomes
      // (or is meant to become) the long-lived server.
      expect(rec!['role']).toBe('live-service');
    },
    20_000,
  );

  it(
    'SOX_TELEMETRY_HARNESS=1 overrides `soxe serve` toward role:"harness" (BL-577 pattern, smoke-test parity)',
    () => {
      const r = spawnSync(
        process.execPath,
        [CLI_MAIN, 'serve', 'nonexistent-ext-bl511', '--scope=user'],
        {
          encoding: 'utf8',
          env: { ...process.env, SOX_ECOSYSTEM_HOME: home, SOX_TELEMETRY_HARNESS: '1' },
        },
      );
      expect(r.status).not.toBeNull();

      const logDir = path.join(home, 'sox', 'logs');
      const records = readJsonlRecords(logDir);
      expect(records.length).toBeGreaterThan(0);
      const rec = records.find((r2) => r2['service'] === 'sox');
      expect(rec).toBeDefined();
      expect(rec!['role']).toBe('harness');
    },
    20_000,
  );
});
