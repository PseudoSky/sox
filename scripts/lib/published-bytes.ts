/**
 * scripts/lib/published-bytes.ts — published-bytes verdict logic (pure).
 *
 * WHY THIS EXISTS
 * ---------------
 * Backlog fbde8dda-d6ed-4b6b-9cde-9495351a7c35: four registry rows
 * (memory-server, memory-cli, memory-flush, sox) carried checksums computed
 * from LOCAL disk bytes while their `npm-package:<name>@<version>` locator
 * still pointed at an EARLIER published version. npm kept serving the old
 * bytes; `fetchArtifact` gates the install on the moved pin, so every install
 * died with CHECKSUM MISMATCH. Fixed in 304513c4 by repointing the four
 * checksums at the published bytes — with nothing to stop recurrence.
 *
 * Backlog 3df6f848-c5c4-4cf3-92dc-6490fb043fde: the generators
 * (`pnpm build-index`, `registry:sync-index`, `release:prepared`,
 * `clean-room-smoke.sh`) all recompute checksums from local disk, so a local
 * rebuild WITHOUT a version bump silently re-pins the row and re-breaks it.
 *
 * A post-publish-only check is a tautology: in CI, `release:prepared` hashes
 * the same bytes it then packs and publishes (CI's bytes vs CI's bytes) and
 * would have passed on exactly the four rows that took production down. The
 * outage class is packages that were NOT published in that run. So this check
 * compares EVERY `npm-package:` row against what npm CURRENTLY SERVES, and is
 * not gated on any publication signal.
 *
 * DERIVATION — WHAT THE INSTALL PATH ACTUALLY HASHES
 * --------------------------------------------------
 * The install path does NOT hash the tarball. It npm-installs the package and
 * hashes exactly ONE file inside it:
 *   libs/install-engine/src/install.ts:472-478  npm-package: branch
 *     -> fetchNpmPackage(spec, storeDir)                          :379-405
 *     -> :404 returns resolveEntrypointFile(pkgDir)
 *     -> :477 bytes = readFileSync(entryFile)
 *     -> :498 checksum = computeChecksum(bytes)
 * `resolveEntrypointFile` (install.ts:334-359) resolves in order:
 *   manifest.entrypoint -> dist/index.js -> prompt.md -> SKILL.md -> extension.json
 * Hashing the whole tarball instead would produce a guaranteed 6/6 false
 * MISMATCH. `resolveEntrypointFromPackageDir` below mirrors that order exactly.
 *
 * BL-33 NOTE: extracting this module does NOT break the "faithful read-only
 * mirror" invariant of scripts/check-registry-sync.ts. That invariant is about
 * never importing scripts/build-index.ts (top-level write side-effect) and
 * never diverging the directory walk / checksum derivation of the DISK mirror.
 * Nothing here touches the disk mirror; this compares the COMMITTED registry
 * rows against the npm registry. Do not "fix" it by inlining it back.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RegistryEntry {
  id: string;
  version?: string;
  source: string;
  checksum: string;
}

export type Verdict = 'MATCH' | 'MISMATCH' | 'ERROR' | 'UNREACHABLE';

export interface RowResult {
  id: string;
  spec: string;
  pkgName: string;
  pkgVersion: string;
  entrypoint: string | null;
  expected: string;
  actual: string | null;
  verdict: Verdict;
  detail?: string;
}

export interface CheckResult {
  rows: RowResult[];
  /** true when at least one row reached the npm registry successfully. */
  registryReachable: boolean;
  /** No row reached npm at all — "could not reach npm", NOT "bytes differ". */
  unreachable: boolean;
  mismatches: number;
  errors: number;
  matches: number;
}

/**
 * Fetches the published package for `name@version` and returns the path of the
 * extracted package directory (the tarball's `package/` root). MUST throw on
 * any failure — a swallowed error here is how this gate becomes theatre.
 */
export type PackageFetcher = (name: string, version: string) => Promise<string>;

export function computeChecksum(bytes: Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse `npm-package:<name>@<version>`. Scoped names contain a second `@`, so
 * this splits on the LAST one — mirroring install.ts fetchNpmPackage:381.
 */
export function parseNpmPackageLocator(source: string): { name: string; version: string } | null {
  if (!source.startsWith('npm-package:')) return null;
  const spec = source.slice('npm-package:'.length);
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Mirror of install.ts resolveEntrypointFile (:334-359), applied to the
 * EXTRACTED PUBLISHED package dir. The published extension.json governs —
 * if it declares a different `entrypoint` than the local copy, the install
 * path follows the published one, so this must too.
 */
export function resolveEntrypointFromPackageDir(dir: string): string {
  const extJson = path.join(dir, 'extension.json');
  if (fs.existsSync(extJson)) {
    let manifest: { entrypoint?: string } | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(extJson, 'utf8')) as { entrypoint?: string };
    } catch { /* unparseable — fall through to the artifact chain, as install.ts does */ }
    if (manifest !== undefined && typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
      const declared = path.resolve(dir, manifest.entrypoint);
      // install.ts assertWithinBase equivalent: never read outside the package dir.
      const base = path.resolve(dir) + path.sep;
      if (!declared.startsWith(base)) {
        throw new Error(`published entrypoint escapes package dir: ${manifest.entrypoint}`);
      }
      if (fs.existsSync(declared)) return declared;
    }
  }
  const distJs = path.join(dir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return distJs;
  const promptMd = path.join(dir, 'prompt.md');
  if (fs.existsSync(promptMd)) return promptMd;
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd)) return skillMd;
  return extJson;
}

