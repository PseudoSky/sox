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
 * The spawner hands the resolved `EmbedHostConfig.idleGraceMs` (and the rest of
 * the host's identity) to the spawned host as argv — {@link encodeEmbedHostArgs} /
 * {@link parseEmbedHostArgs} — never as env (ADR-0022). (Owner directive: "the
 * time bound should be configurable" — typed config, not an ADR-0013 D3 env
 * tuning constant.)
 *
 * The remaining env reads are ADR-0013 D5 shapes:
 *
 *   - `SOX_ECOSYSTEM_HOME` — host config (D5): where the socket lives.
 *   - `SOX_EMBED_HOST_MAIN` — a test seam (D5); it selects a path, it never
 *     enables a feature.
 *
 * ── Identity is content-addressed (ADR-0022 §4) ──────────────────────────────
 *
 * The singleton key carries a {@link computeEmbedHostBuildId build id}: a digest
 * of the host module bytes, the Node ABI and the arch. Two builds on one box get
 * two hosts; a consumer never dials a host from a foreign build.
 *
 * Leaf module — node builtins only (fs, os, path, url, crypto, module) plus
 * `backendSocketPath` from `@adhd/sox-service-proxy`, `log` from
 * `@adhd/sox-telemetry` (both `area:shared`, declared deps), and this
 * package's own `./errors.js`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendSocketPath } from '@adhd/sox-service-proxy';
import { log } from '@adhd/sox-telemetry';
import { TransientEmbeddingError } from './errors.js';

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
   * The idle window `W` (ADR-0022 §1): the host retires this long after its
   * last COMPLETED real work (init/embed/embedBatch), provided nothing is in
   * flight. Connections are not an input. Typed config: the SPAWNER reads this
   * resolved value and forwards it to the spawned host as `--idle-window-ms`.
   * Set it via `EmbeddingProviderConfig.idleGraceMs` /
   * `configureEmbedHostIdleGraceMs()`.
   */
  idleGraceMs: number;
}

/**
 * Bumped whenever the host's wire protocol or behavior changes incompatibly.
 *
 * v2 (ADR-0022): every `init`/`embed`/`embedBatch` request carries
 * `{model, cacheDir}` and the host owns its own model init; the host takes its
 * identity from argv. The build id in the key (see
 * {@link computeEmbedHostBuildId}) already separates builds, so this constant
 * only needs a bump when the `embedding.*` contract itself changes.
 */
export const EMBED_HOST_PROTOCOL_VERSION = 2;

/**
 * Default idle window `W` (ADR-0022 §1): a host retires this long after its
 * last completed real work. 60 s covers the short-lived-CLI arrival cadence.
 */
export const DEFAULT_EMBED_HOST_IDLE_GRACE_MS = 60_000;

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
 * Process-wide idle-grace override. `null` ⇒ the default. This is the TYPED public surface for the time bound: the owner
 * directive is that the bound be configurable as config, not as an ambient
 * ADR-0013 D3 env constant. Set via `configureEmbedHostIdleGraceMs()` (which
 * `createEmbeddingProvider()` calls with `EmbeddingProviderConfig.idleGraceMs`)
 * before the host is spawned.
 */
let _idleGraceOverride: number | null = null;

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
 * is typed config (with the hard default as fallback). The
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
 * Resolve the idle window: the typed override (`configureEmbedHostIdleGraceMs()`
 * / `EmbeddingProviderConfig.idleGraceMs`), else
 * `DEFAULT_EMBED_HOST_IDLE_GRACE_MS`. There is no env fallback (ADR-0013).
 */
