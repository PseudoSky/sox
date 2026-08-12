/**
 * store-lease — a pure-JS cross-process lease registry (adapter-race-fix plan §4,
 * BUG-007/008/009 for 0.5.7).
 *
 * One entry file per CONNECTION lives in `<dbPath>.sox-lease.d/`; a process with
 * N connections holds N entries. `storeQuiescence()` answers "are any OTHER live
 * connections holding this store?" and is the gate for every destructive sidecar
 * operation (sidecar rename, WAL TRUNCATE): a store with a live peer is never
 * reconciled, never truncated.
 *
 * Pure `node:fs` + `node:path` + `node:crypto` — no native deps, no new package
 * dependencies (bundled inline). All fs calls are SYNCHRONOUS (deterministic, no
 * await interleaving inside the check — minimizes TOCTOU), and there is no
 * top-level await (CJS-safe, libs/data/CLAUDE.md rule 7).
 *
 * Remote URLs (`dbPath === undefined`) never use the lease — callers skip.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface StoreLease {
  token: string;
  pid: number;
  release(): Promise<void>;
}

export interface StoreQuiescence {
  quiescent: boolean;
  /** Live peer entries (excluding `excludeToken`), for the decline message. */
  livePeers: { token: string; pid: number }[];
}

/** Per-store lease directory, sibling of the db file. NEVER delete this
 *  directory while the store exists (deleting a lock dir is a race hazard). */
export function leaseDirPath(dbPath: string): string {
  return `${dbPath}.sox-lease.d`;
}

/** Entries older than 24 h are swept only when the pid probe cannot prove the
 *  entry live (pid-reuse guard: a recycled pid could make a stale entry look
 *  live once — the age-out caps that exposure at a deferred TRUNCATE, never a
 *  data loss). A PROVEN-live pid is NEVER aged out: a session running >24 h is
 *  a live peer, and sweeping it would destroy its crash evidence (BUG-019) or
 *  let a destructive reconcile proceed against a store a peer still holds. */
const LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Shared liveness test for one registry entry (a lease entry OR a per-
 * connection open marker — they share the `pid\nopenedAtIso\n` content shape,
 * see `acquireStoreLease` and preflight.ts `markStoreOpen`).
 *
 * The PID is probed FIRST (`process.kill(pid, 0)`): a live pid is a live
 * session regardless of age. The 24 h age-out is a pid-reuse guard that must
 * never override a proven-live pid (BUG-019 review fix): a session running
 * >24 h would otherwise read as dead, re-firing the pre-flight against a live
 * multiprocess store and sweeping its marker/lease — destroying the crash
 * evidence BUG-019 exists to preserve. The age-out applies ONLY to pids that
 * are dead or whose liveness cannot be established: an undeterminable pid is
 * treated as live while FRESH (never sweep or flag a possibly-live session)
 * and as dead once older than LEASE_MAX_AGE_MS. Returns null when the content
 * cannot be parsed (never counts as live; callers decide whether to sweep
 * it). Used by {@link storeQuiescence} for lease entries and by preflight.ts
 * `hasUncleanShutdown`/`sweepDeadOpenMarkers` for open markers — the BUG-019
 * requirement to reuse storeQuiescence's liveness logic.
 */
export function entryLiveness(
  content: string,
  now: number = Date.now(),
): { live: boolean; pid: number; openedAt: number } | null {
  const [pidLine, openedAtLine] = content.split('\n');
  const openedAt = openedAtLine ? Date.parse(openedAtLine) : NaN;
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0) return null; // unparseable — callers decide

  // Probe liveness FIRST. kill(pid, 0) errno semantics: no throw ⇒ the
  // process exists; EPERM ⇒ it EXISTS but is not owned by us (kill(2));
  // ESRCH ⇒ no such process; EINVAL ⇒ pid out of range — no process can hold
  // it. Only the first two are "live".
  let probe: 'live' | 'dead' | 'undeterminable';
  try {
    process.kill(pid, 0);
    probe = 'live';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    probe =
      code === 'EPERM' ? 'live' : code === 'ESRCH' || code === 'EINVAL' ? 'dead' : 'undeterminable';
  }
  if (probe === 'live') return { live: true, pid, openedAt }; // live pids are age-out-proof

  // Not proven live — NOW the 24 h age-out applies (pid-reuse guard), and only
  // to the undeterminable class: a dead pid is dead regardless of age, and a
  // fresh undeterminable pid is treated as live (conservative — never sweep a
  // session whose liveness we could not establish).
  if (
    probe === 'undeterminable' &&
    (!Number.isFinite(openedAt) || now - openedAt <= LEASE_MAX_AGE_MS)
  ) {
    return { live: true, pid, openedAt };
  }
  return { live: false, pid, openedAt };
}

