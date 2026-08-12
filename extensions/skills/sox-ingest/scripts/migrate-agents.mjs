#!/usr/bin/env node
/**
 * extensions/skills/sox-ingest/scripts/migrate-agents.mjs
 *
 * Batch-migrate opencode/Claude markdown agent definitions into born-conformant
 * sox-ecosystem agent extensions.
 *
 * Input: one or more paths/globs to agent .md files (e.g.
 *   node scripts/migrate-agents.mjs typescript researcher product
 *   node scripts/migrate-agents.mjs 'doc-*' agent-manager
 *   node scripts/migrate-agents.mjs ~/.config/opencode/agents/debug.md
 * )
 *
 * For each resolved agent file it:
 *   1. Reads the file verbatim (frontmatter + body — opencode shape: description/
 *      mode/temperature/permission; Claude shape: name/description/tools/model — both
 *      preserved as-is).
 *   2. Derives the extension id from the frontmatter `name:` if present, else the
 *      filename without `.md`.
 *   3. Scaffolds extensions/agents/<id>/ with:
 *        - <id>.md            — the agent definition verbatim (entrypoint)
 *        - extension.json     — born-conformant agent manifest; `install.source`
 *                               points at the origin file; hosts [claude, opencode]
 *        - package.json       — @adhd/sox-extension-<id>, private
 *        - README.md          — overview + usage
 *        - CHANGELOG.md       — initial release entry
 *   4. Refuses to overwrite an existing extension dir unless --force.
 *   5. Rebuilds registry/index.json when --registry (runs scripts/build-index.ts
 *      with --allow-dirty; per BL-390, prefer a committed tree — use --registry only
 *      when the remaining dirt is provably checksum-irrelevant).
 *
 * Requires BL-566 fixed install-engine (agent file-drops land as top-level <id>.md)
 * so the migrated extensions install discoverably on opencode.
 *
 * Usage:
 *   node extensions/skills/sox-ingest/scripts/migrate-agents.mjs <paths...> [--force] [--registry] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Locate the repo root robustly: walk up from this script (in
// extensions/skills/sox-ingest/scripts/) until a dir containing both
// `extensions/` and `registry/` is found. (Script dir → repo root is 4 hops:
// scripts → sox-ingest → skills → extensions → root.)
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, 'extensions')) &&
      existsSync(join(dir, 'registry', 'index.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`migrate-agents: cannot locate repo root (no extensions/ + registry/index.json) from ${start}`);
}

const REPO_ROOT = findRepoRoot(import.meta.dirname);
const AGENTS_DIR = join(REPO_ROOT, 'extensions', 'agents');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const paths = args.filter((a) => !a.startsWith('--'));
const FORCE = flag('force');
const REGISTRY = flag('registry');
const DRY_RUN = flag('dry-run');

if (paths.length === 0) {
  console.error(
    `usage: node scripts/migrate-agents.mjs <agent-path|glob>... [--force] [--registry] [--dry-run]\n` +
    `  e.g. node scripts/migrate-agents.mjs typescript researcher product 'doc-*' agent-manager\n` +
    `       node scripts/migrate-agents.mjs ~/.config/opencode/agents/debug.md\n`,
  );
  process.exit(2);
}

// ─── Resolve inputs ──────────────────────────────────────────────────────────

/**
 * Minimal stdlib glob: match a `*`-containing pattern against files directly
 * under a directory. Supports "doc-*" and "*.md" style patterns (single-level,
 * which is all the migration targets need). No recursion, no ** — keep it stdlib.
 */
