/**
 * scripts/published-bytes-coverage.test.ts
 *
 * INVARIANT:
 *
 *   The published-bytes gate must FAIL when its verified-row count drops.
 *   A committed baseline (`registry/published-coverage.json`) records the exact
 *   set of `npm-package:` rows that must be verified against npm. Any row that
 *   disappears, or that loses its `npm-package:` locator, is a hard failure —
 *   never a silent narrowing. An empty target set is never a pass.
 *
 * WHY: `selectNpmPackageEntries` filters to `npm-package:` rows, and the gate
 * used to print "no npm-package: rows to verify" and return TRUE for an empty
 * set. A registry in which every row had been flipped to a jsdelivr locator —
 * which is exactly what an unguarded `pnpm build-index` produces — was reported
 * as a PASS. The gate narrowed its own scope to zero and called itself green,
 * which is the definition of theatre: the check most relied on during the
 * CHECKSUM MISMATCH outage would have been loudest precisely when it verified
 * nothing at all.
 *
 * Driven END-TO-END through the real CLI against fixture roots, because the
 * defect lived in the gate's control flow (an early `return true`), not in any
 * single pure function.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const realRegistry = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'registry', 'index.json'), 'utf8'),
) as Array<{ id: string; source: string; checksum: string; version?: string }>;

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pubbytes-coverage-'));
});
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Build a fixture repo root holding only registry/index.json + the baseline. */
function fixtureRoot(name: string, entries: unknown[], baseline: unknown): string {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'registry', 'index.json'), JSON.stringify(entries, null, 2));
  if (baseline !== null) {
    fs.writeFileSync(
      path.join(root, 'registry', 'published-coverage.json'),
      JSON.stringify(baseline, null, 2),
    );
  }
  return root;
}

function runGate(root: string): { status: number; out: string } {
  // spawnSync, never execFileSync: execFileSync only surfaces the child's
  // streams on FAILURE (via the thrown error), so a success-path assertion on
  // its return value reads an empty string and silently passes. Here both the
  // pass case and the fail case must be asserted on the same captured text.
  const r = spawnSync(
    'npx',
    ['tsx', 'scripts/check-registry-sync.ts', '--published-bytes-only', '--no-remote', root],
    // CI='' so the gate's "CI must verify published bytes" refusal of
    // --no-remote does not fire: these cases must fail (or pass) on COVERAGE,
    // never on network policy. Conflating the two is how this test would
    // become the very theatre it exists to prevent.
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CI: '' } },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const npmIds = realRegistry
  .filter((e) => e.source.startsWith('npm-package:'))
  .map((e) => e.id)
  .sort();
const baseline = { expectedNpmRows: npmIds.length, ids: npmIds };

describe('published-bytes coverage gate', () => {
  it('the real committed registry satisfies its own committed baseline', () => {
    const committed = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'registry', 'published-coverage.json'), 'utf8'),
    ) as { expectedNpmRows: number; ids: string[] };
    expect([...committed.ids].sort()).toEqual(npmIds);
    expect(committed.expectedNpmRows).toBe(npmIds.length);
  });

  it('a registry whose rows all match the baseline PASSES (the gate is not merely always-red)', () => {
    const root = fixtureRoot('healthy', realRegistry, baseline);
    const r = runGate(root);
    expect(r.out).toContain('published-bytes');
    expect(r.status).toBe(0);
  });

  it('a registry with EVERY row flipped to jsdelivr FAILS (it used to report "no rows to verify" and pass)', () => {
    const flipped = realRegistry.map((e) => ({
      ...e,
      source: `https://cdn.jsdelivr.net/npm/@adhd/sox-${e.id}@${e.version ?? '0.0.0'}/dist/index.js`,
    }));
    const root = fixtureRoot('all-jsdelivr', flipped, baseline);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('coverage');
  });

  it('a single dropped npm-package row FAILS and NAMES the row', () => {
    const dropped = realRegistry.filter((e) => e.id !== 'memory-server');
    const root = fixtureRoot('dropped-row', dropped, baseline);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('memory-server');
  });

  it('a NEW npm-package row FAILS until the baseline is deliberately updated', () => {
    const grown = [
      ...realRegistry,
      { id: 'brand-new-ext', source: 'npm-package:@adhd/sox-brand-new@1.0.0', checksum: `sha256:${'0'.repeat(64)}`, version: '1.0.0' },
    ];
    const root = fixtureRoot('grown', grown, baseline);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('brand-new-ext');
  });

  it('a missing baseline file FAILS rather than defaulting to "nothing expected"', () => {
    const root = fixtureRoot('no-baseline', realRegistry, null);
    const r = runGate(root);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('published-coverage.json');
  });
});
