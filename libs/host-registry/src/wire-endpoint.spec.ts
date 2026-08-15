/**
 * libs/host-registry/src/wire-endpoint.spec.ts
 *
 * BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001 (class B): red->green coverage for
 * port validation and IPv6-safe authority formatting, both at the shared
 * wire-endpoint.ts level and through each host module's mcpConfig.value().
 *
 * The "red" half of BL-225 (run before the fix, seen to fail) is recorded in
 * the report accompanying this change rather than re-run here on every CI
 * pass — these assertions are the permanent "green" regression suite.
 */

import { describe, expect, it } from 'vitest';

import {
  WireEndpointError,
  formatAuthority,
  isIPv6Literal,
  unbracket,
  validatePort,
} from './wire-endpoint.js';
import { claudeHost } from './claude.js';
import { codexHost } from './codex.js';
import { opencodeHost } from './opencode.js';

// ─── validatePort ───────────────────────────────────────────────────────────

describe('wire-endpoint.validatePort', () => {
  it('accepts a valid integer port', () => {
    expect(validatePort(3099, 'http_port')).toBe(3099);
  });

  it('accepts the boundary values 1 and 65535', () => {
    expect(validatePort(1, 'http_port')).toBe(1);
    expect(validatePort(65535, 'http_port')).toBe(65535);
  });

  it('accepts a numeric string (hand-edited config file)', () => {
    expect(validatePort('3099', 'http_port')).toBe(3099);
  });

  it('rejects 0 (below range)', () => {
    expect(() => validatePort(0, 'http_port')).toThrow(WireEndpointError);
    expect(() => validatePort(0, 'http_port')).toThrow(/http_port/);
  });

  it('rejects 65536 (above range)', () => {
    expect(() => validatePort(65536, 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects a negative port', () => {
    expect(() => validatePort(-1, 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects a non-integer (float) port', () => {
    expect(() => validatePort(3099.5, 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects NaN', () => {
    expect(() => validatePort(Number.NaN, 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects a non-numeric string', () => {
    expect(() => validatePort('not-a-port', 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects an empty string', () => {
    expect(() => validatePort('', 'http_port')).toThrow(WireEndpointError);
  });

  it('rejects null/undefined/object', () => {
    expect(() => validatePort(null, 'http_port')).toThrow(WireEndpointError);
    expect(() => validatePort(undefined, 'http_port')).toThrow(WireEndpointError);
    expect(() => validatePort({}, 'http_port')).toThrow(WireEndpointError);
  });

  it('names the offending config key in the error message', () => {
    expect(() => validatePort('garbage', 'bind_address')).toThrow(/bind_address/);
    try {
      validatePort(99999, 'http_port');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('http_port');
      expect((e as Error).message).toContain('99999');
    }
  });
});

// ─── isIPv6Literal / unbracket ──────────────────────────────────────────────

describe('wire-endpoint.isIPv6Literal / unbracket', () => {
  it('detects a bare IPv6 literal', () => {
    expect(isIPv6Literal('::1')).toBe(true);
    expect(isIPv6Literal('fe80::1')).toBe(true);
  });

  it('detects a bracketed IPv6 literal', () => {
    expect(isIPv6Literal('[::1]')).toBe(true);
  });

  it('does not flag an IPv4 literal or hostname', () => {
    expect(isIPv6Literal('127.0.0.1')).toBe(false);
    expect(isIPv6Literal('0.0.0.0')).toBe(false);
    expect(isIPv6Literal('localhost')).toBe(false);
    expect(isIPv6Literal('example.com')).toBe(false);
  });

  it('unbracket strips wrapping brackets, idempotently', () => {
    expect(unbracket('[::1]')).toBe('::1');
    expect(unbracket('::1')).toBe('::1');
    expect(unbracket(unbracket('[::1]'))).toBe('::1');
  });

  it('unbracket leaves non-bracketed input untouched', () => {
    expect(unbracket('127.0.0.1')).toBe('127.0.0.1');
  });
});

// ─── formatAuthority — the IPv6 round-trip (item requirement #3) ───────────

describe('wire-endpoint.formatAuthority', () => {
  it('formats a bare IPv6 literal with brackets: [::1]:8080', () => {
    expect(formatAuthority('::1', 8080)).toBe('[::1]:8080');
  });

  it('does not double-bracket an already-bracketed IPv6 literal', () => {
    expect(formatAuthority('[::1]', 8080)).toBe('[::1]:8080');
  });

  it('formats a non-loopback IPv6 literal (the sharp edge naive split(":") breaks on)', () => {
    // A naive `addr.split(':')` on this address yields 5 garbage segments —
    // it does NOT recover "fe80::abcd:1234" and "8080" as two fields.
    expect(formatAuthority('fe80::abcd:1234', 8080)).toBe('[fe80::abcd:1234]:8080');
  });

  it('formats an IPv4 control with no brackets', () => {
    expect(formatAuthority('127.0.0.1', 8080)).toBe('127.0.0.1:8080');
  });

  it('formats a hostname with no brackets', () => {
    expect(formatAuthority('localhost', 8080)).toBe('localhost:8080');
  });
});

// ─── Integration: each host module's mcpConfig.value() ─────────────────────
// Item requirement #3: "IPv6 endpoints round-trip through parse and format.
// Tests MUST include [::1]:8080, bare ::1, and an IPv4 control."

describe('claude.ts mcpConfig.value — port/IPv6 validation (BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001)', () => {
  const mcpConfig = claudeHost.surfaces['mcp-server']!.mcpConfig!;

  it('rejects an out-of-range port, naming http_port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', 70000)).toThrow(/http_port/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', Number.NaN)).toThrow(/http_port/);
  });

  it('round-trips bare ::1 (non-default port, so it is not collapsed to "localhost")', () => {
    // ::1 IS the loopback special-case here (matches pre-fix behaviour of
    // displaying it as "localhost" for readability) — assert that mapping
    // explicitly, then assert a non-loopback IPv6 literal is bracketed.
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '::1') as { url: string };
    expect(val.url).toBe('http://localhost:8080/mcp');
  });

  it('brackets a non-loopback IPv6 bind address: [fe80::1]:8080', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, 'fe80::1') as { url: string };
    expect(val.url).toBe('http://[fe80::1]:8080/mcp');
  });

  it('accepts an already-bracketed IPv6 literal without double-bracketing', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '[fe80::1]') as { url: string };
    expect(val.url).toBe('http://[fe80::1]:8080/mcp');
  });

  it('IPv4 control round-trips unbracketed', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '0.0.0.0') as { url: string };
    expect(val.url).toBe('http://0.0.0.0:8080/mcp');
  });
});

describe('codex.ts mcpConfig.value — port/IPv6 validation (BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001)', () => {
  const mcpConfig = codexHost.surfaces['mcp-server']!.mcpConfig!;

  it('rejects an out-of-range port, naming http_port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', 0)).toThrow(/http_port/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', Number.NaN)).toThrow(/http_port/);
  });

  it('brackets bare ::1 -> [::1]:8080 (codex does not localhost-alias loopback)', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '::1') as { url: string };
    expect(val.url).toBe('http://[::1]:8080/mcp');
  });

  it('brackets a non-loopback IPv6 bind address', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, 'fe80::1') as { url: string };
    expect(val.url).toBe('http://[fe80::1]:8080/mcp');
  });

  it('IPv4 control round-trips unbracketed', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '127.0.0.1') as { url: string };
    expect(val.url).toBe('http://127.0.0.1:8080/mcp');
  });
});

describe('opencode.ts mcpConfig.value — port/IPv6 validation (BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001)', () => {
  const mcpConfig = opencodeHost.surfaces['mcp-server']!.mcpConfig!;

  it('rejects an out-of-range port, naming http_port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', -1)).toThrow(/http_port/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => mcpConfig.value('http', 'soxe', 'memory-server', Number.NaN)).toThrow(/http_port/);
  });

  it('does not throw for an invalid port on the stdio profile (validation is scoped to remote)', () => {
    expect(() => mcpConfig.value('stdio', 'soxe', 'memory-server', Number.NaN)).not.toThrow();
  });

  it('round-trips bare ::1 as localhost (pre-existing loopback display behaviour)', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '::1') as { url: string };
    expect(val.url).toBe('http://localhost:8080/sse');
  });

  it('brackets a non-loopback IPv6 bind address: [::1]:8080 for a non-default port control', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, 'fe80::1') as { url: string };
    expect(val.url).toBe('http://[fe80::1]:8080/sse');
  });

  it('IPv4 control round-trips unbracketed', () => {
    const val = mcpConfig.value('http', 'soxe', 'memory-server', 8080, '0.0.0.0') as { url: string };
    expect(val.url).toBe('http://0.0.0.0:8080/sse');
  });
});
