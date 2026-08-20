/**
 * restart-dedup.bug-sox-upgrade-restarts-same-service-repeatedly-001.spec.ts
 *
 * Regression gate for BUG-SOX-UPGRADE-RESTARTS-SAME-SERVICE-REPEATEDLY-001.
 *
 * `soxe upgrade --all` enumerated the rolling-restart worklist once per
 * install-registry consumer ROW (extId × scope × root) rather than once per
 * distinct managed unit. Measured: a single pass restarted memory-server FIVE
 * times because it appeared as five separate rows (different scopes/roots)
 * that all resolved to the SAME underlying proxy-mode backend, keyed on
 * `(id, canonical-store-resource)` — never on scope. Each cycle was a real
 * unload / verified-stop / SIGTERM / respawn / re-enable of the one live
 * process.
 *
 * `dedupeRestartRows` (apps/sox/src/restart-dedup.ts) is the fix: group the
 * worklist by the caller-resolved restart-target identity BEFORE the rolling
 * restart loop executes, and restart each distinct target exactly once. This
 * spec asserts:
 *
 *   1. N rows resolving to the SAME identity (the reproduced defect's shape —
 *      "the same service present under multiple scopes/hosts") collapse to
 *      exactly ONE group / ONE restart target — not N.
 *   2. Rows resolving to DIFFERENT identities are never merged (no
 *      over-merging masking a restart that should genuinely happen).
 *   3. Within a shared-identity group, the representative chosen to perform
 *      the physical restart is one that OWNS the os-unit when any row in the
 *      group does — so the re-enable step afterward has an ownership entry
 *      to restore, instead of picking a non-owning row and reporting
 *      `owned:false` after the shared unit was unloaded (the bug's second,
 *      "stranded unsupervised" symptom).
 *   4. Group/row order is preserved (first-seen), so downstream reporting
 *      stays deterministic.
 */

import { describe, expect, it } from 'vitest';
import { dedupeRestartRows, type RestartIdentity, type RestartRow } from './restart-dedup.js';

/** Simulates resolving each row's ACTUAL restart target — a proxy-mode
 * mcp-server keyed on `(id, store-resource)`, independent of scope/root. */
function makeIdentityResolver(
  storeResourceByRow: Map<string, { resource: string; ownsOsUnit: boolean }>,
): (row: RestartRow) => RestartIdentity {
  return (row: RestartRow): RestartIdentity => {
    const key = `${row.extId}|${row.scope}|${row.root}`;
    const info = storeResourceByRow.get(key);
    if (!info) throw new Error(`no fixture entry for ${key}`);
    return { identity: `${row.extId} db:${info.resource}`, ownsOsUnit: info.ownsOsUnit };
  };
}

