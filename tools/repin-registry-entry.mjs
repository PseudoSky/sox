#!/usr/bin/env node
/**
 * tools/repin-registry-entry.mjs — repin ONE registry entry to PUBLISHED npm bytes.
 *
 * WHY THIS EXISTS
 * After publishing a new version, that extension's committed checksum is stale:
 * it still pins the PREVIOUS release's bytes. The obvious fix — rerun
 * `build-index` — is the defect this whole remediation was about: it recomputes
 * EVERY entry from LOCAL disk bytes, silently replacing checksums that were
 * deliberately pinned to published npm bytes (304513c4) with whatever the working
 * tree happens to hash to. `registry:sync-index` has the same failure mode.
 *
 * So: npm-install the published version, hash the entrypoint the FETCHER would
 * resolve (install.ts derivation, not a tarball hash), and
 * rewrite ONLY the named entry. Every other entry is preserved byte-for-byte.
 *
 * The derivation is verified, not assumed: the install-path checksum of
 * `@adhd/sox-cli@1.2.1` is
 * b31388ad87e96ecc72abaed48d401e7fd26c3e2ae6ca036ea448e4be8717d08d, which is
 * exactly the value committed for the `sox` entry.
 *
 * Usage:
 *   node tools/repin-registry-entry.mjs --id sox --version 1.2.2 [--dry-run]
 *   node tools/repin-registry-entry.mjs --id memory-server --version 1.3.4
 *
 * `--dry-run` prints the computed checksum and the diff it WOULD apply, and
 * writes nothing. Run it first, always.
 *
 * Commit the result by explicit pathspec: `git commit registry/index.json -m ...`
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(repoRoot, 'registry', 'index.json');

/**
 * Byte-for-byte mirror of install.ts resolveEntrypointFile (libs/install-engine,
 * ~:334-359): manifest.entrypoint, then dist/index.js, then prompt.md, then
 * SKILL.md, then extension.json. Order matters — prompt.md precedes SKILL.md.
 *
 * ⛔ CONFORMANCE-PINNED — held identical to the other four copies by
 * `scripts/entrypoint-resolution-conformance.test.ts`. Exported (and the whole
 * CLI body below moved behind a main-guard) so that test can call it without
 * the module's argv parsing and `process.exit` running on import.
 *
 * Throws (rather than `process.exit`) on an escaping entrypoint, matching
 * install.ts `assertWithinBase` and published-bytes.resolveEntrypointFromPackageDir;
 * `main()` converts it back to the same stderr + exit 1 the CLI always had.
 */
export function resolveEntrypointFile(dir) {
  const extJson = path.join(dir, 'extension.json');
  if (fs.existsSync(extJson)) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(extJson, 'utf8'));
    } catch { /* unparseable — fall through to the artifact chain */ }
    const declared = manifest?.entrypoint;
    if (typeof declared === 'string' && declared.trim() !== '') {
      const resolved = path.resolve(dir, declared);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error(`repin: manifest entrypoint "${declared}" escapes the package dir — refusing.`);
      }
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  for (const rel of [path.join('dist', 'index.js'), 'prompt.md', 'SKILL.md']) {
    const c = path.join(dir, rel);
    if (fs.existsSync(c)) return c;
  }
  return extJson;
}

function main() {
  function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  }
  const id = arg('id');
  const version = arg('version');
  const dryRun = process.argv.includes('--dry-run');

  if (!id || !version) {
    console.error('usage: repin-registry-entry.mjs --id <extension-id> --version <published-version> [--dry-run]');
    process.exit(2);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = index.find((e) => e.id === id);
  if (!entry) {
    console.error(`repin: no entry with id "${id}" in registry/index.json`);
    process.exit(1);
  }

  // The registry source carries the npm package name; derive it rather than
  // re-deriving the @adhd/sox-extension-<id> convention, which `sox` does not follow.
  const m = /^npm-package:(.+)@[^@]+$/.exec(String(entry.source));
  if (!m) {
    console.error(`repin: entry "${id}" has source "${entry.source}", which is not an npm-package: locator.`);
    console.error('repin: only published entries can be pinned to published bytes.');
    process.exit(1);
  }
  const pkgName = m[1];

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-'));

  // DERIVATION: mirror the INSTALL PATH, not a tarball hash. `npm-package:` mode
  // runs a real `npm install` and then checksums the resolved entrypoint inside
  // node_modules (install.ts resolveEntrypointFile / fetchArtifact). Hashing the
  // .tgz member directly happens to agree today, but it is a DIFFERENT derivation
  // and would silently diverge the moment a package gains an install lifecycle
  // step, a files/ filter change, or a postinstall that rewrites dist. The
  // fetcher's value is the one that gates real installs, so it is the only one
  // that may be committed.
  console.error(`repin: npm install ${pkgName}@${version} (install-path derivation)…`);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'repin-probe', private: true }));
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', `${pkgName}@${version}`], {
      cwd: work,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error(`repin: npm install failed — is ${pkgName}@${version} actually published yet?`);
    console.error(String(e.stderr ?? e));
    process.exit(1);
  }
  const pkgDir = path.join(work, 'node_modules', ...pkgName.split('/'));
  if (!fs.existsSync(pkgDir)) {
    console.error(`repin: installed tree has no ${pkgName} at ${pkgDir}`);
    process.exit(1);
  }

  const artifact = resolveEntrypointFile(pkgDir);
  if (!fs.existsSync(artifact)) {
    console.error(`repin: could not locate a checksummable artifact inside ${pkgName}@${version}`);
    process.exit(1);
  }

  const checksum = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}`;
  const before = { checksum: entry.checksum, version: entry.version, source: entry.source };
  const after = {
    checksum,
    version,
    source: `npm-package:${pkgName}@${version}`,
  };

  console.error(`repin: artifact ${path.relative(pkgDir, artifact)}`);
  console.error(`repin: ${id}`);
  for (const k of ['version', 'source', 'checksum']) {
    const changed = before[k] !== after[k];
    console.error(`  ${changed ? '~' : '='} ${k}: ${before[k]}${changed ? `  ->  ${after[k]}` : ''}`);
  }

  if (before.checksum === after.checksum && before.version === after.version && before.source === after.source) {
    console.error('repin: no change — already pinned to these published bytes.');
    process.exit(0);
  }
  if (dryRun) {
    console.error('repin: --dry-run, nothing written.');
    process.exit(0);
  }

  entry.checksum = after.checksum;
  entry.version = after.version;
  entry.source = after.source;
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.error(`repin: wrote registry/index.json (ONLY the "${id}" entry changed).`);
  console.error('repin: commit by explicit pathspec — git commit registry/index.json -m "..."');
}

// Main-guard: this module is imported by the entrypoint-resolution conformance
// test; importing it must not parse argv, npm-install anything, or exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
