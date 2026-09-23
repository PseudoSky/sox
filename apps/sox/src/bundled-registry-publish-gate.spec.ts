/**
 * bundled-registry-publish-gate.spec.ts — PROD-BREAK-SOXCLI-121
 *
 * `@adhd/sox-cli@1.2.1` shipped to npm carrying an embedded registry
 * (`package/dist/registry/index.json`) with 31 entries, ZERO `npm-package:`
 * sources, 31 `file://` sources pointing at absolute paths under
 * `/Users/nix/dev/ai/sox-ecosystem/...`, `provisional: true`, and a
 * `b1dbf40522e919790a49ff152427d48552045fba+dirty` build stamp.
 *
 * Consequence on a fresh machine (no repo checkout): `loadRegistryResolved`
 * (main.ts) falls back to that embedded copy, `cmdInstall` injects it, and every
 * install dies with `install: source file not found: /Users/nix/dev/ai/...` —
 * leaking a maintainer's home directory and never reaching the checksum gate.
 *
 * Root cause: `embed-registry.cjs` blindly `copyFileSync`s whatever sits at
 * `registry/index.json`. Its own header ASSUMES the publish flow rewrote sources
 * to npm locators first — an assumption nothing enforced. No `provisional` gate
 * existed anywhere in the repo, and `apps/sox/package.json` had no
 * `prepack`/`prepublishOnly`, so a publish from a stale dev `dist/` was
 * unguarded end to end.
 *
 * These tests exec the real scripts as subprocesses (never importing the guard
 * module) so a "red" here is a genuine missing GATE, not a missing import.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const embedScript = path.join(repoRoot, 'apps', 'sox', 'scripts', 'embed-registry.cjs');
const checkScript = path.join(repoRoot, 'apps', 'sox', 'scripts', 'check-bundled-registry.cjs');

/** A well-formed, publish-shaped entry: portable locator, clean stamp. */
const GOOD_ENTRY = {
  id: 'memory-server',
  type: 'mcp-server',
  version: '1.3.3',
  title: 'Agent Memory Server',
  description: 'durable searchable memory',
  source: 'npm-package:@adhd/sox-extension-memory-server@1.3.3',
  checksum: `sha256:${'a'.repeat(64)}`,
  compatibility: { host: '>=1.0.0 <2.0.0' },
  builtFromCommit: '36dcb18f8ec099a2082eda2d508910b97d7497ba',
};

