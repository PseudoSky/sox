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
import { log } from '@adhd/sox-telemetry';

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
 *  a live peer, and sweeping it would destroy its crash evidence (BUG014.T5) or
 *  let a destructive reconcile proceed against a store a peer still holds. */
const LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Shared liveness test for one registry entry (a lease entry OR a per-
 * connection open marker — they share the `pid\nopenedAtIso\n` content shape,
 * see `acquireStoreLease` and preflight.ts `markStoreOpen`).
 *
 * The PID is probed FIRST (`process.kill(pid, 0)`): a live pid is a live
 * session regardless of age. The 24 h age-out is a pid-reuse guard that must
 * never override a proven-live pid (BUG014.T5 review fix): a session running
 * >24 h would otherwise read as dead, re-firing the pre-flight against a live
 * multiprocess store and sweeping its marker/lease — destroying the crash
 * evidence BUG014.T5 exists to preserve. The age-out applies ONLY to pids that
 * are dead or whose liveness cannot be established: an undeterminable pid is
 * treated as live while FRESH (never sweep or flag a possibly-live session)
 * and as dead once older than LEASE_MAX_AGE_MS. Returns null when the content
 * cannot be parsed (never counts as live; callers decide whether to sweep
 * it). Used by {@link storeQuiescence} for lease entries and by preflight.ts
 * `hasUncleanShutdown`/`sweepDeadOpenMarkers` for open markers — the BUG014.T5
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
  } catch (err) {
    // ENOENT or transient fs error — the sweep is idempotent.
    log.debug('store_adapter.lease.sweep_entry_failed', {
      path: entryPath,
      reason: 'ENOENT or transient fs error; sweep is idempotent',
    });
  }
}

