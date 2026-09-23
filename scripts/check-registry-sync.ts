#!/usr/bin/env node
/**
 * scripts/check-registry-sync.ts — Registry drift gate
 *
 * TWO GATES, ONE OF THEM RETIRED FROM CI. Read this before wiring anything:
 *
 * 1. DRIFT GATE (default mode, `runDriftGate`) — compares registry/index.json
 *    against a walk of the manifests on disk. It is NOT wired into any CI
 *    workflow, deliberately, and its remediation advice ("re-sync with
 *    registry:sync-index") must never be followed to "fix" a red gate.
 *    Registry-vs-disk equality is the WRONG invariant: the registry is a
 *    PUBLICATION PIN, not a mirror of the working tree. `resolveSource` below
 *    only emits `npm-package:` locators under SOX_REGISTRY_PUBLISH — a
 *    release-path signal — so outside a release the disk side yields file:// /
 *    jsdelivr rows and cannot equal the committed publication rows by
 *    construction (measured: 31 disk rows vs 6 registry rows). Running a
 *    generator to satisfy it re-pins every checksum from local disk bytes,
 *    which is the CHECKSUM MISMATCH outage itself. ci.yml/validate.yml used to
 *    do exactly that; the step is gone and its absence is enforced by
 *    scripts/ci-no-generator-in-verify.test.ts. This mode survives as a local
 *    diagnostic ONLY.
 *
 *    Use as a local diagnostic:
 *      npx tsx scripts/check-registry-sync.ts
 *
 * 2. PUBLISHED-BYTES GATE + ITS COVERAGE ASSERTION — what CI actually runs.
 *    See below.
 *
 * SECOND GATE — PUBLISHED-BYTES ASSERTION (backlog
 * fbde8dda-d6ed-4b6b-9cde-9495351a7c35 / 3df6f848-c5c4-4cf3-92dc-6490fb043fde):
 * every `npm-package:` row is also compared against WHAT NPM CURRENTLY SERVES
 * for the version in its own locator. This catches the outage class the drift
 * gate structurally cannot: a local rebuild with no version bump keeps the
 * correct locator while the generator silently re-pins `checksum` to new LOCAL
 * bytes; npm keeps serving the old bytes and `fetchArtifact` gates the install
 * on the moved pin (memory-server@1.3.3: 4ea74857 vs 6a4168d7). A
 * post-publish-only check would be a tautology — in CI, `release:prepared`
 * hashes the same bytes it then packs and publishes — so this is NOT gated on
 * any publication signal.
 *   npx tsx scripts/check-registry-sync.ts --published-bytes-only   # CI gate
 *   npx tsx scripts/check-registry-sync.ts --no-remote              # offline
 * Verification is not generation: this is read-only and network-only HERE.
 * scripts/build-index.ts must remain free of any remote-fetch path.
 *
 * BL-33: this scanner MUST mirror `scripts/build-index.ts` exactly — same
 * directory walk (INCLUDING recursion into extensions/bundles/<id>/members/),
 * same source/checksum/version/visibility/bundleId derivation. Any divergence
 * re-introduces false drift. It is kept standalone (no import of build-index,
 * which has a top-level write side-effect) but is a faithful read-only mirror.
 */

import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createNpmPublishedFetcher } from './lib/npm-published-fetcher.js';
import {
  checkPublishedBytes,
  checkPublishedCoverage,
  selectNpmPackageEntries,
  type CoverageBaseline,
  type RegistryEntry,
} from './lib/published-bytes.js';

// BL-480: default root must mirror build-index.ts's git-common-dir resolution
// (never `process.cwd()`) — this scanner recomputes `source` via the same
// `file://${extDir}` derivation, so a divergent default here reintroduces
// exactly the false-drift/worktree-path corruption BL-480 fixed in
// build-index.ts, breaking the BL-33 mirror invariant this file's header
// comment commits to.
function resolveDefaultRoot(): string {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(gitCommonDir, '..');
  } catch {
    return process.cwd();
  }
}

