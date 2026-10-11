/**
 * 595965cc T47 — dispatcher role availability (MAP §1E.4, D17, D23).
 *
 * Arms:
 *   - text: dispatcher.md, dispatch-direct and dispatch-plan carry the AC1–AC3 rule wording.
 *   - behaviour: the REAL workspace-standards resolveRole, parseRoles (roles.md) and loadAgents, driven
 *     against a seeded temp roster (every installed agent's real manifest except `review`).
 *
 * Not real, stated here so nobody counts it as proof of more than it is:
 *   - bind() below transcribes the debt and Deep-block steps of dispatcher.md Step 2. The dispatcher
 *     prose is executed by a model; this test proves the deterministic core it relies on, not the model's
 *     execution of it. Eligibility, including distinct-from, is resolveRole's own (options.session).
 *   - `qa` is SEEDED in the roster with SR.1–SR.4 coverage. The real qa manifest has search tools
 *     (grep/glob, commit 35dfa854) and holds the Auditor role, but declares no SR.* coverage, so the seed
 *     adds that coverage to make a covered static-reviewer candidate.
 *
 * AC5 (the citation guard still exits 0) spawns a process, so it lives in e2e.test.mjs; this file spawns nothing.
 *
 * Run: node --test tests/*.test.mjs   (from extensions/agents/dispatcher)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgents, parseRoles, readText, resolveRole } from '../../../skills/workspace-standards/scripts/lib.mjs';
import { BOUND_NO_COVERAGE } from '../../../skills/workspace-standards/scripts/foundations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const AGENTS = path.join(REPO, 'extensions/agents');
const { roles } = parseRoles(readText(path.join(REPO, 'extensions/skills/workspace-standards/standards/testing/roles.md')));
const role = (name) => {
  const r = roles.find((x) => x.name === name);
  assert.ok(r, `roles.md defines role ${name}`);
  return r;
};
const EXPIRY = '2026-12-31';
const PROSE = {
  dispatcher: path.join(REPO, 'extensions/agents/dispatcher/dispatcher.md'),
  direct: path.join(REPO, 'extensions/skills/dispatch-direct/SKILL.md'),
  plan: path.join(REPO, 'extensions/skills/dispatch-plan/SKILL.md'),
};
const prose = (k) => fs.readFileSync(PROSE[k], 'utf8').replace(/\s+/g, ' ');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't47-roster-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let rosterN = 0;

/** Writes manifests into a fresh roster dir under TMP; returns loadAgents() output. */
function writeRoster(manifests) {
  const dir = path.join(TMP, `roster-${rosterN++}`);
  for (const [id, m] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'extension.json'), JSON.stringify(m));
  }
  return loadAgents(dir);
}

/** SEEDED qa (fixture, not the real manifest): adds SR.1–SR.4 coverage (and `grep` if the manifest lacks it). */
function seededQa(m) {
  return {
    ...m,
    seeded: 'T47 fixture: real qa covers no SR obligation',
    agent: { ...m.agent, tools: [...new Set([...m.agent.tools, 'grep'])] },
    capabilities: [...(m.capabilities ?? []), 'roles-covered:SR.1', 'roles-covered:SR.2', 'roles-covered:SR.3', 'roles-covered:SR.4'],
  };
}

/** The installed roster with `review` removed; every other agent is its real manifest. */
function seededRosterWithoutReview() {
  const manifests = {};
  for (const id of fs.readdirSync(AGENTS)) {
    const f = path.join(AGENTS, id, 'extension.json');
    if (id === 'review' || !fs.existsSync(f)) continue;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    manifests[id] = id === 'qa' ? seededQa(m) : m;
  }
  return writeRoster(manifests);
}

/**
 * Transcription of dispatcher.md Step 2 (595965cc T47). session = the authoring session
 * { agent, holds } — resolveRole excludes it from a role whose distinct-from list names a role it holds
 * (595965cc T47 AC1 fix-3); this function does not re-implement that rule.
 */
function bind({ roleName, agents, rigor, session = null, expiry = EXPIRY }) {
  const r = role(roleName);
  const got = resolveRole(r, agents, { session });
  if (got.holder) return { outcome: 'bound', holder: got.holder, covered: got.covered };
  if (rigor === 'deep' && r.deepBlocks) return { outcome: 'blocked', role: r.name };
  // dispatcher.md Step 2: what follows an unbound role is that role's own `no-holder` entry, not one rule for all.
  if (!/review debt/i.test(r.noHolder)) return { outcome: 'no-holder-entry', role: r.name, entry: r.noHolder };
  if (!expiry) throw new Error('review debt requires an expiry');
  const owner = resolveRole(role('risk-owner'), agents, { session }).holder ?? 'user';
  return { outcome: 'debt', role: r.name, owner, expiry };
}

