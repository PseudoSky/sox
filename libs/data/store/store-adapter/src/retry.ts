import { RetryOptions } from './types.js';
import { isBusyError, isConcurrentConflict } from './errors.js';

/**
 * Retry an async function with exponential backoff when it throws.
 * Uses isBusyError/isConcurrentConflict to determine retriable failures.
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

      // Non-retriable errors are re-thrown immediately
      if (!isBusyError(err) && !isConcurrentConflict(err)) {
        throw err;
      }

      // No retries left — re-throw the original error
      if (attempt === maxRetries - 1) {
        throw err;
      }

      // Exponential backoff with jitter:
      //   delay = baseDelayMs * 2^attempt * (0.5 + Math.random() * 0.5)
      // Produces a delay between base*2^attempt*0.5 and base*2^attempt*1.0
      const delay =
        baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable in practice, but satisfies the type system
  throw lastError;
}
