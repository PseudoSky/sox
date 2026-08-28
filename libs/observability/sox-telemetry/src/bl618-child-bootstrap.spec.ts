/**
 * bl618-child-bootstrap.spec.ts — BL-618 spawn-time telemetry bootstrap
 * convention.
 *
 * Before BL-618, a forked/spawned child that never called `initTelemetry()`
 * (the memory-core enrich fork child was the live instance) silently dropped
 * every `sox.stage.*` / STAGE / OTel record it emitted — role `'harness'`
 * fallback, `logSink:'none'` — while its parent had no way to know. The fix is
 * a convention, not one more `initTelemetry` call: `forkChild`/`spawnWorker`
 * inject `SOX_TELEMETRY_INIT` into the child's env, `bootstrapChildTelemetry`
 * initialises from it (merging over the child's defaults, with role
 * correction), and the child ACKS its state back so no-op children become
 * visible.
 *
 * Also carries the RED→GREEN for BUG-TELEMETRY-DATE-ROLLED-LOGS-NEVER-PRUNED-001:
 * the durable sink pruned on SIZE rotation but never on DATE rollover, so a
 * process writing a little every day accumulated one date-rolled file per day
 * past `maxFiles`, unbounded.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SOX_TELEMETRY_INIT,
  bootstrapChildTelemetry,
  childTelemetrySnapshot,
  forkChild,
  currentRuntimeState,
  _resetTelemetryForTest,
  DurableJsonlSink,
} from './index.js';
import type { InitTelemetryOptions } from './index.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  _resetTelemetryForTest();
});

describe('BL-618: bootstrapChildTelemetry parses + merges SOX_TELEMETRY_INIT', () => {
  it('merges the parent env OVER the caller defaults (last-write-wins on every field)', () => {
    withEnv(
      {
        [SOX_TELEMETRY_INIT]: JSON.stringify({
          service: 'from-parent',
          role: 'cli',
          logSink: 'stderr',
        }),
      },
      () => {
        bootstrapChildTelemetry({ service: 'default-svc', role: 'harness', logSink: 'file' });
        const st = currentRuntimeState();
        expect(st.service).toBe('from-parent');
        expect(st.role).toBe('cli');
        expect(st.logSink).toBe('stderr');
      },
    );
  });

  it('falls back to defaults when the env is absent', () => {
    withEnv({ [SOX_TELEMETRY_INIT]: undefined }, () => {
      bootstrapChildTelemetry({ service: 'default-svc', role: 'harness', logSink: 'none' });
      expect(currentRuntimeState().service).toBe('default-svc');
      expect(currentRuntimeState().role).toBe('harness');
      expect(currentRuntimeState().logSink).toBe('none');
    });
  });

  it('malformed JSON warns on stderr, does NOT throw, and uses defaults', () => {
    withEnv({ [SOX_TELEMETRY_INIT]: '{not-valid-json' }, () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(() => bootstrapChildTelemetry({ service: 'safe-svc', role: 'harness', logSink: 'none' })).not.toThrow();
        expect(currentRuntimeState().service).toBe('safe-svc');
        const warnings = spy.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((line: string) => line.includes('malformed'));
        expect(warnings.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('malformed JSON (non-object / missing service) warns and uses defaults', () => {
    withEnv({ [SOX_TELEMETRY_INIT]: JSON.stringify({ role: 'cli' }) }, () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        bootstrapChildTelemetry({ service: 'safe-svc', role: 'harness', logSink: 'none' });
        expect(currentRuntimeState().service).toBe('safe-svc');
        expect(currentRuntimeState().role).toBe('harness');
        const warnings = spy.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((line: string) => line.includes('malformed'));
        expect(warnings.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('role is corrected through resolveProcessRole — SOX_TELEMETRY_HARNESS=1 wins', () => {
    withEnv(
      {
        [SOX_TELEMETRY_INIT]: JSON.stringify({ service: 'x', role: 'live-service' }),
        SOX_TELEMETRY_HARNESS: '1',
      },
      () => {
        bootstrapChildTelemetry({ service: 'x', role: 'live-service', logSink: 'none' });
        expect(currentRuntimeState().role).toBe('harness');
      },
    );
  });
});

describe('BL-618: childTelemetrySnapshot reports the child\'s own state', () => {
  it('reports service/role/logSink/filePath/pid; filePath null iff logSink !== file', () => {
    withEnv({ [SOX_TELEMETRY_INIT]: undefined }, () => {
      bootstrapChildTelemetry({ service: 'snap-svc', role: 'harness', logSink: 'none' });
      const snap = childTelemetrySnapshot();
      expect(snap.service).toBe('snap-svc');
      expect(snap.role).toBe('harness');
      expect(snap.logSink).toBe('none');
      expect(snap.filePath).toBeNull();
      expect(snap.pid).toBe(process.pid);
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl618-snap-'));
    try {
      bootstrapChildTelemetry({ service: 'snap-file', role: 'harness', logSink: 'file', logDir: dir });
      const snap = childTelemetrySnapshot();
      expect(snap.filePath).toContain(dir);
      expect(snap.filePath).toContain('snap-file.harness-');
      expect(snap.logSink).toBe('file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BL-618: forkChild injects SOX_TELEMETRY_INIT into the child env', () => {
  function echoScript(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl618-fork-'));
    const script = path.join(dir, 'echo-env.js');
    fs.writeFileSync(
      script,
      `process.on('message', () => {\n` +
        `  if (typeof process.send === 'function') process.send({ env: process.env['${SOX_TELEMETRY_INIT}'] });\n` +
        `  process.exit(0);\n` +
        `});\n`,
    );
    return script;
  }

  function once(child: import('node:child_process').ChildProcess): Promise<{ env: string }> {
    return new Promise((resolve) => {
      child.once('message', (msg: { env: string }) => resolve(msg));
    });
  }

  it('the child sees exactly the parent-intended telemetry config', async () => {
    const script = echoScript();
    const telemetry: InitTelemetryOptions = { service: 'child-svc', role: 'harness', logSink: 'file', logDir: '/tmp/bl618' };
    const child = forkChild(script, telemetry, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const received = once(child);
    child.send({});
    const msg = await received;
    expect(JSON.parse(msg.env)).toEqual(telemetry);
    child.unref();
  });

  it('forkChild last-write-wins over an ambient/stale SOX_TELEMETRY_INIT in forkOpts.env', async () => {
    const script = echoScript();
    const telemetry: InitTelemetryOptions = { service: 'child-svc', role: 'harness', logSink: 'none' };
    const child = forkChild(script, telemetry, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { [SOX_TELEMETRY_INIT]: '{"stale":true}' },
    });
    const received = once(child);
    child.send({});
    const msg = await received;
    expect(JSON.parse(msg.env)).toEqual(telemetry);
    child.unref();
  });
});

describe('BUG-TELEMETRY-DATE-ROLLED-LOGS-NEVER-PRUNED-001: date rollover prunes to maxFiles', () => {
  it('a process that rolls over dates (not just sizes) is count-capped at maxFiles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl618-dateprune-'));
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Seed 9 date-rolled files, all safely before "today", for one component.
      for (let i = 1; i <= 9; i++) {
        const d = `2020-01-${String(i).padStart(2, '0')}`;
        fs.writeFileSync(path.join(dir, `dateprune-${d}.jsonl`), '{"event":"seed"}\n');
      }

      const sink = new DurableJsonlSink({ dir, component: 'dateprune', maxFiles: 7 });
      // The first write detects the '' → today rollover (dateRolled) and must
      // prune the accumulated date files down to maxFiles=7.
      sink.write('{"event":"today"}\n');
      sink.close();

      const remaining = fs.readdirSync(dir).filter((f) => f.startsWith('dateprune-') && f.endsWith('.jsonl'));
      expect(remaining.length).toBe(7);
      // The OLDEST dates are the ones that must have been dropped.
      expect(remaining).not.toContain('dateprune-2020-01-01.jsonl');
      expect(remaining).not.toContain('dateprune-2020-01-02.jsonl');
      expect(remaining).not.toContain('dateprune-2020-01-03.jsonl');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a different component\'s files are never pruned by another component\'s rollover (anchor still holds)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl618-dateprune2-'));
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A role-qualified sibling component must survive untouched.
      fs.writeFileSync(path.join(dir, 'dateprune.live-2020-01-01.jsonl'), '{"event":"must-survive"}\n');
      for (let i = 1; i <= 8; i++) {
        const d = `2020-01-${String(i).padStart(2, '0')}`;
        fs.writeFileSync(path.join(dir, `dateprune-${d}.jsonl`), '{"event":"seed"}\n');
      }

      const sink = new DurableJsonlSink({ dir, component: 'dateprune', maxFiles: 7 });
      sink.write('{"event":"today"}\n');
      sink.close();

      expect(fs.existsSync(path.join(dir, 'dateprune.live-2020-01-01.jsonl'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'dateprune.live-2020-01-01.jsonl'), 'utf8')).toContain('must-survive');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
