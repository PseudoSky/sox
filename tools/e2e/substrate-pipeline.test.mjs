#!/usr/bin/env node
/**
 * tools/e2e/substrate-pipeline.test.mjs — full substrate pipeline e2e.
 *
 * PROVES dod.2: a single, real, hermetic run of the entire P1 substrate
 * pipeline over a real on-disk fixture repository (`tools/e2e/fixtures/sample-repo`):
 *
 *   source-provider (LocalProvider, [def:no-clone] — fileTree()+content(), no
 *     git clone, no network)
 *     -> ingest chunking (real `web-tree-sitter` AST chunker for code +
 *        heading chunker for the README, [def:cast])
 *     -> embedding-provider (real fastembed ONNX embeddings, bge-base-en-v1.5)
 *     -> vector-store (real on-disk LanceDB backend, real kNN)
 *     -> hybrid-search (real `fuse()` fusion + real ONNX cross-encoder rerank,
 *        Xenova/ms-marco-MiniLM-L-6-v2 via the shared embedWorker)
 *     -> blob-store (real on-disk content-addressable store, sha256 integrity)
 *     -> claim-verification (real ONNX NLI, Xenova/nli-deberta-v3-xsmall via
 *        the same shared embedWorker)
 *
 * Every package below is imported directly from its own built `dist/` output
 * (the real published surface, `package.json#exports` "." entry) via a
 * relative path — never mocked, never stubbed, never simulated. No
 * `pnpm install`/new node_modules are required: each package already carries
 * its own resolved dependencies (including its sibling `@adhd/sox-*`
 * workspace deps) in its own `node_modules/`, so importing each package's
 * compiled entrypoint in place (without moving/copying files) is sufficient
 * for every internal bare-specifier `import` to resolve exactly as it would
 * for a real downstream consumer. (hybrid-search's cross-encoder.js statically
 * imports only the TYPES of `@adhd/sox-embedding-provider`; its value runtime
 * — including `getSharedOnnxWorker()`, used by `createCrossEncoder()` below —
 * is resolved lazily on first `createCrossEncoder()`, never at module load.
 * ADR-0019.)
 *
 * PROCESS BOUNDARY (real components on both sides — see child-embed.mjs's
 * header comment for the full root-cause writeup): the embedding-provider
 * (fastembed, onnxruntime-node@1.21.0) stage runs in its own child process,
 * isolated from the cross-encoder + claim-verification stage (both
 * @huggingface/transformers, onnxruntime-node@1.24.3) in THIS process — two
 * different onnxruntime-node native addon versions each running ONNX
 * inference in their own worker_threads.Worker in the SAME process crashes
 * with a native V8 fatal error (reproduced deterministically; logged as a
 * blocking finding in sox-ecosystem/BACKLOG.md). LanceDB persists real
 * vectors to disk across the process boundary; nothing is mocked.
 *
 * First run downloads and caches (via @huggingface/transformers /
 * fastembed-js):
 *   - fastembed bge-base-en-v1.5 (embedding, 768-dim)
 *   - Xenova/ms-marco-MiniLM-L-6-v2 (cross-encoder rerank, ~23MB quantized)
 *   - Xenova/nli-deberta-v3-xsmall (NLI claim verification, ~87MB quantized)
 * so the model-loading hook is given a generous timeout.
 *
 * Scope note: the GitHub/Bitbucket no-clone network fetch is proven by
 * source-provider's OWN unit tests (mocked HTTP / createFakeProvider) — this
 * e2e deliberately uses LocalProvider so it stays hermetic and token-free
 * (see contexts/integration.md "Scope note").
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ── Real substrate packages — imported from their own built dist/ output ──

import { openLanceDbVectorStore } from '../../libs/data/vectors/vector-store/dist/index.js';
import { fuse, createCrossEncoder } from '../../libs/data/search/hybrid-search/dist/index.js';
import { createClaimVerifier } from '../../libs/data/verify/claim-verification/dist/index.js';
import { createBlobStore } from '../../libs/data/store/blob-store/dist/index.js';

// ── Fixture + model configuration ──────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'sample-repo');
const CHILD_EMBED_SCRIPT = join(HERE, 'child-embed.mjs');
const RESULT_MARKER = '__E2E_RESULT__';

const EMBED_MODEL_ID = 'bge-base-en-v1.5';
const EMBED_DIM = 768;
const CROSS_ENCODER_MODEL_ID = 'MiniCheck'; // -> Xenova/ms-marco-MiniLM-L-6-v2
const NLI_MODEL_ID = 'MiniCheck'; // -> Xenova/nli-deberta-v3-xsmall (claim-verification's own map)
const QUERY_TEXT = 'How does the fibonacci function avoid using recursion?';

const MODEL_SETUP_TIMEOUT_MS = 300_000;
const REAL_INFERENCE_TIMEOUT_MS = 180_000;

// ── Shared pipeline state, built once in `before` ──────────────────────────

let workDir;
let lancedbDir;
let blobDir;
let vectorStore;
let crossEncoder;
let claimVerifier;
let blobStore;

/** Every chunk produced from the fixture repo (embedded + upserted by the child process). */
let records = [];
let queryVector;

