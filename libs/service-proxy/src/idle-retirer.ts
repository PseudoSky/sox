/**
 * Work-driven idle retirer (plan 8468f7b1, Feature C; ADR-0022).
 *
 * A long-lived host retires itself `idleWindowMs` after its last completed
 * real work. The rule from ADR-0022 is reflected in the API SHAPE:
 *
 *   Connections, presence and health probes never keep a host alive. Only
 *   activity does. Presence may RELEASE a host; it can never PIN one.
 *
 * Consequently no option, method or input in this module accepts a connection,
 * client, session, socket or presence value, and unknown option keys are rejected
 * by the type checker. This is a guard-rail, not a proof: `isBusy` is a caller
 * supplied predicate and the module cannot see what it reads, so a host that
 * derives `isBusy` from presence can still pin itself (documented in the README).
 * The only inputs that can defer retirement are:
 *   - `touch()`          a caller reports real work happened;
 *   - `work(fn)`         wraps real work; the host is busy while `fn` is pending
 *                        and the work counts as done when `fn` settles;
 *   - `isBusy()`         a synchronous caller-supplied predicate over WORK state
 *                        (for example "the browser this host supervises is
 *                        still reachable"), never over who is connected.
 *
 * Pure and injectable: the clock (`now`) and the timer (`setTimer`) are
 * options. No signal handlers, no `process.exit`, no environment reads.
 * The module imports nothing.
 */

/** One ordered step of the retire sequence. */
export interface RetireStep {
  readonly name: string;
  run(): void | Promise<void>;
}

export type IdleRetirerEvent =
  | { type: 'armed'; dueInMs: number }
  | { type: 'fired'; reason: 'idle' }
  | { type: 'retire-begin'; reason: string }
  | { type: 'retire-step-failed'; step: string; error: unknown }
  | { type: 'retired'; reason: string; durationMs: number };

/** Minimal timer handle. `unref` lets the process exit; `clear` cancels. */
export interface IdleRetirerTimer {
  unref(): void;
  clear(): void;
}

export interface IdleRetirerOptions {
  /** Idle window W in ms. Required: there is deliberately no default. */
  idleWindowMs: number;
  /** Ordered retire steps. Every step runs even if an earlier one throws. */
  steps: readonly RetireStep[];
  /**
   * Synchronous predicate over WORK state. While it returns true the host is
   * busy and never fires. Must not be derived from connection or presence.
   */
  isBusy?: () => boolean;
  onEvent?: (e: IdleRetirerEvent) => void;
  /** Injectable clock, ms. Default `Date.now`. */
  now?: () => number;
  /** Injectable timer. Default wraps `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => IdleRetirerTimer;
  /**
   * Per-step timeout for the retire sequence, ms. Default: none (a step runs until it settles,
   * exactly as before). When set, a step that has not settled after this long is reported as a
   * `retire-step-failed` event (with a timeout Error) and the sequence moves on to the next step;
   * the abandoned step keeps running in the background. Must be a positive finite number.
   */
  retireStepTimeoutMs?: number;
}

export interface IdleRetirer {
  /** Report real work: the only way (with `work` settle) to move the deadline. */
  touch(): void;
  /** Run `fn` as work: busy while pending; bumps the deadline on resolve AND reject. */
  work<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Start the unref'd idle timer. Idempotent. Retirement never happens unarmed. */
  arm(): void;
  /** Retire now. Idempotent: every call returns the same completion promise. */
  retire(reason: string): Promise<void>;
  readonly state: 'running' | 'retiring' | 'retired';
  /** Ms until the idle deadline, or null while busy / retiring / retired. */
  dueInMs(): number | null;
}

export interface IdleDueInput {
  busy: boolean;
  retiring: boolean;
  lastWorkAt: number;
  now: number;
  idleWindowMs: number;
}

/**
 * Pure deadline arithmetic. `null` when busy or retiring (nothing is due),
 * otherwise the non-negative ms remaining until `lastWorkAt + idleWindowMs`.
 */
export function idleDueInMs(i: IdleDueInput): number | null {
  if (i.busy || i.retiring) return null;
  return Math.max(0, i.lastWorkAt + i.idleWindowMs - i.now);
}

