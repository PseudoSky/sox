/**
 * cf-rewrite.mjs — Content-first rewrite logic (shared, side-effect free).
 *
 * Single source of truth for the rewrite, imported by BOTH cf-proxy.mjs
 * (server) and verify-cf-instructions.mjs (tests) so tests exercise the
 * exact code that ships — no duplicated mirror that can drift.
 *
 * DESIGN (v4, 2026-08-04 — fixes the settle-turn floor wipe):
 *   Every n-1 message MUST be cached 100% of the time the request is sent
 *   through the proxy. The provider prefix cache requires a byte-identical
 *   prefix; therefore the ONLY thing allowed to change between turns is the
 *   tail. Anything injected must live at a position where a change
 *   invalidates the smallest possible region.
 *
 *   [0] system: opencode's own system prompt — NEVER rewritten. It is the
 *               cache anchor and it is byte-identical every turn. The proxy
 *               does not inject, wrap, or re-derive it.
 *   [1] user:   CF instructions (SESSION-WIDE BEHAVIOR, not system prompt)
 *               injected FIRST, then the user's original text. The injected
 *               block LEADS — no user text ("Go") precedes injected content.
 *   [2..N-1] history: untouched, append-only.
 *   [N] tail:  persona anchor appended to the TRUE LAST message every turn.
 *               The ONLY per-agent variable; changes only at handoff, and a
 *               change invalidates just the tail (bounded), never the floor.
 *
 *   All injected blocks (CF instructions, persona) carry self-describing
 *   markers with a content hash so the proxy can PROVE it has the exact
 *   prompt before forwarding, and the tests can assert the exact bytes
 *   that moved.
 *
 *   INVARIANTS:
 *   [inv:system-untouched]        position 0 = opencode SP, never rewritten.
 *   [inv:injected-leads]          CF instructions PREPENDED to message 1 —
 *                                 injected content comes before user text.
 *   [inv:persona-always-tail]     persona on the TRUE LAST message, every
 *                                 turn, unconditionally. NEVER derived from
 *                                 "last user" — in an opencode tool stream the
 *                                 only user message is index 1 ("Go"), so
 *                                 "last user" = first user = floor wipe
 *                                 (measured: 15,232-token floor on turns 6,
 *                                 17, 34, 89 of ses_035ef41f5).
 *   [inv:persona-idempotent]      never append a persona suffix to a message
 *                                 that already carries the ending marker.
 */

import crypto from 'node:crypto';

export const MARKERS = {
  instructions: '--- CF-Instructions:v4 ---',
  instructionsEnd: '--- /CF-Instructions ---',
  agentStart: (name, body) => `--- CF-AGENT:${name}:sha256:${sha256(body).slice(0, 16)} ---`,
  agentEnd: '--- /CF-AGENT ---',
};

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** CF instructions block — SESSION-WIDE BEHAVIOR, injected at message 1 BEFORE user text. */
export function buildCFInstructions(port) {
  return [
    '--- Content-First Session Instructions ---',
    'You are running through a session-aware content-first proxy: the shared',
    'context stays cached across agent persona switches; only the role suffix',
    'changes per turn. When the next stage of work belongs to a different',
    'specialist, hand off to it instead of doing the work yourself:',
    '',
    '  SESSION_ID=<your session id, from your persona block>',
    `  curl -s -X POST http://localhost:${port}/v1/session/agent \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"sessionId":"$SESSION_ID","agent":"<agent-name>"}'`,
    '',
    'The next turn then runs with that agent\'s persona. Available agents:',
    'cf, rf, product, architect, typescript, review, researcher, backend, security',
  ].join('\n');
}

/** FJ instructions block — SESSION-WIDE BEHAVIOR for fork-join (proxy/fj).
 * Injected at position 0 (like CF instructions) when the model is proxy/fj,
 * so the model KNOWS it can request multiple perspectives and how. The
 * endpoint is the trigger: setting a preset makes the next turn fork those
 * agents and concat their outputs back into the conversation; agents:[] clears
 * back to single-agent standard turns. No judge agent is required in the
 * loop — the model controls the active perspectives itself. */
export function buildFJInstructions(port) {
  return [
    'To hand off the current task to a set of specialist agents for their',
    'perspectives, call the session-agent endpoint with the agents list:',
    '',
    '  SESSION_ID=<your session id, from your persona block>',
    `  curl -s -X POST http://localhost:${port}/v1/session/agent \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"sessionId":"$SESSION_ID","agents":["<name1>","<name2>"]}'`,
    '',
    'Available agents:',
    'cf, rf, product, architect, typescript, review, researcher, backend, security',
  ].join('\n');
}

/** Persona suffix block — the ONLY per-agent variable injected content. */
export function buildPersonaSuffix(agentName, personaBody, handoffTask) {
  const taskBlock = handoffTask ? `Task: ${handoffTask}\n\n` : '';
  return `\n\n${MARKERS.agentStart(agentName, `${taskBlock}${personaBody}`)}\n${taskBlock}${personaBody}\n${MARKERS.agentEnd}`;
}

