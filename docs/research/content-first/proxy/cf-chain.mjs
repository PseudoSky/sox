/**
 * cf-chain.mjs  —  Content-First Session-State Proxy (chained agent switching)
 *
 * The proxy owns per-session state: the accumulated conversation context AND
 * the active agent (persona). The active agent can advance the chain by
 * POSTing to /v1/session/agent, which resolves the next agent's system prompt,
 * appends it + input to the session context (content-first: persona at END),
 * triggers the next turn, stores the output, and returns it.
 *
 * Cache: the session context accumulates at position 0 and is byte-identical
 * across stages, so DeepSeek serves it from cache; each stage pays only the
 * new persona suffix + new output. O(N) across DIFFERENT personas.
 *
 * Design rules (from session-state spec):
 *   - First session request: infer active agent from the opencode-supplied SP
 *     (match against agent registry; fall back to using it verbatim).
 *   - Subsequent requests: extract & discard opencode's SP, substitute the
 *     session-designated agent's SP. The UI dropdown never overrides the chain.
 *   - Agent handoff: agent POSTs /v1/session/agent → proxy resolves SP,
 *     appends, triggers next turn, stores output.
 *
 * Env:
 *   CF_PORT=3334         Port (separate from the plain proxy's 3333)
 *   CF_LOG=<path>        JSONL log
 *   DEEPSEEK_API_KEY     Required
 *   AGENTS_DIR           Agent definitions dir (default ~/.config/opencode/agents)
 *
 * Endpoints:
 *   POST /v1/chat/completions   session-aware (infer/substitute persona)
 *   POST /v1/session/agent      { sessionId, agent, input? } → resolve+switch+trigger
 *   GET  /v1/session/:id        session state (active agent, context size)
 *   GET  /v1/agents             registry contents (name → SP preview)
 *   GET  /v1/health
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CF_PORT || '3334', 10);
const TARGET_BASE = process.env.CF_TARGET || 'https://api.deepseek.com/v1';
const TARGET_MODEL = process.env.CF_MODEL || 'deepseek-v4-flash';
const LOG_PATH = process.env.CF_LOG || path.join(__dirname, "logs", 'proxy-cf-chain-log.jsonl');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET || process.env.OPENAI_API_KEY || '';
const AGENTS_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.config', 'opencode', 'agents');

// ──────── Agent registry (name → system prompt) ────────

function parseFrontmatter(md)
{
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

function loadAgentRegistry()
{
  const registry = new Map();
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8');
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      registry.set(name, {
        name,
        file,
        model: fm?.model || 'unknown',
        description: fm?.description || '',
        systemPrompt: body || `You are the ${name} agent.`,
      });
    }
  } catch (e) {
    console.error(`[cf-chain] agent registry load failed: ${e.message}`);
  }
  return registry;
}

const AGENTS = loadAgentRegistry();

function resolveAgent(nameOrSP)
{
  if (!nameOrSP) return null;
  // 1. Exact name match
  if (AGENTS.has(nameOrSP)) return AGENTS.get(nameOrSP);
  // 2. "provider/model" form → strip provider prefix
  const bare = nameOrSP.includes('/') ? nameOrSP.split('/').pop() : nameOrSP;
  if (AGENTS.has(bare)) return AGENTS.get(bare);
  // 3. Infer by system-prompt similarity (SP body prefix match against registry SPs)
  const sp = nameOrSP;
  if (sp.length > 40) {
    for (const agent of AGENTS.values()) {
      const a = agent.systemPrompt.slice(0, 120).replace(/\s+/g, ' ');
      const b = sp.slice(0, 120).replace(/\s+/g, ' ');
      if (a === b) return agent;
    }
  }
  return null;
}

// ──────── Session store ────────

const sessions = new Map();

function getSession(id)
{
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      activeAgent: null,      // agent name (or custom SP if unresolved)
      customSP: null,         // set when agent could not be resolved from registry
      context: [],            // accumulated {role, content} — the cache anchor
      createdAt: new Date().toISOString(),
      turns: 0,
    });
  }
  return sessions.get(id);
}

function sessionIdFromReq(reqData)
{
  return reqData.session_id || reqData.sessionId ||
    (reqData.headers?.find?.() || reqData.x_session_id) ||
    null;
}

// ──────── Logger ────────

function logCall(entry)
{
  entry._ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n'); } catch { }
  console.error(`[cf-chain] ${entry.event || entry.endpoint} session=${entry.sessionId || '?'} agent=${entry.agent || '?'} depth=${entry.turns ?? '?'} tokens=${entry.tokens ?? '?'} cached=${entry.cached ?? '?'}`);
}

// ──────── DeepSeek forward (streaming) ────────

async function forwardStream(messages, model, res)
{
  const body = {
    model: model || TARGET_MODEL,
    messages,
    stream: true,
    temperature: 0,
    max_tokens: 4000,
  };

  const response = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    const errMsg = `data: {"error":"Provider ${response.status}: ${errText.slice(0, 200)}"}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(errMsg);
    return { inputTokens: 0, outputTokens: 0, cacheHits: 0, fullText: '' };
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
          if (data.choices?.[0]?.delta?.content) fullText += data.choices[0].delta.content;
        } catch { }
      }
    }
  }

  res.end();
  return { inputTokens, outputTokens, cacheHits, fullText };
}

// Non-streaming variant for the session/agent handoff trigger
async function forwardBlocking(messages, model = TARGET_MODEL, maxTokens = 4000)
{
  const body = {
    model,
    messages,
    stream: false,
    temperature: 0,
    max_tokens: maxTokens,
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

// ──────── Content-first message construction ────────

/**
 * Build the content-first message list for a session stage:
 *   [ ...accumulated context, {user: input}, ...(persona as suffix) ]
 * The persona goes at the END of the LAST user message so the accumulated
 * context stays at position 0 (the cache anchor).
 */