export function isEexist(err: unknown): boolean {
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
 *  live peer and is never swept (BUG014.T5 review fix). Quiescent iff zero live
 *  peers. Never throws: unreadable/absent dir ⇒ quiescent. */
export function storeQuiescence(dbPath: string, excludeToken?: string): StoreQuiescence {
  const safe: StoreQuiescence = { quiescent: true, livePeers: [] };
  try {
    let names: string[];
    try {
      names = readdirSync(leaseDirPath(dbPath));
    } catch (err) {
      // absent/unreadable dir ⇒ quiescent, never throws
      log.debug('store_adapter.lease.readdir_failed', {
        db_path: dbPath,
        reason: 'absent or unreadable lease dir; treating as quiescent',
      });
      return safe;
    }
    const livePeers: { token: string; pid: number }[] = [];
    const now = Date.now();
    for (const name of names) {
      // Skip dot-names (e.g. `.DS_Store`, temp files), the caller's own entry,
      // and (BUG014.T5) `.openmark` files — those are per-connection OPEN
      // MARKERS owned by preflight.ts, not lease entries: quiescence must
      // never count them as peers (or sweep them).
      if (name.startsWith('.') || name === excludeToken || name.endsWith('.openmark')) continue;
      const entryPath = join(leaseDirPath(dbPath), name);
      let content: string;
      try {
        content = readFileSync(entryPath, 'utf8');
      } catch (err) {
        // ENOENT (concurrent release) or unreadable — not a peer
        log.debug('store_adapter.lease.read_entry_failed', {
          entry: name,
          reason: 'ENOENT or unreadable entry; treating as not a peer',
        });
        continue;
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
  } catch (err) {
    // NEVER throws — any fs error ⇒ quiescent
    log.debug('store_adapter.lease.quiescence_check_failed', {
      db_path: dbPath,
      reason: 'any fs error; treating as quiescent',
    });
    return safe;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opener registry — "is this store OPEN in a long-lived process?"
//
// The lease above answers "does a peer hold a CONNECTION right now?". That is
// the wrong question for work that must never run under a live service: an
// idle adapter (default `'gated'` idle-flush) closes its connection and drops
// its lease (`releaseIdleConnection()`), so a running-but-idle memory-server
// is lease-invisible. The opener entry lives for the ADAPTER OBJECT's lifetime
// instead — from `connect()` to the final `close()` — and survives
// idle-release and poison/repair reconnects.
//
// Layout: ONE file per process per store, `<leaseDir>/.openers/<pid>`, content
// `<pid>\n<startIso>\n` (the lease shape, so `entryLiveness` judges it). The
// directory is dot-prefixed so every lease-dir scanner that already skips
// dot-names (`storeQuiescence`, `.coldopen.lock`'s neighbours) ignores it.
// Several adapters in ONE process share the file through an in-process
// refcount; the file is written on 0→1 and unlinked on 1→0, and a single
// `process.on('exit')` hook unlinks whatever is left. A SIGKILLed process
// leaves its file behind — `storeOpeners()` sweeps it once its pid is dead.
// ─────────────────────────────────────────────────────────────────────────────

/** Opener directory for a store. */
export function openerDirPath(dbPath: string): string {
  return join(leaseDirPath(dbPath), '.openers');
}

/** One adapter's registration. `release()` is idempotent. */
export interface StoreOpener {
  readonly dbPath: string;
  release(): void;
}

/** In-process refcount of live registrations, keyed by (canonical) dbPath. */
const localOpeners = new Map<string, Set<StoreOpener>>();
let openerExitHookInstalled = false;

function unlinkOwnOpenerFile(dbPath: string): void {
  const path = join(openerDirPath(dbPath), String(process.pid));
  try {
    unlinkSync(path);
  } catch (err) {
    log.debug('store_adapter.opener.unlink_failed', {
      db_path: dbPath,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function writeOwnOpenerFile(dbPath: string): void {
  try {
    mkdirSync(openerDirPath(dbPath), { recursive: true });
    // Plain overwrite: a file already named with OUR pid was left by a dead
    // process whose pid we have recycled — it is ours to replace.
    writeFileSync(
      join(openerDirPath(dbPath), String(process.pid)),
      `${process.pid}\n${new Date().toISOString()}\n`,
    );
  } catch (err) {
    // Registration is advisory for OTHER processes' offline tools; an fs
    // failure here must not fail the open. It is loud, because a missing
    // entry weakens the offline refusal for this store.
    log.warn('store_adapter.opener.register_failed', {
      db_path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Register this adapter as an opener of `dbPath` (canonical path). */
export function registerStoreOpener(dbPath: string): StoreOpener {
  let set = localOpeners.get(dbPath);
  if (!set) {
    set = new Set();
    localOpeners.set(dbPath, set);
  }
  if (set.size === 0) writeOwnOpenerFile(dbPath);
  if (!openerExitHookInstalled) {
    openerExitHookInstalled = true;
    process.on('exit', () => {
      for (const [path, owners] of localOpeners) {
        if (owners.size > 0) unlinkOwnOpenerFile(path);
      }
    });
  }
  let released = false;
  const handle: StoreOpener = {
    dbPath,
    release: () => {
      if (released) return;
      released = true;
      const owners = localOpeners.get(dbPath);
      if (!owners || !owners.delete(handle)) return;
      if (owners.size === 0) {
        localOpeners.delete(dbPath);
        unlinkOwnOpenerFile(dbPath);
      }
    },
  };
  set.add(handle);
  return handle;
}

export interface StoreOpeners {
  /** Pids of live openers other than `exclude` (this process's pid appears
   *  when another adapter in THIS process has the store open). */
  livePids: number[];
  /** True when the opener dir exists but could not be read — liveness is
   *  unknown, so a caller that must be sure has to treat it as in use. */
  unknown: boolean;
}

/**
 * Live openers of `dbPath`, excluding the `exclude` registration. Dead-pid
 * entries are swept as a side effect. Never throws.
 */
export function storeOpeners(dbPath: string, exclude?: StoreOpener): StoreOpeners {
  const livePids: number[] = [];
  const own = localOpeners.get(dbPath);
  const localOthers = own ? own.size - (exclude && own.has(exclude) ? 1 : 0) : 0;
  if (localOthers > 0) livePids.push(process.pid);
  const dir = openerDirPath(dbPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === 'ENOENT') return { livePids, unknown: false };
    log.warn('store_adapter.opener.readdir_failed', {
      db_path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { livePids, unknown: true };
  }
  const now = Date.now();
  let unknown = false;
  for (const name of names) {
    if (name.startsWith('.') || name === String(process.pid)) continue;
    const entryPath = join(dir, name);
    let content: string;
    try {
      content = readFileSync(entryPath, 'utf8');
    } catch (err) {
      log.debug('store_adapter.opener.read_entry_failed', {
        entry: name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const info = entryLiveness(content, now);
    if (info === null) {
      // Unparseable (e.g. torn write from a live registrar): never swept
      // without proof of death, and never proof of absence either.
      unknown = true;
    } else if (info.live) {
      livePids.push(info.pid);
    } else {
      sweepEntry(entryPath); // dead pid — its process never reached close()
    }
  }
  return { livePids, unknown };
}
