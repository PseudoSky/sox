/**
 * apps/sox/src/cli-invoked-fields.ts
 *
 * Derives the attribution fields carried by the `cli_invoked` telemetry event
 * that `main.ts` emits once per `soxe` invocation. Extracted into its own
 * side-effect-free module because `main.ts` runs `void main()` and
 * `initTelemetry()` at import time, so nothing exported from it can be unit
 * tested (same extraction pattern as `grace-ms.ts` / `serve-shutdown.ts`).
 *
 * Why these fields exist (backlog d5c01be3): the smoke harness's BL-173
 * isolation guard (`scripts/lib/isolation-guard.mjs`) must decide whether a
 * change to a live data-root file (`ledger.json`, `ownership.json`,
 * `install-registry.json`, `extensions.lock`) was made by a concurrent
 * OPERATOR `soxe` invocation or leaked out of the smoke run. It can only
 * attribute an entry to an operator event when the event names the
 * extension id it acted on — `verb` alone ("install") explains nothing.
 *
 * Deliberately NOT a dump of every positional: `soxe config set <key> <value>`
 * would otherwise write configuration values (potentially secrets) into a
 * durable log. Only the id-bearing positional of verbs that act on an
 * extension id is recorded; every other verb records `target: null`.
 */

/** Verbs whose first positional argument is the extension (or bundle) id they act on. */
const ID_TARGET_VERBS: ReadonlySet<string> = new Set([
  'install',
  'uninstall',
  'update',
  'upgrade',
  'enable',
  'disable',
  'start',
  'stop',
  'serve',
  'exec',
  'details',
  'status',
  'logs',
]);

/** `soxe service <subverb> <id>` — the id is the SECOND positional. */
const SUBVERB_TARGET_VERBS: ReadonlySet<string> = new Set(['service']);

/** Attribution fields added to `cli_invoked` (all additive; `verb` is unchanged). */
export interface CliInvokedFields {
  verb: string | null;
  /** Sub-command for verbs that take one (`service enable …`), else null. */
  subverb: string | null;
  /** Extension/bundle id the invocation acts on, or null when it names none. */
  target: string | null;
  /** `--host` as passed (null when not passed — never defaulted here). */
  host: string | null;
  /** `--scope` as passed (null when not passed — never defaulted here). */
  scope: string | null;
  /** `--root` as passed (null when not passed). */
  root: string | null;
  /** True when `--all` was passed (e.g. `upgrade --all`). */
  all: boolean;
}

function flagOrNull(flags: Readonly<Record<string, string>>, key: string): string | null {
  const v = flags[key];
  return v === undefined || v === '' || v === 'true' ? null : v;
}

/**
 * Build the `cli_invoked` field set from the parsed verb and the
 * `parseArgs`-produced flag map (positionals live under `_`, `_2`, …).
 */
export function cliInvokedFields(
  verb: string | undefined,
  flags: Readonly<Record<string, string>>,
): CliInvokedFields {
  let subverb: string | null = null;
  let target: string | null = null;
  if (verb !== undefined && SUBVERB_TARGET_VERBS.has(verb)) {
    subverb = flags['_'] ?? null;
    target = flags['_2'] ?? flags['id'] ?? null;
  } else if (verb !== undefined && ID_TARGET_VERBS.has(verb)) {
    target = flags['_'] ?? flags['id'] ?? null;
  }
  return {
    verb: verb ?? null,
    subverb,
    target,
    host: flagOrNull(flags, 'host'),
    scope: flagOrNull(flags, 'scope'),
    root: flagOrNull(flags, 'root'),
    all: flags['all'] === 'true',
  };
}
