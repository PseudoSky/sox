/**
 * scripts/lib/npm-published-fetcher.ts — the NETWORK half of the
 * published-bytes gate (backlog fbde8dda-d6ed-4b6b-9cde-9495351a7c35).
 *
 * Kept separate from scripts/lib/published-bytes.ts so the verdict logic stays
 * pure and unit-testable with a stubbed fetcher: CI's unit test must never
 * depend on npm being up. The LIVE check is the CI job; the unit test pins the
 * comparison logic.
 *
 * The registry used is the AMBIENT one (npm config / .npmrc / NPM_CONFIG_REGISTRY),
 * matching install.ts fetchNpmPackage's documented behaviour (:390-396) — public
 * npm in production, a local verdaccio in the offline acceptance test. We shell
 * out to `npm view` rather than hard-coding registry.npmjs.org precisely so a
 * verdaccio-scoped run checks the bytes that run would actually install.
 *
 * This module NEVER writes to registry/index.json or to the repo — it extracts
 * published tarballs into a caller-supplied temp dir and nothing else. Nothing
 * here belongs inside scripts/build-index.ts: verification is not generation,
 * and build-index generation must remain free of any remote-fetch path.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageFetcher } from './published-bytes.js';

/**
 * Build a PackageFetcher that resolves the published tarball for name@version,
 * downloads it, extracts it, and returns the extracted `package/` dir.
 *
 * Throws on ANY failure (no such version, network down, bad tarball). The
 * caller (checkPublishedBytes) is what distinguishes "npm unreachable" from
 * "this one package failed" — never swallow an error here to fake a skip.
 */
export function createNpmPublishedFetcher(opts?: { cacheDir?: string }): PackageFetcher {
  const cacheDir = opts?.cacheDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sox-published-bytes-'));
  fs.mkdirSync(cacheDir, { recursive: true });

  return async (name: string, version: string): Promise<string> => {
    const spec = `${name}@${version}`;
    // --fetch-retries=0: an unreachable registry must fail FAST and be reported
    // as UNREACHABLE, not sit in npm's multi-minute exponential backoff.
    const tarballUrl = execFileSync('npm', ['view', spec, 'dist.tarball', '--fetch-retries=0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (tarballUrl === '') {
      throw new Error(`npm view returned no dist.tarball for ${spec}`);
    }

    const resp = await fetch(tarballUrl);
    if (!resp.ok) {
      throw new Error(`tarball fetch failed for ${tarballUrl}: ${resp.status} ${resp.statusText}`);
    }
    const bytes = Buffer.from(await resp.arrayBuffer());

    const slot = path.join(cacheDir, `${name.replace(/[@/]/g, '_')}-${version}`);
    fs.rmSync(slot, { recursive: true, force: true });
    fs.mkdirSync(slot, { recursive: true });
    const tgz = path.join(slot, 'package.tgz');
    fs.writeFileSync(tgz, bytes);
    execFileSync('tar', ['-xzf', tgz, '-C', slot], { stdio: ['ignore', 'pipe', 'pipe'] });

    const pkgDir = path.join(slot, 'package');
    if (!fs.existsSync(pkgDir)) {
      throw new Error(`extracted tarball for ${spec} has no package/ root at ${pkgDir}`);
    }
    return pkgDir;
  };
}
