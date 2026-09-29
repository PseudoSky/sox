/**
 * db-artifact-worker.ts — the spawned OS process for the D-B concurrency proof
 * (AC1/AC2). NOT a spec file (vitest only collects *.spec.ts / *.test.ts), so it
 * is never run as a test itself; the spec spawns it via `tsx`.
 *
 * It is a REAL process running the REAL write path
 * (`OwnershipIndex.save` → `writeOwnershipAtomic` → `atomicWriteFileSync`).
 *
 * Invocation: `tsx db-artifact-worker.ts '<json-spec>'`
 * Spec fields:
 *   ownershipPath  absolute path to ownership.json
 *   extId          the extension id this process records
 *   artifactPath   where to write the placed artifact (the "effect")
 *   signal         barrier file: we write `<signal>.ready.<pid>` then block until
 *                  `<signal>` exists (a real file-signal barrier — no sleep)
 *   mode           'install' (effect then marker)
 *                | 'fail-after-effect' (effect, then THROW before the marker)
 *                | 'marker-first' (marker, then THROW before the effect — the lie)
 *   legacyTmp      when true, emulate the OLD fixed-`.tmp` publisher (negative control)
 *
 * Exit codes: 0 success · 2 the injected/ordered failure · 3 barrier timeout.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OwnershipIndex, type OwnedEntry } from './ownership.js';

interface WorkerSpec {
  ownershipPath: string;
  extId: string;
  artifactPath: string;
  signal: string;
  /** Unique-per-worker tag for the ready file (tsx re-execs, so pid ≠ the spawned pid). */
  readyTag: string;
  mode: 'install' | 'fail-after-effect' | 'marker-first';
  legacyTmp?: boolean;
}

function sleepTick(ms: number): void {
  // Atomics.wait on a throwaway buffer — a bounded BLOCKING wait, not a sleep loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function barrier(signal: string, readyTag: string): void {
  fs.writeFileSync(`${signal}.ready.${readyTag}`, 'ready');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(signal)) {
    if (Date.now() > deadline) {
      console.error(`worker ${process.pid}: barrier timeout`);
      process.exit(3);
    }
    sleepTick(2);
  }
}

function main(): void {
  const spec = JSON.parse(process.argv[2]!) as WorkerSpec;
  const content = `# ${spec.extId} artifact\n${crypto.randomBytes(8).toString('hex')}\n`;
  const contentHash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  const entry: OwnedEntry = { kind: 'file-drop', path: spec.artifactPath, contentHash };

  fs.mkdirSync(path.dirname(spec.ownershipPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.artifactPath), { recursive: true });
  barrier(spec.signal, spec.readyTag);

  const effect = (): void => {
    fs.writeFileSync(spec.artifactPath, content);
  };

  const marker = (): void => {
    if (spec.legacyTmp) {
      // NEGATIVE CONTROL: the OLD fixed-temp publisher (no merge, fixed `.tmp`).
      const p = spec.ownershipPath;
      const existing = fs.existsSync(p)
        ? (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: 1; owned: Array<{ extId: string }> })
        : { version: 1 as const, owned: [] as Array<{ extId: string }> };
      existing.owned = existing.owned.filter((r) => r.extId !== spec.extId);
      existing.owned.push({
        extId: spec.extId, scope: 'project', installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), entries: [entry],
      } as { extId: string });
      const tmp = p + '.tmp'; // the fixed temp name that races
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      // Deliberately widen the non-atomic window so the NEGATIVE CONTROL is
      // deterministic: two fixed-`.tmp` writers clobber each other's temp before
      // either renames, so a record is reliably lost. (This delay exists ONLY in
      // the legacy-emulation path, never in the production publisher.)
      sleepTick(25);
      fs.renameSync(tmp, p);
      return;
    }
    const idx = OwnershipIndex.loadFromFile(spec.ownershipPath, { strict: true });
    idx.addEntries(spec.extId, 'project', [entry]);
    idx.save();
  };

  if (spec.mode === 'fail-after-effect') {
    effect();
    // Throw BEFORE the marker — the ownership entry must not exist.
    throw new Error(`worker ${process.pid}: injected failure between effect and marker`);
  }

  if (spec.mode === 'marker-first') {
    marker();
    // Throw BEFORE the effect — the tracked-but-absent lie.
    throw new Error(`worker ${process.pid}: injected failure after marker, before effect`);
  }

  // mode 'install': effect THEN marker (B-I2 ordering).
  effect();
  marker();
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(2);
}