describe('BUG-SOX-UPGRADE-RESTARTS-SAME-SERVICE-REPEATEDLY-001 — dedupeRestartRows', () => {
  it('collapses the same service present under multiple scopes/roots into exactly one restart target', () => {
    // Reproduces the measured incident: memory-server enumerated as 5
    // consumer rows across scopes/roots, all resolving to the SAME shared
    // store (~/.memory/memory.db) — i.e. the same physical backend.
    const rows: RestartRow[] = [
      { extId: 'memory-server', scope: 'user', root: '/home/nix' },
      { extId: 'memory-server', scope: 'project', root: '/repo/a' },
      { extId: 'memory-server', scope: 'project', root: '/repo/b' },
      { extId: 'memory-server', scope: 'local', root: '/repo/c' },
      { extId: 'memory-server', scope: 'org', root: '/org/root' },
    ];
    const identities = new Map<string, { resource: string; ownsOsUnit: boolean }>([
      ['memory-server|user|/home/nix', { resource: '~/.memory/memory.db', ownsOsUnit: true }],
      ['memory-server|project|/repo/a', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
      ['memory-server|project|/repo/b', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
      ['memory-server|local|/repo/c', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
      ['memory-server|org|/org/root', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
    ]);

    const groups = dedupeRestartRows(rows, makeIdentityResolver(identities));

    // THE regression assertion: 5 rows, 1 distinct restart target.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(5);
    expect(groups[0]!.rows).toEqual(rows);
  });

  it('never merges rows that resolve to genuinely different targets', () => {
    const rows: RestartRow[] = [
      { extId: 'memory-server', scope: 'user', root: '/home/nix' },
      { extId: 'tokenguard', scope: 'user', root: '/home/nix' },
      { extId: 'memory-server', scope: 'project', root: '/repo/isolated' },
    ];
    const identities = new Map<string, { resource: string; ownsOsUnit: boolean }>([
      ['memory-server|user|/home/nix', { resource: '~/.memory/memory.db', ownsOsUnit: true }],
      ['tokenguard|user|/home/nix', { resource: '~/.tokenguard/tg.db', ownsOsUnit: true }],
      // A genuinely separate memory-server pointed at its OWN isolated store —
      // must remain its own distinct restart target, not swallowed into the
      // shared-store group above.
      ['memory-server|project|/repo/isolated', { resource: '/repo/isolated/.memory/memory.db', ownsOsUnit: false }],
    ]);

    const groups = dedupeRestartRows(rows, makeIdentityResolver(identities));

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.rows.length)).toEqual([1, 1, 1]);
  });

  it('prefers an os-unit-owning row as the restart representative, fixing the stranded-unsupervised symptom', () => {
    // The bug's second symptom: whichever scope sorts LAST wins and, if it
    // owns no os-unit, reports owned:false and re-enables nothing even though
    // the shared unit (owned by a DIFFERENT row in the same group) was
    // unloaded. The representative choice must not depend on encounter order.
    const nonOwningFirst: RestartRow[] = [
      { extId: 'memory-server', scope: 'project', root: '/repo/a' }, // owns nothing
      { extId: 'memory-server', scope: 'user', root: '/home/nix' }, // owns the os-unit
    ];
    const identities = new Map<string, { resource: string; ownsOsUnit: boolean }>([
      ['memory-server|project|/repo/a', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
      ['memory-server|user|/home/nix', { resource: '~/.memory/memory.db', ownsOsUnit: true }],
    ]);

    const groups = dedupeRestartRows(nonOwningFirst, makeIdentityResolver(identities));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.representativeOwnsOsUnit).toBe(true);
    expect(groups[0]!.representative).toEqual({ extId: 'memory-server', scope: 'user', root: '/home/nix' });
  });

  it('falls back to the first-encountered row when NO row in the group owns an os-unit', () => {
    const rows: RestartRow[] = [
      { extId: 'memory-server', scope: 'project', root: '/repo/a' },
      { extId: 'memory-server', scope: 'project', root: '/repo/b' },
    ];
    const identities = new Map<string, { resource: string; ownsOsUnit: boolean }>([
      ['memory-server|project|/repo/a', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
      ['memory-server|project|/repo/b', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
    ]);

    const groups = dedupeRestartRows(rows, makeIdentityResolver(identities));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.representativeOwnsOsUnit).toBe(false);
    expect(groups[0]!.representative).toEqual(rows[0]);
  });

  it('preserves first-seen group order and within-group row order for deterministic reporting', () => {
    const rows: RestartRow[] = [
      { extId: 'tokenguard', scope: 'user', root: '/home/nix' },
      { extId: 'memory-server', scope: 'user', root: '/home/nix' },
      { extId: 'tokenguard', scope: 'project', root: '/repo/a' },
      { extId: 'memory-server', scope: 'project', root: '/repo/a' },
    ];
    const identities = new Map<string, { resource: string; ownsOsUnit: boolean }>([
      ['tokenguard|user|/home/nix', { resource: '~/.tokenguard/tg.db', ownsOsUnit: true }],
      ['memory-server|user|/home/nix', { resource: '~/.memory/memory.db', ownsOsUnit: true }],
      ['tokenguard|project|/repo/a', { resource: '~/.tokenguard/tg.db', ownsOsUnit: false }],
      ['memory-server|project|/repo/a', { resource: '~/.memory/memory.db', ownsOsUnit: false }],
    ]);

    const groups = dedupeRestartRows(rows, makeIdentityResolver(identities));

    expect(groups.map((g) => g.identity)).toEqual([
      'tokenguard db:~/.tokenguard/tg.db',
      'memory-server db:~/.memory/memory.db',
    ]);
    expect(groups[0]!.rows).toEqual([rows[0], rows[2]]);
    expect(groups[1]!.rows).toEqual([rows[1], rows[3]]);
  });

  it('an empty worklist produces zero groups', () => {
    const groups = dedupeRestartRows([], () => {
      throw new Error('resolveIdentity should never be called for an empty worklist');
    });
    expect(groups).toEqual([]);
  });
});
