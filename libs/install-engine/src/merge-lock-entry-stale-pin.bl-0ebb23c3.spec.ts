/**
 * libs/install-engine/src/merge-lock-entry-stale-pin.bl-0ebb23c3.spec.ts
 *
 * BL-0ebb23c3 — `mergeLockEntry` spreads `prev` first, so when a checksum
 * changes (the artifact was rebuilt / re-materialized) the OLD `version`
 * and `registry_root` silently ride along onto the new bytes. Neither
 * caller (the materialized-store lockfile sync, the host-placement
 * lockfile sync) supplies a fresh version/registry_root of its own, so a
 * host-placement install from repo bytes ends up carrying a stale npm
 * version — producing a false 'ahead' freeze or a spurious re-pin on every
 * subsequent `soxe upgrade` run.
 */
import { describe, expect, it } from 'vitest';
import { mergeLockEntry, type LockfileEntry } from './install.js';

describe('mergeLockEntry — BL-0ebb23c3 stale version/registry_root on checksum change', () => {
  const store = '/data/ext';
  const prev: LockfileEntry = {
    source: 'file:///data/ext/x/dist/index.js',
    checksum: 'sha256:aa',
    resolved_at: 't0',
    origin: 'file:///repo/x/dist/index.js',
    version: '1.0.0',
    registry_root: '/repo/registry',
  };

  it('drops version and registry_root when the checksum changes', () => {
    const m = mergeLockEntry(prev, {
      source: prev.source,
      checksum: 'sha256:bb', // different bytes
      origin: prev.origin,
      storeRoot: store,
    });
    expect(m.checksum).toBe('sha256:bb');
    expect(m.version).toBeUndefined();
    expect(m.registry_root).toBeUndefined();
  });

  it('keeps version and registry_root when the checksum is unchanged', () => {
    const m = mergeLockEntry(prev, {
      source: prev.source,
      checksum: 'sha256:aa', // same bytes
      origin: prev.origin,
      storeRoot: store,
    });
    expect(m.version).toBe('1.0.0');
    expect(m.registry_root).toBe('/repo/registry');
  });

  it('a brand-new entry (no prev) has no version/registry_root to carry', () => {
    const m = mergeLockEntry(undefined, {
      source: 'file:///repo/y/dist/index.js',
      checksum: 'sha256:cc',
      origin: 'file:///repo/y/dist/index.js',
      storeRoot: store,
    });
    expect(m.version).toBeUndefined();
    expect(m.registry_root).toBeUndefined();
  });
});
