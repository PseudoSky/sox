/**
 * BL-62027a66 — the FTS liveness probe must not condemn a healthy index whose
 * rows hold letter+digit tokens.
 *
 * Tantivy tokenizes alphanumeric runs: `epsilon3` is ONE token, so
 * `fts_match('epsilon')` returns 0 rows while `fts_match('epsilon3')` returns 1
 * (Turso 0.7.1 and 0.7.2). `pickSentinelTokens` used letter-only lookarounds
 * and picked `epsilon` out of `epsilon3`, so a row whose three longest letter
 * runs were all digit-suffixed read as unindexed → `fts_index_live: damaged`
 * → the open-time repair DROPped and re-CREATEd the index on EVERY open, and on
 * Turso each DROP orphans the old btree (a full index copy leaked per open).
 *
 * The corpus below is shaped to hit exactly that: per row, three long
 * digit-suffixed words (the old picker's top three candidates, all misses) and
 * one shorter pure word that is a real token.
 *
 * RED (fix disabled — letter-only lookarounds): the probe reports `damaged`,
 * reopens emit `repaired` for the FTS index, and `page_count` grows per open.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { pickSentinelTokens, setIntegrityReportSink, verifyStoreIntegrity } from '../integrity.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[BL-62027a66 test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-62027a66-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const LONG = ['thermometer', 'anniversary', 'microscopes', 'lighthouses', 'strawberry', 'volleyballs'];
const SHORT = ['garden', 'window', 'pencil', 'bottle'];
function doc(i: number): string {
  const a = LONG[i % LONG.length]!;
  const b = LONG[(i + 1) % LONG.length]!;
  const c = LONG[(i + 2) % LONG.length]!;
  return `${a}${i} ${b}${i + 7} ${c}${i + 13} ${SHORT[i % SHORT.length]!}`;
}

describe('BL-62027a66 — sentinel tokens are whole ALPHANUMERIC tokens', () => {
  it('never yields the letter prefix of a letter+digit token', () => {
    expect(pickSentinelTokens('epsilon3 zeta7 gamma12', 3)).toEqual([]);
    expect(pickSentinelTokens('thermometer42 garden', 3)).toEqual(['garden']);
    expect(pickSentinelTokens('3epsilon alphabet', 3)).toEqual(['alphabet']);
    // Unicode letters are alphanumeric to the tokenizer too.
    expect(pickSentinelTokens('résumés window', 3)).toEqual(['window']);
    // Unchanged behaviour for plain words (BL-374).
    expect(pickSentinelTokens('the quick brown hippopotamus jumped', 1)).toEqual(['hippopotamus']);
  });
});

tursoDescribe('BL-62027a66 — no false damaged verdict, no DROP on reopen', () => {
  it('a healthy alphanumeric-token FTS index verifies ok and survives reopens untouched', async () => {
    const dbPath = join(tmpDir, `alnum-${Date.now()}.db`);
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    for (let i = 1; i <= 200; i++) {
      await seed.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [i, doc(i)]);
    }
    await seed.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
    // Negative control on the premise: the digit-suffixed token IS indexed
    // whole, and its letter prefix is NOT a token.
    const whole = await seed.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE id = 1 AND fts_match(content, ?)`,
      [`${LONG[1]!}1`],
    );
    const prefix = await seed.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE id = 1 AND fts_match(content, ?)`,
      [LONG[1]!],
    );
    expect(Number(whole?.c)).toBe(1);
    expect(Number(prefix?.c)).toBe(0);

    const report = await verifyStoreIntegrity(seed, { only: ['fts_index_live'] });
    const fts = report.findings.filter((f) => f.probe === 'fts_index_live');
    expect(fts.length).toBeGreaterThan(0);
    expect(report.damaged, JSON.stringify(report.damaged)).toEqual([]);
    expect(fts.every((f) => f.status === 'ok' && f.probeValidated)).toBe(true);
    await seed.close();

    const events: { event: string; detail: string }[] = [];
    setIntegrityReportSink((event, detail) => events.push({ event, detail }));
    const pageCounts: number[] = [];
    try {
      for (let r = 0; r < 3; r++) {
        const a = await TursoAdapterImpl.connect({ dbPath });
        try {
          const pc = await a.executeGet<Record<string, unknown>>('PRAGMA page_count');
          pageCounts.push(Number(Object.values(pc ?? {})[0]));
        } finally {
          await a.close();
        }
      }
    } finally {
      setIntegrityReportSink(null);
    }
    const ftsEvents = events.filter(
      (e) => (e.event === 'damaged' || e.event === 'repaired' || e.event === 'repair_failed') && /idx_fts_node/.test(e.detail),
    );
    expect(ftsEvents, JSON.stringify(ftsEvents)).toEqual([]);
    expect(new Set(pageCounts).size, `page_count per reopen: ${pageCounts.join(', ')}`).toBe(1);
  }, 120_000);
});