/** Exactly the shape that shipped in 1.2.1. */
const SHIPPED_121_ENTRY = {
  ...GOOD_ENTRY,
  source: 'file:///Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server',
  provisional: true,
  builtFromCommit: 'b1dbf40522e919790a49ff152427d48552045fba+dirty',
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-embed-gate-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * `spawnSync`, not `execFileSync`: the latter surfaces stderr only on a THROW,
 * so a success-path assertion about stderr would silently read `''` and pass
 * no matter what the script actually wrote. Both streams must be captured on
 * both paths for the stdout-purity assertion below to mean anything.
 */
function run(script: string, env: Record<string, string>): RunResult {
  const r = spawnSync('node', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeIndex(entries: unknown[]): string {
  const p = path.join(tmp, 'index.json');
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

/**
 * The embed step must never write a publish artifact it has not validated. The
 * overrides exist so this suite can never touch the real `apps/sox/dist/` — a
 * live artifact other agents and the local service depend on.
 */
describe('embed-registry.cjs — publish-mode gate', () => {
  const outDir = () => path.join(tmp, 'out');
  const outFile = () => path.join(outDir(), 'index.json');

  it('REFUSES a file:// source when the publish signal is set', () => {
    const src = writeIndex([SHIPPED_121_ENTRY]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: 'npm',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
    expect(r.stderr).toMatch(/file:\/\//);
    // A refused build must leave NO artifact behind — a half-written bad index
    // is exactly what gets packed later.
    expect(fs.existsSync(outFile())).toBe(false);
  });

  it('REFUSES a provisional entry when the publish signal is set', () => {
    const src = writeIndex([
      { ...GOOD_ENTRY, provisional: true },
    ]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: 'npm',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
    expect(r.stderr).toMatch(/provisional/);
  });

  it('REFUSES a +dirty build stamp when the publish signal is set', () => {
    const src = writeIndex([
      { ...GOOD_ENTRY, builtFromCommit: 'b1dbf40522e919790a49ff152427d48552045fba+dirty' },
    ]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: 'npm',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
    expect(r.stderr).toMatch(/dirty/);
  });

  it('REFUSES an empty index when the publish signal is set', () => {
    const src = writeIndex([]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: 'npm',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
  });

  it('ACCEPTS a publish-shaped index and writes it', () => {
    const src = writeIndex([GOOD_ENTRY]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: 'npm',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(fs.readFileSync(outFile(), 'utf8'))).toEqual([GOOD_ENTRY]);
  });

  it('still ALLOWS file:// for a local dev build (no publish signal)', () => {
    // `file://` is the CORRECT output of build-index's default branch. An
    // unconditional gate would break every developer build and the smoke test.
    const src = writeIndex([SHIPPED_121_ENTRY]);
    const r = run(embedScript, {
      SOX_REGISTRY_PUBLISH: '',
      SOX_EMBED_REGISTRY_SRC: src,
      SOX_EMBED_REGISTRY_OUT: outFile(),
    });

    expect(r.status).toBe(0);
    expect(fs.existsSync(outFile())).toBe(true);
  });
});

/**
 * The build-time gate is worthless if the build does not run — and "a stale dev
 * dist/ was packed without a rebuild" is the leading candidate for how 1.2.1
 * happened. The publish-time gate reads the artifact as it sits on disk, so it
 * fires no matter how the artifact got there.
 */
describe('check-bundled-registry.cjs — publish-time (prepack) gate', () => {
  it('REFUSES the exact index that shipped in sox-cli@1.2.1', () => {
    const r = run(checkScript, { SOX_BUNDLED_REGISTRY_PATH: writeIndex([SHIPPED_121_ENTRY]) });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
    expect(r.stderr).toMatch(/file:\/\//);
  });

  it('REFUSES a missing embedded registry outright', () => {
    const r = run(checkScript, {
      SOX_BUNDLED_REGISTRY_PATH: path.join(tmp, 'does-not-exist.json'),
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BUNDLED-REGISTRY-GATE/);
  });

  it('ACCEPTS a publish-shaped embedded registry', () => {
    const r = run(checkScript, { SOX_BUNDLED_REGISTRY_PATH: writeIndex([GOOD_ENTRY]) });

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/check-bundled-registry: OK/);
  });

  it('writes NOTHING to stdout, so `npm pack --dry-run --json` stays parseable', () => {
    // This runs as prepack. PUBLISHING.md's tarball proof is
    // `npm pack --dry-run --json`, and npm interleaves a lifecycle script's
    // stdout into that JSON — an informational line on stdout here makes the
    // documented proof unparseable. Caught live: the first version of this
    // script logged its OK line to stdout and broke exactly that command.
    const r = run(checkScript, { SOX_BUNDLED_REGISTRY_PATH: writeIndex([GOOD_ENTRY]) });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('is wired as prepack AND prepublishOnly so no publish path can skip it', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps', 'sox', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    // prepack covers `npm pack` (PUBLISHING.md's tarball proof) and pnpm/npm
    // publish; prepublishOnly covers the npm publish path belt-and-braces.
    // `changeset publish` shells out to one of those, so both are covered.
    expect(pkg.scripts?.['prepack']).toMatch(/check-bundled-registry\.cjs/);
    expect(pkg.scripts?.['prepublishOnly']).toMatch(/check-bundled-registry\.cjs/);
  });

  it('release:prepared carries the publish signal INTO `nx build sox`', () => {
    // The build-time gate is conditional on SOX_REGISTRY_PUBLISH. `release:prepared`
    // originally set that variable inline on `build-index:publish` ONLY, so the
    // very build that produces the published artifact ran without the signal and
    // skipped the gate entirely. The signal must span the build too.
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const prepared = root.scripts['release:prepared'];

    expect(prepared).toMatch(/SOX_REGISTRY_PUBLISH=npm\s+nx build sox/);

    // And the env var must be part of the build's nx cache key, or a cache hit
    // could replay a dev-shaped dist straight into the publish.
    const proj = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps', 'sox', 'project.json'), 'utf8'),
    ) as { targets: { build: { inputs: unknown[] } } };

    expect(proj.targets.build.inputs).toContainEqual({ env: 'SOX_REGISTRY_PUBLISH' });
  });

  it('passes against the real apps/sox/dist artifact currently on disk', () => {
    // Guards the live artifact: if someone leaves a dev-shaped index in
    // apps/sox/dist/, this goes red BEFORE a publish is attempted.
    const r = run(checkScript, {});

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
