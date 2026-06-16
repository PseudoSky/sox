/**
 * @sox/tokenguard-core — tokenize / detokenize
 *
 * Exports:
 *   identifierGroupVariants  — neutral replacement for the Python identifier variant helper
 *   tokenizeStr              — re-exported from detectors (full pipeline on one string)
 *   walkTokenize             — deep-walk of a parsed-JSON value, tokenizing strings
 *   tokenizeRequest          — two-pass scoped tokenization of an API request body
 *   wireLeaks                — check for mapped reals surviving in scoped regions
 *   detokenizeText           — token → real over a flat string (longest-first)
 */

import type { Mapper } from './mapper.js';
import type { DetectorConfig, HitMap } from './detectors.js';
import { tokenizeStr, BOUNDED_TYPES, NEVER } from './detectors.js';

// ── Stoplist for identifierGroupVariants ──────────────────────────────────
const LABEL_STOPLIST = new Set([
  // generic infra subdomains / words
  'access', 'mail', 'staging', 'production', 'prod', 'portal', 'admin', 'login',
  'logout', 'test', 'testing', 'proxy', 'gateway', 'server', 'servers', 'host',
  'hosts', 'internal', 'external', 'corp', 'local', 'intranet', 'extranet',
  'public', 'private', 'secure', 'home', 'main', 'root', 'user', 'users', 'data',
  'auth', 'node', 'edge', 'origin', 'assets', 'static', 'media', 'images', 'files',
  'docs', 'help', 'support', 'status', 'health', 'metrics', 'cloud', 'online',
  'store', 'tech', 'space', 'link', 'click', 'site', 'page', 'blog', 'shop', 'team',
  'group', 'world', 'today', 'name', 'info', 'live', 'vpn', 'web', 'api', 'www',
  'app', 'dev', 'cdn', 'dns', 'smtp', 'imap', 'http', 'https', 'ftp', 'ssh',
  // common public TLDs / SLDs (4+ char; shorter caught by length gate)
  'com', 'net', 'org', 'gov', 'edu', 'mil', 'biz',
]);

/**
 * Derive hyper-specific identifier variants from a label + associated member hosts/names.
 *
 * Keeps the label and each DNS component from the members list that is specific
 * (length >= 4, not in LABEL_STOPLIST, not in NEVER). Drops generic labels
 * (access, api, www, TLDs, etc.). Returns a de-duplicated list of lower-cased strings.
 *
 * This is the neutral generalisation of the Python identifier-variant function.
 * Same algorithm; no red-team vocabulary.
 */
export function identifierGroupVariants(label: string, members: string[]): string[] {
  const out: string[] = [];

  function consider(raw: string): void {
    const l = (raw ?? '').trim().toLowerCase();
    if (l.length < 4 || LABEL_STOPLIST.has(l) || NEVER.has(l)) return;
    if (!out.includes(l)) out.push(l);
  }

  consider(label);
  for (const member of members ?? []) {
    const normalized = (member ?? '').toLowerCase().replace(/\*/g, '');
    for (const part of normalized.split('.')) {
      consider(part);
    }
  }
  return out;
}

// ── Keys whose values must never be tokenized ─────────────────────────────
/**
 * A thinking block's `signature` is a crypto signature — tokenizing it produces
 * garbage that the API rejects with a 400. `$schema` is a JSON-Schema dialect URI
 * that must stay verbatim so the API's schema validator accepts it.
 */
const SKIP_VALUE_KEYS = new Set(['signature', '$schema']);

// ── Request fields that carry real data (everything else is static schema) ─
export const REQUEST_TOKENIZE_KEYS: readonly string[] = ['system', 'messages', 'metadata'] as const;

// ── Walk + tokenize ────────────────────────────────────────────────────────

/**
 * Tokenize string values throughout a parsed-JSON structure.
 */
export function walkTokenize(
  obj: unknown,
  mapper: Mapper,
  hits?: HitMap | null,
  dynamicIp = true,
  config: DetectorConfig = {},
): unknown {
  if (typeof obj === 'string') {
    return tokenizeStr(obj, mapper, hits, dynamicIp, config);
  }
  if (Array.isArray(obj)) {
    return obj.map(x => walkTokenize(x, mapper, hits, dynamicIp, config));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = SKIP_VALUE_KEYS.has(k) ? v : walkTokenize(v, mapper, hits, dynamicIp, config);
    }
    return result;
  }
  return obj;
}

