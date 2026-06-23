/**
 * data-paths.parity.spec.ts — ADR-0004 drift guard.
 *
 * install-engine keeps a dependency-free copy of the data-root resolver
 * (src/data-paths.ts) because this repo's cross-`@adhd`-package access pattern
 * (lazy require + cast) is not intercepted by vitest's resolve.alias in source-mode
 * tests. To prevent the two copies from silently diverging, this test asserts that
 * the PARITY REGION of install-engine's copy is byte-identical to the authoritative
 * resolver at libs/host-runtime/src/data-paths.ts.
 *
 * If this fails: you edited one copy and not the other. Re-sync the PARITY REGION.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const HR = path.join(ROOT, 'libs/host-runtime/src/data-paths.ts');
const IE = path.join(ROOT, 'libs/install-engine/src/data-paths.ts');

/**
 * Extract the comparable body of a data-paths module: every exported declaration,
 * normalized. We compare the set of `export function`/`export const`/`export type`
 * lines plus their bodies by stripping comments and collapsing whitespace, so the
 * two files are guaranteed to expose the SAME resolver logic even though their file
 * headers differ.
 */
function normalizeResolver(src: string): string {
  return src
    // drop block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // drop line comments
    .replace(/^\s*\/\/.*$/gm, '')
    // drop import lines (the two files import the same builtins but may order differently)
    .replace(/^\s*import .*$/gm, '')
    // drop the parity-region markers (install-engine only)
    .replace(/.*PARITY REGION.*$/gm, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

describe('ADR-0004 data-paths parity', () => {
  it('install-engine data-paths resolver is byte-identical (normalized) to host-runtime', () => {
    const hr = normalizeResolver(fs.readFileSync(HR, 'utf8'));
    const ie = normalizeResolver(fs.readFileSync(IE, 'utf8'));
    expect(ie).toBe(hr);
  });

  it('both expose the same resolver surface', async () => {
    const ieMod = await import('./data-paths.js');
    const expected = [
      'DATA_SUBDIR', 'userDataRoot', 'dataRoot', 'scopeConfigPaths',
      'ledgerPathFor', 'ownershipPathFor', 'storeRootFor',
      'installRegistryPath', 'supervisorsPath', 'runDir', 'logDirFor', 'socketDir',
    ];
    for (const name of expected) {
      expect(ieMod, `install-engine data-paths missing export: ${name}`).toHaveProperty(name);
    }
  });
});