/** Only the seeded qa is installed: the one agent with the static-reviewer tools and coverage. */
function seededQaOnlyRoster() {
  const m = JSON.parse(fs.readFileSync(path.join(AGENTS, 'qa', 'extension.json'), 'utf8'));
  return writeRoster({ qa: seededQa(m) });
}

const AUTHORED_QA = { agent: 'qa', holds: ['test-author'] };
const AC = (n, s) => `595965cc T47 AC${n} — ${s}`;

test(AC(1, 'resolveRole binds the closest eligible agent by roles-covered; description text is never scored'), () => {
  const agents = writeRoster({
    wide: { id: 'wide', agent: { tools: ['read', 'grep', 'bash', 'edit'] }, capabilities: ['roles-covered:SR.1', 'roles-covered:SR.2'] },
    narrow: {
      id: 'narrow',
      description: 'static review of SR.1 SR.2 SR.3 SR.4 — a static-reviewer, read-only reviewer',
      agent: { tools: ['read', 'grep'] },
      capabilities: ['roles-covered:SR.1'],
    },
    nosearch: {
      id: 'nosearch',
      agent: { tools: ['read', 'bash'] },
      capabilities: ['roles-covered:SR.1', 'roles-covered:SR.2', 'roles-covered:SR.3', 'roles-covered:SR.4'],
    },
  });
  const got = resolveRole(role('static-reviewer'), agents);
  assert.equal(got.holder, 'wide');
  assert.deepEqual(got.covered, ['SR.1', 'SR.2']);
});

test(AC(1, 'dispatcher.md, dispatch-direct and dispatch-plan carry the closest-eligible rule wording'), () => {
  for (const k of ['dispatcher', 'direct', 'plan']) {
    const p = prose(k);
    assert.match(p, /closest eligible/, k);
    assert.match(p, /roles-covered/, k);
    assert.match(p, /[Ff]ree-text/, k);
  }
  const d = prose('dispatcher');
  assert.match(d, /fewest other roles/);
  assert.match(d, /break remaining ties/);
});

test(AC(2, 'the dispatcher telemetry row names the bound agent with covered ids, or the unbound role'), () => {
  const d = prose('dispatcher');
  assert.match(d, /telemetry row names `role=<role>:<agent>` with its covered ids/);
  assert.match(d, /`role=<role>:unbound` with the debt owner and expiry, or the block/);
});

test('595965cc T47 AC1 rank0-3: the telemetry flag in dispatcher.md is exactly the constant the code emits', () => {
  assert.equal(BOUND_NO_COVERAGE, 'bound-no-coverage', 'the shipped code constant');
  const d = prose('dispatcher');
  assert.ok(d.includes(`the flag \`${BOUND_NO_COVERAGE}\``), 'dispatcher.md names the flag the code emits');
  assert.match(d, /closeness-0 binding records covered ids `none` and the flag/);
  assert.ok(!d.includes('no-declared-coverage'), 'the retired spelling is gone from dispatcher.md');
});

