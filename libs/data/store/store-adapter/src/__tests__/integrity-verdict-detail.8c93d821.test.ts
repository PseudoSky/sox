/**
 * 8c93d821 — an integrity verdict must never read "ok" while its detail names a
 * defect.
 *
 * memory-core's heal-churn canary printed
 *   integrity_ok=true detail=wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key
 * The row IS the documented Turso FTS false positive (`isKnownFalsePositive`,
 * upstream turso#7611) — so the verdict was right and the DETAIL was wrong: it
 * printed the raw, unfiltered row with no indication it had been filtered.
 * The prod `memory_ping` detail said "filtered 1 known Turso FTS false
 * positive" without naming which rule.
 *
 * Fix: `formatIntegrityVerdictDetail` (the one verdict-consistent detail) and
 * the `pragma_integrity_check` probe detail both label a filtered row as a known
 * false positive and cite `KNOWN_FALSE_POSITIVE_RULE_ID`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  classifyIntegrityMessages,
  formatIntegrityVerdictDetail,
  KNOWN_FALSE_POSITIVE_RULE_ID,
  probeIntegrityCheck,
} from '../integrity.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const FP = 'wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), '8c93d821-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('8c93d821 — verdict and detail agree', () => {
  it('a known-false-positive-only result: verdict ok, detail says filtered + rule id, never a bare defect row', () => {
    const c = classifyIntegrityMessages([FP]);
    expect(c.damage).toEqual([]);
    const detail = formatIntegrityVerdictDetail(c);
    expect(detail).toMatch(/^no damage/);
    expect(detail).toContain('known false positive');
    expect(detail).toContain(`rule ${KNOWN_FALSE_POSITIVE_RULE_ID}`);
    expect(detail).not.toBe(FP);
  });

  it('real damage: the detail leads with DAMAGE (verdict not ok)', () => {
    const c = classifyIntegrityMessages(['row 12 missing from index idx_node_uid', FP]);
    expect(c.damage.length).toBe(1);
    const detail = formatIntegrityVerdictDetail(c);
    expect(detail).toMatch(/^DAMAGE \(1\): row 12 missing from index idx_node_uid/);
    expect(detail).toContain(`rule ${KNOWN_FALSE_POSITIVE_RULE_ID}`);
  });

  (hasTurso ? it : it.skip)(
    'probeIntegrityCheck on a real Turso FTS store: ok verdict whose detail cites the rule it filtered under',
    async () => {
      const dbPath = join(dir, 'fts.db');
      const a = await TursoAdapterImpl.connect({ dbPath });
      try {
        await a.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
        await a.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
        await a.executeRun('INSERT INTO node (content) VALUES (?)', ['alpha beta']);
        const raw = await a.executeAll<Record<string, string>>('PRAGMA integrity_check');
        const rows = raw.rows.map((r) => Object.values(r)[0] ?? '').filter((r) => r !== 'ok');
        const [finding] = await probeIntegrityCheck(a);
        expect(finding!.status).toBe('ok');
        if (rows.some((r) => r === FP)) {
          // The engine emitted the false positive: the ok detail must name it.
          expect(finding!.detail).toContain(`rule ${KNOWN_FALSE_POSITIVE_RULE_ID}`);
        } else {
          // Engine no longer emits it (upstream fix) — nothing was filtered.
          expect(finding!.detail).toMatch(/integrity_check clean\./);
        }
      } finally {
        await a.close();
      }
    },
    60_000,
  );
});
