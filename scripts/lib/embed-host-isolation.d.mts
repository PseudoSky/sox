/**
 * Hand-written declarations for the parts of `scripts/lib/embed-host-isolation.mjs` that
 * TypeScript test infrastructure imports (memory-server's `vitest.global-embed-scratch.ts`,
 * BL-26291f21). Plain ESM with no build step; `allowJs` is off repo-wide.
 */

/** The `ps` argv whose output `parsePsLines` understands. */
export const PS_ARGS: string[];

/** One embedding-host (`host`) or fastembed child (`child`) process record. */
export interface IEmbedHostRecord {
  pid: number;
  ppid: number;
  pgid: number;
  startedMs: number;
  kind: 'host' | 'child';
  home: string | null;
  tmpdir: string | null;
  xdgCacheHome: string | null;
  dataRoot: string | null;
  socket: string | null;
  cacheDir: string | null;
  spawnerPid: number;
  line: string;
}

/** True when `p` is `root` or lies beneath it (in any /private spelling). */
export function isInsideRoot(p: string | null, root: string): boolean;

/** One-line human description of a host record. */
export function describeHost(p: IEmbedHostRecord): string;

export interface IAuditAndReapResult {
  smoke: IEmbedHostRecord[];
  foreign: IEmbedHostRecord[];
  violations: { pid: number; kind: string; reasons: string[] }[];
  stopped: number[];
  undead: number[];
  psFailed: boolean;
}

/**
 * Audit, verified-stop every run-owned host (argv/env names a root in `smokeRoots`, or lineage),
 * re-scan once. Foreign hosts are only reported, never signalled.
 */
export function auditAndReapEmbedHosts(
  ctx: {
    smokeRoots: string[];
    spawnedPids: Set<number>;
    runStartedMs: number;
    ownedIds?: Map<number, number>;
    spawnStartedMs?: Map<number, number>;
  },
  io: {
    ps: () => string | null;
    now: () => number;
    kill: (pid: number, sig: string | number) => void;
    sleep: (ms: number) => Promise<void>;
    identity?: (pid: number) => string | null;
    log?: (s: string) => void;
    rescanMs?: number;
    termMs?: number;
    killMs?: number;
  },
): Promise<IAuditAndReapResult>;
