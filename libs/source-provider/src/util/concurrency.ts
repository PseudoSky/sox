// @adhd/sox-source-provider — tiny concurrency-bounded map helper.
// Used by the local provider to bound concurrent file reads/hashes
// (SPEC §7 `hashConcurrency`). Deliberately dependency-free.

/**
 * Map `items` through `fn`, running at most `concurrency` invocations of
 * `fn` in flight at any time. Preserves input order in the returned array.
 * Rejects (and stops scheduling new work) on the first `fn` rejection.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
