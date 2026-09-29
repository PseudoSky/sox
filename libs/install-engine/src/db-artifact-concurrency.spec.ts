/**
 * db-artifact-concurrency.spec.ts — D-B AC1 & AC2, proven with TWO REAL OS
 * PROCESSES and a FILE-SIGNAL barrier, keyed on process EXIT CODES (never stdout).
 *
 * The workers are spawned through `tsx` and run the REAL write path
 * (`OwnershipIndex.save` → `writeOwnershipAtomic` → `atomicWriteFileSync`). The
 * negative controls run the OLD fixed-`.tmp` publisher through the SAME harness,
 * so if the harness could not see the defect the NC assertion would fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnershipIndex } from './ownership.js';
import { ownershipPathFor } from './data-paths.js';
import { detectDrift } from './drift.js';
import { reconcile } from './reconcile.js';

/** Walk up to the workspace root (the dir holding nx.json). No `import.meta`
 *  so the file also typechecks under the package's CommonJS tsconfig. */
function findRepoRoot(start: string): string {
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, 'nx.json'))) return d;
    const parent = path.dirname(d);
    if (parent === d) throw new Error(`repo root (nx.json) not found above ${start}`);
    d = parent;
  }
}
const repoRoot = findRepoRoot(process.cwd());
const hereDir = path.join(repoRoot, 'libs', 'install-engine', 'src');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const worker = path.join(hereDir, 'db-artifact-worker.ts');

interface WorkerSpec {
  ownershipPath: string;
  extId: string;
  artifactPath: string;
  signal: string;
  readyTag: string;
  mode: 'install' | 'fail-after-effect' | 'marker-first';
  legacyTmp?: boolean;
}

interface Child {
  pid: number;
  done: Promise<{ code: number; stderr: string }>;
}

function spawnChild(spec: WorkerSpec): Child {
  const cp: ChildProcess = spawn(tsxBin, [worker, JSON.stringify(spec)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  cp.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    cp.on('exit', (code) => resolve({ code: code ?? -1, stderr: err }));
  });
  return { pid: cp.pid!, done };
}

