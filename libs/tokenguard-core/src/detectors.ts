/**
 * @sox/tokenguard-core — detector pipeline
 *
 * Ordered detector pipeline (order is load-bearing — do NOT reorder):
 *   known reals → email → fqdn → ipv6 → ipv4 → mac → phone
 *
 * Regexes ported verbatim from the Python source (re-expressed in JS RegExp syntax).
 * Optional detectors (phone, ipv6) are toggled via DetectorConfig, NOT via process.env.
 */

import type { DetectorConfig } from './types.js';

export type { DetectorConfig };
import type { Mapper } from './mapper.js';

// ── Types that are never tokenized (loopback, unspecified addresses) ────────
export const NEVER = new Set<string>(['127.0.0.1', '0.0.0.0', '::1', 'localhost']);

/**
 * Types where the real must appear as a standalone label (not as a substring
 * of a longer identifier) before it counts as a match/leak.
 */
export const BOUNDED_TYPES = new Set<string>([
  'host',
  'fqdn',
  'ip',
  'ip6',
  'mac',
  'email',
]);

// ── Detector patterns ───────────────────────────────────────────────────────

/** IPv4: \b\d{1,3}(\.\d{1,3}){3}\b */
export const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Email: no leading/trailing word+dot chars; at-sign separates local + domain. */
export const EMAIL_RE =
  /(?<![A-Za-z0-9.+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.\-])/g;

/**
 * FQDN: whole hostname incl. subdomains; left/right boundaries prevent mid-word starts.
 * The EXT_STOPLIST check (in detectFqdn) rejects file-path extensions.
 */
export const FQDN_RE =
  /(?<![A-Za-z0-9@.\-])(?:[A-Za-z0-9_\-]+\.)+[A-Za-z][A-Za-z0-9\-]*[A-Za-z0-9](?![A-Za-z0-9\-])/g;

/**
 * Comprehensive IPv6 incl. compressed :: forms and v4-mapped tails.
 * Uses a non-capturing group wrapping the alternation; captured groups are
 * not relied upon for the substitution.
 */
export const IPV6_RE = new RegExp(
  '(?<![:.\\.\\w])' +
  '(?:' +
    '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,7}:|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|' +
    '[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|' +
    ':(?::[0-9A-Fa-f]{1,4}){1,7}|' +
    '::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])|' +
    '(?:[0-9A-Fa-f]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])' +
  ')' +
  '(?![:.\\.\\w])',
  'g',
);

/** MAC address: colon- or hyphen-separated hex octets. */
export const MAC_RE =
  /(?<![A-Za-z0-9:.\-])(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}(?![A-Za-z0-9:.\-])/g;

/**
 * Phone CANDIDATE — validated in detectPhone (digit count + separator check)
 * to filter out bare integers, version strings, and IPs.
 */
export const PHONE_RE = /(?<![A-Za-z0-9.])\+?\d[\d ().\-]{6,}\d(?![A-Za-z0-9])/g;

// ── Extension stoplist (file path extensions → not FQDNs) ──────────────────
const EXT_STOPLIST = new Set([
  'json', 'jsonl', 'md', 'txt', 'log', 'py', 'sh', 'bash', 'zsh', 'yaml', 'yml',
  'conf', 'cfg', 'ini', 'toml', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'png',
  'jpg', 'jpeg', 'gif', 'svg', 'ico', 'html', 'htm', 'js', 'ts', 'jsx', 'tsx',
  'css', 'scss', 'csv', 'tsv', 'xml', 'pdf', 'sql', 'db', 'sqlite', 'lock',
  'env', 'bak', 'tmp', 'out', 'err', 'pid', 'pem', 'key', 'crt', 'go', 'rs',
  'java', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'o', 'a', 'so', 'dll', 'exe',
]);

// ── Hit-counting helper ────────────────────────────────────────────────────
type HitKey = string; // `${type}:${real}:${token}`
export type HitMap = Map<HitKey, number>;

function bump(hits: HitMap | null | undefined, type: string, real: string, token: string): void {
  if (hits == null) return;
  const key: HitKey = `${type}:${real}:${token}`;
  hits.set(key, (hits.get(key) ?? 0) + 1);
}

