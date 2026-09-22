import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Install-level proof for `@adhd/sox-hybrid-search`'s optional loadability
 * (ADR-0019 / BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001).
 *
 * The load-level guard (`optional-loadability.spec.ts`) proves the module graph
 * never *resolves* the heavy two. This spec proves the INSTALL-level half, which
 * is a separate failure: a hard transitive dependency re-installs the heavy
 * packages under `--omit=optional`, so the load-level fix is unreachable unless
 * the manifest declares them `optionalDependencies`.
 *
 * It does a REAL install, no mocks:
 *   1. `pnpm pack` hybrid-search into a temp dir.
 *   2. Build a temp consumer depending on the packed tarball (`file:`), then run
 *      `pnpm install --omit=optional --ignore-scripts`.
 *   3. Import the INSTALLED `node_modules/@adhd/sox-hybrid-search/dist/index.js`,
 *      call `fuse()`, assert a fused result.
 * A second temp consumer installed with NO `--omit=optional` is the positive
 * control (the heavy directories must be present), proving the absence
 * assertion is not vacuous. A third child run calls `createCrossEncoder()` in
 * the omitted tree and asserts the rejection names the specifier.
 *
 * Requires registry access to fetch the packed tarball's mandatory deps
 * (`graph-store`, `store-adapter`, …). If the registry is unreachable the spec
 * FAILS LOUDLY — no skip: per the repo's rule, a test that never ran is a
 * comment. `--ignore-scripts` avoids native builds and is sufficient because the
 * child only imports hybrid-search's pure surface (graph-store is type-only at
 * runtime, so no DB is opened).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');
const probeScript = path.join(here, '__tests__', 'fixtures', 'install-consumer-probe.mjs');

const HEAVY = ['@adhd/sox-vector-store', '@adhd/sox-embedding-provider'] as const;
const INSTALL_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 60_000;

const tempRoots: string[] = [];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* teardown must never mask a result */
    }
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, timeout: number): RunResult {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Find any installed heavy package directory anywhere in the consumer tree.
 * pnpm keeps transitive deps under `node_modules/.pnpm/…`, not at the top
 * level, so a shallow check would miss them (or, worse, pass vacuously). The
 * walk does not follow symlinks — the real package dirs live under `.pnpm` and
 * are reached directly, and not following avoids cycles.
 */
function findHeavyDirs(root: string): string[] {
  const found: string[] = [];
  // Bare package names — the `@adhd/` scope is the directory we check under.
  const targets = new Set<string>(HEAVY.map((h) => h.slice(h.indexOf('/') + 1)));
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // skips symlinks (isDirectory() is false for them)
      const full = path.join(dir, e.name);
      if (e.name === '@adhd') {
        for (const t of targets) {
          const candidate = path.join(full, t);
          if (fs.existsSync(candidate)) found.push(candidate);
        }
      }
      stack.push(full);
    }
  }
  return found;
}

function writeConsumer(root: string, tarball: string): void {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'hybrid-omit-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { '@adhd/sox-hybrid-search': `file:${tarball}` },
      },
      null,
      2,
    ),
  );
}

let tarball = '';
let omittedRoot = '';
let defaultRoot = '';
let omittedInstall: RunResult | null = null;
let defaultInstall: RunResult | null = null;

