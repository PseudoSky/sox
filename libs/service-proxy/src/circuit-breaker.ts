/**
 * circuit-breaker.ts — a small, pure circuit-breaker state machine with an
 * injectable clock and an optional consumer-supplied persistence seam.
 *
 * States (derived from `BreakerState`, never stored as a label):
 *   closed     openedAt === null
 *   open       openedAt set and `cooldownMs` has not yet elapsed
 *   half-open  cooldown elapsed: exactly ONE caller is handed `probe: true`;
 *              every other caller stays open until that probe records a result.
 *              A probe that never reports back expires after `cooldownMs`, so a
 *              dead prober cannot wedge a store shared between processes.
 *
 * Modes:
 *   consecutive (default)  the breaker opens after `failureThreshold` failures
 *                          in a row; any success resets the count.
 *   window (`windowMs`)    the breaker opens after `failureThreshold` failures
 *                          within `windowMs`; older failures are dropped.
 *
 * Parity: with `{ failureThreshold: 3, cooldownMs: 10_000 }` and no window the
 * closed/open decisions are those of the embedding funnel client's per-process
 * breaker (embedding-provider `funnelClient.ts`: ENSURE_FAILURE_THRESHOLD = 3
 * at :58, ENSURE_CIRCUIT_COOLDOWN_MS = 10_000 at :59; fail-fast guard :382-387;
 * success reset :535; failure count + open at :571-576): the count survives the
 * cooldown, so a failure after the cooldown re-opens immediately with a fresh
 * cooldown, and a success resets everything.
 *
 * Leaf rule: node builtins only (here: none). No fs, net, child_process, env,
 * timers or process listeners. The default store is in-memory; persistence is
 * the consumer's (`BreakerStore`), and store I/O is best-effort: a throwing
 * store degrades to in-memory state and reports `store-failed`.
 */

export interface BreakerState {
  /** Consecutive failures since the last success. */
  consecutive: number;
  /** Failure timestamps (ms) inside the window; only populated in window mode. */
  recent: number[];
  /** When the breaker last opened (ms), or null while closed. */
  openedAt: number | null;
  /** When the current half-open probe was handed out (ms), or null. */
  probeStartedAt: number | null;
}

/** Synchronous, tiny, consumer-supplied persistence. May be shared between processes. */
export interface BreakerStore {
  load(): BreakerState | null;
  save(state: BreakerState): void;
}

export type BreakerEvent =
  | { type: 'opened'; retryAfterMs: number }
  | { type: 'half-open' }
  | { type: 'closed' }
  | { type: 'store-failed'; error: unknown };

export interface CircuitBreakerOptions {
  /** Failures (consecutive, or within `windowMs`) that open the breaker. Default 3. */
  failureThreshold?: number;
  /** How long the breaker stays open before a probe is allowed. Default 30_000. */
  cooldownMs?: number;
  /** Omitted = count CONSECUTIVE failures. Set = count failures within this window. */
  windowMs?: number;
  /** Clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Persistence. Default in-memory. */
  store?: BreakerStore;
  /** Observability. A throwing listener is ignored. */
  onEvent?: (event: BreakerEvent) => void;
}

export type BreakerCheck = { open: false; probe?: true } | { open: true; retryAfterMs: number };

export interface CircuitBreaker {
  /** Decide whether the guarded operation may run now. */
  check(): BreakerCheck;
  /** Report that the guarded operation succeeded (closes the breaker, resets counts). */
  recordSuccess(): void;
  /** Report that the guarded operation failed (may open, or re-open after a probe). */
  recordFailure(): void;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

function freshState(): BreakerState {
  return { consecutive: 0, recent: [], openedAt: null, probeStartedAt: null };
}

function cloneState(s: BreakerState): BreakerState {
  return {
    consecutive: s.consecutive,
    recent: s.recent.slice(),
    openedAt: s.openedAt,
    probeStartedAt: s.probeStartedAt,
  };
}

/** Accept only a well-formed persisted state; anything else is treated as absent. */
function sanitize(raw: unknown): BreakerState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<BreakerState>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const numOrNull = (v: unknown): v is number | null => v === null || num(v);
  if (!num(r.consecutive) || !Array.isArray(r.recent) || !r.recent.every(num)) return null;
  if (!numOrNull(r.openedAt) || !numOrNull(r.probeStartedAt)) return null;
  return { consecutive: r.consecutive, recent: r.recent.slice(), openedAt: r.openedAt, probeStartedAt: r.probeStartedAt };
}

