/**
 * identity.ts — shared process-identity span attributes (621a11c5).
 *
 * Every product that traces through this package wants the same three
 * dimensions on its spans so a whole process run can be aggregated by session,
 * checkout and population: `session_id`, `worktree` and `role`. They used to be
 * re-derived privately by each tracing plugin (`@adhd/apigen-plugin-tracing`
 * first); they live here so every consumer stamps identical keys and values.
 *
 * ## Why there is no `release.*` helper
 *
 * The release identity is already stamped by this package, so a second copy
 * here would be a second source of truth:
 *
 *  - `service.version` and `sox.artifact_sha256` ride every span and metric
 *    point as OTel RESOURCE attributes (`bringUpOtel`, `otel.ts`).
 *  - The full `release: { version, artifact_sha256, git_sha }` object rides
 *    every durable JSONL record envelope (`emitRecord`, `runtime.ts`), resolved
 *    at runtime when the caller passes none (`resolveRuntimeRelease`).
 *
 * The one gap is that `git_sha` is envelope-only: it is not an OTel resource
 * attribute. That is a separate change and deliberately not made here.
 *
 * ## The `prefix` contract
 *
 * Identity keys are deliberately UNPREFIXED (`session_id`, not
 * `adhd.session_id`) — they are cross-product dimensions, and a prefix would
 * split one session across products. A product's OWN keys (`<prefix>.op`,
 * `<prefix>.transport`, ...) are namespaced with a prefix that is REQUIRED and
 * has no default, so a product cannot silently emit another product's
 * telemetry. {@link requireTelemetryPrefix} enforces that and
 * {@link prefixAttributes} applies it.
 */

import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { OtelAttributes } from './otel-types.js';
import { currentRuntimeState, type Role } from './runtime.js';

/**
 * Where a working directory sits relative to git. Three-valued so the main
 * checkout and a directory outside any repository (a boolean would report both
 * the same) stay distinguishable when records are aggregated.
 */
export type WorktreeKind = 'main' | 'linked' | 'none';

/** The environment variable carrying a caller-assigned session id. */
export const SESSION_ID_ENV = 'ADHD_SESSION_ID';

/** Resolved, process-stable identity. */
export interface ProcessIdentity {
  /** `ADHD_SESSION_ID` when set and non-empty, else a process-stable `randomUUID()`. */
  readonly sessionId: string;
  /** See {@link classifyWorktree}. */
  readonly worktree: WorktreeKind;
}

/**
 * The span attributes {@link identityAttributes} produces. Flat and OTel-safe
 * (`string`), so it can be spread straight into `withSpan`'s attribute bag.
 */
export interface IdentityAttributes {
  session_id: string;
  worktree: WorktreeKind;
  role: Role;
}

/** Run `git rev-parse <args>` in `cwd`; trimmed stdout on success, else null. */
function gitRevParse(args: string[], cwd: string): string | null {
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      const out = result.stdout.trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    /* git missing / not a repo / timeout — caller falls back to null */
  }
  return null;
}

/**
 * Classify `cwd` as a LINKED git worktree, a repository's main checkout, or
 * nothing at all:
 *
 *  - `'linked'` — inside a LINKED worktree: `--git-common-dir` names the main
 *    checkout's `.git` directory and its parent is not this worktree's own
 *    `--show-toplevel`.
 *  - `'main'`   — inside a repository but not a linked worktree.
 *  - `'none'`   — not inside any repository (either probe fails, or git is
 *    unavailable).
 *
 * @param cwd Directory to classify. Defaults to `process.cwd()`. Injectable so
 *   callers (and tests, which cannot `process.chdir()` in a vitest worker) can
 *   classify an arbitrary directory.
 */
export function classifyWorktree(cwd: string = process.cwd()): WorktreeKind {
  const top = gitRevParse(['--show-toplevel'], cwd);
  const commonDir = gitRevParse(['--path-format=absolute', '--git-common-dir'], cwd);
  if (top === null || commonDir === null) return 'none';
  const linked = /[\\/]\.git$/.test(commonDir) && path.resolve(path.dirname(commonDir)) !== path.resolve(top);
  return linked ? 'linked' : 'main';
}

/**
 * Pure identity resolver — no caching, no process-global reads other than the
 * arguments' defaults. Follows the `resolveRuntimeRelease(env, argv, cwd)`
 * pattern so it is testable without touching `process.env` / `process.cwd()`.
 *
 * @param env Environment to read {@link SESSION_ID_ENV} from. Default `process.env`.
 * @param cwd Directory to classify. Default `process.cwd()`.
 * @param sessionId Explicit session id; wins over the environment. An empty
 *   string is treated as unset.
 */