/** Bounded readiness poll — yields via setImmediate (a barrier wait, NOT a sleep). */
async function waitForFile(p: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`barrier: ready file never appeared: ${p}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Spawn N workers, wait for ALL ready signals, then release the barrier at once. */
async function race(specs: WorkerSpec[]): Promise<Array<{ code: number; stderr: string }>> {
  const children = specs.map(spawnChild);
  await Promise.all(specs.map((s) => waitForFile(`${s.signal}.ready.${s.readyTag}`)));
  // Release: both processes are parked on the same signal file.
  fs.writeFileSync(specs[0]!.signal, 'go');
  return Promise.all(children.map((c) => c.done));
}

function readOwnedIds(ownPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownPath, 'utf8')) as { owned: Array<{ extId: string }> };
    return parsed.owned.map((r) => r.extId).sort();
  } catch {
    return ['__TORN__'];
  }
}

let root: string;
let own: string;
let signal: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-db-race-'));
  own = ownershipPathFor('project', root);
  signal = path.join(root, 'barrier');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AC1 — two real OS processes installing DIFFERENT extensions both persist', () => {
  it('both records land in one ownership.json (exit-code keyed, file-signal barrier)', async () => {
    const oc = await race([
      { ownershipPath: own, extId: 'ext-a', artifactPath: path.join(root, 'a.md'), signal, readyTag: 'a', mode: 'install' },
      { ownershipPath: own, extId: 'ext-b', artifactPath: path.join(root, 'b.md'), signal, readyTag: 'b', mode: 'install' },
    ]);
    expect(oc[0]!.code, `A stderr: ${oc[0]!.stderr}`).toBe(0);
    expect(oc[1]!.code, `B stderr: ${oc[1]!.stderr}`).toBe(0);
    // The file always parses (atomic rename — never torn) and holds BOTH records.
    expect(readOwnedIds(own)).toEqual(['ext-a', 'ext-b']);
  }, 30000);

  it('NEGATIVE CONTROL: the old fixed-`.tmp` publisher loses a record under the SAME race', async () => {
    await race([
      { ownershipPath: own, extId: 'ext-a', artifactPath: path.join(root, 'a.md'), signal, readyTag: 'a', mode: 'install', legacyTmp: true },
      { ownershipPath: own, extId: 'ext-b', artifactPath: path.join(root, 'b.md'), signal, readyTag: 'b', mode: 'install', legacyTmp: true },
    ]);
    const ids = readOwnedIds(own);
    // RED: the harness observes the defect (a lost/torn record). If this were green
    // the harness could not have caught the original bug either.
    expect(ids).not.toEqual(['ext-a', 'ext-b']);
  }, 30000);
});

describe('AC2 — idempotent re-run and effect-then-marker ordering', () => {
  it('two concurrent installs of the SAME extension yield exactly one record, one entry', async () => {
    const artifact = path.join(root, 'same.md');
    const oc = await race([
      { ownershipPath: own, extId: 'ext-same', artifactPath: artifact, signal, readyTag: 'a', mode: 'install' },
      { ownershipPath: own, extId: 'ext-same', artifactPath: artifact, signal, readyTag: 'b', mode: 'install' },
    ]);
    expect(oc[0]!.code, oc[0]!.stderr).toBe(0);
    expect(oc[1]!.code, oc[1]!.stderr).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(own, 'utf8')) as { owned: Array<{ extId: string; entries: unknown[] }> };
    expect(parsed.owned.filter((r) => r.extId === 'ext-same')).toHaveLength(1);
    expect(parsed.owned.find((r) => r.extId === 'ext-same')!.entries).toHaveLength(1);
  }, 30000);

  it('GREEN (effect-then-marker): a crash between the two leaves the artifact UNTRACKED', async () => {
    const artifact = path.join(root, 'managed', 'orphan.md');
    const oc = await race([
      { ownershipPath: own, extId: 'ext-ord', artifactPath: artifact, signal, readyTag: 'a', mode: 'fail-after-effect' },
    ]);
    expect(oc[0]!.code).toBe(2); // the injected failure surfaced as an exit code
    // The EFFECT happened (artifact exists)…
    expect(fs.existsSync(artifact)).toBe(true);
    // …and the MARKER did not (untracked-and-repairable, never tracked-and-absent).
    expect(readOwnedIds(own)).not.toContain('ext-ord');

    // Seed a sentinel owned file in the SAME dir (a managed root), then drift NAMES
    // the untracked artifact as `foreign`.
    const sentinel = path.join(root, 'managed', 'sentinel.md');
    fs.writeFileSync(sentinel, 'sentinel');
    const idx = OwnershipIndex.loadFromFile(own, { strict: true });
    idx.addEntries('sentinel', 'project', [{ kind: 'file-drop', path: sentinel }]);
    idx.save();
    const report = await detectDrift('project', root);
    const foreign = report.entries.filter((e) => e.verdict === 'foreign').map((e) => e.target);
    expect(foreign).toContain(artifact);
  }, 30000);

  it('RED (marker-first): the reversed order produces tracked-and-absent, which reconcile NAMES', async () => {
    const artifact = path.join(root, 'never-written.md');
    const oc = await race([
      { ownershipPath: own, extId: 'ext-lie', artifactPath: artifact, signal, readyTag: 'a', mode: 'marker-first' },
    ]);
    expect(oc[0]!.code).toBe(2);
    // The forbidden state: recorded but absent.
    expect(readOwnedIds(own)).toContain('ext-lie');
    expect(fs.existsSync(artifact)).toBe(false);
    const report = await reconcile('project', root);
    expect(report.stubs).toContain('ext-lie');
  }, 30000);
});
