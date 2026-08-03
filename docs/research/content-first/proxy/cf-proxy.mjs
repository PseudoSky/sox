/**
 * cf-proxy.mjs  —  Content-First Proxy Server (session-aware)
 *
 * OpenAI-compatible HTTP server that transparently rewrites role-first calls
 * into content-first. Session-aware: it tracks opencode's real session id
 * (x-session-id header), detects & persists the active agent, allows the
 * active agent to be overridden via POST /v1/session/agent, and names its
 * log files per session.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — OpenAI chat API (streaming, session-aware)
 *   POST /v1/session/agent      — resolve + switch the session's active agent
 *   GET  /v1/session/:id        — session state (active agent, turns, tokens)
 *   POST /v1/chat/fork          — fork N agents from shared context
 *   GET  /v1/health             — health check
 *
 * Session semantics:
 *   - session.opencodeAgent = last agent DETECTED from opencode's system prompt.
 *   - session.activeAgent    = the agent whose SP the proxy USES. Starts equal
 *     to opencodeAgent; can be overridden via /v1/session/agent.
 *   - Manual dropdown change (opencode sends a different SP) is detected by
 *     comparing the detected agent against session.opencodeAgent; on change
 *     BOTH are updated. An API override persists until opencode itself changes.
 *   - The SP used for the turn = activeAgent's SP (substituted for whatever
 *     opencode sent), so the API override wins over the opencode-supplied SP.
 *
 * Virtual tool: the proxy injects a `set_session_agent` tool into the
 * outbound request. If the model calls it, the proxy intercepts the call,
 * updates the session's active agent, synthesizes a tool result, and re-runs
 * the turn once with the result — the agent switches persona without needing
 * a separate HTTP call.
 *
 * Env:
 *   CF_PORT=3333          Port
 *   CF_LOG=<path>         Base log dir/file (per-session logs are derived)
 *   CF_VERBOSE=1          Verbose stdout
 *   CF_PASSTHROUGH=1      Skip rewrite (transparent passthrough)
 *   CF_RAW=1              Log full headers + request body per call
 *   CF_DISABLE_TOOL=1     Do not inject the virtual set_session_agent tool
 *   DEEPSEEK_API_KEY      Required
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CF_PORT || '3333', 10);
const TARGET_BASE = process.env.CF_TARGET || 'https://api.deepseek.com/v1';
const TARGET_MODEL = process.env.CF_MODEL || 'deepseek-v4-flash';
const VERBOSE = process.env.CF_VERBOSE === '1';
const PASSTHROUGH = process.env.CF_PASSTHROUGH === '1';
const RAW_CAPTURE = process.env.CF_RAW === '1';
const INJECT_TOOL = process.env.CF_DISABLE_TOOL !== '1';
const LOG_BASE = process.env.CF_LOG || path.join(__dirname, 'proxy-cf-log.jsonl');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET || process.env.OPENAI_API_KEY || '';

// ──────── Agent registry ────────

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

function loadAgentRegistry() {
  const registry = new Map();
  try {
    for (const file of fs.readdirSync(AGENT_DIR)) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace(/\.md$/, '');
      const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf-8');
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      registry.set(name, {
        name, file,
        model: fm?.model || 'unknown',
        description: fm?.description || '',
        systemPrompt: body || `You are the ${name} agent.`,
      });
    }
  } catch (e) { console.error(`[cf-proxy] agent registry load failed: ${e.message}`); }
  return registry;
}
const AGENTS = loadAgentRegistry();

/**
 * Resolve an agent from a NAME or a full system prompt.
 * For a full opencode SP, we match the leading agent body against the
 * registry (opencode composes SP = [agent_body][shared_boilerplate]).
 */
function resolveAgent(nameOrSP) {
  if (!nameOrSP) return null;
  if (AGENTS.has(nameOrSP)) return AGENTS.get(nameOrSP);
  const bare = nameOrSP.includes('/') ? nameOrSP.split('/').pop() : nameOrSP;
  if (AGENTS.has(bare)) return AGENTS.get(bare);
  // Long SP → try leading-prefix match against each agent body
  if (nameOrSP.length > 60) {
    let best = null, bestLen = 0;
    for (const agent of AGENTS.values()) {
      const body = agent.systemPrompt;
      if (nameOrSP.startsWith(body.slice(0, 200)) && body.length > bestLen) {
        best = agent; bestLen = body.length;
      }
    }
    if (best) return best;
    // relaxed: first 120 chars normalized equal
    const probe = nameOrSP.slice(0, 120).replace(/\s+/g, ' ');
    for (const agent of AGENTS.values()) {
      if (agent.systemPrompt.slice(0, 120).replace(/\s+/g, ' ') === probe) return agent;
    }
  }
  return null;
}