function expandSimpleGlob(pattern, dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  const star = pattern.indexOf('*');
  if (star === -1) {
    if (entries.includes(pattern)) out.push(join(dir, pattern));
    return out;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  for (const e of entries) {
    if (e.startsWith(prefix) && e.endsWith(suffix) && e.length >= prefix.length + suffix.length) {
      out.push(join(dir, e));
    }
  }
  return out;
}

function resolveCandidates(raw) {
  const out = new Set();
  const homes = [
    join(REPO_ROOT, '.opencode', 'agents'),
    join(process.env.HOME ?? '', '.config', 'opencode', 'agents'),
    join(process.env.HOME ?? '', '.claude', 'agents'),
    join(REPO_ROOT, '.claude', 'agents'),
  ];
  for (const p of raw) {
    // Bare id (e.g. "typescript") → search the standard agent homes.
    if (!p.includes('/') && !p.includes('*') && !p.includes('.')) {
      for (const home of homes) {
        const f = join(home, `${p}.md`);
        if (existsSync(f)) out.add(f);
      }
      if (out.size === 0) {
        console.error(`migrate-agents: no agent '${p}' found in ${homes.map((h) => h.replace(process.env.HOME ?? '~', '~')).join(' or ')}`);
      }
      continue;
    }
    // Glob: expand against each agent home (e.g. "doc-*").
    if (p.includes('*')) {
      for (const home of homes) {
        for (const f of expandSimpleGlob(p, home)) out.add(f);
      }
      continue;
    }
    // Absolute or relative path: use directly.
    const abs = p.startsWith('/') ? p : resolve(process.cwd(), p);
    if (existsSync(abs) && abs.endsWith('.md')) out.add(abs);
  }
  return [...out].sort();
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { frontmatter: '', meta: {} };
  const raw = m[1];
  const meta = {};
  // Extract known scalar fields (name, description, mode, model, temperature) —
  // nested YAML (permission/tools blocks) is preserved verbatim in the file, we
  // only read the scalars we need for the manifest.
  const scalar = (key) => {
    const re = new RegExp(`^${key}:\\s*["']?([^"'\n]+)["']?\\s*$`, 'm');
    const hit = raw.match(re);
    return hit ? hit[1].trim() : undefined;
  };
  meta.name = scalar('name');
  meta.description = scalar('description');
  meta.model = scalar('model');
  meta.mode = scalar('mode');
  // opencode-shaped agents carry a `permission:` block and no `name:`; Claude
  // agents carry `name:` + a `tools:` list (and often `model: sonnet/opus`).
  meta.hasPermissionBlock = /(^|\n)permission:\s*\n/.test(raw);
  meta.hasToolsList = /(^|\n)tools:\s*\n/.test(raw) || /(^|\n)tools:\s+[^\n]+/.test(raw);
  return { frontmatter: m[0], meta };
}

/**
 * Detect the host formatter the source was authored for:
 *   'opencode' — `mode:` and/or `permission:` present (filename is identity;
 *                opencode agents usually omit `name:`).
 *   'claude'   — `name:` + (`tools:` list or `model:`) present (frontmatter name
 *                is identity).
 *   'generic'  — neither (or ambiguous) — fall back to filename identity.
 */
function detectFormatter(meta) {
  if ((meta.mode !== undefined || meta.hasPermissionBlock) && meta.name === undefined) {
    return 'opencode';
  }
  if (meta.name !== undefined && (meta.hasToolsList || meta.model !== undefined || meta.hasPermissionBlock === false)) {
    return 'claude';
  }
  if (meta.name !== undefined) return 'claude';
  return 'generic';
}

function deriveId(filePath, meta) {
  // Claude formatter: the frontmatter `name:` is the identity — prefer it when valid.
  if (meta.name && /^[a-z][a-z0-9-]*$/.test(meta.name)) return meta.name;
  // opencode/generic: the filename is the identity.
  const stem = basename(filePath, '.md');
  if (!/^[a-z][a-z0-9-]*$/.test(stem)) {
    throw new Error(`migrate-agents: cannot derive a valid extension id from '${filePath}' (stem '${stem}' fails ^[a-z][a-z0-9-]*$)`);
  }
  return stem;
}

/**
 * Normalize the entrypoint for BOTH hosts. opencode identifies by filename, so the
 * file MUST be `<id>.md`. Claude identifies by frontmatter `name:`, so an
 * opencode-shaped source (no `name:`) gets a `name: <id>` line injected after the
 * opening `---` so the SAME file is discoverable on Claude too. A Claude-shaped
 * source already carries `name:` — left verbatim.
 */
function normalizeForHosts(content, id, meta) {
  if (meta.name !== undefined && meta.name !== id) {
    // Claude-shaped but the name differs from the derived id (rare): keep the file
    // verbatim and let the id be the filename — but note the mismatch for the user.
    return { content, note: `frontmatter name '${meta.name}' differs from id '${id}' (filename identity wins for opencode)` };
  }
  if (meta.name === undefined) {
    const fmEnd = content.indexOf('\n---');
    if (fmEnd === -1) return { content, note: null };
    const injected = content.slice(0, fmEnd + 1) + `name: ${id}\n` + content.slice(fmEnd + 1);
    return { content: injected, note: `injected 'name: ${id}' for Claude frontmatter identity` };
  }
  return { content, note: null };
}

// ─── Scaffold ────────────────────────────────────────────────────────────────

function manifest(id, description, sourcePath) {
  return {
    $schema: 'https://your-registry/schemas/extension/v2.json',
    id,
    version: '0.1.0',
    type: 'agent',
    title: id,
    description: description ?? `${id} agent`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    author: 'sox-ecosystem',
    keywords: [id, 'agent', 'declarative'],
    runtime: 'declarative',
    entrypoint: `${id}.md`,
    install: {
      type: 'agent',
      hosts: ['claude', 'opencode'],
      source: `file://${sourcePath}`,
    },
    requires: { tool_calling: true },
  };
}

function packageJson(id, description) {
  return {
    name: `@adhd/sox-extension-${id}`,
    version: '0.1.0',
    description: description ?? `${id} agent`,
    private: true,
    license: 'MIT',
    author: 'sox-ecosystem',
    keywords: [id, 'agent', 'declarative'],
  };
}

function readme(id, description, sourcePath, formatter) {
  return `# ${id}

> ${description ?? `${id} agent`}

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **${formatter ?? 'unknown'}** agent formatter. The entrypoint
\`${id}.md\` is named by the extension id (opencode identity = filename) and carries
\`name: ${id}\` in frontmatter when the source lacked it (Claude identity = frontmatter
\`name\`), so the same file is discoverable on both hosts.

## Source

Migrated from \`${sourcePath}\`.

## Usage

\`\`\`bash
soxe install ${id} --host claude --scope user
soxe install ${id} --host opencode --scope user
\`\`\`

## License

MIT
`;
}

function changelog(id, sourcePath) {
  return `# Changelog

## 0.1.0

- Initial release.
- Migrated the \`${id}\` agent definition from \`${sourcePath}\` into a born-conformant
  declarative agent extension.
`;
}

function scaffoldAgent(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const { meta } = parseFrontmatter(content);
  const formatter = detectFormatter(meta);
  const id = deriveId(filePath, meta);
  const { content: entryContent, note: normalizeNote } = normalizeForHosts(content, id, meta);
  const outDir = join(AGENTS_DIR, id);

  if (existsSync(outDir) && !FORCE) {
    return { id, formatter, status: 'skipped', reason: `extensions/agents/${id}/ exists (use --force to overwrite)` };
  }

  if (DRY_RUN) {
    return { id, formatter, status: 'would-scaffold', target: `extensions/agents/${id}/`, source: filePath, note: normalizeNote };
  }
  mkdirSync(outDir, { recursive: true });
  // Entrypoint: the agent definition, normalized for both hosts (BL-566 shape —
  // a top-level <id>.md at install time, discoverable by opencode's agents/*.md
  // scan; `name:` injected for Claude frontmatter identity when absent).
  writeFileSync(join(outDir, `${id}.md`), entryContent);
  writeFileSync(join(outDir, 'extension.json'), JSON.stringify(manifest(id, meta.description, filePath), null, 2) + '\n');
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(packageJson(id, meta.description), null, 2) + '\n');
  writeFileSync(join(outDir, 'README.md'), readme(id, meta.description, filePath, formatter));
  writeFileSync(join(outDir, 'CHANGELOG.md'), changelog(id, filePath));
  return { id, formatter, status: 'scaffolded', target: `extensions/agents/${id}/`, source: filePath, note: normalizeNote };
}

