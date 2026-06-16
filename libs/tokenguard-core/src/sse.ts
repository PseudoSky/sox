/**
 * @sox/tokenguard-core — SSE delta reassembly + detokenization
 *
 * A token like <HOST_1> can be split across consecutive content_block_delta events
 * (e.g. text or tool-input streamed in fragments), so flat replacement on the raw
 * bytes misses it. This module reassembles each content block's full value from
 * its deltas, detokenizes the assembled value, and re-emits it as a single delta
 * per block — preserving every other event verbatim.
 *
 * Thinking blocks are deliberately excluded from reassembly: thinking blocks are
 * signed and never executed, so we pass them through verbatim (modifying them
 * breaks the signature → API 400). Tokens in thinking are harmless.
 */

import { detokenizeText } from './tokenize.js';
import type { Mapper } from './mapper.js';
import type { HitMap } from './detectors.js';

/**
 * Delta types we reassemble + detokenize.
 * Maps delta.type → the field name inside the delta that holds the fragment.
 *
 * thinking_delta and signature_delta are intentionally absent: pass verbatim.
 */
const DELTA_FIELD: Record<string, string> = {
  text_delta: 'text',
  input_json_delta: 'partial_json',
};

interface BlockBuffer {
  buf: string;
  field: string;
  dtype: string;
}

/**
 * Detokenize an Anthropic streaming SSE body.
 *
 * Reassembles each content block's accumulated text/partial_json across its
 * content_block_delta events, detokenizes the full assembled string, and emits
 * a single replacement delta at content_block_stop. All other events pass verbatim.
 *
 * Falls back to flat detokenizeText if the body does not look like SSE.
 *
 * @param raw     The raw SSE body string.
 * @param reverse A function mapping tokenized text → original text (i.e. detokenizeText
 *                partially applied). Accepting a function keeps this module decoupled
 *                from the mapper directly and lets callers inject custom reversal logic.
 * @param hits    Optional hit counter map (passed through to the reversal function internally).
 */
export function detokenizeSse(
  raw: string,
  reverse: (s: string) => string,
): string {
  if (!raw.includes('content_block_delta') && !raw.includes('data:')) {
    return reverse(raw);
  }

  const events = raw.split('\n\n');
  const out: string[] = [];
  const blocks = new Map<number, BlockBuffer>();

  for (const ev of events) {
    if (!ev.trim()) continue;

    let data: Record<string, unknown> | null = null;
    for (const line of ev.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          data = null;
        }
      }
    }

    if (data === null) {
      out.push(ev);
      continue;
    }

    const t = data['type'] as string | undefined;

    if (t === 'content_block_delta') {
      const idx = (data['index'] as number | undefined) ?? 0;
      const delta = (data['delta'] as Record<string, unknown> | null | undefined) ?? {};
      const dt = delta['type'] as string | undefined;
      const field = dt !== undefined ? DELTA_FIELD[dt] : undefined;

      if (field !== undefined && dt !== undefined) {
        let block = blocks.get(idx);
        if (block === undefined) {
          block = { buf: '', field, dtype: dt };
          blocks.set(idx, block);
        }
        block.dtype = dt;
        block.field = field;
        block.buf += (delta[field] as string | undefined) ?? '';
        // buffer; emit the whole block at content_block_stop
        continue;
      }

      // thinking_delta / signature_delta / other → verbatim
      out.push(ev);
      continue;
    }

    if (t === 'content_block_stop') {
      const idx = (data['index'] as number | undefined) ?? 0;
      const block = blocks.get(idx);
      if (block !== undefined && block.field) {
        const val = reverse(block.buf);
        const merged = {
          type: 'content_block_delta',
          index: idx,
          delta: { type: block.dtype, [block.field]: val },
        };
        out.push(`event: content_block_delta\ndata: ${JSON.stringify(merged)}`);
      }
      out.push(ev);
      continue;
    }

    // message_start / message_delta / message_stop / ping → verbatim
    out.push(ev);
  }

  return out.join('\n\n') + '\n\n';
}

/**
 * Convenience wrapper: detokenize an SSE body using a Mapper directly.
 */
export function detokenizeSseWithMapper(
  raw: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return detokenizeSse(raw, (s) => detokenizeText(s, mapper, hits));
}