export function resolveEmbedHostIdleGraceMs(): number {
  return _idleGraceOverride ?? DEFAULT_EMBED_HOST_IDLE_GRACE_MS;
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
 * The machine-wide [def:singleton-key] for the host serving `(buildId, modelId,
 * ep, cacheDir)`. Identical inputs ⇒ identical key ⇒ identical socket ⇒ one
 * host, across every consumer process on the box.
 *
 * `cacheDirDigest` is a short sha256 of the ABSOLUTE cache dir, so two stores
 * pointed at different model caches never collide onto one host. `buildId`
 * (ADR-0022 §4) separates builds: a consumer never dials a foreign build's host.
 */
export function embedHostSingletonKey(
  modelId: string,
  ep: string,
  cacheDir: string,
  buildId: string,
): string {
  const digest = createHash('sha256').update(cacheDir, 'utf8').digest('hex').slice(0, 12);
  return `embedding-host:v${EMBED_HOST_PROTOCOL_VERSION}:${buildId}:${modelId}:${ep}:${digest}`;
}

interface BuildIdMemoEntry {
  /** Cheap per-file `name:size:mtimeMs:ino` signature, joined. Recomputing this
   * is orders of magnitude cheaper than re-reading every file's bytes. */
  fingerprint: string;
  id: string;
}

const _buildIdMemo = new Map<string, BuildIdMemoEntry>();

function matchesFor(hostMainPath: string): (name: string) => boolean {
  const tsMode = hostMainPath.endsWith('.ts');
  return (name: string): boolean =>
    tsMode ? name.endsWith('.ts') && !name.endsWith('.spec.ts') : /\.[cm]?js$/.test(name);
}

/**
 * Cheap stat-based fingerprint of the same file set {@link computeEmbedHostBuildId}
 * hashes: `name:size:mtimeMs:ino` per matching file, sorted by name. Two calls
 * against an untouched build produce an identical string in O(files) stat
 * calls — no file bytes are read. A rebuild (new sizes/mtimes/inodes, files
 * added/removed) always changes this string, so it is a sound cache-invalidation
 * key: [2fe52b0f].
 */
function computeBuildFingerprint(hostMainPath: string): string {
  const dir = dirname(hostMainPath);
  const matches = matchesFor(hostMainPath);
  const names = readdirSync(dir).filter(matches).sort();
  const parts: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch (e) {
      // A rebuild swap can delete-then-recreate a sibling between our readdir
      // and this stat; skip it — the recreated file (or its absence) is
      // reflected on the next call. Not build-fatal, so plain log, not throw.
      log.warn('embedding_provider.embed_host_config.fingerprint_stat_race', {
        file,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!st.isFile()) continue;
    parts.push(`${name}:${st.size}:${st.mtimeMs}:${st.ino}`);
  }
  return parts.join('|');
}

/**
 * The content build id of the host at `hostMainPath` (ADR-0022 §4): 12 hex of a
 * sha256 over the protocol version, the Node ABI (`process.versions.modules`),
 * `process.arch`, and the bytes of every regular file in `dirname(hostMainPath)`
 * matching `/\.[cm]?js$/`, sorted by name. When `hostMainPath` ends `.ts` (tsx
 * source mode) the set is the `.ts` files, excluding `*.spec.ts`.
 *
 * The whole directory, not just the entry file, because the host's behavior
 * lives in its siblings (a bundled sidecar inlines them; the npm dist imports
 * them).
 *
 * [2fe52b0f] Memoized per path, but the memo is invalidated by content, not by
 * process lifetime: services here run straight out of a `dist/` that is
 * rebuilt IN PLACE (see CLAUDE.md "a revert is not finished until you rebuild")
 * — a long-lived consumer process outlives many rebuilds of its own sibling
 * bundle, so "a new build is a new process" does not hold. Every call first
 * recomputes the cheap {@link computeBuildFingerprint}; only a change there
 * triggers the full byte-hash. An unchanged build is still O(1) memo hit cost
 * plus O(files) stats — no bytes read.
 *
 * Throws {@link TransientEmbeddingError} if the directory itself has vanished
 * mid-swap (ENOENT on `readdirSync`) — a rebuild is in flight; the caller
 * should retry, not treat this as a permanent resolution failure.
 */
export function computeEmbedHostBuildId(hostMainPath: string): string {
  const dir = dirname(hostMainPath);
  let fingerprint: string;
  try {
    fingerprint = computeBuildFingerprint(hostMainPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TransientEmbeddingError(
        `embed host build id: ${dir} vanished mid-rebuild swap — retry`,
        250,
      );
    }
    throw e;
  }
  const memo = _buildIdMemo.get(hostMainPath);
  if (memo !== undefined && memo.fingerprint === fingerprint) return memo.id;

  const matches = matchesFor(hostMainPath);
  const hash = createHash('sha256');
  hash.update(`protocol:${EMBED_HOST_PROTOCOL_VERSION}\0`);
  hash.update(`abi:${process.versions.modules}\0`);
  hash.update(`arch:${process.arch}\0`);
  let names: string[];
  try {
    names = readdirSync(dir).filter(matches).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TransientEmbeddingError(
        `embed host build id: ${dir} vanished mid-rebuild swap — retry`,
        250,
      );
    }
    throw e;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      hash.update(`file:${name}\0`);
      hash.update(readFileSync(file));
      hash.update('\0');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TransientEmbeddingError(
          `embed host build id: ${file} vanished mid-rebuild swap — retry`,
          250,
        );
      }
      throw e;
    }
  }
  const id = hash.digest('hex').slice(0, 12);
  _buildIdMemo.set(hostMainPath, { fingerprint, id });
  return id;
}

