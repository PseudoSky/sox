/**
 * libs/host-runtime/src/log-manager.ts — log pipeline (R4 / P3).
 *
 * LogManager owns the write stream for a single extension's log output.
 * It handles daily rotation and enforces the configured file-size cap.
 *
 * Log file path template:
 *   <logDir>/<extId>-<YYYY-MM-DD>.log
 *
 * Rotation policy (concrete defaults, not per-extension-overrideable in P3):
 *   - Max size per file: 50 MB
 *   - Max files per extId prefix: 7 (one week of daily logs at typical verbosity)
 *   - Files are kept as plain text (no compressed archives in P3)
 *
 * Run-history tracking is also managed here:
 *   <logDir>/run-history.json — appended by supervisor on spawn/stop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logDirFor } from './data-paths.js';

export interface LogManagerOptions {
  /** e.g. ~/.sox/logs/<supervisorId> */
  logDir: string;
  /** e.g. "memory-server" */
  extId: string;
  /** Default: 50_000_000 (50 MB) */
  maxSizeBytes?: number;
  /** Default: 7 */
  maxFiles?: number;
}

export interface RunRecord {
  extId: string;
  /** ISO 8601 timestamp when the supervisor spawned this extension */
  startedAt: string;
  /** ISO 8601 timestamp when the extension stopped, or null if currently running */
  stoppedAt: string | null;
  /** Exit code from the process, or null if killed by signal or still running */
  exitCode: number | null;
  /** How the process ended */
  stopReason: 'clean' | 'sigterm' | 'sigkill' | 'crash' | null;
}

export interface RunHistoryFile {
  version: 1;
  runs: RunRecord[];
}

export class LogManager {
  private _stream: fs.WriteStream | null = null;
  private _currentPath: string = '';
  private _currentDate: string = '';
  private _bytesWritten: number = 0;

  private readonly _maxSizeBytes: number;
  private readonly _maxFiles: number;

  constructor(private readonly opts: LogManagerOptions) {
    this._maxSizeBytes = opts.maxSizeBytes ?? 50_000_000;
    this._maxFiles = opts.maxFiles ?? 7;
  }

  /**
   * Returns the write stream for the current log file. Opens or rotates as needed.
   * Called on every chunk write so rotation is checked eagerly.
   */
  stream(): fs.WriteStream {
    const today = todayDateString();

    // Rotate if date has changed.
    if (this._currentDate !== today && this._stream !== null) {
      this._rotateDate();
    }

    // Open a new stream if none is open yet.
    if (this._stream === null) {
      this._openStream(today);
    }

    return this._stream!;
  }

  /**
   * Write a chunk to the log, handling size-based rotation inline.
   */
  write(chunk: Buffer): void {
    const s = this.stream();
    s.write(chunk);
    this._bytesWritten += chunk.length;

    if (this._bytesWritten >= this._maxSizeBytes) {
      this._rotateSizeExceeded();
    }
  }

  /**
   * Returns the path of the currently active log file.
   * Empty string if no stream has been opened yet.
   */
  currentPath(): string {
    return this._currentPath;
  }

  /**
   * Close the current stream. Called on supervisor stop or extension teardown.
   */
  close(): void {
    if (this._stream !== null) {
      try {
        this._stream.end();
      } catch {
        /* ignore */
      }
      this._stream = null;
    }
    this._currentPath = '';
    this._currentDate = '';
    this._bytesWritten = 0;
  }

  /**
   * Append a run-start record to run-history.json.
   * Called when the supervisor spawns the extension.
   */
  appendRunStart(extId: string): void {
    const history = this._readHistory();
    history.runs.push({
      extId,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      stopReason: null,
    });
    this._writeHistory(history);
  }