// ──────── Session store ────────

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      activeAgent: null,      // agent the proxy USES (API-overridable)
      customSP: null,         // fallback SP when agent can't be resolved
      opencodeAgent: null,    // last agent detected from opencode's SP
      opencodeSP: null,       // last SP opencode sent (for change detection)
      apiOverride: false,     // true when activeAgent was set via /v1/session/agent
      pendingInput: null,     // DEPRECATED — handoff tasks are read from the
                              // session_agent_set tool call in the conversation,
                              // not redundantly injected as a new user message
      context: [],            // accumulated messages (cache anchor)
      // Per-persona metrics (reset on agent change)
      personaTurns: 0,        // turns since the current persona started
      personaCtxChars: 0,     // cumulative non-shared non-persona context chars
      createdAt: new Date().toISOString(),
      turns: 0,
    });
  }
  return sessions.get(id);
}

/**
 * Resolve the session's effective persona SP, detecting opencode agent changes.
 * Returns { personaSP, activeAgent, changed }.
 *
 * Rules:
 *   - session.activeAgent: the persona the proxy USES.
 *   - session.opencodeAgent: last agent detected from opencode's SP.
 *   - Manual dropdown change: opencode sends a DIFFERENT SP than last time →
 *     follow it (update both).
 *   - API override (session.apiOverride=true): the explicit session choice
 *     WINS over whatever opencode sends, until the user manually changes the
 *     dropdown to a DIFFERENT agent than the override target.
 */
function resolveSessionPersona(session, opencodeSP) {
  const detected = resolveAgent(opencodeSP);
  const opencodeChanged = detected?.name !== session.opencodeAgent;

  // Manual dropdown change: opencode sent a different agent than last time.
  // When there is an API override, it holds until opencode's detected agent
  // MATCHES the override target (dropdown caught up) — then the override is
  // released and normal detection resumes. An override is never silently
  // clobbered by a re-send of the dropdown's pre-override agent.
  let manualChange;
  if (session.apiOverride) {
    manualChange = opencodeChanged && detected?.name === session.activeAgent;
    if (manualChange) session.apiOverride = false; // caught up → release
  } else {
    manualChange = opencodeChanged;
  }

  if (opencodeChanged) {
    session.opencodeAgent = detected?.name || null;
    session.opencodeSP = opencodeSP || null;
  }
  if (manualChange) {
    // opencode genuinely switched (or first contact) → follow it
    session.activeAgent = detected?.name || null;
    session.customSP = detected ? null : (opencodeSP || '');
    // Reset per-persona metrics on agent change
    session.personaTurns = 0;
    session.personaCtxChars = 0;
  }
  // Effective persona SP: activeAgent's registry SP, else custom SP
  const personaSP = session.activeAgent
    ? (AGENTS.get(session.activeAgent)?.systemPrompt || '')
    : (session.customSP || opencodeSP || '');
  return { personaSP, activeAgent: session.activeAgent, changed: manualChange };
}

function sessionLogPath(sessionId) {
  if (!sessionId) return LOG_BASE;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(__dirname, `proxy-${safe}.jsonl`);
}

// ──────── Logger ────────

function logCall(entry, sessionId) {
  entry._ts = new Date().toISOString();
  const logPath = sessionId ? sessionLogPath(sessionId) : LOG_BASE;
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch {}
  if (VERBOSE) {
    console.log('');
    console.log('── CF Proxy ──────────────────────────────────────────');
    console.log(`  session=${sessionId || '?'}  agent=${entry.agent || '?'}  turns=${entry.turns ?? '?'}`);
    console.log(`  tokens=${entry.tokens ?? '?'}  cached=${entry.cached ?? '?'}  savings=${entry.savings_pct ?? '?'}%  model=${entry.model ?? '?'}`);
    console.log('──────────────────────────────────────────────────────');
  }
}

// ──────── Cache simulation ────────

