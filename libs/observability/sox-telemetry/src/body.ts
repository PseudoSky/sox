/**
 * body.ts — c536ce29 L1: bounded raw-body capture with exact accounting.
 *
 * `body_bytes` counts ALL bytes seen and `body_sha256` is a rolling digest over
 * ALL bytes (even past the cap), while the retained text is capped at
 * `maxBytes` and cut on a UTF-8 character boundary. Nothing here throws.
 */
import { createHash } from 'node:crypto';

/** A captured wire body. `body` is null only when `maxBytes` is 0 (digest-only). */
export interface CapturedBody {
  body: string | null;
  body_bytes: number;
  body_sha256: string;
  truncated: boolean;
}

function sanitizeMax(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Number of leading bytes of `buf` forming whole UTF-8 characters (drops a trailing partial sequence). */
function completeUtf8Length(buf: Buffer): number {
  const len = buf.length;
  for (let back = 1; back <= 4 && back <= len; back++) {
    const b = buf[len - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? len - back : len;
  }
  return len;
}

/** Streaming capture: feed chunks with `append`, read the result with `finish`. */
export class BodyCapture {
  private readonly maxBytes: number;
  private readonly hash = createHash('sha256');
  private readonly kept: Buffer[] = [];
  private keptBytes = 0;
  private total = 0;

  constructor(opts: { maxBytes: number }) {
    this.maxBytes = sanitizeMax(opts.maxBytes);
  }

  /** Add a chunk (string is UTF-8 encoded). Invalid chunks are ignored, never thrown on. */
  append(chunk: string | Uint8Array): void {
    try {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (buf.length === 0) return;
      this.hash.update(buf);
      this.total += buf.length;
      const room = this.maxBytes - this.keptBytes;
      if (room > 0) {
        const piece = buf.length <= room ? buf : buf.subarray(0, room);
        this.kept.push(piece);
        this.keptBytes += piece.length;
      }
    } catch {
      /* swallow: capture must never break the wire path */
    }
  }

  /** Snapshot the result. Idempotent; further `append` calls remain valid. */
  finish(): CapturedBody {
    const truncated = this.total > this.maxBytes;
    let body: string | null = null;
    try {
      if (this.maxBytes > 0) {
        const all = Buffer.concat(this.kept, this.keptBytes);
        body = (truncated ? all.subarray(0, completeUtf8Length(all)) : all).toString('utf8');
      }
    } catch {
      body = null;
    }
    return {
      body,
      body_bytes: this.total,
      body_sha256: this.hash.copy().digest('hex'),
      truncated,
    };
  }
}

/** One-shot capture of a complete body. */
export function captureBody(input: string | Uint8Array, opts: { maxBytes: number }): CapturedBody {
  const c = new BodyCapture(opts);
  c.append(input);
  return c.finish();
}
