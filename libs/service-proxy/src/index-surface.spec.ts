/**
 * index-surface.spec.ts — export-surface golden (8468f7b1 SP34, SP33).
 *
 * The complete 0.5.0 runtime surface must stay exported unchanged; the 0.6.0
 * additions are exactly the names listed below. Type-level checks compile under
 * `nx run service-proxy:typecheck` (a failing @ts-expect-error is a type error).
 */
import { describe, it, expect } from 'vitest';
import * as api from './index.js';
import type {
  BackendHandler,
  BreakerCheck,
  BreakerEvent,
  BreakerState,
  BreakerStore,
  CircuitBreaker,
  CircuitBreakerOptions,
  ClientDisconnectReason,
  ConnectionContext,
  EnsureBackendOptions,
  IdleDueInput,
  IdleRetirer,
  IdleRetirerEvent,
  IdleRetirerOptions,
  IdleRetirerTimer,
  ProcessIdentityDeps,
  RetireStep,
  ServeBackendOptions,
} from './index.js';

/** Every runtime export of the published 0.5.0 package (54871159 index.ts). */
const SURFACE_0_5_0 = [
  'ERR_BACKEND_UNAVAILABLE',
  'FrameDecoder',
  'HEADER_BYTES',
  'MAX_FRAME_BYTES',
  'assertPrivateSocketDir',
  'backendSocketPath',
  'canonicalize',
  'computeSchemaHash',
  'dialBackend',
  'encodeFrame',
  'ensureBackend',
  'ensurePrivateSocketDir',
  'errorResponse',
  'handshakeBackend',
  'isJsonRpcRequest',
  'isJsonRpcResponse',
  'isNotification',
  'isUdsDirUnsafeError',
  'probeSocketLive',
  'runFrontShim',
  'serveBackend',
  'tightenOwnedSocketDir',
  'udsFallbackRoot',
] as const;

/** The only runtime additions in 0.6.0. */
const ADDED_0_6_0 = [
  'createCircuitBreaker',
  'createIdleRetirer',
  'idleDueInMs',
  'isSameProcess',
  'readProcessStartToken',
] as const;

describe('index export surface', () => {
  it('8468f7b1 SP34: every 0.5.0 runtime export is still exported with the same kind', () => {
    for (const name of SURFACE_0_5_0) {
      expect(api, name).toHaveProperty(name);
      expect((api as Record<string, unknown>)[name], name).toBeDefined();
    }
    expect(typeof api.ERR_BACKEND_UNAVAILABLE).toBe('number');
    expect(typeof api.HEADER_BYTES).toBe('number');
    expect(typeof api.MAX_FRAME_BYTES).toBe('number');
    expect(typeof api.FrameDecoder).toBe('function');
    expect(typeof api.serveBackend).toBe('function');
  });

  it('8468f7b1 SP34: the runtime surface is exactly 0.5.0 plus the 0.6.0 additions', () => {
    const actual = Object.keys(api).sort();
    const expected = [...SURFACE_0_5_0, ...ADDED_0_6_0].sort();
    expect(actual).toEqual(expected);
  });

  it('8468f7b1 SP33: the new factories are functions', () => {
    for (const name of ADDED_0_6_0) {
      expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('index type surface (compile-time)', () => {
  it('8468f7b1 SP33 SP2: ConnectionContext / ClientDisconnectReason exported; one-arg handlers still type-check', () => {
    const ctx: ConnectionContext = { connectionId: 'c1' };
    const reasons: ClientDisconnectReason[] = ['end', 'error', 'closed-by-backend'];
    // @ts-expect-error - not a member of ClientDisconnectReason
    const bad: ClientDisconnectReason = 'timeout';
    void bad;
    const oneArg: BackendHandler = (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: null });
    const twoArg: BackendHandler = (req, c) => ({ jsonrpc: '2.0', id: req.id ?? null, result: c.connectionId });
    const opts: Partial<ServeBackendOptions> = {
      onClientConnect: (id: string) => void id,
      onClientDisconnect: (id: string, r: ClientDisconnectReason) => void [id, r],
    };
    expect(ctx.connectionId).toBe('c1');
    expect(reasons).toHaveLength(3);
    expect(typeof oneArg).toBe('function');
    expect(typeof twoArg).toBe('function');
    expect(opts.onClientConnect).toBeDefined();
  });

  it('8468f7b1 SP19: IdleRetirerOptions has no connection or presence parameter (unknown keys are rejected; isBusy remains a caller-supplied predicate the types cannot police)', () => {
    const steps: RetireStep[] = [{ name: 's', run: () => undefined }];
    const ok: IdleRetirerOptions = { idleWindowMs: 1000, steps };
    // @ts-expect-error - ADR-0022: connections never feed retire inputs
    const withConnections: IdleRetirerOptions = { idleWindowMs: 1000, steps, connectionCount: 3 };
    // @ts-expect-error - ADR-0022: presence never pins
    const withPresence: IdleRetirerOptions = { idleWindowMs: 1000, steps, presence: () => true };
    void withConnections;
    void withPresence;
    const input: IdleDueInput = { busy: false, retiring: false, lastWorkAt: 0, now: 0, idleWindowMs: 1 };
    const timer: IdleRetirerTimer = { unref: () => undefined, clear: () => undefined };
    const ev: IdleRetirerEvent = { type: 'fired', reason: 'idle' };
    const r: IdleRetirer | undefined = undefined;
    expect([ok.idleWindowMs, input.busy, typeof timer.clear, ev.type, r]).toEqual([1000, false, 'function', 'fired', undefined]);
  });

  it('8468f7b1 SP21: breaker types are exported and shaped as specified', () => {
    const state: BreakerState = { consecutive: 0, recent: [], openedAt: null, probeStartedAt: null };
    const store: BreakerStore = { load: () => state, save: () => undefined };
    const events: BreakerEvent[] = [
      { type: 'opened', retryAfterMs: 1 },
      { type: 'half-open' },
      { type: 'closed' },
      { type: 'store-failed', error: new Error('x') },
    ];
    const o: CircuitBreakerOptions = { failureThreshold: 3, cooldownMs: 10_000, store };
    const check: BreakerCheck = { open: true, retryAfterMs: 5 };
    const b: CircuitBreaker = api.createCircuitBreaker(o);
    expect(events).toHaveLength(4);
    expect(check.open).toBe(true);
    expect(b.check()).toEqual({ open: false });
  });

  it('8468f7b1 SP7: ProcessIdentityDeps and EnsureBackendOptions.processIdentity are exported and optional', () => {
    const deps: ProcessIdentityDeps = { pidAlive: () => true };
    const opt: Pick<EnsureBackendOptions, 'processIdentity'> = { processIdentity: deps };
    const none: Pick<EnsureBackendOptions, 'processIdentity'> = {};
    expect(opt.processIdentity).toBe(deps);
    expect(none.processIdentity).toBeUndefined();
  });
});
