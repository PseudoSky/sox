/**
 * Anthropic provider adapter — request scoping + SSE reassembly + thinking passthrough.
 *
 * [shape:provider-adapter] — implements the ProviderAdapter interface.
 * [inv:wire-guarantee] — tokenizes ONLY system/messages/metadata; tools verbatim.
 * Thinking blocks are signed — never tokenized (modifying them breaks the signature).
 * Uses detokenizeSse from @adhd/sox-tokenguard-core for split-token SSE reassembly.
 *
 * [ref:c7-no-reach-in] — imports via @adhd/sox-tokenguard-core scope only.
 */

import { detokenizeSse } from '@adhd/sox-tokenguard-core';
import type { ProviderAdapter } from './generic.js';

export { type ProviderAdapter };

/**
 * Anthropic adapter: scope request to system/messages/metadata (tools verbatim);
 * reassemble SSE deltas before detokenizing so split tokens are caught.
 */
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',

  scopeRequest(body: unknown): { tokenizable: unknown; verbatim: unknown } {
    // [inv:wire-guarantee]: only tokenize the real-data-bearing fields.
    // tools, model, max_tokens, stream, etc. pass through verbatim.
    // tokenizeRequest (engine) already scopes to system/messages/metadata —
    // but here we also expose it so the proxy can reconstruct the full body
    // by merging tokenized + verbatim after the engine pass.
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const r = body as Record<string, unknown>;
      const SCOPE_KEYS = new Set(['system', 'messages', 'metadata']);
      const tokenizable: Record<string, unknown> = {};
      const verbatim: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (SCOPE_KEYS.has(k)) {
          tokenizable[k] = v;
        } else {
          verbatim[k] = v;
        }
      }
      return { tokenizable, verbatim };
    }
    // Non-object body: tokenize everything
    return { tokenizable: body, verbatim: {} };
  },

  reverseStream(raw: string, reverse: (s: string) => string): string {
    // Use the engine's SSE reassembler — handles split tokens across delta events.
    // Thinking blocks pass through verbatim (signed, must not be modified).
    return detokenizeSse(raw, reverse);
  },
};
