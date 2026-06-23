/**
 * @adhd/sox-tokenguard-core — types
 *
 * [shape:token-map] — token-mapping.json v2 — the live bijective cache
 */

/** Source of a mapping entry. */
export type Source = 'seed' | 'proxy' | 'tooling' | 'custom';

/** Canonical token type strings (non-exhaustive — custom entries may carry others). */
export type IdType =
  | 'host'
  | 'fqdn'
  | 'ip'
  | 'ip6'
  | 'mac'
  | 'email'
  | 'phone'
  | 'id'
  | string;

/** A single bijective mapping entry. */
export interface MapEntry {
  token: string;
  real: string;
  type: IdType;
  source: Source;
  created_ts: string;
}

/** The v2 token-mapping.json on-disk shape. */
export interface TokenMap {
  version: 2;
  entries: MapEntry[];
}

/** Optional detector toggle configuration (injected by service layer, not read from env). */
export interface DetectorConfig {
  detectPhone?: boolean;
  detectIpv6?: boolean;
}
