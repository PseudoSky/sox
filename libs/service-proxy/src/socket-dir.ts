/**
 * libs/service-proxy/src/socket-dir.ts -- the UDS directory trust check (BL-4041c6e0).
 *
 * A Unix-domain socket is only as private as the directory it is bound in: any
 * user who can write that directory can unlink the socket and bind an impostor in
 * its place, and any user who owns it can re-point it. `backendSocketPath`'s tier 3
 * places sockets under `/tmp/sox-<uid>` -- inside world-writable `/tmp`, where
 * another local user can pre-create that name. So both ends verify the directory
 * before touching the socket:
 *
 *   - the listener (`serveBackend`) calls {@link ensurePrivateSocketDir} with
 *     `create: true` before bind;
 *   - every dialer (`dialBackend`, `probeSocketLive`, `handshakeBackend`) calls
 *     {@link assertPrivateSocketDir} before `net.createConnection`.
 *
 * The rule (all must hold, checked with `lstat` so a symlink is seen as itself):
 *
 *   - not a symlink, and a directory;
 *   - owned by the current uid;
 *   - the fallback root (`/tmp/sox-<uid>`): mode exactly 0700;
 *   - any other directory: no group/other write bit (`mode & 0o022 === 0`).
 *
 * On failure it throws `E_UDS_DIR_UNSAFE` with a `reason` (`foreign`,
 * `own-writable`, `fallback-mode`) and a remediation message chosen by that
 * reason, and does nothing else: the check never chmods, chowns, deletes, or
 * falls back to a different path. Repairing a directory an attacker may control
 * is the attacker's win condition, and a silent fallback path would split the
 * singleton ([inv:singleton]). No message ever suggests a recursive delete -- a
 * sox run dir holds live runtime state.
 *
 * The one repair path is separate and explicit: {@link tightenOwnedSocketDir}
 * drops group/other write from a directory it can prove (via one
 * `O_NOFOLLOW|O_DIRECTORY` descriptor) is ours. The owning process calls it once
 * at start-up (`soxe` CLI init, the embedding funnel); the checks never call it.
 *
 * Leaf module -- node builtins only (fs). `deps` is injectable so tests can
 * exercise the foreign-owner and fallback-root branches without touching `/tmp`.
 */

import * as fs from 'node:fs';
import { udsFallbackRoot } from './socket-path.js';

/** The filesystem/process primitives the check uses (injectable for tests). */
export interface SocketDirDeps {
  lstat: (p: string) => Pick<fs.Stats, 'mode' | 'uid' | 'isDirectory' | 'isSymbolicLink'>;
  mkdir: (p: string, opts: fs.MakeDirectoryOptions) => unknown;
  getuid: () => number;
}

/** Options for {@link ensurePrivateSocketDir}. */
export interface EnsurePrivateSocketDirOptions {
  /** Create the directory (0700) if it does not exist. */
  create: boolean;
  deps?: Partial<SocketDirDeps> | undefined;
}

/**
 * Why a socket directory was refused. Each reason has its own remediation:
 *
 *   - `foreign`       -- not a directory we own: a symlink, a non-directory, or
 *                        owned by another uid. Possibly a local impostor; sox never
 *                        touches it.
 *   - `own-writable`  -- ours, but group/other-writable (usually umask 002). Safe to
 *                        `chmod go-w`; never delete it, it holds live runtime state.
 *   - `fallback-mode` -- the `/tmp/sox-<uid>` root is ours but not exactly 0700.
 */
export type UdsDirUnsafeReason = 'foreign' | 'own-writable' | 'fallback-mode';

/** The structured error thrown when a socket directory fails the trust check. */
export interface UdsDirUnsafeError extends Error {
  code: 'E_UDS_DIR_UNSAFE';
  reason: UdsDirUnsafeReason;
  dir: string;
  expectedUid: number;
  actualUid: number | null;
  mode: number | null;
  isSymlink: boolean;
}

/** Type guard for {@link UdsDirUnsafeError}. */
export function isUdsDirUnsafeError(err: unknown): err is UdsDirUnsafeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'E_UDS_DIR_UNSAFE'
  );
}

