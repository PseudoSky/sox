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
 * So: fetch the published tarball, hash the artifact npm actually serves, and
 * rewrite ONLY the named entry. Every other entry is preserved byte-for-byte.
 *
 * The derivation is verified, not assumed: sha256 of `@adhd/sox-cli@1.2.1`'s
 * `dist/index.js` in the published tarball is
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
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(repoRoot, 'registry', 'index.json');

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
console.error(`repin: fetching ${pkgName}@${version} from npm…`);
try {
  execFileSync('npm', ['pack', `${pkgName}@${version}`, '--pack-destination', work], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error(`repin: npm pack failed — is ${pkgName}@${version} actually published yet?`);
  console.error(String(e.stderr ?? e));
  process.exit(1);
}
const tgz = fs.readdirSync(work).find((f) => f.endsWith('.tgz'));
execFileSync('tar', ['xzf', path.join(work, tgz), '-C', work]);

// Mirror build-index's resolveChecksum order: declared entrypoint, else dist/index.js,
// else prompt.md, else the manifest. In the published tarball those live under package/.
const pkgDir = path.join(work, 'package');
const manifestPath = path.join(pkgDir, 'extension.json');
const candidates = [];
if (fs.existsSync(manifestPath)) {
  const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entrypoint;
  if (typeof declared === 'string' && declared.trim() !== '') candidates.push(path.join(pkgDir, declared));
}
candidates.push(
  path.join(pkgDir, 'dist', 'index.js'),
  path.join(pkgDir, 'SKILL.md'),
  path.join(pkgDir, 'prompt.md'),
  manifestPath,
);
const artifact = candidates.find((c) => fs.existsSync(c));
if (!artifact) {
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
