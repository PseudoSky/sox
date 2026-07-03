/**
 * libs/mcp-runtime/src/transport.spec.ts — Multi-transport + auth middleware tests.
 *
 * Covers:
 *   TR-1: Simultaneous multi-bind (stdio + uds + http)
 *   TR-2: Bind/auth policy (validateBindAuth, authMiddleware)
 *
 * Negative control: remove requireAuth guard → test red (proves TR-2 works).
 */

import { describe, expect, it } from 'vitest';
import {
  validateBindAuth,
  authMiddleware,
  isLoopback,
  resolveBindHost,
  type TransportOptions,
} from './transport.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(authHeader?: string): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  if (authHeader) {
    req.headers['authorization'] = authHeader;
  }
  return req;
}

function makeRes(): ServerResponse {
  const socket = new Socket();
  return new ServerResponse(socket);
}

/**
 * Captured response state — wraps a ServerResponse with interceptors.
 * Access captured.status and captured.body AFTER calling authMiddleware
 * to see what was written. Do NOT destructure at capture time.
 */
interface CapturedResponse {
  res: ServerResponse;
  /** Resolved status code after middleware runs. */
  status: number;
  /** Response body string after middleware runs. */
  body: string;
}

/**
 * Collect response data from a ServerResponse.
 * Intercepts writeHead and end to capture status and body.
 * Returns a CapturedResponse with live getters — access .status and .body
 * AFTER the middleware call, not before.
 */
function captureRes(): CapturedResponse {
  let statusCode = 200;
  let responseBody = '';
  const socket = new Socket();
  const res = new ServerResponse(socket);
  res.writeHead = (s: number) => { statusCode = s; return res; };
  res.end = (data: string) => { responseBody = data; return res; };
  return {
    res,
    get status() { return statusCode; },
    get body() { return responseBody; },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('validateBindAuth (TR-2)', () => {
  it('loopback without token is OK', () => {
    const opts: TransportOptions = { host: '127.0.0.1' };
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  it('localhost without token is OK', () => {
    const opts: TransportOptions = { host: 'localhost' };
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  it('::1 without token is OK', () => {
    const opts: TransportOptions = { host: '::1' };
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  it('non-loopback (0.0.0.0) without token REFUSES', () => {
    const opts: TransportOptions = { host: '0.0.0.0' };
    expect(() => validateBindAuth(opts)).toThrow(/REFUSE TO START/);
  });

  it('non-loopback with token is OK', () => {
    const opts: TransportOptions = { host: '0.0.0.0', authToken: 's3cret' };
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  it('loopback with token is OK (token may be set for other reasons)', () => {
    const opts: TransportOptions = { host: '127.0.0.1', authToken: 'mytoken' };
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  it('bindAddress alias resolves correctly', () => {
    const opts: TransportOptions = { bindAddress: '0.0.0.0' };
    expect(() => validateBindAuth(opts)).toThrow(/REFUSE TO START/);
  });

  it('default (no host) resolves to loopback and is OK', () => {
    const opts: TransportOptions = {};
    expect(() => validateBindAuth(opts)).not.toThrow();
  });

  /**
   * NEGATIVE CONTROL: remove the auth guard → this test MUST go red.
   * If it stays green, the guard is not actually preventing the non-loopback bind.
   *
   * To verify: temporarily comment out the `throw new Error(...)` in
   * validateBindAuth() — this test should then fail (because the throw is removed).
   * Uncomment to re-green.
   */
  it('NEGATIVE CONTROL: removing guard makes 0.0.0.0 without token pass (proves guard matters)', () => {
    // This test SHOULD FAIL if we delete the throw in validateBindAuth.
    // It proves the guard is working.
    const opts: TransportOptions = { host: '0.0.0.0' };
    expect(() => validateBindAuth(opts)).toThrow(/REFUSE TO START/);
  });
});

describe('authMiddleware (TR-2)', () => {
  const expectedToken = 's3cret';

  it('missing auth header → 401', () => {
    const req = makeReq();
    const cap = captureRes();
    const ok = authMiddleware(req, cap.res as unknown as ServerResponse, expectedToken);
    expect(ok).toBe(false);
    expect(cap.status).toBe(401);
    expect(cap.body).toContain('missing authorization');
  });

  it('wrong token → 401', () => {
    const req = makeReq('Bearer wrongtoken');
    const cap = captureRes();
    const ok = authMiddleware(req, cap.res as unknown as ServerResponse, expectedToken);
    expect(ok).toBe(false);
    expect(cap.status).toBe(401);
    expect(cap.body).toContain('invalid');
  });

  it('correct token → OK (returns true)', () => {
    const req = makeReq('Bearer s3cret');
    const cap = captureRes();
    const ok = authMiddleware(req, cap.res as unknown as ServerResponse, expectedToken);
    expect(ok).toBe(true);
  });

  it('malformed auth header (no space) → 401', () => {
    const req = makeReq('Bearers3cret');
    const cap = captureRes();
    const ok = authMiddleware(req, cap.res as unknown as ServerResponse, expectedToken);
    expect(ok).toBe(false);
    expect(cap.status).toBe(401);
  });

  it('empty token in config always fails on non-empty request token', () => {
    // Even with an empty expected token, a non-empty request should fail
    const req = makeReq('Bearer somevalue');
    const cap = captureRes();
    const ok = authMiddleware(req, cap.res as unknown as ServerResponse, '');
    expect(ok).toBe(false);
    expect(cap.status).toBe(401);
  });
});

describe('resolveBindHost / isLoopback', () => {
  it('resolveBindHost defaults to 127.0.0.1', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('resolveBindHost prefers bindAddress over host', () => {
    expect(resolveBindHost({ host: '0.0.0.0', bindAddress: '::1' })).toBe('::1');
  });

  it('isLoopback true for 127.0.0.1, ::1, localhost', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('isLoopback false for 0.0.0.0, 10.x, 192.168.x, etc.', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('192.168.1.1')).toBe(false);
    expect(isLoopback('172.16.0.1')).toBe(false);
  });
});

describe('multi-bind acceptance (TR-1)', () => {
  /**
   * This test verifies the resolveTransports function returns the correct
   * set of transports for multi-bind scenarios.
   *
   * A full end-to-end test (one backend answering on all 3 transports)
   * requires sockets and async lifecycle — that is covered by the
   * integration suite. Here we verify the config plumbing.
   */
  it('resolveTransports returns array from opts.transports', async () => {
    const { resolveTransports } = await import('./transport.js');
    const modes = resolveTransports({ transports: ['stdio', 'uds', 'http'] });
    expect(modes).toEqual(['stdio', 'uds', 'http']);
  });

  it('resolveTransports falls back to single mode when transports empty', async () => {
    const { resolveTransports } = await import('./transport.js');
    const modes = resolveTransports({});
    expect(Array.isArray(modes)).toBe(true);
    expect(modes.length).toBeGreaterThanOrEqual(1);
  });

  it('ToolDispatch interface is usable at type level', async () => {
    // ToolDispatch is a TypeScript interface (erased at runtime); verify
    // a value export exists and the type shape compiles.
    const mod = await import('./transport.js');
    expect(mod).toHaveProperty('validateBindAuth');

    // Verify the type shape by creating a minimal dispatch object
    const dispatch: import('./transport.js').ToolDispatch = {
      serverInfo: { name: 'test', version: '1.0' },
      listTools: () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    const result = await dispatch.callTool('test', {});
    expect(result.content[0]!.text).toBe('ok');
  });
});
