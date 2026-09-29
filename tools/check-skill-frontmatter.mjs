#!/usr/bin/env node
/**
 * tools/check-skill-frontmatter.mjs — validate skill manifests and the rendered
 * header artifact (bug aace3faa).
 *
 * Skill extensions used to have TWO sources of truth for their header — the
 * manifest `description` and a hand-written `SKILL.md` YAML frontmatter — and the
 * one the host surfaced was the hand-written one. The 1ceffdbf incident proved the
 * failure class: a `description` containing "backlog: product prioritizes" (a
 * colon+space in an unquoted scalar) made the frontmatter unparseable and the host
 * silently dropped the skill. The fix makes `extension.json` the single source of
 * truth: the header is rendered from the manifest at install time (by
 * libs/host-registry/src/skill-renderers.ts, mirroring agent-renderers.ts), and the
 * source `SKILL.md` is prose-only.
 *
 * This guard keeps that invariant honest with three legs, each fail-closed:
 *
 *   1. source-purity — a changed source SKILL.md must NOT begin with `---`
 *      (no hand-written frontmatter; the header is machine-rendered). This rejects
 *      the authentic pre-fix bytes at `1ceffdbf^:extensions/skills/dispatch-plan/SKILL.md`.
 *   2. manifest — id is a valid slug AND equals the directory basename; description
 *      is present and ≤1024 chars; no `render` block (skills are host-agnostic, so
 *      a per-host render override is a smell); the prose body is non-empty and bounded.
 *   3. rendered artifact — render the header via host-registry's renderSkillFile and
 *      run the off-the-shelf `skillcheck` linter (uvx) over the rendered output.
 *      Because the renderer quotes scalars safely, a colon-in-scalar description
 *      still yields parseable YAML — the colon class is immune by construction.
 *
 * Changed-file source (mirrors tools/precommit-lint.mjs):
 *   default                `git diff --cached` (the pre-commit hook's staged set).
 *   --base <ref> --head <ref>
 *                          `git diff --name-only <base> <head>` (manual / CI context).
 *   --all                  whole-tree: every tracked source SKILL.md under
 *                          extensions/skills/ and extensions/bundles/ — the build/CI
 *                          mode (a CI runner has no staged set, so the changed-file
 *                          modes would silently check nothing).
 *
 * Exit 0 when there is nothing to check or every checked file passes. Exit non-zero
 * on any source-purity / manifest violation, when `skillcheck` fails on a rendered
 * artifact, or when a required dependency (the host-registry build, or `uvx`) cannot
 * be satisfied while files are in scope — fail-closed, never a silent pass.
 *
 * Usage: node tools/check-skill-frontmatter.mjs [--base <ref> --head <ref>] [--all]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { withVerifiedGitIndex } from './lib/git-index-scope.mjs';

// This file is ESM; the host-registry build is CommonJS. createRequire lets us load
// the built dist without a static cross-package import.
const require = createRequire(import.meta.url);

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');

const SKILL_DIR = path.posix.join('extensions', 'skills');
const BUNDLE_DIR = path.posix.join('extensions', 'bundles');

/** A skill id is a lowercase kebab slug (matches the directory name it installs under). */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Maximum permitted manifest description length (the Agent Skills spec bound). */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Maximum permitted source prose body size (bytes) — a hard sanity bound, not a style rule. */
export const MAX_BODY_BYTES = 512 * 1024;

/** True for a SOURCE skill markdown file (extensions/skills/* and bundle members), not an installed copy. */
export function isSourceSkillMd(f) {
  return (
    (f.startsWith(SKILL_DIR + '/') || f.startsWith(BUNDLE_DIR + '/')) &&
    f.endsWith('/SKILL.md')
  );
}

/** True for a SOURCE skill manifest file. */
export function isSkillManifest(f) {
  return (
    (f.startsWith(SKILL_DIR + '/') || f.startsWith(BUNDLE_DIR + '/')) &&
    f.endsWith('/extension.json')
  );
}

/**
 * Leg 1 — source purity. Returns an error string when the source prose still
 * carries a hand-written frontmatter fence, else null.
 *
 * `strip` is the renderer's own `stripFrontmatter` (shared — one detector, no
 * drift). The renderer strips a leading fence only when it sits at absolute
 * position 0 (`^---\s*\n…\n---`), so a fence hidden behind a BOM or a leading
 * blank line would survive stripping and ship as a stale second header. We
 * normalize leading BOM + blank lines first, then ask that same detector
 * whether a fence remains — so a source the renderer would fail to strip is
 * rejected here instead of silently rendering a broken header.
 */
