/**
 * schema-hash.spec.ts — [contract:schema-hash] (§9.5.3): a behaviour-only change
 * MUST leave the hash unchanged; an interface change MUST change it; the hash must
 * be stable across key ordering and across the { tools } / bare-array shapes.
 */
import { describe, it, expect } from 'vitest';
import { computeSchemaHash, canonicalize } from './schema-hash.js';

const toolsA = {
  tools: [
    { name: 'write', description: 'store a memory', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'recall', description: 'find memories', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ],
};

describe('computeSchemaHash', () => {
  it('is stable across object-key ordering (canonical)', () => {
    const reordered = {
      tools: [
        { inputSchema: { properties: { text: { type: 'string' } }, type: 'object' }, description: 'store a memory', name: 'write' },
        { description: 'find memories', name: 'recall', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      ],
    };
    expect(computeSchemaHash(reordered)).toBe(computeSchemaHash(toolsA));
  });

  it('accepts both { tools: [...] } and a bare array with the same hash', () => {
    expect(computeSchemaHash(toolsA.tools)).toBe(computeSchemaHash(toolsA));
  });

  it('accepts a JSON-RPC result wrapper { result: { tools } }', () => {
    expect(computeSchemaHash({ result: toolsA })).toBe(computeSchemaHash(toolsA));
  });

  it('is UNCHANGED for a behaviour-only change (same tool interface)', () => {
    // Same names + schemas; nothing in the tools/list payload differs → same hash.
    // (A behaviour change lives in the backend impl, not in tools/list.)
    const copy = JSON.parse(JSON.stringify(toolsA));
    expect(computeSchemaHash(copy)).toBe(computeSchemaHash(toolsA));
  });

  it('CHANGES when a tool is added (interface change)', () => {
    const withExtra = {
      tools: [...toolsA.tools, { name: 'forget', description: 'delete a memory', inputSchema: { type: 'object' } }],
    };
    expect(computeSchemaHash(withExtra)).not.toBe(computeSchemaHash(toolsA));
  });

  it('CHANGES when a tool input schema changes (interface change)', () => {
    const edited = JSON.parse(JSON.stringify(toolsA));
    edited.tools[0].inputSchema.properties.limit = { type: 'number' };
    expect(computeSchemaHash(edited)).not.toBe(computeSchemaHash(toolsA));
  });

  it('preserves array order (order is semantically meaningful)', () => {
    const swapped = { tools: [toolsA.tools[1], toolsA.tools[0]] };
    expect(computeSchemaHash(swapped)).not.toBe(computeSchemaHash(toolsA));
  });
});

describe('canonicalize', () => {
  it('sorts object keys recursively but preserves array order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
});