/**
 * ⛔ NO MODULE-SCOPE EXECUTION BELOW THIS POINT.
 *
 * This file is a CLI gate AND an importable module: its entrypoint-resolution
 * copy is pinned against the other four by
 * `scripts/entrypoint-resolution-conformance.test.ts`. Argv parsing, the
 * registry read, and the `process.exit(1)` that used to live at module scope
 * would have run — and killed the test process — on a bare `import`. They are
 * now performed by `initCliState()`, which only `main()` calls.
 *
 * `--published-bytes-only` runs ONLY the published-bytes assertion (plus its
 * coverage check) and skips the disk-drift comparison. That is the mode CI
 * wires in, deliberately — see the header's gate 1/gate 2 note.
 *
 * `--allow-empty` is the only way an empty verified-row set passes.
 *
 * `--no-remote` (or SOX_SKIP_PUBLISHED_BYTES=1) is the EXPLICIT offline opt-out.
 * It is the ONLY thing that makes an un-run published check a pass. A network
 * failure never silently becomes a skip — see the UNREACHABLE handling below.
 */
let publishedBytesOnly = false;
let noRemote = false;
let allowEmpty = false;
let root = '';
let committedRaw = '';
let committedRawEntries: unknown[] = [];
let committedEntries: unknown[] = [];

function initCliState(): void {
  const argv = process.argv.slice(2);
  publishedBytesOnly = argv.includes('--published-bytes-only');
  noRemote = argv.includes('--no-remote') || process.env['SOX_SKIP_PUBLISHED_BYTES'] === '1';
  // `--allow-empty` is the ONLY way an empty verified-row set is a pass. It
  // exists for a registry that legitimately publishes nothing (a fresh fork),
  // and it must be typed by a human every time.
  allowEmpty = argv.includes('--allow-empty');
  root = argv.find((a) => !a.startsWith('--')) ?? resolveDefaultRoot();

  // Read the current committed registry
  const registryPath = path.join(root, 'registry', 'index.json');
  if (!fs.existsSync(registryPath)) {
    console.error('check-registry-sync: registry/index.json not found — run npx nx run registry:sync-index first');
    process.exit(1);
  }

  committedRaw = fs.readFileSync(registryPath, 'utf8');
  committedRawEntries = JSON.parse(committedRaw) as unknown[];

  // BL-390: a committed `provisional: true` entry means someone ran sync-index
  // with `--allow-dirty` and its checksum was NOT built from committed source.
  // That is a legitimate escape hatch, not a drift failure — but it must not
  // pass silently, or the whole point of stamping it is lost.
  const provisionalIds = committedRawEntries
    .filter((e) => (e as { provisional?: boolean }).provisional === true)
    .map((e) => (e as { id: string }).id);
  if (provisionalIds.length > 0) {
    console.warn(
      `check-registry-sync: WARNING — ${provisionalIds.length} committed entr${provisionalIds.length === 1 ? 'y is' : 'ies are'} ` +
      `provisional (built from a dirty tree via --allow-dirty): ${provisionalIds.join(', ')}`,
    );
    console.warn('  Re-run `npx nx run registry:sync-index` against a clean tree to replace with a reproducible checksum.');
  }

  committedEntries = stripProvenanceFields(committedRawEntries);
}

// ─── Mirror of scripts/build-index.ts (read-only) ────────────────────────────

// MUST match scripts/build-index.ts DIR_TO_TYPE exactly (BL-33 mirror invariant).
// Any type added to build-index MUST be added here in the same commit.
const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  // BL-80: service is a first-class type; extensions/services/ must be scanned.
  services: 'service',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  bundles: 'bundle',
};

interface Manifest {
  id: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  private?: boolean;
  checksum?: string;
  entrypoint?: string;
  requires?: Record<string, unknown>;
  members?: Array<{ id: string }>;
  visibility?: 'public' | 'internal';
  bundle_id?: string;
}

function computeFileChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Directory walk — mirrors build-index.findExtensionDirs (BL-33 fix):
 *   extensions/<type>/<id>/ and, for type=bundles, ALSO
 *   extensions/bundles/<bundle-id>/members/<member-id>/, plus apps/<name>/.
 */
function findExtDirs(): Array<{ extPath: string; bundleId?: string }> {
  const dirs: Array<{ extPath: string; bundleId?: string }> = [];

  const extensionsRoot = path.join(root, 'extensions');
  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;

      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        if (!fs.existsSync(path.join(extPath, 'extension.json'))) continue;

        if (typeDir === 'bundles') {
          dirs.push({ extPath });
          // BL-33: recurse into members/ so bundle members are not false-flagged.
          const membersPath = path.join(extPath, 'members');
          if (fs.existsSync(membersPath) && fs.statSync(membersPath).isDirectory()) {
            for (const memberId of fs.readdirSync(membersPath)) {
              const memberPath = path.join(membersPath, memberId);
              if (!fs.statSync(memberPath).isDirectory()) continue;
              if (fs.existsSync(path.join(memberPath, 'extension.json'))) {
                dirs.push({ extPath: memberPath, bundleId: extId });
              }
            }
          }
        } else {
          dirs.push({ extPath });
        }
      }
    }
  }

  const appsRoot = path.join(root, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const appName of fs.readdirSync(appsRoot)) {
      const appPath = path.join(appsRoot, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;
      if (fs.existsSync(path.join(appPath, 'extension.json'))) {
        dirs.push({ extPath: appPath });
      }
    }
  }

  return dirs;
}

/** Mirror of build-index.resolveDisplayVersion (ADR-0003 Decision 6). */
function resolveDisplayVersion(extDir: string): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch { /* fall through */ }
  }
  return '0.0.0';
}

/** Mirror of build-index.resolveSource (incl. the Slice 3 publication signal). */
function resolveSource(extDir: string, manifest: Manifest): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; private?: boolean };
    const pkgName = pkg.name ?? `@adhd/sox-extension-${manifest.id}`;
    // Mirror build-index: only NON-PRIVATE (published) packages get an npm-package: locator.
    if (process.env['SOX_REGISTRY_PUBLISH'] && pkg.private !== true) {
      return `npm-package:${pkgName}@${resolveDisplayVersion(extDir)}`;
    }
    if (manifest.checksum) {
      return `https://cdn.jsdelivr.net/npm/${pkgName}@${resolveDisplayVersion(extDir)}/dist/index.js`;
    }
  }
  return `file://${extDir}`;
}

/**
 * Mirror of build-index.resolveEntrypointPath.
 *
 * ⛔ CONFORMANCE-PINNED — see `scripts/entrypoint-resolution-conformance.test.ts`.
 * `libs/install-engine/src/install.ts resolveEntrypointFile` is the authority.
 */
export function resolveEntrypointPath(extDir: string, manifest: Pick<Manifest, 'entrypoint'>): string {
  if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
    const declared = path.join(extDir, manifest.entrypoint);
    // Mirror install.ts assertWithinBase / build-index: an escaping entrypoint
    // is a hard failure, never a silently-hashed out-of-tree file.
    if (!path.resolve(declared).startsWith(path.resolve(extDir) + path.sep)) {
      throw new Error(`entrypoint escapes the extension dir: ${manifest.entrypoint}`);
    }
    if (fs.existsSync(declared)) return declared;
  }
  const distJs = path.join(extDir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return distJs;
  // prompt.md precedes SKILL.md — order matters.
  const promptMd = path.join(extDir, 'prompt.md');
  if (fs.existsSync(promptMd)) return promptMd;
  const skillMd = path.join(extDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) return skillMd;
  return path.join(extDir, 'extension.json');
}

/** Mirror of build-index.resolveChecksum (C4 entrypoint resolution order). */
function resolveChecksum(extDir: string, manifest: Manifest): string {
  if (manifest.checksum && /^sha256:[0-9a-f]{64}$/.test(manifest.checksum)) {
    return manifest.checksum;
  }
  return computeFileChecksum(resolveEntrypointPath(extDir, manifest));
}

