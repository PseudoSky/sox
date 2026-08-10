/**
 * scripts/workspace-package-scan.test.mjs — unit pin for the BL-192
 * smoke-gate coverage-gap fix (tools/workspace-package-scan.mjs).
 *
 * Covers the contract-path resolver (dedupe across main/types/exports, nested
 * condition objects, skipped values) and the workspace package scan (exclusion
 * of node_modules/, dist/, and leftover atomic-build scratch dirs).
 *
 * Run: npx vitest run scripts/workspace-package-scan.test.mjs
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { contractArtifactPaths, hasContractPaths, workspacePackageDirs } from '../tools/workspace-package-scan.mjs';

/** A sox-nx-shaped package: same main/types/exports layout as packages/sox-nx. */
function soxNxShapedPkg() {
  return {
    name: '@adhd/sox-nx',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        import: './dist/index.js',
      },
      './package.json': './package.json',
      './executors.json': './executors.json',
    },
  };
}

describe('contractArtifactPaths', () => {
  it('resolves main/types/exports, deduping the same file across fields', () => {
    const pkgDir = '/workspace/packages/sox-nx';
    const paths = contractArtifactPaths(pkgDir, soxNxShapedPkg());

    // dist/index.js appears in main, exports["."].require AND exports["."].import
    // — must be deduped to exactly one entry.
    const indexJs = path.resolve(pkgDir, 'dist/index.js');
    const indexDts = path.resolve(pkgDir, 'dist/index.d.ts');
    expect(paths.filter((p) => p === indexJs)).toHaveLength(1);
    expect(paths).toContain(indexJs);
    expect(paths).toContain(indexDts);
    expect(paths).toContain(path.resolve(pkgDir, 'package.json'));
    expect(paths).toContain(path.resolve(pkgDir, 'executors.json'));
    // Nothing from outside the package dir.
    expect(paths.every((p) => p.startsWith(pkgDir + path.sep))).toBe(true);
  });

  it('recurses nested exports condition objects and arrays', () => {
    const pkgDir = '/workspace/libs/x';
    const pkg = {
      exports: {
        './a': [
          { node: { import: './dist/a.mjs' } },
          './dist/a.cjs',
        ],
        './b': {
          types: './dist/b.d.ts',
          default: {
            import: './dist/b.mjs',
          },
        },
      },
    };
    const paths = contractArtifactPaths(pkgDir, pkg);
    expect(paths).toContain(path.resolve(pkgDir, 'dist/a.mjs'));
    expect(paths).toContain(path.resolve(pkgDir, 'dist/a.cjs'));
    expect(paths).toContain(path.resolve(pkgDir, 'dist/b.d.ts'));
    expect(paths).toContain(path.resolve(pkgDir, 'dist/b.mjs'));
  });

  it('skips bare package names, node:/npm:/URL schemes, empty strings and non-strings', () => {
    const pkgDir = '/workspace/libs/y';
    const pkg = {
      main: 'some-bare-name',
      module: './dist/module.js',
      exports: {
        '.': {
          types: 'node:fs',
          default: './dist/index.js',
        },
        './npm-dep': 'npm:is-odd@1.0.0',
        './http-thing': 'https://example.com/x.js',
        './empty': '',
        './null': null,
        './number': 42,
      },
    };
    const paths = contractArtifactPaths(pkgDir, pkg);
    expect(paths).toContain(path.resolve(pkgDir, 'dist/module.js'));
    expect(paths).toContain(path.resolve(pkgDir, 'dist/index.js'));
    // Bare name skipped; node:/npm:/URL skipped; ''/null/number skipped.
    expect(paths).not.toContain(path.resolve(pkgDir, 'some-bare-name'));
    expect(paths.every((p) => !p.includes('node:') && !p.startsWith('https:') && !p.includes('npm:'))).toBe(true);
    expect(paths.every((p) => p.endsWith('.js'))).toBe(true);
  });

  it('returns [] for a package with no contract fields (bin absent, no main/types/exports)', () => {
    const pkgDir = '/workspace/tools/plain';
    expect(contractArtifactPaths(pkgDir, { name: '@adhd/plain', version: '1.0.0' })).toEqual([]);
    expect(hasContractPaths({ name: '@adhd/plain' })).toBe(false);
  });

  it('includes bin object values and string bin', () => {
    const pkgDir = '/workspace/packages/cli';
    const objBin = contractArtifactPaths(pkgDir, {
      bin: { sox: './bin/sox.js', soxe: './bin/soxe.js' },
    });
    expect(objBin).toContain(path.resolve(pkgDir, 'bin/sox.js'));
    expect(objBin).toContain(path.resolve(pkgDir, 'bin/soxe.js'));
    const strBin = contractArtifactPaths(pkgDir, { bin: './bin/cli.js' });
    expect(strBin).toEqual([path.resolve(pkgDir, 'bin/cli.js')]);
    expect(hasContractPaths({ bin: {} })).toBe(false); // empty object bin — no contract
    expect(hasContractPaths({ bin: './bin/cli.js' })).toBe(true);
  });
});

describe('workspacePackageDirs', () => {
  it('excludes dist/, node_modules/ and leftover atomic-build scratch dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scan-'));
    try {
      const mkpkg = (rel) => {
        const dir = path.join(root, rel);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
      };
      // Real packages — must be found.
      mkpkg('packages/sox-nx');
      mkpkg('libs/memory-core');
      mkpkg('extensions/commands/di-command');
      mkpkg('tools/baseline-capture');
      // Must be EXCLUDED:
      mkpkg('packages/sox-nx/dist'); // dist output
      mkpkg('libs/memory-core/dist'); // dist output
      mkpkg('node_modules/dep'); // node_modules
      mkpkg('packages/sox-nx/dist.staging-999'); // atomic-tsc scratch
      mkpkg('packages/sox-nx/dist.prev-999'); // atomic-tsc rollback remnant
      mkpkg('libs/memory-core/bundle.staging-1234'); // bundle-extension scratch
      mkpkg('libs/memory-core/bundle.prev-999'); // bundle-extension remnant

      const dirs = workspacePackageDirs(root).map((d) => path.relative(root, d));
      expect(dirs.sort()).toEqual([
        'extensions/commands/di-command',
        'libs/memory-core',
        'packages/sox-nx',
        'tools/baseline-capture',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] for a root with no package-bearing base dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scan-empty-'));
    try {
      expect(workspacePackageDirs(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is sorted and deterministic', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scan-det-'));
    try {
      for (const rel of ['libs/zz', 'libs/aa', 'packages/mm', 'apps/sox']) {
        const dir = path.join(root, rel);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
      }
      const a = workspacePackageDirs(root);
      const b = workspacePackageDirs(root);
      expect(a).toEqual(b);
      expect(a).toEqual([...a].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
