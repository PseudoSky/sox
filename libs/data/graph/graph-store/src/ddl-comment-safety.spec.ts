/**
 * The DDL templates in index.ts are split on the statement separator before
 * execution. A comment containing that character therefore does not stay a
 * comment — its tail becomes a phantom statement and every openDb() against a
 * fresh store dies with `failed to consume stmt: near "<word>": syntax error`.
 *
 * This is not hypothetical. It happened twice in ten minutes, 2026-08-15:
 *   1. A perf comment ended "Additive only<SEP> nothing above is dropped."
 *      -> phantom statement starting with "nothing" -> 6 memory-core tests down.
 *   2. The comment added to WARN about (1) quoted the separator character while
 *      explaining it -> broke again, differently.
 *
 * Both were invisible to typecheck and lint — the template is a valid JS string
 * either way. Only a runtime open catches it, and only against a FRESH store,
 * which is why it slipped through a green graph-store suite (139/139) while
 * memory-core was red.
 *
 * So: assert it structurally, cheaply, at the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, 'index.ts');
const SEP = String.fromCharCode(59); // the statement separator, never written literally here

describe('DDL comment safety', () => {
  it('no SQL line-comment inside a DDL template contains the statement separator', () => {
    const src = readFileSync(SRC, 'utf8');
    const offenders: string[] = [];
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith('--')) return;
      if (t.startsWith('-->')) return; // drizzle statement-breakpoint marker
      if (t.includes(SEP)) offenders.push(`${i + 1}: ${t.slice(0, 100)}`);
    });
    expect(
      offenders,
      `A SQL comment in a DDL template contains the statement separator. It will be ` +
        `split into a phantom statement and every fresh-store open will fail at runtime. ` +
        `Rewrite the comment without that character.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every DDL statement, after splitting, is either empty or starts with a SQL keyword', () => {
    // Catches the phantom-statement shape directly, not just its known cause.
    const src = readFileSync(SRC, 'utf8');
    const KEYWORDS = /^(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|PRAGMA|BEGIN|COMMIT|WITH|SELECT|VACUUM|ANALYZE|REINDEX)\b/i;
    const bad: string[] = [];
    for (const m of src.matchAll(/`([^`]*CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TABLE)[^`]*)`/gi)) {
      const body = m[1];
      if (!body) continue;
      for (const raw of body.split(SEP)) {
        const stmt = raw
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('--') && !l.startsWith('-->'))
          .join(' ')
          .trim();
        if (stmt && !KEYWORDS.test(stmt)) bad.push(stmt.slice(0, 90));
      }
    }
    expect(
      bad,
      `A DDL fragment does not start with a SQL keyword — it is almost certainly the ` +
        `tail of a comment that got split into a statement:\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});
