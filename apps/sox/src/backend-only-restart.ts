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
 * BL-156 refusal: proxy mode with no `SOX_CONFIG_PORT` means the os-unit
 * runs the bare backend entrypoint directly — there is no port-listening
 * front-shim for `--backend-only` to leave alive. Refuse early instead of
 * waiting the full `--wait-ms` for an outcome already known up front.
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
  result: { ok: boolean; reason?: string; before: number[]; after: number[] };
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