/**
 * Backstop for the case the fingerprint (mtime/size/ino) happened not to
 * change across a rebuild (e.g. a filesystem with second-granularity mtimes)
 * yet the spawned host still rejected our build id [2fe52b0f]: drop the memo
 * entry so the NEXT {@link computeEmbedHostBuildId} call is a forced full
 * rehash rather than trusting a fingerprint that just proved stale.
 */
export function invalidateEmbedHostBuildId(hostMainPath: string): void {
  _buildIdMemo.delete(hostMainPath);
}

/** TEST-ONLY: forget memoized build ids (a test that edits a host dir in place). */
export function __resetEmbedHostBuildIdMemoForTests(): void {
  _buildIdMemo.clear();
}

/** Who spawned a host — provenance for telemetry only, never identity. */
export interface EmbedHostSpawner {
  pid: number;
  /** The spawner's `SOX_SERVICE_ID`, carried as argv (never env — ADR-0022 §5). */
  serviceId: string | null;
  /** The spawner's entrypoint (`process.argv[1]`). */
  entry: string | null;
  /** Env keys the spawner withheld from the host (names only). */
  deniedEnv: string[];
}

/** Exact env keys a spawned host inherits (ADR-0022 §5). */
const EMBED_HOST_ENV_FORWARD_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CACHE_HOME',
  // Network egress for a cold model download (fastembed fetches the model on a
  // cache miss). No identity content; without them a host behind a proxy or a
  // private CA could never load its model.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
/** Env key prefixes a spawned host inherits. */
const EMBED_HOST_ENV_FORWARD_PREFIXES = ['NODE_', 'SOX_'];
/**
 * Keys that match a forward rule but carry the SPAWNER's identity, config or
 * permissions. `SOX_SERVICE_ID` in particular made every service reaper treat
 * the shared host as the spawning service's own process (6660076e).
 */
const EMBED_HOST_ENV_DENY_EXACT = new Set(['SOX_SERVICE_ID', 'SOX_TELEMETRY_INIT']);
const EMBED_HOST_ENV_DENY_PREFIXES = ['SOX_CONFIG_', 'SOX_PERM_', 'SOX_PROXY_', 'SOX_EMBED_HOST_'];

/**
 * 6660076e: the env a spawned embedding host runs with (ADR-0022 §5,
 * docs/spec/service-lifecycle.md §5). The host is shared by every consumer on
 * the box and must carry none of its spawner's identity:
 *
 *   - forwarded: `PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ TMPDIR
 *     XDG_CACHE_HOME`, the proxy/CA variables a cold model download needs
 *     (`HTTP(S)_PROXY`, `NO_PROXY`, lowercase forms, `SSL_CERT_FILE/DIR`),
 *     `NODE_*`, `SOX_*`;
 *   - denied (reported by name in `denied`): `SOX_SERVICE_ID`,
 *     `SOX_TELEMETRY_INIT`, `SOX_CONFIG_*`, `SOX_PERM_*`, `SOX_PROXY_*`,
 *     `SOX_EMBED_HOST_*`;
 *   - everything else is not forwarded (reported by name in `dropped`).
 *
 * Reimplemented locally on purpose: `area:data` may not import
 * `@adhd/sox-host-runtime`'s env policy.
 */
