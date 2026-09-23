// @ts-nocheck
/**
 * Registry-rule regression coverage — extensions/skills/sox-ingest/scripts/migrate-agents.mjs
 *
 * `--registry` used to rebuild `registry/index.json` via `scripts/build-index.ts
 * --allow-dirty` after scaffolding new agent extensions. That contradicts the
 * architecture decision recorded in AGENTS.md § registry is release-only: a
 * new/harvested extension has no registry row and installs from its local dir
 * with no checksum gate, so nothing should ever run build-index outside the
 * release flow. `--registry` is now refused outright — this test proves the
 * refusal is a real, observable process-exit behavior (not just a doc claim),
 * and that it happens before any path resolution, so it can never reach
 * `scripts/build-index.ts`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'migrate-agents.mjs');
// Repo root is 5 hops up from this test file: __tests__ -> scripts -> sox-ingest -> skills -> extensions -> root.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('migrate-agents --registry is refused (registry is release-only)', () => {
  it('exits non-zero with an explanatory message and never invokes build-index.ts', () => {
    const before = spawnSync('git', ['status', '--porcelain', '--', 'registry/index.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).stdout;

    // No paths given at all — if --registry were still wired to run after
    // scaffolding, this invocation would never reach it anyway (paths.length
    // === 0 exits first under the OLD code). The refusal must fire BEFORE
    // that path-count check, so this proves the flag itself is rejected,
    // not merely that there was nothing to scaffold.
    const result = spawnSync('node', [SCRIPT, '--registry'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--registry is removed/);
    expect(result.stderr).toMatch(/registry is release-only/);
    expect(result.stderr).not.toMatch(/build-index/);

    // registry/index.json must be byte-identical to before the run — proof
    // build-index.ts (which rewrites the whole file) never executed.
    const after = spawnSync('git', ['status', '--porcelain', '--', 'registry/index.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).stdout;
    expect(after).toBe(before);
  });

  it('still refuses with --registry even when combined with --dry-run', () => {
    const result = spawnSync('node', [SCRIPT, 'typescript', '--registry', '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--registry is removed/);
  });

  it('a run with no flags at all still reaches the normal "no paths" usage error (baseline — refusal is --registry-specific)', () => {
    const result = spawnSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: node scripts\/migrate-agents\.mjs/);
    expect(result.stderr).not.toMatch(/--registry is removed/);
  });
});