/**
 * COVERAGE BASELINE — the committed `registry/published-coverage.json`.
 *
 * `expectedNpmRows` is redundant with `ids.length` ON PURPOSE: a hand-edit that
 * adds an id without moving the count (or vice versa) is a half-finished edit,
 * and `checkPublishedCoverage` refuses it rather than picking a winner.
 */
export interface CoverageBaseline {
  expectedNpmRows: number;
  ids: string[];
}

export interface CoverageVerdict {
  ok: boolean;
  /** Baseline ids with no `npm-package:` row in the registry — scope LOST. */
  missing: string[];
  /** `npm-package:` rows absent from the baseline — scope GROWN unreviewed. */
  unexpected: string[];
  actual: string[];
  /** Populated when the baseline itself is internally inconsistent. */
  baselineError?: string;
}

/**
 * Assert the gate's verified-row set against its committed baseline.
 *
 * SET EQUALITY, not superset. A superset assertion would let growth through
 * silently, and growth is exactly the event that needs a human to look: a newly
 * published package entering the gate should cost one deliberate line in
 * `registry/published-coverage.json`. Loss is the outage direction — a row that
 * loses its `npm-package:` locator stops being verified at all, and the gate
 * used to report that narrowing as a pass.
 *
 * Pure: no I/O, no process state.
 */
export function checkPublishedCoverage(
  entries: RegistryEntry[],
  baseline: CoverageBaseline,
): CoverageVerdict {
  const actual = selectNpmPackageEntries(entries).map((e) => e.id).sort();
  const expected = [...baseline.ids].sort();

  const baselineError =
    !Array.isArray(baseline.ids) || typeof baseline.expectedNpmRows !== 'number'
      ? 'coverage baseline is malformed: it must carry `expectedNpmRows` (number) and `ids` (string[])'
      : baseline.expectedNpmRows !== baseline.ids.length
        ? `coverage baseline is self-inconsistent: expectedNpmRows=${baseline.expectedNpmRows} but ids has ${baseline.ids.length} entries`
        : new Set(expected).size !== expected.length
          ? 'coverage baseline lists a duplicate id'
          : undefined;

  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));

  return {
    ok: baselineError === undefined && missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
    actual,
    ...(baselineError === undefined ? {} : { baselineError }),
  };
}

/** Select the `npm-package:` rows of a committed registry. */
export function selectNpmPackageEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter((e) => typeof e.source === 'string' && e.source.startsWith('npm-package:'));
}

/**
 * Compare every `npm-package:` row's committed checksum against the bytes npm
 * currently serves for the version in its own locator.
 *
 * Reachability discriminator (the whole point — conflating these two is how
 * the gate becomes theatre):
 *   - If ANY row fetched successfully, the npm registry is reachable. A
 *     per-row failure after that (404 "no such version", extraction failure,
 *     missing entrypoint) is a HARD FAILURE (`ERROR`), never UNREACHABLE.
 *   - Only when NO row could be fetched at all do we report UNREACHABLE,
 *     i.e. "could not reach npm" as distinct from "npm says bytes differ".
 */
export async function checkPublishedBytes(
  entries: RegistryEntry[],
  fetchPackage: PackageFetcher,
): Promise<CheckResult> {
  const targets = selectNpmPackageEntries(entries);
  const rows: RowResult[] = [];
  const failures: Array<{ index: number; detail: string }> = [];
  let registryReachable = false;

  for (const entry of targets) {
    const parsed = parseNpmPackageLocator(entry.source);
    if (parsed === null) {
      rows.push({
        id: entry.id, spec: entry.source, pkgName: '', pkgVersion: '',
        entrypoint: null, expected: entry.checksum, actual: null,
        verdict: 'ERROR', detail: 'unparseable npm-package locator',
      });
      continue;
    }

    let pkgDir: string;
    try {
      pkgDir = await fetchPackage(parsed.name, parsed.version);
      registryReachable = true;
    } catch (e) {
      const index = rows.length;
      rows.push({
        id: entry.id, spec: entry.source, pkgName: parsed.name, pkgVersion: parsed.version,
        entrypoint: null, expected: entry.checksum, actual: null,
        verdict: 'ERROR', detail: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      failures.push({ index, detail: 'fetch failed' });
      continue;
    }

    try {
      const entryFile = resolveEntrypointFromPackageDir(pkgDir);
      const actual = computeChecksum(fs.readFileSync(entryFile));
      rows.push({
        id: entry.id, spec: entry.source, pkgName: parsed.name, pkgVersion: parsed.version,
        entrypoint: path.relative(pkgDir, entryFile),
        expected: entry.checksum, actual,
        verdict: actual === entry.checksum ? 'MATCH' : 'MISMATCH',
      });
    } catch (e) {
      rows.push({
        id: entry.id, spec: entry.source, pkgName: parsed.name, pkgVersion: parsed.version,
        entrypoint: null, expected: entry.checksum, actual: null,
        verdict: 'ERROR', detail: `entrypoint hash failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Promote the "nobody reached npm" case to UNREACHABLE. If even one row
  // succeeded, every fetch failure stays a hard ERROR.
  const unreachable = targets.length > 0 && !registryReachable && failures.length === targets.length;
  if (unreachable) {
    for (const f of failures) {
      const row = rows[f.index];
      if (row !== undefined) row.verdict = 'UNREACHABLE';
    }
  }

  return {
    rows,
    registryReachable,
    unreachable,
    mismatches: rows.filter((r) => r.verdict === 'MISMATCH').length,
    errors: rows.filter((r) => r.verdict === 'ERROR').length,
    matches: rows.filter((r) => r.verdict === 'MATCH').length,
  };
}
