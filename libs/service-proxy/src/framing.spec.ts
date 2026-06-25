/**
 * framing.spec.ts — length-prefixed frame codec correctness.
 */
import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, HEADER_BYTES, MAX_FRAME_BYTES } from './framing.js';

describe('encodeFrame', () => {
  it('prefixes a 4-byte big-endian length header', () => {
    const frame = encodeFrame({ a: 1 });
    const body = JSON.stringify({ a: 1 });
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(frame.subarray(HEADER_BYTES).toString('utf8')).toBe(body);
  });

  it('rejects a payload over MAX_FRAME_BYTES', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(huge)).toThrow(/exceeds max/);
  });
});

describe('FrameDecoder', () => {
  it('decodes a single whole frame', () => {
    const out: unknown[] = [];
    const dec = new FrameDecoder((m) => out.push(m), () => { throw new Error('unexpected'); });
    dec.push(encodeFrame({ hello: 'world' }));
    expect(out).toEqual([{ hello: 'world' }]);
  });

  it('reassembles a frame split across many chunks (one byte at a time)', () => {
    const out: unknown[] = [];
    const dec = new FrameDecoder((m) => out.push(m), () => { throw new Error('unexpected'); });
    const frame = encodeFrame({ method: 'tools/call', params: { x: [1, 2, 3] } });
    for (const byte of frame) dec.push(Buffer.from([byte]));
    expect(out).toEqual([{ method: 'tools/call', params: { x: [1, 2, 3] } }]);
  });

  it('decodes multiple frames coalesced into one chunk', () => {
    const out: unknown[] = [];
    const dec = new FrameDecoder((m) => out.push(m), () => { throw new Error('unexpected'); });
    dec.push(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 }), encodeFrame({ c: 3 })]));
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('handles a frame boundary that lands mid-header', () => {
    const out: unknown[] = [];
    const dec = new FrameDecoder((m) => out.push(m), () => { throw new Error('unexpected'); });
    const f1 = encodeFrame({ a: 1 });
    const f2 = encodeFrame({ b: 2 });
    const combined = Buffer.concat([f1, f2]);
    // Split 2 bytes into the second frame's header.
    const cut = f1.length + 2;
    dec.push(combined.subarray(0, cut));
    expect(out).toEqual([{ a: 1 }]);
    dec.push(combined.subarray(cut));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports an error on an oversized declared length and stops', () => {
    let err: Error | null = null;
    const dec = new FrameDecoder(() => { throw new Error('should not emit'); }, (e) => { err = e; });
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    dec.push(header);
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as Error).message).toMatch(/exceeds max/);
  });

  it('reports an error on invalid JSON in a frame', () => {
    let err: Error | null = null;
    const dec = new FrameDecoder(() => { throw new Error('should not emit'); }, (e) => { err = e; });
    const bad = Buffer.from('{not json');
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(bad.length, 0);
    dec.push(Buffer.concat([header, bad]));
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as Error).message).toMatch(/invalid JSON/);
  });
});
