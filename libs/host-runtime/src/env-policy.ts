/**
 * env-policy.ts — the ONE definition of how a child process's environment is
 * scrubbed under `policy.enforced` (BL-344).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * This logic previously existed as **five hand-maintained copies** across two
 * packages:
 *
 *   1. `apps/sox/src/main.ts`            — `buildOsUnitEnv()`, the launchd unit
 *   2. `apps/sox/src/main.ts`            — the `soxe serve` backend spawn
 *   3. `apps/sox/src/main.ts`            — `cmdExec`
 *   4. `libs/host-runtime/src/supervisor.ts`   — in-process supervisor spawn
 *   5. `libs/host-runtime/src/runtime-cli.ts`  — the runtime CLI exec path
 *
 * Adding a tunable required editing all five. Nobody ever did. **They had
 * measurably drifted at the time this was written**, which is the whole case
 * for this file:
 *
 * | copy | `SOX_DISABLE_EMBED_HEAL` | `SOX_DISABLE_PERIODIC_ENRICH` |
 * |---|---|---|
 * | main.ts buildOsUnitEnv | yes | yes |
 * | main.ts serve          | yes | yes |
 * | main.ts cmdExec        | yes | yes |
 * | supervisor.ts          | yes | **NO** |
 * | runtime-cli.ts         | **NO** | **NO** |
 *
 * (Both emergency-brake vars were deleted 2026-08-11 — they were anti-features,
 * ADR-0013: "Disable heal???", "why would the store not repair". The table is
 * retained as the incident record; the drift it documents is why this prefix
 * policy exists.)
 *
 * The cost was not theoretical. `SOX_DISABLE_EMBED_HEAL` was set on the live
 * launchd unit to mitigate a read outage and had **zero effect**, because a
 * different copy re-scrubbed it away before the backend was spawned. The var
 * was present in the `.plist` and absent from `ps eww <backend-pid>` — so
 * verifying the plist produced a false green. Separately, `SOX_RECALL_EMBED_TIMEOUT_MS`
 * and all four `SOX_MEMORY_LOG_*` controls shipped **non-functional in the
 * deployed configuration on their first outing**, and nothing reported it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * An allowlist that every new tunable must remember to join, in five places,
 * fails open in the direction of silence. This replaces it with a **principled
 * prefix policy plus an explicit deny-list**:
 *
 *   - Base process keys (`PATH`, `HOME`, locale, …) — forwarded.
 *   - `NODE_*` — forwarded. Scrubbing `NODE_OPTIONS`/`NODE_PATH` breaks native
 *     addon loading (better-sqlite3), which is why this prefix already existed.
 *   - `SOX_*` — forwarded, EXCEPT the denied prefixes below.
 *   - Everything else — dropped, as before.
 *
 * ── This does NOT weaken the sandbox. It is the reason the deny-list exists ──
 *
 * Forwarding `SOX_*` wholesale WOULD weaken it, because two `SOX_` namespaces
 * are **host-authoritative** and must never be inherited from an ambient
 * environment:
 *
 *   - `SOX_PERM_*` — the compiled permission policy (`policy.toEnv()`:
 *     `SOX_PERM_ENFORCE` plus the fs/net allowlist JSON). A child that inherited
 *     these from the calling shell would let anyone who can set an env var
 *     before the spawn widen — or switch off — the sandbox. That is privilege
 *     escalation, and it is the single genuinely unsafe case.
 *   - `SOX_CONFIG_*` — the resolved extension-config cascade
 *     (`buildExtConfigEnv`). Inheriting these silently overrides resolved
 *     config with whatever happened to be exported.
 *
 * Today both are blocked only *incidentally* — they do not match the old
 * allowlist, and the call sites additionally re-apply the authoritative values
 * last so an inherited one would be overwritten. Under a `SOX_*` prefix rule
 * that incidental protection disappears, so the deny-list makes it **explicit
 * and load-bearing**. Net security posture is unchanged for `SOX_PERM_*`/
 * `SOX_CONFIG_*` and unchanged for non-`SOX_` variables; only operator-facing
 * tunables become forwardable.
 *
 * ── Dropped variables are never silent ──────────────────────────────────────
 *
 * {@link scrubEnv} returns every denied `SOX_*` key alongside the env. Callers
 * report it (see {@link formatDeniedEnvWarning}). A tunable that vanishes
 * without a trace is indistinguishable from one that was never set — the same
 * failure class as an instrument wired to one code path, and the reason this
 * defect survived long enough to break two tunables on their first shipment.
 *
 * @module
 */

