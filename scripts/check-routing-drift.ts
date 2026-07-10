#!/usr/bin/env node
/**
 * check-routing-drift.ts — Routing index drift gate
 *
 * Regenerates the routing files into a temp directory and diffs against the
 * committed outputs. Exits non-zero on any drift.
 *
 * Use as a CI check or pre-commit hook:
 *   npx tsx scripts/check-routing-drift.ts
 *
 * When it fails, re-sync with:
 *   npx tsx scripts/build-routing-index.ts && git add docs/routing/ libs/data/INDEX.md
 *
 * Modeled on the BL-33 byte-mirror pattern (build-index.ts / check-registry-sync.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildRoutingIndex } from './build-routing-index.js';

const root = process.argv[2] ?? process.cwd();
const committedRoutingDir = path.join(root, 'docs', 'routing');

function readFileOrNull(fp: string): string | null {
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-drift-'));

try {
  // BL-257: pass a scratch libsRoot so this dry-run comparison build never
  // touches the real committed `libs/<area>/INDEX.md` before we've diffed it.
  buildRoutingIndex({ root, outDir: tempDir, libsRoot: tempDir });

  const driftFiles: string[] = [];

  const tempMapJson = readFileOrNull(path.join(tempDir, 'map.json'));
  const committedMapJson = readFileOrNull(path.join(committedRoutingDir, 'map.json'));

  if (tempMapJson !== committedMapJson) {
    if (!committedMapJson) {
      driftFiles.push('docs/routing/map.json (missing from committed)');
    } else {
      driftFiles.push('docs/routing/map.json');
    }
  }

  const tempIndex = readFileOrNull(path.join(tempDir, 'INDEX.md'));
  const committedIndex = readFileOrNull(path.join(committedRoutingDir, 'INDEX.md'));

  if (tempIndex !== committedIndex) {
    if (!committedIndex) {
      driftFiles.push('docs/routing/INDEX.md (missing from committed)');
    } else {
      driftFiles.push('docs/routing/INDEX.md');
    }
  }

  for (const entry of fs.readdirSync(tempDir)) {
    const tempEntryPath = path.join(tempDir, entry);
    if (!fs.statSync(tempEntryPath).isDirectory()) continue;
    if (entry === 'INDEX.md' || entry === 'map.json') continue;

    const tempAreaIndex = readFileOrNull(path.join(tempEntryPath, 'INDEX.md'));
    const committedAreaIndex = readFileOrNull(path.join(committedRoutingDir, entry, 'INDEX.md'));

    if (tempAreaIndex !== committedAreaIndex) {
      if (!committedAreaIndex) {
        driftFiles.push(`docs/routing/${entry}/INDEX.md (missing from committed)`);
      } else {
        driftFiles.push(`docs/routing/${entry}/INDEX.md`);
      }
    }

    const libsAreaIndexPath = path.join(root, 'libs', entry, 'INDEX.md');
    const committedLibsAreaIndex = readFileOrNull(libsAreaIndexPath);

    if (tempAreaIndex !== committedLibsAreaIndex) {
      if (!committedLibsAreaIndex) {
        driftFiles.push(`libs/${entry}/INDEX.md (missing from committed)`);
      } else {
        driftFiles.push(`libs/${entry}/INDEX.md`);
      }
    }
  }

  if (driftFiles.length > 0) {
    console.error('check-routing-drift: FAIL — routing index is out of sync.');
    console.error('  Drifted files:');
    for (const f of driftFiles) {
      console.error(`    ${f}`);
    }
    console.error('');
    console.error('  Fix: npx tsx scripts/build-routing-index.ts');
    console.error('       git add docs/routing/ libs/data/INDEX.md');
    process.exit(1);
  }

  console.log('check-routing-drift: OK — routing index is in sync');
  process.exit(0);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
