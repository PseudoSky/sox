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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface JsonlSinkOptions {
  /** Directory the rotating files live in. Created recursively on first write. */
  dir: string;
  /** File-name prefix. Callers that want role isolation (BL-353) pass a
   *  role-qualified component, e.g. `memory-core.live` — NOT `memory-core-live`,
   *  because a hyphen collides with the `<component>-<date>` anchor below. */
  component: string;
  /** Size-based rotation threshold in bytes. Default 20 MB. */
  maxBytes?: number;
  /** Rotated files retained per component. Default 7. */
  maxFiles?: number;
  /** `writeSync` (true, default) vs fire-and-forget stream (false). See BL-365. */
  durable?: boolean;
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
  private readonly _opts: Required<JsonlSinkOptions>;

  constructor(opts: JsonlSinkOptions) {
    this._opts = {
      dir: opts.dir,
      component: opts.component,
      maxBytes: opts.maxBytes ?? 20_000_000,
      maxFiles: opts.maxFiles ?? 7,
      durable: opts.durable ?? true,
    };
    this._durableMode = this._opts.durable;
  }

  currentPath(): string {
    return this._currentPath;
  }

  private _isOpen(): boolean {
    return this._fd !== null || this._stream !== null;
  }

  /** Test-only: resolve once every write queued so far has reached the file.
   *  Durable mode: writes are already on disk when `write()` returns, so this
   *  is a no-op. Buffered mode: flushes the stream. */
  flush(): Promise<void> {
    if (this._stream === null) return Promise.resolve();
    return new Promise((resolve) => {
      this._stream!.write('', () => resolve());
    });
  }

  write(line: string): void {
    const today = todayDateString();
    if (!this._isOpen() || today !== this._currentDate) {
      this._reopen(today);
    }
    if (!this._isOpen()) return; // open failed — drop silently, never throw

    const buf = Buffer.from(line, 'utf8');
    if (this._fd !== null) {
      try {
        fs.writeSync(this._fd, buf);
      } catch {
        return; // disk full / fd revoked / EINTR — drop, never throw
      }
    } else if (this._stream !== null) {
      this._stream.write(buf);
    }
    this._bytesWritten += buf.length;

    if (this._bytesWritten >= this._opts.maxBytes) {
      this._rotateSizeExceeded();
    }
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
  }

  private _reopen(date: string): void {
    this.close();
    const { dir, component } = this._opts;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${component}-${date}.jsonl`);
      // Open the fd synchronously so the file physically exists the instant
      // this returns — a size-triggered rotation racing an async open would
      // otherwise `renameSync` a file that doesn't exist yet and silently
      // drop it via the catch below.
      const fd = fs.openSync(filePath, 'a');
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
      try {
        this._bytesWritten = fs.statSync(filePath).size;
      } catch {
        this._bytesWritten = 0;
      }
    } catch {
      this._stream = null;
      this._fd = null;
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
    try {
      fs.renameSync(oldPath, rotatedPath);
    } catch {
      /* ignore — worst case we keep appending past the cap once */
    }
    this._pruneOldFiles();
    this._reopen(this._currentDate);
  }

  private _pruneOldFiles(): void {
    const { dir, component, maxFiles } = this._opts;
    if (!fs.existsSync(dir)) return;
    // Anchored on the FULL `<component>-<ISO-date>` shape, not a bare prefix —
    // see the class doc comment for the collision this closes (BL-351 §5.8).
    const anchor = new RegExp(`^${escapeRegExp(component)}-\\d{4}-\\d{2}-\\d{2}(\\.\\d+-\\d+)?\\.jsonl$`);
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => anchor.test(f))
        .map((f) => path.join(dir, f))
        .sort();
    } catch {
      return;
    }
    while (files.length > maxFiles) {
      const oldest = files.shift();
      if (oldest) {
        try {
          fs.unlinkSync(oldest);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
