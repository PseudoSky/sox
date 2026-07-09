import { describe, it, expect } from 'vitest';
import { createCrossEncoder } from './cross-encoder.js';

// These tests run REAL ONNX inference (Xenova/ms-marco-MiniLM-L-6-v2, a
// sequence-classification cross-encoder converted from
// cross-encoder/ms-marco-MiniLM-L-6-v2) via the shared embedWorker in
// @adhd/sox-embedding-provider — no mocks. First run downloads and caches
// the ~23MB quantized ONNX model + tokenizer from the HuggingFace hub, so
// these are given a generous timeout.
const REAL_INFERENCE_TIMEOUT_MS = 120_000;

describe('CrossEncoder', () => {
  it(
    'createCrossEncoder returns a CrossEncoder instance',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      expect(encoder.metadata.modelId).toBe('MiniCheck');
      expect(encoder.metadata.maxTokens).toBe(512);
      await encoder.dispose();
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'rerank returns scores in same order as candidates',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      const scores = await encoder.rerank('hello world', [
        { id: '1', text: 'hello there' },
        { id: '2', text: 'goodbye world' },
        { id: '3', text: 'something else' },
      ]);
      expect(scores).toBeInstanceOf(Float32Array);
      expect(scores.length).toBe(3);
      await encoder.dispose();
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'real ONNX cross-encoder ranks a relevant passage above an irrelevant one',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      const scores = await encoder.rerank('What is the capital of France?', [
        { id: 'relevant', text: 'Paris is the capital and most populous city of France.' },
        { id: 'irrelevant', text: 'Bananas are a good source of potassium and fiber.' },
      ]);

      expect(scores.length).toBe(2);
      const [relevantScore, irrelevantScore] = scores;
      // Real model inference — not lexical overlap — must rank the true
      // answer passage strictly above the unrelated one.
      expect(relevantScore).toBeGreaterThan(irrelevantScore);
      await encoder.dispose();
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'real ONNX cross-encoder produces a stable relevance ordering across a candidate set',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      const query = 'How does photosynthesis work?';
      const candidates = [
        { id: 'best', text: 'Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen.' },
        { id: 'tangential', text: 'Plants need soil, water, and sunlight to grow into mature organisms.' },
        { id: 'unrelated', text: 'The stock market closed higher today amid strong quarterly earnings reports.' },
      ];
      const scores = await encoder.rerank(query, candidates);
      const ranked = candidates
        .map((c, i) => ({ id: c.id, score: scores[i] }))
        .sort((a, b) => b.score - a.score);

      expect(ranked[0].id).toBe('best');
      expect(ranked[ranked.length - 1].id).toBe('unrelated');
      await encoder.dispose();
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'rerankBatch scores each query against its own candidate set with real inference',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      const allScores = await encoder.rerankBatch(
        ['What is the capital of France?', 'What is the capital of Japan?'],
        [
          [
            { id: 'fr-relevant', text: 'Paris is the capital of France.' },
            { id: 'fr-irrelevant', text: 'Sharks have existed for over 400 million years.' },
          ],
          [
            { id: 'jp-relevant', text: 'Tokyo is the capital of Japan.' },
            { id: 'jp-irrelevant', text: 'Volcanoes form where tectonic plates diverge or converge.' },
          ],
        ],
      );

      expect(allScores.length).toBe(2);
      expect(allScores[0][0]).toBeGreaterThan(allScores[0][1]);
      expect(allScores[1][0]).toBeGreaterThan(allScores[1][1]);
      await encoder.dispose();
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'dispose prevents further rerank calls',
    async () => {
      const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
      await encoder.dispose();
      await expect(encoder.rerank('test', [{ id: '1', text: 'test' }])).rejects.toThrow(
        'disposed',
      );
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});