describe('substrate full pipeline (real fixture repo, dod.2)', () => {
  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sox-e2e-work-'));
    lancedbDir = mkdtempSync(join(tmpdir(), 'sox-e2e-lancedb-'));
    blobDir = mkdtempSync(join(tmpdir(), 'sox-e2e-blobstore-'));

    // ── 1-3. source-provider -> ingest -> embedding-provider, in an isolated
    // child process (see child-embed.mjs's header for why). Writes real
    // vectors into the real on-disk LanceDB at `lancedbDir`. ──────────────
    const jobPath = join(workDir, 'job.json');
    writeFileSync(
      jobPath,
      JSON.stringify({
        fixtureDir: FIXTURE_DIR,
        lancedbPath: lancedbDir,
        embedModelId: EMBED_MODEL_ID,
        embedDim: EMBED_DIM,
        queryText: QUERY_TEXT,
      }),
    );

    const stdout = execFileSync(process.execPath, [CHILD_EMBED_SCRIPT, jobPath], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: MODEL_SETUP_TIMEOUT_MS,
    });
    const resultLine = stdout.split('\n').find((line) => line.startsWith(RESULT_MARKER));
    assert.ok(resultLine, `child-embed.mjs produced no ${RESULT_MARKER} line; stdout:\n${stdout}`);
    const payload = JSON.parse(resultLine.slice(RESULT_MARKER.length));

    assert.equal(payload.dim, EMBED_DIM);
    records = payload.records;
    queryVector = new Float32Array(payload.queryVector);

    assert.ok(records.length >= 6, `expected >=6 chunks total, got ${records.length}`);
    // Sanity: both code chunkers (AST) and the doc chunker (heading) fired.
    assert.ok(records.some((r) => r.chunkerId === 'ast:treesitter:typescript'));
    assert.ok(records.some((r) => r.chunkerId === 'ast:treesitter:python'));
    assert.ok(records.some((r) => r.chunkerId === 'heading:markdown'));

    // ── 4. vector-store: reopen the same real on-disk LanceDB database ─────
    vectorStore = openLanceDbVectorStore({ lancedbPath: lancedbDir, db: undefined });
    assert.deepEqual(
      vectorStore.listSpaces().map((s) => s.modelId),
      [EMBED_MODEL_ID],
    );

    // ── 5. hybrid-search's real ONNX cross-encoder reranker ────────────────
    crossEncoder = await createCrossEncoder({ modelId: CROSS_ENCODER_MODEL_ID });
    assert.equal(crossEncoder.metadata.modelId, CROSS_ENCODER_MODEL_ID);

    // ── 6. blob-store: real on-disk content-addressable store ──────────────
    blobStore = createBlobStore({ basePath: blobDir });
    await blobStore.open();

    // ── 7. claim-verification: real ONNX NLI ───────────────────────────────
    claimVerifier = await createClaimVerifier({ modelId: NLI_MODEL_ID, modelVersion: '1' });
    assert.equal(claimVerifier.isReady, true);
  }, { timeout: MODEL_SETUP_TIMEOUT_MS });

  after(async () => {
    if (crossEncoder) await crossEncoder.dispose();
    if (claimVerifier) await claimVerifier.shutdown();
    if (blobStore) await blobStore.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (lancedbDir) rmSync(lancedbDir, { recursive: true, force: true });
    if (blobDir) rmSync(blobDir, { recursive: true, force: true });
  });

  it(
    'source-provider -> ingest -> embedding-provider -> vector-store produced ' +
      'one real embedding per chunk across code (AST) and docs (heading) chunkers',
    () => {
      const space = { modelId: EMBED_MODEL_ID, dim: EMBED_DIM };
      const everything = vectorStore.knn(queryVector, space, records.length);
      assert.equal(
        everything.length,
        records.length,
        'expected the real on-disk LanceDB table to contain exactly one vector per chunk',
      );
    },
  );

  it(
    'vector-store(LanceDB) + hybrid-search fuse real vector scores into ranked ' +
      'results, and the real ONNX cross-encoder reranks the truly relevant chunk to the top',
    async () => {
      // Real LanceDB kNN over every stored chunk.
      const space = { modelId: EMBED_MODEL_ID, dim: EMBED_DIM };
      const knnResults = vectorStore.knn(queryVector, space, records.length);
      assert.ok(knnResults.length > 0, 'LanceDB kNN returned no results');
      const vecScoreById = new Map(knnResults.map((r) => [r.id, r.score]));

      // A trivial, mechanism-agnostic textScore signal (hybrid-search's `fuse()`
      // is deliberately signal-source-agnostic — "textScore / vecScore, not
      // BM25 / cosine" — any lexical-overlap scorer is a legitimate textScore
      // producer for it to fuse against the real vector signal above).
      const queryTerms = QUERY_TEXT.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const textScoreFor = (text) => {
        const lower = text.toLowerCase();
        let hits = 0;
        for (const term of queryTerms) {
          if (term.length > 2 && lower.includes(term)) hits++;
        }
        return hits;
      };

      const candidates = records.map((r) => ({
        id: r.id,
        textScore: textScoreFor(r.text),
        vecScore: vecScoreById.get(r.id) ?? 0,
      }));

      // Real hybrid-search fusion (min_max normalize-then-combine).
      const fused = fuse(candidates, { normalizer: 'min_max' });
      assert.equal(fused.length, records.length);
      for (let i = 1; i < fused.length; i++) {
        assert.ok(
          fused[i - 1].score >= fused[i].score,
          'fuse() must return results sorted by descending score',
        );
      }

      const recordsById = new Map(records.map((r) => [r.id, r]));
      const topFused = fused.slice(0, 5);

      // Real ONNX cross-encoder rerank of the top fused candidates.
      const rerankCandidates = topFused.map((f) => ({
        id: f.id,
        text: recordsById.get(f.id).text,
      }));
      const rerankScores = await crossEncoder.rerank(QUERY_TEXT, rerankCandidates, {
        timeoutMs: REAL_INFERENCE_TIMEOUT_MS,
      });
      assert.equal(rerankScores.length, rerankCandidates.length);

      const reranked = rerankCandidates
        .map((c, i) => ({ id: c.id, text: c.text, score: rerankScores[i] }))
        .sort((a, b) => b.score - a.score);

      const winner = recordsById.get(reranked[0].id);
      assert.match(
        winner.text.toLowerCase(),
        /fibonacci/,
        `expected the top reranked result to be about fibonacci, got: ${winner.sourceUrl} / ${winner.heading ?? ''}`,
      );
      // The greeting.py chunks and the unrelated "Weather in Paris" section
      // must not out-rank the genuinely relevant chunk.
      assert.notEqual(winner.sourceUrl, 'src/greeting.py');
      assert.ok(!(winner.heading ?? '').includes('Weather'));
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'blob-store -> claim-verification: real ONNX NLI grounds a claim that is ' +
      'truly entailed by the blob-retrieved fixture source (grounded verdict)',
    async () => {
      const fiboSection = records.find((r) => (r.heading ?? '').includes('Fibonacci'));
      assert.ok(fiboSection, 'expected a README "Fibonacci" section chunk');

      const sourceBytes = new TextEncoder().encode(fiboSection.text);
      const hash = await blobStore.put(sourceBytes);
      assert.equal(hash.length, 64);

      const integrity = await blobStore.verify(hash);
      assert.equal(integrity.match, true);
      assert.equal(integrity.hash, hash);

      const retrieved = await blobStore.get(hash);
      assert.notEqual(retrieved, null);
      const retrievedText = new TextDecoder().decode(retrieved);
      assert.equal(retrievedText, fiboSection.text);

      const result = await claimVerifier.verify(
        {
          id: 'claim-grounded',
          text: 'The fibonacci function computes numbers iteratively, without using recursion.',
        },
        { id: hash, text: retrievedText },
      );

      assert.equal(result.sourceResults.length, 1);
      const [sourceResult] = result.sourceResults;
      assert.equal(sourceResult.entailment, 'entails');
      assert.ok(sourceResult.confidence > 0.5, `confidence too low: ${sourceResult.confidence}`);
      assert.ok(result.aggregateConfidence > 0.5);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'claim-verification: real ONNX NLI flags a claim that contradicts the ' +
      'blob-retrieved fixture source as NOT entailed (ungrounded verdict)',
    async () => {
      const fiboSection = records.find((r) => (r.heading ?? '').includes('Fibonacci'));
      assert.ok(fiboSection);

      const hash = await blobStore.put(new TextEncoder().encode(fiboSection.text));
      const retrieved = await blobStore.get(hash);
      const retrievedText = new TextDecoder().decode(retrieved);

      const result = await claimVerifier.verify(
        {
          id: 'claim-ungrounded',
          text: 'The fibonacci function relies on recursive function calls to compute its result.',
        },
        { id: hash, text: retrievedText },
      );

      const [sourceResult] = result.sourceResults;
      assert.notEqual(sourceResult.entailment, 'entails');
      assert.ok(
        ['contradicts', 'neutral', 'unverifiable'].includes(sourceResult.entailment),
        `unexpected entailment label: ${sourceResult.entailment}`,
      );
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});
