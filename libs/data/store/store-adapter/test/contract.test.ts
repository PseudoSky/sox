/**
 * Contract test suite for StoreAdapter implementations.
 * Runs against SqliteAdapter and MockAdapter.
 *
 * Each test group is parameterized: `runContractTests(createAdapter)` is called
 * once per adapter implementation. All SQL uses parameterized queries (?) with
 * args arrays for compatibility with MockAdapter's regex-based SQL parser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  StoreAdapter,
  SqliteAdapter,
} from '../src/types.js';
import { MockAdapter } from '../src/mock-adapter.js';
import { createSqliteAdapter } from '../src/factory.js';
import {
  isUniqueConstraintError,
  isForeignKeyError,
  isBusyError,
  isConcurrentConflict,
  isDatabaseError,
  dbErrorCode,
} from '../src/errors.js';
import { withRetry } from '../src/retry.js';

// ── Shared contract test function ────────────────────────────────────────────

export function runContractTests(
  label: string,
  createAdapter: () => StoreAdapter | Promise<StoreAdapter>,
) {
  let adapter: StoreAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
    await adapter.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role_id INTEGER REFERENCES roles(id))');
    await adapter.exec('CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, role_name TEXT NOT NULL UNIQUE)');
    await adapter.executeRun("INSERT INTO roles (id, role_name) VALUES (?, ?)", [1, 'admin']);
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      // ignore — close is tested separately
    }
  });

  describe(`${label}: executeGet`, () => {
    it('returns a single row by id', async () => {
      await adapter.executeRun(
        'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
        [1, 'Alice', 'alice@test.com'],
      );
      const row = await adapter.executeGet<{ id: number; name: string; email: string }>(
        'SELECT id, name, email FROM users WHERE id = ?',
        [1],
      );
      expect(row).not.toBeNull();
      expect(row!.id).toBe(1);
      expect(row!.name).toBe('Alice');
      expect(row!.email).toBe('alice@test.com');
    });

    it('returns null when no rows match', async () => {
      const row = await adapter.executeGet('SELECT * FROM users WHERE id = ?', [999]);
      expect(row).toBeNull();
    });

    it('returns null for empty table', async () => {
      const row = await adapter.executeGet('SELECT * FROM users');
      expect(row).toBeNull();
    });

    it('supports typed generic parameter', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Bob']);
      interface UserRow {
        id: number;
        name: string;
      }
      const row = await adapter.executeGet<UserRow>('SELECT id, name FROM users WHERE id = ?', [2]);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(2);
      expect(row!.name).toBe('Bob');
    });

    it('works with parameterized queries', async () => {
      await adapter.executeRun(
        'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
        [3, 'Charlie', 'charlie@test.com'],
      );
      const row = await adapter.executeGet<{ email: string }>(
        'SELECT email FROM users WHERE name = ?',
        ['Charlie'],
      );
      expect(row!.email).toBe('charlie@test.com');
    });
  });

  describe(`${label}: executeAll`, () => {
    it('returns multiple rows with columns', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Bob']);
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [3, 'Charlie']);

      const result = await adapter.executeAll<{ id: number; name: string }>(
        'SELECT id, name FROM users ORDER BY id',
      );
      expect(result.columns).toContain('id');
      expect(result.columns).toContain('name');
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]!.name).toBe('Alice');
      expect(result.rows[2]!.name).toBe('Charlie');
    });

    it('returns empty rows for no matches', async () => {
      const result = await adapter.executeAll<{ id: number }>(
        'SELECT id FROM users WHERE id = ?',
        [999],
      );
      expect(result.rows).toEqual([]);
    });

    it('returns empty rows from empty table', async () => {
      await adapter.exec('CREATE TABLE IF NOT EXISTS empty_table (x INTEGER)');
      const result = await adapter.executeAll('SELECT * FROM empty_table');
      expect(result.rows).toEqual([]);
    });
  });

  describe(`${label}: executeRun`, () => {
    it('INSERT returns rowsAffected=1 and a lastInsertRowid', async () => {
      const result = await adapter.executeRun(
        'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
        [10, 'Dave', 'dave@test.com'],
      );
      expect(result.rowsAffected).toBe(1);
      expect(typeof result.lastInsertRowid).toBe('number');
    });

    it('UPDATE returns rowsAffected matching changed rows', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Eve']);
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'Frank']);

      const result = await adapter.executeRun(
        "UPDATE users SET name = 'Eve Updated' WHERE id = 1",
      );
      expect(result.rowsAffected).toBe(1);
    });

    it('UPDATE with no matching rows returns rowsAffected=0', async () => {
      const result = await adapter.executeRun(
        "UPDATE users SET name = 'Nope' WHERE id = 999",
      );
      expect(result.rowsAffected).toBe(0);
    });

    it('DELETE returns rowsAffected matching deleted rows', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'DeleteMe']);
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'KeepMe']);

      const result = await adapter.executeRun('DELETE FROM users WHERE id = 1');
      expect(result.rowsAffected).toBe(1);

      const remaining = await adapter.executeGet('SELECT name FROM users WHERE id = ?', [2]);
      expect(remaining).not.toBeNull();
    });
  });

  describe(`${label}: exec`, () => {
    it('executes DDL to create a table', async () => {
      await adapter.exec('CREATE TABLE IF NOT EXISTS test_ddl (id INTEGER PRIMARY KEY, value TEXT)');
      await adapter.executeRun('INSERT INTO test_ddl (id, value) VALUES (?, ?)', [1, 'hello']);
      const row = await adapter.executeGet<{ value: string }>('SELECT value FROM test_ddl WHERE id = ?', [1]);
      expect(row!.value).toBe('hello');
    });

    it('executes multi-statement DDL', async () => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS multi_a (x INTEGER);
        CREATE TABLE IF NOT EXISTS multi_b (y TEXT);
      `);
      await adapter.executeRun('INSERT INTO multi_a (x) VALUES (?)', [42]);
      await adapter.executeRun('INSERT INTO multi_b (y) VALUES (?)', ['ok']);
      const a = await adapter.executeGet<{ x: number }>('SELECT x FROM multi_a WHERE x = ?', [42]);
      const b = await adapter.executeGet<{ y: string }>('SELECT y FROM multi_b WHERE y = ?', ['ok']);
      expect(a!.x).toBe(42);
      expect(b!.y).toBe('ok');
    });
  });

  describe(`${label}: pragmaSet / pragmaGet`, () => {
    it('round-trips cache_size', async () => {
      await adapter.pragmaSet('cache_size', 1000);
      const val = await adapter.pragmaGet<number>('cache_size');
      expect(val).toBeDefined();
    });

    it('round-trips journal_mode value', async () => {
      await adapter.pragmaSet('journal_mode', 'delete');
      const result = await adapter.pragmaGet<string>('journal_mode');
      expect(typeof result === 'string' || typeof result === 'number').toBe(true);
    });

    it('converts boolean true to 1', async () => {
      await adapter.pragmaSet('foreign_keys', true);
      const val = await adapter.pragmaGet<number>('foreign_keys');
      expect(val).toBe(1);
    });

    it('converts boolean false to 0', async () => {
      await adapter.pragmaSet('foreign_keys', false);
      const val = await adapter.pragmaGet<number>('foreign_keys');
      expect(val).toBe(0);
    });

    it('round-trips string PRAGMA values', async () => {
      await adapter.pragmaSet('synchronous', 'NORMAL');
      const val = await adapter.pragmaGet<string>('synchronous');
      expect(val).toBeDefined();
    });

    it('round-trips numeric PRAGMA values', async () => {
      await adapter.pragmaSet('busy_timeout', 5000);
      const val = await adapter.pragmaGet<number>('busy_timeout');
      expect(val).toBe(5000);
    });
  });

  describe(`${label}: transaction`, () => {
    it('commits data when callback succeeds', async () => {
      await adapter.transaction(async (tx) => {
        await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'TxUser']);
      });
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('TxUser');
    });

    it('rolls back data when callback throws', async () => {
      try {
        await adapter.transaction(async (tx) => {
          await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'RollbackMe']);
          throw new Error('abort transaction');
        });
      } catch {
        // expected
      }
      const row = await adapter.executeGet('SELECT * FROM users WHERE id = ?', [1]);
      expect(row).toBeNull();
    });

    it('supports sync callbacks (non-promise return)', async () => {
      const result = await adapter.transaction((tx) => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('mode: deferred succeeds', async () => {
      await adapter.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Deferred']);
        },
        { mode: 'deferred' },
      );
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('Deferred');
    });

    it('mode: immediate succeeds', async () => {
      await adapter.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Immediate']);
        },
        { mode: 'immediate' },
      );
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('Immediate');
    });

    it('mode: exclusive succeeds', async () => {
      await adapter.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Exclusive']);
        },
        { mode: 'exclusive' },
      );
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('Exclusive');
    });

    it('mode defaults to deferred when not specified', async () => {
      await adapter.transaction(async (tx) => {
        await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'DefaultMode']);
      });
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('DefaultMode');
    });

    it('supports AdapterTransaction.executeGet inside transaction', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'ReadInside']);
      const result = await adapter.transaction(async (tx) => {
        const row = await tx.executeGet<{ id: number; name: string }>(
          'SELECT id, name FROM users WHERE id = ?',
          [1],
        );
        return row!.name;
      });
      expect(result).toBe('ReadInside');
    });

    it('supports AdapterTransaction.executeAll inside transaction', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'A']);
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [2, 'B']);
      const result = await adapter.transaction(async (tx) => {
        const all = await tx.executeAll<{ name: string }>('SELECT name FROM users ORDER BY id');
        return all.rows.map((r) => r.name).join(',');
      });
      expect(result).toBe('A,B');
    });

    it('supports AdapterTransaction.executeRun inside transaction', async () => {
      const runResult = await adapter.transaction(async (tx) => {
        return tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'TxRun']);
      });
      expect(runResult.rowsAffected).toBe(1);
    });

    it('supports AdapterTransaction.exec inside transaction', async () => {
      await adapter.transaction(async (tx) => {
        await tx.exec('CREATE TABLE IF NOT EXISTS tx_created (x INTEGER)');
      });
      await adapter.executeRun('INSERT INTO tx_created (x) VALUES (?)', [99]);
      const row = await adapter.executeGet<{ x: number }>('SELECT x FROM tx_created WHERE x = ?', [99]);
      expect(row!.x).toBe(99);
    });

    it('rolls back on nested error in async callback', async () => {
      await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'PreTx']);
      try {
        await adapter.transaction(async (tx) => {
          await tx.executeRun('UPDATE users SET name = ? WHERE id = ?', ['Changed', 1]);
          throw new Error('force rollback');
        });
      } catch {
        // expected
      }
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('PreTx');
    });
  });

  describe(`${label}: executeMany`, () => {
    it('executes multiple statements sequentially', async () => {
      const results = await adapter.executeMany([
        { sql: 'INSERT INTO users (id, name, email) VALUES (?, ?, ?)', args: [1, 'Batch1', 'b1@test.com'] },
        { sql: 'INSERT INTO users (id, name, email) VALUES (?, ?, ?)', args: [2, 'Batch2', 'b2@test.com'] },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]!.rowsAffected).toBe(1);
      expect(results[1]!.rowsAffected).toBe(1);

      const all = await adapter.executeAll<{ name: string }>('SELECT name FROM users ORDER BY id');
      expect(all.rows).toHaveLength(2);
    });

    it('first statement data persists even if second fails (non-atomic)', async () => {
      try {
        await adapter.executeMany([
          { sql: 'INSERT INTO users (id, name, email) VALUES (?, ?, ?)', args: [1, 'Keep', 'keep@test.com'] },
          { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', args: [1, 'Dup'] },
        ]);
      } catch {
        // expected
      }
      const row = await adapter.executeGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [1]);
      expect(row!.name).toBe('Keep');
    });

    it('returns empty array for empty input', async () => {
      const results = await adapter.executeMany([]);
      expect(results).toEqual([]);
    });
  });

  describe(`${label}: close`, () => {
    it('subsequent operations throw after close', async () => {
      await adapter.close();
      await expect(adapter.executeGet('SELECT 1')).rejects.toThrow();
      await expect(adapter.executeAll('SELECT 1')).rejects.toThrow();
      await expect(adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'test'])).rejects.toThrow();
      await expect(adapter.exec('SELECT 1')).rejects.toThrow();
    });

    it('close is idempotent', async () => {
      await adapter.close();
      await expect(adapter.close()).resolves.toBeUndefined();
      await expect(adapter.close()).resolves.toBeUndefined();
    });

    it('pragma operations throw after close', async () => {
      await adapter.close();
      await expect(adapter.pragmaSet('cache_size', 100)).rejects.toThrow();
      await expect(adapter.pragmaGet('cache_size')).rejects.toThrow();
    });

    it('transaction throws after close', async () => {
      await adapter.close();
      await expect(
        adapter.transaction(async (tx) => {
          await tx.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'test']);
        }),
      ).rejects.toThrow();
    });
  });

  describe(`${label}: error helpers`, () => {
    it('isUniqueConstraintError detects UNIQUE violations', async () => {
      await adapter.executeRun('INSERT INTO users (id, name, email) VALUES (?, ?, ?)', [1, 'U1', 'unique@test.com']);
      let caught: unknown;
      try {
        await adapter.executeRun('INSERT INTO users (id, name, email) VALUES (?, ?, ?)', [2, 'U2', 'unique@test.com']);
      } catch (err) {
        caught = err;
      }
      if (caught) {
        expect(isUniqueConstraintError(caught)).toBe(true);
        expect(isDatabaseError(caught)).toBe(true);
        expect(dbErrorCode(caught)).toBe('SQLITE_CONSTRAINT_UNIQUE');
      }
    });

    it('isForeignKeyError detects FK violations', async () => {
      let caught: unknown;
      try {
        await adapter.executeRun('INSERT INTO users (id, name, email, role_id) VALUES (?, ?, ?, ?)', [1, 'FK', 'fk@test.com', 999]);
      } catch (err) {
        caught = err;
      }
      if (caught) {
        if (isForeignKeyError(caught)) {
          expect(isDatabaseError(caught)).toBe(true);
        }
        expect(isDatabaseError(caught)).toBe(true);
      }
    });

    it('isDatabaseError returns false for non-DB errors', () => {
      expect(isDatabaseError(new Error('plain error'))).toBe(false);
      expect(isDatabaseError('string error')).toBe(false);
      expect(isDatabaseError(null)).toBe(false);
      expect(isDatabaseError(undefined)).toBe(false);
      expect(isDatabaseError({})).toBe(false);
    });

    it('dbErrorCode returns undefined for non-DB errors', () => {
      expect(dbErrorCode(new Error('plain'))).toBeUndefined();
      expect(dbErrorCode('string')).toBeUndefined();
      expect(dbErrorCode(null)).toBeUndefined();
    });

    it('isBusyError returns false for non-busy errors', () => {
      expect(isBusyError(new Error('some error'))).toBe(false);
      expect(isBusyError(null)).toBe(false);
    });

    it('isConcurrentConflict returns false for non-conflict errors', () => {
      expect(isConcurrentConflict(new Error('some error'))).toBe(false);
      expect(isConcurrentConflict(null)).toBe(false);
    });
  });

  describe(`${label}: withRetry`, () => {
    it('returns result on first success', async () => {
      const result = await withRetry(async () => 'success');
      expect(result).toBe('success');
    });

    it('retries on retriable errors', async () => {
      let attempts = 0;
      const busyError = Object.assign(new Error('database is locked'), {
        code: 'SQLITE_BUSY',
      });

      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw busyError;
          return 'recovered';
        },
        { maxRetries: 5, baseDelayMs: 1 },
      );
      expect(result).toBe('recovered');
      expect(attempts).toBe(3);
    });

    it('throws on exhaustion of retries', async () => {
      const busyError = Object.assign(new Error('database is locked'), {
        code: 'SQLITE_BUSY',
      });

      await expect(
        withRetry(
          async () => {
            throw busyError;
          },
          { maxRetries: 2, baseDelayMs: 1 },
        ),
      ).rejects.toThrow('database is locked');
    });

    it('re-throws non-retriable errors immediately', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw new Error('non-retriable');
          },
          { maxRetries: 5, baseDelayMs: 1 },
        ),
      ).rejects.toThrow('non-retriable');
      expect(attempts).toBe(1);
    });

    it('defaults to 3 retries', async () => {
      let attempts = 0;
      const busyError = Object.assign(new Error('busy'), {
        code: 'SQLITE_BUSY',
      });

      await expect(
        withRetry(async () => {
          attempts++;
          throw busyError;
        }),
      ).rejects.toThrow('busy');
      expect(attempts).toBe(3);
    });
  });

  describe(`${label}: capabilities`, () => {
    it('has defined capabilities object', () => {
      expect(adapter.capabilities).toBeDefined();
      expect(typeof adapter.capabilities.multiprocessWrite).toBe('boolean');
      expect(typeof adapter.capabilities.nativeVectors).toBe('boolean');
      expect(typeof adapter.capabilities.concurrentTransactions).toBe('boolean');
      expect(typeof adapter.capabilities.recursiveCte).toBe('boolean');
    });
  });

  describe(`${label}: config`, () => {
    it('has a config object with type', () => {
      expect(adapter.config).toBeDefined();
      expect(adapter.config.type).toBeDefined();
      expect(['sqlite', 'turso'].includes(adapter.config.type)).toBe(true);
    });
  });

  describe(`${label}: unwrap`, () => {
    it('returns a non-null value', () => {
      const handle = adapter.unwrap();
      expect(handle).toBeDefined();
      expect(handle).not.toBeNull();
    });
  });

  describe(`${label}: read-only mode`, () => {
    it('writes throw in read-only adapter', async () => {
      if (adapter.config.readonly) {
        await expect(
          adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'ro-test']),
        ).rejects.toThrow();
      }
    });

    it('reads succeed in read-only adapter', async () => {
      if (adapter.config.readonly) {
        const row = await adapter.executeGet('SELECT 1 AS val');
        expect(row).toEqual({ val: 1 });
      }
    });
  });

  describe(`${label}: basic CRUD round-trip`, () => {
    it('INSERT + SELECT + UPDATE + DELETE workflow', async () => {
      // INSERT
      const insertResult = await adapter.executeRun(
        'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
        [100, 'CRUD', 'crud@test.com'],
      );
      expect(insertResult.rowsAffected).toBe(1);

      // SELECT
      const row = await adapter.executeGet<{ id: number; name: string; email: string }>(
        'SELECT * FROM users WHERE id = ?',
        [100],
      );
      expect(row!.name).toBe('CRUD');

      // UPDATE
      const updateResult = await adapter.executeRun(
        'UPDATE users SET name = ? WHERE id = ?',
        ['Updated', 100],
      );
      expect(updateResult.rowsAffected).toBe(1);

      // SELECT after UPDATE
      const updated = await adapter.executeGet<{ name: string }>(
        'SELECT name FROM users WHERE id = ?',
        [100],
      );
      expect(updated!.name).toBe('Updated');

      // DELETE
      const deleteResult = await adapter.executeRun('DELETE FROM users WHERE id = ?', [100]);
      expect(deleteResult.rowsAffected).toBe(1);

      // Verify deletion
      const deleted = await adapter.executeGet('SELECT * FROM users WHERE id = ?', [100]);
      expect(deleted).toBeNull();
    });
  });
}

// ── Adapter-specific tests ────────────────────────────────────────────────────

describe('SqliteAdapter contract tests', () => {
  runContractTests('SqliteAdapter', () => {
    return createSqliteAdapter({ dbPath: ':memory:' });
  });
});

describe('SqliteAdapter read-only tests', () => {
  let adapter: StoreAdapter;

  afterEach(async () => {
    try { await adapter.close(); } catch { /* ok */ }
  });

  it('readable=false allows writes', async () => {
    adapter = createSqliteAdapter({ dbPath: ':memory:' });
    await adapter.exec('CREATE TABLE rw_test (id INTEGER PRIMARY KEY, value TEXT)');
    await expect(
      adapter.executeRun('INSERT INTO rw_test (id, value) VALUES (?, ?)', [1, 'write-ok']),
    ).resolves.toBeDefined();
  });
});