describe('install-level optional loadability — a --omit=optional install must not contain the native chain', () => {
  beforeAll(() => {
    try {
      // Fail LOUDLY rather than skip — a missing artifact must turn the suite red.
      if (!fs.existsSync(distEntry)) {
        throw new Error(
          `built artifact missing at ${distEntry}. This spec packs and installs the real package, so the ` +
            `'build' target must run first — the test target declares dependsOn: ["^build", "build"].`,
        );
      }

      const packDir = mkTemp('sox-hybrid-pack-');
      const pack = run('pnpm', ['pack', '--pack-destination', packDir], packageRoot, 120_000);
      if (pack.status !== 0) {
        throw new Error(`pnpm pack failed (exit ${String(pack.status)}):\n${pack.stderr}`);
      }
      const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (!tgz) throw new Error(`pnpm pack produced no tarball in ${packDir}`);
      tarball = path.join(packDir, tgz);

      omittedRoot = mkTemp('sox-hybrid-omit-');
      writeConsumer(omittedRoot, tarball);
      omittedInstall = run(
        'pnpm',
        ['install', '--omit=optional', '--ignore-scripts'],
        omittedRoot,
        INSTALL_TIMEOUT_MS,
      );
      // Older pnpm spells the flag `--no-optional`.
      if (omittedInstall.status !== 0) {
        omittedInstall = run(
          'pnpm',
          ['install', '--no-optional', '--ignore-scripts'],
          omittedRoot,
          INSTALL_TIMEOUT_MS,
        );
      }

      defaultRoot = mkTemp('sox-hybrid-default-');
      writeConsumer(defaultRoot, tarball);
      defaultInstall = run('pnpm', ['install', '--ignore-scripts'], defaultRoot, INSTALL_TIMEOUT_MS);
    } catch (err) {
      cleanup();
      throw err;
    }
  }, 900_000);

  afterAll(() => {
    cleanup();
  });

  it('omitted install: neither heavy directory exists, and fuse() runs', () => {
    const install = omittedInstall!;
    expect(
      install.status,
      `pnpm install --omit=optional failed:\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    ).toBe(0);

    // ABSENCE — the fix. If the manifest regresses to hard `dependencies`, the
    // heavy dirs reappear here and this goes RED (the documented negative control).
    expect(findHeavyDirs(omittedRoot)).toEqual([]);

    const installedDist = path.join(
      omittedRoot,
      'node_modules',
      '@adhd',
      'sox-hybrid-search',
      'dist',
      'index.js',
    );
    expect(fs.existsSync(installedDist), `installed dist missing at ${installedDist}`).toBe(true);

    const probe = run(process.execPath, [probeScript, installedDist, 'pure'], omittedRoot, PROBE_TIMEOUT_MS);
    const detail = `exit=${String(probe.status)}\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`;
    expect(probe.status, detail).toBe(0);

    const payload = JSON.parse(probe.stdout.trim()) as { ok: boolean; fused: number[]; normalized: number[] };
    expect(payload.ok).toBe(true);
    expect(payload.fused).toEqual([2, 1]);
    expect(payload.normalized).toEqual([0, 0.5, 1]);
  });

  it('positive control — a default install DOES contain both heavy directories', () => {
    const install = defaultInstall!;
    expect(
      install.status,
      `pnpm install failed:\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    ).toBe(0);

    const found = findHeavyDirs(defaultRoot).map((p) => path.basename(p));
    for (const heavy of HEAVY) {
      const bare = heavy.slice(heavy.indexOf('/') + 1);
      expect(found, `${heavy} must be installed by default`).toContain(bare);
    }
  });

  it('omitted install: createCrossEncoder degrades, naming the missing specifier', () => {
    const installedDist = path.join(
      omittedRoot,
      'node_modules',
      '@adhd',
      'sox-hybrid-search',
      'dist',
      'index.js',
    );
    const probe = run(
      process.execPath,
      [probeScript, installedDist, 'cross-encoder'],
      omittedRoot,
      PROBE_TIMEOUT_MS,
    );
    const detail = `exit=${String(probe.status)}\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`;
    expect(probe.status, detail).toBe(0);

    const payload = JSON.parse(probe.stdout.trim()) as {
      ok: boolean;
      encoderError: { name: string; message: string; code: string | null };
    };
    expect(payload.ok).toBe(true);
    expect(payload.encoderError.message).toContain('@adhd/sox-embedding-provider');
    // Not a bare module-resolution error.
    expect(payload.encoderError.code).toBeNull();
  });
});