function resolveDeps(deps: Partial<SocketDirDeps> | undefined): SocketDirDeps {
  return {
    lstat: deps?.lstat ?? ((p) => fs.lstatSync(p)),
    mkdir: deps?.mkdir ?? ((p, o) => fs.mkdirSync(p, o)),
    getuid:
      deps?.getuid ??
      (() => {
        if (typeof process.getuid !== 'function') {
          // Delegates to the same structured platform error as the path derivation.
          udsFallbackRoot();
        }
        return (process.getuid as () => number)();
      }),
  };
}

function modeString(mode: number | null): string {
  return mode === null ? 'n/a' : `0${(mode & 0o7777).toString(8)}`;
}

/** The operator remediation for each refusal. Never suggests a recursive delete. */
function remediation(
  dir: string,
  reason: UdsDirUnsafeReason,
  fields: { expectedUid: number; actualUid: number | null; mode: number | null; isSymlink: boolean },
  isFallbackRoot: boolean,
): string {
  const facts =
    `owner uid ${String(fields.actualUid)}, expected ${String(fields.expectedUid)}; ` +
    `mode ${modeString(fields.mode)}; symlink ${String(fields.isSymlink)}`;
  if (reason === 'own-writable') {
    return (
      `socket directory ${dir} is yours but group/other-writable (mode ${modeString(fields.mode)}), ` +
      `usually from umask 002 (${facts}). Run \`chmod go-w ${dir}\` and retry. Do not delete it: ` +
      `it holds live runtime state. sox tightens its own run dirs at start, so if you still see ` +
      `this, something re-adds the bit or this is not a sox-created path (check SOX_ECOSYSTEM_HOME).`
    );
  }
  if (reason === 'fallback-mode') {
    return (
      `socket root ${dir} is yours but its mode is ${modeString(fields.mode)}, not exactly 0700 ` +
      `(${facts}). Run \`chmod 700 ${dir}\` and retry.`
    );
  }
  const base =
    `socket directory ${dir} is not a directory you own (${facts}); sox will not bind, dial or ` +
    `modify it. Check it with \`ls -ld ${dir}\`. If you did not create it, treat it as a possible ` +
    `local impostor. For a symlink, \`rm ${dir}\` removes only the link. A foreign-owned ` +
    `directory under sticky /tmp can only be removed by its owner or an admin. Inside your data ` +
    `root, move it aside (\`mv ${dir} ${dir}.suspect-<timestamp>\`) and restart.`;
  return isFallbackRoot
    ? `${base} This root is used only because your socket dir path exceeds sun_path (104 bytes); ` +
        `point SOX_ECOSYSTEM_HOME at a shorter path to avoid it.`
    : base;
}

function unsafe(
  dir: string,
  reason: UdsDirUnsafeReason,
  fields: { expectedUid: number; actualUid: number | null; mode: number | null; isSymlink: boolean },
  isFallbackRoot: boolean,
): UdsDirUnsafeError {
  const err = new Error(
    `E_UDS_DIR_UNSAFE: ${remediation(dir, reason, fields, isFallbackRoot)}`,
  ) as UdsDirUnsafeError;
  err.code = 'E_UDS_DIR_UNSAFE';
  err.reason = reason;
  err.dir = dir;
  err.expectedUid = fields.expectedUid;
  err.actualUid = fields.actualUid;
  err.mode = fields.mode;
  err.isSymlink = fields.isSymlink;
  return err;
}

/**
 * Verify `dir` is a private socket directory (see module doc for the rule).
 *
 * @throws {@link UdsDirUnsafeError} when the directory exists but fails the rule.
 * @throws the raw `lstat` error (e.g. `ENOENT`) when it cannot be stat'd -- a
 *         missing directory is not unsafe, it just has nothing to dial yet, so the
 *         caller keeps its ordinary retry behaviour.
 */
