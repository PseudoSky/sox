/**
 * libs/install-engine/src/manifest-path-escape.bug-epic-manifest-path-escape-001.spec.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001 — RED->GREEN regression for install-engine's
 * 3 cited sites (install.ts manifest.entrypoint joins) plus the CLI-argument
 * `descriptor.ext` join in declarativeInstall's agent file-drop path.
 *
 * A test asserting only a normalized STRING is insufficient (per the item's
 * acceptance criteria) — the symlink-escape case below exercises the real
 * filesystem resolution path, not a string comparison.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchArtifact } from './install.js';
import { PathEscapeError } from './path-safety.js';

// NOTE: declarativeInstall's host lookup is `require('@adhd/sox-host-registry')`
// at call time, which does NOT resolve under source-mode vitest (the same
// documented constraint as mcp-project-sync.spec.ts and data-paths.ts — the
// require gets rewritten to a relative dist path only by the post-tsc build
// step, scripts/rewrite-paths.cjs). The CLI-argument `descriptor.ext` escape
// through declarativeInstall's agent file-drop path is covered end-to-end
// against the BUILT CLI by
// apps/sox/src/manifest-path-escape-cli.bug-epic-manifest-path-escape-001.spec.ts
// (same harness convention as agent-file-drop.bl566.spec.ts). This file covers
// the two manifest.entrypoint sites that ARE reachable in source-mode: they
// sit in fetchArtifact, which has no host-registry dependency.


let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-path-escape-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(extDir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
}

describe('fetchArtifact — manifest.entrypoint escape (install.ts:~280 / ~370)', () => {
  it('REFUSES a manifest declaring entrypoint "../../evil.txt" (literal ../ escape)', async () => {
    const extDir = path.join(tmp, 'extensions', 'evil-ext');
    writeManifest(extDir, { id: 'evil-ext', version: '0.1.0', type: 'skill', entrypoint: '../../evil.txt' });
    fs.writeFileSync(path.join(tmp, 'evil.txt'), 'i-should-never-be-read-as-this-extensions-checksum-content');

    await expect(fetchArtifact(`file://${extDir}`)).rejects.toThrow(PathEscapeError);
  });

  it('REFUSES a manifest declaring an entrypoint that is a symlink pointing outside the extension dir', async () => {
    const extDir = path.join(tmp, 'extensions', 'evil-ext-symlink');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret-file-outside-extension-dir');
    writeManifest(extDir, { id: 'evil-ext-symlink', version: '0.1.0', type: 'skill', entrypoint: 'link-out' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(extDir, 'link-out'));

    // A test asserting only a normalized path STRING would pass here even on
    // vulnerable code, because "extDir/link-out" reads as "inside extDir" —
    // only real filesystem resolution (realpathSync) catches the escape.
    await expect(fetchArtifact(`file://${extDir}`)).rejects.toThrow(PathEscapeError);
  });

  it('accepts a manifest whose entrypoint stays inside the extension dir', async () => {
    const extDir = path.join(tmp, 'extensions', 'good-ext');
    writeManifest(extDir, { id: 'good-ext', version: '0.1.0', type: 'skill', entrypoint: 'SKILL.md' });
    fs.writeFileSync(path.join(extDir, 'SKILL.md'), '# fine');

    const result = await fetchArtifact(`file://${extDir}`);
    expect(result.bytes.toString('utf8')).toBe('# fine');
  });
});

