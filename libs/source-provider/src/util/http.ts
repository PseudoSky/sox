// @adhd/sox-source-provider — shared HTTP client for the GitHub and Bitbucket
// providers. Built on `undici` (see docs/plan/source-provider/SPEC.md §14 —
// "HTTP client choice ... the spec defines the API contract, not the
// transport layer" — undici is explicitly named as an acceptable choice).
// Using undici directly (rather than @octokit/rest) also gives deterministic,
// reliable test mocking via `undici`'s `MockAgent`/`setGlobalDispatcher`,
// which intercepts at the dispatcher level rather than patching Node's
// core `http`/`https` modules (the layer tools like `nock` target — a poor
// match for undici-backed `fetch`/`request` calls on modern Node).

import { request as undiciRequest, type Dispatcher } from 'undici';
import type { RetryConfig } from '../types.js';

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform an HTTP request, retrying transient failures (network errors,
 * 5xx responses) with exponential backoff up to `retry.maxRetries` times.
 * Non-5xx statuses (2xx/3xx/4xx, including 401/403/404/429) are returned
 * as-is — those carry provider-specific meaning and are interpreted by the
 * caller (GitHub/Bitbucket provider error mapping).
 */
export async function httpRequestWithRetry(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  retry: RetryConfig = {},
): Promise<HttpResult> {
  const cfg: Required<RetryConfig> = { ...DEFAULT_RETRY, ...retry };
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= cfg.maxRetries) {
    try {
      const method = (init.method ?? 'GET') as Dispatcher.HttpMethod;
      const res = await undiciRequest(url, {
        method,
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      const text = await res.body.text();

      if (res.statusCode >= 500 && attempt < cfg.maxRetries) {
        attempt++;
        await sleep(Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs));
        continue;
      }

      return {
        statusCode: res.statusCode,
        headers: res.headers as Record<string, string | string[] | undefined>,
        text,
      };
    } catch (err) {
      lastErr = err;
      if (attempt >= cfg.maxRetries) break;
      attempt++;
      await sleep(Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Read a header value that undici may represent as `string | string[] | undefined`. */
export function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