/**
 * Split the composed opencode system prompt into [shared boilerplate][agent role].
 * Used ONLY for metrics/attribution — the system message is NEVER rewritten.
 */
export function splitSystemPrompt(system, AGENTS) {
  if (!system) return { shared: '', agentRole: '' };
  if (!AGENTS || AGENTS.size === 0) return { shared: system, agentRole: '' };
  let bestMatch = '';
  let bestAgentName = '';
  for (const [name, agent] of AGENTS.entries()) {
    const body = agent.systemPrompt;
    if (system.startsWith(body) && body.length > bestMatch.length) {
      bestMatch = body;
      bestAgentName = name;
    }
  }
  if (bestMatch.length > 50) {
    return { agentRole: bestMatch, shared: system.slice(bestMatch.length).trim(), agentName: bestAgentName, method: 'prefix' };
  }
  // F4 (2026-08-04): the agent body may NOT be a prefix of the SP (non-standard
  // composition — e.g. a chain wrapper prepended, or the body reordered). The
  // old fallback returned shared='' and kept the FULL SP (agent body included)
  // at position 0, which is NOT byte-stable across handoffs → cross-agent
  // cache reuse silently degrades (position-0 anchor breaks). Fix: search for
  // the longest agent body ANYWHERE in the SP; if found, extract it as the
  // agentRole and keep everything else as shared. Only if NO agent body is
  // found anywhere do we fall back to the full-SP-as-role (bare opencode SP).
  let bestAny = '', bestAnyName = '';
  for (const [name, agent] of AGENTS.entries()) {
    const body = agent.systemPrompt;
    if (body.length > 50 && system.includes(body) && body.length > bestAny.length) {
      bestAny = body;
      bestAnyName = name;
    }
  }
  if (bestAny.length > 50) {
    const shared = system.replace(bestAny, '').trim();
    return { agentRole: bestAny, shared, agentName: bestAnyName, method: 'contains' };
  }
  return { shared: '', agentRole: system, method: 'fallback' };
}

/**
 * Resolve an agent from a NAME or full system prompt (registry prefix match).
 */
export function resolveAgent(nameOrSP, AGENTS) {
  if (!nameOrSP) return null;
  if (AGENTS.has(nameOrSP)) return AGENTS.get(nameOrSP);
  const bare = nameOrSP.includes('/') ? nameOrSP.split('/').pop() : nameOrSP;
  if (AGENTS.has(bare)) return AGENTS.get(bare);
  if (nameOrSP.length > 60) {
    let best = null, bestLen = 0;
    for (const agent of AGENTS.values()) {
      const body = agent.systemPrompt;
      if (nameOrSP.startsWith(body.slice(0, 200)) && body.length > bestLen) {
        best = agent; bestLen = body.length;
      }
    }
    if (best) return best;
    const probe = nameOrSP.slice(0, 120).replace(/\s+/g, ' ');
    for (const agent of AGENTS.values()) {
      if (agent.systemPrompt.slice(0, 120).replace(/\s+/g, ' ') === probe) return agent;
    }
  }
  return null;
}

/**
 * THE REWRITE (v4).
 *
 * @param {Array} messages inbound messages from opencode
 * @param {Object} opts
 *   personaSP    active agent's bare body ('' if none)
 *   cfPrompt     CF instructions text (session-wide behavior)
 *   handoffTask  warm-handoff task (null = cold)
 *   agentName    resolved agent name for the persona marker
 * @returns {Array} forwarded messages
 */