export function buildEmbedHostEnv(parent: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  denied: string[];
  dropped: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  const denied: string[] = [];
  const dropped: string[] = [];
  for (const key of Object.keys(parent).sort()) {
    const value = parent[key];
    if (value === undefined) continue;
    const forwarded =
      EMBED_HOST_ENV_FORWARD_EXACT.has(key) || EMBED_HOST_ENV_FORWARD_PREFIXES.some((p) => key.startsWith(p));
    if (!forwarded) {
      dropped.push(key);
      continue;
    }
    if (EMBED_HOST_ENV_DENY_EXACT.has(key) || EMBED_HOST_ENV_DENY_PREFIXES.some((p) => key.startsWith(p))) {
      denied.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, denied, dropped };
}

/** Everything a spawned host needs, transported as argv (ADR-0022). */
export interface EmbedHostSpawnArgs {
  socketPath: string;
  model: string;
  cacheDir: string;
  ep: string;
  buildId: string;
  idleWindowMs: number;
  spawner: EmbedHostSpawner;
}

/**
 * Encode host spawn args as argv. Every flag uses the single-element
 * `--flag=value` form on purpose: a spawner's entrypoint path must never appear
 * as a whitespace-bounded argv token, because the identity reaper
 * (`argvContainsToken`) would then match the embed host as the spawner's own
 * process and kill it.
 */
export function encodeEmbedHostArgs(a: EmbedHostSpawnArgs): string[] {
  const out = [
    `--socket=${a.socketPath}`,
    `--model=${a.model}`,
    `--cache-dir=${a.cacheDir}`,
    `--ep=${a.ep}`,
    `--build-id=${a.buildId}`,
    `--idle-window-ms=${String(a.idleWindowMs)}`,
    `--spawner-pid=${String(a.spawner.pid)}`,
  ];
  if (a.spawner.serviceId !== null) out.push(`--spawner-service=${a.spawner.serviceId}`);
  if (a.spawner.entry !== null) out.push(`--spawner-entry=${a.spawner.entry}`);
  if (a.spawner.deniedEnv.length > 0) out.push(`--spawner-denied-env=${a.spawner.deniedEnv.join(',')}`);
  return out;
}

const REQUIRED_FLAGS = ['socket', 'model', 'cache-dir', 'ep', 'build-id', 'idle-window-ms', 'spawner-pid'] as const;
const KNOWN_FLAGS = new Set<string>([...REQUIRED_FLAGS, 'spawner-service', 'spawner-entry', 'spawner-denied-env']);

/**
 * Parse host argv produced by {@link encodeEmbedHostArgs}. Accepts `--flag=value`
 * and `--flag value`. Throws a `TypeError` naming the offending flag on an
 * unknown flag, a missing required flag, or a malformed value.
 */
export function parseEmbedHostArgs(argv: readonly string[]): EmbedHostSpawnArgs {
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (!tok.startsWith('--')) throw new TypeError(`embed-host: unexpected argument ${JSON.stringify(tok)}`);
    const eq = tok.indexOf('=');
    let name: string;
    let value: string | undefined;
    if (eq !== -1) {
      name = tok.slice(2, eq);
      value = tok.slice(eq + 1);
    } else {
      name = tok.slice(2);
      value = argv[i + 1];
      i++;
    }
    if (!KNOWN_FLAGS.has(name)) throw new TypeError(`embed-host: unknown flag --${name}`);
    if (value === undefined) throw new TypeError(`embed-host: flag --${name} is missing its value`);
    vals.set(name, value);
  }
  for (const f of REQUIRED_FLAGS) {
    const v = vals.get(f);
    if (v === undefined || v === '') throw new TypeError(`embed-host: required flag --${f} is missing`);
  }
  const num = (flag: string, positive: boolean): number => {
    const raw = vals.get(flag) ?? '';
    const n = Number(raw);
    if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0) || raw.trim() === '') {
      throw new TypeError(`embed-host: flag --${flag} must be a ${positive ? 'positive' : 'non-negative'} number, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  const buildId = vals.get('build-id') ?? '';
  if (!/^[0-9a-f]{12}$/.test(buildId)) {
    throw new TypeError(`embed-host: flag --build-id must be 12 lowercase hex, got ${JSON.stringify(buildId)}`);
  }
  const denied = vals.get('spawner-denied-env');
  return {
    socketPath: vals.get('socket') ?? '',
    model: vals.get('model') ?? '',
    cacheDir: vals.get('cache-dir') ?? '',
    ep: vals.get('ep') ?? '',
    buildId,
    idleWindowMs: num('idle-window-ms', true),
    spawner: {
      pid: num('spawner-pid', false),
      serviceId: vals.get('spawner-service') ?? null,
      entry: vals.get('spawner-entry') ?? null,
      deniedEnv: denied ? denied.split(',').filter((k) => k !== '') : [],
    },
  };
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
  } catch (e) {
    // Last resort: name the path that was actually attempted in any later error.
    log.warn('embedding_provider.embed_host_config.resolve_fallback', {
      error: e instanceof Error ? e.message : String(e),
      fallback: sibling,
    });
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