function buildLiveEntries(): unknown[] {
  const entries: unknown[] = [];

  for (const { extPath: extDir, bundleId: detectedBundleId } of findExtDirs()) {
    const manifestPath = path.join(extDir, 'extension.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch (e) {
      console.error(`check-registry-sync: ERROR parsing ${manifestPath}: ${String(e)}`);
      process.exit(1);
    }

    if (manifest.private === true) continue;

    const source = resolveSource(extDir, manifest);

    // Mirror build-index: under the publication signal, omit any entry whose source
    // is still file:// (private / unpublished package — not installable from npm).
    if (process.env['SOX_REGISTRY_PUBLISH'] && source.startsWith('file://')) continue;

    const entry: Record<string, unknown> = {
      id: manifest.id,
      type: manifest.type,
      version: resolveDisplayVersion(extDir),
      title: manifest.title,
      description: manifest.description,
      source,
      checksum: resolveChecksum(extDir, manifest),
      compatibility: manifest.compatibility,
    };

    if (manifest.requires && Object.keys(manifest.requires).length > 0) {
      entry['requires'] = manifest.requires;
    }
    if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
      entry['members'] = manifest.members;
    }
    if (detectedBundleId !== undefined) {
      entry['visibility'] = 'internal';
      entry['bundleId'] = detectedBundleId;
    } else if (manifest.visibility === 'internal') {
      entry['visibility'] = 'internal';
      if (manifest.bundle_id !== undefined) entry['bundleId'] = manifest.bundle_id;
    }

    entries.push(entry);
  }

  return entries;
}

// Lazily computed: under --published-bytes-only the disk walk is not run at all.
let liveEntriesCache: unknown[] | undefined;
function liveEntriesOnce(): unknown[] {
  if (liveEntriesCache === undefined) liveEntriesCache = buildLiveEntries();
  return liveEntriesCache;
}

// BL-390: build-index.ts stamps every entry with `builtFromCommit` (and, for a
// forced dirty run, `provisional: true`) recording the git state the checksum
// was computed against. Those are per-run provenance metadata, not disk
// content — this script never shells out to git and has no live counterpart
// to compare them against. Strip both before the drift comparison so their
// mere presence (or the commit sha changing between HEAD advancing) never
// registers as false drift; the checksum/source/etc. fields they sit beside
// are still compared in full.
function stripProvenanceFields(entries: unknown[]): unknown[] {
  return entries.map((e) => {
    const { builtFromCommit: _builtFromCommit, provisional: _provisional, ...rest } =
      e as Record<string, unknown>;
    return rest;
  });
}


// Sort both by id for stable comparison
function sortedById(arr: unknown[]): unknown[] {
  return [...arr].sort((a, b) => {
    const aId = (a as { id: string }).id;
    const bId = (b as { id: string }).id;
    return aId.localeCompare(bId);
  });
}

function runDriftGate(): boolean {
  const liveEntries = liveEntriesOnce();
  const committedSorted = JSON.stringify(sortedById(committedEntries), null, 2);
  const liveSorted = JSON.stringify(sortedById(liveEntries), null, 2);

  if (committedSorted === liveSorted) {
  console.log(`check-registry-sync: OK — registry/index.json is in sync (${committedEntries.length} entries)`);
  return true;
} else {
  console.error('check-registry-sync: FAIL — registry/index.json is out of sync with disk.');
  console.error('  Extensions on disk but not in registry, or registry entries no longer on disk.');
  console.error('  Fix: npx nx run registry:sync-index && git add registry/index.json');
  console.error(`  Disk: ${liveEntries.length} entries  Registry: ${committedEntries.length} entries`);

  const committedIds = new Set(committedEntries.map((e) => (e as { id: string }).id));
  const liveIds = new Set(liveEntries.map((e) => (e as { id: string }).id));
  for (const id of liveIds) {
    if (!committedIds.has(id)) console.error(`  + on disk, missing from registry: ${id}`);
  }
  for (const id of committedIds) {
    if (!liveIds.has(id)) console.error(`  - in registry, not on disk: ${id}`);
  }
  // Same id-set but differing content (e.g. checksum/source drift): name the ids.
  for (const id of liveIds) {
    if (!committedIds.has(id)) continue;
    const live = liveEntries.find((e) => (e as { id: string }).id === id);
    const committed = committedEntries.find((e) => (e as { id: string }).id === id);
    if (JSON.stringify(live) !== JSON.stringify(committed)) {
      console.error(`  ~ content differs for: ${id}`);
    }
  }
  return false;
}
}

