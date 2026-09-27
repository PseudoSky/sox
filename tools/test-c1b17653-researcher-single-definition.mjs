#!/usr/bin/env node
/**
 * tools/test-c1b17653-researcher-single-definition.mjs
 *
 * Red->green contract pin for backlog c1b17653 (BUG-027): `extensions/agents/researcher` shipped
 * THREE divergent definitions of one agent, and `extension.json` pointed inconsistently at two of
 * them:
 *
 *   1. `researcher.md`         — opencode frontmatter header (`mode`/`temperature`/`permission`),
 *                                and the declared `entrypoint`.
 *   2. `researcher-claude.md`  — claude frontmatter header (`tools:`/`model:`/`version:`),
 *                                ORPHANED (`rg researcher-claude` → 0 references outside the dir).
 *   3. `~/dev/ai/claude-agents/categories/10-research-analysis/researcher.md` — the copy named by
 *                                `install.source`, in a DIFFERENT repo, with fully-expanded headers.
 *
 * `install.source` resolved to a different file than `entrypoint`, so the bytes that landed depended
 * on WHICH resolution path fired. Same bug class as the BL-569 incident (a working opencode agent
 * replaced by a divergent extension copy and rejected by opencode).
 *
 * Root-cause fix, per docs/spec/cross-platform-install-rendering.md §4.1/§6.4/§8: author ONE
 * prose-only `agent.md` (no frontmatter), carry the host-agnostic IR + per-host `render` overrides
 * in `extension.json`, and delete both host-headed copies plus the cross-repo `install.source`. The
 * header is then generated at install time, so two divergent headers cannot both exist.
 *
 * `isAgentDefinition()` is the load-bearing predicate: a `.md` file is an *agent definition* iff it
 * opens with a frontmatter fence whose block declares `name:`. A prose-only body is not one.
 *
 * Arms (all structural — no prose matching, no network, no git, no prebuilt dist/):
 *   manifest-parses               extension.json is valid JSON
 *   entrypoint-resolves           the declared entrypoint exists as a file in the extension dir
 *   single-agent-definition       NO `.md` file other than the entrypoint is an agent definition
 *   no-orphan-claude-copy         no `*-claude.md` host-variant sibling survives in the dir
 *   no-install-source-divergence  install.source absent, OR resolves to the SAME file as entrypoint
 *   no-cross-repo-pointer         extension.json carries no `claude-agents` reference
 *   entrypoint-is-prose-only      the entrypoint itself carries no host frontmatter header
 *
 * NEGATIVE CONTROL — the authentic pre-fix shape, embedded byte-for-byte from the commit that fixed
 * it (09497f45 "feat(host-registry,manifest,install-engine): cross-host agent rendering"; its parent
 * is 18461a15). Pulled from git, never invented:
 *   - extension.json        — verbatim, all 40 lines, incl. line 22 `"entrypoint": "researcher.md"`
 *                             and line 35 `"source": "file:///Users/nix/dev/ai/claude-agents/…"`.
 *   - researcher.md         — its verbatim 29-line opencode frontmatter header. The pre-fix file was
 *                             928 lines / 56KB; only the HEADER is load-bearing for this predicate,
 *                             so the prose body is a one-line stub and is not claimed as verbatim.
 *   - researcher-claude.md  — its verbatim 7-line claude frontmatter header (pre-fix: 900 lines).
 * The fixture is materialised into a throwaway temp dir, so the guard never reads the external
 * claude-agents repo and stays hermetic + machine-independent. The predicate MUST reject it.
 *
 * Usage:
 *   node tools/test-c1b17653-researcher-single-definition.mjs                  # full contract
 *   node tools/test-c1b17653-researcher-single-definition.mjs --raw fixture     # pre-fix fixture → exit 1
 *   node tools/test-c1b17653-researcher-single-definition.mjs --raw live        # live tree       → exit 0
 *
 * Exit 0 iff (a) the pre-fix fixture is REJECTED and (b) the live extension dir is ACCEPTED.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = path.join(REPO_ROOT, 'extensions/agents/researcher');

const STUB_BODY = '\n# researcher — tool, pattern, and use-case discovery (prose body elided in fixture)\n';

// ---------------------------------------------------------------------------------------------
// Authentic pre-fix fixture — byte-for-byte from 18461a15 (09497f45's parent).
// ---------------------------------------------------------------------------------------------

const PRE_FIX_MANIFEST = `{
  "$schema": "https://your-registry/schemas/extension/v2.json",
  "id": "researcher",
  "version": "0.1.1",
  "type": "agent",
  "title": "researcher",
  "description": "Use this when you need to discover, grade, and catalog third-party tools/patterns/use cases before building — sweeps registries and the web via the search MCP, grades sources, writes per-finding memory episodes (agent:approved/agent:blocked), and returns a build-vs-integrate verdict.",
  "compatibility": {
    "host": ">=1.0.0 <2.0.0"
  },
  "license": "MIT",
  "author": "sox-ecosystem",
  "keywords": [
    "research",
    "tools",
    "discovery",
    "memory",
    "build-vs-integrate",
    "registry-search"
  ],
  "runtime": "declarative",
  "entrypoint": "researcher.md",
  "invocation": {
    "protocol": "function-export",
    "handler": "run",
    "description": "Declarative agent — host reads the .md definition file directly."
  },
  "install": {
    "type": "agent",
    "hosts": [
      "claude",
      "codex",
      "opencode"
    ],
    "source": "file:///Users/nix/dev/ai/claude-agents/categories/10-research-analysis/researcher.md"
  },
  "requires": {
    "tool_calling": true
  }
}
`;

// researcher.md, lines 1-29 — the opencode-format header (the divergence).
const PRE_FIX_OPENCODE_HEADER = `---
name: researcher
description: "Discovery researcher for third-party tools, patterns, and use cases before you build. Generalizes a problem into research questions, sweeps package registries and the web via the search MCP, grades every source, and writes each finding to memory as a separate episode tagged agent:approved or agent:blocked, ending in a build-vs-integrate verdict. Never writes code. Unlike workflow-researcher (workflow-plugin findings) or research-analyst (trend synthesis), it evaluates shippable dependencies."
mode: all
temperature: 0.4
permission:
  read: allow
  edit: allow
  bash:
    "*": allow
    "npx nx *": allow
    "rg *": allow
    "scratch-agent-search *": allow
    "gx *": allow
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git stash*": deny
    "git add -A*": deny
    "git add .*": deny
    "git add --all*": deny
    "git reset --hard*": deny
    "git push --force*": deny
    "git push *--no-verify*": deny
    "git clean *-f*": deny
    "rm -rf *": deny
  websearch: deny
  task: allow
  todowrite: allow
  question: allow
  skill: allow
  memory_*: allow
  gitnexus_*: allow
  search_*: allow
---
`;

// researcher-claude.md, lines 1-7 — the claude-format header, orphaned.
const PRE_FIX_CLAUDE_HEADER = `---
name: researcher
description: Discovery researcher for third-party tools, patterns, and use cases before you build. Generalizes a problem into research questions, sweeps package registries and the web via the search MCP, grades every source, and writes each finding to memory as a separate episode tagged agent:approved or agent:blocked, ending in a build-vs-integrate verdict. Never writes code. Unlike workflow-researcher (workflow-plugin findings) or research-analyst (trend synthesis), it evaluates shippable dependencies.
tools: Read, Bash, Write, Edit, WebFetch, WebSearch, mcp__search__*, mcp__memory-server__*, mcp__backlog__*
model: sonnet
version: v1.0.1
---
`;

/** Materialise the authentic pre-fix three-copy shape into a throwaway dir. */
function materialiseFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1b17653-prefix-'));
  fs.writeFileSync(path.join(dir, 'extension.json'), PRE_FIX_MANIFEST);
  fs.writeFileSync(path.join(dir, 'researcher.md'), PRE_FIX_OPENCODE_HEADER + STUB_BODY);
  fs.writeFileSync(path.join(dir, 'researcher-claude.md'), PRE_FIX_CLAUDE_HEADER + STUB_BODY);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// The predicate.