class BlockCacheSim {
  constructor() { this.blocks = new Map(); this.hits = 0; this.misses = 0; }
  get(hash) { const hit = this.blocks.has(hash); if (hit) this.hits++; else this.misses++; return hit; }
  set(hash, size) { this.blocks.set(hash, size); }
  stats() { const total = this.hits + this.misses; return { blocks: this.blocks.size, hits: this.hits, misses: this.misses, hitRate: total > 0 ? (this.hits / total * 100).toFixed(1) + '%' : '0%' }; }
}
const cache = new BlockCacheSim();

// ──────── Core rewrite logic ────────

/**
 * Split the composed opencode system prompt into [shared boilerplate][agent role].
 * opencode prepends the agent .md body, then appends shared boilerplate.
 */
function splitSystemPrompt(system) {
  if (!system) return { shared: '', agentRole: '' };
  let bestMatch = '';
  for (const agent of AGENTS.values()) {
    const body = agent.systemPrompt;
    if (system.startsWith(body) && body.length > bestMatch.length) bestMatch = body;
  }
  if (bestMatch.length > 50) {
    return { agentRole: bestMatch, shared: system.slice(bestMatch.length).trim() };
  }
  return { shared: '', agentRole: system };
}

/**
 * Content-first rewrite for a session turn.
 *
 * Forwarded structure (matches RESUME.md §2 design — proven cache reuse):
 *   [0] system: shared boilerplate + CF instructions  ← position 0, cache anchor
 *   [1..n] history (untouched)
 *   [last user]: "...\n\n--- Role ---\n<persona body>"  ← persona suffix on last user
 *
 * CF instructions (handoff recipe + session id) live in position 0 alongside
 * the shared boilerplate — session-constant, cached once, zero per-turn waste.
 *
 * The persona is appended to the LAST USER MESSAGE, NOT as a trailing system.
 * This is the structure that produced 82-93% first-turn cache reuse in
 * sessions 03c0c039c and 03c3312d1 — the conversation prefix (everything
 * before the persona-suffixed last user) is byte-identical across agent
 * switches, so the provider cache hits on the full accumulated context.
 *
 * Two critical invariants:
 *   1. SHARED comes from the opencode system prompt, which is composed as
 *      [agent_body][shared_boilerplate]. It is NEVER derived from the bare
 *      persona body — that body has no boilerplate, so splitting against it
 *      yields shared='' and the system message gets DESTROYED.
 *   2. The persona is a suffix on the LAST USER message. This is the structure
 *      proven to produce cross-agent cache reuse: the conversation grows
 *      monotonically between turns, and the only divergence at handoff is the
 *      persona suffix on the very last message — the entire preceding context
 *      remains in the cacheable prefix.
 */
function rewriteToContentFirst(messages, personaSP, opencodeSP, cfPrompt) {
  const system = messages.find(m => m.role === 'system')?.content;
  const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
  if (lastUserIdx === -1) {
    return { messages, system, savings: 0, cachedSeed: false, seedTokens: 0, systemTokens: 0, agentTokens: 0 };
  }

  // SHARED always from the opencode SP (has the boilerplate). When the SP has
  // no agent-body prefix (bare opencode base in a chained session),
  // splitSystemPrompt returns shared='' — falling back to the FULL SP keeps
  // position 0 non-empty and byte-identical across agents, so the provider's
  // prefix cache survives every handoff (regression: sharedSysLen=0 destroyed
  // the anchor and killed cross-agent cache reuse).
  const baseShared = splitSystemPrompt(opencodeSP || system).shared || (opencodeSP || system) || '';
  // PERSONA from the session active agent's bare body; falls back to the
  // opencode SP's agent body on first contact.
  const { agentRole } = splitSystemPrompt(personaSP || opencodeSP || system);
  const systemTokens = Math.ceil((system || '').length / 4);
  const seedTokens = Math.ceil(messages[lastUserIdx].content.length / 4);

  const result = messages.map(m => ({ ...m }));
  // Position-0 system message = shared boilerplate + CF instructions.
  // CF instructions are session-constant: cached once, zero per-turn cost.
  const cfText = cfPrompt ? `\n\n${cfPrompt}` : '';
  const shared = baseShared + cfText;
  const sysIdx = result.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    result[sysIdx] = { ...result[sysIdx], content: shared };
  }

  // Persona as a suffix on the LAST USER message — the structure proven to
  // produce cross-agent cache reuse (sessions 03c0c039c: 82-93%,
  // 03c3312d1: 52-80%). The conversation before the last user message is
  // byte-identical across agent switches → provider cache hits on the full
  // accumulated context.
  const lastUser = result.filter(m => m.role === 'user');
  const lastUserMsg = lastUser[lastUser.length - 1];
  lastUserMsg.content = `${lastUserMsg.content}\n\n--- Role ---\n${agentRole}`;
  const personaMarker = '--- Role ---\n';

  const seedHash = seedTokens > 100 ? `seed-${seedTokens}` : null;
  const cached = seedHash ? cache.get(seedHash) : false;
  if (seedHash && !cached) cache.set(seedHash, seedTokens);

  // Tail = the persona suffix only (appended to last user message, not a separate message).
  const tailTokens = Math.ceil(agentRole.length / 4) + Math.ceil(personaMarker.length / 4);

  return {
    messages: result,
    system: shared,
    agentRole,   // exposed for per-request context metrics
    savings: cached ? ((seedTokens / (seedTokens + tailTokens)) * 100).toFixed(1) : '0.0',
    cachedSeed: cached,
    seedTokens,
    systemTokens,
    agentTokens: tailTokens,
    cfTokens: 0,  // at position 0; no longer variable tail
  };
}

