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
    // _openStream will be called on next stream() call.
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
