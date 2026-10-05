#!/usr/bin/env node
/**
 * tools/test-dispatcher-ac-citation.mjs
 *
 * Red->green contract pin: the dispatcher requires that every acceptance criterion be proven by
 * a test that cites the ticket and the AC id, and that verification confirm every AC individually.
 *
 * Arms:
 *   1..10. the dispatcher prose carries every AC-citation invariant (rule 20, Step 2.1, Step 4,
 *          the Step 8 checklist, the AC-uncovered failure mode).
 *   11..14. dispatch-contract carries the AC-block field, the `ac-coverage:` return line, the hard
 *           rule, and the brief template's Acceptance-criteria section.
 *   15. NEGATIVE CONTROL: the pre-fix rule-20 bullet (no stable ids) is rejected.
 *
 * Usage: node tools/test-dispatcher-ac-citation.mjs [--file <path-to-dispatcher.md>]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fileArgIdx = process.argv.indexOf('--file')
const TARGET = fileArgIdx !== -1
  ? path.resolve(process.argv[fileArgIdx + 1])
  : path.join(REPO_ROOT, 'extensions/agents/dispatcher/dispatcher.md')
const CONTRACT = path.join(REPO_ROOT, 'extensions/skills/dispatch-contract/SKILL.md')
const BRIEF = path.join(REPO_ROOT, 'extensions/skills/dispatch-contract/templates/brief.md')

// Authentic pre-fix rule-20 AC-block bullet (no stable ids).
const PRE_FIX = `- an **acceptance-criteria block** — binary, objectively checkable statements a verifier can pass or fail; or`

const INVARIANTS = [
  ['rule 20 AC block carries stable ids', /each carrying a stable id/i],
  ['rule 20 names the AC id form', /AC1/],
  ['every AC proven by a citing test', /Every AC is proven by a test that cites it/],
  ['test names the ticket and the AC id', /names the ticket and the AC id it exercises/],
  ['verification confirms every AC individually', /confirms \*\*every AC individually\*\*/],
  ['unexercised AC is verified-fail', /no citing test exercises, is `verified-fail`/],
  ['Step 2.1 requires the AC id + citation', /Each AC carries an id, and the brief requires the executor's tests to cite it/],
  ['Step 4 confirms every AC covered', /Confirm every AC is exercised by a test that cites the ticket and the AC id/],
  ['Step 8 checklist item present', /Did every test the executor wrote cite the ticket and the AC id it proves/],
  ['failure mode AC-uncovered catalogued', /\*\*AC-uncovered\*\*/],
]

const CONTRACT_INVARIANTS = [
  ['contract §1 AC-block field with ids', /Acceptance criteria \(with ids\)/],
  ['contract return line ac-coverage', /ac-coverage:/],
  ['contract hard rule', /Every AC is proven by a test citing the ticket and the AC id/],
  ['brief template Acceptance-criteria section', /## Acceptance criteria \(test each; cite the ticket and the AC id\)/],
]

const normalise = (s) => s.replace(/\s+/g, ' ').trim()
const missing = (text, list) => list.filter(([, re]) => !re.test(normalise(text))).map(([n]) => n)

let failed = 0
function report(name, ok, detail) {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ' — ' + detail}`)
  if (!ok) failed++
}

const text = fs.readFileSync(TARGET, 'utf8')
const miss = missing(text, INVARIANTS)
report(`dispatcher carries the AC-citation requirement (${INVARIANTS.length} invariants)`, miss.length === 0, `missing: ${miss.join(' | ')}`)

const contract = fs.readFileSync(CONTRACT, 'utf8') + '\n' + fs.readFileSync(BRIEF, 'utf8')
const cmiss = missing(contract, CONTRACT_INVARIANTS)
report(`dispatch-contract carries AC-block + ac-coverage (${CONTRACT_INVARIANTS.length} invariants)`, cmiss.length === 0, `missing: ${cmiss.join(' | ')}`)

report(
  'pre-fix rule-20 shape is REJECTED (negative control)',
  !/each carrying a stable id/i.test(normalise(PRE_FIX)),
  'pre-fix text unexpectedly satisfies the id predicate',
)

console.log(failed === 0 ? '\nALL dispatcher-ac-citation ASSERTIONS PASS' : `\n${failed} ASSERTION(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