// ──────── CF flow instructions (Option 2: session handle in context) ────────

/**
 * Render the content-first process instructions with the session id baked in.
 *
 * Lives at position 0 alongside the shared boilerplate — cached once, zero
 * per-turn waste.
 *
 * The agent learns its own session id from this anchor and uses it to call
 * POST /v1/session/agent when handing off. The handoff task lives in the
 * `input` field of the session_agent_set tool call — already in the
 * conversation — so the next agent reads it from context without redundant
 * message injection.
 */
function renderCFInstructions(sessionId) {
  const agents = [...AGENTS.keys()].sort();
  return [
    '--- Content-First Session Instructions ---',
    `Your session id is: ${sessionId || '(unset)'}.`,
    'You are running through a session-aware content-first proxy: the shared',
    'context stays cached across agent persona switches; only the user-message',
    'suffix changes per turn. When the next stage belongs to a different',
    'specialist, hand off to it instead of doing the work yourself:',
    '',
    `  curl -s -X POST http://localhost:${PORT}/v1/session/agent \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"sessionId":"${sessionId}","agent":"<agent-name>","input":"<task>"}'`,
    '',
    'The next turn runs with that agent\'s persona. The handoff task is already',
    'in the conversation (the `input` field of the session_agent_set tool call)',
    '— read it from context; nothing is redundantly injected. Available agents:',
    agents.join(', '),
  ].join('\n');
}

// ──────── Virtual tool definition ────────

const SESSION_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'set_session_agent',
    description: 'Switch the current session to a different agent persona. Call this when you determine the next stage of work should be handled by a different agent (e.g. triage → judge → implement → review).',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent name to switch to (e.g. review, backend, architect).' },
        reason: { type: 'string', description: 'Why the switch is happening.' },
      },
      required: ['agent'],
    },
  },
};

function injectSessionTool(tools) {
  if (!INJECT_TOOL) return tools || [];
  const list = Array.isArray(tools) ? [...tools] : [];
  if (!list.some(t => t?.function?.name === 'set_session_agent')) {
    list.push(SESSION_AGENT_TOOL);
  }
  return list;
}

// ──────── Forward with streaming support ────────