export function createCircuitBreaker(o: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = o.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = o.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const windowMs = o.windowMs;
  const now = o.now ?? Date.now;
  const store = o.store;

  /** Authoritative fallback: always mirrors the last state this breaker saw or wrote. */
  let memory: BreakerState = freshState();

  const emit = (e: BreakerEvent): void => {
    try {
      o.onEvent?.(e);
    } catch {
      /* observability must never break the guarded path */
    }
  };

  const load = (): BreakerState => {
    if (!store) return cloneState(memory);
    try {
      const loaded = sanitize(store.load());
      if (loaded) {
        memory = loaded;
        return cloneState(loaded);
      }
    } catch (error) {
      emit({ type: 'store-failed', error });
    }
    return cloneState(memory);
  };

  const save = (s: BreakerState): void => {
    memory = cloneState(s);
    if (!store) return;
    try {
      store.save(cloneState(s));
    } catch (error) {
      emit({ type: 'store-failed', error });
    }
  };

  const open = (s: BreakerState, t: number): void => {
    s.openedAt = t;
    s.probeStartedAt = null;
    emit({ type: 'opened', retryAfterMs: cooldownMs });
  };

  return {
    check(): BreakerCheck {
      const s = load();
      if (s.openedAt === null) return { open: false };
      const t = now();
      const sinceOpen = t - s.openedAt;
      // Clock moved backwards: treat as freshly opened rather than going negative.
      if (sinceOpen < 0) return { open: true, retryAfterMs: cooldownMs };
      if (sinceOpen < cooldownMs) return { open: true, retryAfterMs: cooldownMs - sinceOpen };
      // Cooldown elapsed: half-open. One live probe at a time.
      if (s.probeStartedAt !== null) {
        const sinceProbe = t - s.probeStartedAt;
        if (sinceProbe >= 0 && sinceProbe < cooldownMs) {
          return { open: true, retryAfterMs: cooldownMs - sinceProbe };
        }
      }
      s.probeStartedAt = t;
      save(s);
      emit({ type: 'half-open' });
      return { open: false, probe: true };
    },

    recordSuccess(): void {
      const s = load();
      const wasOpen = s.openedAt !== null;
      save(freshState());
      if (wasOpen) emit({ type: 'closed' });
    },

    recordFailure(): void {
      const s = load();
      const t = now();

      if (s.openedAt !== null) {
        const sinceOpen = t - s.openedAt;
        const coolingDown = sinceOpen >= 0 && sinceOpen < cooldownMs;
        // A stray failure during an active cooldown (no probe out) changes nothing:
        // the cooldown is not extended by callers that ignored the open breaker.
        if (coolingDown && s.probeStartedAt === null) return;
        // Failed probe (or failure after the cooldown): re-open with a fresh cooldown.
        s.consecutive += 1;
        if (windowMs !== undefined) s.recent = s.recent.filter((f) => t - f < windowMs).concat(t);
        open(s, t);
        save(s);
        return;
      }

      s.consecutive += 1;
      let tripped: boolean;
      if (windowMs !== undefined) {
        s.recent = s.recent.filter((f) => t - f < windowMs && t - f >= 0).concat(t);
        tripped = s.recent.length >= failureThreshold;
      } else {
        tripped = s.consecutive >= failureThreshold;
      }
      if (tripped) open(s, t);
      save(s);
    },
  };
}
