/**
 * Unit tests for _adapter_meta infrastructure.
 *
 * Covers table creation, stamping, meta reading, change detection, and
 * resilience to missing tables.
 *
 * NOTE on MockAdapter vs. real SQLite behaviour:
 * The MockAdapter does NOT enforce PRIMARY KEY uniqueness or implement
 * INSERT OR IGNORE semantics.  The real `INSERT OR IGNORE` + `PRIMARY KEY`
 * idempotency is therefore a SQLite-level guarantee, not a mock-level one.
 * Tests verify stamp shape, read/cycle, and detection logic — the actual
 * "first writer wins" invariant should be acceptance-tested against a real
 * adapter.
 */
import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../mock-adapter.js';
import {
  ensureAdapterMetaTable,
  stampAdapterMeta,
  readAdapterMeta,
  detectAdapterChange,
  ADAPTER_META_KEYS,
} from '../adapter-meta.js';

// `stampAdapterMeta` stamps this package's OWN version — `adapter-meta.ts`
// reads it out of package.json. Read it from the same source here rather than
// hardcoding a literal, which goes red on every release bump for no reason
// other than the bump: it did exactly that when 0.1.0 became 0.1.2.
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

// ============================================================================
// 1. ensureAdapterMetaTable — table creation is idempotent
// ============================================================================

describe('ensureAdapterMetaTable', () => {
  it('creates the _adapter_meta table without error', async () => {
    const adapter = new MockAdapter();
    await expect(ensureAdapterMetaTable(adapter)).resolves.toBeUndefined();
  });

  it('is idempotent on repeated calls', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await expect(ensureAdapterMetaTable(adapter)).resolves.toBeUndefined();
  });
});

// ============================================================================
// 2. stampAdapterMeta — writes adapter metadata into the store
// ============================================================================

describe('stampAdapterMeta', () => {
  it('stamps adapter_type, adapter_version, and created_at', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');

    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_type).toBe('sqlite');
    expect(meta.adapter_version).toBe(PKG_VERSION);
    expect(meta.created_at).toBeTypeOf('string');
  });

  it('stamps turso when passed', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'turso');

    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_type).toBe('turso');
  });

  it('stamps a valid semver version', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');

    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('does not throw on re-stamp (idempotency is SQLite-level)', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');
    await expect(stampAdapterMeta(adapter, 'sqlite')).resolves.toBeUndefined();
  });

  it('skips stamping on readonly adapter', async () => {
    const adapter = new MockAdapter();
    // MockAdapter doesn't enforce readonly, but stampAdapterMeta checks config
    (adapter as any).config = { ...adapter.config, readonly: true };
    await stampAdapterMeta(adapter, 'sqlite');
    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_type).toBeNull();
  });
});

// ============================================================================
// 3. readAdapterMeta — reads back the stamped metadata
// ============================================================================

describe('readAdapterMeta', () => {
  it('returns all-null fields when the table does not exist', async () => {
    const adapter = new MockAdapter();
    const meta = await readAdapterMeta(adapter);
    expect(meta).toEqual({ adapter_type: null, adapter_version: null, created_at: null });
  });

  it('returns all-null fields when the table is empty', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    const meta = await readAdapterMeta(adapter);
    expect(meta).toEqual({ adapter_type: null, adapter_version: null, created_at: null });
  });

  it('returns adapter_type and version after stamping', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');

    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_type).toBe('sqlite');
    expect(meta.adapter_version).toBe(PKG_VERSION);
    expect(meta.created_at).not.toBeNull();

    // Verify created_at is a valid ISO timestamp
    expect(new Date(meta.created_at!).toISOString()).toBe(meta.created_at);
  });

  it('reads back turso when stamped as turso', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'turso');

    const meta = await readAdapterMeta(adapter);
    expect(meta.adapter_type).toBe('turso');
  });
});

// ============================================================================
// 4. detectAdapterChange — detects type mismatches
// ============================================================================

describe('detectAdapterChange', () => {
  it('returns false when no meta table exists (fresh store)', async () => {
    const adapter = new MockAdapter();
    const changed = await detectAdapterChange(adapter, 'sqlite');
    expect(changed).toBe(false);
  });

  it('returns false when table exists but empty', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    const changed = await detectAdapterChange(adapter, 'sqlite');
    expect(changed).toBe(false);
  });

  it('returns false when stored type matches expected type', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');
    const changed = await detectAdapterChange(adapter, 'sqlite');
    expect(changed).toBe(false);
  });

  it('returns true when stored type differs from expected type', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'sqlite');
    const changed = await detectAdapterChange(adapter, 'turso');
    expect(changed).toBe(true);
  });

  it('returns true for opposite direction (turso → sqlite)', async () => {
    const adapter = new MockAdapter();
    await ensureAdapterMetaTable(adapter);
    await stampAdapterMeta(adapter, 'turso');
    const changed = await detectAdapterChange(adapter, 'sqlite');
    expect(changed).toBe(true);
  });
});

// ============================================================================
// 5. ADAPTER_META_KEYS
// ============================================================================

describe('ADAPTER_META_KEYS', () => {
  it('defines the three expected key constants', () => {
    expect(ADAPTER_META_KEYS).toEqual({
      ADAPTER_TYPE: 'adapter_type',
      ADAPTER_VERSION: 'adapter_version',
      CREATED_AT: 'created_at',
    });
  });

  it('is frozen at runtime (Object.freeze)', () => {
    expect(Object.isFrozen(ADAPTER_META_KEYS)).toBe(true);
  });
});
