/**
 * [ref:scaffold-parity] — anchor for the scaffold-parity invariant.
 *
 * Asserts that scaffold() (the soxe init path) and @adhd/sox-nx:extension (the generator path)
 * emit byte-identical FileSet output for the same inputs, for all 6 active types.
 *
 * Rule (from _shared.md): "a passing test asserts scaffold() (the soxe init path) and
 * @adhd/sox-nx:extension produce byte-identical FileSet output for identical inputs."
 *
 * Test methodology:
 *   1. Call scaffold(opts) directly — this is what soxe init uses.
 *   2. Run extensionGenerator(tree, schema) on a dry-run nx Tree.
 *   3. Reconstruct the FileSet from the Tree.
 *   4. Assert every key/value pair is byte-identical.
 */

import type { ActiveType } from '@adhd/sox-authoring';
import { ACTIVE_TYPES, scaffold } from '@adhd/sox-authoring';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { applyFileSet, extensionGenerator } from './index.js';

/** Reconstruct a FileSet from an nx Tree at the given root path. */
function treeToFileSet(
  tree: ReturnType<typeof createTreeWithEmptyWorkspace>,
  rootPath: string,
  expectedKeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const relPath of expectedKeys) {
    const fullPath = rootPath.endsWith('/') ? `${rootPath}${relPath}` : `${rootPath}/${relPath}`;
    const buf = tree.read(fullPath);
    if (buf === null) {
      throw new Error(`Expected file not found in tree: ${fullPath}`);
    }
    result[relPath] = buf.toString('utf-8');
  }
  return result;
}

const DIR_MAP: Record<ActiveType, string> = {
  agent: 'agents',
  skill: 'skills',
  'mcp-server': 'mcp-servers',
  hook: 'hooks',
  command: 'commands',
  bundle: 'bundles',
  service: 'services',
};

/** IDs that do NOT end with the type name — required by manifest contract. */
const TYPE_IDS: Record<ActiveType, string> = {
  agent: 'test-echo',
  skill: 'test-greet',
  'mcp-server': 'test-mcp',
  hook: 'test-audit',
  command: 'test-status',
  bundle: 'test-pack',
  service: 'test-daemon',
};

describe('[ref:scaffold-parity] scaffold() == @adhd/sox-nx:extension for all active types', () => {
  for (const type of ACTIVE_TYPES) {
    it(`type=${type}: generator FileSet is byte-identical to scaffold() output`, async () => {
      const id = TYPE_IDS[type];
      const opts = {
        type,
        id,
        title: `Test ${type}`,
        description: `Born-conformance test for type ${type}`,
        author: 'sox-test',
        keywords: ['test', type],
      };

      // Path 1: direct scaffold() call (soxe init path)
      const directFileSet = scaffold(opts);

      // Path 2: nx generator path — apply to Tree then read back
      const tree = createTreeWithEmptyWorkspace();
      const outDir = `extensions/${DIR_MAP[type]}/${id}`;
      await extensionGenerator(tree, {
        type,
        id,
        title: opts.title,
        description: opts.description,
        author: opts.author,
        keywords: opts.keywords.join(','),
        directory: outDir,
      });

      const generatorFileSet = treeToFileSet(
        tree,
        outDir,
        Object.keys(directFileSet),
      );

      // Assert byte-identical for every file
      for (const relPath of Object.keys(directFileSet)) {
        const direct = directFileSet[relPath] ?? '';
        const generated = generatorFileSet[relPath] ?? '';
        expect(generated, `${type}/${relPath}`).toBe(direct);
      }

      // Assert same set of files (no extras from generator)
      expect(Object.keys(generatorFileSet).sort()).toEqual(Object.keys(directFileSet).sort());
    });
  }

  it('scaffold() output matches applyFileSet() output (byte-parity via Tree)', async () => {
    const type: ActiveType = 'skill';
    const id = 'parity-test';
    const opts = { type, id, title: 'Parity Test', description: 'parity check', author: 'tester', keywords: ['parity'] };

    const directFileSet = scaffold(opts);

    const tree = createTreeWithEmptyWorkspace();
    const outDir = `extensions/skills/${id}`;
    applyFileSet(tree, directFileSet, outDir);

    const reconstructed = treeToFileSet(tree, outDir, Object.keys(directFileSet));
    for (const relPath of Object.keys(directFileSet)) {
      expect(reconstructed[relPath], relPath).toBe(directFileSet[relPath]);
    }
  });
});
