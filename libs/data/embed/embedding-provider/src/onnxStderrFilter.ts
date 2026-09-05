/**
 * (BUG-EMBED-ONNX-COREML-STDERR-NOISE-001) Filters the ONNX Runtime CoreML
 * graph-partitioning warning out of the fastembed child's inherited stderr,
 * while forwarding every other byte through verbatim, unbuffered, and in
 * order.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `sharedFastembedProcess.ts` forks `fastembedProcessHost.ts` with
 * `resolveExecutionProviders()` returning `['coreml', 'cpu']` on darwin
 * (`fastembedProcessHost.ts`). bge-base's `word_embeddings` tensor is shaped
 * `{30522,768}`, and CoreML's execution provider cannot host any input
 * dimension over 16384 — so onnxruntime's native CoreML EP logs, at EVERY
 * model load:
 *
 *   [W:onnxruntime:, helper.cc:83 IsInputSupported] CoreML does not support
 *   input dim > 16384. Input:embeddings.word_embeddings.weight,
 *   shape: {30522,768}
 *
 * This is emitted by the native onnxruntime addon straight to the process's
 * real stderr fd (not through any JS logger this package controls), and
 * `sharedFastembedProcess.ts` forks the child with
 * `stdio: ['ignore', 'inherit', 'inherit', 'ipc']` — so it lands on every
 * `adhd-backlog` (or any other consumer) invocation's terminal, on every
 * single command, even though the node in question simply falls back to CPU
 * silently and nothing is actually wrong.
 *
 * ── Why this is a stderr *filter*, not a log-severity option ────────────────
 *
 * onnxruntime-node's `InferenceSession.SessionOptions` DOES expose a
 * `logSeverityLevel` (0=Verbose…4=Fatal) that would suppress Warning-level
 * messages at the source — a cleaner fix, if it were reachable. It is not:
 * `fastembed@2.1.0`'s `FlagEmbedding.init()` (`fastembed.js`'s
 * `ort.InferenceSession.create(modelPath, { executionProviders,
 * graphOptimizationLevel: "all" })`) hardcodes its own `SessionOptions`
 * literal with no passthrough for caller options, and `fastembed`'s public
 * `InitOptions` type has no `sessionOptions`/`logSeverityLevel` field either
 * (verified against the installed `fastembed@2.1.0` and
 * `onnxruntime-node@1.21.0` packages — not assumed). Filtering the child's
 * stderr byte stream is therefore the only lever this package can pull.
 *
 * ── Why this must NOT become "throw away all child stderr" ──────────────────
 *
 * `fastembedProcessHost.ts`'s BL-331 lock check intentionally
 * `console.error`s a loud, greppable line when a competing fastembed host is
 * detected (guarding against a silent 25-50x embed-latency regression), and
 * `resolveExecutionProviders()` intentionally `console.error`s when
 * `SOX_EMBED_EXECUTION_PROVIDER` forces a non-default provider. A blanket
 * "pipe stderr, discard everything" fix would silently destroy both of those
 * — reintroducing exactly the silent-failure class BL-331 exists to prevent.
 * So this filter matches ONLY the known-benign CoreML dim-limit warning text
 * and passes every other line — including genuine errors and both lines
 * above — straight through unmodified.
 */

const BENIGN_CORE_ML_WARNING_SUBSTRING = 'CoreML does not support input dim > 16384';

/**
 * True if `line` is the known-benign ONNX Runtime CoreML dim-limit warning
 * (see module doc comment). This is a plain substring match — deliberately
 * narrow (not a broad `onnxruntime`/`[W:` pattern) so this filter can never
 * swallow an unrelated onnxruntime warning or error that happens to share the
 * `[W:onnxruntime:...]` prefix format.
 */
export function isBenignOnnxCoreMlWarning(line: string): boolean {
  return line.includes(BENIGN_CORE_ML_WARNING_SUBSTRING);
}

/**
 * Attach a line-buffering filter to a child process's stderr `Readable`,
 * dropping only lines matching {@link isBenignOnnxCoreMlWarning} and writing
 * every other line through to `dest` (defaults to `process.stderr`)
 * unbuffered, verbatim (original line content, `\n`-terminated), and in the
 * order it was received.
 *
 * Chunk boundaries never line up with `\n` boundaries in a real pipe, so
 * this buffers a trailing partial line across `data` events instead of
 * filtering mid-line: `source` is split on `\n` as chunks arrive, each
 * complete line is tested and (if not benign) written immediately, and any
 * remaining partial line is flushed on `end` (also filtered, so a benign
 * warning that happens to be the final unterminated write is still caught).
 */
export function attachOnnxStderrFilter(
  source: NodeJS.ReadableStream,
  dest: NodeJS.WritableStream = process.stderr,
): void {
  let buffer = '';
  source.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!isBenignOnnxCoreMlWarning(line)) {
        dest.write(`${line}\n`);
      }
    }
  });
  source.on('end', () => {
    if (buffer.length > 0 && !isBenignOnnxCoreMlWarning(buffer)) {
      dest.write(buffer);
    }
    buffer = '';
  });
}
