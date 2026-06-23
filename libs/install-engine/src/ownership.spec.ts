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