export function assertPrivateSocketDir(dir: string, deps?: Partial<SocketDirDeps>): void {
  const d = resolveDeps(deps);
  const expectedUid = d.getuid();
  const st = d.lstat(dir);
  const isSymlink = st.isSymbolicLink();
  const fields = { expectedUid, actualUid: st.uid, mode: st.mode, isSymlink };

  const isFallbackRoot = dir === udsFallbackRoot(expectedUid);

  if (isSymlink || !st.isDirectory() || st.uid !== expectedUid) {
    throw unsafe(dir, 'foreign', fields, isFallbackRoot);
  }
  if (isFallbackRoot) {
    if ((st.mode & 0o777) !== 0o700) throw unsafe(dir, 'fallback-mode', fields, true);
  } else if ((st.mode & 0o022) !== 0) {
    throw unsafe(dir, 'own-writable', fields, false);
  }
}

/**
 * Make sure `dir` exists (when `create`) and is a private socket directory.
 *
 * The fallback root (`/tmp/sox-<uid>`) is created NON-recursively with mode 0700
 * -- its parent is `/tmp`, which must never be created or altered -- and an
 * `EEXIST` there is fine: whoever made it, the verification below decides. Any
 * other directory is created recursively (mode 0700). Verification always runs.
 *
 * @throws {@link UdsDirUnsafeError} when the directory fails the rule.
 */
export function ensurePrivateSocketDir(dir: string, opts: EnsurePrivateSocketDirOptions): void {
  const d = resolveDeps(opts.deps);
  if (opts.create) {
    if (dir === udsFallbackRoot(d.getuid())) {
      try {
        d.mkdir(dir, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // EEXIST: an existing root is verified below exactly like a fresh one.
      }
    } else {
      d.mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }
  assertPrivateSocketDir(dir, d);
}

/** Outcome of {@link tightenOwnedSocketDir}. */
export type TightenOutcome = 'absent' | 'ok' | 'tightened' | 'skipped-not-owned';

/** One tightening event: the directory and its mode before and after. */
export interface TightenEvent {
  dir: string;
  oldMode: number;
  newMode: number;
}

/** Options for {@link tightenOwnedSocketDir}. */
export interface TightenOwnedSocketDirOptions {
  /**
   * Called once when a mode was actually changed. The caller routes it to its
   * telemetry (`@adhd/sox-telemetry`); this leaf stays free of that dependency.
   */
  onTightened?: ((e: TightenEvent) => void) | undefined;
  deps?: Partial<Pick<SocketDirDeps, 'getuid'>> | undefined;
}

/**
 * Drop the group/other write bits from a socket directory that WE own
 * (BL-4041c6e0, BL-6233c1c2). This is the repair path for sox's own run dirs,
 * which older builds (or any `mkdir` under umask 002) left 0775. It is called
 * once at start-up by the process that owns the data root -- never by
 * {@link assertPrivateSocketDir} / {@link ensurePrivateSocketDir}, which only
 * judge.
 *
 * It refuses to act on anything it cannot prove is ours, race-free: the
 * directory is opened with `O_NOFOLLOW|O_DIRECTORY` and every check and the
 * `fchmod` run against that one descriptor, so a symlink or a swapped path is
 * never followed. The `/tmp/sox-<uid>` root is never touched (it is held to
 * exactly 0700 and a wrong mode there is an operator decision).
 *
 * @returns `'absent'` (does not exist), `'ok'` (already tight), `'tightened'`
 *          (mode changed to `mode & 0o7755`), or `'skipped-not-owned'` (the
 *          fallback root, a symlink, a non-directory, or another uid's dir).
 */
export function tightenOwnedSocketDir(dir: string, opts: TightenOwnedSocketDirOptions = {}): TightenOutcome {
  const d = resolveDeps(opts.deps);
  const uid = d.getuid();
  if (dir === udsFallbackRoot(uid)) return 'skipped-not-owned';

  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (code === 'ELOOP' || code === 'ENOTDIR') return 'skipped-not-owned';
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.uid !== uid) return 'skipped-not-owned';
    if ((st.mode & 0o022) === 0) return 'ok';
    const oldMode = st.mode & 0o7777;
    const newMode = st.mode & 0o7755;
    fs.fchmodSync(fd, newMode);
    opts.onTightened?.({ dir, oldMode, newMode });
    return 'tightened';
  } finally {
    fs.closeSync(fd);
  }
}
