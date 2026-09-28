/**
 * (BL-7e5be7e8) Test-harness scrub of the operator's host-injected store config.
 *
 * ## The hazard
 *
 * A test worker inherits the environment of whoever launched `nx test`. When
 * that is an operator shell, or any process running under a sox host, the
 * environment can carry the host-injected store config: `SOX_CONFIG_DB_PATH`
 * pointing at `~/.memory/memory.db`, the `SOX_PROXY_BACKEND*` backend-mode
 * switches, `SOX_AUTO_BACKUP_DIR`. Every consumer of that config then treats
 * the operator's production store as its own:
 *
 *   - memory-server's direct-stdio SIGTERM/SIGINT handler (index.ts) and the
 *     backend's `coordinatedShutdown` (backend.ts) run `autoBackup()` against
 *     `resolveDbPath(undefined)`, i.e. `SOX_CONFIG_DB_PATH`. That opens the
 *     production store through a store adapter, writes a `memory-*.db` copy
 *     and a `.auto-backup-<hash>` marker into the backup dir, and then PRUNES
 *     rotated backups past retention. A test that spawns the real entrypoint
 *     with `{ ...process.env }` and SIGTERMs it therefore reads the production
 *     store and can delete the operator's backups.
 *   - `resolveDbPath()` hands the same path to every store-backed tool call
 *     that omits `db_path`/`store`.
 *   - `createStoreAdapter()` (store-adapter factory.ts) falls back to
 *     `SOX_CONFIG_DB_PATH` when called without a `dbPath`.
 *
 * The BL-412 fs guard in memory-server's vitest.setup.ts only observes the
 * worker process; a spawned child escapes it entirely.
 *
 * ## Why the harness, not the shutdown path
 *
 * Production shutdown behaviour is correct: a deployed server MUST back up the
 * store its host configured. ADR-0013 forbids an env switch whose only job is
 * to disable a core safety function, so the backup cannot be made "opt-in in
 * tests" without either such a switch or test-awareness in production code.
 * The root cause is the test inheriting production config, so the fix removes
 * that config at the one place every test in the suite passes through: the
 * vitest setup file, which runs in each worker before any spec module loads.
 * Every `{ ...process.env }` spawn, and every in-process fallback read, then
 * sees an unconfigured process. A spec that needs a configured store sets its
 * own scratch value after setup, exactly as the existing specs already do.
 */

/** Exact keys scrubbed in addition to every `SOX_CONFIG_*` key. */
export const OPERATOR_STORE_ENV_KEYS: readonly string[] = [
  'SOX_PROXY_BACKEND',
  'SOX_PROXY_BACKEND_SOCKET',
  'SOX_PROXY_BACKEND_SCHEMA',
  'SOX_AUTO_BACKUP_DIR',
];

/**
 * Prefix of every config value a sox host injects into an extension process
 * (`buildExtConfigEnv`). All of it is operator config; none of it is ever
 * owned by a test, so the whole family is scrubbed rather than only
 * `SOX_CONFIG_DB_PATH` (a future store-shaped key is covered by default).
 */
export const HOST_CONFIG_ENV_PREFIX = 'SOX_CONFIG_';

/** True when `key` names operator store/host config the harness must scrub. */
export function isOperatorStoreEnvKey(key: string): boolean {
  return key.startsWith(HOST_CONFIG_ENV_PREFIX) || OPERATOR_STORE_ENV_KEYS.includes(key);
}

/**
 * Delete every operator store/host-config key from `env` IN PLACE and return
 * the names that were removed (sorted). Pass `process.env` from a test setup
 * file; pass a copy to build a child environment.
 */
export function scrubOperatorStoreEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter(isOperatorStoreEnvKey).sort();
  for (const key of removed) delete env[key];
  return removed;
}
