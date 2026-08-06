#!/usr/bin/env node
/**
 * scripts/check-changeset-surface.ts — changeset-surface gate (BL-460)
 *
 * Fails (exit 1) when a publishable `@adhd/sox-*` package's built `dist/*.d.ts`
 * differs, byte-for-byte, from the `.d.ts` in the last version actually published
 * to the registry, and no `.changeset/*.md` in this tree names that package.
 *
 * Root cause this closes (SPEC-PKT-79 §1, BL-460): nothing in the toolchain reads
 * the shape a package is about to publish and asks "does a changeset explain this
 * delta from what's already live?" `WriteQueueMetrics` gained a required `mode`
 * discriminator (BL-445) and shipped to npm with zero `.changeset/*.md` recording
 * it — this gate is the missing check.
 *
 * Diff mechanism (Decision C, deliberately conservative): byte-level diff of each
 * `dist/*.d.ts` file against the same relative path extracted from the last
 * published tarball. Not an AST/API-surface diff — a byte diff may false-positive
 * on comment-only churn (acceptable: worst case is an unwanted "add a changeset"
 * prompt), but never false-negatives a real type change (which a normalization
 * bug in an AST differ could).
 *
 * Package selection (Decision F): the SAME predicate and directory walk as
 * `scripts/check-publishable.ts` (`pkg.private !== true && pkg.name.startsWith
 * ('@adhd/sox-')`, roots `libs/apps/extensions/packages`) — reproduced here
 * verbatim rather than imported, because `check-publishable.ts` is out of this
 * packet's file list (SPEC-PKT-79 §2 "Explicitly OUT OF BOUNDS") and must not be
 * refactored into a shared module as a side effect of this change. Keep both
 * walkers byte-identical if either changes.
 *
 * "Last published version" lookup (Decision D): registry packument fetch (same
 * fetch-based, fail-closed pattern as check-publishable.ts's registry probe) for
 * `dist-tags.latest` and that version's `dist.tarball` URL, then a plain
 * `fetch()` download of the tarball, extracted with the system `tar` binary
 * (available on every macOS/Linux dev machine and GitHub's ubuntu-latest
 * runners — avoids adding a new npm dependency just to parse the tar format).
 * Downloaded tarballs are cached indefinitely under
 * `node_modules/.cache/check-changeset-surface/<name>@<version>.tar` — a
 * published version's bytes are immutable, unlike check-publishable's 24h
 * existence-cache (existence can flip; content of an already-published version
 * never does).
 *
 * Network / missing-artifact behaviour — deliberately fail-closed (Decision D/E):
 *   --offline              never degrades to green; exits 1 unconditionally, same
 *                           policy as check-publishable.ts's --offline (a check
 *                           that goes green when it cannot verify reproduces the
 *                           exact defect class BL-460 exists to close).
 *   --registry <url>       registry base to probe (default $npm_config_registry or
 *                           https://registry.npmjs.org). Points the regression
 *                           test at a local fixture registry.
 *   --ci                   missing local dist/ for a publishable package is a
 *                           HARD FAIL (release.yml always builds before this step
 *                           runs — a missing dist/ there is a pipeline ordering
 *                           defect, not a normal state).
 *   (default, no --ci)     missing local dist/ is a WARN + SKIP — a developer
 *                           running this gate without having built everything
 *                           first should not be told to go run a (destructive,
 *                           BL-235) build themselves.
 *   registry/tarball fetch error → UNVERIFIABLE, always an ERROR (exit 1), never
 *                           a silent pass.
 *
 * Run:  npx tsx scripts/check-changeset-surface.ts [root] [--ci] [--registry url]
 * Fix:  add a `.changeset/*.md` describing the surface change, or (if the diff is
 *       comment-only / non-semantic) add a trivial changeset anyway — see the
 *       module docstring on Decision C for why this gate fails toward requiring
 *       more changesets, never fewer.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
};
const hasFlag = (name: string): boolean =>
  argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));

const positionals = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev === '--registry' || prev === '--probe-timeout-ms');
});

const root = positionals[0] ?? process.cwd();
const registryBase = (
  flagValue('registry') ??
  process.env['npm_config_registry'] ??
  'https://registry.npmjs.org'
).replace(/\/+$/, '');
const offline = hasFlag('offline') || process.env['CHECK_CHANGESET_SURFACE_OFFLINE'] === '1';
const ciMode = hasFlag('ci');
const probeTimeoutMs = Number(flagValue('probe-timeout-ms') ?? 15_000);

interface Pkg {
  name?: string;
  private?: boolean;
}

// ── package walk (mirrors scripts/check-publishable.ts:78-97 verbatim) ────────
function findPackageJsons(): string[] {
  const out: string[] = [];
  const roots = ['libs', 'apps', 'extensions', 'packages'];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'bundle') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name === 'package.json') {
        out.push(full);
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs, 0);
  }
  return out;
}

function isPublishable(pkg: Pkg): boolean {
  return pkg.private !== true && typeof pkg.name === 'string' && pkg.name.startsWith('@adhd/sox-');
}

// ── pending changeset packages (mirrors check-publishable.ts:114-146) ─────────
function pendingChangesetPackages(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(root, '.changeset');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m?.[1]) continue;
    for (const line of m[1].split(/\r?\n/)) {
      const dep = /^\s*["']?(@?[^"':]+)["']?\s*:\s*\w+/.exec(line);
      if (dep?.[1]) out.add(dep[1].trim());
    }
  }
  return out;
}

// ── local dist walk ─────────────────────────────────────────────────────────
// Returns paths relative to the PACKAGE ROOT (e.g. "dist/index.d.ts"), not to
// `distDir` itself — this must match the tarball layout (`package/dist/...`)
// so extractDtsFromTarball() can look the same relative path up under `package/`.
function listDtsFilesRelativeToPkgRoot(distDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(full, relPath);
      } else if (e.name.endsWith('.d.ts')) {
        out.push(relPath);
      }
    }
  };
  walk(distDir, 'dist');
  return out.sort();
}

// ── registry packument fetch ────────────────────────────────────────────────
interface Packument {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string } }>;
}

type PackumentResult =
  | { ok: true; packument: Packument }
  | { ok: false; notFound: true }
  | { ok: false; error: string };

async function fetchPackument(name: string): Promise<PackumentResult> {
  const url = `${registryBase}/${name.replace('/', '%2f')}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, error: `registry returned HTTP ${res.status} for ${url}` };
    const body = (await res.json()) as Packument;
    return { ok: true, packument: body };
  } catch (e) {
    return { ok: false, error: `packument fetch of ${url} failed: ${(e as Error).message}` };
  }
}

const cacheDir = path.join(root, 'node_modules', '.cache', 'check-changeset-surface');

function sanitizeCacheKey(name: string, version: string): string {
  return `${name.replace(/\//g, '__')}@${version}.tar`;
}

async function downloadTarball(
  tarballUrl: string,
  cacheFile: string,
): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
  // Immutable cache: a published version's bytes never change once published.
  if (fs.existsSync(cacheFile)) {
    try {
      return { ok: true, buf: fs.readFileSync(cacheFile) };
    } catch {
      /* fall through to re-download */
    }
  }
  try {
    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (!res.ok) return { ok: false, error: `tarball fetch HTTP ${res.status} for ${tarballUrl}` };
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, cacheFile);
    } catch {
      /* cache is an optimization; never fail the gate on a cache-write error */
    }
    return { ok: true, buf };
  } catch (e) {
    return { ok: false, error: `tarball download of ${tarballUrl} failed: ${(e as Error).message}` };
  }
}