// ─── Main ────────────────────────────────────────────────────────────────────

// BL-569: the migration must never mutate its SOURCES. Hash every source file
// before scaffolding and re-verify after — the originals stay byte-identical.
import { createHash } from 'node:crypto';

const hashFile = (p) => {
  const h = createHash('sha256');
  h.update(readFileSync(p));
  return h.digest('hex');
};

const candidates = resolveCandidates(paths);
if (candidates.length === 0) {
  console.error('migrate-agents: no agent files matched. Check the paths/globs.');
  process.exit(2);
}

const beforeHashes = new Map(candidates.map((p) => [p, hashFile(p)]));

const results = candidates.map(scaffoldAgent);
for (const r of results) {
  const note = r.note ? ` — ${r.note}` : '';
  console.log(`[${r.status}] ${r.id} (${r.formatter}) → ${r.target ?? r.reason}${note}`);
}

// Verify every source is untouched (BL-569 — never overwrite the originals).
if (!DRY_RUN) {
  let sourceMismatch = 0;
  for (const [p, before] of beforeHashes) {
    const after = hashFile(p);
    if (after !== before) {
      sourceMismatch++;
      console.error(`migrate-agents: SOURCE CHANGED by migration: ${p} (BL-569 violation)`);
    }
  }
  if (sourceMismatch > 0) {
    console.error(`migrate-agents: ${sourceMismatch} source file(s) were modified — the migration must never write to sources. Aborting registry step.`);
    process.exit(1);
  }
}

if (REGISTRY && !DRY_RUN) {
  const scaffolded = results.filter((r) => r.status === 'scaffolded').length;
  if (scaffolded > 0) {
    console.log(`migrate-agents: rebuilding registry (${scaffolded} new extension(s))...`);
    try {
      execFileSync('node', ['--experimental-strip-types', 'scripts/build-index.ts', '--allow-dirty'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch (e) {
      console.error(`migrate-agents: registry rebuild failed (exit ${e.status}). Run it manually: npx tsx scripts/build-index.ts`);
      process.exit(1);
    }
  } else {
    console.log('migrate-agents: nothing new scaffolded — skipping registry rebuild.');
  }
}

console.log(`migrate-agents: ${results.filter((r) => r.status === 'scaffolded').length} scaffolded, ` +
  `${results.filter((r) => r.status === 'skipped').length} skipped, ` +
  `${results.filter((r) => r.status === 'would-scaffold').length} dry-run.`);