export function checkSourcePurity(content, file, strip) {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/^(?:[ \t]*\r?\n)+/, '');
  if (strip(normalized) !== normalized) {
    return `${file}: source SKILL.md begins with a YAML fence — the header is rendered from extension.json, so the source must be prose-only (this is the 1ceffdbf silent-drop class)`;
  }
  return null;
}

/**
 * Leg 2 — manifest. Returns an array of error strings (empty when valid).
 * `dirname` is the skill directory basename the manifest id must equal.
 */
export function checkManifest(manifest, dirname, file) {
  const errors = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [`${file}: extension.json is not a JSON object`];
  }
  const id = manifest['id'];
  const description = manifest['description'];
  if (typeof id !== 'string' || id.trim() === '') {
    errors.push(`${file}: extension.json is missing a non-empty "id"`);
  } else {
    if (!SKILL_ID_PATTERN.test(id)) {
      errors.push(`${file}: id "${id}" is not a lowercase kebab slug (${SKILL_ID_PATTERN})`);
    }
    if (dirname !== undefined && id !== dirname) {
      errors.push(`${file}: id "${id}" != directory basename "${dirname}" — the rendered name must equal the installed directory`);
    }
  }
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push(`${file}: extension.json is missing a non-empty "description"`);
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`${file}: description is ${description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`);
  }
  // Skills are host-agnostic — a per-host `render` override is an agent-only shape.
  if (manifest['render'] !== undefined) {
    errors.push(`${file}: extension.json declares a "render" block — skills are host-agnostic and must not carry one`);
  }
  return errors;
}

/**
 * Leg 2b — body. Returns an error string when the prose body is empty or over the
 * size bound, else null.
 */
export function checkBody(prose, file) {
  const trimmed = prose.trim();
  if (trimmed === '') return `${file}: source SKILL.md body is empty`;
  if (Buffer.byteLength(prose, 'utf8') > MAX_BODY_BYTES) {
    return `${file}: source SKILL.md body is ${Buffer.byteLength(prose, 'utf8')} bytes (max ${MAX_BODY_BYTES})`;
  }
  return null;
}

/** Load the built host-registry skill renderer, fail-closed when it is absent. */
export function loadRenderer() {
  const dist = path.join(REPO_ROOT, 'libs', 'host-registry', 'dist', 'index.js');
  if (!fs.existsSync(dist)) {
    throw new Error(
      `check-skill-frontmatter: ${dist} is missing — run \`npx nx build host-registry\` first so the skill header renderer can be loaded`,
    );
  }
  const mod = require(dist);
  if (typeof mod.renderSkillFile !== 'function') {
    throw new Error(
      `check-skill-frontmatter: ${dist} does not export renderSkillFile — the host-registry build is stale; re-run \`npx nx build host-registry\``,
    );
  }
  return mod;
}

/** Render a manifest + prose into a full SKILL.md, or throw with a clear message. */
export function renderSkill(manifest, prose, renderSkillFile) {
  const result = renderSkillFile(manifest, prose);
  if (result === null || result.kind !== 'file-body' || typeof result.content !== 'string') {
    throw new Error('renderSkillFile returned no file body — manifest has no usable id/description');
  }
  return result.content;
}

/**
 * Run the off-the-shelf `skillcheck` linter over rendered SKILL.md files. Returns
 * { ok, output } — never a silent pass when uvx cannot be spawned.
 */
export function runSkillcheck(renderedPaths) {
  const argv = ['skillcheck', ...renderedPaths, '--skip-ref-check', '--skip-dirname-check', '--no-color'];
  const res = spawnSync('uvx', argv, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.error) {
    throw new Error(
      `check-skill-frontmatter: failed to spawn \`uvx skillcheck\` — ${res.error.message}. ` +
        'Install uv (https://docs.astral.sh/uv) so rendered skill headers can be validated.',
    );
  }
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function parseArgs(argv) {
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return { base: flagVal('--base'), head: flagVal('--head'), all: argv.includes('--all') };
}

// No try/catch: a git failure here is a hook failure. Let it throw — fail-closed by
// construction (the uncaught throw terminates non-zero; falling back to "check
// nothing" would hide the failure behind a silent pass).
function getChangedFiles(args) {
  if (args.base && args.head) {
    const out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'diff', '--name-only', '--no-renames', args.base, args.head],
      { encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean);
  }
  const env = withVerifiedGitIndex({
    root: REPO_ROOT,
    env: process.env,
    indexFile: process.env.GIT_INDEX_FILE,
    label: 'check-skill-frontmatter',
  });
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'diff', '--cached', '--name-only', '--no-renames', '-z'],
    { encoding: 'utf8', env },
  );
  return out.split('\0').filter(Boolean);
}

