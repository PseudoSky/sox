/**
 * recluster-cli.90ba140a.spec.ts — `memory recluster` (2f998081 AC-B5, 90ba140a AC-B5).
 *
 * Failure mode: no CLI verb reached the clustering pass, forcing operators onto
 * the timeout-prone MCP path; and a CLI that waits must map every terminal
 * state to a distinct exit code and never report a queued job as done.
 * Tier: S. Real temp store (explicit --db, HOME is a temp dir — the live
 * ~/.memory/memory.db is unreachable). The memory-server that consumes the job
 * is modelled by the injected `sleep` hook, which claims and settles the job
 * through the same memory-core functions the server tick calls. No process is
 * spawned.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimGlobalReclusterJobs,
  openDb,
  readOpenReclusterJob,
  readReclusterJob,
  settleReclusterJobs,
  type ReclusterSettleOutcome,
} from '@adhd/sox-memory-core';
import { RECLUSTER_EXIT, runCli, runReclusterCommand } from './index.js';

const T = 60_000;
let dir: string;
let dbPath: string;
let lines: string[];
let errs: string[];
let savedHome: string | undefined;

const deps = (extra: Partial<Parameters<typeof runReclusterCommand>[3]> = {}) => ({
  write: (l: string) => lines.push(l),
  error: (l: string) => errs.push(l),
  ...extra,
});

beforeEach(async () => {
  savedHome = process.env['HOME'];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-cli-'));
  process.env['HOME'] = dir;
  dbPath = path.join(dir, 'store.db');
  (await openDb(dbPath)).close();
  lines = [];
  errs = [];
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A "server" that, on the CLI's first poll sleep, runs and settles the open job. */
function serverSettles(outcome: ReclusterSettleOutcome) {
  return async (): Promise<void> => {
    const a = await openDb(dbPath);
    try {
      const job = await readOpenReclusterJob(a);
      if (!job) return;
      await claimGlobalReclusterJobs(a, { maxSeq: job.seq, owner: 'server', leaseMs: 60_000 });
      await settleReclusterJobs(a, job.seq, outcome);
    } finally {
      await a.close();
    }
  };
}

describe('2f998081 AC-B5 recluster verb', () => {
  it('2f998081 AC-B5: without --wait it queues a job, prints the handle, exits 0, and the job is queued in the store', async () => {
    const code = await runReclusterCommand([], dbPath, false, deps());
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/job queued: [0-9a-f-]{36}/);
    const a = await openDb(dbPath);
    expect((await readOpenReclusterJob(a))!.state).toBe('queued');
    await a.close();
  }, T);

  it('90ba140a AC-B5: --wait polls queued -> completed and exits 0', async () => {
    const code = await runReclusterCommand(['--wait', '--poll-ms', '5'], dbPath, false, deps({ sleep: serverSettles({ ok: true }) }));
    expect(code).toBe(RECLUSTER_EXIT.COMPLETED);
    expect(lines.join('\n')).toContain('completed');
  }, T);

  it('90ba140a AC-B5: --wait on a degraded pass exits 3; on a failed pass exits 2', async () => {
    const degraded = await runReclusterCommand(['--wait'], dbPath, false, deps({
      sleep: serverSettles({ ok: false, skipped: true, reason: 'nodeCap: too big', kind: 'nodeCap' }),
    }));
    expect(degraded).toBe(RECLUSTER_EXIT.DEGRADED);
    expect(lines.join('\n')).toContain('reason=nodeCap');
    const failed = await runReclusterCommand(['--wait'], dbPath, false, deps({
      sleep: serverSettles({ ok: false, error: 'timeout', kind: 'child_failed' }),
    }));
    expect(failed).toBe(RECLUSTER_EXIT.FAILED);
  }, T);

  it('90ba140a AC-B5: --wait with no server times out with exit 4 and the job stays queued (never reported done)', async () => {
    let t = 0;
    const code = await runReclusterCommand(['--wait', '--timeout', '1', '--poll-ms', '400'], dbPath, false, deps({
      now: () => t,
      sleep: async (ms) => { t += ms; },
    }));
    expect(code).toBe(RECLUSTER_EXIT.TIMEOUT);
    expect(errs.join('\n')).toContain('timeout');
    const a = await openDb(dbPath);
    expect((await readOpenReclusterJob(a))!.state).toBe('queued');
    await a.close();
  }, T);

  it('90ba140a AC-B3 AC-B5: a second invocation joins the open job (single-flight) instead of queuing another', async () => {
    await runReclusterCommand([], dbPath, false, deps());
    lines.length = 0;
    await runReclusterCommand(['--json'], dbPath, false, deps());
    const out = JSON.parse(lines[0]!) as { joined: boolean; job_id: string };
    expect(out.joined).toBe(true);
    const a = await openDb(dbPath);
    const n = (await a.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM organizer_queue WHERE json_extract(payload,'$.job.job_id') IS NOT NULL`))!.c;
    expect(n).toBe(1);
    expect((await readReclusterJob(a, out.job_id))!.state).toBe('queued');
    await a.close();
  }, T);

  it('90ba140a AC-B5: --json --wait prints the terminal job record', async () => {
    const code = await runReclusterCommand(['--wait', '--json', '--poll-ms', '5'], dbPath, false, deps({ sleep: serverSettles({ ok: true }) }));
    expect(code).toBe(0);
    const rec = JSON.parse(lines[lines.length - 1]!) as { state: string; finished_at: string };
    expect(rec.state).toBe('completed');
    expect(typeof rec.finished_at).toBe('string');
  }, T);

  it('2f998081 AC-B5: filter flags make a filtered job (request recorded); --dry-run on whole store enqueues nothing', async () => {
    await runReclusterCommand(['--project-path', '/p', '--tag', 'a,b', '--importance-min', '3', '--threshold', '0.9'], dbPath, false, deps());
    const a = await openDb(dbPath);
    const job = (await readOpenReclusterJob(a))!;
    expect(job.scope).toBe('subset');
    expect(job.request).toEqual({ filters: { project_path: '/p', tags: ['a', 'b'], importance_min: 3 }, threshold: 0.9, persist: true });
    await a.close();

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-cli2-'));
    const db2 = path.join(dir2, 's.db');
    (await openDb(db2)).close();
    expect(await runReclusterCommand([], db2, true, deps())).toBe(0);
    const b = await openDb(db2);
    expect(await readOpenReclusterJob(b)).toBeNull();
    await b.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }, T);

  it('2f998081 AC-B5: usage errors exit 1 (unknown flag, bad --timeout, missing db)', async () => {
    expect(await runReclusterCommand(['--bogus'], dbPath, false, deps())).toBe(1);
    expect(await runReclusterCommand(['--timeout', 'x'], dbPath, false, deps())).toBe(1);
    expect(await runReclusterCommand([], path.join(dir, 'nope.db'), false, deps())).toBe(1);
  }, T);

  it('2f998081 AC-B5: runCli routes `recluster` and exits with the mapped code', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
    await expect(runCli(['recluster', '--db', dbPath, '--wait', '--timeout', '1', '--poll-ms', '1000'])).rejects.toThrow('exit:4');
    expect(exit).toHaveBeenCalledWith(4);
  }, T);
});