export function rewriteToContentFirst(messages, opts = {}) {
  const {
    personaSP = '', cfPrompt = '',
    handoffTask = null, agentName = '',
    AGENTS = null, sessionId = null,
  } = opts;
  const result = messages.map(m => ({ ...m, content: typeof m.content === 'string' ? m.content : (m.content == null ? '' : JSON.stringify(m.content)) }));

  // [inv:position0-anchor] — position 0 = the opencode shared boilerplate with
  // the agent body EXTRACTED; the persona lives ONLY at the tail, never twice.
  //   [agent_body][boilerplate]  →  [boilerplate]            (extraction)
  //   [boilerplate]              →  [CF instructions][boilerplate]  (injection)
  //
  // EXTRACTION and INJECTION are DECOUPLED (2026-08-05 fix): `cf_instructions:
  // false` was intended to skip only the INJECTION (the CF-instruction block
  // carries the session id — a per-fork sub-session id baked in would differ
  // per fork and blow the shared cache prefix). It was incorrectly implemented
  // to skip the ENTIRE block, leaving the main agent's persona body at position
  // 0 of fork requests — so forks believed they WERE the main agent. The
  // extraction must always run: position 0 must never carry a persona body,
  // injected instructions or not. The injection is gated on cfPrompt.
  //
  // Idempotent: skip both if the CF marker is already present (a previously
  // rewritten system message being re-posted).
  const sysIdx = result.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    const rawSystem = result[sysIdx].content;
    if (!rawSystem.includes(MARKERS.instructions)) {
      // ── EXTRACTION (always): remove the agent body if it prefixes the SP ──
      const { shared } = splitSystemPrompt(rawSystem, AGENTS);
      if (shared) {
        result[sysIdx] = { ...result[sysIdx], content: shared };
      } else if (rawSystem.length > 200) {
        // shared='' (bare opencode SP, no agent-body prefix) → keep the FULL SP
        // so position 0 is never emptied (regression: 96185ef empty-shared bug).
        // WARNING: if the agent body is NOT a prefix (non-standard SP composition),
        // the full SP (including agent body) stays at position 0 — NOT byte-stable
        // across handoffs, breaking cross-agent cache reuse. Log so it surfaces.
        console.error(`[cf-rewrite] ⚠ position-0 anchor: agent body not a prefix of opencode SP — full SP retained (${rawSystem.length} chars); cross-agent reuse may break.`);
      }
    }
  }
  // ── INJECTION (only when cfPrompt is set) ──
  if (cfPrompt) {
    const injIdx = result.findIndex(m => m.role === 'system');
    if (injIdx !== -1 && !result[injIdx].content.includes(MARKERS.instructions)) {
      result[injIdx] = { ...result[injIdx], content: `${MARKERS.instructions}\n${cfPrompt}\n${MARKERS.instructionsEnd}\n\n${result[injIdx].content}` };
    }
  }

  // [inv:persona-always-tail] — persona on the TRUE LAST message, unconditionally.
  // [inv:persona-idempotent] — never double-append.
  // [inv:persona-never-user] — the persona is NEVER injected as a new
  // `user`-role message. A synthetic user turn pollutes the conversation:
  // it looks like user speech (the model may treat it as user intent), it
  // breaks the user/assistant/tool alternation that DeepSeek's thinking-mode
  // reasoning-echo validation keys on, and it adds a spurious turn to the
  // conversation. The persona is APPENDED to the last message's content as a
  // suffix (the cache-safe tail position), never emitted as its own message.
  // Tool-call assistant messages in the history are left untouched — the
  // reasoning-echo contract is satisfied by [inv:reasoning-echo] below, not
  // by persona placement.
  if (personaSP) {
    // The session id rides the PERSONA TAIL, never position 0 (2026-08-05):
    // the CF/FJ instructions are session-id-free so position 0 is byte-
    // identical across ALL sessions and persona transitions — handoff chains
    // (product → fan out → product → typescript → fan out → typescript) keep
    // the shared prefix cached. The agent still needs its session id for the
    // endpoint recipes, so it is prepended to the persona suffix.
    const sessionPrefix = sessionId ? `SESSION_ID=${sessionId}\n\n` : '';
    const suffix = buildPersonaSuffix(agentName || 'agent', sessionPrefix + personaSP, handoffTask);
    const lastIdx = result.length - 1;
    const lastMsg = result[lastIdx];
    if (lastMsg && !String(lastMsg.content || '').includes(MARKERS.agentEnd)) {
      lastMsg.content = String(lastMsg.content || '') + suffix;
    }
  }

  return result;
}

/**
 * In-flight cache-blow predictor. Given the previous turn's forwarded messages
 * and the current forwarded messages, compute the LONGEST COMMON PREFIX and
 * predict what prompt_cache_hit_tokens the provider will report.
 *
 * @param {Array} prevForwarded messages forwarded last turn (with persona tail)
 * @param {Array} curForwarded  messages about to be forwarded (with persona tail)
 * @returns {number} predicted cached tokens (chars/4 estimate)
 */
export function predictCacheHit(prevForwarded, curForwarded) {
  const ser = msgs => msgs.map(m => `<${m.role}>${m.content}`).join('');
  const a = ser(prevForwarded || []);
  const b = ser(curForwarded || []);
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return Math.floor(i / 4);
}

/** Serialize forwarded messages (logging + fingerprinting). */
export function serializeForwarded(msgs) {
  return msgs.map(m => `<${m.role}>${m.content}`).join('\n');
}

/**
 * Corruption decision logic (pure — mirrors cf-proxy.mjs corruptionCheck).
 * Exported so tests exercise the REAL logic instead of a duplicated mirror.
 * Returns true if the persona change is legitimate; false = corruption.
 */
export function isPersonaChangeAllowed(session, requestedAgent) {
  if (!session) return true;
  const prev = session.activeAgent;
  if (!prev) return true;                              // first contact
  if (requestedAgent === prev) return true;            // same agent — no change
  if (session.handoffAuthorized && session.handoffAuthorized === requestedAgent) return true;
  if (session.apiOverride && session.activeAgent === requestedAgent) return true;
  return false;                                        // mid-stage change = corruption
}

/**
 * Persona-residual marker count across a message list (mirrors
 * scanForSPResiduals' marker check). Exported for real-logic testing.
 */
export function personaMarkerCount(messages) {
  return messages.reduce((n, m) => n + (String(m.content || '').match(/--- Role ---/g) || []).length, 0);
}