/** Best-effort unlink of an entry. ENOENT (already released) and any other
 *  fs error are ignored — sweeping is a side effect, never a failure. */
function sweepEntry(entryPath: string): void {
  try {
    unlinkSync(entryPath);
  } catch {
    // ENOENT or transient fs error — the sweep is idempotent.
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST'
  );
}

/** Acquire a connection lease: one entry file per connection.
 *  Entry path: `${leaseDir}/<token>`; content: `<pid>\n<openedAtIso>\n`.
 *  Created with flag 'wx' (atomic exclusive create; a token collision is
 *  astronomically unlikely and simply retries with a fresh token).
 *  Returns a handle whose `release()` unlinks the entry (ENOENT ignored). */
export async function acquireStoreLease(dbPath: string): Promise<StoreLease> {
  const dir = leaseDirPath(dbPath);
  // The lease dir is created with recursive: true — no throw on exist. It is
  // NEVER deleted while the store exists (deleting a lock dir is a race hazard).
  mkdirSync(dir, { recursive: true });
  const pid = process.pid;
  const content = `${pid}\n${new Date().toISOString()}\n`;
  let token = '';
  for (;;) {
    token = randomUUID();
    try {
      writeFileSync(join(dir, token), content, { flag: 'wx' });
      break;
    } catch (err) {
      if (isEexist(err)) continue; // token collision — retry with a fresh token
      throw err;
    }
  }
  return {
    token,
    pid,
    release: async () => {
      sweepEntry(join(dir, token));
    },
  };
}

/** Quiescence probe: list the lease dir, exclude `excludeToken` (the caller's
 *  own entry — a process's own lease must never count against itself), read
 *  each peer's pid, liveness = `process.kill(pid, 0)` does not throw.
 *  Dead entries are SWEPT (unlinked) as a side effect. The 24 h age-out is a
 *  pid-reuse guard applied ONLY to entries whose pid is dead or of
 *  undeterminable liveness — a PROVEN-live pid (however old the entry) is a
 *  live peer and is never swept (BUG-019 review fix). Quiescent iff zero live
 *  peers. Never throws: unreadable/absent dir ⇒ quiescent. */
export function storeQuiescence(dbPath: string, excludeToken?: string): StoreQuiescence {
  const safe: StoreQuiescence = { quiescent: true, livePeers: [] };
  try {
    let names: string[];
    try {
      names = readdirSync(leaseDirPath(dbPath));
    } catch {
      return safe; // absent/unreadable dir ⇒ quiescent, never throws
    }
    const livePeers: { token: string; pid: number }[] = [];
    const now = Date.now();
    for (const name of names) {
      // Skip dot-names (e.g. `.DS_Store`, temp files), the caller's own entry,
      // and (BUG-019) `.openmark` files — those are per-connection OPEN
      // MARKERS owned by preflight.ts, not lease entries: quiescence must
      // never count them as peers (or sweep them).
      if (name.startsWith('.') || name === excludeToken || name.endsWith('.openmark')) continue;
      const entryPath = join(leaseDirPath(dbPath), name);
      let content: string;
      try {
        content = readFileSync(entryPath, 'utf8');
      } catch {
        continue; // ENOENT (concurrent release) or unreadable — not a peer
      }
      const info = entryLiveness(content, now);
      if (info === null) continue; // unparseable — not a peer
      if (info.live) {
        livePeers.push({ token: name, pid: info.pid });
      } else {
        sweepEntry(entryPath); // dead (or aged-out) entry — swept as a side effect
      }
    }
    return { quiescent: livePeers.length === 0, livePeers };
  } catch {
    return safe; // NEVER throws — any fs error ⇒ quiescent
  }
}