/** Extracts `package/<rel>` for each wanted relative path from a downloaded npm tarball. */
function extractDtsFromTarball(
  tarBuf: Buffer,
  wantRelPaths: string[],
): { ok: true; files: Map<string, Buffer> } | { ok: false; error: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-changeset-surface-extract-'));
  try {
    const tarFile = path.join(tmpDir, 'pkg.tgz');
    fs.writeFileSync(tarFile, tarBuf);
    const res = spawnSync('tar', ['-xzf', tarFile, '-C', tmpDir], { encoding: 'utf8' });
    if (res.error) return { ok: false, error: `tar extraction failed to spawn: ${res.error.message}` };
    if (res.status !== 0) {
      return { ok: false, error: `tar extraction exited ${res.status}: ${res.stderr || res.stdout}` };
    }
    const files = new Map<string, Buffer>();
    for (const rel of wantRelPaths) {
      const full = path.join(tmpDir, 'package', rel);
      if (fs.existsSync(full)) files.set(rel, fs.readFileSync(full));
    }
    return { ok: true, files };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const allPkgPaths = findPackageJsons();

  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let checked = 0;
  let skippedNoDist = 0;

  const publishablePkgs: { name: string; dir: string; distDir: string }[] = [];
  for (const pkgPath of allPkgPaths) {
    let pkg: Pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Pkg;
    } catch {
      continue;
    }
    if (!isPublishable(pkg)) continue;
    const dir = path.dirname(pkgPath);
    publishablePkgs.push({ name: pkg.name as string, dir, distDir: path.join(dir, 'dist') });
  }

  const withDist = publishablePkgs.filter((p) => {
    if (!fs.existsSync(p.distDir)) {
      if (ciMode) {
        errors.push(
          `"${p.name}": no local dist/ present at ${path.relative(root, p.distDir)} — release.yml ` +
            'builds every package before this gate runs (see .github/workflows/release.yml "Build ' +
            'all packages" / "Test all packages" steps), so a missing dist/ here in --ci mode is a ' +
            'pipeline-ordering defect, not an expected state.',
        );
      } else {
        warnings.push(
          `"${p.name}": no local dist/ at ${path.relative(root, p.distDir)} — skipping (run a build ` +
            'first if you want this package checked; not required for this gate to pass locally).',
        );
        skippedNoDist++;
      }
      return false;
    }
    return true;
  });

  if (offline) {
    console.error(
      'check-changeset-surface: FAIL — OFFLINE MODE. The registry surface-diff probe did not run,\n' +
        `  so ${withDist.length} publishable package(s) with a local dist/ are UNVERIFIED against their\n` +
        '  last-published .d.ts shape. This exit is deliberate: passing here would reproduce the exact\n' +
        '  defect (a green check over a type change that shipped without a changeset) that this gate\n' +
        '  exists to prevent. Re-run with network access, or point --registry at a reachable mirror.',
    );
    process.exit(1);
  }

  const pending = pendingChangesetPackages();

  for (const p of withDist) {
    checked++;
    const relDtsPaths = listDtsFilesRelativeToPkgRoot(p.distDir);
    if (relDtsPaths.length === 0) {
      notes.push(`"${p.name}": dist/ has no *.d.ts files — nothing to diff.`);
      continue;
    }

    const packumentResult = await fetchPackument(p.name);
    if (!packumentResult.ok) {
      if ('notFound' in packumentResult) {
        notes.push(`"${p.name}": not yet on ${registryBase} (first publish) — nothing to diff against.`);
        continue;
      }
      errors.push(`UNVERIFIABLE: "${p.name}" — ${packumentResult.error}. This gate fails closed rather than assuming no drift.`);
      continue;
    }

    const packument = packumentResult.packument;
    const latest = packument['dist-tags']?.['latest'];
    const tarballUrl = latest ? packument.versions?.[latest]?.dist?.tarball : undefined;
    if (!latest || !tarballUrl) {
      errors.push(`UNVERIFIABLE: "${p.name}" — packument from ${registryBase} has no dist-tags.latest / dist.tarball to compare against.`);
      continue;
    }

    const cacheFile = path.join(cacheDir, sanitizeCacheKey(p.name, latest));
    const tarball = await downloadTarball(tarballUrl, cacheFile);
    if (!tarball.ok) {
      errors.push(`UNVERIFIABLE: "${p.name}"@${latest} — ${tarball.error}. This gate fails closed rather than assuming no drift.`);
      continue;
    }

    const extracted = extractDtsFromTarball(tarball.buf, relDtsPaths);
    if (!extracted.ok) {
      errors.push(`UNVERIFIABLE: "${p.name}"@${latest} — ${extracted.error}. This gate fails closed rather than assuming no drift.`);
      continue;
    }

    const diffFiles: string[] = [];
    for (const rel of relDtsPaths) {
      const localBuf = fs.readFileSync(path.join(p.dir, rel));
      const publishedBuf = extracted.files.get(rel);
      if (publishedBuf === undefined || !localBuf.equals(publishedBuf)) diffFiles.push(rel);
    }

    if (diffFiles.length === 0) {
      notes.push(`"${p.name}": dist/*.d.ts unchanged from published ${latest}.`);
      continue;
    }

    if (pending.has(p.name)) {
      notes.push(
        `"${p.name}": dist/*.d.ts differs from published ${latest} (${diffFiles.join(', ')}) — ` +
          'covered by a pending changeset, publishes in this same run.',
      );
      continue;
    }

    errors.push(
      `"${p.name}": dist/*.d.ts differs from the published ${latest} (${diffFiles.join(', ')}) and no ` +
        '.changeset/*.md in this tree names this package. A public-surface change is about to ship with ' +
        'no changeset recording it (BL-460) — add one with `pnpm changeset`.',
    );
  }

  for (const n of notes) console.log(`check-changeset-surface: NOTE ${n}`);
  for (const w of warnings) console.warn(`check-changeset-surface: WARN ${w}`);

  if (errors.length > 0) {
    console.error('check-changeset-surface: FAIL — publishable surface changed with no changeset:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `check-changeset-surface: OK — ${checked} publishable package(s) with a local dist/ checked ` +
      `against ${registryBase} (${skippedNoDist} skipped, no local dist/).`,
  );
}

main().catch((e: unknown) => {
  console.error(`check-changeset-surface: FAIL — unexpected error: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
