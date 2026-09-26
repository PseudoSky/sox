/**
 * 4cd68c4e — `memory fts-optimize`, the operator surface for the OFFLINE FTS
 * segment merge. The in-service idle pass never merges a pre-existing backlog
 * (a 27–34 s main-thread merge on prod's ~5,001 segments); this verb does, with
 * memory-server stopped, and refuses (exit 2) while any store-lease peer is
 * live.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TursoAdapterImpl } from '@adhd/sox-store-adapter';
import { runCli } from './index.js';

const cleanups: Array<() => void | Promise<void>> = [];
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function seedFtsStore(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cli-fts-optimize-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'fts.db');
  const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
  await a.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await a.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
  for (let i = 0; i < 30; i++) await a.executeRun('INSERT INTO node (content) VALUES (?)', [`alpha beta ${i}`]);
  await a.close();
  return dbPath;
}

describe('4cd68c4e — `memory fts-optimize` (offline FTS segment merge)', () => {
  it('merges every FTS index of a stopped store and reports per-index duration', async () => {
    const dbPath = await seedFtsStore();
    await runCli(['fts-optimize', '--db', dbPath]);
    const out = logs.join('\n');
    expect(out).toMatch(/ok\s+idx_fts_node\s+\d+ ms/);
    expect(out).toContain('[fts-optimize] complete');
    expect(out).toMatch(/duration_ms: \d+/);
    expect(exitSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('refuses (exit 2) while a store peer is live, and runs nothing', async () => {
    const dbPath = await seedFtsStore();
    const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await peer.executeGet('SELECT 1 AS one');
    cleanups.push(() => peer.close());
    await expect(runCli(['fts-optimize', '--db', dbPath])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toMatch(/REFUSED: \d+ live store peer/);
    expect(logs.join('\n')).not.toContain('idx_fts_node');
  }, 120_000);

  it('exits 1 on a missing db', async () => {
    await expect(runCli(['fts-optimize', '--db', path.join(os.tmpdir(), 'no-such-fts-store.db')])).rejects.toMatchObject({
      code: 1,
    });
  });
});