/**
 * Non-`SOX_` process keys forwarded verbatim. Locale and shell fundamentals,
 * plus `XDG_CACHE_HOME` (BL-52 — the embed backend resolves its model cache
 * through it; without it the backend silently degrades).
 */
export const ENV_BASE_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_CACHE_HOME',
];

/** Prefixes forwarded wholesale. `NODE_` is required for native addon loading. */
export const ENV_ALLOW_PREFIXES: readonly string[] = ['NODE_', 'SOX_'];

/**
 * Host-authoritative prefixes that must NEVER be inherited from the ambient
 * environment. See the module header — `SOX_PERM_*` is a privilege-escalation
 * vector and this deny-list is what keeps the prefix rule safe.
 *
 * The spawning call site injects the real values for these AFTER the scrub, so
 * denying them here removes an inherited value rather than the effective one.
 */
export const ENV_DENY_PREFIXES: readonly string[] = ['SOX_PERM_', 'SOX_CONFIG_'];

export interface ScrubbedEnv {
  /** The forwarded environment. */
  env: Record<string, string>;
  /**
   * `SOX_*` keys that were present in the source and deliberately NOT
   * forwarded, sorted. Empty in the overwhelmingly common case. Callers must
   * report this — never drop a tunable silently (BL-344).
   */
  denied: string[];
}

/** True when `key` is a host-authoritative name that must not be inherited. */
export function isDeniedEnvKey(key: string): boolean {
  return ENV_DENY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Build the scrubbed child environment for an enforced-policy spawn.
 *
 * Pure: reads `source` (default `process.env`) and returns a new object. The
 * caller layers extension-config and policy env on top, in that order, so those
 * remain authoritative.
 */
export function scrubEnv(source: NodeJS.ProcessEnv = process.env): ScrubbedEnv {
  const env: Record<string, string> = {};
  const denied: string[] = [];
  const base = new Set(ENV_BASE_ALLOW);

  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (isDeniedEnvKey(k)) {
      denied.push(k);
      continue;
    }
    if (base.has(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) {
      env[k] = v;
      continue;
    }
    // A non-SOX_ variable being dropped is the normal, intended scrub — not a
    // finding. Only SOX_-namespaced drops are worth an operator's attention,
    // and those can now only be the denied ones above.
  }

  denied.sort();
  return { env, denied };
}

/**
 * One-line warning naming every denied `SOX_*` key, or `null` when there is
 * nothing to report.
 *
 * ⚠️ Callers MUST write this to **stderr**, never stdout. Several of these
 * spawn paths serve MCP over stdio, where stdout is the JSON-RPC protocol
 * channel and a single stray line corrupts the session.
 */
export function formatDeniedEnvWarning(denied: string[], context: string): string | null {
  if (denied.length === 0) return null;
  return (
    `[env-policy] ${context}: refused to forward ${denied.length} host-authoritative ` +
    `variable(s) from the ambient environment: ${denied.join(', ')}. ` +
    `These are injected by the host and cannot be overridden by an inherited value.`
  );
}

/**
 * Scrub and report in one call — the shape every spawn site uses.
 *
 * `context` names the spawn path so a warning is traceable to one of the five
 * former copies (e.g. `'serve backend'`, `'os-unit'`, `'supervisor'`).
 */
export function scrubEnvReported(
  context: string,
  source: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => {
    try {
      process.stderr.write(line + '\n');
    } catch {
      /* a logging failure must never break a spawn */
    }
  },
): Record<string, string> {
  const { env, denied } = scrubEnv(source);
  const warning = formatDeniedEnvWarning(denied, context);
  if (warning !== null) write(warning);
  return env;
}
