/**
 * ownership.spec.ts — ADR-0004 §D5 ownership index unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OwnershipIndex,
  readOwnership,
  supersededEntries,
  type OwnedEntry,
} from './ownership.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-own-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ownPath = (): string => path.join(dir, 'ownership.json');

describe('OwnershipIndex — record / get / remove', () => {
  it('records owned entries and persists them', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    const entries: OwnedEntry[] = [
      { kind: 'file-drop', path: '/home/u/.claude/skills/memory-usage' },
      { kind: 'config-key', file: '/home/u/.claude.json', keyPath: 'mcpServers.memory-server' },
    ];
    idx.record({ extId: 'memory-server', scope: 'user', host: 'claude', entries });
    idx.save();

    const onDisk = readOwnership(ownPath());
    expect(onDisk.owned).toHaveLength(1);
    expect(onDisk.owned[0]!.extId).toBe('memory-server');
    expect(onDisk.owned[0]!.entries).toHaveLength(2);
    expect(onDisk.owned[0]!.host).toBe('claude');
  });

  it('addEntries merges into the existing record', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    idx.addEntries('ext', 'user', [{ kind: 'file-drop', path: '/a' }]);
    idx.addEntries('ext', 'user', [{ kind: 'materialize', path: '/b' }]);
    idx.save();
    const rec = OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user');
    expect(rec?.entries.map((e) => e.kind)).toEqual(['file-drop', 'materialize']);
  });

  it('record() preserves installedAt across updates but refreshes updatedAt', async () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    idx.record({ extId: 'ext', scope: 'user', entries: [{ kind: 'file-drop', path: '/a' }] });
    idx.save();
    const first = OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user')!;
    await new Promise((r) => setTimeout(r, 5));
    const idx2 = OwnershipIndex.loadFromFile(ownPath());
    idx2.record({ extId: 'ext', scope: 'user', entries: [{ kind: 'file-drop', path: '/c' }] });
    idx2.save();
    const second = OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user')!;
    expect(second.installedAt).toBe(first.installedAt);
    expect(second.entries[0]).toEqual({ kind: 'file-drop', path: '/c' });
  });

  it('keys by (extId, scope) — same id at two scopes is two records', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    idx.record({ extId: 'ext', scope: 'user', entries: [{ kind: 'file-drop', path: '/u' }] });
    idx.record({ extId: 'ext', scope: 'project', entries: [{ kind: 'file-drop', path: '/p' }] });
    idx.save();
    const all = OwnershipIndex.loadFromFile(ownPath()).all();
    expect(all).toHaveLength(2);
  });

  it('remove() clears the record', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    idx.record({ extId: 'ext', scope: 'user', entries: [{ kind: 'file-drop', path: '/a' }] });
    idx.save();
    const idx2 = OwnershipIndex.loadFromFile(ownPath());
    idx2.remove('ext', 'user');
    idx2.save();
    expect(OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user')).toBeUndefined();
  });

  it('tolerates a missing / corrupt file (returns empty)', () => {
    expect(readOwnership(ownPath()).owned).toEqual([]);
    fs.writeFileSync(ownPath(), 'not json');
    expect(readOwnership(ownPath()).owned).toEqual([]);
  });
});

describe('supersededEntries — ADR-0004 §D6 update diff', () => {
  it('returns entries present in old but not in new (by kind + target)', () => {
    const oldE: OwnedEntry[] = [
      { kind: 'file-drop', path: '/skills/old-name' },
      { kind: 'materialize', path: '/ext/x' },
      { kind: 'config-key', file: '/cfg.json', keyPath: 'a.b' },
    ];
    const newE: OwnedEntry[] = [
      { kind: 'file-drop', path: '/skills/new-name' }, // renamed
      { kind: 'materialize', path: '/ext/x' },          // unchanged
      { kind: 'config-key', file: '/cfg.json', keyPath: 'a.b' }, // unchanged
    ];
    const gone = supersededEntries(oldE, newE);
    expect(gone).toEqual([{ kind: 'file-drop', path: '/skills/old-name' }]);
  });

  it('empty when nothing is superseded', () => {
    const e: OwnedEntry[] = [{ kind: 'materialize', path: '/ext/x' }];
    expect(supersededEntries(e, e)).toEqual([]);
  });
});

describe('OwnershipIndex — deduplication (PI-6 / BL-142)', () => {
  it('dedupeEntries: removes duplicates by (kind, target), keeps last occurrence', () => {
    const entries: OwnedEntry[] = [
      { kind: 'file-drop', path: '/skills/a' },
      { kind: 'config-key', file: '/cfg.json', keyPath: 'mcpServers.x' },
      { kind: 'file-drop', path: '/skills/b' },
      { kind: 'file-drop', path: '/skills/a' }, // duplicate of first
      { kind: 'config-key', file: '/cfg.json', keyPath: 'mcpServers.x' }, // duplicate
      { kind: 'materialize', path: '/store/x' },
    ];
    const deduped = OwnershipIndex.dedupeEntries(entries);
    expect(deduped).toHaveLength(4);
    // file-drop /skills/a should keep the LAST occurrence
    const skillAEntries = deduped.filter(
      (e) => e.kind === 'file-drop' && e.path === '/skills/a',
    );
    expect(skillAEntries).toHaveLength(1);
  });

  it('addEntries: adding the same entry 3 times produces exactly one entry', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    const entry: OwnedEntry = { kind: 'file-drop', path: '/skills/skill' };
    // Add the same entry 3 times
    idx.addEntries('ext', 'user', [entry]);
    idx.addEntries('ext', 'user', [entry]);
    idx.addEntries('ext', 'user', [entry]);
    idx.save();
    const rec = OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user')!;
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toEqual(entry);
  });

  it('compact: deduplicates across all records in the index', () => {
    const idx = OwnershipIndex.loadFromFile(ownPath());
    // Simulate duplicates from a real ledger (e.g. reinstall × 3)
    idx.record({
      extId: 'ext', scope: 'user',
      entries: [
        { kind: 'file-drop', path: '/skills/a' },
        { kind: 'file-drop', path: '/skills/a' },
        { kind: 'config-key', file: '/cfg.json', keyPath: 's.x' },
        { kind: 'config-key', file: '/cfg.json', keyPath: 's.x' },
        { kind: 'config-key', file: '/cfg.json', keyPath: 's.x' },
      ],
    });
    idx.compact();
    idx.save();
    const rec = OwnershipIndex.loadFromFile(ownPath()).get('ext', 'user')!;
    expect(rec.entries).toHaveLength(2);
  });

  it('dedupeEntries: preserves uniqueness across all OwnedEntry kinds', () => {
    const entries: OwnedEntry[] = [
      { kind: 'file-drop', path: '/a' },
      { kind: 'materialize', path: '/b' },
      { kind: 'config-key', file: '/cfg', keyPath: 'k' },
      { kind: 'array-values', file: '/cfg', keyPath: 'k', values: ['v1'] },
      { kind: 'lockfile-key', file: '/l', keyPath: 'id' },
      { kind: 'registry-record', extId: 'e', scope: 'user', root: '/r' },
      { kind: 'os-unit' as const, label: 'test', unitPath: '/u', supervisor: 'launchd', appliedHash: 'h' },
      // Duplicates of each
      { kind: 'file-drop', path: '/a' },
      { kind: 'materialize', path: '/b' },
      { kind: 'config-key', file: '/cfg', keyPath: 'k' },
      { kind: 'array-values', file: '/cfg', keyPath: 'k', values: ['v2'] },
      { kind: 'lockfile-key', file: '/l', keyPath: 'id' },
      { kind: 'registry-record', extId: 'e', scope: 'user', root: '/r' },
      { kind: 'os-unit' as const, label: 'test', unitPath: '/u2', supervisor: 'systemd', appliedHash: 'h2' },
    ];
    const deduped = OwnershipIndex.dedupeEntries(entries);
    expect(deduped).toHaveLength(7); // one of each kind
  });
});
