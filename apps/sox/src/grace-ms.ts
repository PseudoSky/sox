/**
 * apps/sox/src/grace-ms.ts
 *
 * `main.ts` runs `void main()` at import time (it is a CLI entrypoint, not a
 * library — see serve-shutdown.ts's header for the same caveat), so nothing
 * exported from it can be imported directly by a unit test without invoking
 * the whole CLI. This module has no such side effect, matching the
 * extraction pattern already used for `serve-shutdown.ts`.
 *
 * `resolveGraceMs` is the single shared implementation for the
 * `--grace-ms`/`SOX_STOP_GRACE_MS` resolver used by `cmdStop`, `cmdService`
 * (both the runtime-record and list-reconcile paths), and `cmdServe` in
 * `main.ts`.
 */

/**
 * Parse a single raw `--grace-ms`/`SOX_STOP_GRACE_MS` value into a finite,
 * non-negative millisecond count, or `undefined` if the value is absent,
 * blank, or not a valid non-negative number.
 */
export function parseGraceMsFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve the effective grace-ms override from the `--grace-ms` CLI flag and
 * the `SOX_STOP_GRACE_MS` env var: `--grace-ms` wins over the env var, which
 * wins over the caller's own default (applied by the caller — this returns
 * `undefined` when neither source yields a value).
 *
 * A blank/whitespace-only `--grace-ms` (`--grace-ms=` with no value, which
 * the flag parser turns into `''`) is treated as ABSENT so it falls through
 * to `SOX_STOP_GRACE_MS` — a plain `flagRaw ?? envRaw` treats `''` as
 * "present" and, worse, `Number('') === 0` used to make an *empty* flag
 * silently resolve to an immediate SIGKILL (grace 0) instead of consulting
 * the env var or the default — exactly the opposite of "no override given".
 *
 * A PRESENT but INVALID flag (non-numeric, or negative) is NOT treated as
 * absent — it does not fall through to the env var, it falls straight to the
 * caller's default, same as before this fix. Only a genuinely blank/missing
 * flag consults `SOX_STOP_GRACE_MS`.
 */
export function resolveGraceMs(flagRaw: string | undefined, envRaw: string | undefined): number | undefined {
  const normalizedFlag = flagRaw !== undefined && flagRaw.trim() === '' ? undefined : flagRaw;
  return parseGraceMsFlag(normalizedFlag ?? envRaw);
}
