#!/usr/bin/env node
/**
 * build-index.ts — Registry index builder
 *
 * Contract (Section 4.3):
 *   - Inputs: all extension.json under extensions/; for published entries, resolved npm-CDN URL
 *     and artifact bytes (to compute sha256).
 *   - Outputs: registry/index.json — array of {id,type,version,title,description,source,checksum,compatibility}
 *   - source points to npm CDN (or file:// for local); checksum is "sha256:<hex>"
 *   - private:true extensions are excluded (not an error)
 *   - An extension.json failing schema validation aborts with the offending path
 *   - Side effects: writes registry/index.json; may fetch published artifacts to checksum them.
 *     Runs post-publish in CI.
 */

import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * BL-390: raised when `buildIndex` is asked to hash artifacts out of a dirty
 * working tree without `allowDirty`. A dedicated Error (not `process.exit`)
 * so library callers (tests, future tooling) can catch it instead of the
 * process dying mid-suite — only the CLI entry point below turns it into
 * `process.exit(1)`.
 */
export class DirtyTreeError extends Error {}

interface ExtensionManifest {
  $schema: string;
  id: string;
  version?: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  license: string;
  entrypoint?: string;
  author?: string;
  private?: boolean;
  checksum?: string;
  requires?: {
    tool_calling?: boolean;
    structured_output?: boolean;
    min_context_tokens?: number;
  };
  tags?: string[];
  capabilities?: string[];
  /** G-B: bundle members. Present iff type=='bundle'. Indexed like any extension. */
  members?: Array<{ id: string }>;
  /** R9: "public" (default) or "internal" (bundle member, not independently installable). */
  visibility?: 'public' | 'internal';
  /** R9: populated when visibility is "internal". The owning bundle's id. */
  bundle_id?: string;
}

export interface IndexEntry {
  id: string;
  type: string;
  version?: string;
  title: string;
  description: string;
  /** npm CDN URL or file:// path or https:// URL */
  source: string;
  /** sha256:<hex> — computed from artifact bytes */
  checksum: string;
  compatibility: { host: string };
  /** Populated only if the entry has requires fields */
  requires?: ExtensionManifest['requires'];
  /** G-B: populated for bundle type; the members this bundle expands to at install time */
  members?: ExtensionManifest['members'];
  /** R9: "public" (default if absent) or "internal" (bundle member, not independently installable). */
  visibility?: 'public' | 'internal';
  /** R9: populated when visibility is "internal". The owning bundle's id. */
  bundleId?: string;
  /**
   * BL-390: the commit sha the working tree was at when this entry's checksum
   * was computed. Suffixed `+dirty` when the tree had uncommitted changes and
   * the run was forced with `--allow-dirty` (see `provisional`). Absent when
   * `root` is not a git repository at all (e.g. some test fixtures).
   */
  builtFromCommit?: string;
  /**
   * BL-390: true iff this entry's checksum was computed from a dirty working
   * tree via `--allow-dirty`. A provisional entry's checksum cannot be
   * reproduced from any commit and should not be trusted as a supply-chain
   * integrity record — it exists only so the run doesn't silently pretend
   * otherwise.
   */
  provisional?: boolean;
}

/** BL-390: git state of `root`, used to gate/stamp registry entries. */
interface GitState {
  isGitRepo: boolean;
  dirty: boolean;
  commitSha: string | null;
  /** Relative paths, uncommitted (staged + unstaged + untracked), CHECKSUM-RELEVANT only. */
  dirtyFiles: string[];
  /** Dirty files skipped as provably checksum-irrelevant (docs, agent scratch). Reported, never hidden. */
  ignoredDirtyCount?: number;
}