/**
 * Second-pass helper: apply only known-real detection (no dynamic FQDN/IP discovery).
 * Used after walkTokenize so that FQDNs newly added to the mapper during the first pass
 * are caught as standalone labels in subsequent strings. This is idempotent: already-
 * tokenized strings contain only token placeholders, which don't match real patterns.
 */
function walkKnown(
  obj: unknown,
  mapper: Mapper,
  hits?: HitMap | null,
): unknown {
  if (typeof obj === 'string') {
    return tokenizeStr(obj, mapper, hits, false);
  }
  if (Array.isArray(obj)) {
    return obj.map(x => walkKnown(x, mapper, hits));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = SKIP_VALUE_KEYS.has(k) ? v : walkKnown(v, mapper, hits);
    }
    return result;
  }
  return obj;
}

/**
 * Tokenize only the real-data-bearing parts of an Anthropic Messages request.
 *
 * Leaves `tools` (and any other top-level structure) verbatim so the API still
 * sees a valid JSON Schema. Falls back to a full walk for non-object bodies.
 *
 * Two-pass strategy:
 *   Pass 1 — full pipeline (known reals + dynamic FQDN/IP/MAC/email detection).
 *             Dynamic detectors add newly-seen hosts/FQDNs to the mapper.
 *   Pass 2 — known-reals only (walkKnown). Catches sub-domain apexes that were
 *             added to the mapper by pass 1's FQDN detector but may still appear
 *             standalone in later strings within the same request.
 */
export function tokenizeRequest(
  req: unknown,
  mapper: Mapper,
  hits?: HitMap | null,
  config: DetectorConfig = {},
): unknown {
  if (req !== null && typeof req === 'object' && !Array.isArray(req)) {
    const r = req as Record<string, unknown>;
    // Pass 1: full pipeline on scoped regions
    for (const k of REQUEST_TOKENIZE_KEYS) {
      if (k in r) {
        r[k] = walkTokenize(r[k], mapper, hits, true, config);
      }
    }
    // Pass 2: known-reals-only on scoped regions
    for (const k of REQUEST_TOKENIZE_KEYS) {
      if (k in r) {
        r[k] = walkKnown(r[k], mapper, hits);
      }
    }
    return r;
  }
  // Non-dict body: two-pass full walk
  const pass1 = walkTokenize(req, mapper, hits, true, config);
  return walkKnown(pass1, mapper, hits);
}

/**
 * Return mapped reals that still appear in the parts we tokenize (system/messages/
 * metadata) AFTER tokenization — the true wire-leak set.
 *
 * Scans ONLY those regions, not `tools` (static JSON-Schema left verbatim — its
 * Anthropic/MCP domains like claude.ai are not mapped reals).
 *
 * For BOUNDED_TYPES the same label-boundary rules as detectKnown are applied:
 * a bounded real only counts as a leak if it appears standalone.
 */
export function wireLeaks(req: unknown, mapper: Mapper): string[] {
  let blob: string;
  if (req !== null && typeof req === 'object' && !Array.isArray(req)) {
    const r = req as Record<string, unknown>;
    const scoped: Record<string, unknown> = {};
    for (const k of REQUEST_TOKENIZE_KEYS) {
      if (k in r) scoped[k] = r[k];
    }
    blob = JSON.stringify(scoped, safeReplacer);
  } else {
    blob = JSON.stringify(req, safeReplacer);
  }

  const leaks: string[] = [];
  for (const entry of mapper.entries()) {
    const { real, type } = entry;
    if (BOUNDED_TYPES.has(type)) {
      const pat = new RegExp('(?<![\\w.])' + escapeRegex(real) + '(?![\\w.])', 'i');
      if (pat.test(blob)) leaks.push(real);
    } else {
      if (blob.includes(real)) leaks.push(real);
    }
  }
  return leaks;
}

/**
 * Token → real over a flat string (tokens longest-first to avoid prefix overlap).
 */
export function detokenizeText(
  text: string,
  mapper: Mapper,
  hits?: HitMap | null,
): string {
  if (!text) return text;
  for (const [tok, real] of mapper.tokensLongestFirst()) {
    if (text.includes(tok)) {
      const count = countOccurrences(text, tok);
      text = text.split(tok).join(real);
      if (hits != null) {
        const type = mapper.typeFor(real);
        const key = `${type}:${real}:${tok}`;
        hits.set(key, (hits.get(key) ?? 0) + count);
      }
    }
  }
  return text;
}

// ── Utilities ──────────────────────────────────────────────────────────────
function safeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return String(value);
  return value;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// Re-export for convenience
export { tokenizeStr, BOUNDED_TYPES, NEVER } from './detectors.js';
export type { DetectorConfig, HitMap } from './detectors.js';
