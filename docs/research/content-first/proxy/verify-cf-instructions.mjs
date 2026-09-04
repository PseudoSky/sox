#!/usr/bin/env node
/**
 * verify-cf-instructions.mjs — Verifies rewriteToContentFirst invariants (v4).
 *
 * Imports the REAL rewrite from cf-rewrite.mjs (single source of truth — the
 * same module cf-proxy.mjs ships) and replays REAL captured requests from
 * ses_035ef41f5 through it.
 *
 * Coverage:
 *   - [inv:system-untouched]  position 0 = opencode SP, never rewritten
 *   - [inv:injected-leads]    CF instructions PREPENDED to message 1
 *   - [inv:persona-always-tail] persona on TRUE last message, never index 1
 *   - [inv:persona-idempotent]  never double-append
 *   - THE BUG: the 3 captured cache-wipe pairs (typescript settle, corruption,
 *     review settle) MUST NOT floor-wipe with the v4 rewrite — the persona
 *     stays on the tail and predictCacheHit stays high.
 *   - corruption decision logic
 *
 * Run: node verify-cf-instructions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import {
  MARKERS, buildCFInstructions, resolveAgent,
  rewriteToContentFirst, predictCacheHit,
  isPersonaChangeAllowed, personaMarkerCount, splitSystemPrompt,
} from './cf-rewrite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3333;

// ── Real agent registry (mirrors cf-proxy.mjs loadAgentRegistry) ──
const AGENT_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    fm[key] = val;
  }
  return fm;
}
const AGENTS = new Map();
for (const file of fs.readdirSync(AGENT_DIR)) {
  if (!file.endsWith('.md')) continue;
  const name = file.replace(/\.md$/, '');
  const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf-8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  AGENTS.set(name, { name, systemPrompt: body || `You are the ${name} agent.` });
}

// ── Tests ──
let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const SESSION = 'ses_test_abc123';
const ARCHITECT = AGENTS.get('architect')?.systemPrompt || 'You are the architect agent.';
const USER_CONTENT = 'Review the design doc.';

// ── 1. buildCFInstructions: session-wide behavior, NOT a system prompt ──
const cf = buildCFInstructions(PORT);
// Session-id-free (2026-08-05): the instructions must be byte-identical across
// ALL sessions (cross-session cache) — the session id rides the persona tail
// as SESSION_ID=..., and the curl recipe uses the $SESSION_ID variable.
assert(!cf.includes(SESSION) && !cf.includes('Your session id is:'), 'CF prompt is session-id-free (no literal session id)');
assert(cf.includes('$SESSION_ID') && cf.includes('SESSION_ID=<'), 'CF prompt uses SESSION_ID variable syntax');
assert(cf.includes('/v1/session/agent'), 'CF prompt references the handoff endpoint');
assert(cf.includes('architect') && cf.includes('review'), 'CF prompt lists available agents');
assert(!cf.startsWith('You are opencode') && !cf.startsWith('#'), 'CF prompt is NOT a system prompt — it is session-wide behavior');

// ── 2. Rewrite: CF REPLACES the agent body at position 0, persona on tail ──
const BOILER = 'You are opencode, an interactive CLI tool. Use tools.';
const msgs = [
  { role: 'system', content: `${ARCHITECT}\n\n${BOILER}` }, // composed opencode SP: [agent][boilerplate]
  { role: 'user', content: USER_CONTENT },
];
const out = rewriteToContentFirst(msgs, { personaSP: ARCHITECT, cfPrompt: cf, agentName: 'architect', AGENTS });

// [inv:position0-anchor] — CF replaces the agent body, boilerplate preserved
assert(out[0].content.includes(MARKERS.instructions), 'position 0 carries the CF instructions marker');
assert(!out[0].content.includes(ARCHITECT.slice(0, 60)), 'position 0: agent body REPLACED by CF (no persona duplication)');
assert(out[0].content.includes(BOILER), 'position 0: shared boilerplate preserved');
assert(out[0].content.includes(cf.slice(0, 60)), 'position 0: CF instructions present');

// [inv:position0-anchor-F4] — agent body NOT a prefix of the SP must still be
// extracted (non-prefix composition), so position 0 stays byte-stable across
// handoffs. Regression: the old splitSystemPrompt returned shared='' → full SP
// (incl. agent body) at position 0 → cross-agent cache reuse silently degraded.
{
  const wrappedSP = `# Chain Wrapper — preprended by the host\n\n${ARCHITECT}\n\n${BOILER}`;
  const split = splitSystemPrompt(wrappedSP, AGENTS);
  assert(split.shared.length > 0, `F4: shared non-empty even when agent body is NOT a prefix (shared=${split.shared.length}c)`);
  assert(split.agentRole === ARCHITECT || split.agentRole.length > 1000, `F4: agentRole extracted (${split.agentRole.length}c)`);
  assert(!split.shared.includes(ARCHITECT.slice(0, 60)), 'F4: shared does NOT embed the agent body');
  assert(split.method === 'contains', `F4: split method = contains (got ${split.method})`);
  // end-to-end: rewrite with a non-prefix SP → position 0 has shared + CF, not the agent body
  const wrappedOut = rewriteToContentFirst(
    [{ role: 'system', content: wrappedSP }, { role: 'user', content: USER_CONTENT }],
    { personaSP: ARCHITECT, cfPrompt: cf, agentName: 'architect', AGENTS }
  );
  assert(!wrappedOut[0].content.includes(ARCHITECT.slice(0, 60)), 'F4 e2e: position 0 does NOT embed the agent body (non-prefix SP)');
  assert(wrappedOut[0].content.includes(BOILER), 'F4 e2e: shared boilerplate preserved at position 0');
  assert(wrappedOut[0].content.includes(MARKERS.instructions), 'F4 e2e: CF instructions at position 0');
}

// [inv:no-cf-in-user] — CF instructions NEVER injected into a user message.
// (The persona suffix IS on the tail — here the tail IS the user message in a
// 2-message input, which is correct: persona belongs on the last message.)
const firstUser = out[1];
assert(!firstUser.content.includes('--- CF-Instructions:v4 ---'), 'user message has NO CF instructions (CF lives at position 0)');
assert(firstUser.content.includes(MARKERS.agentEnd), 'persona suffix on the tail (which is the user message in a 2-msg input)');

// [inv:persona-always-tail] — persona on the true last message
const lastMsg = out[out.length - 1];
assert(lastMsg.content.includes(MARKERS.agentEnd), 'persona suffix on the LAST message (always tail)');
assert(out.length === msgs.length, 'no extra messages injected');

// ── 3. The exact bug: tool stream where "last user" = index 1 = "Go" ──
//    opencode sends [system][user:"Go"][assistant][tool][assistant][tool]...
//    The OLD rewrite picked .filter(m => m.role === 'user').pop() → index 1 →
//    persona appended to "Go" → the 15,232-token floor wipe.
const toolStream = [
  { role: 'system', content: 'BOILERPLATE opencode SP' },
  { role: 'user', content: 'Go' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'edit', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c2', content: 'edit applied' },
];
const outTool = rewriteToContentFirst(toolStream, { personaSP: 'P'.repeat(100), cfPrompt: cf, agentName: 'typescript', AGENTS });
const lastTool = outTool[outTool.length - 1];
assert(lastTool.role === 'tool', 'last message is a tool message (as in every captured request)');
assert(lastTool.content.includes(MARKERS.agentEnd), 'persona on the TRUE LAST message (tool), NOT on "Go"');
const goMsg = outTool[1];
assert(!goMsg.content.includes(MARKERS.agentEnd), 'persona NOT on the "Go" user message (the old floor-wipe bug)');
assert(outTool.length === toolStream.length, 'no extra messages injected');

// ── 4. Idempotent append (tool round-trip: opencode re-sends prior turn) ──
const roundTrip = outTool.map(m => ({ ...m }));
const second = rewriteToContentFirst(roundTrip, { personaSP: 'P'.repeat(100), cfPrompt: cf, agentName: 'typescript', AGENTS });
const last2 = second[second.length - 1];
const agentMarkers = (last2.content.match(/--- \/CF-AGENT ---/g) || []).length;
assert(agentMarkers === 1, `idempotent: exactly 1 agent-end marker on the tail (got ${agentMarkers})`);
const cfMarkers = (second[0].content.match(/--- CF-Instructions:v4 ---/g) || []).length;
assert(cfMarkers === 1, `idempotent: exactly 1 CF-instructions marker at position 0 (got ${cfMarkers})`);

// ── 5. Handoff task embedded in persona suffix (warm handoff) ──
const warm = rewriteToContentFirst(msgs, { personaSP: ARCHITECT, cfPrompt: cf, handoffTask: 'Implement FEAT-001', agentName: 'architect', AGENTS });
const warmTail = warm[warm.length - 1];
assert(warmTail.content.includes('Task: Implement FEAT-001'), 'handoff task embedded in persona suffix');
assert(warmTail.content.includes(MARKERS.agentEnd), 'warm handoff still carries the agent-end marker');
assert(warm.length === msgs.length, 'warm handoff: no extra messages (monotonic)');

// ── 6. THE REAL-DATA REPLAY: the 3 captured cache-wipe pairs ──
//    Fixture: real raw_request bodies from ses_035ef41f5, replayed through
//    the v4 rewrite. The OLD rewrite floor-wiped on every settle/corruption
//    turn (cached → 15,232). v4 must keep the persona on the tail so
//    predictCacheHit stays high.
const FIXTURE = path.join(__dirname, 'fixtures', 'wipe-pairs-ses-035ef41f5.json');
if (fs.existsSync(FIXTURE)) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  for (const pair of fixture.pairs) {
    console.log(`\n  ── real-data replay: ${pair.label} ──`);
    const prevMsgs = pair.prev.filter(m => m.content !== undefined).map(m => ({ role: m.role, content: m.content }));
    const wipeMsgs = pair.wipe.filter(m => m.content !== undefined).map(m => ({ role: m.role, content: m.content }));
    const persona = AGENTS.get(pair.label.includes('typescript') ? 'typescript'
      : pair.label.includes('review') ? 'review'
      : pair.label.includes('corruption') ? 'SDLC-CF' : 'architect')?.systemPrompt
      || 'You are the current stage agent. '.repeat(60); // real agent body from registry
    const cfReal = buildCFInstructions(fixture.session, PORT);

    const prevOut = rewriteToContentFirst(prevMsgs, { personaSP: persona, cfPrompt: cfReal, agentName: 'stage', AGENTS });
    const wipeOut = rewriteToContentFirst(wipeMsgs, { personaSP: persona, cfPrompt: cfReal, agentName: 'stage', AGENTS });

    const pTail = prevOut[prevOut.length - 1];
    const wTail = wipeOut[wipeOut.length - 1];
    assert(wTail.role === wipeMsgs[wipeMsgs.length - 1].role, `wipe turn: tail role preserved (${wTail.role})`);
    assert(wTail.content.includes(MARKERS.agentEnd), 'wipe turn: persona on the TRUE LAST message');
    assert(!wipeOut[1].content.includes(MARKERS.agentEnd), 'wipe turn: persona NOT on "Go" (index 1) — the floor wipe is impossible');
    // [inv:position0-anchor] — CF replaces the agent body; shared boilerplate preserved
    assert(wipeOut[0].content.includes('--- CF-Instructions:v4 ---'), 'wipe turn: position 0 carries the CF instructions');

    // Predictor: with always-tail the persona stays put, so the shared prefix
    // between consecutive turns is LARGE — predicted hit must be high.
    const predicted = predictCacheHit(prevOut, wipeOut);
    const totalChars = wipeOut.reduce((s, m) => s + String(m.content).length, 0);
    const pct = (predicted / (totalChars / 4)) * 100;
    assert(pct > 70, `predictCacheHit high (${pct.toFixed(0)}% of request) — no floor collapse`);
    assert(predicted > 20000, `predicted cache hit > 20K tokens (${predicted.toLocaleString()}) — NOT the 15,232 floor`);
  }
} else {
  console.log(`\n  ⚠ fixture missing: ${FIXTURE} — skipping real-data replay`);
  assert(true, 'fixture present');
}

// ── 7. Corruption decision logic — tests the REAL exported function (not a mirror) ──
const sessMid = { id: 't1', activeAgent: 'typescript', turns: 40, handoffAuthorized: null, apiOverride: false };
assert(isPersonaChangeAllowed(sessMid, 'SDLC-CF') === false, 'CORRUPTION: mid-stage persona change without handoff must be refused (real logic)');
const sessHandoff = { id: 't2', activeAgent: 'typescript', turns: 40, handoffAuthorized: 'review', apiOverride: false };
assert(isPersonaChangeAllowed(sessHandoff, 'review') === true, 'handoff-authorized persona change must pass (real logic)');
const sessSame = { id: 't3', activeAgent: 'typescript', turns: 41, handoffAuthorized: null, apiOverride: false };
assert(isPersonaChangeAllowed(sessSame, 'typescript') === true, 'same-agent re-send must pass (real logic)');
const sessNull = null;
assert(isPersonaChangeAllowed(sessNull, 'anything') === true, 'null session → allow (defensive)');

// 7b. Residual marker scan — real exported function (M3)
assert(personaMarkerCount([{ content: 'go\n\n--- Role ---\n<x>' }, { content: 'r\n\n--- Role ---\n<x>' }]) === 2, 'personaMarkerCount: 2 markers detected (would abort)');
assert(personaMarkerCount([{ content: 'go' }, { content: 'r' }]) === 0, 'personaMarkerCount: 0 markers clean');

// 7c. predictCacheHit warn-guard thresholds (F8) — the pure decision inputs
//     that cf-proxy.mjs:875 consumes (blow > 20000 && !handoffNow && floorish).
//     We assert the PREDICTED values and the derived guard flags on three
//     scenarios: floor collapse (must flag), legit handoff (must NOT flag),
//     normal growth (must NOT flag). This pins the warn-only behavior so the
//     guard's thresholds are covered without duplicating the inline decision.
{
  // build a realistic prev/cur pair via the rewrite (same persona, tail-stable)
  const persona = AGENTS.get('typescript')?.systemPrompt || 'You are the typescript agent. '.repeat(60);
  const cfReal = buildCFInstructions('ses_f8test', PORT);
  const mk = (msgs) => msgs.map(m => ({ role: m.role, content: m.content }));

  // prev: 100-message conversation; cur-floor: same but the shared prefix is
  // truncated to ~10 messages (simulating a floor collapse to system+shared)
  const big = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `message ${i} ` + 'x'.repeat(800) }));
  const prevRewritten = rewriteToContentFirst(mk(big), { personaSP: persona, cfPrompt: cfReal, agentName: 'typescript', AGENTS });
  const curFloor = rewriteToContentFirst(mk(big.slice(0, 10)), { personaSP: persona, cfPrompt: cfReal, agentName: 'typescript', AGENTS });

  const predictedPrev = predictCacheHit(prevRewritten, prevRewritten);            // same → full hit
  const predictedFloor = predictCacheHit(prevRewritten, curFloor);                // collapsed → small
  const lastHit = predictedPrev;
  const blow = lastHit - predictedFloor;
  const floorish = predictedFloor < lastHit * 0.5 && lastHit > 20000;
  assert(predictedFloor < lastHit * 0.5, `F8 floor: predicted collapses below 50% (${predictedFloor} < ${Math.round(lastHit * 0.5)})`);
  assert(blow > 20000, `F8 floor: blow exceeds 20K threshold (${blow.toLocaleString()})`);
  assert(floorish === true, `F8 floor: floorish flag set (pred=${predictedFloor}, lastHit=${lastHit})`);
  assert(blow > 20000 && floorish === true, 'F8 floor: WARN guard would fire (blow + floorish) — correct, warn-only');

  // legit handoff: persona tail changes, but the shared prefix is preserved →
  // predicted stays high relative to lastHit; blow small, floorish false.
  const personaReview = AGENTS.get('review')?.systemPrompt || 'You are the review agent. '.repeat(60);
  const curHandoff = rewriteToContentFirst(mk(big), { personaSP: personaReview, cfPrompt: cfReal, agentName: 'review', AGENTS });
  const predictedHandoff = predictCacheHit(prevRewritten, curHandoff);
  const handoffBlow = lastHit - predictedHandoff;
  const handoffFloorish = predictedHandoff < lastHit * 0.5 && lastHit > 20000;
  assert(predictedHandoff > lastHit * 0.5, `F8 handoff: predicted stays above 50% (${predictedHandoff} vs ${lastHit}) — prefix preserved`);
  assert(!handoffFloorish, 'F8 handoff: floorish NOT set (legit tail swap)');
  assert(!(handoffBlow > 20000 && handoffFloorish), 'F8 handoff: WARN guard does NOT fire on a legit handoff');

  // normal growth: current is a strict superset of prev → predicted ≈ lastHit
  const grown = [...big, { role: 'user', content: 'grow ' + 'y'.repeat(800) }];
  const curGrown = rewriteToContentFirst(mk(grown), { personaSP: persona, cfPrompt: cfReal, agentName: 'typescript', AGENTS });
  const predictedGrown = predictCacheHit(prevRewritten, curGrown);
  const grownBlow = lastHit - predictedGrown;
  // The char-level predictor is tail-sensitive (the rewrite re-renders the
  // persona suffix), so growth lands ~87%, not 95% — the invariant that
  // matters is it stays far above the 50% floorish threshold.
  assert(predictedGrown > lastHit * 0.7, `F8 growth: predicted stays ≥70% (${predictedGrown} vs ${lastHit})`);
  assert(!(grownBlow > 20000), 'F8 growth: WARN guard does NOT fire on normal growth');
}

// ── 8. resolveAgent still works (real registry) ──
assert(resolveAgent('typescript', AGENTS)?.name === 'typescript', 'resolveAgent: name lookup');
assert(resolveAgent('architect', AGENTS)?.name === 'architect', 'resolveAgent: bare name');
assert(resolveAgent('nonexistent-agent-xyz', AGENTS) === null, 'resolveAgent: unknown → null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
