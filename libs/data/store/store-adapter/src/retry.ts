import { RetryOptions } from './types.js';
import { isBusyError, isConcurrentConflict } from './errors.js';
import { log } from '@adhd/sox-telemetry';

/**
 * Retry an async function with exponential backoff when it throws.
 * Uses isBusyError/isConcurrentConflict to determine retriable failures.
 *
 * BL-401: this is store-adapter's first consumer of `@adhd/sox-telemetry`
 * (BL-351's shared substrate). Each retry/exhaustion emits a `log.*` record;
 * `trace_id` is auto-injected from whatever ambient trace context the caller
 * is running under (`withTrace()` — memory-core's write-queue.ts wraps every
 * queued operation in one) via the substrate's ONE process-wide
 * AsyncLocalStorage instance, so a retry loop triggered by a memory-core
 * write joins the same trace as the write that provoked it, with zero
 * signature changes required here.
 *
 * @param fn        The async function to retry.
 * @param options   Optional retry config (maxRetries, baseDelayMs).
 *                  Defaults: maxRetries: 3, baseDelayMs: 10.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 10;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Non-retriable errors are re-thrown immediately
      if (!isBusyError(err) && !isConcurrentConflict(err)) {
        throw err;
      }

      // No retries left — re-throw the original error
      if (attempt === maxRetries - 1) {
        log.warn('store_adapter.retry.exhausted', {
          attempt: attempt + 1,
          max_retries: maxRetries,
          error: errorMessage,
        });
        throw err;
      }

      // Exponential backoff with jitter:
      //   delay = baseDelayMs * 2^attempt * (0.5 + Math.random() * 0.5)
      // Produces a delay between base*2^attempt*0.5 and base*2^attempt*1.0
      const delay =
        baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);

      log.debug('store_adapter.retry.attempt', {
        attempt: attempt + 1,
        max_retries: maxRetries,
        delay_ms: Math.round(delay),
        error: errorMessage,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable in practice, but satisfies the type system
  throw lastError;
}
