#!/usr/bin/env node
/**
 * tools/test-roster-guard.mjs — backlog 3fe895f3 (T10): name-resolution guard.
 *
 * Fails when an agent name the dispatcher routes work to matches no installed extension.
 * "Installed extension" = a directory under extensions/agents/ whose extension.json `id` is the name.
 *
 * Routed names come from two sources:
 *   1. The dispatcher's routing rule (extensions/agents/dispatcher/dispatcher.md), from
 *      "Route each bucket" up to "If no row matches ...":
 *        - the rows after `Work class → executor:`: only the backticked token right after an arrow
 *          (`→ \`name\``), so a backticked non-agent word in a row is never flagged;
 *        - the preamble before the rows: its backticked agent-shaped tokens (the `general`
 *          last-resort guard and the verification aliases it names are names a reader routes to).
 *   2. The task-to-agent routing table in the repo-root AGENTS.md — a markdown table whose header
 *      has a task/work-class/intent column AND an agent/executor column. When AGENTS.md has no
 *      such table the guard SAYS SO on stdout and still checks source 1; it never passes silently.
 *
 * Usage:
 *   node tools/test-roster-guard.mjs [--ref <git-ref>] [--root <dir>]
 *     --ref   read dispatcher.md, AGENTS.md and the extensions/agents listing from <git-ref>
 *             via `git show` / `git ls-tree` (no checkout). Default: the working tree.
 *     --root  repo root to read (fixture rosters; default: this repo).
 *
 * Exit: 0 every routed name resolves; 1 at least one routed name matches no installed extension;
 *       2 the guard could not run (no routing rows found, unreadable file, bad manifest).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DISPATCHER_REL = 'extensions/agents/dispatcher/dispatcher.md';
export const AGENTS_DIR_REL = 'extensions/agents';
export const AGENTS_MD_REL = 'AGENTS.md';

const IDENT = /^[a-z][a-z0-9-]*$/;
const START_MARK = 'Route each bucket';
const END_MARK = 'If no row matches';
/** Backticked tokens in the preamble that are not agent names (model tiers). */
const NOT_AGENTS = new Set(['sonnet', 'opus', 'haiku']);
const ROWS_MARK = /Work class\s*→\s*executor\s*:?/;
/** The executor of a routing row: the backticked token directly after an arrow. */
const ROW_EXECUTOR = /→\s*`([^`\n]+)`/g;

/** Thrown for "the guard cannot run" (exit 2), as opposed to "roster is wrong" (exit 1). */
export class GuardError extends Error {}

function backticked(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}

/**
 * Parse the dispatcher's routing rule into routed names.
 * @returns {{ name: string, source: string }[]} unique names, first-seen order.
 */
export function parseDispatcherRoutes(markdown) {
  const start = markdown.indexOf(START_MARK);
  if (start === -1) throw new GuardError(`dispatcher routing rule not found: no "${START_MARK}" text`);
  const end = markdown.indexOf(END_MARK, start);
  if (end === -1) throw new GuardError(`dispatcher routing rule not found: no "${END_MARK}" after "${START_MARK}"`);
  const rule = markdown.slice(start, end);
  const marker = ROWS_MARK.exec(rule);
  if (marker === null) throw new GuardError('dispatcher routing rule has no "Work class → executor" rows');
  const preamble = rule.slice(0, marker.index);
  const rows = rule.slice(marker.index + marker[0].length);
  const candidates = [
    ...backticked(preamble),
    ...[...rows.matchAll(ROW_EXECUTOR)].map((m) => m[1].trim()),
  ];
  const seen = new Set();
  const out = [];
  for (const tok of candidates) {
    if (!IDENT.test(tok) || NOT_AGENTS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push({ name: tok, source: DISPATCHER_REL });
  }
  if (out.length === 0) throw new GuardError('dispatcher routing rule names no agents');
  return out;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Parse a task-to-agent routing table out of AGENTS.md.
 * Agent cells that are neither backticked identifiers nor bare identifiers are reported in
 * `warnings` (the CLI prints them to stderr) instead of being dropped silently.
 * @returns {{ found: boolean, names: { name: string, source: string }[], warnings: string[] }}
 */
export function parseAgentsMdTable(markdown) {
  const lines = markdown.split('\n');
  const names = [];
  const seen = new Set();
  const warnings = [];
  let found = false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1]) || !lines[i + 1].includes('|')) continue;
    const header = splitRow(lines[i]).map((h) => h.toLowerCase());
    const agentCol = header.findIndex((h) => /\b(agent|executor)\b/.test(h));
    const taskCol = header.findIndex((h) => /\b(task|work class|intent)\b/.test(h));
    if (agentCol === -1 || taskCol === -1) continue;
    found = true;
    for (let j = i + 2; j < lines.length && lines[j].includes('|'); j++) {
      const cell = splitRow(lines[j])[agentCol] ?? '';
      const toks = backticked(cell);
      const cands = toks.length > 0 ? toks : [cell];
      for (const c of cands) {
        if (!IDENT.test(c)) {
          warnings.push(`${AGENTS_MD_REL}:${j + 1}: agent cell ${JSON.stringify(cell)} is neither a backticked nor a bare agent identifier; not checked`);
        } else if (!seen.has(c)) {
          seen.add(c);
          names.push({ name: c, source: AGENTS_MD_REL });
        }
      }
    }
  }
  return { found, names, warnings };
}

/**
 * Build a source of repo facts. `git` is injectable (args[], cwd) => string so unit tests never
 * spawn a process. With ref === null the working tree is read through `fsApi`.
 */
export function makeSource({ root, ref = null, git, fsApi = fs }) {
  if (ref === null) {
    return {
      label: `working tree ${root}`,
      readFile(rel) {
        const p = path.join(root, rel);
        return fsApi.existsSync(p) ? fsApi.readFileSync(p, 'utf8') : null;
      },
      listDirs(rel) {
        const p = path.join(root, rel);
        if (!fsApi.existsSync(p)) return [];
        return fsApi.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      },
    };
  }
  return {
    label: `git ref ${ref}`,
    readFile(rel) {
      const present = git(['ls-tree', '--name-only', ref, '--', rel], root).trim();
      return present === '' ? null : git(['show', `${ref}:${rel}`], root);
    },
    listDirs(rel) {
      const out = git(['ls-tree', '-d', '--name-only', ref, `${rel}/`], root);
      return out.split('\n').filter(Boolean).map((p) => path.posix.basename(p));
    },
  };
}

/** Installed names = extension.json ids of every directory under extensions/agents/. */
export function listInstalled(source) {
  const installed = new Set();
  const warnings = [];
  for (const dir of source.listDirs(AGENTS_DIR_REL)) {
    const rel = `${AGENTS_DIR_REL}/${dir}/extension.json`;
    const raw = source.readFile(rel);
    if (raw === null) {
      warnings.push(`${AGENTS_DIR_REL}/${dir}: no extension.json, not an installed extension`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      throw new GuardError(`${rel}: invalid JSON: ${e.message}`);
    }
    if (typeof manifest.id !== 'string' || manifest.id === '') {
      throw new GuardError(`${rel}: missing string "id"`);
    }
    installed.add(manifest.id);
  }
  return { installed, warnings };
}

/**
 * Pure check over a source. Returns the full result; never prints, never exits.
 * @returns {{ routed, installed:Set<string>, unresolved:{name:string,source:string}[],
 *             agentsMdTable:'found'|'absent'|'no-file', warnings:string[], tableWarnings:string[], label:string }}
 */
export function checkRoster(source) {
  const dispatcherText = source.readFile(DISPATCHER_REL);
  if (dispatcherText === null) throw new GuardError(`${DISPATCHER_REL} not found in ${source.label}`);
  const routed = [...parseDispatcherRoutes(dispatcherText)];
  const agentsMd = source.readFile(AGENTS_MD_REL);
  let agentsMdTable = 'no-file';
  const tableWarnings = [];
  if (agentsMd !== null) {
    const t = parseAgentsMdTable(agentsMd);
    tableWarnings.push(...t.warnings);
    agentsMdTable = t.found ? 'found' : 'absent';
    const have = new Set(routed.map((r) => r.name));
    for (const n of t.names) {
      if (!have.has(n.name)) {
        have.add(n.name);
        routed.push(n);
      }
    }
  }
  const { installed, warnings } = listInstalled(source);
  const unresolved = routed.filter((r) => !installed.has(r.name));
  return { routed, installed, unresolved, agentsMdTable, warnings, tableWarnings, label: source.label };
}

export function formatReport(result) {
  const lines = [];
  lines.push(`roster-guard: ${result.label}`);
  lines.push(`  installed extensions (${result.installed.size}): ${[...result.installed].sort().join(', ')}`);
  lines.push(`  routed names (${result.routed.length}): ${result.routed.map((r) => r.name).join(', ')}`);
  if (result.agentsMdTable === 'found') lines.push('  AGENTS.md: task-to-agent routing table parsed');
  else if (result.agentsMdTable === 'absent') {
    lines.push('  AGENTS.md: NO task-to-agent routing table found; only the dispatcher routing rule was checked');
  } else lines.push('  AGENTS.md: file not present; only the dispatcher routing rule was checked');
  for (const w of result.warnings) lines.push(`  warning: ${w}`);
  if (result.unresolved.length === 0) lines.push('PASS: every routed agent name matches an installed extension');
  else {
    for (const u of result.unresolved) lines.push(`UNRESOLVED: ${u.name} (routed in ${u.source}) matches no installed extension`);
    lines.push(`FAIL: ${result.unresolved.length} routed name(s) unresolved: ${result.unresolved.map((u) => u.name).join(', ')}`);
  }
  return lines.join('\n');
}

/** Real git; failures become one-line GuardErrors that carry git's own stderr. */
export const realGit = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = String(e.stderr ?? e.message).trim().replace(/\s*\n\s*/g, ' ');
    throw new GuardError(`git ${args[0]} failed: ${detail}`);
  }
};

/** Fail with exit-2 semantics when `ref` does not name a commit. */
function verifyRef(git, root, ref) {
  if (ref.startsWith('-')) throw new GuardError(`unknown --ref "${ref}": a ref must not start with "-"`);
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`], root);
  } catch (e) {
    const detail = e instanceof GuardError ? e.message : String(e.message);
    throw new GuardError(`unknown --ref "${ref}": ${detail}`);
  }
}

export function main(argv, io = { out: console.log, err: console.error }, git = realGit, env = process.env) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new GuardError(`${name} requires a value`);
    return v;
  };
  try {
    const root = path.resolve(flag('--root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const ref = flag('--ref');
    if (ref !== null) verifyRef(git, root, ref);
    const result = checkRoster(makeSource({ root, ref, git }));
    for (const w of result.tableWarnings) io.err(`roster-guard: warning: ${w}`);
    io.out(formatReport(result));
    return result.unresolved.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof GuardError) io.err(`roster-guard: cannot run: ${e.message}`);
    else if (env.GUARD_DEBUG) io.err(`roster-guard: cannot run: ${e.stack ?? String(e)}`);
    else io.err(`roster-guard: cannot run: ${e?.message ?? String(e)} (set GUARD_DEBUG=1 for the stack)`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
