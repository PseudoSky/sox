/**
 * libs/host-runtime/src/singleton.ts — Slice 1 of docs/spec/service-lifecycle.md.
 *
 * The cross-scope singleton machinery that closes the genuinely-open half of
 * BL-50 (F1/F7): two scopes resolving the SAME backing store but DIFFERENT
 * sockets producing two writers.
 *
 * The spec's `[def:singleton-key]` (§4.3) is `(id, resolved-store-resource)`,
 * NOT `(id, scope)` and NOT the socket path. The invariant being protected is
 * **one writer per backing store** (one daemon per `memory.db`, one proxy per
 * port). This module computes that key from the manifest + resolved config env
 * and provides the survivor-selection used by the reconcile pass (§5.3).
 *
 * It reuses the existing BL-31 primitives (reaper.ts) for process discovery and
 * verified kill — it never re-implements process scanning or killing. It only
 * adds: (1) store-resource resolution from a manifest, (2) the singleton key,
 * (3) a deterministic survivor tiebreak by OS process start time, and (4) the
 * cross-scope ownership collision check (over store-resource, not scope).
 *
 * Leaf-ish: node builtins + reaper.ts only. No import from install-engine or
 * apps/sox (callers pass resolved inputs in).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findOrphansByIdentity,
  identityToken,
  killAndVerify,
  type KillOutcome,
  type OrphanMatch,
} from './reaper.js';
import { descendantOf } from './reconcile.js';

// ─── Store-resource resolution (the singleton-key anchor) ───────────────────────

/**
 * The kind of backing resource a service binds. The singleton invariant is
 * "one live process per (id, resource)". `db` is the strongest (a SQLite file
 * is a true single-writer resource); `socket`/`port` are bound endpoints.
 */
export type StoreResourceKind = 'db' | 'socket' | 'port' | 'none';

export interface StoreResource {
  kind: StoreResourceKind;
  /**
   * The canonical, absolute identity of the resource:
   *   - db:     the realpath'd absolute db file path
   *   - socket: the absolute socket path
   *   - port:   `host:port`
   *   - none:   '' (no singleton resource declared)
   */
  value: string;
}

/**
 * Expand `${SOX_CONFIG_*}`/`${VAR}` placeholders and a leading tilde in a
 * config-derived path string, using the resolved config env then process.env.
 * Mirrors the resolution `buildExtConfigEnv` + `resolveServiceHealthSocketPath`
 * already apply (apps/sox/src/main.ts) so the key matches what is actually
 * spawned.
 */
export function expandConfigValue(
  raw: string,
  configEnv: Record<string, string>,
): string {
  let out = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, varName: string) => {
    return configEnv[varName] ?? process.env[varName] ?? _m;
  });
  if (out.startsWith('~/')) {
    out = path.join(os.homedir(), out.slice(2));
  } else if (out === '~') {
    out = os.homedir();
  }
  return out;
}

/**
 * Canonicalize a filesystem path to its realpath when it (or its parent dir)
 * exists, so two spellings of the same store (symlink, `..`, trailing slash)
 * collapse to one identity. Falls back to `path.resolve` when nothing on disk
 * exists yet (a not-yet-created db is still a valid singleton anchor).
 */
export function canonicalizePath(p: string): string {
  if (!p) return '';
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // The file may not exist yet — realpath the existing parent, keep the leaf.
    const dir = path.dirname(abs);
    const leaf = path.basename(abs);
    try {
      return path.join(fs.realpathSync(dir), leaf);
    } catch {
      return abs;
    }
  }
}

interface ManifestShape {
  lifecycle?: {
    singleton?: boolean;
    health?: { type?: string; endpoint?: string };
  };
  config_schema?: {
    properties?: Record<string, { 'x-sox-singleton-key'?: boolean }>;
  };
}

/**
 * Resolve the canonical store-resource for a service from its manifest +
 * resolved config env. Resolution order (the most-single-writer first):
 *
 *   1. An explicit `x-sox-singleton-key: true` property in config_schema —
 *      its resolved value is THE key (lets any service nominate its anchor).
 *   2. `SOX_CONFIG_DB_PATH` — the canonical single-writer SQLite file.
 *   3. The declared socket health endpoint (`lifecycle.health` type socket).
 *   4. `SOX_CONFIG_PORT` / `SOX_CONFIG_HOST` → `host:port`.
 *   5. none.
 *
 * `db`/`socket` paths are canonicalized (realpath) so symlink/`..` spellings of
 * the same store collapse. Returns `{kind:'none', value:''}` when nothing is
 * declared — such a service is not singleton-keyed on a store.
 */
