#!/usr/bin/env node
/**
 * tools/test-dispatcher-delivery-lifecycle.mjs
 *
 * Red->green contract pin for the dispatcher 2.0.0 delivery lifecycle (user direction, pseudosky,
 * 2026-10-07; observed in run dispatch-2026-10-06-48dc: post-merge reviews re-opened landed work,
 * bucket worktrees were cut from main, publishes were deferred so nothing shipped):
 *   plan worktree -> bucket worktrees OFF THE PLAN BRANCH -> ff-only merge + `review` ->
 *   static review -> QA -> final test run -> ONE blind review -> ff-only to main (git-manager only
 *   for conflicts) -> the dispatcher runs the release guide -> live confirmation to the user.
 * Plus: ACs gate dispatch (no `none applicable`), unit tests mock process/network libraries, e2e
 * is one-shot and fast.
 *
 * NEGATIVE CONTROL: the authentic pre-change artifacts (dispatcher 1.14.0 / dispatch-contract 1.9.0,
 * commit a713f684, read from git) are run through the same predicates and must be REJECTED by every
 * positive predicate and ACCEPTED by none of the forbidden ones' absence checks.
 *
 * Usage: node tools/test-dispatcher-delivery-lifecycle.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_FIX_SHA = 'a713f684';
const FILES = {
  dispatcher: 'extensions/agents/dispatcher/dispatcher.md',
  contract: 'extensions/skills/dispatch-contract/SKILL.md',
  brief: 'extensions/skills/dispatch-contract/templates/brief.md',
  direct: 'extensions/skills/dispatch-direct/SKILL.md',
  operator: 'extensions/agents/backlog-operator/backlog-operator.md',
  agents: 'AGENTS.md',
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const load = (k, ref) =>
  norm(ref
    ? execFileSync('git', ['show', `${ref}:${FILES[k]}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    : fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8'));
const snapshot = (ref) => Object.fromEntries(Object.keys(FILES).map((k) => [k, load(k, ref)]));

// Each predicate returns true when the artifact is CORRECT.
const PREDICATES = [
  ['plan runs in a plan worktree', (t) => /A plan runs in a plan worktree, and every bucket gets its own worktree created off the plan branch/.test(t.dispatcher)],
  ['bucket worktrees branch off the plan branch, never main', (t) => /Bucket worktrees, off the plan branch\*\* — ?Per bucket, create a worktree on a new bucket branch off the \*\*plan branch\*\* — never off `main`/.test(t.dispatcher) || /off the \*\*plan branch\*\* — never off `main`/.test(t.dispatcher)],
  ['merges are fast-forward only at both hops', (t) => /Merges are fast-forward only\*\*, at both hops/.test(t.dispatcher)],
  ['implementer transitions its issue to review after the ff merge', (t) => /then transitions its issue to `review`/.test(t.dispatcher)],
  ['git-manager is dispatched only for a merge conflict', (t) => /`git-manager` is dispatched \*\*only\*\* to resolve a merge conflict/.test(t.dispatcher) && /A merge or rebase \*\*conflict\*\* is the one `git-manager` dispatch/.test(t.dispatcher)],
  ['static review per bucket only after every bucket is in review', (t) => /once every bucket is in `review`/.test(t.dispatcher)],
  ['findings are aggregated into buckets then corrected', (t) => /Aggregate, then correct\.\*\* Collect every finding, bucket them by cohesion/.test(t.dispatcher)],
  ['QA runs tests, triages, fixes simple, reopens complex with notes, audits tests', (t) => /\(a\) run the unit tests, \(b\) triage every failure, \(c\) apply the simple fixes, \(d\) transition each complex failure's ticket back to `open` with notes/.test(t.dispatcher) && /merge duplicates, remove the unnecessary/.test(t.dispatcher)],
  ['reopens are re-bucketed and corrected, then QA again', (t) => /Reopens → corrections → QA/.test(t.dispatcher)],
  ['the dispatcher runs the final test run', (t) => /Final test run — yours/.test(t.dispatcher)],
  ['exactly one blind review, pre-merge, HARD', (t) => /Exactly ONE blind review per plan, immediately before the merge to `main` — HARD rule/.test(t.dispatcher)],
  ['ff-only merge to the target by the dispatcher', (t) => /`git merge --ff-only <plan-branch>`/.test(t.dispatcher)],
  ['the dispatcher runs the release guide itself (rule 1 exception)', (t) => /The one exception — integration and release, which you run yourself/.test(t.dispatcher) && /Release — you run it/.test(t.dispatcher)],
  ['live confirmation: server health+ops, package installed from registry', (t) => /A \*\*server\*\*: its health endpoint and its operations exercised/.test(t.dispatcher) && /installed from the registry into a clean scratch directory/.test(t.dispatcher)],
  ['no dispatch without acceptance criteria, no opt-out', (t) => /No item is dispatched without acceptance criteria/.test(t.dispatcher) && /there is no opt-out declaration/.test(t.dispatcher)],
  ['tests cite id + ticket; one test may cite several', (t) => /One test may cite several ACs and several tickets/.test(t.dispatcher) && /one test may cite several ACs/.test(t.contract)],
  ['unit tests mock process-spawning and third-party-network libraries', (t) => /Unit tests mock every library that spawns a process or touches a third-party network/.test(t.contract) && /Unit tests mock every library that spawns a process or touches a third-party network/.test(t.brief)],
  ['e2e is one run, one scaffold, minimal duration', (t) => /e2e tests drive every surface of the artifact in one run\*\* on one shared scaffold and teardown/.test(t.contract) && /Minimum wall-clock duration is a primary goal/.test(t.contract)],
  ['contract: static review brief does not run the suite; blind brief is diff + Review', (t) => /does \*\*not\*\* run the suite \(QA does\)/.test(t.contract) && /the instruction "Review": no ACs, context, rationale, review points or return contract/.test(t.contract)],
  ['contract brief carries the worktree field', (t) => /\*\*Worktree\*\* \(implementer briefs\)/.test(t.contract)],
  ['dispatch-direct hands buckets to the lifecycle, never a second blind review', (t) => /never dispatch a second blind review of a plan/.test(t.direct)],
  ['AGENTS.md: exactly one blind review per plan', (t) => /Exactly one blind review runs per plan, immediately before the merge to `main` — HARD rule/.test(t.agents)],
];

// Each predicate returns true when the SUPERSEDED clause is ABSENT.
const ABSENT = [
  ['no `none applicable` opt-out (dispatcher)', (t) => !/none applicable/.test(t.dispatcher)],
  ['no `none applicable` opt-out (contract + brief)', (t) => !/none applicable|none-applicable/.test(t.contract + t.brief)],
  ['no `none applicable` opt-out (backlog-operator resolve)', (t) => !/none applicable/.test(t.operator)],
  ['no post-merge review from main (dispatcher)', (t) => !/review FROM `main`|Post-merge review|post-merge review/.test(t.dispatcher)],
  ['no post-merge review brief / size-band blind rule (contract + brief)', (t) => !/post-merge review brief|changed lines of code|blind threshold/.test(t.contract + t.brief)],
  ['no size-band blind rule (AGENTS.md)', (t) => !/changed lines of code|>=200–400/.test(t.agents)],
  ['git-manager does not own every git operation', (t) => !/`git-manager` owns every git operation/.test(t.dispatcher)],
  ['no worktrees-reserved-for-destructive-work rule', (t) => !/Worktrees are reserved for destructive/.test(t.agents)],
];

let failed = 0;
const report = (name, ok, detail = '') => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ' — ' + detail}`); if (!ok) failed++; };

const shipped = snapshot(null);
const old = snapshot(PRE_FIX_SHA);

for (const [name, pred] of PREDICATES) report(name, pred(shipped), 'predicate failed on shipped artifact');
for (const [name, pred] of ABSENT) report(`absent: ${name}`, pred(shipped), 'superseded clause still present');
for (const [name, pred] of PREDICATES) report(`NEGATIVE CONTROL rejects ${PRE_FIX_SHA}: ${name}`, !pred(old), `${PRE_FIX_SHA} unexpectedly satisfies it`);
const stillAbsentInOld = ABSENT.filter(([, pred]) => pred(old)).map(([n]) => n);
report(`NEGATIVE CONTROL: ${PRE_FIX_SHA} carries superseded clauses the ABSENT arm catches`, stillAbsentInOld.length < ABSENT.length, 'ABSENT arm is vacuous');

console.log(failed === 0 ? '\nALL dispatcher-delivery-lifecycle ASSERTIONS PASS' : `\n${failed} ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