// ─── Published-bytes assertion (fbde8dda-d6ed-4b6b-9cde-9495351a7c35) ────────

/**
 * Load the committed coverage baseline. A MISSING baseline is a hard failure,
 * never "nothing is expected" — the whole defect being fixed here is a gate
 * that silently narrowed its own scope to zero and called that green.
 */
function loadCoverageBaseline(): CoverageBaseline | null {
  const p = path.join(root, 'registry', 'published-coverage.json');
  if (!fs.existsSync(p)) {
    console.error(
      `check-registry-sync: FAIL — coverage baseline registry/published-coverage.json not found at ${p}.\n` +
      '  It records which registry rows MUST be verified against npm. Without it this gate cannot\n' +
      '  distinguish "nothing to verify" from "everything stopped being verified".',
    );
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CoverageBaseline;
  } catch (e) {
    console.error(`check-registry-sync: FAIL — registry/published-coverage.json is unparseable: ${String(e)}`);
    return null;
  }
}

async function runPublishedBytesGate(): Promise<boolean> {
  const targets = selectNpmPackageEntries(committedRawEntries as RegistryEntry[]);

  // ── COVERAGE FIRST ──────────────────────────────────────────────────────
  // Before asking "do the bytes match", ask "are we still looking at the rows
  // we are supposed to be looking at". An all-jsdelivr registry (what an
  // unguarded `build-index` produces) has ZERO npm-package: rows, and the
  // byte comparison below would have reported that as a pass.
  const baseline = loadCoverageBaseline();
  if (baseline === null) return false;

  const coverage = checkPublishedCoverage(committedRawEntries as RegistryEntry[], baseline);
  if (!coverage.ok) {
    console.error(
      `check-registry-sync: FAIL — published-bytes coverage: expected ${baseline.ids.length} ` +
      `npm-package row${baseline.ids.length === 1 ? '' : 's'}, found ${coverage.actual.length}.`,
    );
    if (coverage.baselineError !== undefined) {
      console.error(`  ${coverage.baselineError}`);
    }
    if (coverage.missing.length > 0) {
      console.error(
        `  MISSING (no longer verified against npm — scope LOST): ${coverage.missing.join(', ')}\n` +
        '  A row loses coverage by disappearing, or by having its `npm-package:` locator rewritten to a\n' +
        '  file:// or CDN URL — which is exactly what `pnpm build-index` does to every row.',
      );
    }
    if (coverage.unexpected.length > 0) {
      console.error(
        `  UNEXPECTED (verified, but not in the baseline): ${coverage.unexpected.join(', ')}\n` +
        '  If a newly published package has legitimately entered the gate, add it to\n' +
        '  registry/published-coverage.json in the same commit. That edit is the review signal.',
      );
    }
    return false;
  }
  console.log(
    `check-registry-sync: published-bytes coverage OK — ${coverage.actual.length}/${baseline.ids.length} ` +
    'expected npm-package rows present.',
  );

  if (targets.length === 0) {
    if (!allowEmpty) {
      console.error(
        'check-registry-sync: FAIL — published-bytes has NO npm-package: rows to verify. An empty target\n' +
        '  set is never a pass: it is indistinguishable from every row having silently lost coverage.\n' +
        '  Pass --allow-empty if this registry genuinely publishes nothing.',
      );
      return false;
    }
    console.log('check-registry-sync: published-bytes — no npm-package: rows to verify (--allow-empty)');
    return true;
  }

  if (noRemote) {
    console.warn(
      `check-registry-sync: published-bytes SKIPPED by explicit --no-remote/SOX_SKIP_PUBLISHED_BYTES ` +
      `(${targets.length} npm-package row${targets.length === 1 ? '' : 's'} NOT verified against npm).`,
    );
    if (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false') {
      console.error('check-registry-sync: FAIL — --no-remote is an interactive/offline escape hatch; CI must verify published bytes.');
      return false;
    }
    return true;
  }

  const result = await checkPublishedBytes(
    targets,
    createNpmPublishedFetcher({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sox-pubbytes-')) }),
  );

  for (const r of result.rows) {
    const mark = r.verdict === 'MATCH' ? 'MATCH     ' : `${r.verdict.padEnd(10)}`;
    console.log(
      `  ${mark} ${r.id} ${r.pkgVersion} ${r.entrypoint ?? '(no entrypoint)'} ` +
      `expected=${r.expected}${r.actual !== null && r.actual !== r.expected ? ` published=${r.actual}` : ''}` +
      `${r.detail !== undefined ? ` (${r.detail})` : ''}`,
    );
  }

  // Three-state verdict. Conflating "npm says these bytes differ" with "could
  // not reach npm" is exactly how this gate would become theatre, so they are
  // reported and exited on separately:
  //   MISMATCH/ERROR -> exit 1 ALWAYS.
  //   UNREACHABLE    -> exit 1 ALWAYS (fail closed). The only pass for an
  //                     unverified registry is the explicit --no-remote flag
  //                     above, which CI itself refuses.
  // Discriminator: if ANY row fetched successfully the registry is reachable,
  // so a per-row failure (incl. 404 "no such version") is a hard ERROR, never
  // UNREACHABLE. UNREACHABLE requires that NO row reached npm at all.
  if (result.unreachable) {
    console.error(
      `check-registry-sync: FAIL (UNREACHABLE) — could not reach the npm registry for ANY of the ` +
      `${targets.length} npm-package rows. This is NOT "the bytes differ"; nothing was verified. ` +
      `Re-run with network, or pass --no-remote to explicitly accept an unverified registry locally.`,
    );
    return false;
  }

  if (result.mismatches > 0 || result.errors > 0) {
    console.error(
      `check-registry-sync: FAIL — published-bytes assertion: ${result.mismatches} MISMATCH, ` +
      `${result.errors} ERROR, ${result.matches} MATCH.`,
    );
    console.error(
      '  A MISMATCH means registry/index.json pins a checksum that npm does NOT serve for the version in its own\n' +
      '  locator — every install of that row dies with CHECKSUM MISMATCH (fbde8dda-d6ed-4b6b-9cde-9495351a7c35).\n' +
      '  This is almost always a local rebuild without a version bump: `build-index`/`registry:sync-index`/\n' +
      '  `release:prepared` re-pin the checksum from LOCAL disk bytes (3df6f848-c5c4-4cf3-92dc-6490fb043fde).\n' +
      '  Fix by PUBLISHING a new version (see PUBLISHING.md) or by restoring the checksum of the published bytes.\n' +
      '  Do NOT "fix" it by re-running a generator — that is what broke it.',
    );
    return false;
  }

  console.log(`check-registry-sync: OK — published-bytes: ${result.matches}/${targets.length} rows match npm`);
  return true;
}

async function main(): Promise<void> {
  initCliState();
  let ok = true;
  if (!publishedBytesOnly) {
    ok = runDriftGate() && ok;
  }
  ok = (await runPublishedBytesGate()) && ok;
  process.exit(ok ? 0 : 1);
}

// Main-guard: importing this module (the conformance test does) must not run
// the gate, parse argv, or call process.exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
