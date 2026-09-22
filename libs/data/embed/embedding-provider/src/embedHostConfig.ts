/**
 * embedHostConfig.ts — config + stable socket/singleton-key resolution for the
 * embedding funnel (SPEC-EMBEDDING-FUNNEL.md §B).
 *
 * The funnel collapses N consumer processes onto ONE peer-spawned, self-reaping
 * ONNX host per `(model, execution-provider, cacheDir)`. That requires a
 * deterministic, machine-wide identity for "the one host for this workload":
 *
 *   - {@link embedHostSingletonKey} — the [def:singleton-key] every consumer
 *     computes identically, so `ensureBackend()`'s O_EXCL spawn-lock collapses a
 *     thundering herd to one spawn.
 *   - {@link embedHostSocketPath} — the UDS path derived from that key via
 *     `backendSocketPath()` (the SAME derivation the service-proxy uses, so
 *     there is never a port-selection problem and never a clash).
 *
 * ── Host selection AND the idle bound are typed config, never env toggles ──────
 *
 * `host` is a closed union (`'shared' | 'private'`) carried on
 * `EmbeddingProviderConfig.host` and reported in `health()`. `idleGraceMs` is the
 * same shape: a typed field on `EmbeddingProviderConfig.idleGraceMs` (applied by
 * `createEmbeddingProvider()`), reported in the host's `embedding.health`, and
 * carried on the resolved `EmbedHostConfig` the SPAWNER reads and forwards to the
 * spawned host. There is deliberately NO `SOX_EMBED_HOST=shared|private`
 * variable: a behavior switch must be visible, validated, and auditable, not an
 * ambient string.
 *
 * `SOX_EMBED_HOST_IDLE_GRACE_MS` still exists, but it is the INTERNAL
 * cross-process transport between the spawner and the spawned host — the spawner
 * writes the resolved `EmbedHostConfig.idleGraceMs` into the child's env and the
 * host consumes it. It is not the public configuration surface; set the typed
 * `idleGraceMs` (or `configureEmbedHostIdleGraceMs()`) instead. (Owner directive:
 * "the time bound should be configurable" — typed config, not an ADR-0013 D3 env
 * tuning constant. This supersedes ADR-0020 D2's env-tuning framing.)
 *
 * The remaining env reads are ADR-0013 D5 shapes:
 *
 *   - `SOX_ECOSYSTEM_HOME` — host config (D5): where the socket lives.
 *   - `SOX_EMBED_HOST_MAIN` / `SOX_EMBED_HOST_SOCKET` — host-injected transport
 *     config (D5) / test seams; they select a path, they never enable a feature.
 *
 * Leaf module — node builtins only (fs, os, path, url, crypto, module) plus
 * `backendSocketPath` from `@adhd/sox-service-proxy`.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendSocketPath } from '@adhd/sox-service-proxy';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The host-selection closed union (ADR-0013). `'shared'` is the default. */
export type EmbedHostMode = 'shared' | 'private';

/** Resolved funnel configuration. */
export interface EmbedHostConfig {
  /** `'shared'` (default): funnel through the peer-spawned host. `'private'`: the pre-funnel per-process fork (CI/diagnostics). */
  host: EmbedHostMode;
  /** The directory the host UDS is created under (ADR-0004: `$SOX_ECOSYSTEM_HOME/run`). */
  socketDir: string;
  /**
   * How long the host lingers with zero clients and zero in-flight work before
   * it reaps itself. Typed config (owner directive: "the time bound should be
   * configurable"): the SPAWNER reads this resolved value and forwards it to the
   * spawned host, which consumes it. Set it via
   * `EmbeddingProviderConfig.idleGraceMs` / `configureEmbedHostIdleGraceMs()`.
   */
  idleGraceMs: number;
}

/**
 * Bumped whenever the host's wire protocol or behavior changes incompatibly.
 *
 * Open question #4 in SPEC-EMBEDDING-FUNNEL.md ("a running host is an old
 * build") is resolved with this constant rather than the npm package version.
 * Rationale: the real hazard is a host whose `embedding.*` contract the new
 * consumer cannot speak — a *protocol* change — not every cosmetic patch. Keying
 * on the npm version would spawn a brand-new host on every patch bump (briefly
 * two hosts, defeating the funnel across an upgrade window) while the explicit
 * protocol version forces a new socket exactly when compatibility actually
 * breaks. Bump this with any change to the `embedding.*` method set, the payload
 * shape, or the response shape in `embedHostMain.ts`.
 */
