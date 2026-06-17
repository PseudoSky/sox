/**
 * Generic provider adapter — plain JSON passthrough + whole-body reversal.
 *
 * [shape:provider-adapter] — implements the ProviderAdapter interface.
 * For non-Anthropic providers: no SSE reassembly, no request scoping.
 * Tokenizes the full request body; reverses the full response body.
 */

export interface ProviderAdapter {
  readonly name: string;
  /** Split the request body into the tokenizable region and the verbatim region. */
  scopeRequest(body: unknown): { tokenizable: unknown; verbatim: unknown };
  /** Reverse tokens in the raw response string (SSE or JSON). */
  reverseStream(raw: string, reverse: (s: string) => string): string;
}

/**
 * Generic adapter: tokenize the entire request body;
 * reverse the entire response body as a flat string.
 */
export const genericAdapter: ProviderAdapter = {
  name: 'generic',

  scopeRequest(body: unknown): { tokenizable: unknown; verbatim: unknown } {
    // For generic: tokenize everything, no verbatim region.
    return { tokenizable: body, verbatim: {} };
  },

  reverseStream(raw: string, reverse: (s: string) => string): string {
    return reverse(raw);
  },
};