export function resolveProcessIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  sessionId?: string,
): ProcessIdentity {
  const fromEnv = env[SESSION_ID_ENV];
  const resolved =
    sessionId !== undefined && sessionId.length > 0
      ? sessionId
      : fromEnv !== undefined && fromEnv.length > 0
        ? fromEnv
        : randomUUID();
  return { sessionId: resolved, worktree: classifyWorktree(cwd) };
}

// The cached identity is keyed on `globalThis` for the same reason the runtime
// is (BL-404 / ADR-0018): two installed copies of this package in one process
// must agree on ONE `session_id`, or a single session splits into two.
// SEMVER-STABLE KEY — see the runtime slot-key doc comment before changing it.
const IDENTITY_SLOT_KEY: symbol = Symbol.for('@adhd/sox-telemetry.identity.v1');

/**
 * The process-stable identity, resolved once from `process.env` / `process.cwd()`
 * on first call and frozen thereafter (shared across duplicate module copies).
 * `session_id` is therefore stable for the whole process and never per-span.
 */
export function processIdentity(): ProcessIdentity {
  const slot = globalThis as unknown as Record<symbol, ProcessIdentity | undefined>;
  const existing = slot[IDENTITY_SLOT_KEY];
  if (existing !== undefined) return existing;
  const created = Object.freeze(resolveProcessIdentity());
  slot[IDENTITY_SLOT_KEY] = created;
  return created;
}

/** Test-only: forget the cached identity so the next call re-resolves. */
export function _resetProcessIdentityForTest(): void {
  const slot = globalThis as unknown as Record<symbol, ProcessIdentity | undefined>;
  slot[IDENTITY_SLOT_KEY] = undefined;
}

/**
 * The `{ session_id, worktree, role }` attributes to stamp on a span. `role` is
 * read live from the initialised telemetry runtime (`currentRuntimeState().role`)
 * so it matches the record envelope's `role` exactly and test/cli/live-service/
 * harness populations aggregate together.
 *
 * Spread this LAST in a span's attribute bag so a caller-configured key can
 * never shadow an identity dimension.
 *
 * @example
 * ```ts
 * await withSpan('adhd.op', { ...own, ...identityAttributes() }, async () => work());
 * ```
 */
export function identityAttributes(): IdentityAttributes {
  const { sessionId, worktree } = processIdentity();
  return { session_id: sessionId, worktree, role: currentRuntimeState().role };
}

/**
 * Keep only the values the OTel attribute contract admits
 * (`string | number | boolean`); everything else (objects, `undefined`,
 * `null`, arrays) is dropped rather than coerced, so a nested value is never
 * silently stringified into the sink.
 */
export function toOtelAttributes(fields: Record<string, unknown>): OtelAttributes {
  const out: OtelAttributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate a product namespace prefix. REQUIRED with no implicit default: an
 * absent or blank prefix would stamp every key `undefined.op` and poison the
 * sink, so a JS caller (or an untyped `any`) bypassing the type fails loudly
 * instead.
 *
 * @param prefix The emitting product's namespace (e.g. `'adhd'`, `'apigen'`).
 * @param owner Name used in the error message so the failing caller is obvious.
 * @returns The prefix, trimmed.
 * @throws `Error` when `prefix` is not a non-blank string.
 */
export function requireTelemetryPrefix(prefix: unknown, owner = '@adhd/sox-telemetry'): string {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error(
      `${owner}: \`prefix\` is required and must be a non-empty string — it namespaces every ` +
        'span name and attribute key the product emits. Pass it explicitly, e.g. `{ prefix: "adhd" }`.',
    );
  }
  return prefix.trim();
}

/**
 * Namespace a product's own attributes: `{ op: 'x' }` with prefix `'adhd'`
 * becomes `{ 'adhd.op': 'x' }`. Non-OTel values are dropped (see
 * {@link toOtelAttributes}). Identity dimensions are NOT passed through here —
 * they are unprefixed by contract.
 *
 * @throws `Error` via {@link requireTelemetryPrefix} when `prefix` is blank.
 */
export function prefixAttributes(prefix: string, fields: Record<string, unknown>): OtelAttributes {
  const p = requireTelemetryPrefix(prefix);
  const out: OtelAttributes = {};
  for (const [key, value] of Object.entries(toOtelAttributes(fields))) {
    out[`${p}.${key}`] = value;
  }
  return out;
}