export function resolveStoreResource(
  manifestPath: string,
  configEnv: Record<string, string>,
): StoreResource {
  let manifest: ManifestShape = {};
  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestShape;
    }
  } catch {
    manifest = {};
  }

  // 1. Explicit nominated key.
  const props = manifest.config_schema?.properties ?? {};
  for (const [k, spec] of Object.entries(props)) {
    if (spec && spec['x-sox-singleton-key'] === true) {
      const envKey = `SOX_CONFIG_${k.toUpperCase().replace(/[-\s]/g, '_')}`;
      const v = configEnv[envKey];
      if (v) {
        // Treat a *.db / path-like value as a db resource, else a socket.
        const expanded = expandConfigValue(v, configEnv);
        const kind: StoreResourceKind = expanded.endsWith('.sock') ? 'socket' : 'db';
        return { kind, value: canonicalizePath(expanded) };
      }
    }
  }

  // 2. db_path — the canonical single-writer resource.
  const dbRaw = configEnv['SOX_CONFIG_DB_PATH'];
  if (dbRaw) {
    return { kind: 'db', value: canonicalizePath(expandConfigValue(dbRaw, configEnv)) };
  }

  // 3. socket health endpoint.
  const health = manifest.lifecycle?.health;
  if (health?.type === 'socket' && health.endpoint) {
    const sock = expandConfigValue(health.endpoint, configEnv);
    if (sock && !sock.includes('${')) {
      return { kind: 'socket', value: canonicalizePath(sock) };
    }
  }

  // 4. host:port.
  const portRaw = configEnv['SOX_CONFIG_PORT'];
  if (portRaw) {
    const host = expandConfigValue(configEnv['SOX_CONFIG_HOST'] ?? '127.0.0.1', configEnv);
    return { kind: 'port', value: `${host}:${expandConfigValue(portRaw, configEnv)}` };
  }

  return { kind: 'none', value: '' };
}

/**
 * The spec's `[def:singleton-key]` (§4.3): `(id, canonical-store-resource)`.
 * Returns null when the service declares no singleton resource (kind 'none'),
 * meaning it is not subject to the cross-store singleton invariant.
 */
export function singletonKey(id: string, resource: StoreResource): string | null {
  if (resource.kind === 'none' || !resource.value) return null;
  return `${id} ${resource.kind}:${resource.value}`;
}

/** True iff a service opts into `[inv:singleton]` via `lifecycle.singleton`. */
export function manifestDeclaresSingleton(manifestPath: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestShape;
    return m.lifecycle?.singleton === true;
  } catch {
    return false;
  }
}

// ─── Process start time (survivor tiebreak, spec §5.3) ──────────────────────────

/**
 * Read a process's start time (epoch ms) from the OS process table via
 * `ps -o lstart=`. The spec (§5.3, Appendix B item 5) chooses oldest-by-start
 * as the survivor tiebreak because it is more portable + meaningful than
 * lowest-pid (pids wrap; the older live writer is the one with warm state).
 *
 * Returns null when ps is unavailable or the pid is gone (the caller falls back
 * to lowest-pid). `lstart` is BSD/macOS + Linux portable (e.g.
 * "Wed Jun 25 11:02:13 2026").
 */
export function processStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export interface SurvivorChoice {
  survivor: number;
  losers: number[];
}

/**
 * Choose the deterministic survivor among ≥2 pids that match one singleton key
 * (spec §5.3). `preferred` (a live supervisor/OS-unit-owned pid) always wins if
 * present in the set. Otherwise the OLDEST by `ps -o lstart` wins; lowest-pid is
 * the fallback only when start times are unavailable/equal.
 */
export function chooseSurvivor(
  pids: number[],
  opts: { preferred?: number | undefined } = {},
): SurvivorChoice {
  const unique = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (unique.length === 0) return { survivor: -1, losers: [] };
  if (unique.length === 1) return { survivor: unique[0]!, losers: [] };

  let survivor: number;
  if (opts.preferred !== undefined && unique.includes(opts.preferred)) {
    survivor = opts.preferred;
  } else {
    // Oldest by start time; lowest-pid tiebreak when times missing/equal.
    const withTime = unique.map((pid) => ({ pid, t: processStartTime(pid) }));
    const allHaveTime = withTime.every((x) => x.t !== null);
    if (allHaveTime) {
      withTime.sort((a, b) => (a.t! - b.t!) || (a.pid - b.pid));
    } else {
      withTime.sort((a, b) => a.pid - b.pid);
    }
    survivor = withTime[0]!.pid;
  }
  return { survivor, losers: unique.filter((p) => p !== survivor) };
}

// ─── Reconcile: heal a duplicate pair for one singleton key (spec §5.3) ──────────

export interface HealResult {
  /** The singleton key healed (id + store-resource). */
  key: string;
  /** pids found alive matching the entrypoint token. */
  found: number[];
  /** The pid kept alive. -1 when nothing was found. */
  survivor: number;
  /** Per-loser kill outcomes ('spared-descendant' = not killed — live child of a root). */
  killed: Array<{ pid: number; outcome: HealOutcome }>;
}