// ---------------------------------------------------------------------------------------------

const ARMS = [
  'manifest-parses',
  'entrypoint-resolves',
  'single-agent-definition',
  'no-orphan-claude-copy',
  'no-install-source-divergence',
  'no-cross-repo-pointer',
  'entrypoint-is-prose-only',
];

/** The frontmatter fence block, or null when the file does not open with one. */
function frontmatterBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  return m ? m[1] : null;
}

/**
 * A `.md` file is an *agent definition* iff it opens with a frontmatter fence declaring `name:`.
 * After the render-at-install migration the shipped artifact is prose-only, so it is NOT one.
 */
function isAgentDefinition(text) {
  const fm = frontmatterBlock(text);
  return fm !== null && /^name:\s*\S/m.test(fm);
}

/** Audit one extension dir. Returns { violations, entrypoint }. */
function audit(dir) {
  const violations = [];
  const violate = (arm, detail) => violations.push({ arm, detail });

  const manifestPath = path.join(dir, 'extension.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    violate('manifest-parses', `${manifestPath} — ${err.message}`);
    return { violations, entrypoint: null };
  }

  const entrypointRaw = typeof manifest.entrypoint === 'string' ? manifest.entrypoint.trim() : '';
  const entrypointPath = entrypointRaw ? path.join(dir, entrypointRaw) : null;
  const entrypointIsFile =
    !!entrypointPath && fs.existsSync(entrypointPath) && fs.statSync(entrypointPath).isFile();
  if (!entrypointRaw || !entrypointIsFile) {
    violate(
      'entrypoint-resolves',
      `entrypoint=${JSON.stringify(manifest.entrypoint)} → ${entrypointPath ?? '(absent)'} exists=${entrypointIsFile}`,
    );
  }

  const mdFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));

  const definitions = mdFiles.filter(({ text }) => isAgentDefinition(text)).map(({ file }) => file);
  const extraDefinitions = definitions.filter((f) => f !== entrypointRaw);
  if (extraDefinitions.length > 0) {
    violate(
      'single-agent-definition',
      `${extraDefinitions.length} divergent definition markdown(s) alongside the entrypoint: ` +
        `${extraDefinitions.join(', ')} (${definitions.length} agent definitions in the dir)`,
    );
  }

  const orphanCopies = fs.readdirSync(dir).filter((f) => /-claude\.md$/.test(f));
  if (orphanCopies.length > 0) {
    violate('no-orphan-claude-copy', `claude host-variant copies still present: ${orphanCopies.join(', ')}`);
  }

  const source =
    manifest.install && typeof manifest.install.source === 'string' ? manifest.install.source.trim() : null;
  if (source) {
    const resolvedSource = path.resolve(source.replace(/^file:\/\//, ''));
    const resolvedEntry = entrypointPath ? path.resolve(entrypointPath) : null;
    if (resolvedSource !== resolvedEntry) {
      violate(
        'no-install-source-divergence',
        `install.source → ${resolvedSource} but entrypoint → ${resolvedEntry ?? '(absent)'} — ` +
          `the bytes that land depend on which resolution path fires`,
      );
    }
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  if (manifestText.includes('claude-agents')) {
    violate('no-cross-repo-pointer', 'extension.json points at the external `claude-agents` repo');
  }

  if (entrypointIsFile && isAgentDefinition(fs.readFileSync(entrypointPath, 'utf8'))) {
    violate(
      'entrypoint-is-prose-only',
      `${entrypointRaw} carries a host frontmatter header — the header must be rendered per host at ` +
        `install time, never authored into the shipped bytes`,
    );
  }

  return { violations, entrypoint: entrypointRaw || null };
}

// ---------------------------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------------------------

let failed = 0;

function reportSubject(label, dir, expected) {
  const { violations, entrypoint } = audit(dir);
  console.log(`\n--- ${label}`);
  console.log(`    dir        : ${dir === LIVE_DIR ? 'extensions/agents/researcher' : dir}`);
  console.log(`    entrypoint : ${entrypoint ?? '(none declared)'}`);
  for (const arm of ARMS) {
    const v = violations.find((x) => x.arm === arm);
    console.log(v ? `    [VIOLATED] ${arm}\n                 ${v.detail}` : `    [ok]       ${arm}`);
  }
  const verdict = violations.length === 0 ? 'ACCEPT' : 'REJECT';
  const ok = verdict === expected;
  const note = ok
    ? '✓ as expected'
    : expected === 'REJECT'
      ? '✗ UNEXPECTED — PREDICATE IS VACUOUS, it accepts the unfixed shape'
      : '✗ UNEXPECTED — the shipped tree fails its own invariant';
  console.log(
    `    verdict    : ${verdict} (${violations.length}/${ARMS.length} arm(s) violated) — expected ${expected} ${note}`,
  );
  if (!ok) failed++;
  return ok;
}

const argv = process.argv.slice(2);
const rawIdx = argv.indexOf('--raw');

if (rawIdx !== -1) {
  // Bare predicate, no expectations — exit code IS the predicate result.
  const subject = argv[rawIdx + 1];
  let dir;
  let cleanup = () => {};
  if (subject === 'fixture') {
    dir = materialiseFixture();
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  } else if (subject === 'live') {
    dir = LIVE_DIR;
  } else {
    console.error('usage: node tools/test-c1b17653-researcher-single-definition.mjs [--raw fixture|live]');
    process.exit(2);
  }

  const { violations } = audit(dir);
  console.log(`[c1b17653] bare predicate — subject=${subject} dir=${dir}`);
  for (const v of violations) console.log(`  VIOLATED ${v.arm} — ${v.detail}`);
  console.log(
    violations.length === 0
      ? '[c1b17653] predicate result: ACCEPT (0 arms violated)'
      : `[c1b17653] predicate result: REJECT (${violations.length}/${ARMS.length} arm(s) violated)`,
  );
  cleanup();
  process.exit(violations.length === 0 ? 0 : 1);
}

const fixtureDir = materialiseFixture();
try {
  reportSubject('NEGATIVE CONTROL — authentic pre-fix three-copy fixture (must be REJECTED)', fixtureDir, 'REJECT');
  reportSubject('LIVE — extensions/agents/researcher (must be ACCEPTED)', LIVE_DIR, 'ACCEPT');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('');
console.log(failed === 0 ? 'ALL c1b17653 ASSERTIONS PASS' : `${failed} c1b17653 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