function buildCFMessages(session, personaSP, input)
{
  const suffix = personaSP ? `\n\n${personaSP}` : '';
  return [
    ...session.context.map(m => ({ ...m })),
    { role: 'user', content: `${input}${suffix}` },
  ];
}

// ──────── HTTP server ────────

function jsonResponse(res, status, data)
{
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) =>
{
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CF-Session-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // GET /v1/health
    if (req.method === 'GET' && p === '/v1/health') {
      return jsonResponse(res, 200, {
        ok: true, mode: 'content-first-chain',
        target: { base: TARGET_BASE, model: TARGET_MODEL },
        sessions: sessions.size,
        agents: AGENTS.size,
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
        customSP: s.customSP ? s.customSP.slice(0, 80) : null,
        turns: s.turns,
        contextTokens: s.context.reduce((n, m) => n + Math.ceil((m.content || '').length / 4), 0),
        contextMessages: s.context.length,
        createdAt: s.createdAt,
      });
    }

    // POST /v1/session/agent — resolve + switch + trigger next turn
    if (req.method === 'POST' && p === '/v1/session/agent') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const sessionId = reqData.sessionId || reqData.session_id;
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

      // Switch active agent
      session.activeAgent = resolved.name;
      session.customSP = null;

      // If input provided, trigger the next turn with the new persona
      if (input) {
        const messages = buildCFMessages(session, resolved.systemPrompt, input);
        const result = await forwardBlocking(messages, TARGET_MODEL);
        const output = result.choices?.[0]?.message?.content || '';
        // Store the stage: input + persona + output become part of accumulated context
        session.context.push({ role: 'user', content: input });
        session.context.push({ role: 'assistant', content: output });
        session.turns++;

        logCall({
          event: 'handoff', sessionId, agent: resolved.name,
          turns: session.turns,
          tokens: result.provider.tokens.prompt,
          cached: result.provider.tokens.cacheHit,
          outputTokens: result.provider.tokens.completion,
        });

        return jsonResponse(res, 200, {
          sessionId,
          activeAgent: resolved.name,
          turn: session.turns,
          tokens: { input: result.provider.tokens.prompt, cached: result.provider.tokens.cacheHit },
          output,
        });
      }

      // No input — just switch the persona for the next /v1/chat/completions call
      logCall({ event: 'switch', sessionId, agent: resolved.name, turns: session.turns });
      return jsonResponse(res, 200, {
        sessionId,
        activeAgent: resolved.name,
        switched: true,
        note: 'Next /v1/chat/completions call for this session uses the new persona.',
      });
    }

    // POST /v1/chat/completions — session-aware
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const messages = reqData.messages || [];
      const sessionId = reqData.session_id || reqData.sessionId ||
        req.headers['x-cf-session-id'] || null;

      // Extract opencode-supplied SP
      const opencodeSP = messages.find(m => m.role === 'system')?.content || null;

      // Determine session (create on first contact)
      const sid = sessionId || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const session = getSession(sid);

      if (!session.activeAgent && !session.customSP) {
        // First request: infer active agent from the opencode-supplied SP
        const resolved = resolveAgent(opencodeSP);
        if (resolved) {
          session.activeAgent = resolved.name;
          console.error(`[cf-chain] session ${sid} inferred agent: ${resolved.name}`);
        } else {
          session.customSP = opencodeSP || '';
          console.error(`[cf-chain] session ${sid} using opencode-supplied SP (no registry match)`);
        }
      }

      // Resolve the session's designated persona SP
      const personaSP = session.activeAgent
        ? (AGENTS.get(session.activeAgent)?.systemPrompt || '')
        : (session.customSP || '');

      // Take the LAST user message as this stage's input
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const input = lastUser?.content || '';

      // Build content-first messages: accumulated context + input + persona suffix
      const cfMessages = buildCFMessages(session, personaSP, input);

      // Forward (streaming)
      const result = await forwardStream(cfMessages, TARGET_MODEL, res);

      // Store the stage into session context
      session.context.push({ role: 'user', content: input });
      if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
      session.turns++;

      logCall({
        event: 'turn', sessionId: sid, agent: session.activeAgent || '(custom SP)',
        turns: session.turns,
        tokens: result.inputTokens, cached: result.cacheHits, outputTokens: result.outputTokens,
        opencodeSPMatched: !!session.activeAgent,
      });
      return;
    }

    return jsonResponse(res, 404, { error: 'Not found', path: p });

  } catch (err) {
    console.error(`[cf-chain] Error: ${err.message}`);
    if (!res.headersSent) return jsonResponse(res, 500, { error: err.message });
    res.end();
  }
});

server.listen(PORT, () =>
{
  console.log(`\n  ╔══════════════════════════════════════════════════════╗`);
  console.log(`  ║  Content-First CHAIN Proxy (session state)          ║`);
  console.log(`  ║  Port: ${PORT}    Agents: ${AGENTS.size}                        ║`);
  console.log(`  ║  Target: ${TARGET_BASE}  ║`);
  console.log(`  ║  Model: ${TARGET_MODEL}                          ║`);
  console.log(`  ║  Log: ${LOG_PATH}  ║`);
  console.log(`  ╚══════════════════════════════════════════════════════╝\n`);
});
