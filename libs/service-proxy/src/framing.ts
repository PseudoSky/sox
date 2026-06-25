/**
 * libs/service-proxy/src/framing.ts — length-prefixed JSON-RPC frame codec.
 *
 * The front-shim (§9.5.2) speaks raw newline/stdio JSON-RPC to the MCP client but
 * length-prefixed frames to the backend over a Unix domain socket. UDS is a byte
 * stream with no message boundaries, so we frame every payload as:
 *
 *     [ 4-byte big-endian uint32 length ][ <length> bytes of UTF-8 JSON ]
 *
 * A 4-byte length header (max ~4 GiB) is plenty for a JSON-RPC message and keeps
 * the codec trivially correct — no escaping, no delimiter ambiguity (unlike the
 * newline-delimited exec socket, which cannot carry a JSON string containing a raw
 * newline without escaping).
 *
 * Leaf module — imports ONLY node builtins. No sox-package imports (this lib is a
 * dependency-free leaf per §9.5.4).
 */

/** The fixed size of the length prefix, in bytes. */
export const HEADER_BYTES = 4;

/**
 * A hard cap on a single frame's payload size (16 MiB). A larger declared length
 * is treated as a protocol error rather than allocating an attacker-sized buffer.
 * JSON-RPC tool payloads are far smaller; this only guards against a corrupt or
 * hostile peer on the (0600, data-root-owned) socket.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Encode a JSON-serialisable value into a single length-prefixed frame.
 *
 * @throws if the encoded payload exceeds {@link MAX_FRAME_BYTES}.
 */
export function encodeFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error(
      `[service-proxy] frame payload ${json.length}B exceeds max ${MAX_FRAME_BYTES}B`,
    );
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * A streaming frame decoder. Feed it arbitrary chunks from a socket via
 * {@link push}; it emits each complete frame's parsed JSON payload to the
 * `onMessage` callback. Partial frames are buffered across chunks.
 *
 * Decoupling the decoder from the socket makes it directly unit-testable (push a
 * byte at a time and assert reassembly) and reusable on both the shim and backend
 * sides.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (value: unknown) => void,
    /** Called on a protocol violation (oversized/invalid frame). The caller
     * should destroy the socket — the stream is no longer trustworthy. */
    private readonly onError: (err: Error) => void,
  ) {}

  /** Feed a chunk of raw bytes; emits zero or more complete frames. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    for (;;) {
      if (this.buf.length < HEADER_BYTES) return; // need more bytes for the header
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        this.onError(
          new Error(`[service-proxy] declared frame length ${len}B exceeds max ${MAX_FRAME_BYTES}B`),
        );
        return;
      }
      if (this.buf.length < HEADER_BYTES + len) return; // need more bytes for the body

      const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
      this.buf = this.buf.subarray(HEADER_BYTES + len);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (e) {
        this.onError(
          new Error(`[service-proxy] invalid JSON in frame: ${(e as Error).message}`),
        );
        return;
      }
      this.onMessage(parsed);
    }
  }

  /** Discard any buffered partial frame (e.g. on socket close). */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