/**
 * BL-621: a singleton heal may spare, not kill. `'spared-descendant'` marks a
 * loser that is a live descendant of a tracked root (an enrich fork child / a
 * fastembed pool host) — it was never a duplicate, only a token-matched child.
 */
export type HealOutcome = KillOutcome | 'spared-descendant';

/**
 * The §5.3 reconcile heal: given the entrypoint identity token for a singleton
 * service and the resolved key, find every live process for it, and if there is
 * MORE than one, kill all but the deterministic survivor (spec §5.3). Never
 * touches a service with ≤1 live process (no thrashing a healthy daemon).
 *
 * `excludePids` (e.g. the live CLI/supervisor) are never killed and are treated
 * as the preferred survivor when present.
 */
export async function healSingletonDuplicates(opts: {
  key: string;
  entrypointToken: string;
  excludePids?: number[] | undefined;
  preferredSurvivor?: number | undefined;
  graceMs?: number | undefined;
  log?: ((msg: string) => void) | undefined;
  /**
   * BL-621 (optional): a pid→ppid snapshot. When provided together with
   * `liveRoots`, a loser whose parentage chain reaches a live root is SPARED
   * (reported `'spared-descendant'`) rather than killed — a token-matched fork
   * child is never a singleton duplicate. Omitted ⇒ the pre-BL-621 behaviour
   * (every loser is killed); owner-directed teardown paths stay unguarded.
   */
  processTable?: ReadonlyMap<number, number> | undefined;
  /** BL-621 (optional): live tracked-instance roots (accounted pids ∪ socket holders). */
  liveRoots?: ReadonlySet<number> | undefined;
}): Promise<HealResult> {
  const log = opts.log ?? (() => { /* no-op */ });
  const matches: OrphanMatch[] = findOrphansByIdentity(opts.entrypointToken, {
    excludePids: opts.excludePids,
  });
  const found = matches.map((m) => m.pid);
  if (found.length <= 1) {
    return { key: opts.key, found, survivor: found[0] ?? -1, killed: [] };
  }

  const { survivor, losers } = chooseSurvivor(found, {
    preferred: opts.preferredSurvivor,
  });
  log(
    `[singleton-violation healed] key=${opts.key} found=${found.length} ` +
    `survivor=${survivor} losers=${losers.join(',')}`,
  );

  const killed: HealResult['killed'] = [];
  for (const pid of losers) {
    if (opts.processTable && opts.liveRoots) {
      const root = descendantOf(pid, opts.liveRoots, opts.processTable);
      if (root !== null) {
        killed.push({ pid, outcome: 'spared-descendant' });
        log(`[singleton heal] spared pid ${pid} (descendant of live root ${root})`);
        continue;
      }
    }
    const outcome = await killAndVerify(pid, {
      graceMs: opts.graceMs ?? 5000,
      log: (m) => log(`[singleton heal] ${m}`),
    });
    killed.push({ pid, outcome });
  }
  return { key: opts.key, found, survivor, killed };
}

// ─── Cross-scope ownership collision (spec §4.4 / §5.2 step 4) ───────────────────

/** A per-scope view of what store-resource an install resolves to. */
export interface ScopeResource {
  scope: string;
  resource: StoreResource;
}

/**
 * Find scopes — OTHER than `targetScope` — whose install of the same extension
 * resolves to the SAME store-resource (spec §4.4 rule 1 / §5.2 step 4). This is
 * the cross-scope collision check that the socket-only guard misses: a project
 * scope that overrides `sock_path` but shares `db_path` collides on the db
 * resource even though the sockets differ.
 *
 * Pure over its inputs — the caller resolves each scope's StoreResource (via
 * resolveStoreResource with that scope's config env) and passes them in.
 */
export function findCrossScopeSharers(
  targetScope: string,
  targetResource: StoreResource,
  others: ScopeResource[],
): string[] {
  if (targetResource.kind === 'none' || !targetResource.value) return [];
  const sharers: string[] = [];
  for (const o of others) {
    if (o.scope === targetScope) continue;
    if (
      o.resource.kind === targetResource.kind &&
      o.resource.value === targetResource.value &&
      o.resource.value !== ''
    ) {
      sharers.push(o.scope);
    }
  }
  return [...new Set(sharers)];
}

/** Convenience: derive the entrypoint identity token from a store dir source. */
export function entrypointTokenForStore(storePath: string): string {
  // The spawned child runs `node … <storePath>/dist/index.js` (or the resolved
  // entrypoint). The reaper matches the entrypoint path token; callers pass the
  // resolved entrypoint source. This helper mirrors identityToken for a
  // file://-prefixed store source.
  return identityToken(storePath);
}
