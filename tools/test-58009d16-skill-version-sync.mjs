#!/usr/bin/env node
/**
 * tools/test-58009d16-skill-version-sync.mjs — red→green guard for 58009d16.
 *
 * Defect (58009d16): a skill's `package.json` `version` lags its `CHANGELOG.md` top
 * `## <version>` heading, so the manifest never carries the version the changelog
 * records as shipped — and nothing checked it. Measured 2026-10-02: 8 of 18 skills
 * lagged (dispatch-contract, dispatch-direct, dispatch-triage, backlog-intake,
 * dispatch-plan, dispatch-priority, definition-of-ready, iterative-research-refinement).
 *
 * Two halves:
 *   1. unit — the version parser and comparator, with an authentic negative control
 *      (a lagging pair) and matching positive controls.
 *   2. live — every versioned skill under extensions/skills/ must have
 *      `package.json.version === its CHANGELOG top`. This half was RED at the commit
 *      that introduced the guard (8 mismatches) and GREEN once every package.json was
 *      reconciled to its changelog.
 *
 * Exit 0 when every skill is in sync, non-zero (with a named list) otherwise.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'extensions', 'skills');

/** First `## <version>` heading (digit-led) of a changelog, or null. */
export function changelogTopVersion(text) {
  const m = /^##\s+\[?([0-9][0-9A-Za-z.\-+]*)\]?/m.exec(text);
  return m ? m[1] : null;
}

/** null when pkgVersion matches the changelog top; an error string otherwise. */
export function checkVersionSync(pkgVersion, changelogText, file) {
  const top = changelogTopVersion(changelogText);
  if (top === null) return `${file}: CHANGELOG has no \`## <version>\` heading`;
  if (pkgVersion !== top) {
    return `${file}: package.json "${pkgVersion}" != CHANGELOG top "${top}"`;
  }
  return null;
}

const failures = [];

// Half 1 — unit controls (no git, no fs).
const lag = checkVersionSync('1.4.0', '## 1.6.1\n\nhistory\n', 'x/CHANGELOG.md');
if (lag === null) failures.push('unit: a lagging pair (1.4.0 vs 1.6.1) must be reported');
const ok = checkVersionSync('1.6.1', '## 1.6.1\n', 'x/CHANGELOG.md');
if (ok !== null) failures.push(`unit: a matching pair must pass, got: ${ok}`);
const bracket = changelogTopVersion('# Changelog\n\n## [1.2.3] - 2024-01-01\n');
if (bracket !== '1.2.3') failures.push(`unit: bracketed heading parsed as ${bracket}`);
const draft = changelogTopVersion('## 0.1.0 — draft\n');
if (draft !== '0.1.0') failures.push(`unit: title-suffixed heading parsed as ${draft}`);
const none = changelogTopVersion('# Changelog\n\n## Unreleased\n');
if (none !== null) failures.push(`unit: a non-version heading must yield null, got ${none}`);

// Half 2 — live: every versioned skill in the tree.
for (const name of fs.readdirSync(SKILLS_DIR).sort()) {
  const dir = path.join(SKILLS_DIR, name);
  const pkgPath = path.join(dir, 'package.json');
  const clPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(pkgPath) || !fs.existsSync(clPath)) continue;
  let version;
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch (e) {
    failures.push(`extensions/skills/${name}/package.json: invalid JSON (${e.message})`);
    continue;
  }
  if (typeof version !== 'string' || version.trim() === '') {
    failures.push(`extensions/skills/${name}/package.json: missing "version"`);
    continue;
  }
  const err = checkVersionSync(
    version,
    fs.readFileSync(clPath, 'utf8'),
    `extensions/skills/${name}/CHANGELOG.md`,
  );
  if (err !== null) failures.push(err);
}

if (failures.length > 0) {
  console.error('test-58009d16-skill-version-sync: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('test-58009d16-skill-version-sync: OK — every versioned skill matches its CHANGELOG top');
