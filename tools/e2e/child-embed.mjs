#!/usr/bin/env node
/**
 * tools/e2e/child-embed.mjs — isolated child process for the fastembed
 * (embedding-provider) stage of substrate-pipeline.test.mjs.
 *
 * WHY THIS IS A SEPARATE PROCESS (not a workaround, not a mock — a real,
 * necessary process boundary around a genuine upstream native-library
 * incompatibility discovered by this e2e):
 *
 *   `@adhd/sox-embedding-provider`'s fastembed backend and
 *   `@adhd/sox-hybrid-search`/`@adhd/sox-claim-verification`'s shared
 *   `embedWorker.ts` both run real ONNX inference in `worker_threads.Worker`
 *   threads, but through two DIFFERENT major versions of the native
 *   `onnxruntime-node` addon (the `fastembed` npm package pins
 *   `onnxruntime-node@1.21.0`; `@huggingface/transformers@4.2.0` pins
 *   `onnxruntime-node@1.24.3`). Loading + running inference in TWO worker
 *   threads that each carry an onnxruntime-node native addon in the SAME
 *   process crashes the process with a native V8 fatal error
 *   (`v8::HandleScope::CreateHandle() Cannot create a handle without a
 *   HandleScope`, inside `onnxruntime-node`'s `InferenceSessionWrap::Run`) —
 *   reproduced deterministically even with TWO fastembed workers alone (no
 *   version mismatch needed), so this is a real thread-safety limitation of
 *   the `fastembed` package's worker usage, not merely an ABI mismatch.
 *   Two `@huggingface/transformers`-based workers (cross-encoder rerank +
 *   claim-verification NLI) DO coexist safely in one process.
 *
 *   Real production consumers of this substrate that embed + rerank +
 *   verify in a single long-lived process would hit this exact crash today.
 *   This is logged as a blocking finding in sox-ecosystem/BACKLOG.md — the
 *   real fix (a genuine singleton/multiplexed ONNX worker, or process-level
 *   isolation inside the packages themselves) is out of this state's
 *   `tools/e2e/**` reservation. This script isolates ONLY the fastembed
 *   stage into its own OS process so the rest of the real pipeline
 *   (LanceDB, hybrid-search fusion, the real ONNX cross-encoder, and the
 *   real ONNX NLI verifier — all proven mutually compatible) can run
 *   together in the parent test process — every component is still 100%
 *   real, real inference, on-disk LanceDB persisted across the process
 *   boundary; only the OS thread/process layout changes.
 *
 * Contract: reads a job spec from the file path in argv[2]:
 *   { fixtureDir, lancedbPath, embedModelId, embedDim, queryText }
 * Writes exactly one line to stdout prefixed with `__E2E_RESULT__` followed
 * by JSON: { dim, records: [{id,text,sourceUrl,heading,chunkerId}], queryVector: number[] }
 * (all other stdout — e.g. vector-store's `[vector-store] ...` info logs —
 * is real console output from the real packages and is ignored by the
 * parent via the marker prefix, not suppressed).
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { createLocalProvider, SourceRef } from '../../libs/source-provider/dist/index.js';
import { globalChunkerRegistry } from '../../libs/data/ingest/ingest/dist/index.js';
import { createEmbeddingProvider } from '../../libs/data/embed/embedding-provider/dist/index.js';
import { openLanceDbVectorStore } from '../../libs/data/vectors/vector-store/dist/index.js';

const RESULT_MARKER = '__E2E_RESULT__';

const LANGUAGE_BY_EXT = {
  '.ts': 'typescript',
  '.py': 'python',
  '.md': 'markdown',
};

// embedding-provider's FastembedProvider intentionally `unref()`s its worker
// (fire-and-forget default so a real consumer app isn't forced to wait on
// it) — which means a bare script with NOTHING else keeping the event loop
// alive can have the process exit between "send request" and "receive
// reply" ticks, silently abandoning the in-flight promise (no error, no
// warning, exit 0, zero output — reproduced and confirmed while building
// this harness). A ref'd keep-alive interval for the duration of real work
// is the correct caller-side counterpart to an intentionally unref'd
// worker; cleared before we hand control back, on both the success and
// error paths.
const keepAlive = setInterval(() => {}, 1000);

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('child-embed.mjs requires a job file path as argv[2]');
  const job = JSON.parse(readFileSync(jobPath, 'utf-8'));
  const { fixtureDir, lancedbPath, embedModelId, embedDim, queryText } = job;

  // ── source-provider: fetch tree + content, no clone, no network ──────────
  const provider = createLocalProvider();
  const ref = SourceRef.parse(fixtureDir);
  const manifest = await provider.fileTree(ref);
  const fileEntries = manifest.entries.filter((e) => e.type === 'file');

  // ── ingest: real web-tree-sitter AST chunker (code) + heading chunker (docs) ──
  const records = [];
  let nextId = 1;
  for (const entry of fileEntries) {
    const language = LANGUAGE_BY_EXT[extname(entry.path)];
    if (!language) continue;

    const content = await provider.content(ref, entry.path);
    const chunker =
      language === 'markdown'
        ? globalChunkerRegistry.get('heading:markdown')
        : globalChunkerRegistry.getForLanguage(language)[0];
    if (!chunker) throw new Error(`no chunker registered for language "${language}"`);

    const chunks = chunker.chunk(content, { sourceUrl: entry.path, sourceSha: entry.sha });
    for (const chunk of chunks) {
      records.push({
        id: nextId++,
        text: chunk.text,
        sourceUrl: entry.path,
        heading: chunk.metadata.heading,
        chunkerId: chunk.metadata.chunkerId,
      });
    }
  }

  // ── embedding-provider: real fastembed ONNX embeddings (isolated process) ──
  const embeddingProvider = await createEmbeddingProvider({ type: 'fastembed', model: embedModelId });
  if (embeddingProvider.metadata.dimensions !== embedDim) {
    throw new Error(
      `embedding dim mismatch: expected ${embedDim}, got ${embeddingProvider.metadata.dimensions}`,
    );
  }

  // ── vector-store: real on-disk LanceDB backend ─────────────────────────────
  const vectorStore = openLanceDbVectorStore({ lancedbPath, db: undefined });
  const space = { modelId: embedModelId, dim: embedDim };
  vectorStore.ensureSpace(space);

  for (const record of records) {
    const vec = await embeddingProvider.embedSingle(record.text, 'document');
    if (vec.length !== embedDim) {
      throw new Error(`chunk embedding dim mismatch for ${record.sourceUrl}: got ${vec.length}`);
    }
    vectorStore.upsert(record.id, vec, space);
  }

  const queryVector = await embeddingProvider.embedSingle(queryText, 'query');

  // NOTE: `process.stdout.write()` to a piped (non-TTY) stdout can be
  // asynchronous on some platforms; calling `process.exit()` immediately
  // after would risk truncating the write before the OS-level flush
  // completes. Setting `process.exitCode` and letting the process exit
  // naturally (once the now-properly-unref'd embedding worker stops holding
  // the event loop open) guarantees the write is flushed first.
  process.stdout.write(
    `${RESULT_MARKER}${JSON.stringify({
      dim: embeddingProvider.metadata.dimensions,
      records,
      queryVector: Array.from(queryVector),
    })}\n`,
  );

  process.exitCode = 0;
}

main()
  .catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