// ── Individual detectors ───────────────────────────────────────────────────

/**
 * Known reals, longest-first, case-insensitive, label-boundaried.
 * BOUNDED_TYPES get (?<![\\w.]) … (?![\\w.]) boundaries; all other types
 * hide everywhere (substring).
 */
export function detectKnown(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  for (const [real, tok] of mapper.realsLongestFirst()) {
    const type = mapper.typeFor(real);
    let pattern: RegExp;
    if (BOUNDED_TYPES.has(type)) {
      pattern = new RegExp(
        '(?<![\\w.])' + escapeRegex(real) + '(?![\\w.])',
        'gi',
      );
    } else {
      pattern = new RegExp(escapeRegex(real), 'gi');
    }
    s = s.replace(pattern, (_m) => {
      bump(hits, type, real, tok);
      return tok;
    });
  }
  return s;
}

export function detectEmail(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(EMAIL_RE.source, 'gi'), (m) => {
    const real = m.toLowerCase();
    if (mapper.never.has(real)) return m;
    const tok = mapper.getOrCreate(real, 'email', 'proxy');
    bump(hits, 'email', real, tok);
    return tok;
  });
}

export function detectFqdn(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(FQDN_RE.source, 'gi'), (m) => {
    const low = m.toLowerCase();
    if (NEVER.has(low) || mapper.never.has(low)) return m;
    const ext = low.split('.').pop() ?? '';
    if (EXT_STOPLIST.has(ext)) return m;
    const tok = mapper.getOrCreate(low, 'host', 'proxy');
    bump(hits, 'host', low, tok);
    return tok;
  });
}

export function detectIpv6(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(IPV6_RE.source, 'gi'), (m) => {
    const low = m.toLowerCase();
    if (NEVER.has(m) || mapper.never.has(low)) return m;
    const tok = mapper.getOrCreate(low, 'ip6', 'proxy');
    bump(hits, 'ip6', low, tok);
    return tok;
  });
}

export function detectIpv4(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(IPV4_RE.source, 'g'), (m) => {
    if (NEVER.has(m) || mapper.never.has(m)) return m;
    const tok = mapper.getOrCreate(m, 'ip', 'proxy');
    bump(hits, 'ip', m, tok);
    return tok;
  });
}

export function detectMac(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(MAC_RE.source, 'gi'), (m) => {
    const mac = m.toLowerCase();
    if (mapper.never.has(mac)) return m;
    const tok = mapper.getOrCreate(mac, 'mac', 'proxy');
    bump(hits, 'mac', mac, tok);
    return tok;
  });
}

export function detectPhone(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  return s.replace(new RegExp(PHONE_RE.source, 'g'), (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) return m;
    // check if it looks like an IPv4 address
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m)) return m;
    if (NEVER.has(m) || mapper.never.has(m)) return m;
    const hasSep = m.startsWith('+') || /[ ().\-]/.test(m);
    if (!hasSep) return m;
    const tok = mapper.getOrCreate(m, 'phone', 'proxy');
    bump(hits, 'phone', m, tok);
    return tok;
  });
}

// ── Ordered full pipeline ──────────────────────────────────────────────────

/**
 * Apply the full ordered detector pipeline to a single string.
 *
 * Order (load-bearing — do NOT reorder):
 *   known reals → email → fqdn → ipv6 → ipv4 → mac → phone
 *
 * `dynamicIp` gates all auto-detectors (email/fqdn/ip/mac/phone);
 * known reals are always applied.
 */
export function tokenizeStr(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
  dynamicIp = true,
  config: DetectorConfig = {},
): string {
  if (!s) return s;
  s = detectKnown(s, mapper, hits);
  if (dynamicIp) {
    s = detectEmail(s, mapper, hits);
    s = detectFqdn(s, mapper, hits);
    if (config.detectIpv6 !== false) {
      s = detectIpv6(s, mapper, hits);
    }
    s = detectIpv4(s, mapper, hits);
    s = detectMac(s, mapper, hits);
    if (config.detectPhone !== false) {
      s = detectPhone(s, mapper, hits);
    }
  }
  return s;
}

// ── Utility ────────────────────────────────────────────────────────────────
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
