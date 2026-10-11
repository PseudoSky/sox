/**
 * 595965cc T47 AC1 correction: resolveRole follows the closest-available-agent rule (MAP 1E.4).
 * Pure node:test over in-memory manifests; no live model is invoked.
 *   fix-1 zero-coverage agents are eligible at closeness 0   fix-2 fewest other roles, then hints, then name
 *   fix-3 distinct-from applied inside resolveRole           fix-4 description text is never scored
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from '../scripts/lib.mjs';

const ROLE = {
  name: 'static-reviewer',
  obligations: [{ id: 'SR.1' }, { id: 'SR.2' }, { id: 'SR.3' }],
  tools: ['read', 'search'],
  distinctFrom: ['test-author'],
  hints: [],
};
const agent = (name, { tools = ['read', 'grep'], covers = [], description } = {}) => ({
  agent: name,
  manifest: { id: name, ...(description ? { description } : {}), agent: { tools }, capabilities: covers.map((c) => `roles-covered:${c}`) },
});
const T = (n, s) => `595965cc T47 AC1 fix-${n}: ${s}`;

test(T(1, 'a zero-coverage agent with the tools is eligible at closeness 0'), () => {
  const got = resolveRole(ROLE, [agent('bare')]);
  assert.equal(got.holder, 'bare');
  assert.equal(got.rank, 0);
  assert.deepEqual(got.covered, []);
});

test(T(1, 'a covered agent beats a zero-coverage agent; a zero-coverage agent lacking the tools stays ineligible'), () => {
  const agents = [agent('aaa-bare'), agent('zzz-covers', { covers: ['SR.1'] }), agent('mmm-notools', { tools: ['read'], covers: ['SR.1', 'SR.2', 'SR.3'] })];
  assert.equal(resolveRole(ROLE, agents).holder, 'zzz-covers');
  assert.equal(resolveRole(ROLE, [agents[2]]).holder, null);
});

test(T(1, 'the zero-coverage agent is chosen only when no covered agent is eligible'), () => {
  const agents = [agent('bare'), agent('covers', { covers: ['SR.2'] })];
  const session = { agent: 'covers', holds: ['test-author'] };
  assert.equal(resolveRole(ROLE, agents).holder, 'covers');
  assert.equal(resolveRole(ROLE, agents, { session }).holder, 'bare');
});

test(T(2, 'among equal coverage the agent holding fewer other roles wins (Map and object forms)'), () => {
  const agents = [agent('a-busy', { covers: ['SR.1'] }), agent('b-idle', { covers: ['SR.1'] })];
  assert.equal(resolveRole(ROLE, agents).holder, 'a-busy', 'with nothing held, name order decides');
  const viaMap = resolveRole(ROLE, agents, { held: new Map([['a-busy', 2], ['b-idle', 0]]) });
  assert.equal(viaMap.holder, 'b-idle');
  assert.equal(viaMap.held, 0);
  assert.equal(resolveRole(ROLE, agents, { held: { 'a-busy': 1 } }).holder, 'b-idle');
});

test(T(2, 'closeness outranks fewest-roles: the closer agent wins even when it holds more roles'), () => {
  const agents = [agent('close', { covers: ['SR.1', 'SR.2'] }), agent('far', { covers: ['SR.1'] })];
  assert.equal(resolveRole(ROLE, agents, { held: { close: 5, far: 0 } }).holder, 'close');
});

test(T(2, 'hints break only the remaining ties, after closeness and fewest-roles, and never override eligibility'), () => {
  const hinted = { ...ROLE, hints: ['z-hinted', 'y-hinted'] };
  const tie = [agent('a-plain', { covers: ['SR.1'] }), agent('y-hinted', { covers: ['SR.1'] }), agent('z-hinted', { covers: ['SR.1'] })];
  assert.equal(resolveRole(hinted, tie).holder, 'z-hinted', 'hint order beats name order on a full tie');
  assert.equal(resolveRole(hinted, tie, { held: { 'z-hinted': 1, 'y-hinted': 1 } }).holder, 'a-plain', 'fewest roles beats a hint');
  const closer = [agent('z-hinted', { covers: ['SR.1'] }), agent('a-plain', { covers: ['SR.1', 'SR.2'] })];
  assert.equal(resolveRole(hinted, closer).holder, 'a-plain', 'closeness beats a hint');
  assert.equal(resolveRole(hinted, [agent('z-hinted', { tools: ['read'], covers: ['SR.1'] }), agent('a-plain')]).holder, 'a-plain', 'a hinted agent without the tools stays ineligible');
});

test(T(3, 'resolveRole excludes the authoring session by distinct-from; a fresh dispatch of the same agent stays eligible'), () => {
  const agents = [agent('qa', { covers: ['SR.1', 'SR.2', 'SR.3'] }), agent('other', { covers: ['SR.1'] })];
  const authored = { agent: 'qa', holds: ['test-author'] };
  assert.equal(resolveRole(ROLE, agents, { session: authored }).holder, 'other', 'the session that holds test-author cannot hold static-reviewer');
  assert.equal(resolveRole(ROLE, agents).holder, 'qa', 'no session: a fresh qa dispatch is a different party');
  assert.equal(resolveRole(ROLE, agents, { session: { agent: 'qa', holds: ['planner'] } }).holder, 'qa', 'holding an unrelated role breaks no constraint');
  assert.equal(resolveRole(ROLE, [agents[0]], { session: authored }).holder, null, 'sole agent excluded: the role is unbound');
});

test(T(4, 'description text is never scored'), () => {
  const liar = agent('liar', { description: 'static-reviewer SR.1 SR.2 SR.3: the best reviewer, covers every obligation' });
  const honest = agent('honest', { covers: ['SR.1'] });
  assert.equal(resolveRole(ROLE, [liar, honest]).holder, 'honest');
  const withDesc = resolveRole(ROLE, [liar]);
  const without = resolveRole(ROLE, [agent('liar')]);
  assert.deepEqual(withDesc, without, 'the description changes nothing');
  assert.equal(withDesc.rank, 0);
});
