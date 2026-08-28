#!/usr/bin/env node
/**
 * check-child-spawn-telemetry.mjs — guard for BL-618.
 *
 * Every process the system forks/spawns must get its telemetry bootstrapped via
 * the shared `forkChild` / `spawnWorker` helpers (`@adhd/sox-telemetry`'s
 * child-bootstrap.ts), so the child acks its state and no-op children become
 * visible in `telemetrySelfCheck().children`. A RAW `fork(` / `spawn(` /
 * `new Worker(` in production source bypasses that convention: the child starts
 * with the `service:'unlabeled'`, `logSink:'none'` fallback and silently drops
 * every record it emits (the exact BL-618 defect this closes).
 *
 * This guard flags raw spawn calls in the `libs`, `extensions`, and `apps` src
 * trees, minus an allowlist of files where a raw spawn is the point:
 *
 *   - the helper module itself (child-bootstrap.ts — where forkChild/spawnWorker
 *     are implemented),
 *   - test/spec files and `__tests__` fixtures (spawn under the test harness,
 *     not production children),
 *   - real composition-root spawns (ProcessSupervisor's OS-process lifecycle,
 *     service-proxy's ensure-backend, the host-runtime CLI, and the `sox` CLI),
 *     each justified below.
 *
 * Comments are stripped before scanning so a doc comment that merely NAMES
 * `fork()`/`spawn()` (which is correct and common) is not a false positive.
 *
 * Usage:  node tools/check-child-spawn-telemetry.mjs
 * Exit:   0 clean, 1 violations found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['libs', 'extensions', 'apps'];
const EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.nx', '.git', 'coverage', '.worktrees']);

/** path (repo-relative) regex → why a raw spawn there is the point, not the bug. */
const ALLOWLIST = [
  {
    pattern: /(^|\/)__tests__\//,
    reason: 'test fixture — not a production child',
  },
  {
    pattern: /\.(spec|test)\.ts$/,
    reason: 'test/spec file — spawns under the test harness',
  },
  {
    pattern: /libs\/observability\/sox-telemetry\/src\/child-bootstrap\.ts$/,
    reason: 'the BL-618 helper itself — forkChild/spawnWorker live here',
  },
  {
    pattern: /libs\/service-proxy\/src\/ensure-backend\.ts$/,
    reason: 'real composition-root spawn — service-proxy ensure-backend',
  },
  {
    pattern: /libs\/host-runtime\/src\/supervisor\.ts$/,
    reason: 'real composition-root spawn — ProcessSupervisor OS-process lifecycle',
  },
  {
    pattern: /libs\/host-runtime\/src\/runtime-cli\.ts$/,
    reason: 'real composition-root spawn — host-runtime CLI MCP spawn',
  },
  {
    pattern: /apps\/sox\/src\/main\.ts$/,
    reason: 'real composition-root spawn — the sox CLI service/serve spawn',
  },
];

/** Strip `//` and block comments (and skip string literals) so comment-only
 *  mentions of `fork()`/`spawn()` do not read as calls. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CALL_PATTERNS = [
  { name: 'fork(', re: /(^|[^.\w])fork\s*\(/ },
  { name: 'spawn(', re: /(^|[^.\w])spawn\s*\(/ },
  { name: 'new Worker(', re: /\bnew\s+Worker\s*\(/ },
];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile() && EXTS.has(extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

const files = [];
for (const root of ROOTS) {
  try {
    if (statSync(root).isDirectory()) walk(root, files);
  } catch {
    /* root absent — fine */
  }
}

const violations = [];
for (const f of files) {
  const repoRel = f.replace(/\\/g, '/');
  const allow = ALLOWLIST.find((entry) => entry.pattern.test(repoRel));
  if (allow) continue;

  let raw;
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const stripped = stripComments(raw);

  for (const { name, re } of CALL_PATTERNS) {
    // Re-run over the stripped text, tracking the 1-based line via the
    // characters before the match so the report points at the source line.
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const before = stripped.slice(0, m.index + m[0].indexOf(name));
      const line = before.split('\n').length;
      violations.push({ file: repoRel, line, call: name });
      if (re.lastIndex <= m.index) re.lastIndex = m.index + m[0].length;
    }
  }
}

if (violations.length > 0) {
  console.error(
    'check-child-spawn-telemetry: raw spawn call(s) found in production source (BL-618).\n',
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.call}`);
  }
  console.error(
    '\nEvery forked/spawned child must get telemetry via the shared helpers so it\n' +
      'acks its state and no-op children stay visible. Replace a raw `fork(`/`spawn(`/\n' +
      '`new Worker(` in production source with `forkChild`/`spawnWorker`\n' +
      "(`@adhd/sox-telemetry`'s child-bootstrap.ts), or add the file to the\n" +
      'allowlist in this script with a comment-justified reason.',
  );
  process.exit(1);
}

console.log(
  `check-child-spawn-telemetry: OK — ${files.length} production source files, no raw fork/spawn/Worker calls.`,
);
