/**
 * sse.spec.ts — SSE delta reassembly + detokenization invariants
 *
 * Covers:
 *   - a placeholder split across two streaming deltas reassembles + reverses correctly
 *     (vs naive flat replacement which would miss split tokens)
 *   - thinking_delta / signature_delta pass through byte-identical
 *   - non-SSE body falls back to flat detokenizeText
 */

import { describe, it, expect } from 'vitest';
import {
  Mapper,
  detokenizeSse,
  detokenizeSseWithMapper,
} from '../src/index';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSseEvent(data: Record<string, unknown>): string {
  return `event: ${data['type']}\ndata: ${JSON.stringify(data)}`;
}

function buildSseBody(events: Array<Record<string, unknown>>): string {
  return events.map(makeSseEvent).join('\n\n') + '\n\n';
}

// ── split-token reassembly ────────────────────────────────────────────────────

describe('SSE split-token reassembly', () => {
  it('reverses a token split across two text_delta events correctly', () => {
    const m = new Mapper();
    const tok = m.getOrCreate('vulntarget.internal', 'host', 'seed'); // <HOST_1>

    // Simulate the token being split: delta 1 = "<HOS", delta 2 = "T_1>"
    const split1 = tok.slice(0, 4);   // "<HOS"
    const split2 = tok.slice(4);       // "T_1>"

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Found host: ${split1}` } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${split2} is the target.` } },
      { type: 'content_block_stop', index: 0 },
    ];

    const raw = buildSseBody(events);
    const result = detokenizeSseWithMapper(raw, m, null);

    // The real must be present in the output
    expect(result).toContain('vulntarget.internal');
    // The token must NOT appear in the output (fully resolved)
    expect(result).not.toContain(tok);
  });

  // NEGATIVE CONTROL: naive flat replacement on the raw body would NOT find <HOST_1>
  // because it's split. This test proves split reassembly is necessary.
  it('[neg-ctrl] naive flat string replace FAILS for split tokens (proving reassembly is needed)', () => {
    const m = new Mapper();
    const tok = m.getOrCreate('vulntarget.internal', 'host', 'seed');

    const split1 = tok.slice(0, 4);
    const split2 = tok.slice(4);

    // Build a raw SSE body where the token is split
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Found: ${split1}` } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${split2} done.` } },
      { type: 'content_block_stop', index: 0 },
    ];
    const raw = buildSseBody(events);

    // Naive flat replacement: replace full token in the raw bytes
    const naiveResult = raw.split(tok).join('vulntarget.internal');

    // Token was split, so naive replacement finds NOTHING to replace
    // → 'vulntarget.internal' still absent in naive result
    expect(naiveResult).not.toContain('vulntarget.internal');
    // (This proves the SSE reassembly path adds real value.)
  });

  it('correctly handles a token that spans three deltas', () => {
    const m = new Mapper();
    // Use a longer label so we can make 3 meaningful splits
    const tok = m.getOrCreate('testhost.corp.internal', 'host', 'seed'); // <HOST_1>
    // tok = '<HOST_1>' → split into 3 parts
    const p1 = tok.slice(0, 2);   // '<H'
    const p2 = tok.slice(2, 5);   // 'OST'
    const p3 = tok.slice(5);       // '_1>'

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p1 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p2 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p3 } },
      { type: 'content_block_stop', index: 0 },
    ];

    const raw = buildSseBody(events);
    const result = detokenizeSseWithMapper(raw, m, null);
    expect(result).toContain('testhost.corp.internal');
    expect(result).not.toContain(tok);
  });
});

// ── thinking/signature passthrough ───────────────────────────────────────────

describe('SSE thinking/signature delta passthrough', () => {
  it('thinking_delta events pass through byte-identical', () => {
    const m = new Mapper();
    m.getOrCreate('sensitive.internal', 'host', 'seed');

    const thinkingText = 'Thinking about sensitive.internal in depth';

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingText } },
      { type: 'content_block_stop', index: 0 },
    ];

    const raw = buildSseBody(events);
    const result = detokenizeSseWithMapper(raw, m, null);

    // The thinking event must be in the output verbatim (not reassembled or altered)
    // — sensitive.internal is NOT a token yet in the response (it's in thinking),
    //   and thinking_delta events pass through unchanged.
    expect(result).toContain('thinking_delta');
    expect(result).toContain(thinkingText);
  });

  it('signature_delta events pass through byte-identical', () => {
    const m = new Mapper();
    const sigPayload = 'ErRj7B+AAAA=SomeBase64Signature==';
    m.getOrCreate('ErRj7B', 'id', 'seed'); // a real that appears inside sig

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sigPayload } },
      { type: 'content_block_stop', index: 0 },
    ];

    const raw = buildSseBody(events);
    const result = detokenizeSseWithMapper(raw, m, null);

    // The signature must survive byte-identical — not tokenized
    expect(result).toContain(sigPayload);
  });
});

// ── multiple blocks ───────────────────────────────────────────────────────────

describe('SSE multi-block handling', () => {
  it('correctly detokenizes two independent text blocks in one response', () => {
    const m = new Mapper();
    const tok0 = m.getOrCreate('block0-host.internal', 'host', 'seed');
    const tok1 = m.getOrCreate('block1-host.internal', 'host', 'seed');

    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `First: ${tok0}` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `Second: ${tok1}` } },
      { type: 'content_block_stop', index: 1 },
    ];

    const raw = buildSseBody(events);
    const result = detokenizeSseWithMapper(raw, m, null);

    expect(result).toContain('block0-host.internal');
    expect(result).toContain('block1-host.internal');
    expect(result).not.toContain(tok0);
    expect(result).not.toContain(tok1);
  });
});

// ── non-SSE fallback ─────────────────────────────────────────────────────────

describe('detokenizeSse — non-SSE fallback', () => {
  it('falls back to flat reversal for plain-text body without SSE structure', () => {
    const m = new Mapper();
    const tok = m.getOrCreate('plain-host.internal', 'host', 'seed');

    const plainBody = `The target is ${tok} as reported.`;
    const reverse = (s: string) => s.split(tok).join('plain-host.internal');

    const result = detokenizeSse(plainBody, reverse);
    expect(result).toContain('plain-host.internal');
    expect(result).not.toContain(tok);
  });
});
