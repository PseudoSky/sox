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
 * On failure it throws `E_UDS_DIR_UNSAFE` and does nothing else: it never
 * chmods, chowns, deletes, or falls back to a different path. Repairing a
 * directory an attacker may control is the attacker's win condition, and a
 * silent fallback path would split the singleton ([inv:singleton]). The operator
 * inspects and removes it.
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

/** The structured error thrown when a socket directory fails the trust check. */
export interface UdsDirUnsafeError extends Error {
  code: 'E_UDS_DIR_UNSAFE';
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

function unsafe(
  dir: string,
  reason: string,
  fields: { expectedUid: number; actualUid: number | null; mode: number | null; isSymlink: boolean },
): UdsDirUnsafeError {
  const modeStr = fields.mode === null ? 'n/a' : `0${(fields.mode & 0o7777).toString(8)}`;
  const err = new Error(
    `E_UDS_DIR_UNSAFE: socket directory ${dir} is not private (${reason}; ` +
      `owner uid ${String(fields.actualUid)}, expected ${String(fields.expectedUid)}; mode ${modeStr}; ` +
      `symlink ${String(fields.isSymlink)}). Refusing to bind or connect a Unix socket there. ` +
      `Inspect the directory and remove it (\`ls -ld ${dir}\`, then \`rm -r ${dir}\` if it is not ` +
      `yours or not needed); sox recreates it with mode 0700 on next start.`,
  ) as UdsDirUnsafeError;
  err.code = 'E_UDS_DIR_UNSAFE';
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

  if (isSymlink) throw unsafe(dir, 'is a symbolic link', fields);
  if (!st.isDirectory()) throw unsafe(dir, 'is not a directory', fields);
  if (st.uid !== expectedUid) throw unsafe(dir, 'owned by another user', fields);
  if (dir === udsFallbackRoot(expectedUid)) {
    if ((st.mode & 0o777) !== 0o700) throw unsafe(dir, 'fallback root mode is not exactly 0700', fields);
  } else if ((st.mode & 0o022) !== 0) {
    throw unsafe(dir, 'group- or world-writable', fields);
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
