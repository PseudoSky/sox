#!/usr/bin/env node
/**
 * check-no-nul-bytes.mjs — guard for BL-371.
 *
 * A raw 0x00 byte in a source file makes `grep` treat the whole file as binary.
 * This shell's `grep` wrapper suppresses the "Binary file matches" notice, so a
 * search returns NO OUTPUT and EXIT 0 — indistinguishable from "the symbol is not
 * there". That is a silent false negative in the primary tool used to establish
 * that code does or does not exist.
 *
 * It has already cost real time and put an incorrect status claim into an agent
 * coordination channel: `libs/data/store/store-adapter/src/integrity.ts:445` held
 * a literal NUL instead of the `'\0'` escape, and two agents got NOT FOUND for a
 * symbol that was demonstrably present.
 *
 * The escape and the raw byte are byte-identical at runtime — `'\0'` in a
 * TypeScript string literal IS a NUL character — so there is never a reason to
 * commit the raw form. Same family as BL-347 and BL-319: a signal whose failure
 * mode is indistinguishable from a legitimate negative result.
 *
 * Usage:  node tools/check-no-nul-bytes.mjs
 * Exit:   0 clean, 1 violations found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['libs', 'extensions', 'apps', 'tools', 'docs', 'scripts'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.nx', '.git', 'coverage', '.worktrees']);

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir is not this guard's business
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
for (const r of ROOTS) {
  try {
    if (statSync(r).isDirectory()) walk(r, files);
  } catch {
    /* root absent — fine */
  }
}

const violations = [];
for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue;
  }
  const idx = buf.indexOf(0);
  if (idx === -1) continue;
  // Report the 1-based line so the fix is one jump away.
  const line = buf.subarray(0, idx).toString('utf8').split('\n').length;
  violations.push({ file: f, line });
}

if (violations.length > 0) {
  console.error('check-no-nul-bytes: raw 0x00 byte(s) found in source (BL-371).\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
  }
  console.error(
    '\nA raw NUL makes `grep` treat the file as binary and return NOTHING, silently —' +
      '\nany "symbol not found" result on this file is untrustworthy.' +
      "\nFix: write the escape `'\\0'` instead of the raw byte. Runtime value is identical.",
  );
  process.exit(1);
}

console.log(`check-no-nul-bytes: OK — ${files.length} source files, no raw NUL bytes.`);