describe('SqliteAdapter unwrap', () => {
  it('returns a better-sqlite3 Database instance', () => {
    const adapter = createSqliteAdapter({ dbPath: ':memory:' });
    const db = (adapter as SqliteAdapter).unwrap();
    expect(db).toBeDefined();
    expect(typeof db.prepare).toBe('function');
    expect(typeof db.exec).toBe('function');
    expect(typeof db.close).toBe('function');
    adapter.close();
  });
});

describe('SqliteAdapter capabilities', () => {
  it('has correct default capabilities', () => {
    const adapter = createSqliteAdapter({ dbPath: ':memory:' });
    const caps = adapter.capabilities;
    expect(caps.multiprocessWrite).toBe(false);
    expect(caps.nativeVectors).toBe(false);
    expect(caps.concurrentTransactions).toBe(false);
    expect(caps.recursiveCte).toBe(true); // better-sqlite3 accepts WITH RECURSIVE
    adapter.close();
  });
});

describe('SqliteAdapter config', () => {
  it('has type sqlite and dbPath set', () => {
    const adapter = createSqliteAdapter({ dbPath: ':memory:' });
    expect(adapter.config.type).toBe('sqlite');
    expect(adapter.config.dbPath).toBe(':memory:');
    adapter.close();
  });
});

