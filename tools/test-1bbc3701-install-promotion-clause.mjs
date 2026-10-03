#!/usr/bin/env node
/**
 * tools/test-1bbc3701-install-promotion-clause.mjs
 *
 * Red->green contract pin for backlog 1bbc3701: agent-manager edited an already-installed agent's
 * definition (3 committed dispatcher changes) but never re-installed it, so the fix shipped
 * committed-but-inert — the host kept loading the stale copy because `soxe install` places a copy
 * and opencode/Claude read definitions at STARTUP (no hot-reload). The spec's crafting workflow ran
 * install only on the CRAFT path (its step 6), so an EDIT had no promotion step and no check that
 * the deployed bytes match source.
 *
 * The negative control is AUTHENTIC, not invented: the exact pre-fix tail of the spec's step 7 as
 * committed at 22b04a53 (the dispatcher fix commits landed against this shape). It carries no
 * promotion mandate and is REJECTED by the same predicate that accepts the fixed artifact, so this
 * guard is demonstrably able to fail.
 *
 * Arms (whitespace-normalised, so line wrapping is irrelevant):
 *   1. the spec mandates re-install after editing an installed artifact
 *   2. the spec names the actual command (`soxe install` to every declared host)
 *   3. the spec requires diffing the deployed bytes against source
 *   4. the spec requires a restart when a running session must adopt the change
 *   5. NEGATIVE CONTROL: the authentic pre-fix step-7 tail is rejected (no promotion mandate)
 *
 * Usage:
 *   node tools/test-1bbc3701-install-promotion-clause.mjs               # check the shipped spec
 *   node tools/test-1bbc3701-install-promotion-clause.mjs --fixture     # check the fixture (exit non-zero: rejected)
 *   node tools/test-1bbc3701-install-promotion-clause.mjs --file <path> # check an alternate spec
 *
 * Exit 0 iff the artifact carries every promotion invariant AND the pre-fix negative control is
 * rejected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'extensions/agents/agent-manager/agent-manager.md');

const argv = process.argv.slice(2);
const FIXTURE_MODE = argv.includes('--fixture');
const fileArgIdx = argv.indexOf('--file');
const TARGET = fileArgIdx !== -1 ? path.resolve(argv[fileArgIdx + 1]) : DEFAULT_TARGET;

// -------------------------------------------------------------------------------------------
// The authentic pre-fix spec tail, verbatim as committed at 22b04a53 (step 7's closing lines,
// before the promotion step existed). Kept exactly as authored — evidence, not an invented shape.
// -------------------------------------------------------------------------------------------
const PRE_FIX_TAIL = `   (\`git commit <paths> -m "..."\` — never \`git add -A\`, per the repo AGENTS.md), then report. Same
   for every repo-tracked artifact this agent ships. An edit to an untracked host path (measured
   2026-09-28: \`~/.config/opencode/\` is not a git repo) has no revision to land in — report the edit
   and its backup path instead of claiming a commit.`;

const norm = (s) => s.replace(/\s+/g, ' ').trim();

const ARMS = [
  [
    'promotion mandate',
    (t) => /Editing an installed artifact is not finished until it is re-installed/.test(t),
  ],
  [
    're-install command named',
    (t) => /re-run `soxe install` to every declared host/.test(t),
  ],
  [
    'deployed-bytes diff required',
    (t) => /diff the deployed bytes against source/.test(t),
  ],
  [
    'restart for a running session',
    (t) => /restart the host if a running session must adopt it/.test(t),
  ],
];

function check(spec) {
  const t = norm(spec);
  const missing = ARMS.filter(([, pred]) => !pred(t)).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

const fixture = FIXTURE_MODE || false;
const source = fixture ? PRE_FIX_TAIL : fs.readFileSync(TARGET, 'utf8');
const result = check(source);

const negControl = check(PRE_FIX_TAIL);
const negRejected = !negControl.ok;

if (fixture) {
  // Fixture mode asserts the predicate REJECTS the authentic pre-fix shape.
  if (negRejected) {
    console.log(`OK (fixture) — pre-fix tail rejected; missing: ${negControl.missing.join(', ')}`);
    process.exit(0);
  }
  console.error('FAIL (fixture) — the pre-fix tail was ACCEPTED; the predicate cannot fail');
  process.exit(1);
}

if (!result.ok) {
  console.error(`FAIL — ${TARGET} lacks the promotion mandate; missing: ${result.missing.join(', ')}`);
  process.exit(1);
}
if (!negRejected) {
  console.error('FAIL — negative control: the authentic pre-fix tail was ACCEPTED (predicate cannot fail)');
  process.exit(1);
}
console.log(`OK — promotion mandate present in ${path.relative(REPO_ROOT, TARGET)}; pre-fix negative control rejected`);
