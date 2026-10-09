/**
 * sink.ts — the durable JSONL sink (BL-351 §5.6/§5.8, migrated from
 * `libs/memory-core/src/telemetry.ts`'s `RotatingJsonlWriter`).
 *
 * This is the ONLY durable-write mechanism in the substrate. Every span
 * start/finish record, every metrics snapshot, and every plain log line goes
 * through one `DurableJsonlSink` instance. Two properties carried over
 * unchanged from the original, because they are the whole reason this class
 * exists rather than `fs.createWriteStream`:
 *
 *   - **`writeSync` by default (BL-365).** A fire-and-forget stream measured
 *     0 of 10,000 records surviving SIGKILL. `durable: true` (default) holds
 *     the fd directly and writes synchronously — costs ~2.2µs/record more.
 *   - **Never throws, never blocks the caller on a fault.** Disk full / fd
 *     revoked / directory unwritable — every failure mode drops the record
 *     silently rather than propagating. A logging fault must never break or
 *     slow the operation it is observing.
 *
 * Unlike the original, `DurableJsonlSink` takes its directory/component/
 * rotation policy as constructor options instead of reading `process.env`
 * itself — env resolution belongs to the composition root (`initTelemetry`),
 * not the sink. This is what lets `role`-qualified components (BL-353) exist
 * without the sink knowing anything about roles.
 *
 * **Pruning anchor fix (BL-351 §5.8 footgun, fixed here rather than
 * reintroduced):** the original pruner selected `f.startsWith(component + '-')`,
 * which means a component `memory-core` would ALSO match and delete files
 * belonging to `memory-core-live` — a live-service forensic log deleted by an
 * un-migrated test-role writer's retention pass. The filter here is anchored
 * on the full `<component>-<ISO-date>` shape via regex, not a bare prefix.
 *
 * **c536ce29 additive options (sox-telemetry 0.5.0).** `fileScope: 'per-process'`
 * (+ `fileLabel`) puts the label and pid in the file name so no two processes
 * ever share an open file; `maxAgeDays` / `maxDirBytes` add age and
 * directory-byte retention; `gzipRotated` compresses rotated files
 * asynchronously. Every default reproduces the pre-0.5.0 behaviour byte for
 * byte (shared file name, count-only retention, no gzip).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export interface JsonlSinkOptions {
  /** Directory the rotating files live in. Created recursively on first write. */
  dir: string;
  /** File-name prefix. Callers that want role isolation (BL-353) pass a
   *  role-qualified component, e.g. `memory-core.live` — NOT `memory-core-live`,
   *  because a hyphen collides with the `<component>-<date>` anchor below. */
  component: string;
  /** Size-based rotation threshold in bytes. Default 20 MB. */
  maxBytes?: number;
  /** Rotated files retained per component. Default 7.
   *
   *  Hard-floored at prune time (`Math.max(1, maxFiles)`): a value of `0` or a
   *  negative number keeps exactly ONE file, never zero. Pruning to zero would
   *  unlink the file the sink is actively appending to and leave the durable
   *  series with nothing to read. */
  maxFiles?: number;
  /** `writeSync` (true, default) vs fire-and-forget stream (false). See BL-365. */
  durable?: boolean;
  /** `'shared'` (default): every process of one component appends to
   *  `<component>-<date>.jsonl` (today's behaviour). `'per-process'`: the file is
   *  `<component>-<date>.<fileLabel>.<pid>.jsonl`, so a file has exactly one writer. */
  fileScope?: 'shared' | 'per-process';
  /** Stable instance label for `per-process` names; `[A-Za-z0-9_-]` only (anything
   *  else becomes `_`). Default `proc`. */
  fileLabel?: string;
  /** Delete matching files whose mtime is older than this many days. `0`/unset = off. */
  maxAgeDays?: number;
  /** Delete oldest matching files until their total size is <= this. `0`/unset = off. */
  maxDirBytes?: number;
  /** Gzip each rotated file asynchronously (errors swallowed). Default false. */
  gzipRotated?: boolean;
  /** Called with the underlying error when a write/open fails (the record is still
   *  dropped, never thrown). Must not throw; exceptions from it are swallowed. */
  onError?: (err: unknown, op: 'open' | 'write') => void;
}

const FILE_LABEL_DEFAULT = 'proc';

function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : FILE_LABEL_DEFAULT;
}

/**
 * The regex every retention pass is anchored on. Matches the legacy shared shape
 * `<component>-<date>[.<epoch>-<seq>].jsonl` AND the per-process shape
 * `<component>-<date>.<label>.<pid>[.<epoch>-<seq>].jsonl`, each with an optional
 * trailing `.gz`. Always the FULL `<component>-<ISO-date>` shape (BL-351 §5.8).
 * Capture 1 = label, capture 2 = pid (per-process names only).
 */