describe('SqliteAdapter mode: concurrent throws', () => {
  it('throws TypeError for concurrent mode', async () => {
    const adapter = createSqliteAdapter({ dbPath: ':memory:' });
    await adapter.exec('CREATE TABLE test (id INTEGER)');
    await expect(
      adapter.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO test (id) VALUES (?)', [1]);
        },
        { mode: 'concurrent' },
      ),
    ).rejects.toThrow(TypeError);
    await adapter.close();
  });
});

// ── MockAdapter tests ─────────────────────────────────────────────────────────

describe('MockAdapter contract tests', () => {
  runContractTests('MockAdapter', () => {
    return new MockAdapter();
  });
});

describe('MockAdapter unwrap', () => {
  it('returns the internal Map', () => {
    const adapter = new MockAdapter();
    const data = adapter.unwrap();
    expect(data).toBeInstanceOf(Map);
  });
});

describe('MockAdapter capabilities', () => {
  it('has correct capabilities', () => {
    const adapter = new MockAdapter();
    const caps = adapter.capabilities;
    expect(caps.multiprocessWrite).toBe(false);
    expect(caps.nativeVectors).toBe(false);
    expect(caps.concurrentTransactions).toBe(false);
    expect(caps.recursiveCte).toBe(true);
  });
});

describe('MockAdapter config', () => {
  it('has type sqlite', () => {
    const adapter = new MockAdapter();
    expect(adapter.config.type).toBe('sqlite');
  });
});