test('595965cc T47 AC3: an unbound role follows its own no-holder entry; the implementer waits for a specialist and records no review debt', () => {
  const d = prose('dispatcher');
  assert.match(d, /the role's own `no-holder` entry/);
  assert.match(d, /`implementer` role's work waits for a specialist/);
  assert.doesNotMatch(d, /With none eligible the role is unbound\. At Light/, 'the blanket "every unbound role is review debt" sentence is gone');
  const impl = role('implementer');
  assert.match(impl.noHolder, /waits for a specialist/);
  assert.equal(impl.deepBlocks, false);
  for (const rigor of ['light', 'standard', 'deep']) {
    const got = bind({ roleName: 'implementer', agents: [], rigor });
    assert.equal(got.outcome, 'no-holder-entry', `${rigor}: no review debt record for implementer`);
    assert.match(got.entry, /waits for a specialist/);
  }
  assert.equal(bind({ roleName: 'triager', agents: [], rigor: 'light' }).outcome, 'debt', 'a review-debt entry still records debt');
});

test('595965cc T47 AC1: the final tie-break is hints order, then agent name, and the caller supplies held', () => {
  const d = prose('dispatcher');
  assert.match(d, /you supply that `held` count per agent/);
  assert.match(d, /in `hints` order; any tie still left goes to the agent name/);
  const hinted = 'hh-hinted';
  const sr = { ...role('static-reviewer'), hints: [hinted] }; // fixture hint list: the real role declares none
  const tools = ['read', 'grep'];
  const mk = (ids) => Object.fromEntries(ids.map((id) => [id, { id, agent: { tools }, capabilities: [] }]));
  // equal closeness (0), equal held: a hinted agent beats an unhinted one regardless of name
  assert.equal(resolveRole(sr, writeRoster(mk(['aaa-unhinted', hinted]))).holder, hinted);
  // equal closeness, no hints involved: the lower name wins, independent of roster order
  assert.equal(resolveRole(sr, writeRoster(mk(['zzz-b', 'zzz-a']))).holder, 'zzz-a');
  // held outranks hints: the caller's count decides before hints are consulted
  assert.equal(resolveRole(sr, writeRoster(mk(['zzz-a', hinted])), { held: { [hinted]: 1 } }).holder, 'zzz-a');
  // omitting held does not infer anything: same roster, same result as held {}
  assert.equal(resolveRole(sr, writeRoster(mk(['zzz-a', hinted]))).holder, hinted);
});

test(AC(3, 'unbound roles record review debt with owner and expiry at Light and Standard; Deep blocks'), () => {
  for (const k of ['dispatcher', 'direct', 'plan']) {
    const p = prose(k);
    assert.match(p, /review debt/, k);
    assert.match(p, /\bowner\b/, k);
    assert.match(p, /\bexpiry\b/, k);
    assert.match(p, /blocks? at Deep|Deep, an unbound role/, k);
  }
  for (const k of ['direct', 'plan']) {
    const p = prose(k);
    assert.match(p, /role's own `no-holder` entry/, `${k}: defers to the per-role no-holder entry`);
    assert.match(p, /`implementer` role[^.]*waits for a specialist[^.]*no review debt/, `${k}: implementer waits, no debt`);
    assert.doesNotMatch(p, /An? unbound role is review debt/i, `${k}: blanket sentence is gone`);
  }
  assert.match(prose('dispatcher'), /At Light and Standard/);
});

test(AC(4, 'Light, review removed, authoring qa: static-reviewer is unbound and review debt is recorded with owner and expiry'), () => {
  const got = bind({ roleName: 'static-reviewer', agents: seededQaOnlyRoster(), rigor: 'light', session: AUTHORED_QA });
  assert.deepEqual(got, { outcome: 'debt', role: 'static-reviewer', owner: 'user', expiry: EXPIRY });
});

test(AC(4, 'Standard, review removed: a fresh qa dispatch is the closest eligible holder of static-reviewer'), () => {
  const got = bind({ roleName: 'static-reviewer', agents: seededRosterWithoutReview(), rigor: 'standard' });
  assert.equal(got.outcome, 'bound');
  assert.equal(got.holder, 'qa');
  assert.deepEqual([...got.covered].sort(), ['SR.1', 'SR.2', 'SR.3', 'SR.4']);
});

test(AC(4, 'Standard, review removed: a qa session that authored the tests is excluded, so the role is unbound with debt'), () => {
  const got = bind({ roleName: 'static-reviewer', agents: seededQaOnlyRoster(), rigor: 'standard', session: AUTHORED_QA });
  assert.equal(got.outcome, 'debt');
  assert.notEqual(got.holder, 'qa');
});

test(AC(4, 'Deep, no eligible agent: the change is blocked and reported; a deep-blocks: no role does not block'), () => {
  const roster = seededQaOnlyRoster();
  assert.deepEqual(
    bind({ roleName: 'static-reviewer', agents: roster, rigor: 'deep', session: AUTHORED_QA }),
    { outcome: 'blocked', role: 'static-reviewer' },
  );
  assert.equal(bind({ roleName: 'static-reviewer', agents: roster, rigor: 'deep' }).holder, 'qa');
  assert.equal(role('triager').deepBlocks, false);
  assert.equal(bind({ roleName: 'triager', agents: [], rigor: 'deep' }).outcome, 'debt');
});

test(AC(4, 'Light, review removed, full roster, authoring qa: a zero-coverage agent with the tools is eligible at closeness 0 (595965cc T47 AC1 fix-1)'), () => {
  const got = bind({ roleName: 'static-reviewer', agents: seededRosterWithoutReview(), rigor: 'light', session: AUTHORED_QA });
  assert.equal(got.outcome, 'bound');
  assert.notEqual(got.holder, 'qa', 'the authoring qa session is excluded by resolveRole');
  assert.deepEqual(got.covered, [], 'no installed agent besides qa covers SR.*, so the holder is at closeness 0');
});
