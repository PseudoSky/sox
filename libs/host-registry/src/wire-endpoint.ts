/**
 * libs/host-registry/src/wire-endpoint.ts
 *
 * Shared port + bind-address validation/formatting for the `mcpConfig.value()`
 * builders in claude.ts / codex.ts / opencode.ts
 * (BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001, class B: unvalidated endpoint parsing).
 *
 * `port`/`bindAddress` reach these builders as install-engine's
 * `descriptor.resolvedConfig?.['http_port']` / `['bind_address']` — an
 * unchecked `as number | undefined` / `as string | undefined` cast off a
 * caller-supplied JSON/TOML config value
 * (libs/install-engine/src/install.ts:1705-1706, out of this item's file
 * set). The TS parameter type on `mcpConfig.value()` therefore promises more
 * than the runtime guarantees: a hand-edited config file can put a string, a
 * float, an out-of-range number, or garbage in `http_port`, and nothing
 * between that file and this module checks it. `validatePort` is the
 * parse-site validation the signature implied but the upstream cast skipped.
 *
 * The IPv6 sharp edge: `http://${host}:${port}/...` built by naive string
 * concatenation is ambiguous the moment `host` itself contains a `:` (every
 * non-loopback-shorthand IPv6 literal does) — `fe80::1:8080` parses as
 * nothing sane. RFC 3986 §3.2.2 requires an IPv6 literal in a URL authority
 * to be bracketed (`[fe80::1]:8080`); `formatAuthority` is the one place
 * that bracketing happens so none of the three host modules can independently
 * get it half-right (the pre-fix code hard-coded a special case for the exact
 * string `'::1'` and left every other IPv6 literal — link-local, ULA,
 * non-loopback global — unbracketed and broken).
 */

export class WireEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireEndpointError';
  }
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Validate a port value sourced from config key `configKey` (e.g.
 * `"http_port"`). `raw` is treated as untrusted `unknown` regardless of its
 * declared TS type — see module docblock. Accepts a finite integer in
 * `1..65535`, or a numeric string carrying the same (a hand-edited
 * JSON/TOML config file may legally contain either). Throws
 * {@link WireEndpointError} naming `configKey` for anything else —
 * out-of-range, non-integer, NaN, non-numeric string, or the wrong type
 * entirely.
 */
export function validatePort(raw: unknown, configKey: string): number {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    n = Number(raw);
  } else {
    throw new WireEndpointError(
      `[host-registry] invalid ${configKey}: expected a port number, got ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    throw new WireEndpointError(
      `[host-registry] invalid ${configKey}: ${JSON.stringify(raw)} is not a valid port ` +
        `(must be an integer in the range ${MIN_PORT}-${MAX_PORT})`,
    );
  }
  return n;
}

/**
 * Remove a single wrapping `[...]` bracket pair, if present. Idempotent —
 * an already-bare host is returned unchanged.
 */
export function unbracket(host: string): string {
  return host.length >= 2 && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * True if `host` is an IPv6 literal — bracketed or bare — detected by the
 * presence of a `:` once any wrapping brackets are removed. Every valid
 * IPv6 literal contains at least one `:`; no valid IPv4 literal or DNS
 * hostname does, so this is unambiguous.
 */
export function isIPv6Literal(host: string): boolean {
  return unbracket(host).includes(':');
}

/**
 * Format a `host:port` authority for direct interpolation into a URL
 * template literal (`` `http://${authority}/...` ``), bracketing IPv6
 * literals per RFC 3986 §3.2.2 so a downstream `split(':')` or URL parser
 * cannot misparse the address's internal colons as the port separator.
 * IPv4 literals and hostnames pass through unchanged. Idempotent — an
 * already-bracketed host is never double-bracketed.
 */
export function formatAuthority(host: string, port: number): string {
  const bare = unbracket(host);
  const authorityHost = bare.includes(':') ? `[${bare}]` : bare;
  return `${authorityHost}:${port}`;
}
