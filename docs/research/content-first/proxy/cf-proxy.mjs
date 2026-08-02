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
      context: [],            // accumulated messages (cache anchor)
      createdAt: new Date().toISOString(),
      turns: 0,
    });
  }
  return sessions.get(id);
}

/**
 * Resolve the session's effective persona SP, detecting opencode agent changes.
 * Returns { personaSP, activeAgent, changed }.
 */
function resolveSessionPersona(session, opencodeSP) {
  const detected = resolveAgent(opencodeSP);
  const changed = detected?.name !== session.opencodeAgent;
  if (changed) {
    // opencode switched agents (or first contact) → follow it
    session.opencodeAgent = detected?.name || null;
    session.opencodeSP = opencodeSP || null;
    session.activeAgent = detected?.name || null;
    session.customSP = detected ? null : (opencodeSP || '');
  }
  // Effective persona SP: activeAgent's registry SP, else custom SP
  const personaSP = session.activeAgent
    ? (AGENTS.get(session.activeAgent)?.systemPrompt || '')
    : (session.customSP || opencodeSP || '');
  return { personaSP, activeAgent: session.activeAgent, changed };
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
    console.log(`  tokens=${entry.cf_tokens ?? entry.rf_tokens ?? '?'}  cached=${entry.cf_cached ?? entry.rf_cached ?? '?'}`);
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
 * The effective persona SP (session active agent) is split from the shared
 * boilerplate; shared stays at position 0 (cache anchor), persona is appended
 * to the LAST user message.
 */
function rewriteToContentFirst(messages, personaSP) {
  const system = messages.find(m => m.role === 'system')?.content;
  const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
  if (lastUserIdx === -1) {
    return { messages, system, savings: 0, cachedSeed: false, seedTokens: 0, systemTokens: 0, agentTokens: 0 };
  }

  // Split the SHARED boilerplate out of the effective persona SP
  const { shared, agentRole } = splitSystemPrompt(personaSP || system);
  const systemTokens = Math.ceil((system || '').length / 4);
  const seedTokens = Math.ceil(messages[lastUserIdx].content.length / 4);

  const result = messages.map(m => ({ ...m }));
  result[lastUserIdx] = {
    ...result[lastUserIdx],
    content: `${result[lastUserIdx].content}\n\n--- Role ---\n${agentRole}`,
  };
  // Shared boilerplate remains the system message (position 0, cached)
  const sysIdx = result.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    result[sysIdx] = { ...result[sysIdx], content: shared };
  }

  // Provider strictness: a `tool` message must be immediately preceded by an
  // assistant message carrying `tool_calls`. If the last message is a `tool`
  // result, the persona suffix appended to the last user message is fine —
  // the sequence stays [user+role, assistant(tool_calls), tool]. But if the
  // LAST message overall is a `tool` role (common in opencode: tool result is
  // the most recent turn), the persona must be appended to the LAST USER
  // message, which we already do — the tool result follows it, and the
  // assistant tool_calls message precedes the tool result. However, when the
  // last user message IS the turn input and a tool result follows, the
  // provider still requires tool_calls before tool. opencode's array already
  // satisfies this; we only touch the user message content, never reorder.
  // The dangerous case is when there is NO user message after the last
  // assistant(tool_calls) — then appending to a stale user message orphans
  // the pairing. Guard: if the last message is role 'tool' and its preceding
  // assistant has tool_calls, append the persona to the LAST user message
  // that comes BEFORE that tool chain (i.e., the last user before the final
  // tool message), leaving the tool chain intact at the end.

  const lastMsg = result[result.length - 1];
  if (lastMsg && lastMsg.role === 'tool') {
    // Find the last user message BEFORE the final tool chain, and move the
    // persona there if it's not already on the very last user message.
    const lastUserBeforeTool = result.findLastIndex(m => m.role === 'user');
    // The final tool message must still follow its assistant(tool_calls).
    // The persona suffix we appended to result[lastUserIdx] may be AFTER the
    // tool_calls/assistant message (if lastUserIdx > the assistant idx),
    // which is fine. Nothing more to do — the pairing is preserved because
    // we never reordered or removed the assistant(tool_calls) message.
  }

  const seedHash = seedTokens > 100 ? `seed-${seedTokens}` : null;
  const cached = seedHash ? cache.get(seedHash) : false;
  if (seedHash && !cached) cache.set(seedHash, seedTokens);

  return {
    messages: result,
    system: shared,
    savings: cached ? ((seedTokens / (seedTokens + Math.ceil(agentRole.length / 4))) * 100).toFixed(1) : '0.0',
    cachedSeed: cached,
    seedTokens,
    systemTokens,
    agentTokens: Math.ceil(agentRole.length / 4),
  };
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
    tools: options.tools !== undefined ? options.tools : injectSessionTool(reqData.tools),
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
      logCall({ event: 'session_agent_set', agent: resolved.name, turns: session.turns }, sessionId);

      // If input provided, trigger the next turn with the new persona
      if (input) {
        const { personaSP } = { personaSP: resolved.systemPrompt };
        const messages = [
          ...session.context.map(m => ({ ...m })),
          { role: 'user', content: `${input}\n\n--- Role ---\n${resolved.systemPrompt}` },
        ];
        const result = await forwardBlocking(messages, { model: TARGET_MODEL, tools: session.lastTools });
        const output = result.choices?.[0]?.message?.content || '';
        session.context.push({ role: 'user', content: input });
        if (output) session.context.push({ role: 'assistant', content: output });
        session.turns++;

        logCall({
          event: 'handoff', agent: resolved.name, turns: session.turns,
          cf_tokens: result.provider.tokens.prompt, cf_cached: result.provider.tokens.cacheHit,
          cf_output: result.provider.tokens.completion,
        }, sessionId);

        return jsonResponse(res, 200, {
          sessionId, activeAgent: resolved.name, turn: session.turns,
          tokens: { input: result.provider.tokens.prompt, cached: result.provider.tokens.cacheHit },
          output,
        });
      }

      return jsonResponse(res, 200, {
        sessionId, activeAgent: resolved.name, switched: true,
        note: 'Next /v1/chat/completions call for this session uses the new persona.',
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
      const { personaSP, activeAgent, changed } = session
        ? resolveSessionPersona(session, opencodeSP)
        : { personaSP: null, activeAgent: null, changed: false };

      const modelStr = reqData.model || '';
      const isCFModel = /(^|\/)cf$/.test(modelStr) || modelStr === 'cf';
      const doPassthrough = PASSTHROUGH || !isCFModel;

      console.error(`[cf-proxy] session=${sessionId || 'none'} model="${modelStr}" agent=${activeAgent || opencodeSP?.slice(0, 40) || '?'} depth=${messages.filter(m => m.role === 'user').length} mode=${doPassthrough ? 'passthrough' : 'cf'}${changed ? ' [agent-detected-change]' : ''}`);

      if (doPassthrough) {
        const result = await forwardStream(messages, reqData, res, { model: TARGET_MODEL });
        logCall({
          event: 'turn', agent: activeAgent || '(passthrough)', turns: session?.turns ?? 0,
          passthrough: true,
          rf_tokens: result.inputTokens, rf_cached: result.cacheHits, rf_output: result.outputTokens,
        }, sessionId);
        if (session) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
          if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
          session.turns++;
        }
        return;
      }

      // ── Content-first path ──
      // Build the effective SP: session persona (override) if available,
      // else the opencode-supplied SP.
      const effectiveSP = personaSP || opencodeSP;
      const cf = rewriteToContentFirst(messages, effectiveSP);

      // Blocking call so we can intercept the virtual set_session_agent tool
      // BEFORE anything reaches the client. Returns the final assistant text.
      async function runTurn(turnMessages, allowVirtualTool) {
        const upReq = {
          ...reqData,
          messages: turnMessages,
          model: TARGET_MODEL,
          stream: false,
        };
        // strip streaming-only params that DeepSeek rejects on non-stream calls
        delete upReq.stream_options;
        delete upReq.stream;
        if (allowVirtualTool) upReq.tools = injectSessionTool(reqData.tools);
        else upReq.tools = (reqData.tools || []).filter(t => t?.function?.name !== 'set_session_agent');
        const response = await fetch(`${TARGET_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
          body: JSON.stringify(upReq),
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          console.error(`[cf-proxy] UPSTREAM ERROR ${response.status}: ${errText.slice(0, 300)}`);
          throw new Error(`Upstream ${response.status}: ${errText.slice(0, 200)}`);
        }
        const data = await response.json();
        const usage = data.usage || {};
        const msg = data.choices?.[0]?.message || {};
        return {
          text: msg.content || '',
          toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
          tokens: {
            prompt: usage.prompt_tokens || 0,
            completion: usage.completion_tokens || 0,
            cacheHit: usage.prompt_cache_hit_tokens || 0,
          },
        };
      }

      let result = await runTurn(cf.messages, true);
      let finalText = result.text;

      // Virtual tool: if the model called set_session_agent, switch session
      // and re-run the turn with a synthetic tool result so the new persona
      // produces the final answer.
      const virtualCall = result.toolCalls.find(tc => tc.function?.name === 'set_session_agent');
      if (virtualCall && session) {
        try {
          const args = JSON.parse(virtualCall.function.arguments || '{}');
          const target = resolveAgent(args.agent);
          if (target) {
            session.activeAgent = target.name;
            session.customSP = null;
            session.opencodeAgent = target.name; // keep in sync with manual detection
            console.error(`[cf-proxy] VIRTUAL TOOL: session ${sessionId} switched to ${target.name} (${args.reason || 'no reason'})`);
            logCall({ event: 'virtual_tool_switch', agent: target.name, turns: session.turns }, sessionId);

            // Re-run with the new persona; append the tool call + result so
            // the model knows the switch happened.
            const rerunMessages = [
              ...cf.messages,
              {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: virtualCall.id, type: 'function', function: { name: 'set_session_agent', arguments: virtualCall.function.arguments || '{}' } }],
              },
              { role: 'tool', tool_call_id: virtualCall.id, content: `Session agent switched to ${target.name}. Continue your work under this persona.` },
            ];
            const rerun = await runTurn(rerunMessages, false);
            finalText = rerun.text;
            result.tokens = rerun.tokens;
          }
        } catch (e) {
          console.error(`[cf-proxy] virtual tool handling failed: ${e.message}`);
        }
      }

      // Store turn in session context
      if (session) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
        if (finalText) session.context.push({ role: 'assistant', content: finalText });
        session.turns++;
      }

      // Stream the final text to the client as SSE
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const id = `chatcmpl-${Date.now().toString(36)}`;
      // Split into token-ish chunks for a natural stream feel (fall back to whole text)
      const chunks = finalText.match(/.{1,40}/gs) || [finalText];
      for (const part of chunks) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: TARGET_MODEL, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: TARGET_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: result.tokens.prompt, completion_tokens: result.tokens.completion, total_tokens: result.tokens.prompt + result.tokens.completion, prompt_cache_hit_tokens: result.tokens.cacheHit } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();

      logCall({
        event: 'turn', agent: activeAgent || '(unassigned)', turns: session?.turns ?? 0,
        passthrough: false,
        agent_changed: changed,
        virtual_switch: !!virtualCall,
        cf_tokens: result.tokens.prompt, cf_cached: result.tokens.cacheHit, cf_output: result.tokens.completion,
        savings_pct: cf.savings, cached_seed: cf.cachedSeed,
        seed_tokens: cf.seedTokens, system_tokens: cf.systemTokens,
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