export const EMBED_HOST_PROTOCOL_VERSION = 1;

/** Default grace before a zero-client host reaps itself. Sized to the short-lived-CLI arrival cadence. */
export const DEFAULT_EMBED_HOST_IDLE_GRACE_MS = 30_000;

/**
 * Process-wide host-selection override. `null` ⇒ `'shared'`.
 *
 * Deliberately NOT an env var (ADR-0013): the typed
 * `EmbeddingProviderConfig.host` field is applied here by
 * `createEmbeddingProvider()` before the accessor singleton is constructed.
 * Host selection is a process-wide posture — once a consumer has resolved its
 * accessor, changing this does not retroactively re-point it (documented, not
 * hidden).
 */
let _hostOverride: EmbedHostMode | null = null;

/**
 * Process-wide idle-grace override. `null` ⇒ resolve from the transport env (or
 * the default). This is the TYPED public surface for the time bound: the owner
 * directive is that the bound be configurable as config, not as an ambient
 * ADR-0013 D3 env constant. Set via `configureEmbedHostIdleGraceMs()` (which
 * `createEmbeddingProvider()` calls with `EmbeddingProviderConfig.idleGraceMs`)
 * before the host is spawned.
 */
let _idleGraceOverride: number | null = null;

/**
 * The internal cross-process transport variable the spawner uses to hand the
 * resolved `EmbedHostConfig.idleGraceMs` to the spawned host. Not a public knob
 * — set the typed `idleGraceMs` instead.
 */
export const EMBED_HOST_IDLE_GRACE_ENV = 'SOX_EMBED_HOST_IDLE_GRACE_MS';

/**
 * Apply the typed `host` field from an `EmbeddingProviderConfig`. Passing
 * `undefined` leaves the current posture unchanged (so a `remote` provider
 * without a `host` field never resets a deliberate `'private'` selection).
 */
export function configureEmbedHostHost(host: EmbedHostMode | undefined): void {
  if (host === undefined) return;
  if (host !== 'shared' && host !== 'private') {
    throw new TypeError(`EmbedHostMode must be 'shared' or 'private', got ${String(host)}`);
  }
  _hostOverride = host;
}

/**
 * Apply the typed `idleGraceMs` field from an `EmbeddingProviderConfig`. Passing
 * `undefined` leaves the current value unchanged (so a provider without the field
 * never resets a deliberate selection). A non-positive or non-finite value is
 * rejected loudly — never silently treated as "off".
 */
export function configureEmbedHostIdleGraceMs(idleGraceMs: number | undefined): void {
  if (idleGraceMs === undefined) return;
  if (!Number.isFinite(idleGraceMs) || idleGraceMs <= 0) {
    throw new TypeError(
      `EmbedHostConfig.idleGraceMs must be a positive number, got ${String(idleGraceMs)}`,
    );
  }
  _idleGraceOverride = idleGraceMs;
}

/** TEST-ONLY: clear the process-wide host + idle-grace overrides back to defaults. */
export function __resetEmbedHostConfigForTests(): void {
  _hostOverride = null;
  _idleGraceOverride = null;
}

/**
 * Resolve the funnel configuration. `host` defaults to `'shared'`; `idleGraceMs`
 * is typed config (with the transport env / hard default as fallbacks). The
 * SPAWNER reads the resolved `idleGraceMs` and forwards it to the spawned host —
 * see `funnelClient.ts`'s `doEnsure()` — which is what makes this field the
 * consumed surface rather than a dead declaration.
 */
export function resolveEmbedHostConfig(): EmbedHostConfig {
  return {
    host: _hostOverride ?? 'shared',
    socketDir: resolveEmbedHostSocketDir(),
    idleGraceMs: resolveEmbedHostIdleGraceMs(),
  };
}

/**
 * Resolve the idle grace, in priority order:
 *
 *   1. the typed override (`configureEmbedHostIdleGraceMs()` /
 *      `EmbeddingProviderConfig.idleGraceMs`) — the public surface;
 *   2. the internal transport env (`SOX_EMBED_HOST_IDLE_GRACE_ENV`) the spawner
 *      writes for the spawned host;
 *   3. `DEFAULT_EMBED_HOST_IDLE_GRACE_MS`.
 *
 * A non-positive or non-numeric transport value is rejected loudly (never
 * silently treated as "off").
 */