async function forwardStream(providerMessages, reqData, res, options = {}) {
  const body = {
    ...reqData,
    model: options.model || reqData.model || TARGET_MODEL,
    messages: providerMessages,
    stream: true,
  };

  const response = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    const errMsg = `data: {"error":"Provider ${response.status}: ${errText.slice(0,200)}"}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(errMsg);
    return { inputTokens: 0, outputTokens: 0, cacheHits: 0, fullText: '', toolCalls: [] };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let inputTokens = 0, outputTokens = 0, cacheHits = 0;
  const toolCalls = []; // accumulated {id, name, args}

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);

    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.usage) {
            inputTokens = data.usage.prompt_tokens || 0;
            outputTokens = data.usage.completion_tokens || 0;
            cacheHits = data.usage.prompt_cache_hit_tokens || 0;
          }
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) fullText += delta.content;
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              let cur = toolCalls.find(t => t.id === tc.id);
              if (!cur) { cur = { id: tc.id, name: '', args: '' }; toolCalls.push(cur); }
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
  }

  res.end();
  return { inputTokens, outputTokens, cacheHits, fullText, toolCalls };
}

async function forwardBlocking(messages, options = {}) {
  const body = {
    model: options.model || TARGET_MODEL,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.max_tokens ?? 2000,
    tools: injectSessionTool(options.tools),
  };
  const start = Date.now();
  const res = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  const data = await res.json();
  const usage = data.usage || {};
  return {
    ...data,
    provider: {
      tokens: {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        cacheHit: usage.prompt_cache_hit_tokens || 0,
      },
      latencyMs: elapsed,
    },
  };
}

// ──────── HTTP server ────────

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CF-Session-Id, X-Session-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // GET /v1/health
    if (req.method === 'GET' && p === '/v1/health') {
      return jsonResponse(res, 200, {
        ok: true,
        mode: PASSTHROUGH ? 'passthrough' : 'content-first',
        target: { base: TARGET_BASE, model: TARGET_MODEL },
        cache: cache.stats(),
        sessions: sessions.size,
        agents: AGENTS.size,
        sessionTool: INJECT_TOOL,
      });
    }

    // GET /v1/agents
    if (req.method === 'GET' && p === '/v1/agents') {
      const list = [...AGENTS.values()].map(a => ({
        name: a.name, model: a.model, description: a.description,
        sp_preview: a.systemPrompt.slice(0, 80),
      }));
      return jsonResponse(res, 200, { agents: list, count: list.length });
    }

    // GET /v1/session/:id
    if (req.method === 'GET' && p.startsWith('/v1/session/')) {
      const id = p.split('/').pop();
      const s = getSession(id);
      return jsonResponse(res, 200, {
        sessionId: id,
        activeAgent: s.activeAgent,
        opencodeAgent: s.opencodeAgent,
        apiOverride: s.apiOverride,
        customSP: s.customSP ? s.customSP.slice(0, 80) : null,
        turns: s.turns,
        contextTokens: s.context.reduce((n, m) => n + Math.ceil((m.content || '').length / 4), 0),
        contextMessages: s.context.length,
        createdAt: s.createdAt,
      });
    }

    // POST /v1/session/agent — switch the session's active agent
    if (req.method === 'POST' && p === '/v1/session/agent') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const sessionId = reqData.sessionId || reqData.session_id || req.headers['x-session-id'] || null;
      const nextAgent = reqData.agent || reqData.persona;
      const input = reqData.input || '';
      if (!sessionId || !nextAgent) {
        return jsonResponse(res, 400, { error: 'sessionId and agent required' });
      }

      const session = getSession(sessionId);
      const resolved = resolveAgent(nextAgent);
      if (!resolved) {
        return jsonResponse(res, 404, { error: `agent not found: ${nextAgent}`, registry: [...AGENTS.keys()] });
      }

      session.activeAgent = resolved.name;
      session.customSP = null;
      session.apiOverride = true;
      // Reset per-persona metrics on agent switch.
      session.personaTurns = 0;
      session.personaCtxChars = 0;
      // Seed opencodeAgent so the next request doesn't look like a manual
      // switch away from the override target.
      if (!session.opencodeAgent) session.opencodeAgent = resolved.name;
      logCall({ event: 'session_agent_set', agent: resolved.name, turns: session.turns }, sessionId);

      // The handoff task is persisted in the conversation (the session_agent_set
      // tool call args). The next agent reads it from context — no pendingInput
      // injection needed. The input field is preserved in the log for audit.
      return jsonResponse(res, 200, {
        sessionId, activeAgent: resolved.name, switched: true,
        note: 'Next turn runs with the new persona. Task is in the tool call conversation context.',
      });
    }

    // POST /v1/chat/completions — session-aware streaming
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const messages = reqData.messages || [];
      const sessionId = req.headers['x-session-id'] || req.headers['x-cf-session-id'] ||
        reqData.session_id || reqData.sessionId || null;

      // RAW CAPTURE
      if (RAW_CAPTURE) {
        const rawEntry = {
          _ts: new Date().toISOString(),
          event: 'raw_request',
          sessionId,
          headers: { ...req.headers },
          body_keys: Object.keys(reqData),
          full_body: reqData,
        };
        try { fs.appendFileSync(LOG_BASE, JSON.stringify(rawEntry) + '\n'); } catch {}
      }

      const opencodeSP = messages.find(m => m.role === 'system')?.content || null;

      // Session persona resolution (detect + persist + allow override)
      const session = sessionId ? getSession(sessionId) : null;
      console.error(`[cf-proxy] chat-session lookup: id=${JSON.stringify(sessionId)} exists=${!!session} activeAgent=${session?.activeAgent ?? 'N/A'} apiOverride=${session?.apiOverride ?? 'N/A'}`);
      const { personaSP, activeAgent, changed } = session
        ? resolveSessionPersona(session, opencodeSP)
        : { personaSP: null, activeAgent: null, changed: false };

      const modelStr = reqData.model || '';
      const isCFModel = /(^|\/)cf$/.test(modelStr) || modelStr === 'cf';
      const doPassthrough = PASSTHROUGH || !isCFModel;

      console.error(`[cf-proxy] session=${sessionId || 'none'} model="${modelStr}" agent=${activeAgent || opencodeSP?.slice(0, 40) || '?'} depth=${messages.filter(m => m.role === 'user').length} mode=${doPassthrough ? 'passthrough' : 'cf'}${changed ? ' [agent-detected-change]' : ''}`);

      if (doPassthrough) {
        const result = await forwardStream(messages, reqData, res, { model: TARGET_MODEL });
        // Attribute the turn to the actual stage agent (product/architect/
        // typescript/review) even in RF mode — the name is in the opencode SP.
        const rfAgent = activeAgent || resolveAgent(opencodeSP)?.name || '(passthrough)';
        logCall({
          event: 'turn', agent: rfAgent, turns: session?.turns ?? 0,
          passthrough: true,
          // Uniform metrics schema across both arms (rf and cf) so per-agent
          // comparison is direct: same field names, same savings math.
          tokens: result.inputTokens, cached: result.cacheHits, output: result.outputTokens,
          savings_pct: result.inputTokens > 0 ? ((result.cacheHits / result.inputTokens) * 100).toFixed(1) : '0.0',
          model: modelStr,
        }, sessionId);
        if (session) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
          if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
          session.turns++;
        }
        return;
      }

      // ── Content-first path (true streaming) ──
      // The handoff task is ALREADY in the conversation (session_agent_set
      // tool call args). Re-injecting it as pendingInput was redundant and
      // broke prefix cache contiguity at every handoff — the extra user
      // message shifted the sequence and prevented the provider from reusing
      // the prior agent's full context. The new agent reads its task from the
      // tool call `input` field in the conversation.
      const cfPrompt = sessionId ? renderCFInstructions(sessionId) : null;
      const cf = rewriteToContentFirst(messages, personaSP, opencodeSP, cfPrompt);

      // ── Enhanced metrics ──
      const totalMsgChars = cf.messages.reduce((s, m) => s + (m.content?.length || 0), 0);
      const sharedChars = cf.messages[0]?.content?.length || 0;
      const personaMarkerChars = '\n\n--- Role ---\n'.length;
      const personaChars = (cf.agentRole ? cf.agentRole.length : 0) + personaMarkerChars;
      const contextChars = totalMsgChars - sharedChars - personaChars;
      // Increment per-persona metrics
      if (session) {
        session.personaTurns++;
        session.personaCtxChars += contextChars;
      }
      // Verify BOTH invariants reached the forwarded messages:
      //  - personaApplied: last USER message carries "--- Role ---" (persona suffix)
      //  - sharedSystem: position-0 system message is NOT emptied
      const lastUserP = [...cf.messages].reverse().find(m => m.role === 'user');
      const lastUserContent = lastUserP?.content || '';
      const roleApplied = lastUserContent.includes('--- Role ---');
      const sharedSysLen = cf.messages[0]?.content?.length || 0;
      console.error(`[cf-proxy] rewrite: agent=${activeAgent || '?'} shared=${sharedChars} persona=${personaChars} ctx=${contextChars} sessTurns=${session?.turns ?? 0} personaTurns=${session?.personaTurns ?? 0} personaCtx=${session?.personaCtxChars ?? 0} role=${roleApplied}`);

      // True streaming passthrough to upstream. The virtual tool is DISABLED
      // here (CF_VIRTUAL_TOOL=1 re-enables it later once the baseline works);
      // session agent switching happens via POST /v1/session/agent instead.
      const result = await forwardStream(cf.messages, reqData, res, { model: TARGET_MODEL });

      // Store turn in session context
      if (session) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
        if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
        session.turns++;
      }

      logCall({
        event: 'turn', agent: activeAgent || '(unassigned)', turns: session?.turns ?? 0,
        passthrough: false,
        agent_changed: changed,
        // Uniform metrics schema across both arms (cf and rf) so per-agent
        // comparison is direct: same field names, same savings math.
        tokens: result.inputTokens, cached: result.cacheHits, output: result.outputTokens,
        savings_pct: result.inputTokens > 0 ? ((result.cacheHits / result.inputTokens) * 100).toFixed(1) : '0.0',
        cached_seed: cf.cachedSeed,
        seed_tokens: cf.seedTokens, system_tokens: cf.systemTokens,
        model: modelStr,
        // Enhanced per-request context metrics
        shared_chars: sharedChars,
        persona_chars: personaChars,
        context_chars: contextChars,
        persona_turns: session?.personaTurns ?? 0,
        persona_ctx_chars: session?.personaCtxChars ?? 0,
      }, sessionId);
      return;
    }

    // POST /v1/chat/fork
    if (req.method === 'POST' && p === '/v1/chat/fork') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const sharedContext = reqData.shared_context || '';
      const forks = reqData.forks || [];
      if (!sharedContext || forks.length === 0) {
        return jsonResponse(res, 400, { error: 'shared_context and forks required' });
      }

      const results = [];
      for (let i = 0; i < forks.length; i++) {
        const fork = forks[i];
        const roleSuffix = fork.role || fork.system || '';
        const cfContent = `${sharedContext}\n\n${roleSuffix}`;
        const start = Date.now();
        const response = await forwardBlocking(
          [{ role: 'user', content: cfContent }],
          { model: TARGET_MODEL, max_tokens: fork.max_tokens, temperature: fork.temperature ?? 0, tools: [] }
        );
        const elapsed = Date.now() - start;
        const isWarm = i > 0;
        const shareTokens = Math.ceil(sharedContext.length / 4);
        const suffixTokens = Math.ceil(roleSuffix.length / 4);
        results.push({
          index: i,
          role: roleSuffix.slice(0, 80),
          tokens: {
            input: response.provider.tokens.prompt,
            output: response.provider.tokens.completion,
            estimated_shared: shareTokens,
            estimated_suffix: suffixTokens,
          },
          warm_start: isWarm,
          estimated_savings_pct: isWarm
            ? ((shareTokens / (shareTokens + suffixTokens)) * 100).toFixed(1)
            : '0.0 (cold seed)',
          output: response.choices?.[0]?.message?.content || '',
          latency_ms: elapsed,
        });
      }

      logCall({
        event: 'fork', forks: forks.length,
        shared_context_tokens: Math.ceil(sharedContext.length / 4),
        results: results.map(r => ({
          index: r.index, warm: r.warm_start, tokens_in: r.tokens.input,
          tokens_out: r.tokens.output, savings: r.estimated_savings_pct, latency: r.latency_ms,
        })),
      });
      return jsonResponse(res, 200, {
        object: 'fork', model: TARGET_MODEL,
        forks: forks.length, shared_context_tokens: Math.ceil(sharedContext.length / 4), results,
      });
    }

    return jsonResponse(res, 404, { error: 'Not found', path: p });

  } catch (err) {
    console.error(`[cf-proxy] Error: ${err.message}`);
    if (!res.headersSent) return jsonResponse(res, 500, { error: err.message });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════════╗`);
  console.log(`  ║  Content-First Proxy (session-aware)                ║`);
  console.log(`  ║  Port: ${PORT}   Sessions: ${sessions.size}  Agents: ${AGENTS.size}       ║`);
  console.log(`  ║  Target: ${TARGET_BASE}  ║`);
  console.log(`  ║  Model: ${TARGET_MODEL}  Virtual tool: ${INJECT_TOOL ? 'on' : 'off'}        ║`);
  console.log(`  ║  Log base: ${LOG_BASE}  ║`);
  console.log(`  ╚══════════════════════════════════════════════════════╝\n`);
});
