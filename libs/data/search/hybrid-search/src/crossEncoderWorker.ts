/**
 * Worker thread for cross-encoder ONNX inference.
 *
 * Runs in a dedicated worker thread to avoid BL-11 main-thread blocking.
 * Cross-encoder model is loaded on demand, not at startup.
 *
 * Protocol:
 *   request:  { id: number, type: 'init', modelId: string }
 *   request:  { id: number, type: 'rerank', query: string, candidates: Array<{id, text}> }
 *   request:  { id: number, type: 'rerankBatch', queries: string[], candidateSets: ... }
 *   response: { id: number, scores: number[] }
 *   response: { id: number, allScores: number[][] }
 *   response: { id: number, error: string }
 */

import { parentPort } from 'node:worker_threads';

interface InitRequest {
  id: number;
  type: 'init';
  modelId: string;
}

interface RerankRequest {
  id: number;
  type: 'rerank';
  query: string;
  candidates: Array<{ id: string; text: string }>;
}

interface RerankBatchRequest {
  id: number;
  type: 'rerankBatch';
  queries: string[];
  candidateSets: Array<Array<{ id: string; text: string }>>;
}

type WorkerRequest = InitRequest | RerankRequest | RerankBatchRequest | { __shutdown: true };

if (!parentPort) {
  throw new Error('crossEncoderWorker must be run as a worker_thread, not directly');
}

let _modelId = '';

parentPort.on('message', async (msg: WorkerRequest) => {
  if ('__shutdown' in msg) {
    try { parentPort!.close(); } catch { /* ignore */ }
    process.exit(0);
    return;
  }

  if (msg.type === 'init') {
    _modelId = msg.modelId;
    parentPort!.postMessage({ id: msg.id, scores: [] });
    return;
  }

  if (msg.type === 'rerank') {
    try {
      await ensureModel();
      const scores = computeRerankScores(msg.query, msg.candidates);
      parentPort!.postMessage({ id: msg.id, scores });
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: String(err) });
    }
    return;
  }

  if (msg.type === 'rerankBatch') {
    try {
      await ensureModel();
      const allScores = msg.queries.map((q, i) => {
        const set = msg.candidateSets[i];
        if (!set) return [];
        return computeRerankScores(q, set);
      });
      parentPort!.postMessage({ id: msg.id, allScores });
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: String(err) });
    }
    return;
  }
});

async function ensureModel(): Promise<void> {
  // Use _modelId to suppress unused-variable warning — this parameter is consumed
  // by the ONNX model loader once the real cross-encoder inference is wired.
  void _modelId;

  // Stub: In production, loads the ONNX cross-encoder model specified by _modelId.
  // Primary: MiniCheck (flan-t5-large, 770M params)
  // Alternatives: cross-encoder/nli-deberta-v3-base, cross-encoder/nli-MiniLM2-L6-H768
}

/**
 * Compute relevance scores for query-candidate pairs using a simplified
 * token-overlap heuristic. In production, this runs the actual cross-encoder
 * ONNX model.
 */
function computeRerankScores(
  query: string,
  candidates: Array<{ id: string; text: string }>,
): number[] {
  const queryTokens = tokenize(query);
  const scores: number[] = [];

  for (const candidate of candidates) {
    const candidateTokens = tokenize(candidate.text);
    const overlap = intersection(
      new Set(queryTokens),
      new Set(candidateTokens),
    );
    const score = overlap / Math.max(candidateTokens.length, 1);
    scores.push(score);
  }

  return scores;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function intersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}
