import { describe, it, expect } from 'vitest';
import { createCrossEncoder } from './cross-encoder.js';

describe('CrossEncoder', () => {
  it('createCrossEncoder returns a CrossEncoder instance', async () => {
    const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
    expect(encoder.metadata.modelId).toBe('MiniCheck');
    expect(encoder.metadata.maxTokens).toBe(512);
    await encoder.dispose();
  });

  it('rerank returns scores in same order as candidates', async () => {
    const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
    const scores = await encoder.rerank('hello world', [
      { id: '1', text: 'hello there' },
      { id: '2', text: 'goodbye world' },
      { id: '3', text: 'something else' },
    ]);
    expect(scores).toBeInstanceOf(Float32Array);
    expect(scores.length).toBe(3);
    await encoder.dispose();
  });

  it('dispose prevents further rerank calls', async () => {
    const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
    await encoder.dispose();
    await expect(encoder.rerank('test', [{ id: '1', text: 'test' }])).rejects.toThrow(
      'disposed',
    );
  });
});
