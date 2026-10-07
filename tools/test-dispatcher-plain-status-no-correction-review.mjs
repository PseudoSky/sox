#!/usr/bin/env node
/**
 * tools/test-dispatcher-plain-status-no-correction-review.mjs
 *
 * Red->green pin for the dispatcher 1.14.0 corrections (user report, run dispatch-2026-10-04-b7d4):
 *   A. the status table is plain markdown — no <span style=...> / <br> (they rendered as raw HTML in Claude);
 *   B. blind review runs exactly once per plan, pre-merge — never for a correction, reopen cycle or
 *      re-dispatch (a blind review of each cycle never converges and blocks the release);
 *   C. one dispatch record: the §5 run line leads with dispatcher/session/agent/task/run_at.
 *
 * NEGATIVE CONTROL: the authentic pre-fix text, read from commit d7c954b4 (dispatcher 1.13.0), is run
 * through the same predicates and must be REJECTED by every one.
 *
 * Usage: node tools/test-dispatcher-plain-status-no-correction-review.mjs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRE_FIX_SHA = 'd7c954b4'
const FILES = {
  dispatcher: 'extensions/agents/dispatcher/dispatcher.md',
  contract: 'extensions/skills/dispatch-contract/SKILL.md',
  agents: 'AGENTS.md',
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const read = (k) => norm(fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8'))
const preFix = (k) => norm(execFileSync('git', ['show', `${PRE_FIX_SHA}:${FILES[k]}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }))

// Each predicate returns true when the artifact is CORRECT.
const PREDICATES = [
  ['status table has no HTML (span/br)', (t) => !/<span style=|<br>/.test(t.dispatcher), 'dispatcher'],
  ['status table: optional notes field in the status cell', (t) => /optional `notes: <text>` ends the status cell/.test(t.dispatcher), 'dispatcher'],
  ['objectives: one line per outstanding objective, active bolded', (t) => /one line per outstanding objective/.test(t.dispatcher) && /stalled — <reason>/.test(t.dispatcher), 'dispatcher'],
  ['active dispatches named <agent> <issue> <short title>', (t) => /`<agent> <issue> <short title>`/.test(t.dispatcher), 'dispatcher'],
  ['contract §1a: the blind review is never dispatched for a correction, reopen or re-dispatch', (t) => /A correction, a reopen cycle or a re-dispatch never gets one/.test(t.contract), 'contract'],
  ['dispatcher rule 5: no correction, reopen cycle or re-dispatch is blind-reviewed', (t) => /No correction, reopen cycle or re-dispatch, before or after it, is blind-reviewed/.test(t.dispatcher), 'dispatcher'],
  ['AGENTS.md Blind Review: exactly one per plan, never for corrections', (t) => /Exactly one blind review runs per plan/.test(t.agents) && /No correction, reopen cycle, or re-dispatch/.test(t.agents), 'agents'],
  ['contract §5: run line is the dispatch record', (t) => /dispatcher: <dispatcher session_id>, session: <subagent session id>, agent: <dispatched agent name>, task: <task title>, run_at: <ISO UTC timestamp>/.test(t.contract), 'contract'],
]

let failed = 0
const report = (name, ok, detail = '') => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ' — ' + detail}`); if (!ok) failed++ }

const shipped = { dispatcher: read('dispatcher'), contract: read('contract'), agents: read('agents') }
const old = { dispatcher: preFix('dispatcher'), contract: preFix('contract'), agents: preFix('agents') }

for (const [name, pred] of PREDICATES) report(name, pred(shipped), 'predicate failed on shipped artifact')
for (const [name, pred] of PREDICATES) report(`NEGATIVE CONTROL rejects pre-fix: ${name}`, !pred(old), `pre-fix ${PRE_FIX_SHA} unexpectedly satisfies it`)

console.log(failed === 0 ? '\nALL dispatcher-plain-status-no-correction-review ASSERTIONS PASS' : `\n${failed} ASSERTION(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