  /**
   * Patch the most recent run record for the given extId with stop information.
   * Called when the supervisor's stop() method completes.
   */
  patchRunStop(
    extId: string,
    exitCode: number | null,
    stopReason: RunRecord['stopReason'],
  ): void {
    const history = this._readHistory();
    // Find the most recent record for this extId that hasn't been stopped yet.
    for (let i = history.runs.length - 1; i >= 0; i--) {
      const run = history.runs[i];
      if (run && run.extId === extId && run.stoppedAt === null) {
        run.stoppedAt = new Date().toISOString();
        run.exitCode = exitCode;
        run.stopReason = stopReason;
        break;
      }
    }
    this._writeHistory(history);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _historyPath(): string {
    return path.join(this.opts.logDir, 'run-history.json');
  }

  private _readHistory(): RunHistoryFile {
    const p = this._historyPath();
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as RunHistoryFile;
      } catch {
        /* corrupt — start fresh */
      }
    }
    return { version: 1, runs: [] };
  }

  private _writeHistory(history: RunHistoryFile): void {
    const p = this._historyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  }

  private _openStream(date: string): void {
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    const filePath = path.join(this.opts.logDir, `${this.opts.extId}-${date}.log`);
    // Append mode so log files survive across supervisor restarts.
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
    this._stream.on('error', (e: Error) => {
      console.warn(`[log-manager] write stream error for ${filePath}: ${String(e)}`);
    });
    this._currentPath = filePath;
    this._currentDate = date;
    // Start _bytesWritten from current file size so size cap is accurate on append.
    try {
      const stat = fs.statSync(filePath);
      this._bytesWritten = stat.size;
    } catch {
      this._bytesWritten = 0;
    }
  }

  private _rotateDate(): void {
    this.close();
    // BUG (host-runtime observability defect B, filed as a backlog item):
    // date-triggered rotation used to close the old file and stop there —
    // `_pruneOldFiles()` was only ever called from `_rotateSizeExceeded()`.
    // A log that never hits the 50 MB size cap within a single day (the
    // overwhelmingly common case for most extensions) rolls to a new
    // `<extId>-<date>.log` every day FOREVER with zero enforcement of the
    // documented "Max files per extId prefix: 7" policy at the top of this
    // file — the retention config existed and was read by the size-rotation
    // path, but was structurally unreachable from the date-rotation path,
    // which is the one that actually fires under normal, non-bursty log
    // volume. Pruning here closes that gap: every date rollover now enforces
    // the same `maxFiles` bound the size-rotation path always has.
    // _openStream will be called on next stream() call.
    this._pruneOldFiles();
  }

  private _rotateSizeExceeded(): void {
    if (this._stream === null) return;

    const oldPath = this._currentPath;
    const epoch = Date.now();
    const rotatedPath = oldPath.replace(/\.log$/, `.${epoch}.log`);

    // End the current stream, then rename.
    try {
      this._stream.end();
    } catch {
      /* ignore */
    }
    this._stream = null;

    try {
      fs.renameSync(oldPath, rotatedPath);
    } catch {
      /* ignore if rename fails — will just re-open same path */
    }

    this._pruneOldFiles();

    // Re-open a fresh file for the same date.
    this._openStream(this._currentDate || todayDateString());
  }

  /**
   * Delete oldest files if we exceed maxFiles for this extId prefix.
   */
  private _pruneOldFiles(): void {
    const dir = this.opts.logDir;
    if (!fs.existsSync(dir)) return;

    let files: string[];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${this.opts.extId}-`) && f.endsWith('.log'))
        .map((f) => path.join(dir, f))
        .sort(); // lexicographic sort — ISO dates and epoch suffixes sort correctly
    } catch {
      return;
    }

    while (files.length > this._maxFiles) {
      const oldest = files.shift();
      if (oldest) {
        try { fs.unlinkSync(oldest); } catch { /* ignore */ }
      }
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function todayDateString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── PI-3: Unified log stream discovery ──────────────────────────────────────

/**
 * A single discoverable log stream for an extension.
 * Used by `soxe logs --id=<ext>` (PI-3) and `soxe follow` (PI-4) to enumerate
 * ALL streams associated with a given extension id, including proxy-backend and
 * OS-unit output streams that were previously invisible to `soxe logs`.
 */
export interface LogStreamDescriptor {
  /** Human-readable stream label (e.g. "backend", "serve", "os-out", "os-err") */
  label: string;
  /**
   * The log directory (e.g. `runDir()/logs/<supervisorId>` or
   * `runDir()/logs/proxy-backend-<extId>`).
   */
  logDir: string;
  /**
   * Glob-like file prefix pattern: all files in `logDir` whose name starts with
   * this prefix and ends with `.log` belong to this stream.
   */
  filePrefix: string;
}

/**
 * Find ALL log streams for a given extension id across all known sources.
 *
 * Returns descriptors for:
 * 1. The supervisor-managed extension log stream: `<extId>-<date>.log`
 * 2. The proxy-backend log stream: `<extId>-backend-<date>.log` (when present)
 * 3. The OS-unit log streams: `<extId>-os.out.log` / `<extId>-os.err.log`
 *    (BL-620 stable paths; legacy `<extId>-os-<date>.<out|err>.log` archives are
 *    still discovered via the finder's dated-shape match — see
 *    {@link findMostRecentLogFile})
 *    (when the extension has an OS unit)
 * 4. The serve log stream: `<extId>-serve-<date>.log` (when `soxe serve --log` is used)
 *
 * @param extId The extension id (e.g. "memory-server")
 * @param supervisorId The deterministic supervisor id for the scope+root
 * @param scope The installation scope (used for OS-unit log dir key)
 */
export function findAllLogStreamsForExt(
  extId: string,
  supervisorId: string,
  scope: string,
): LogStreamDescriptor[] {
  const streams: LogStreamDescriptor[] = [];

  // 1. Supervisor-managed extension log (current behaviour).
  const extLogDir = logDirFor(supervisorId);
  streams.push({ label: 'process', logDir: extLogDir, filePrefix: `${extId}-` });

  // 2. Proxy-backend log (auto-spawned by soxe serve, §9.5).
  const backendLogDir = logDirFor(`proxy-backend-${extId}`);
  streams.push({ label: 'backend', logDir: backendLogDir, filePrefix: `${extId}-backend-` });

  // 3. OS-unit log (launchd/systemd stdout/stderr redirects). BL-630: distinct
  // prefixes per stream so `findMostRecentLogFile` can tell stdout apart from
  // stderr (the old shared `${extId}-os` prefix collapsed both onto one file).
  const osLogDir = logDirFor(`os-${scope}-${extId}`);
  streams.push({ label: 'os-out', logDir: osLogDir, filePrefix: `${extId}-os.out` });
  streams.push({ label: 'os-err', logDir: osLogDir, filePrefix: `${extId}-os.err` });

  // 4. Serve log (soxe serve --log or SOX_SERVE_LOG=1).
  const serveLogDir = logDirFor(`serve-${extId}`);
  streams.push({ label: 'serve', logDir: serveLogDir, filePrefix: `${extId}-serve-` });

  return streams;
}

/**
 * Find the most recent log file matching a given prefix in a directory.
 * Returns the full path, or null if no matching log file exists.
 *
 * BL-632: the ACTIVE os-unit log is the exact stable name `<filePrefix>.log`
 * (e.g. `doctor-tick-os.out.log`); its rotated archives are
 * `<filePrefix>.log.<timestamp>` (e.g. `doctor-tick-os.out.log.20260801`).
 * Both previously matched `startsWith(filePrefix)`, and a lexicographic sort
 * puts the longer archive name LAST — so `files[files.length - 1]` returned the
 * ARCHIVE instead of the live active file. Resolve the exact active name first,
 * and exclude `.log.<digits>` archives from the fallback scan so the finder can
 * never misreport a rotated archive as the current live log.
 */
export function findMostRecentLogFile(logDir: string, filePrefix: string): string | null {
  if (!fs.existsSync(logDir)) return null;
  const exact = path.join(logDir, `${filePrefix}.log`);
  if (fs.existsSync(exact)) return exact;
  let files: string[];
  try {
    files = fs.readdirSync(logDir)
      .filter((f: string) => logStreamFileMatches(f, filePrefix))
      .filter((f: string) => !isRotatedArchiveName(f, filePrefix))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return path.join(logDir, files[files.length - 1] as string);
}

/**
 * BL-632: true when `name` is a ROTATED archive of the active `<filePrefix>.log`
 * file — i.e. `<filePrefix>.log.<digits…>`. These archives must never win the
 * most-recent determination over the live active file (or, when the active file
 * is absent, over a legacy dated archive).
 */
function isRotatedArchiveName(name: string, filePrefix: string): boolean {
  return new RegExp(`^${escapeRegex(filePrefix)}\\.log\\.\\d`).test(name);
}

/**
 * BL-630: match a log file name against a stream. Stable os-unit paths
 * (`<extId>-os.out.log` / `<extId>-os.err.log`) match by the `${extId}-os.out` /
 * `${extId}-os.err` prefix. The LEGACY dated forms (`<extId>-os-<date>.<out|err>.log`)
 * no longer share that prefix, so they are matched by deriving extId + stream back
 * out of the prefix and testing the dated shape — without this, `soxe logs` /
 * `follow` could not surface old archives after the prefix split.
 */
function logStreamFileMatches(name: string, filePrefix: string): boolean {
  if (!name.endsWith('.log')) return false;
  if (name.startsWith(filePrefix)) return true;
  const osStream = /^(.*)-os\.(out|err)$/.exec(filePrefix);
  if (!osStream) return false;
  const extId = osStream[1]!;
  const stream = osStream[2]!;
  return new RegExp(`^${escapeRegex(extId)}-os-\\d{4}-\\d{2}-\\d{2}\\.${stream}\\.log$`).test(name);
}

// ─── BL-620 / INV-6: OS-unit log rotation ──────────────────────────────────────

export interface RotateOsUnitLogsOptions {
  /** The active stdout log path (e.g. `<logDir>/<id>-os.out.log`). */
  outPath: string;
  /** The active stderr log path (e.g. `<logDir>/<id>-os.err.log`). Optional. */
  errPath?: string;
  /** Size threshold above which the active log is rotated (copytruncated). Default 1 MB. */
  maxBytes?: number;
  /** Max number of rotated archives to keep per stream. Default 5. */
  keep?: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rotate ONE OS-unit log stream: copytruncate an over-size active file to
 * `<path>.<YYYYMMDD-HHmmss>` (BL-629 — the active path's inode is preserved so
 * the OS supervisor's open fd keeps writing to the same file), then prune
 * archived files by count and size. See {@link rotateOsUnitLogs}.
 */
function rotateOsUnitLogFile(activePath: string, maxBytes: number, keep: number): void {
  const dir = path.dirname(activePath);
  const base = path.basename(activePath); // e.g. doctor-tick-os.out.log

  // Derive id/stream from the STABLE `<id>-os.<stream>.log` shape, not from
  // `base.indexOf('-os.')` + slicing: an id that itself contains `-os.` (e.g.
  // `my-os-tool`) mis-splits under the substring approach (`my` + `tool-os.out`),
  // and a non-matching path silently no-ops instead of logging. The anchored
  // regex lets the greedy `.+` capture the FULL id (`my-os-tool`) with the
  // literal `-os.<stream>.log` tail disambiguating the split.
  const stableRe = /^(.+)-os\.(out|err)\.log$/;
  const m = stableRe.exec(base);
  if (m === null) {
    console.warn(`[os-unit] rotateOsUnitLogFile: ${activePath} is not a recognized os-unit log path — nothing rotated`);
    return;
  }
  const id = m[1]!;
  const stream = m[2]!;

  // 1. Size-triggered copytruncate of the active file (BL-629): the OS
  // supervisor keeps the active log OPEN via StandardOutPath/StandardErrorPath,
  // so renaming would relabel the still-growing file and post-rename output
  // would keep landing in the renamed archive. Copy the content to a
  // collision-free archive path, then truncate the active path to 0 — the inode
  // (and the supervisor's open fd) is preserved, so the service keeps writing to
  // the (now empty) active file and disk stays bounded while it lives.
  if (fs.existsSync(activePath)) {
    let size = 0;
    try { size = fs.statSync(activePath).size; } catch { /* ignore */ }
    if (size >= maxBytes) {
      try {
        const rotated = uniqueArchivePath(activePath);
        fs.copyFileSync(activePath, rotated);
        fs.truncateSync(activePath, 0);
      } catch { /* best-effort rotation */ }
    }
  }

  // 2. Enumerate archives in BOTH forms:
  //    new    → `<id>-os.<stream>.log.<YYYYMMDD[-HHmmss[.N]]>`
  //    legacy → `<id>-os-<date>.<stream>.log`
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const newRe = new RegExp(`^${escapeRegex(id)}-os\\.${stream}\\.log\\.\\d{8}(?:-\\d{6}(?:\\.\\d+)?)?$`);
  const legacyRe = new RegExp(`^${escapeRegex(id)}-os-\\d{4}-\\d{2}-\\d{2}\\.${stream}\\.log$`);
  const archives: Array<{ path: string; name: string }> = [];
  for (const name of entries) {
    if (newRe.test(name) || legacyRe.test(name)) {
      archives.push({ path: path.join(dir, name), name });
    }
  }

  // 3. Prune archives over maxBytes*4 regardless of count.
  const sizeCap = maxBytes * 4;
  const survivors: Array<{ path: string; name: string }> = [];
  for (const a of archives) {
    let size = 0;
    try { size = fs.statSync(a.path).size; } catch { /* ignore */ }
    if (size > sizeCap) {
      try { fs.unlinkSync(a.path); } catch { /* ignore */ }
    } else {
      survivors.push(a);
    }
  }

  // 4. Count-cap: keep the newest `keep` archives. Sort by PARSED date — the
  // legacy `-os-<YYYY-MM-DD>` and new `.YYYYMMDD[-HHmmss]` forms normalize to a
  // common sortable key — not raw `name.localeCompare`, which misorders the two
  // forms relative to each other (a legacy `-os-2026-08-02` sorts AFTER a new
  // `.20260801` even though it is the older archive).
  survivors.sort((a, b) => archiveSortKey(a.name).localeCompare(archiveSortKey(b.name)));
  while (survivors.length > keep) {
    const oldest = survivors.shift();
    if (oldest) {
      try { fs.unlinkSync(oldest.path); } catch { /* ignore */ }
    }
  }
}

/**
 * BL-620 (second-round): a sortable date key for an os-unit log ARCHIVE name,
 * normalizing every accepted form to a common lexicographic order:
 *   legacy  `-os-<YYYY-MM-DD>.<out|err>.log`     → `YYYY-MM-DD`
 *   new     `.log.<YYYYMMDD>`                    → `YYYY-MM-DD`
 *   new+ts  `.log.<YYYYMMDD>-<HHmmss>`           → `YYYY-MM-DD-HHmmss`
 *   collided`.log.<YYYYMMDD>-<HHmmss>.<N>`       → `YYYY-MM-DD-HHmmss.NNNN`
 * Non-archive names fall through to the raw name.
 */
function archiveSortKey(name: string): string {
  const legacy = /-os-(\d{4}-\d{2}-\d{2})\.(out|err)\.log$/.exec(name);
  if (legacy) return legacy[1]!;
  const newForm = /\.log\.(\d{8})(?:-(\d{6})(?:\.(\d+))?)?$/.exec(name);
  if (newForm) {
    const d = newForm[1]!;
    const base = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const t = newForm[2];
    const n = newForm[3];
    return `${base}${t !== undefined ? `-${t}` : ''}${n !== undefined ? `.${n.padStart(4, '0')}` : ''}`;
  }
  return name;
}

/** A UTC `YYYYMMDD-HHmmss` stamp for the current instant. */
function archiveStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}`;
}

