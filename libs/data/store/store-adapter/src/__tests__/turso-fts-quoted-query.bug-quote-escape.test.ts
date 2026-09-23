/**
 * BUG-STOREADAPTER-TURSO-FTS-QUOTE-ESCAPE-001 — a recall query containing
 * double quotes killed the whole BM25 arm on Turso.
 *
 * Backlog: 05eb832e-95f6-473f-bd9a-f7dc2e005726
 *
 * Production symptom (~/.adhd/sox-ecosystem/memory/logs, pid 99483,
 * 2026-09-22T19:57:59.455Z, db /Users/nix/.memory/memory.db):
 *
 *   recall.fts_failed — step failed: Internal error: FTS parse error:
 *   Syntax Error: """e68be52c""" OR "or" OR """cb47fb79""" OR ...
 *
 * Chain: `normalizeFtsTokens` whitespace-splits without stripping quotes, so
 * `"e68be52c"` stays one token WITH its quotes. `buildMatchQuery` escapes the
 * embedded quotes by doubling (SQLite FTS5 convention) and wraps → a
 * triple-quoted token. Turso's Tantivy parser has no doubled-quote escape and
 * rejects the entire match query. recall.ts's BL-391 handler catches it and
 * downgrades to an `fts:` degradation, so recall returns a normal-looking
 * payload with the BM25 channel contributing nothing.
 *
 * RED (fix deleted — `.map((t) => t.replace(/"/g, ''))` removed from
 * `normalizeFtsTokens`): ftsSearch THROWS the parse error above.
 * GREEN: ftsSearch returns the matching row.
 *
 * Detector strength: this asserts POSITIVE RETRIEVAL (the row comes back with
 * a score), not merely "did not throw" — a query that silently matched zero
 * rows for an unrelated reason would still fail this test.
 */
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { ftsSearch } from '../fts-ops.js';
import { normalizeFtsTokens } from '../fts-ops.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-quote-escape-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('BUG-STOREADAPTER-TURSO-FTS-QUOTE-ESCAPE-001', () => {
  it('strips double quotes in the SHARED tokenizer, so both engines get identical tokens', () => {
    // Parity is the reason the fix lives in normalizeFtsTokens rather than in
    // TursoFTSDialect: per-dialect quote handling would make the same caller
    // query mean different things on sqlite vs turso.
    expect(normalizeFtsTokens('"e68be52c" or "cb47fb79" review')).toEqual([
      'e68be52c',
      'or',
      'cb47fb79',
      'review',
    ]);
    // A token that is ONLY quotes must not survive as an empty token.
    expect(normalizeFtsTokens('"" alpha')).toEqual(['alpha']);
  });

  it('a quoted-term query still retrieves the row on Turso instead of throwing a parse error', async () => {
    const dbPath = path.join(tmpDir(), 'p.db');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT)');
      await adapter.executeRun('INSERT INTO node (content) VALUES (?)', [
        'review findings for e68be52c embed durability',
      ]);
      await adapter.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');

      // The verbatim production query shape: bare hashes wrapped in quotes,
      // joined by the word "or".
      const rows = await ftsSearch<{ rowid: number }>(
        adapter,
        'node',
        ['content'],
        '"e68be52c" or "cb47fb79" or "d01d181b" review findings embed durability',
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.rowid).toBe(1);
    } finally {
      await adapter.close();
    }
  });
});
