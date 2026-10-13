/**
 * connection-tracker.spec.ts — 8468f7b1 Feature A, pure unit lane: no net, no
 * spawn, no timers. Connections are plain objects.
 */
import { describe, it, expect } from 'vitest';
import {
  createConnectionTracker,
  type ClientDisconnectReason,
  type ConnectionContext,
} from './connection-tracker.js';

function setup(overrides: { throwConnect?: boolean; throwDisconnect?: boolean } = {}) {
  const events: string[] = [];
  const diags: string[] = [];
  const tracker = createConnectionTracker<object>({
    onClientConnect: (id) => {
      events.push(`connect:${id}`);
      if (overrides.throwConnect) throw new Error('connect-boom');
    },
    onClientDisconnect: (id, reason) => {
      events.push(`disconnect:${id}:${reason}`);
      if (overrides.throwDisconnect) throw new Error('disconnect-boom');
    },
    diag: (l) => diags.push(l),
  });
  return { tracker, events, diags };
}

describe('createConnectionTracker', () => {
  it('8468f7b1 SP1: ids are stable per connection and distinct across connections', () => {
    const { tracker } = setup();
    const a = {};
    const b = {};
    const ca = tracker.connected(a);
    const cb = tracker.connected(b);
    expect(ca.connectionId).toBe('c1');
    expect(cb.connectionId).toBe('c2');
    expect(tracker.context(a)).toBe(ca); // same frozen object every time
    expect(tracker.context(a)).toBe(ca);
    expect(Object.isFrozen(ca)).toBe(true);
    expect(tracker.size).toBe(2);
  });

  it('8468f7b1 SP1: ids are never reused after a disconnect', () => {
    const { tracker } = setup();
    const a = {};
    tracker.connected(a);
    tracker.disconnected(a);
    expect(tracker.connected({}).connectionId).toBe('c2');
  });

  it('8468f7b1 SP3: abrupt destroy of one of two clients disconnects exactly that id', () => {
    const { tracker, events } = setup();
    const a = {};
    const b = {};
    tracker.connected(a);
    tracker.connected(b);
    tracker.disconnected(a);
    expect(events).toEqual(['connect:c1', 'connect:c2', 'disconnect:c1:end']);
    expect(tracker.context(a)).toBeUndefined();
    expect(tracker.context(b)?.connectionId).toBe('c2');
  });

  it('8468f7b1 SP3: disconnect fires once even if closed repeatedly', () => {
    const { tracker, events } = setup();
    const a = {};
    tracker.connected(a);
    tracker.disconnected(a);
    tracker.disconnected(a);
    expect(events.filter((e) => e.startsWith('disconnect'))).toHaveLength(1);
  });

  it.each<[string, (t: ReturnType<typeof setup>['tracker'], c: object) => void, ClientDisconnectReason]>([
    ['no mark', () => {}, 'end'],
    ['error mark', (t, c) => t.markError(c), 'error'],
    ['backend close mark', (t, c) => t.markClosingByBackend(c), 'closed-by-backend'],
    ['error then backend close: first mark wins', (t, c) => { t.markError(c); t.markClosingByBackend(c); }, 'error'],
    ['backend close then error: first mark wins', (t, c) => { t.markClosingByBackend(c); t.markError(c); }, 'closed-by-backend'],
  ])('8468f7b1 SP3: reason mapping — %s => %s', (_name, mark, reason) => {
    const { tracker, events } = setup();
    const c = {};
    tracker.connected(c);
    mark(tracker, c);
    tracker.disconnected(c);
    expect(events).toEqual(['connect:c1', `disconnect:c1:${reason}`]);
  });

  it('8468f7b1 SP3: backend close with three live connections reports each as closed-by-backend', () => {
    const { tracker, events } = setup();
    const conns = [{}, {}, {}];
    for (const c of conns) tracker.connected(c);
    for (const c of conns) tracker.markClosingByBackend(c);
    for (const c of conns) tracker.disconnected(c);
    expect(events.slice(3)).toEqual([
      'disconnect:c1:closed-by-backend',
      'disconnect:c2:closed-by-backend',
      'disconnect:c3:closed-by-backend',
    ]);
  });

  it('marks on an unknown or already-closed connection are ignored', () => {
    const { tracker } = setup();
    const ghost = {};
    expect(() => {
      tracker.markError(ghost);
      tracker.markClosingByBackend(ghost);
      tracker.disconnected(ghost);
    }).not.toThrow();
  });

  it('8468f7b1 SP5: a throwing onClientConnect is isolated, diagnosed, and the connection still tracks', () => {
    const { tracker, events, diags } = setup({ throwConnect: true });
    const a = {};
    const ctx: ConnectionContext = tracker.connected(a);
    expect(ctx.connectionId).toBe('c1');
    expect(diags).toEqual(['[service-proxy backend] onClientConnect threw: connect-boom']);
    tracker.disconnected(a);
    expect(events).toEqual(['connect:c1', 'disconnect:c1:end']); // disconnect hook still ran
  });

  it('8468f7b1 SP5: a throwing onClientDisconnect is isolated and diagnosed; later connections unaffected', () => {
    const { tracker, events, diags } = setup({ throwDisconnect: true });
    const a = {};
    tracker.connected(a);
    expect(() => tracker.disconnected(a)).not.toThrow();
    expect(diags).toEqual(['[service-proxy backend] onClientDisconnect threw: disconnect-boom']);
    const b = {};
    expect(tracker.connected(b).connectionId).toBe('c2');
    expect(events).toContain('connect:c2');
    expect(tracker.size).toBe(1);
  });

  it('works with no hooks configured', () => {
    const tracker = createConnectionTracker<object>({ diag: () => {} });
    const a = {};
    expect(tracker.connected(a).connectionId).toBe('c1');
    expect(() => tracker.disconnected(a)).not.toThrow();
  });

  it('non-Error throws are stringified in the diagnostic', () => {
    const diags: string[] = [];
    const tracker = createConnectionTracker<object>({
      onClientConnect: () => { throw 'str'; },
      diag: (l) => diags.push(l),
    });
    tracker.connected({});
    expect(diags).toEqual(['[service-proxy backend] onClientConnect threw: str']);
  });
});