/**
 * Whole-tree mode: every tracked source SKILL.md under extensions/skills/ and
 * extensions/bundles/. Uses `git ls-files` (tracked truth, like guards-manifest)
 * so untracked scratch/dist files are never swept in.
 */
function getAllSkillFiles() {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '-z', '--', 'extensions/skills', 'extensions/bundles'],
    { encoding: 'utf8' },
  );
  return out.split('\0').filter(isSourceSkillMd);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changed = args.all ? null : getChangedFiles(args);

  // A changed SKILL.md or a changed extension.json both select their skill dir for
  // the full leg run (a manifest edit must re-render and re-check the same skill).
  // `--all` enumerates every tracked source SKILL.md instead of the diff.
  const skillFiles = new Set(args.all ? getAllSkillFiles() : changed.filter(isSourceSkillMd));
  if (!args.all) {
    for (const f of changed.filter(isSkillManifest)) {
      const skillMd = path.posix.join(path.posix.dirname(f), 'SKILL.md');
      if (fs.existsSync(path.join(REPO_ROOT, skillMd))) skillFiles.add(skillMd);
    }
  }

  if (skillFiles.size === 0) {
    console.log('check-skill-frontmatter: no changed source SKILL.md files — nothing to validate');
    process.exit(0);
  }

  const files = [...skillFiles].sort();
  const errors = [];
  const renderedPaths = [];

  // Load the renderer up-front so a missing/stale build fails closed before any leg runs.
  const { renderSkillFile, stripFrontmatter } = loadRenderer();

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-skillcheck-'));
  // Never leak the staged-render dir — `process.exit()` skips try/finally, but a
  // synchronous 'exit' handler runs on every exit path (success, violation, or a
  // thrown skillcheck/spawn error).
  process.on('exit', () => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    const content = fs.readFileSync(abs, 'utf8');
    const dirname = path.basename(path.dirname(rel));
    const manifestRel = path.posix.join(path.posix.dirname(rel), 'extension.json');
    const manifestAbs = path.join(REPO_ROOT, manifestRel);

    // Leg 1: source purity.
    const purity = checkSourcePurity(content, rel, stripFrontmatter);
    if (purity !== null) errors.push(purity);

    // Leg 2: manifest + body.
    let manifest = null;
    if (!fs.existsSync(manifestAbs)) {
      errors.push(`${rel}: no sibling extension.json — a skill must carry a manifest`);
    } else {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
      } catch (e) {
        errors.push(`${manifestRel}: extension.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (manifest !== null) {
        errors.push(...checkManifest(manifest, dirname, manifestRel));
      }
    }
    const bodyErr = checkBody(content, rel);
    if (bodyErr !== null) errors.push(bodyErr);

    // Leg 3: render the header and stage the rendered artifact for skillcheck.
    if (manifest !== null && purity === null && bodyErr === null) {
      try {
        const rendered = renderSkill(manifest, content, renderSkillFile);
        const stageDir = path.join(scratch, dirname);
        fs.mkdirSync(stageDir, { recursive: true });
        const staged = path.join(stageDir, 'SKILL.md');
        fs.writeFileSync(staged, rendered, 'utf8');
        renderedPaths.push(staged);
      } catch (e) {
        errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('check-skill-frontmatter: violations found:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // Leg 3 (rendered artifact) — the off-the-shelf linter over rendered output.
  if (renderedPaths.length > 0) {
    let skillcheck;
    try {
      skillcheck = runSkillcheck(renderedPaths);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    if (skillcheck.output) process.stdout.write(skillcheck.output);
    if (!skillcheck.ok) {
      console.error(
        `check-skill-frontmatter: skillcheck failed on ${renderedPaths.length} rendered SKILL.md file(s) — ` +
          'the manifest header did not render to parseable YAML',
      );
      process.exit(1);
    }
  }

  console.log(`check-skill-frontmatter: ${files.length} source SKILL.md file(s) passed (manifest + rendered header)`);
  process.exit(0);
}

// Only run as a CLI when executed directly — importing this module (e.g. from
// tools/check-skill-frontmatter.test.mjs) must not shell out to git/uvx or call
// process.exit(). Compare real paths (fileURLToPath decodes percent-encoding), so
// a repo path containing a space or non-ASCII still resolves to the entrypoint —
// the old `import.meta.url === \`file://${process.argv[1]}\`` compared an encoded
// URL against a raw path and silently failed open on those, skipping the guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