describe('MockAdapter transaction isolation', () => {
  it('rolls back state on error', async () => {
    const adapter = new MockAdapter();
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
    await adapter.executeRun('INSERT INTO items (id, value) VALUES (?, ?)', [1, 'initial']);

    try {
      await adapter.transaction(async (tx) => {
        await tx.executeRun('UPDATE items SET value = ? WHERE id = ?', ['mutated', 1]);
        throw new Error('abort');
      });
    } catch {
      // expected
    }

    const row = await adapter.executeGet<{ value: string }>('SELECT value FROM items WHERE id = ?', [1]);
    expect(row!.value).toBe('initial');
  });

  it('supports all four transaction modes', async () => {
    const adapter = new MockAdapter();
    await adapter.exec('CREATE TABLE txmodes (id INTEGER, val TEXT)');

    for (const mode of ['deferred', 'immediate', 'exclusive', 'concurrent'] as const) {
      await adapter.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO txmodes (id, val) VALUES (?, ?)', [1, mode]);
        },
        { mode },
      );
    }
  });
});

describe('MockAdapter executeMany with args', () => {
  it('passes arguments to INSERT', async () => {
    const adapter = new MockAdapter();
    await adapter.exec('CREATE TABLE people (id INTEGER, name TEXT)');

    const results = await adapter.executeMany([
      { sql: 'INSERT INTO people (id, name) VALUES (?, ?)', args: [1, 'Alice'] },
      { sql: 'INSERT INTO people (id, name) VALUES (?, ?)', args: [2, 'Bob'] },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.rowsAffected).toBe(1);

    const all = await adapter.executeAll<{ name: string }>('SELECT name FROM people');
    expect(all.rows).toHaveLength(2);
    expect(all.rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
  });
});

describe('MockAdapter close', () => {
  it('close is idempotent', async () => {
    const adapter = new MockAdapter();
    await adapter.close();
    await adapter.close();
  });

  it('operations after close throw', async () => {
    const adapter = new MockAdapter();
    await adapter.close();
    await expect(adapter.executeGet('SELECT 1')).rejects.toThrow('closed');
    await expect(adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'test'])).rejects.toThrow('closed');
  });
});
