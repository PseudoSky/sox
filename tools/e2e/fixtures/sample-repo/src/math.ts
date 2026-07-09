/** Adds two numbers together. */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Computes the nth Fibonacci number iteratively, keeping only the previous
 * two values in memory. Avoids recursion entirely so it stays fast and
 * stack-safe even for large inputs.
 */
export function fibonacci(n: number): number {
  let prev = 0;
  let curr = 1;
  for (let i = 0; i < n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return prev;
}

/** A minimal running-total calculator. */
export class Calculator {
  private total = 0;

  add(value: number): number {
    this.total += value;
    return this.total;
  }

  reset(): void {
    this.total = 0;
  }
}
