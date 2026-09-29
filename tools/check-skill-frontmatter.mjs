#!/usr/bin/env node
/**
 * tools/check-skill-frontmatter.mjs — validate YAML frontmatter of skill/agent definitions.
 *
 * Pins the failure class recorded in commit 1ceffdbf: `extensions/skills/dispatch-plan/SKILL.md`
 * had a `description` containing "backlog: product prioritizes" — a colon+space inside an
 * unquoted YAML scalar. YAML reads that as a mapping separator, the whole frontmatter block fails
 * to parse, and the host silently drops the skill (no error anywhere; an agent later reports it
 * "cannot see" the skill). The fix reworded the colon to an em dash; the authentic pre-fix bytes
 * are at `1ceffdbf^:extensions/skills/dispatch-plan/SKILL.md`.
 *
 * This is NOT a hand-written validator. It shells out to `skillcheck` (PyPI, MIT, production/
 * stable; `uvx skillcheck`), the off-the-shelf Agent Skills frontmatter/quality linter that the
 * 2026-09-29 research (`docs/research/fallback/2026-09-29-skill-frontmatter-validators.md`)
 * selected. Verified live: `skillcheck` reports `parse.error  mapping values are not allowed here`
 * (exit 1) on the pre-fix bytes and PASSes (exit 0) on the fixed bytes.
 *
 * Scope (see tools/guards-manifest.mjs entry `skill-frontmatter`):
 *   - Skills (`extensions/skills/<skill>/SKILL.md`) DO carry YAML frontmatter in source and are
 *     the real target. `skillcheck` is run over exactly the SKILL.md files in the changed set, with
 *     `--skip-ref-check` (file-reference validation is a different concern and is currently
 *     pre-existing-broken in several skills; it is deliberately out of scope here).
 *   - Agents (`extensions/agents/<agent>/<file>.md`) are prose-only in this repo — their YAML frontmatter
 *     is rendered at install time from `extension.json` by `libs/host-registry/src/agent-renderers.ts`
 *     (`yamlStringify`, which quotes scalars safely). There is therefore no frontmatter to parse in
 *     an agent source `.md`, so the agent half is a structural no-op, reported as such rather than
 *     silently skipped. cclint (the research's agent-side candidate) targets Claude Code
 *     subagent files (`.claude/agents/*.md`), a layout this repo does not keep in source.
 *
 * Changed-file source (mirrors tools/precommit-lint.mjs):
 *   default                `git diff --cached` (the pre-commit hook's staged set), re-admitting a
 *                          private next-index via withVerifiedGitIndex() only when it is proven to
 *                          belong to this repo's git dir.
 *   --base <ref> --head <ref>
 *                          `git diff --name-only <base> <head>` (manual / CI context).
 *
 * Exit 0 when there is nothing to check or every checked file passes. Exit non-zero when
 * `skillcheck` fails (a frontmatter parse error or a missing required name/description) or when
 * `uvx` cannot be spawned while files are in scope — fail-closed, never a silent pass.
 *
 * Usage: node tools/check-skill-frontmatter.mjs [--base <ref> --head <ref>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withVerifiedGitIndex } from './lib/git-index-scope.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');

const SKILL_DIR = path.posix.join('extensions', 'skills');
const AGENT_DIR = path.posix.join('extensions', 'agents');

function parseArgs(argv) {
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return { base: flagVal('--base'), head: flagVal('--head') };
}

const args = parseArgs(process.argv.slice(2));

function isSkillMd(f) {
  return f.startsWith(SKILL_DIR + '/') && f.endsWith('/SKILL.md');
}

function isAgentMd(f) {
  return f.startsWith(AGENT_DIR + '/') && f.endsWith('.md');
}

// No try/catch: a git failure here is a hook failure. Let it throw — that is fail-closed by
// construction (the uncaught throw terminates with a non-zero exit), and there is no safe
// fallback (falling back to "check nothing" would hide the failure behind a silent pass).
function getChangedFiles() {
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

const changed = getChangedFiles();
const skills = changed.filter(isSkillMd);
const agents = changed.filter(isAgentMd);

if (skills.length === 0 && agents.length === 0) {
  console.log('check-skill-frontmatter: no changed SKILL.md or agent files — nothing to validate');
  process.exit(0);
}

if (skills.length === 0) {
  console.log(
    'check-skill-frontmatter: no changed SKILL.md files. Agent source .md files carry no YAML ' +
      'frontmatter (header rendered from extension.json at install), so there is nothing to parse.',
  );
  process.exit(0);
}

const argv = ['skillcheck', ...skills, '--skip-ref-check', '--no-color'];
const res = spawnSync('uvx', argv, { cwd: REPO_ROOT, encoding: 'utf8' });

if (res.error) {
  console.error(
    `check-skill-frontmatter: failed to spawn \`uvx skillcheck\` — ${res.error.message}. ` +
      'Install uv (https://docs.astral.sh/uv) so skill frontmatter can be validated.',
  );
  process.exit(1);
}

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);

if (res.status !== 0) {
  console.error(
    `check-skill-frontmatter: skillcheck failed on ${skills.length} SKILL.md file(s) — ` +
      'fix the frontmatter (unquoted "colon+space" scalars and missing name/description are the ' +
      'silent-drop class) before committing.',
  );
  process.exit(res.status ?? 1);
}

console.log(`check-skill-frontmatter: ${skills.length} SKILL.md file(s) passed`);
process.exit(0);