/**
 * BL-620 (second-round, same-day archive overwrite): a collision-free archive
 * path for `activePath`. The base is `<activePath>.<YYYYMMDD-HHmmss>`; when that
 * name is already taken (a prior rotation within the same UTC second, or a prior
 * day's archive coinciding), a monotonic `.N` disambiguator is appended. This
 * replaces the old fixed `.YYYYMMDD` suffix, under which a second rotation within
 * one UTC day silently overwrote the first archive.
 */
function uniqueArchivePath(activePath: string): string {
  const base = `${activePath}.${archiveStamp()}`;
  if (!fs.existsSync(base)) return base;
  let n = 1;
  for (;;) {
    const candidate = `${base}.${n}`;
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}

/**
 * BL-620 / INV-6: rotate OS-unit log streams at reconcile time. The stable
 * active paths (`<id>-os.out.log` / `<id>-os.err.log`) grow unbounded because
 * launchd/systemd append forever and the old dated names were never rotated.
 *
 *   - size-triggered copytruncate of the active file to `<path>.<YYYYMMDD-HHmmss>`
 *     (BL-629: the active inode/fd is preserved — the supervisor keeps writing
 *     to the same file, now truncated, instead of a renamed archive);
 *   - count-cap prune keeping `keep` archives per stream, matching BOTH the new
 *     `.YYYYMMDD[-HHmmss]` form and the legacy `-os-<date>.<out|err>.log` form;
 *   - archives larger than `maxBytes * 4` are pruned regardless of count.
 */
export function rotateOsUnitLogs(opts: RotateOsUnitLogsOptions): void {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const keep = opts.keep ?? 5;
  rotateOsUnitLogFile(opts.outPath, maxBytes, keep);
  if (opts.errPath !== undefined) rotateOsUnitLogFile(opts.errPath, maxBytes, keep);
}