export function resolveEmbedHostIdleGraceMs(): number {
  if (_idleGraceOverride !== null) return _idleGraceOverride;
  const raw = process.env[EMBED_HOST_IDLE_GRACE_ENV];
  if (raw === undefined || raw === '') return DEFAULT_EMBED_HOST_IDLE_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(
      `${EMBED_HOST_IDLE_GRACE_ENV} must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * ADR-0004 D5: the host socket lives under `$SOX_ECOSYSTEM_HOME/run` (the user
 * data root's `run/` dir). Mirrors `@adhd/sox-host-runtime`'s `runDir()` without
 * importing it — this package is a low-tier leaf and must not gain a
 * host-runtime dependency. `SOX_ECOSYSTEM_HOME` defaults to `~/.adhd/sox-ecosystem`
 * exactly as `data-paths.ts`'s `DATA_SUBDIR` does.
 */
export function resolveEmbedHostSocketDir(): string {
  const home = process.env['SOX_ECOSYSTEM_HOME'];
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.adhd', 'sox-ecosystem');
  return join(root, 'run');
}

/**
 * The machine-wide [def:singleton-key] for the host serving `(modelId, ep,
 * cacheDir)`. Identical inputs ⇒ identical key ⇒ identical socket ⇒ one host,
 * across every consumer process on the box.
 *
 * `cacheDirDigest` is a short sha256 of the ABSOLUTE cache dir, so two stores
 * pointed at different model caches never collide onto one host. The protocol
 * version is appended (see {@link EMBED_HOST_PROTOCOL_VERSION}).
 */
export function embedHostSingletonKey(modelId: string, ep: string, cacheDir: string): string {
  const digest = createHash('sha256').update(cacheDir, 'utf8').digest('hex').slice(0, 12);
  return `embedding-host:v${EMBED_HOST_PROTOCOL_VERSION}:${modelId}:${ep}:${digest}`;
}

/** Derive the host UDS path from the resolved config and singleton key. */
export function embedHostSocketPath(cfg: EmbedHostConfig, key: string): string {
  return backendSocketPath(cfg.socketDir, key);
}

/**
 * Resolve the runnable host entrypoint to spawn.
 *
 * Order:
 *   1. `SOX_EMBED_HOST_MAIN` (D5/test seam) — a path injection, never a feature
 *      toggle. Used by the funnel teeth suite to run the host from source via a
 *      tsx shim without a prior build.
 *   2. A `__dirname` sibling (`dist/embedHostMain.js`) — the npm AND bundled
 *      case. The literal `join(__dirname, 'embedHostMain.js')` is load-bearing:
 *      `bundle-extension.cjs`'s `verifySidecarReferences()` scans emitted files
 *      for exactly this shape, so the sidecar can never ship missing (BL-259).
 *   3. `src/../dist/embedHostMain.js` — vitest's `src/`-resident `__dirname`.
 *   4. `require.resolve('@adhd/sox-embedding-provider/embed-host')` — the
 *      package `exports` subpath, when self-reference is available.
 */
export function resolveEmbedHostMainPath(): string {
  const override = process.env['SOX_EMBED_HOST_MAIN'];
  if (override !== undefined && override !== '') return override;

  const sibling = join(__dirname, 'embedHostMain.js');
  if (existsSync(sibling)) return sibling;

  const distSibling = join(__dirname, '..', 'dist', 'embedHostMain.js');
  if (existsSync(distSibling)) return distSibling;

  try {
    return createRequire(import.meta.url).resolve('@adhd/sox-embedding-provider/embed-host');
  } catch {
    // Last resort: name the path that was actually attempted in any later error.
    return sibling;
  }
}

/**
 * Where the detached host's stderr is redirected (its stdout/stdin are severed).
 * Kept beside the socket so a wedged host's startup diagnostics are greppable
 * without inheriting any caller fd ([inv:no-fd-inherit], BL-67).
 */
export function resolveEmbedHostStderrLogPath(cfg: EmbedHostConfig): string {
  return join(cfg.socketDir, 'logs', 'embed-host.stderr.log');
}