export function componentFileAnchor(component: string): RegExp {
  return new RegExp(
    `^${escapeRegExp(component)}-\\d{4}-\\d{2}-\\d{2}(?:\\.([A-Za-z0-9_-]+)\\.(\\d+))?(?:\\.\\d+-\\d+)?\\.jsonl(?:\\.gz)?$`,
  );
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  dir: string;
  component: string;
  /** Count cap, hard-floored at 1. Omit to not count-cap. */
  maxFiles?: number;
  maxAgeDays?: number;
  maxDirBytes?: number;
  /** Absolute paths that must never be deleted (the caller's open file). */
  protect?: readonly string[];
  /** Clock override for tests. */
  now?: number;
}

/**
 * One retention pass over the component's files. Tolerates ENOENT/EBUSY and any
 * other fs error (a concurrent sweeper may have removed a file first), only ever
 * touches names matching {@link componentFileAnchor}, and never deletes (a) a path in
 * `protect` or (b) the newest file of any pid that is still alive — so a peer
 * process's live file survives. Idempotent under concurrent sweeps. Returns the
 * number of files this call unlinked.
 */
export function sweepComponentFiles(o: SweepOptions): number {
  let deleted = 0;
  try {
    const anchor = componentFileAnchor(o.component);
    interface Entry {
      file: string;
      name: string;
      mtimeMs: number;
      size: number;
      pid: number | null;
    }
    const entries: Entry[] = [];
    for (const name of fs.readdirSync(o.dir)) {
      const m = anchor.exec(name);
      if (!m) continue;
      const file = path.join(o.dir, name);
      try {
        const st = fs.statSync(file);
        entries.push({ file, name, mtimeMs: st.mtimeMs, size: st.size, pid: m[2] !== undefined ? Number(m[2]) : null });
      } catch {
        /* vanished between readdir and stat — a peer swept it */
      }
    }
    const protectedSet = new Set<string>(o.protect ?? []);
    const newestByPid = new Map<number, Entry>();
    for (const e of entries) {
      if (e.pid === null) continue;
      const cur = newestByPid.get(e.pid);
      if (!cur || e.mtimeMs > cur.mtimeMs || (e.mtimeMs === cur.mtimeMs && e.name > cur.name)) newestByPid.set(e.pid, e);
    }
    for (const [pid, e] of newestByPid) if (isPidAlive(pid)) protectedSet.add(e.file);

    const gone = new Set<string>();
    const remove = (e: Entry): void => {
      try {
        fs.unlinkSync(e.file);
        deleted++;
      } catch {
        /* ENOENT/EBUSY/EPERM — already gone or busy; tolerated */
      }
      gone.add(e.file);
    };
    const live = (): Entry[] => entries.filter((e) => !gone.has(e.file));

    if (o.maxFiles !== undefined) {
      const cap = Math.max(1, o.maxFiles);
      let remaining = entries.length;
      for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (remaining <= cap) break;
        if (protectedSet.has(e.file)) continue;
        remove(e);
        remaining--;
      }
    }
    if (o.maxAgeDays !== undefined && o.maxAgeDays > 0) {
      const cutoff = (o.now ?? Date.now()) - o.maxAgeDays * 86_400_000;
      for (const e of live()) if (e.mtimeMs < cutoff && !protectedSet.has(e.file)) remove(e);
    }
    if (o.maxDirBytes !== undefined && o.maxDirBytes > 0) {
      let total = live().reduce((n, e) => n + e.size, 0);
      const oldestFirst = live().sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
      for (const e of oldestFirst) {
        if (total <= o.maxDirBytes) break;
        if (protectedSet.has(e.file)) continue;
        remove(e);
        total -= e.size;
      }
    }
  } catch {
    /* unreadable dir — nothing to sweep */
  }
  return deleted;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function todayDateString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class DurableJsonlSink {
  private _fd: number | null = null;
  private _stream: fs.WriteStream | null = null;
  private _durableMode: boolean;
  private _currentPath = '';
  private _currentDate = '';
  private _bytesWritten = 0;
  private _rotationSeq = 0;
  private _opts: Required<JsonlSinkOptions>;
  /** Snapshot of (dir, component, durable) the currently-open fd/stream was
   *  opened against — compared on every `write()` so a `reconfigure()` call
   *  (or a caller re-resolving env vars per call, memory-core's pattern)
   *  takes effect on the next write without requiring an explicit reopen. */
  private _openedFor: { dir: string; component: string; durable: boolean; scope: string } | null = null;
  private _rotated = 0;
  private _pendingGzip = new Set<Promise<void>>();

  constructor(opts: JsonlSinkOptions) {
    this._opts = DurableJsonlSink._normalize(opts);
    this._durableMode = this._opts.durable;
  }

  private static _normalize(opts: JsonlSinkOptions): Required<JsonlSinkOptions> {
    return {
      dir: opts.dir,
      component: opts.component,
      maxBytes: opts.maxBytes ?? 20_000_000,
      maxFiles: opts.maxFiles ?? 7,
      durable: opts.durable ?? true,
      fileScope: opts.fileScope ?? 'shared',
      fileLabel: opts.fileLabel ?? FILE_LABEL_DEFAULT,
      maxAgeDays: opts.maxAgeDays ?? 0,
      maxDirBytes: opts.maxDirBytes ?? 0,
      gzipRotated: opts.gzipRotated ?? false,
      onError: opts.onError ?? ((): void => undefined),
    };
  }

  /**
   * Update the sink's configuration in place. Does NOT force an immediate
   * reopen — the next `write()` detects drift in (dir, component, durable)
   * against what the currently-open fd/stream was opened for and reopens
   * then. This is what lets a caller re-resolve environment variables on
   * every call (memory-core's per-call `SOX_MEMORY_LOG_*` contract) without
   * constructing a new sink instance per write.
   */
  reconfigure(opts: JsonlSinkOptions): void {
    this._opts = DurableJsonlSink._normalize(opts);
  }

  currentPath(): string {
    return this._currentPath;
  }

  /**
   * The file the NEXT `write()` will land in, computed without opening
   * anything. `currentPath()` is `''` until the first write, which makes a
   * status surface reporting it indistinguishable from "no sink configured" —
   * the same absent-field ambiguity as BL-319/BL-347. A status field should
   * answer "where do I look?" whether or not anything has been written yet.
   */
  plannedPath(): string {
    return path.join(this._opts.dir, `${this._stem(todayDateString())}.jsonl`);
  }

  /** File stem (no extension). Shared scope is the legacy `<component>-<date>`. */
  private _stem(date: string): string {
    const { component, fileScope, fileLabel } = this._opts;
    return fileScope === 'per-process'
      ? `${component}-${date}.${sanitizeLabel(fileLabel)}.${process.pid}`
      : `${component}-${date}`;
  }

  /** Number of size-triggered rotations this instance has performed. */
  rotatedCount(): number {
    return this._rotated;
  }

  private _reportError(err: unknown, op: 'open' | 'write'): void {
    try {
      this._opts.onError(err, op);
    } catch {
      /* a faulty hook must never break the sink */
    }
  }

  private _isOpen(): boolean {
    return this._fd !== null || this._stream !== null;
  }

  /** Test-only: resolve once every write queued so far has reached the file.
   *  Durable mode: writes are already on disk when `write()` returns, so this
   *  is a no-op. Buffered mode: flushes the stream. */
  flush(): Promise<void> {
    const gz = this._pendingGzip.size > 0 ? Promise.allSettled([...this._pendingGzip]).then(() => undefined) : null;
    if (this._stream === null) return gz ?? Promise.resolve();
    const streamed = new Promise<void>((resolve) => {
      this._stream!.write('', () => resolve());
    });
    return gz ? Promise.all([streamed, gz]).then(() => undefined) : streamed;
  }

  write(line: string): void {
    void this.tryWrite(line);
  }

  /** Same as {@link write} but reports whether the record reached the file. Never throws. */
  tryWrite(line: string): boolean {
    const today = todayDateString();
    const { dir, component, durable } = this._opts;
    const drifted =
      this._openedFor === null ||
      this._openedFor.dir !== dir ||
      this._openedFor.component !== component ||
      this._openedFor.durable !== durable ||
      this._openedFor.scope !== this._scopeKey();
    // BUG-TELEMETRY-DATE-ROLLED-LOGS-NEVER-PRUNED-001: size-triggered rotation
    // prunes (`_rotateSizeExceeded` → `_pruneOldFiles`), but a DATE rollover
    // opened a brand-new file without EVER pruning — so a long-lived process
    // that wrote a little every day accumulated one date-rolled file per day
    // past `maxFiles`, unbounded. Capture the rollover BEFORE `_reopen` resets
    // `_currentDate`, then prune on it too, so date-rolled files are
    // count-capped (`maxFiles`) on rollover, not only on size rotation. The
    // first-ever write (`_currentDate === ''`) also satisfies this condition,
    // which is desirable: it caps date files left behind by a prior process.
    const dateRolled = today !== this._currentDate;
    const prevPath = this._currentPath;
    if (!this._isOpen() || dateRolled || drifted) {
      this._durableMode = durable;
      this._reopen(today);
    }
    if (!this._isOpen()) return false; // open failed — drop silently, never throw

    if (dateRolled) {
      if (this._opts.gzipRotated && prevPath !== '' && prevPath !== this._currentPath) this._gzip(prevPath);
      this._pruneOldFiles();
    }

    const buf = Buffer.from(line, 'utf8');
    if (this._fd !== null) {
      try {
        fs.writeSync(this._fd, buf);
      } catch (err) {
        this._reportError(err, 'write');
        return false; // disk full / fd revoked / EINTR — drop, never throw
      }
    } else if (this._stream !== null) {
      this._stream.write(buf);
    }
    this._bytesWritten += buf.length;

    if (this._bytesWritten >= this._opts.maxBytes) {
      this._rotateSizeExceeded();
    }
    return true;
  }

  private _scopeKey(): string {
    return `${this._opts.fileScope}:${this._opts.fileScope === 'per-process' ? sanitizeLabel(this._opts.fileLabel) : ''}`;
  }

  close(): void {
    if (this._stream !== null) {
      try {
        this._stream.end();
      } catch {
        /* ignore */
      }
      this._stream = null;
    } else if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch {
        /* ignore */
      }
    }
    this._fd = null;
    this._currentPath = '';
    this._currentDate = '';
    this._bytesWritten = 0;
    this._openedFor = null;
  }

  private _reopen(date: string): void {
    this.close();
    const { dir, component, durable } = this._opts;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${this._stem(date)}.jsonl`);
      // Open the fd synchronously so the file physically exists the instant
      // this returns — a size-triggered rotation racing an async open would
      // otherwise `renameSync` a file that doesn't exist yet and silently
      // drop it via the catch below.
      const fd =
        this._opts.fileScope === 'per-process' ? fs.openSync(filePath, 'a', 0o600) : fs.openSync(filePath, 'a');
      if (this._durableMode) {
        this._fd = fd;
      } else {
        this._stream = fs.createWriteStream(filePath, { fd });
        this._stream.on('error', () => {
          /* never throw from a logging failure */
        });
      }
      this._currentPath = filePath;
      this._currentDate = date;
      this._openedFor = { dir, component, durable, scope: this._scopeKey() };
      try {
        this._bytesWritten = fs.statSync(filePath).size;
      } catch {
        this._bytesWritten = 0;
      }
    } catch (err) {
      this._stream = null;
      this._fd = null;
      this._openedFor = null;
      this._reportError(err, 'open');
    }
  }

  private _rotateSizeExceeded(): void {
    if (!this._isOpen()) return;
    const oldPath = this._currentPath;
    const epoch = Date.now();
    const seq = this._rotationSeq++;
    const rotatedPath = oldPath.replace(/\.jsonl$/, `.${epoch}-${seq}.jsonl`);
    try {
      if (this._stream !== null) this._stream.end();
      else if (this._fd !== null) fs.closeSync(this._fd);
    } catch {
      /* ignore */
    }
    this._stream = null;
    this._fd = null;
    let renamed = false;
    try {
      fs.renameSync(oldPath, rotatedPath);
      renamed = true;
      this._rotated++;
    } catch {
      /* ignore — worst case we keep appending past the cap once */
    }
    if (renamed && this._opts.gzipRotated) this._gzip(rotatedPath);
    this._pruneOldFiles();
    this._reopen(this._currentDate);
  }

  private _pruneOldFiles(): void {
    const { dir, component, maxFiles, maxAgeDays, maxDirBytes } = this._opts;
    // Durable-metrics S2: never delete the newest file. `sweepComponentFiles` floors
    // the count cap at 1 (pruning to zero would unlink the file the sink is
    // appending to) and anchors on the FULL `<component>-<ISO-date>` shape — see
    // the module doc for the collision this closes (BL-351 §5.8).
    sweepComponentFiles({
      dir,
      component,
      maxFiles,
      maxAgeDays,
      maxDirBytes,
      protect: this._currentPath !== '' ? [this._currentPath] : [],
    });
  }

  /** Gzip `file` to `file.gz` off the hot path. All errors are swallowed; a
   *  partial `.gz.tmp` is removed. Tracked so `flush()` can await it. */
  private _gzip(file: string): void {
    const perProcess = this._opts.fileScope === 'per-process';
    const task = (async (): Promise<void> => {
      const tmp = `${file}.gz.tmp`;
      try {
        await pipeline(
          fs.createReadStream(file),
          createGzip(),
          fs.createWriteStream(tmp, perProcess ? { mode: 0o600 } : {}),
        );
        await fs.promises.rename(tmp, `${file}.gz`);
        await fs.promises.unlink(file);
      } catch {
        try {
          await fs.promises.unlink(tmp);
        } catch {
          /* nothing to clean */
        }
        return;
      }
      if (this._opts.maxAgeDays > 0 || this._opts.maxDirBytes > 0) this._pruneOldFiles();
    })().catch(() => undefined);
    this._pendingGzip.add(task);
    void task.finally(() => this._pendingGzip.delete(task));
  }
}
