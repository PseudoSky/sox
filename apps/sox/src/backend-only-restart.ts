/**
 * Pure decision logic for `soxe service restart --backend-only`
 * (see `cmdServiceRestart` in `main.ts`, §9.4a/§9.5).
 *
 * Extracted so the CLI contract — non-proxy refusal, unconfigured-port
 * refusal, shim-pid-rotation failure, `result.ok` failure, and success — is
 * unit-testable without spawning the real CLI or touching launchd/systemd.
 * `cmdServiceRestart` calls these functions and writes their `stdout`/`stderr`
 * fields verbatim before `process.exit(exitCode)`.
 */

export interface BackendOnlyOutcome {
  exitCode: 0 | 1;
  stdout?: string;
  stderr?: string;
}

/**
 * §9.5 refusal: `--backend-only` requires the extension to be served in
 * proxy mode — otherwise there is no independent backend/shim split to
 * restart just one half of.
 */
export function checkBackendOnlyProxyModeRefusal(opts: {
  cli: string;
  extId: string;
  isProxyMode: boolean;
}): BackendOnlyOutcome | undefined {
  if (opts.isProxyMode) return undefined;
  return {
    exitCode: 1,
    stderr:
      `${opts.cli} service restart: --backend-only refused — '${opts.extId}' is not served in proxy mode ` +
      `(§9.5); there is no independent backend to restart without the shim. Run without ` +
      `--backend-only, or see docs/spec/service-lifecycle.md §9.5.\n`,
  };
}

/**
 * BL-156 refusal: if the on-disk os-unit's REAL argv does not run the
 * port-listening front-shim (`soxe serve <id> --port <port>`), the unit
 * runs the bare backend entrypoint directly — there is no front-shim for
 * `--backend-only` to leave alive. Refuse early instead of waiting the full
 * `--wait-ms` for an outcome already known up front.
 *
 * `portConfigured` here is really "does the on-disk unit's argv resolve to
 * the front-shim" (`isFrontShimArgv`, same predicate as `shimIsUnit` in
 * proxy-backend-front-shim.ts) — NOT `Boolean(SOX_CONFIG_PORT)`. Config can
 * disagree with what was actually rendered (e.g. the unit was enabled
 * before a port was configured), so the caller (`cmdServiceRestart`,
 * main.ts) must derive this from `extractUnitArgv`/`isFrontShimArgv`
 * against the unit file, not from config.
 */
export function checkBackendOnlyPortRefusal(opts: {
  cli: string;
  extId: string;
  scope: string;
  portConfigured: boolean;
}): BackendOnlyOutcome | undefined {
  if (opts.portConfigured) return undefined;
  return {
    exitCode: 1,
    stderr:
      `${opts.cli} service restart: --backend-only refused — '${opts.extId}' has no SOX_CONFIG_PORT ` +
      `configured, so its os-unit runs the bare backend entrypoint directly (BL-156), not the ` +
      `port-listening front-shim (§9.5) --backend-only exists to leave alive. Configure a port ` +
      `and run \`${opts.cli} service enable ${opts.extId} --scope ${opts.scope}\` first, or restart ` +
      `without --backend-only.\n`,
  };
}

/**
 * Post-restart verdict once `restartAndVerify({kickstart:false, ...})` has
 * returned: refuse if the shim's own pid rotated (it must never change under
 * `--backend-only`), refuse if the deploy could not be verified, otherwise
 * report the rotated backend pid(s).
 */
export function evaluateBackendOnlyOutcome(opts: {
  cli: string;
  label: string;
  beforeMainPid: number | undefined;
  afterMainPid: number | undefined;
  result: {
    ok: boolean;
    reason?: string;
    before: number[];
    after: number[];
    rotatedOnDivergentEntrypoint?: { pids: number[]; running: string[]; resolved: string };
  };
}): BackendOnlyOutcome {
  if (opts.afterMainPid !== opts.beforeMainPid) {
    return {
      exitCode: 1,
      stderr:
        `${opts.cli} service restart: FAILED — --backend-only rotated the shim pid ` +
        `(${opts.beforeMainPid ?? '(none)'} -> ${opts.afterMainPid ?? '(none)'}); the shim must never ` +
        `change under --backend-only. See docs/spec/service-lifecycle.md §9.4a/§9.5.\n`,
    };
  }
  // dc6261c1: the backend rotated, but onto the shim's cached (stale) entrypoint —
  // never report that as a deploy.
  const div = opts.result.rotatedOnDivergentEntrypoint;
  if (div) {
    return {
      exitCode: 1,
      stderr:
        `${opts.cli} service restart: NOT DEPLOYED — --backend-only rotated the backend ` +
        `([${opts.result.before.join(', ') || '(none)'}] -> [${div.pids.join(', ')}]) but the front-shim respawned it on ` +
        `its cached entrypoint [${div.running.join(', ')}], not the lockfile-resolved artifact ${div.resolved}. ` +
        `The running artifact is unchanged. Run a full \`${opts.cli} service restart\` (without --backend-only) ` +
        `to adopt the resolved artifact (dc6261c1; docs/spec/service-lifecycle.md §9.4a).\n`,
    };
  }
  if (!opts.result.ok) {
    return {
      exitCode: 1,
      stderr:
        `${opts.cli} service restart: FAILED — ${opts.result.reason ?? 'backend deploy could not be verified'}. ` +
        `See docs/spec/service-lifecycle.md §9.4a/§9.5.\n`,
    };
  }
  return {
    exitCode: 0,
    stdout:
      `${opts.cli} service restart: '${opts.label}' backend-only deploy — pid(s) rotated ` +
      `([${opts.result.before.join(', ') || '(none)'}] -> [${opts.result.after.join(', ')}])\n`,
  };
}