function getGitState(root: string): GitState {
  const runGit = (args: string): string =>
    execSync(`git ${args}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  let commitSha: string | null;
  try {
    commitSha = runGit('rev-parse HEAD').trim();
  } catch {
    // Not a git repo (or no commits yet) — nothing to gate or stamp.
    return { isGitRepo: false, dirty: false, commitSha: null, dirtyFiles: [], ignoredDirtyCount: 0 };
  }

  // -uall: list files inside a wholly-untracked directory individually rather
  // than collapsing to the directory name — an agent's uncommitted new
  // extension dir must show up as its actual files, not just "extensions/".
  const statusOut = runGit('status --porcelain -uall');
  const dirtyFiles = statusOut
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    // porcelain lines are "XY <path>" (or "XY <old> -> <new>" for renames)
    .map((line) => line.slice(3));

  const relevant = dirtyFiles.filter(isChecksumRelevant);
  return {
    isGitRepo: true,
    dirty: relevant.length > 0,
    commitSha,
    dirtyFiles: relevant,
    ignoredDirtyCount: dirtyFiles.length - relevant.length,
  };
}

/**
 * BL-390's gate refused on ANY dirty file. In a shared checkout that means one agent's
 * uncommitted `docs/research/**` notes block every other agent's deploy — the gate fires on
 * changes that provably cannot alter a single byte of any checksummed artifact. That is the same
 * over-broad-scope shape as BL-407 (the smoke-test exports preflight ran workspace-wide before the
 * `--extension` filter was applied), and it has the same consequence: a correct-in-principle guard
 * that people route around, after which it protects nothing.
 *
 * This narrows the gate to paths that can actually enter a checksum. It **fails closed** — anything
 * not explicitly listed here counts as relevant — because the cost of wrongly ignoring a file is a
 * blessed checksum that corresponds to no commit (the BL-393 hazard), while the cost of wrongly
 * including one is only an unnecessary refusal.
 *
 * Note what is deliberately NOT ignored: `extensions/**` markdown. A skill ships its `SKILL.md` and
 * that file IS part of the checksummed payload, so a blanket `*.md` rule would be wrong.
 */
const CHECKSUM_IRRELEVANT_PREFIXES = [
  'docs/', // project documentation — never packaged into an extension
  '.claude/', // agent worktrees, session scratch, local skills
  '.opencode/', // dispatch artifacts
  '.worktrees/', // repo convention for experimental worktrees
  '.nx/', // nx cache
];

/** Root-level documents that are never part of any extension payload. */
const CHECKSUM_IRRELEVANT_ROOT_FILES = new Set([
  'BACKLOG.md',
  'CHANGELOG.md',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'DOD.md',
]);

function isChecksumRelevant(file: string): boolean {
  // Rename lines arrive as "old -> new"; judge the destination.
  const p = (file.includes(' -> ') ? file.slice(file.indexOf(' -> ') + 4) : file).trim();
  if (CHECKSUM_IRRELEVANT_ROOT_FILES.has(p)) return false;
  return !CHECKSUM_IRRELEVANT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  // BL-80: service is a first-class type; extensions/services/ must be scanned.
  services: 'service',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  // G-B: bundles are indexed like any extension; they are expanded at install time.
  bundles: 'bundle',
};

function computeFileChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

function computeBytesChecksum(bytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Returns extension dirs paired with optional bundle context.
 * bundleId is set when the dir is a member of a bundle (detected by filesystem location).
 */
function findExtensionDirs(root: string): Array<{ extPath: string; bundleId?: string }> {
  const dirs: Array<{ extPath: string; bundleId?: string }> = [];

  // Primary scan: extensions/<type>/<id>/extension.json
  const extensionsRoot = path.join(root, 'extensions');
  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;

      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        const manifestPath = path.join(extPath, 'extension.json');
        if (fs.existsSync(manifestPath)) {
          // R9: for bundles, also scan members/ subdirectory
          if (typeDir === 'bundles') {
            dirs.push({ extPath });
            const membersPath = path.join(extPath, 'members');
            if (fs.existsSync(membersPath) && fs.statSync(membersPath).isDirectory()) {
              for (const memberId of fs.readdirSync(membersPath)) {
                const memberPath = path.join(membersPath, memberId);
                if (!fs.statSync(memberPath).isDirectory()) continue;
                const memberManifestPath = path.join(memberPath, 'extension.json');
                if (fs.existsSync(memberManifestPath)) {
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
  }

  // Secondary scan: apps/<name>/extension.json
  // First-party CLI tools (e.g. apps/sox) are self-hosted extensions; they live
  // outside extensions/ but still declare an extension.json to be discoverable.
  const appsRoot = path.join(root, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const appName of fs.readdirSync(appsRoot)) {
      const appPath = path.join(appsRoot, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;
      const manifestPath = path.join(appPath, 'extension.json');
      if (fs.existsSync(manifestPath)) {
        dirs.push({ extPath: appPath });
      }
    }
  }

  return dirs;
}

/**
 * Determine the source URL for an extension.
 * For published extensions: npm CDN URL.
 * For local/unpublished extensions: file:// path.
 *
 * The NPM package name convention: @adhd/sox-extension-<id>
 */
function resolveSource(extDir: string, manifest: ExtensionManifest): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string; private?: boolean };
    const pkgName = pkg.name ?? `@adhd/sox-extension-${manifest.id}`;

    // D-D / Slice 3 — PUBLICATION SIGNAL. Set SOX_REGISTRY_PUBLISH (e.g. "npm")
    // in the publish flow (CI post-`changeset publish`, or the offline acceptance
    // harness) to emit a PORTABLE npm-package locator instead of a checkout-bound
    // file:// path. This is the signal that was previously gated on a never-set
    // `manifest.checksum` (the dormant CDN branch). The fetcher's `npm-package:`
    // install mode runs a real `npm install` so transitive NATIVE deps
    // (better-sqlite3, sqlite-vec) resolve on the target — which the single-file
    // CDN fetch cannot deliver. ADR-0003/0005: the version here only SELECTS the
    // bytes; the checksum (resolveChecksum, unchanged) is the integrity authority.
    // Only NON-PRIVATE packages are actually published to npm. A private package
    // (example/test fixture, internal-only extension) is never on the registry, so
    // emitting an `npm-package:` locator for it would dangle (npm 404 on install).
    // Those keep a checkout-bound file:// source — clearly not installable from npm.
    if (process.env['SOX_REGISTRY_PUBLISH'] && pkg.private !== true) {
      return `npm-package:${pkgName}@${resolveDisplayVersion(extDir)}`;
    }

    // Legacy single-file CDN signal (pure-JS only): kept for back-compat. Gated on
    // an explicit manifest.checksum, which the publish flow does not set.
    if (manifest.checksum) {
      return `https://cdn.jsdelivr.net/npm/${pkgName}@${resolveDisplayVersion(extDir)}/dist/index.js`;
    }
  }
  // Default (local development): checkout-bound file:// path.
  return `file://${extDir}`;
}

/**
 * ADR-0003 Decision 6: the registry's `version` is a DERIVED, display-only label.
 * Sourced from the nx `package.json` (release bookkeeping) — the single source —
 * never from `extension.json` (which no longer carries a version). Absent
 * package.json ⇒ '0.0.0' placeholder (display chrome only; never a gate input).
 */
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

/**
 * Compute checksum for the extension.
 * For a file:// source: checksum the content file (src/index.ts or prompt.md).
 * For a published extension: use the checksum already in the manifest.
 * For unpublished: compute from local content file.
 */
function resolveChecksum(extDir: string, manifest: ExtensionManifest): string {
  // If the manifest already has a checksum (set by CI on publish), use it
  if (manifest.checksum && /^sha256:[0-9a-f]{64}$/.test(manifest.checksum)) {
    return manifest.checksum;
  }

  // C4: checksum the declared entrypoint (the built artifact), not the TS source.
  // Resolution order mirrors fetchArtifact in install.ts — must stay in sync:
  //  1. manifest.entrypoint (explicit: dist/index.js, SKILL.md, org-agent.md, …)
  //  2. dist/index.js (built artifact fallback for code types)
  //  3. prompt.md (declarative prompt types)
  //  4. extension.json (final fallback)
  if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
    const declared = path.join(extDir, manifest.entrypoint);
    if (fs.existsSync(declared)) return computeFileChecksum(declared);
  }

  const distJs = path.join(extDir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return computeFileChecksum(distJs);

  const promptMd = path.join(extDir, 'prompt.md');
  if (fs.existsSync(promptMd)) return computeFileChecksum(promptMd);

  // Fallback: checksum the extension.json itself
  return computeFileChecksum(path.join(extDir, 'extension.json'));
}

export function buildIndex(opts: { root: string; allowDirty?: boolean }): IndexEntry[] {
  const { root, allowDirty = false } = opts;

  // BL-390: `registry:sync-index` must not bless a checksum computed from a
  // tree state no commit can reproduce. Refuse outright unless the caller
  // explicitly opts into a provisional run.
  const gitState = getGitState(root);
  if (gitState.isGitRepo && (gitState.ignoredDirtyCount ?? 0) > 0) {
    // Say so out loud. A guard that silently narrows its own scope is how the next person
    // concludes it covered something it did not.
    console.error(
      `build-index: ignoring ${gitState.ignoredDirtyCount} dirty file(s) that cannot affect a ` +
        `checksum (docs/, .claude/, .opencode/, .worktrees/, .nx/, root-level *.md).`,
    );
  }
  if (gitState.isGitRepo && gitState.dirty && !allowDirty) {
    const shown = gitState.dirtyFiles.slice(0, 20).map((f) => `    ${f}`).join('\n');
    const rest = gitState.dirtyFiles.length > 20
      ? `\n    ...and ${gitState.dirtyFiles.length - 20} more`
      : '';
    throw new DirtyTreeError(
      `build-index: REFUSING to run against a dirty working tree (BL-390).\n` +
      `  A checksum computed now would not correspond to any commit — no one could\n` +
      `  answer "was this artifact built from this source?" after the fact.\n` +
      `  ${gitState.dirtyFiles.length} uncommitted change(s) at ${root}:\n${shown}${rest}\n` +
      `  Fix: commit (or let the owning agent commit) the pending changes, then re-run.\n` +
      `  Escape hatch: buildIndex({ allowDirty: true }) / CLI \`--allow-dirty\` stamps every\n` +
      `  entry \`provisional: true\` with \`builtFromCommit\` suffixed "+dirty" instead of refusing.`,
    );
  }

  const dirs = findExtensionDirs(root);
  const entries: IndexEntry[] = [];

  for (const { extPath: extDir, bundleId: detectedBundleId } of dirs) {
    const manifestPath = path.join(extDir, 'extension.json');

    let manifest: ExtensionManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
    } catch (e) {
      console.error(`build-index: ERROR parsing ${manifestPath}: ${String(e)}`);
      process.exit(1);
    }

    // Validate required fields. ADR-0003: `version` is NO LONGER required — identity
    // is `id` + content checksum; the registry's version is a derived display label.
    const requiredFields = ['id', 'type', 'title', 'description', 'compatibility'];
    for (const field of requiredFields) {
      if (!(field in manifest)) {
        console.error(
          `build-index: ERROR ${manifestPath} missing required field "${field}" — aborting`,
        );
        process.exit(1);
      }
    }

    // Skip private extensions
    if (manifest.private === true) {
      console.log(`build-index: skipping private extension "${manifest.id}" at ${extDir}`);
      continue;
    }

    const source = resolveSource(extDir, manifest);

    // Under the publication signal, a source that is STILL file:// means the package
    // is private/unpublished (resolveSource only emits an npm-package: locator for a
    // non-private, published package). Such an extension is not installable from npm,
    // so OMIT it from the PORTABLE/published registry entirely — never ship an entry
    // with a checkout-bound /Users path in the embedded CLI registry (the fresh-machine
    // "no /Users path" + "no dangling npm-package:" invariants).
    if (process.env['SOX_REGISTRY_PUBLISH'] && source.startsWith('file://')) {
      console.log(`build-index: [publish] omitting unpublished extension "${manifest.id}" (private / no npm package)`);
      continue;
    }

    const checksum = resolveChecksum(extDir, manifest);

    const entry: IndexEntry = {
      id: manifest.id,
      type: manifest.type,
      // ADR-0003 Decision 6: derived display-only label (from package.json), never
      // an identity/integrity input. Resolution/lockfile/bundles never read it.
      version: resolveDisplayVersion(extDir),
      title: manifest.title,
      description: manifest.description,
      source,
      checksum,
      compatibility: manifest.compatibility,
    };

    if (manifest.requires && Object.keys(manifest.requires).length > 0) {
      entry.requires = manifest.requires;
    }

    // G-B: include members for bundle type so the install client can expand without re-reading disk
    if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
      entry.members = manifest.members;
    }

    // R9: auto-set visibility for bundle members detected by filesystem location.
    // Members at extensions/bundles/<bundle-id>/members/<member-id>/ are always internal.
    // The extension.json visibility field is the source of truth; filesystem detection
    // is a fallback that ensures correctness even if extension.json omits the field.
    if (detectedBundleId !== undefined) {
      entry.visibility = 'internal';
      entry.bundleId = detectedBundleId;
    } else if (manifest.visibility === 'internal') {
      entry.visibility = 'internal';
      if (manifest.bundle_id !== undefined) {
        entry.bundleId = manifest.bundle_id;
      }
    }

    // BL-390: record the commit sha this entry's checksum was computed against,
    // so "does this artifact correspond to this source?" is answerable later.
    if (gitState.isGitRepo && gitState.commitSha) {
      entry.builtFromCommit = gitState.dirty ? `${gitState.commitSha}+dirty` : gitState.commitSha;
      if (gitState.dirty) entry.provisional = true;
    }

    entries.push(entry);
  }

  // Write registry/index.json
  const registryDir = path.join(root, 'registry');
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }
  const indexPath = path.join(registryDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  console.log(`build-index: wrote ${entries.length} entries to ${indexPath}`);
  return entries;
}

// Utility: compute sha256 from fetched URL (for P4 npm CDN artifacts)
export async function checksumUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return computeBytesChecksum(buf);
}

// CLI entry point.
//
// Guarded to run only when this file is executed directly (`tsx
// scripts/build-index.ts`), not when it's `import`ed — build-index.test.ts
// imports `buildIndex` for in-process testing, and prior to BL-390 this tail
// ran unconditionally on import too, silently writing registry/index.json as
// a side effect of loading the module (see the "kept standalone" comment in
// check-registry-sync.ts, which avoided importing this file specifically
// because of that). Un-guarding it here also means the DirtyTreeError thrown
// above would fire on every test run in a shared, routinely-dirty checkout —
// which is not what a unit-test import should trigger.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);
  const allowDirty = args.includes('--allow-dirty');
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();
  try {
    buildIndex({ root, allowDirty });
  } catch (e) {
    if (e instanceof DirtyTreeError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