/**
 * Longest delay a Node timer accepts (larger values are clamped to 1 ms and would spin).
 * Used for the hold-open timer, and as the ceiling of every scheduled idle delay: a longer
 * remainder is armed in MAX_TIMER_MS slices and re-evaluated on each fire.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

function defaultSetTimer(fn: () => void, ms: number): IdleRetirerTimer {
  const handle = setTimeout(fn, ms);
  return {
    unref: () => {
      handle.unref();
    },
    clear: () => clearTimeout(handle),
  };
}

export function createIdleRetirer(o: IdleRetirerOptions): IdleRetirer {
  if (!Number.isFinite(o.idleWindowMs) || o.idleWindowMs <= 0) {
    throw new RangeError(`idleWindowMs must be a positive finite number, got ${String(o.idleWindowMs)}`);
  }
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? defaultSetTimer;
  const window = o.idleWindowMs;
  const stepTimeoutMs = o.retireStepTimeoutMs;
  if (stepTimeoutMs !== undefined && (!Number.isFinite(stepTimeoutMs) || stepTimeoutMs <= 0)) {
    throw new RangeError(`retireStepTimeoutMs must be a positive finite number, got ${String(stepTimeoutMs)}`);
  }

  let state: 'running' | 'retiring' | 'retired' = 'running';
  let lastWorkAt = now();
  let inFlight = 0;
  let timer: IdleRetirerTimer | null = null;
  let retirement: Promise<void> | null = null;

  const emit = (e: IdleRetirerEvent): void => {
    try {
      o.onEvent?.(e);
    } catch {
      // Observers must never break the lifecycle.
    }
  };

  const busy = (): boolean => {
    if (inFlight > 0) return true;
    try {
      return o.isBusy?.() === true;
    } catch {
      // A throwing predicate is treated as busy: never retire on a guess.
      return true;
    }
  };

  const due = (): number | null =>
    idleDueInMs({ busy: busy(), retiring: state !== 'running', lastWorkAt, now: now(), idleWindowMs: window });

  const schedule = (): void => {
    if (state !== 'running') return;
    // Busy => nothing is due; poll again after one window. Not busy => the exact remainder.
    const delay = due() ?? window;
    // Windows beyond the timer ceiling are armed in slices; onTimer re-evaluates on each fire.
    const t = setTimer(onTimer, Math.min(delay, MAX_TIMER_MS));
    t.unref();
    timer = t;
    emit({ type: 'armed', dueInMs: delay });
  };

  // Re-evaluates and re-arms WITHOUT writing lastWorkAt (livelock guard):
  // only touch() and work() settle may move the deadline.
  function onTimer(): void {
    timer = null;
    if (state !== 'running') return;
    if (due() === 0) {
      emit({ type: 'fired', reason: 'idle' });
      void retire('idle');
      return;
    }
    schedule();
  }

  const runStep = async (step: RetireStep): Promise<void> => {
    if (stepTimeoutMs === undefined) {
      await step.run();
      return;
    }
    let guard: IdleRetirerTimer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      guard = setTimer(
        () => reject(new Error(`retire step "${step.name}" timed out after ${String(stepTimeoutMs)}ms`)),
        Math.min(stepTimeoutMs, MAX_TIMER_MS),
      );
    });
    try {
      await Promise.race([Promise.resolve().then(() => step.run()), timeout]);
    } finally {
      guard?.clear();
    }
  };

  function retire(reason: string): Promise<void> {
    if (retirement) return retirement;
    state = 'retiring';
    timer?.clear();
    timer = null;
    const startedAt = now();
    emit({ type: 'retire-begin', reason });
    // Ref'd (never unref'd) so the loop stays open until the last step ends.
    const hold = setTimer(() => {}, MAX_TIMER_MS);
    retirement = (async () => {
      try {
        for (const step of o.steps) {
          try {
            await runStep(step);
          } catch (error) {
            emit({ type: 'retire-step-failed', step: step.name, error });
          }
        }
      } finally {
        hold.clear();
        state = 'retired';
        emit({ type: 'retired', reason, durationMs: Math.max(0, now() - startedAt) });
      }
    })();
    return retirement;
  }

  return {
    touch(): void {
      lastWorkAt = now();
    },
    async work<T>(fn: () => Promise<T> | T): Promise<T> {
      inFlight += 1;
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        lastWorkAt = now();
      }
    },
    arm(): void {
      if (state !== 'running' || timer) return;
      schedule();
    },
    retire,
    get state() {
      return state;
    },
    dueInMs: due,
  };
}
