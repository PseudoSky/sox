/**
 * scripts/lib/smoke-teardown.mjs — run-teardown logic for the smoke harness
 * (e5cf17a0, 8c3f8f87). Node builtins only; process I/O is injected so
 * tools/test-e5cf17a0-*.mjs and tools/test-8c3f8f87-*.mjs pin it without a build.
 */

/** Leading pid of a `ps -o pid,...` line (NaN when absent). */
function pidOf(line) {
  return Number(String(line).trim().split(/\s+/)[0]);
}

/**
 * e5cf17a0: the no-proxy leg's orphan proof. A process is a teardown SURVIVOR
 * only if it was alive before the teardown and still is; one that shows up only
 * afterwards appeared DURING teardown (e.g. a host re-spawned by a dying
 * server) and is reported separately. An empty `before` means the proof has
 * nothing to show — it is vacuous, never a pass.
 *
 * @param {string[]} before  smoke-tagged ps lines captured right before teardown
 * @param {string[]} after   the same capture right after teardown
 * @returns {{ survivors: string[], appeared: string[], vacuous: boolean, problems: string[] }}
 */
export function diffTeardownSurvivors(before, after) {
  const beforePids = new Set(before.map(pidOf).filter((n) => n > 0));
  const survivors = after.filter((l) => beforePids.has(pidOf(l)));
  const appeared = after.filter((l) => !beforePids.has(pidOf(l)));
  const vacuous = beforePids.size === 0;
  const problems = [];
  if (vacuous) problems.push('orphan proof vacuous: no smoke-tagged process was alive before teardown');
  if (survivors.length > 0) problems.push(`${survivors.length} smoke-tagged process(es) survived teardown (pids ${survivors.map(pidOf).join(', ')})`);
  if (appeared.length > 0) problems.push(`${appeared.length} smoke-tagged process(es) appeared during teardown (pids ${appeared.map(pidOf).join(', ')})`);
  return { survivors, appeared, vacuous, problems };
}

/**
 * e5cf17a0: SIGINT/SIGTERM handling for the harness. An interrupted run used
 * to die with its detached embedding hosts still running and its /tmp alias
 * still in place. On the first signal: run `sweep` (the verified-stop of every
 * smoke-owned host), then `cleanup` (alias removal), then exit 128+signo. A
 * second signal while the sweep runs skips straight to cleanup + exit.
 *
 * @param {NodeJS.Process} proc
 * @param {{ sweep: () => Promise<unknown>, cleanup: () => void, log: (s:string)=>void, exit?: (code:number)=>void }} o
 */
export function installSignalSweep(proc, o) {
  const exit = o.exit ?? ((c) => proc.exit(c));
  const codes = { SIGINT: 130, SIGTERM: 143 };
  let sweeping = false;
  const runCleanup = () => {
    try {
      o.cleanup();
    } catch (e) {
      o.log(`cleanup after signal failed: ${(e && e.message) ?? e}`);
    }
  };
  for (const sig of Object.keys(codes)) {
    proc.on(sig, () => {
      if (sweeping) {
        o.log(`second ${sig} during the embed-host sweep — skipping to cleanup`);
        runCleanup();
        exit(codes[sig]);
        return;
      }
      sweeping = true;
      o.log(`${sig} received — verified-stopping smoke embedding hosts before exit`);
      Promise.resolve()
        .then(() => o.sweep())
        .catch((e) => o.log(`signal sweep failed: ${(e && e.stack) ?? e}`))
        .finally(() => {
          runCleanup();
          exit(codes[sig]);
        });
    });
  }
}

/**
 * 8c3f8f87: fold the run-end checks into the log BEFORE log.json is written.
 * Each `steps` entry becomes a log entry and is counted in `summary`, and the
 * exit code is 2 exactly when a `fatal` step failed — so `summary.failed` is
 * non-zero whenever the exit code is 2, by construction.
 *
 * @param {{ summary: {passed:number, failed:number}, log: object[], steps: {test_id:string, passed:boolean, verdict:string, detail:string, fatal?:boolean}[] }} o
 * @returns {number} the process exit code
 */
export function finalizeRun(o) {
  let fatal = false;
  for (const s of o.steps) {
    o.log.push({
      test_id: s.test_id, extension_id: null, extension_type: 'post-run',
      command: '(post-run assertion)', exit_code: null, signal: null,
      verdict: s.passed ? 'verified' : s.verdict, verdict_detail: s.detail,
      stdout: '', stderr: '', file_changes: [], duration_ms: 0, passed: s.passed, error: null,
    });
    if (s.passed) o.summary.passed++;
    else {
      o.summary.failed++;
      if (s.fatal) fatal = true;
    }
  }
  if (fatal) return 2;
  return o.summary.failed > 0 ? 1 : 0;
}
