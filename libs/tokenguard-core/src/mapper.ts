/**
 * @adhd/sox-tokenguard-core — Mapper
 *
 * Bijective real<->token store, per-type counters, origin-tagged entries.
 * Thread-safe (JS is single-threaded, but all mutations are synchronous and atomic).
 * Reload-stable: the same real maps to the same token across process restarts;
 * IDs are never reassigned.
 */

import * as fs from 'fs';
import type { MapEntry, Source, TokenMap } from './types.js';

const VALID_SOURCES = new Set<Source>(['seed', 'proxy', 'tooling', 'custom']);

/** Matches <TYPENAME_N> tokens, e.g. <HOST_3>. */
const TOKEN_RE = /^<([A-Z0-9]+)_(\d+)>$/;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Mapper {
  /** real -> MapEntry */
  private readonly byReal = new Map<string, MapEntry>();
  /** token -> MapEntry */
  private readonly byToken = new Map<string, MapEntry>();
  /** TYPE(upper) -> highest index allocated */
  private readonly counts = new Map<string, number>();
  /** Per-instance do-not-tokenize set (lower-cased). */
  readonly never = new Set<string>();

  private readonly persistPath: string | undefined;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath && fs.existsSync(persistPath)) {
      this.load(persistPath);
    }
  }

  // ── canonical insert+read API ──────────────────────────────────────────

  /**
   * Return the canonical token for `real`, allocating one if unseen.
   * Idempotent + bijective: a known real returns its existing token unchanged;
   * its source/type are NOT rewritten.
   */
  getOrCreate(real: string, type: string, source: Source): string {
    if (!VALID_SOURCES.has(source)) {
      throw new Error(`invalid source ${JSON.stringify(source)}`);
    }
    const existing = this.byReal.get(real);
    if (existing !== undefined) {
      return existing.token;
    }
    const typU = type.toUpperCase();
    const n = (this.counts.get(typU) ?? 0) + 1;
    this.counts.set(typU, n);
    const token = `<${typU}_${n}>`;
    const entry: MapEntry = { token, real, type, source, created_ts: now() };
    this.byReal.set(real, entry);
    this.byToken.set(token, entry);
    this._persist();
    return token;
  }

  /**
   * Register a real under a caller-chosen token (operator override / custom entry).
   * Honors `token` verbatim; bumps the per-type counter past it so later
   * auto-allocations never collide. If `real` is already known, returns its
   * existing token (operator override only applies on first insert).
   */
  registerExplicit(real: string, type: string, token: string, source: Source): string {
    if (!VALID_SOURCES.has(source)) {
      throw new Error(`invalid source ${JSON.stringify(source)}`);
    }
    const existing = this.byReal.get(real);
    if (existing !== undefined) {
      return existing.token;
    }
    const conflict = this.byToken.get(token);
    if (conflict !== undefined && conflict.real !== real) {
      throw new Error(`token ${JSON.stringify(token)} already maps to a different real`);
    }
    const entry: MapEntry = { token, real, type, source, created_ts: now() };
    this.byReal.set(real, entry);
    this.byToken.set(token, entry);
    this._noteIndex(token);
    this._persist();
    return token;
  }

  /**
   * Seed entries from a list of { real, type?, token? } items.
   * An explicit `token` is honored only for source='custom'; otherwise
   * the token is allocated by getOrCreate.
   * After the explicit items are seeded, identifier-group variants are derived
   * from any label-typed entries + identifier seeds and seeded as type=id.
   */
  seed(
    items: ReadonlyArray<{ real?: string; type?: string; token?: string }>,
    source: Source = 'seed',
  ): void {
    const itemList = Array.from(items);
    for (const it of itemList) {
      const r = it.real;
      const t = it.type ?? 'id';
      if (!r) continue;
      const tok = it.token;
      if (tok && source === 'custom') {
        this.registerExplicit(r, t, tok, source);
      } else {
        this.getOrCreate(r, t, source);
      }
    }

    // Derive identifier-group variants from label-type + identifier seeds.
    // Mirrors the Python identifier-variant logic in a neutral way.
    const { identifierGroupVariants } = require('./tokenize.js') as {
      identifierGroupVariants: (label: string, members: string[]) => string[];
    };

    const hosts = itemList
      .filter(it => it.type === 'host' || it.type === 'fqdn')
      .map(it => it.real!)
      .filter(Boolean);

    const labels = itemList
      .filter(it => it.type === 'label' || it.type === 'id')
      .map(it => it.real!)
      .filter(Boolean);

    for (const label of labels) {
      for (const v of identifierGroupVariants(label, hosts)) {
        if (this.never.has(v)) continue;
        this.getOrCreate(v, 'id', source);
      }
    }
  }

  // ── accessors ────────────────────────────────────────────────────────

  entries(): MapEntry[] {
    return Array.from(this.byReal.values());
  }

  tokenOf(real: string): string | undefined {
    return this.byReal.get(real)?.token;
  }

  realOf(token: string): string | undefined {
    return this.byToken.get(token)?.real;
  }

  typeFor(real: string): string {
    return this.byReal.get(real)?.type ?? 'id';
  }

  /** All (real, token) pairs sorted longest-real first. */
  realsLongestFirst(): Array<[string, string]> {
    return Array.from(this.byReal.entries())
      .map(([r, e]) => [r, e.token] as [string, string])
      .sort((a, b) => b[0].length - a[0].length);
  }

  /** All (token, real) pairs sorted longest-token first. */
  tokensLongestFirst(): Array<[string, string]> {
    return Array.from(this.byToken.entries())
      .map(([t, e]) => [t, e.real] as [string, string])
      .sort((a, b) => b[0].length - a[0].length);
  }

  // ── persistence (single v2 file, atomic) ──────────────────────────────

  /** Load a v2 token-mapping.json from disk. */
  load(filePath: string): void {
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = JSON.parse(raw) as Partial<TokenMap>;
    const entries: Partial<MapEntry>[] = Array.isArray(doc.entries) ? doc.entries : [];
    for (const e of entries) {
      const tok = e.token;
      const real = e.real;
      if (!tok || real === undefined || real === null) continue;
      const entry: MapEntry = {
        token: tok,
        real,
        type: e.type ?? 'id',
        source: (e.source ?? 'seed') as Source,
        created_ts: e.created_ts ?? now(),
      };
      this.byReal.set(real, entry);
      this.byToken.set(tok, entry);
      this._noteIndex(tok);
    }
  }

  /** Serialize the current map to a v2 token-mapping.json. */
  serialize(): TokenMap {
    return { version: 2, entries: Array.from(this.byReal.values()) };
  }

  private _noteIndex(token: string): void {
    const m = TOKEN_RE.exec(token);
    if (m) {
      const typU = m[1]!;
      const n = parseInt(m[2]!, 10);
      if (n > (this.counts.get(typU) ?? 0)) {
        this.counts.set(typU, n);
      }
    }
  }

  private _persist(): void {
    if (!this.persistPath) return;
    try {
      const doc: TokenMap = { version: 2, entries: Array.from(this.byReal.values()) };
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // best-effort — never crash on persist failure
    }
  }
}
