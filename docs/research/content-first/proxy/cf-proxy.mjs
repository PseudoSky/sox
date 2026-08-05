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
import {
  MARKERS, buildCFInstructions, buildFJInstructions, resolveAgent,
  rewriteToContentFirst as rewriteToContentFirstShared, predictCacheHit, serializeForwarded,
} from './cf-rewrite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CF_PORT || '3333', 10);
const TARGET_BASE = process.env.CF_TARGET || 'https://api.deepseek.com/v1';
const TARGET_MODEL = process.env.CF_MODEL || 'deepseek-v4-flash';
const VERBOSE = process.env.CF_VERBOSE === '1';
const PASSTHROUGH = process.env.CF_PASSTHROUGH === '1';
const RAW_CAPTURE = process.env.CF_RAW !== '0'; // default ON — captures full request bodies; CF_RAW=0 disables
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
      presetSet: [],          // fork-join preset agent set (fj mode) — multiple
                              // agents run per turn, forked from shared context.
                              // [] = single-agent mode (default). Set via
                              // POST /v1/session/agent { agents: [...] }.
      joinMode: 'concat',     // fj join strategy: 'concat' (v1) | 'judge' (stub).
                              // concat = N outputs concatenated with role markers.
                              // judge  = FILTER pass (architecture doc) — STUBBED
                              // in v1; the switch is wired but falls back to concat.
      pendingInput: null,     // handoff task — embedded in persona suffix,
                              // not injected as a separate user message
                              // (keeps the conversation prefix monotonic)
      context: [],            // accumulated messages (cache anchor)
      // Per-persona metrics (reset on agent change)
      personaTurns: 0,        // turns since the current persona started
      personaCtxChars: 0,     // cumulative non-shared non-persona context chars
      // Repeated-read tracking (cross-agent knowledge detection signal)
      fileReads: new Map(),   // file path → turn number of last read
      fileWrites: new Map(),  // file path → turn number of last write
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
// ──────── Mid-stage persona-stability verification (HARD FAIL) ────────
//
// [inv:persona-stage-stability] The active agent persona MUST NOT change
// mid-stage. The provider prefix cache requires a byte-identical message
// prefix; a persona swap on the last user message invalidates the entire
// accumulated conversation (measured: 142K tokens lost in one turn on
// session 035ef41f5). The ONLY legitimate persona change is via
// POST /v1/session/agent (handoff).
//
// These checks FAIL HARD: any violation kills the proxy process. A silent
// continue would corrupt the experiment metrics (mid-stage cache breaks,
// phantom recon-stage tokens). Failing fast forces the corruption to the
// surface instead of polluting every downstream number.

// Kill the server with a loud, searchable reason.
function corruptionAbort(reason, detail) {
  console.error('\n❌❌❌ PROXY CORRUPTION — SHUTTING DOWN ❌❌❌');
  console.error(`  reason: ${reason}`);
  console.error(`  detail: ${detail}`);
  console.error('  See the session log for the full corrupted request.');
  try {
    logCall({ event: 'corruption_abort', reason, detail, _ts: new Date().toISOString() }, null);
  } catch {}
  // Hard exit — never continue with corrupted state.
  process.exit(1);
}

// Mid-stage persona change check (called before applying a persona switch).
// Returns true if the change is legitimate (handoff-authorized or first
// contact). Otherwise KILLS THE SERVER.
function corruptionCheck(session, requestedAgent, changeReason) {
  if (!session) return true;
  const prev = session.activeAgent;
  if (!prev) return true;                   // first contact — nothing to protect
  if (requestedAgent === prev) return true; // no change — always fine

  // Legitimate: handoff-authorized change (consumed one-shot).
  if (session.handoffAuthorized && session.handoffAuthorized === requestedAgent) {
    session.handoffAuthorized = null;
    return true;
  }
  // The apiOverride path is also legitimate (handoff holds until dropdown catches up).
  if (session.apiOverride && session.activeAgent === requestedAgent) {
    return true;
  }

  corruptionAbort(
    'mid-stage persona change without handoff',
    `session ${session.id}: ${prev} → ${requestedAgent} (reason: ${changeReason}, turns: ${session.turns})`
  );
  return false; // unreachable — process.exit happened
}

// Scan the message list for persona residuals — content that indicates the
// rewrite left stale persona bytes in the conversation. Called on every
// request BEFORE forwarding. Any hit = corrupted state → kill the server.
//
// Residuals checked:
//   1. More than one '--- Role ---' marker in the conversation (a persona
//      append should exist on exactly ONE message).
//   2. '--- Role ---' appearing on a NON-target message (e.g. buried on a
//      tool message or an early user message after the rewrite moved on).
//   3. The active agent's persona body appearing verbatim on any message
//      OTHER than the intended suffix target (a leak from a prior rewrite).
function scanForSPResiduals(messages, activeAgent, targetIdx) {
  if (!messages || messages.length === 0) return;
  const marker = '--- Role ---';
  const personaBody = activeAgent ? (AGENTS.get(activeAgent)?.systemPrompt || '') : '';

  // 1. Marker count across the conversation
  let markerCount = 0;
  const markerAt = [];
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content || '';
    const n = (c.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n > 0) markerAt.push({ idx: i, count: n });
    markerCount += n;
  }
  if (markerCount > 1) {
    corruptionAbort(
      'multiple persona markers in conversation',
      `session marker count=${markerCount} at indices ${JSON.stringify(markerAt)}`
    );
  }
  if (markerCount === 1 && targetIdx !== undefined) {
    const only = markerAt[0].idx;
    if (only !== targetIdx) {
      corruptionAbort(
        'persona marker on non-target message',
        `marker at index ${only}, expected target ${targetIdx}`
      );
    }
  }

  // 3. Persona body leak: the active agent's SP body appearing verbatim on a
  //    message that is not the target. (The target legitimately carries it as
  //    the suffix; anywhere else is a residual from a prior persona.)
  if (personaBody && personaBody.length > 100) {
    const probe = personaBody.slice(0, 200); // distinctive prefix
    for (let i = 0; i < messages.length; i++) {
      if (i === targetIdx) continue;
      if (typeof messages[i].content === 'string' && messages[i].content.includes(probe)) {
        corruptionAbort(
          'persona body residual on non-target message',
          `agent ${activeAgent} body prefix found at index ${i} (target ${targetIdx})`
        );
      }
    }
  }
}

function resolveSessionPersona(session, opencodeSP) {
  const detected = resolveAgent(opencodeSP, AGENTS);
  const opencodeChanged = detected?.name !== session.opencodeAgent;

  // Manual dropdown change: opencode sent a different agent than last time.
  // When there is an API override, it holds until opencode's detected agent
  // MATCHES the override target (dropdown caught up) — then the override is
  // released and normal detection resumes. An override is never silently
  // clobbered by a re-send of the dropdown's pre-override agent.
  // BUGFIX (2026-08-04): a detection FAILURE (detected === null) is NOT an
  // agent change. When opencode sends the base SP (frontmatter stripped) and
  // resolveAgent can't match it mid-stage, detected=null → opencodeChanged
  // became true → manualChange=true → activeAgent was nulled, so 21 turns of
  // the typescript stage logged as '(unassigned)' and inflated the recon
  // stage by 4M tokens (session 035ef41f5). Preserve the current activeAgent
  // when detection fails; only switch on a POSITIVE detection of a different
  // agent.
  let manualChange;
  if (detected) {
    if (session.apiOverride) {
      manualChange = opencodeChanged && detected.name === session.activeAgent;
      if (manualChange) session.apiOverride = false; // caught up → release
    } else {
      manualChange = opencodeChanged && detected.name !== session.activeAgent;
    }
  } else {
    manualChange = false; // unknown SP — keep the current agent, never null
  }

  if (opencodeChanged && !manualChange) {
    // Detection changed but no persona switch (same agent re-sent, or base SP
    // while an override holds) — update bookkeeping only, never the persona.
    session.opencodeAgent = detected?.name || null;
    session.opencodeSP = opencodeSP || null;
  }
  if (manualChange) {
    // opencode genuinely switched (or first contact) → follow it,
    // BUT only if corruptionCheck approves (mid-stage stability invariant).
    const requested = detected?.name || null;
    if (corruptionCheck(session, requested, 'resolveSessionPersona manualChange')) {
      session.activeAgent = requested;
      session.customSP = detected ? null : (opencodeSP || '');
      // Reset per-persona metrics on agent change
      session.personaTurns = 0;
      session.personaCtxChars = 0;
      if (opencodeChanged) {
        session.opencodeAgent = detected?.name || null;
        session.opencodeSP = opencodeSP || null;
      }
    } else {
      // Corruption refused — keep the current activeAgent. Also stop the
      // opencodeAgent bookkeeping from advancing so detection doesn't
      // retry the swap on the next turn.
      return { personaSP: (AGENTS.get(session.activeAgent)?.systemPrompt || session.customSP || ''), activeAgent: session.activeAgent, changed: false };
    }
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
 * Content-first rewrite — delegates to cf-rewrite.mjs (single source of truth).
 * Computes the per-request metrics that the shared module cannot (registry SP,
 * CF instructions render).
 *
 * Forwarded structure (v4 — see cf-rewrite.mjs DESIGN):
 *   [0] system: opencode SP as-is (cache anchor, never rewritten)
 *   [1] user:   CF instructions PREPENDED, then the user's original text
 *   [2..N-1] history: untouched
 *   [N] tail:  persona anchor appended to the TRUE last message (always tail)
 */
function rewriteToContentFirst(messages, personaSP, opencodeSP, cfPrompt, handoffTask, agentName, fork = false) {
  const system = messages.find(m => m.role === 'system')?.content;
  const forwarded = rewriteToContentFirstShared(messages, {
    personaSP: personaSP || '',
    cfPrompt: cfPrompt || '',
    handoffTask: handoffTask || null,
    agentName: agentName || '',
    fork,                 // fj forks: persona NOT appended to tool-role messages
    AGENTS,
  });
  const systemTokens = Math.ceil((system || '').length / 4);
  const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
  const seedTokens = lastUserIdx !== -1 ? Math.ceil(String(messages[lastUserIdx].content || '').length / 4) : 0;
  const personaMarkerChars = (MARKERS.agentStart(agentName || 'x', 'y').length - 1); // marker overhead
  const agentTokens = Math.ceil((personaSP || '').length / 4) + 2;
  return {
    messages: forwarded, system,
    agentRole: personaSP || '',
    savings: '0.0', cachedSeed: false, seedTokens, systemTokens,
    agentTokens, cfTokens: 0,
  };
}
// ──────── CF flow instructions (Option 2: session handle in context) ────────

/**
 * Render the content-first process instructions with the session id baked in.
 * Delegates to cf-rewrite.mjs (single source of truth).
 */
function renderCFInstructions(sessionId) {
  return buildCFInstructions(sessionId, PORT);
}

function renderFJInstructions(sessionId) {
  return buildFJInstructions(sessionId, PORT);
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
  const sessionId = options.sessionId ?? null; // for per-session raw logging

  const response = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (RAW_CAPTURE) {
      logCall({ event: 'raw_response_error', status: response.status, error: errText.slice(0, 500), _ts: new Date().toISOString() }, sessionId);
    }
    const errMsg = `data: {"error":"Provider ${response.status}: ${errText.slice(0,200)}"}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(errMsg);
    return { inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0, fullText: '', toolCalls: [] };
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
  let fullReasoning = '';  // RAW CAPTURE: accumulated reasoning_content deltas
  let inputTokens = 0, outputTokens = 0, cacheHits = 0, cacheMisses = 0;
  let reasoningTokens = 0; // completion_tokens_details.reasoning_tokens (split)
  const toolCalls = []; // accumulated {id, name, args}
  let rawSSE = '';      // RAW CAPTURE: full SSE stream bytes (data: lines only)

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);

    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        if (RAW_CAPTURE) rawSSE += line + '\n';
        try {
          const data = JSON.parse(line.slice(6));
          if (data.usage) {
            inputTokens = data.usage.prompt_tokens || 0;
            outputTokens = data.usage.completion_tokens || 0;
            cacheHits = data.usage.prompt_cache_hit_tokens || 0;
            // Cache-write tokens: the provider charges these at the MISS rate and
            // stores them for future prefix hits. DeepSeek: prompt_cache_miss_tokens.
            // (Some providers report prompt_cache_write_tokens — accept either.)
            cacheMisses = data.usage.prompt_cache_miss_tokens
              ?? data.usage.prompt_cache_write_tokens
              ?? (data.usage.prompt_tokens - (data.usage.prompt_cache_hit_tokens || 0));
            // Reasoning vs output split (DeepSeek: completion_tokens_details.reasoning_tokens)
            reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens;
          }
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) fullText += delta.content;
          if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
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

  // RAW CAPTURE — VERBATIM response, per-session file.
  //
  // The entire SSE stream is stored untruncated (`sse` = every data: line the
  // provider sent, in order). No reformatting, no extraction, no truncation —
  // a raw capture must be raw: the exact provider payload is the only
  // ground truth for cache accounting and decision-trail analysis, and any
  // re-derivation (parsing content/reasoning out of the stream) is lossy by
  // construction. The parsed fields below are a convenience INDEX alongside
  // the verbatim stream — the stream is authoritative, never the index.
  //
  // This also fixes a real gap: opencode's own message DB persists only
  // `content`, NOT `reasoning_content`, so without this verbatim capture the
  // model's reasoning trail is irrecoverable after the fact.
  if (RAW_CAPTURE) {
    logCall({
      event: 'raw_response',
      status: response.status,
      // VERBATIM: the complete upstream SSE stream, in order, untruncated.
      sse: rawSSE,
      sse_bytes: rawSSE.length,
      // ── convenience index (derived, lossy by construction — do not treat as
      //    authoritative; the stream above is) ─────────────────────────────
      usage: {
        prompt: inputTokens,
        completion: outputTokens,
        cache_hit: cacheHits,
        cache_miss: cacheMisses,
        reasoning_tokens: reasoningTokens,
        output_tokens_non_reasoning: Math.max(0, outputTokens - reasoningTokens),
      },
      tool_calls: toolCalls.map(t => ({ id: t.id, name: t.name, args: t.args })),
      content_len: fullText.length,
      reasoning_len: fullReasoning.length,
    }, sessionId);
  }
  return { inputTokens, outputTokens, cacheHits, cacheMisses, fullText, toolCalls };
}

async function forwardBlocking(messages, options = {}) {
  const body = {
    model: options.model || TARGET_MODEL,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.max_tokens ?? 2000,
    tools: injectSessionTool(options.tools),
  };
  const sessionId = options.sessionId ?? null; // carried from the fj turn so
                                               // fork calls attribute to the
                                               // right per-session log
  const start = Date.now();
  if (RAW_CAPTURE) {
    logCall({
      _ts: new Date().toISOString(),
      event: 'raw_request',
      sessionId,
      fork: options.fork ?? null,
      body_keys: Object.keys(body),
      model: body.model,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      tools_count: Array.isArray(body.tools) ? body.tools.length : null,
      stream: false,
      full_body: body,
    }, sessionId);
  }
  const res = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  if (!res.ok) {
    const errText = await res.text();
    if (RAW_CAPTURE) {
      logCall({ event: 'raw_response_error', status: res.status, error: errText.slice(0, 500), _ts: new Date().toISOString() }, sessionId);
    }
    throw new Error(`Provider ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const usage = data.usage || {};
  if (RAW_CAPTURE) {
    logCall({
      event: 'raw_response', sessionId, fork: options.fork ?? null,
      sse: JSON.stringify(data), sse_bytes: JSON.stringify(data).length,
      usage: usage, _ts: new Date().toISOString(),
    }, sessionId);
  }
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

/**
 * Extract a normalized file path from a tool call's arguments.
 * Handles the opencode pattern `<path>/Users/machine/repo/file.ts</path> <type>file</type>`
 * as well as plain JSON path fields.
 */
function extractFilePath(toolName, args) {
  if (!args) return null;
  // OpenCode tool result pattern: <path>...</path>
  let m = args.match(/<path>(.+?)<\/path>/);
  if (m) return m[1].trim();
  // JSON path fields
  try {
    const j = JSON.parse(args);
    const p = j.filePath || j.path || j.file || j.file_path || j.fileName || '';
    if (p) return p;
  } catch {}
  return null;
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
        presetSet: s.presetSet || [],
        joinMode: s.joinMode || 'concat',
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
    //   { sessionId, agent: "architect", input?: "..." }        → single (unchanged)
    //   { sessionId, agents: ["correctness-reviewer", "security-reviewer"] } → preset set (fj mode)
    //   { sessionId, agents: [] }                               → clear preset (back to single-agent)
    if (req.method === 'POST' && p === '/v1/session/agent') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      const reqData = JSON.parse(body);
      const sessionId = reqData.sessionId || reqData.session_id || req.headers['x-session-id'] || null;
      const nextAgent = reqData.agent || reqData.persona;
      const input = reqData.input || '';
      if (!sessionId || (!nextAgent && !reqData.agents)) {
        return jsonResponse(res, 400, { error: 'sessionId and agent (or agents[]) required' });
      }

      const session = getSession(sessionId);

      // ── Plural path: preset agent set (fork-join / fj mode) ──
      // Stores the set on the session for the fj fork-join handler. Does NOT
      // touch activeAgent/persona machinery — the set is orthogonal to the
      // single-agent persona switch, so this path can be called any time
      // without corrupting the active persona or the cache prefix.
      if (reqData.agents) {
        if (!Array.isArray(reqData.agents)) {
          return jsonResponse(res, 400, { error: 'agents must be an array' });
        }
        // Optional fj join strategy — validated, applied to the session.
        if (reqData.joinMode !== undefined) {
          if (!['concat', 'judge'].includes(reqData.joinMode)) {
            return jsonResponse(res, 400, { error: `joinMode must be 'concat' or 'judge' (got ${reqData.joinMode})` });
          }
          session.joinMode = reqData.joinMode;
        }
        const resolvedSet = [];
        const missing = [];
        for (const name of reqData.agents) {
          const resolved = resolveAgent(name, AGENTS);
          if (resolved) resolvedSet.push(resolved.name);
          else missing.push(name);
        }
        if (reqData.agents.length > 0 && resolvedSet.length === 0) {
          return jsonResponse(res, 404, {
            error: `no agents resolved from set: ${missing.join(', ')}`,
            registry: [...AGENTS.keys()],
          });
        }
        session.presetSet = resolvedSet; // [] = clear
        logCall({
          event: 'session_agent_set',
          agent: resolvedSet.join(','),
          agent_set: resolvedSet,
          missing: missing.length ? missing : undefined,
          turns: session.turns,
        }, sessionId);
        return jsonResponse(res, 200, {
          sessionId,
          presetSet: resolvedSet,
          missing: missing.length ? missing : undefined,
          set: resolvedSet.length > 0,
          note: resolvedSet.length > 0
            ? `Preset agent set stored: ${resolvedSet.join(', ')}. Fork-join mode will run these agents per turn.`
            : 'Preset agent set cleared. Session is back to single-agent mode.',
        });
      }

      // ── Singular path (unchanged behavior) ──
      if (!nextAgent) {
        return jsonResponse(res, 400, { error: 'sessionId and agent required' });
      }
      const resolved = resolveAgent(nextAgent, AGENTS);
      if (!resolved) {
        return jsonResponse(res, 404, { error: `agent not found: ${nextAgent}`, registry: [...AGENTS.keys()] });
      }

      session.activeAgent = resolved.name;
      session.customSP = null;
      session.apiOverride = true;
      session.presetSet = [];  // single-agent switch clears any preset set
      session.handoffAuthorized = resolved.name;  // authorize the next request's persona change
      // Reset per-persona metrics on agent switch.
      session.personaTurns = 0;
      session.personaCtxChars = 0;
      // Seed opencodeAgent so the next request doesn't look like a manual
      // switch away from the override target.
      if (!session.opencodeAgent) session.opencodeAgent = resolved.name;
      logCall({ event: 'session_agent_set', agent: resolved.name, turns: session.turns }, sessionId);

      // Store the handoff task — it will be embedded in the persona suffix
      // on the next turn (not injected as a separate user message, which
      // would break the cache prefix).
      if (input) {
        session.pendingInput = input;
        return jsonResponse(res, 200, {
          sessionId, activeAgent: resolved.name, switched: true,
          note: 'Handoff task will be embedded in the persona suffix on the next turn.',
          continue_hint: 'You are now the next specialist. Continue working in this session: your next request will run as this agent. Do NOT stop - proceed with the next stage of the chain.',
        });
      }

      return jsonResponse(res, 200, {
        sessionId, activeAgent: resolved.name, switched: true,
        note: 'Next /v1/chat/completions call for this session uses the new persona.',
        continue_hint: 'You are now the next specialist. Continue working in this session: your next request will run as this agent. Do NOT stop - proceed with the next stage of the chain.',
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

      // RAW CAPTURE — per-session file (proxy-<session>.jsonl). Includes the
      // full request body (messages incl. reasoning_content of prior turns,
      // tools, tool_choice, sampling params) so a replay has EVERY input the
      // model actually saw. Raw_request events go to the session log, never
      // the global catch-all (they were leaking to LOG_BASE before — mixing
      // all sessions into one 441MB file). Logged AFTER the session lookup so
      // session_start precedes the first raw_request in the file.
      const opencodeSP = messages.find(m => m.role === 'system')?.content || null;

      // Session persona resolution (detect + persist + allow override)
      const wasKnown = sessionId ? sessions.has(sessionId) : true;
      const session = sessionId ? getSession(sessionId) : null;
      // One-time session_start record — makes each per-session file
      // self-describing (sampling params, tool surface, model) so a replay or
      // the aggregator never needs to re-derive the run configuration from a
      // later raw_request. Written BEFORE the first turn event.
      if (sessionId && !wasKnown && RAW_CAPTURE) {
        logCall({
          event: 'session_start',
          sessionId,
          model: reqData.model ?? null,
          max_tokens: reqData.max_tokens ?? null,
          temperature: reqData.temperature ?? null,   // null = provider default
          top_p: reqData.top_p ?? null,
          reasoning_effort: reqData.reasoning_effort ?? null,
          tools_count: Array.isArray(reqData.tools) ? reqData.tools.length : null,
          tools: Array.isArray(reqData.tools) ? reqData.tools.map(t => t.function?.name).filter(Boolean) : null,
          tool_choice: reqData.tool_choice ?? null,
          stream: reqData.stream ?? null,
          system_prompt_chars: (opencodeSP || '').length,
          user_message_count: messages.filter(m => m.role === 'user').length,
        }, sessionId);
      }
      if (RAW_CAPTURE) {
        const rawEntry = {
          _ts: new Date().toISOString(),
          event: 'raw_request',
          sessionId,
          headers: { ...req.headers },
          body_keys: Object.keys(reqData),
          // sampling + decision-relevant inputs, surfaced at top level so a
          // replay can read them without re-parsing full_body
          model: reqData.model ?? null,
          max_tokens: reqData.max_tokens ?? null,
          temperature: reqData.temperature ?? null,     // null = provider default
          top_p: reqData.top_p ?? null,
          tools_count: Array.isArray(reqData.tools) ? reqData.tools.length : null,
          tool_choice: reqData.tool_choice ?? null,
          reasoning_effort: reqData.reasoning_effort ?? null,
          stream: reqData.stream ?? null,
          full_body: reqData,
        };
        logCall(rawEntry, sessionId);
      }
      console.error(`[cf-proxy] chat-session lookup: id=${JSON.stringify(sessionId)} exists=${!!session} activeAgent=${session?.activeAgent ?? 'N/A'} apiOverride=${session?.apiOverride ?? 'N/A'}`);
      const { personaSP, activeAgent, changed } = session
        ? resolveSessionPersona(session, opencodeSP)
        : { personaSP: null, activeAgent: null, changed: false };

      const modelStr = reqData.model || '';
      const isCFModel = /(^|\/)cf$/.test(modelStr) || modelStr === 'cf';
      const isFJModel = /(^|\/)fj$/.test(modelStr) || modelStr === 'fj';
      const doPassthrough = PASSTHROUGH || (!isCFModel && !isFJModel);

      console.error(`[cf-proxy] session=${sessionId || 'none'} model="${modelStr}" agent=${activeAgent || opencodeSP?.slice(0, 40) || '?'} depth=${messages.filter(m => m.role === 'user').length} mode=${doPassthrough ? 'passthrough' : 'cf'}${changed ? ' [agent-detected-change]' : ''}`);

      if (doPassthrough) {
        const result = await forwardStream(messages, reqData, res, { model: TARGET_MODEL, sessionId });
        // Attribute the turn to the actual stage agent (product/architect/
        // typescript/review) even in RF mode — the name is in the opencode SP.
        const rfAgent = activeAgent || resolveAgent(opencodeSP, AGENTS)?.name || '(passthrough)';
        // Enhanced per-request metrics (same as CF path)
        const totalMsgChars = messages.reduce((s, m) => s + (m.content?.length || 0), 0);
        const sharedChars = messages[0]?.content?.length || 0;
        const personaChars = 0; // RF: no persona suffix; full SP at position 0
        const contextChars = totalMsgChars - sharedChars;
        // RF persona_ctx_chars: real per-session accumulator (matches CF path),
        // not the old contextChars × turns estimate (which over-counted and was
        // not comparable to CF's cumulative value).
        if (session) session.personaCtxChars += contextChars;
        logCall({
          event: 'turn', agent: rfAgent, turns: session?.turns ?? 0,
          passthrough: true,
          tokens: result.inputTokens, cached: result.cacheHits, cache_miss: result.cacheMisses || 0, output: result.outputTokens,
          savings_pct: result.inputTokens > 0 ? ((result.cacheHits / result.inputTokens) * 100).toFixed(1) : '0.0',
          model: modelStr,
          shared_chars: sharedChars,
          persona_chars: personaChars,
          context_chars: contextChars,
          persona_turns: session?.turns ?? 0,
          persona_ctx_chars: session?.personaCtxChars ?? 0,
        }, sessionId);
        if (session) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
          if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
          session.turns++;
          // Repeated-read detection (same as CF path)
          let repeatedReads = 0;
          if (result.toolCalls) {
            const readTools = /^(read|Read|view|glimpse|open)$/i;
            const writeTools = /^(edit|write|Write|create)$/i;
            for (const tc of result.toolCalls) {
              const name = tc.name || '';
              const fp = extractFilePath(name, tc.args || '');
              if (!fp) continue;
              const turn = session.turns;
              if (readTools.test(name)) {
                const lastRead = session.fileReads.get(fp);
                const lastWrite = session.fileWrites.get(fp);
                if (lastRead !== undefined && (!lastWrite || lastWrite < lastRead)) repeatedReads++;
                session.fileReads.set(fp, turn);
              } else if (writeTools.test(name)) {
                session.fileWrites.set(fp, turn);
              }
            }
          }
          if (repeatedReads > 0) {
            logCall({ event: 'repeated_reads', count: repeatedReads, turns: session.turns }, sessionId);
          }
        }
        return;
      }

      // ── Fork-join path (fj mode) ──
      // The preset agent set runs on EACH turn: the shared conversation is
      // forked once per preset agent (each fork = rewriteToContentFirst with a
      // different personaSP — position 0 + history byte-identical, tail differs),
      // executed seed-then-warm so forks 2..N hit the provider prefix cache the
      // seed populated, then the N outputs are JOINED back into the single
      // response opencode sees. See fj-mode-design.md §3.4.
      if (isFJModel) {
        const preset = session?.presetSet || [];
        const fjPrompt = sessionId ? renderFJInstructions(sessionId) : null;
        if (preset.length === 0) {
          // No preset set — behave as a standard single-agent turn (tools
          // work, execution happens), but position 0 still carries the FJ
          // instructions so the model KNOWS the agent-set endpoint exists
          // before it ever tries to trigger a fork.
          console.error(`[cf-proxy] fj: no preset set for session ${sessionId} — passthrough (FJ instructions injected)`);
          const fjStandard = rewriteToContentFirst(messages, '', opencodeSP, fjPrompt, null, '');
          const result = await forwardStream(fjStandard.messages, reqData, res, { model: TARGET_MODEL, sessionId });
          logCall({
            event: 'fj_turn', agent: '(passthrough)', join_mode: session?.joinMode || 'concat',
            preset: [], turns: session?.turns ?? 0, note: 'no preset set — standard turn',
            shared_chars: fjStandard.messages[0]?.content?.length || 0,
          }, sessionId);
          return;
        }

        const cfPrompt = fjPrompt;
        const presetAgents = preset
          .map(name => resolveAgent(name, AGENTS))
          .filter(Boolean);
        if (presetAgents.length === 0) {
          return jsonResponse(res, 404, { error: 'preset agents no longer resolve in registry', preset });
        }

        // ── FORK: the request goes through the PROVEN CF rewrite, once per
        // preset agent (2026-08-05 redesign). Each fork is exactly what the
        // single-agent CF path does — rewriteToContentFirst(personaSP =
        // agent.systemPrompt) — which is what established persona identity
        // and real analysis in v0.0.1. NO fork-specific flags: no persona-as-
        // new-message, no reasoning-echo backfill games. The CF rewrite
        // already appends the persona at the tail and preserves the reasoning
        // echo correctly. The forks share the byte-identical position-0 +
        // history (only the persona tail differs) → the seed-then-warm
        // ordering still delivers the fork-join cache geometry.
        //
        // CRITICAL (2026-08-05, the "empty forks" root cause): the FORKS must
        // NOT carry the FJ instructions block (fjPrompt) at position 0. The FJ
        // block describes the fork MECHANISM ("you are running through a
        // fork-join proxy, call the endpoint, the preset auto-resets...") —
        // injected into the fork's system prompt, it makes the model NARRATE
        // the orchestration ("fork set stored, let me check the session
        // state") instead of ANALYZING the task. Verified: same fork with
        // cfPrompt='' → real review; with fjPrompt → narration. Forks get the
        // CF-style session instructions (or empty); only the main agent's
        // standard turns carry the FJ trigger instructions.
        const forkPrompt = sessionId ? renderCFInstructions(sessionId) : null;
        const forks = presetAgents.map(agent => rewriteToContentFirst(
          messages,
          agent.systemPrompt,   // personaSP — per-fork (exactly the CF path)
          opencodeSP,
          forkPrompt,           // CF instructions, NOT the FJ self-referential block
          null,                 // no handoff task in fj mode
          agent.name,           // agentName — per-fork marker
        ));

        // ── EXECUTE: seed-then-warm (cache-critical ordering) ──
        // Fork 0 runs alone (cold seed — populates the provider prefix cache
        // for the shared context). Forks 1..N-1 then run in parallel and hit
        // that cache (warm), which is the fork-join claim being measured.
        // Each fork CARRIES the session id (so its raw_request/raw_response
        // attribute to the right per-session log) and the FORWARDED tools
        // (forks act as the opencode agent would — the tool schema is not
        // stripped). tools=[] is gone: forks get reqData.tools.
        const forkResults = [];
        const execute = async (fork, idx) => {
          const start = Date.now();
          const resp = await forwardBlocking(fork.messages, {
            model: TARGET_MODEL,
            max_tokens: reqData.max_tokens ?? 2000,
            temperature: reqData.temperature ?? 0,
            // [fj:forks-analysis-only] Forks run WITHOUT the tool schema
            // (tools: []). Reasons (2026-08-05):
            //   1. Fork tool_calls can't execute — emitting them fabricates a
            //      tool-call assistant message without reasoning_content →
            //      DeepSeek 400 "reasoning_content must be passed back".
            //   2. A fork that wants a tool returns EMPTY content → the concat
            //      join produces useless empty perspective blocks.
            // Forks analyze the shared context and answer; the main agent
            // (which has tools) executes. Real fork tool-loops are the v2
            // design — see fj-mode-design.md §[fj-tool-loop-v2].
            tools: [],
            sessionId,                     // carry the session id to the log
            fork: presetAgents[idx].name,  // tag the fork in raw events
          });
          return {
            index: idx,
            agent: presetAgents[idx].name,
            warm: idx > 0,
            latencyMs: Date.now() - start,
            tokensIn: resp.provider?.tokens?.prompt ?? 0,
            cacheHit: resp.provider?.tokens?.cacheHit ?? 0,
            tokensOut: resp.provider?.tokens?.completion ?? 0,
            output: resp.choices?.[0]?.message?.content || '',
            // The reasoning trail is the EVIDENCE behind the conclusion — the
            // decisions live there (v0.0.1: architect's PATCH-vs-TEMPLATE call
            // found in reasoning_content, cf-fresh:2015). Concatenating only
            // content would hand the main agent conclusions without the
            // analysis that produced them. Captured here so the join can
            // include it.
            reasoning: resp.choices?.[0]?.message?.reasoning_content || '',
            // Tool calls the fork requested (forks carry opencode's tool
            // schema). Captured for the dedup+merge in the join — opencode
            // executes them client-side and the results join the posted
            // prefix, cache-safe (write-through on posted input).
            toolCalls: (resp.choices?.[0]?.message?.tool_calls || []).map(tc => ({
              id: tc.id || `fj-${idx}-${tc.function?.name || 'tc'}-${Math.random().toString(36).slice(2, 8)}`,
              name: tc.function?.name || '',
              args: tc.function?.arguments || '',
            })),
          };
        };
        forkResults.push(await execute(forks[0], 0));            // cold seed
        const rest = await Promise.all(forks.slice(1).map((f, i) => execute(f, i + 1))); // warm
        forkResults.push(...rest);

        // ── JOIN — switch preserved, judge NOT applied yet (2026-08-05) ──
        // The switch selects the join strategy (concat | judge). The judge
        // branch is STRUCTURALLY PRESENT but deliberately NOT reachable: per
        // user directive, judge filtering is not applied yet — the join is
        // concat unconditionally, and the model (which learned the agent-set
        // endpoint from the FJ instructions) synthesizes the N perspectives
        // itself. The switch stays so enabling judge filtering later is a
        // one-line change (make the case reachable); the fj-judge agent and
        // the endpoint's joinMode field remain for that moment.
        let joined;
        switch (session?.joinMode || 'concat') {
          case 'judge': {
            // [fj:judge-dormant] — judge filtering is NOT applied yet.
            // When enabled: resolveAgent('fj-judge') → one forwardBlocking
            // over the N outputs → parse FJ-CONTROL → apply preset changes.
            // Deliberately falls through to concat until the user enables it.
            console.error(`[cf-proxy] fj: join_mode=judge requested but judge filtering is not enabled yet — using concat`);
            logCall({
              event: 'fj_judge_stub', sessionId, turns: session?.turns ?? 0,
              note: 'judge filtering not enabled (2026-08-05 directive) — concat used',
            }, sessionId);
            // fall through
          }
          case 'concat':
          default: {
            // Concat the fork CONCLUSIONS (content) only. The reasoning trail
            // is NOT streamed into the output — it is captured in the
            // per-fork raw_response log for forensics (v0.0.1: decisions live
            // in reasoning — that is POST-HOC analysis, not runtime context).
            // [fj:reasoning-internal] Streaming reasoning into the joined
            // response makes it conversation content: it pollutes the cached
            // prefix, is re-sent verbatim every turn, and the model reads its
            // own old reasoning as ground truth (the "momentum and direction"
            // persistence). Reasoning stays internal; content is the output.
            joined = forkResults
              .map(f => `\n\n--- CF-AGENT:${f.agent}:sha256:${f.index} ---\n${f.output}\n--- /CF-AGENT ---`)
              .join('\n');
            break;
          }
        }

        // ── TOOL-CALL DEDUP + MERGE (2026-08-05) — LOG ONLY, NEVER EMITTED ──
        // Forks carry opencode's tool schema and may each request tool calls.
        // Collect + dedup them for AUDIT (per-fork behavior signal), but do
        // NOT emit them as delta.tool_calls in the streamed response.
        // [fj:no-tool-emit] Emitting tool_calls alongside the concat content
        // makes opencode assemble ONE assistant message with content +
        // tool_calls + NO reasoning_content — which DeepSeek rejects on the
        // next turn ("reasoning_content must be passed back", 400). The
        // reasoning-echo contract requires every tool-call assistant message
        // to carry reasoning_content; a proxy-fabricated merge cannot. Forks
        // are advisory: the main agent sees the joined perspectives (which
        // can RECOMMEND tools in text) and decides what to actually run.
        const mergedToolCalls = [];
        {
          const seen = new Set();
          for (const f of forkResults) {
            for (const tc of f.toolCalls || []) {
              const key = `${tc.name}|${tc.args}`;
              if (seen.has(key)) continue;
              seen.add(key);
              mergedToolCalls.push({
                index: mergedToolCalls.length,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.args },
              });
            }
          }
        }
        if (mergedToolCalls.length > 0) {
          console.error(`[cf-proxy] fj: observed ${mergedToolCalls.length} deduped tool call(s) from ${forkResults.length} forks (${forkResults.reduce((n, f) => n + (f.toolCalls?.length || 0), 0)} raw) — LOGGED, not emitted (reasoning-echo contract)`);
        }

        // ── Stream the joined result back to opencode as SSE ──
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const totalIn = forkResults.reduce((s, f) => s + f.tokensIn, 0);
        const totalHit = forkResults.reduce((s, f) => s + f.cacheHit, 0);
        const totalOut = forkResults.reduce((s, f) => s + f.tokensOut, 0);
        const chunk = {
          id: `fj-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: TARGET_MODEL,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: joined },
            // NO tool_calls here — see [fj:no-tool-emit]. Emitting them would
            // fabricate a tool-call assistant message without reasoning_content,
            // violating DeepSeek's reasoning-echo contract (400 on next turn).
            finish_reason: 'stop',
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: `fj-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: TARGET_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: totalIn, completion_tokens: totalOut, prompt_cache_hit_tokens: totalHit },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

        // ── Persist + metrics ──
        if (session) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
          session.context.push({ role: 'assistant', content: joined });
          session.turns++;
        }
        logCall({
          event: 'fj_turn', agent: presetAgents.map(a => a.name).join(','),
          join_mode: session?.joinMode || 'concat', fork_count: forkResults.length, turns: session?.turns ?? 0,
          tokens: totalIn, cached: totalHit, cache_miss: totalIn - totalHit, output: totalOut,
          savings_pct: totalIn > 0 ? ((totalHit / totalIn) * 100).toFixed(1) : '0.0',
          tool_calls_merged: mergedToolCalls.length,
          tool_calls_raw: forkResults.reduce((n, f) => n + (f.toolCalls?.length || 0), 0),
          forks: forkResults.map(f => ({
            agent: f.agent, warm: f.warm, tokens_in: f.tokensIn,
            cache_hit: f.cacheHit, tokens_out: f.tokensOut, latency_ms: f.latencyMs,
            hit_ratio: f.tokensIn > 0 ? ((f.cacheHit / f.tokensIn) * 100).toFixed(1) : '0.0',
            tool_calls: f.toolCalls?.map(tc => tc.name) || [],
          })),
        }, sessionId);

        // ── AUTO-RESET (2026-08-05) — the fork is a ONE-SHOT trigger ──
        // [fj:one-shot] After this fork runs, clear the preset so the session
        // returns to standard single-agent mode. This makes fj an ALTERNATION
        // (trigger → fork → concat → back to normal), not a sticky mode: the
        // model's trigger fires ONE fork round, then tools/execution work
        // normally until the model triggers again. Without this, every
        // subsequent request (including opencode's tool continuations of the
        // SAME user message) forks forever.
        if (session) {
          const wasPreset = session.presetSet;
          session.presetSet = [];
          console.error(`[cf-proxy] fj: fork completed — preset auto-reset (was [${wasPreset.join(', ')}]) → standard mode`);
          logCall({
            event: 'fj_auto_reset', sessionId, turns: session.turns,
            cleared: wasPreset,
          }, sessionId);
        }
        return;
      }

      // ── Content-first path (true streaming) ──
      // Handoff continuation: the task from the session_agent_set call is
      // embedded in the persona suffix on the last user message — it gives
      // the new agent an explicit trigger without injecting a separate
      // message (which would break monotonic prefix growth and kill cache
      // reuse at handoff boundaries).
      const handoffTask = session?.pendingInput || null;
      if (handoffTask) {
        session.pendingInput = null; // one-shot, cleared after use
        console.error(`[cf-proxy] handoff task embedded in persona: ${Math.ceil(handoffTask.length / 4)} tokens`);
      }
      const cfPrompt = sessionId ? renderCFInstructions(sessionId) : null;
            const cf = rewriteToContentFirst(messages, personaSP, opencodeSP, cfPrompt, handoffTask, activeAgent || '');
      // ── In-flight cache-blow predictor (v4) ──
      // Compare the previous forwarded prefix vs the current one. The provider
      // prefix cache hits on the longest common prefix; if the persona moved
      // off the tail (the settle-turn floor-wipe bug) the predicted hit
      // collapses to system+first-user. A predicted drop below the previous
      // hit minus the persona delta means a blow BEFORE the request is sent.
      //
      // LEGACY-SESSION GUARD (2026-08-04): a session whose conversation carries
      // the OLD '--- Role ---' persona marker was created under the pre-v4
      // rewrite (Option C). The v4 rewrite restructures such conversations
      // (persona target moves, position 0 changes) so a large predicted blow
      // is a VERSION-MIGRATION artifact, NOT mid-stage corruption. Hard-fail
      // would kill the proxy on the first legacy session it touches (observed:
      // ses_03610a02d, blow 319736 on turn 2 → process.exit(1)). Log-only for
      // legacy sessions; hard-fail only for v4-native sessions.
      const LEGACY_MARKER = '--- Role ---';
      const isLegacySession = messages.some(m =>
        typeof m.content === 'string' && m.content.includes(LEGACY_MARKER)
      );
      if (session && session.lastForwarded) {
        const predicted = predictCacheHit(session.lastForwarded, cf.messages);
        const lastHit = session.lastCacheHits || 0;
        const blow = lastHit - predicted;
        // Allowed: handoff-authorized persona change (legit tail swap) and
        // normal delta growth. NOT allowed: a mid-stage collapse to floor.
        const handoffNow = handoffTask != null;
        const floorish = predicted < lastHit * 0.5 && lastHit > 20000;
        if (blow > 20000 && !handoffNow && floorish) {
          // WARN ONLY — never hard-fail on predictCacheHit.
          // (2026-08-04) This estimator does a CHAR-LEVEL prefix compare, NOT
          // the provider's real tokenizer. It false-positived on the pre-v4
          // session ses_03610a02d (predicted 183816, provider ACTUALLY cached
          // 503,552 = 98.2%) and killed the proxy — taking down ALL sessions.
          // A predicted-blow estimate is never proof of corruption; the
          // deterministic corruptionCheck (persona change without handoff) is
          // the only hard-fail path. Log for post-hoc audit instead.
          console.error(`[cf-proxy] ⚠ CACHE-BLOW WARNING (no abort): session ${session.id} turn ${session.turns}: predicted=${predicted} vs lastHit=${lastHit} (blow ${blow}) legacy=${isLegacySession}. Verify via raw_response usage — predictor is a char-level estimate, not the provider tokenizer.`);
        }
        console.error(`[cf-proxy] cache-predict: predicted=${predicted} lastHit=${lastHit} blow=${blow} handoff=${handoffNow} floorish=${floorish} legacy=${isLegacySession}`);
      }

      // ── Enhanced metrics ──
      const totalMsgChars = cf.messages.reduce((s, m) => s + (m.content?.length || 0), 0);
      const sharedChars = cf.messages[0]?.content?.length || 0;
      const personaMarkerChars = '\n\n--- CF-AGENT:'.length + '\n--- /CF-AGENT ---'.length;
      const personaChars = (cf.agentRole ? cf.agentRole.length : 0) + personaMarkerChars;
      const contextChars = totalMsgChars - sharedChars - personaChars;
      // Increment per-persona metrics
      if (session) {
        session.personaTurns++;
        session.personaCtxChars += contextChars;
      }
      // Verify the v4 invariants reached the forwarded messages:
      //  - personaApplied: the TRUE LAST message carries "--- /CF-AGENT ---"
      //  - position0: system message untouched (opencode SP, the cache anchor)
      const tailMsg = cf.messages[cf.messages.length - 1];
      const roleApplied = tailMsg?.content ? tailMsg.content.includes('--- /CF-AGENT ---') : false;
      const sharedAnchor = cf.messages[0]?.content?.includes('--- CF-System:v4:sha256:') || false;
      const sharedSysLen = cf.messages[0]?.content?.length || 0;
      const goUntouched = !cf.messages[1]?.content?.includes('--- CF-') || false;
      console.error(`[cf-proxy] rewrite: agent=${activeAgent || '?'} shared=${sharedChars} persona=${personaChars} ctx=${contextChars} sessTurns=${session?.turns ?? 0} personaTurns=${session?.personaTurns ?? 0} personaCtx=${session?.personaCtxChars ?? 0} role=${roleApplied} anchor=${sharedAnchor} goClean=${goUntouched} sysLen=${sharedSysLen}`);

      // True streaming passthrough to upstream. The virtual tool is DISABLED
      // here (CF_VIRTUAL_TOOL=1 re-enables it later once the baseline works);
      // session agent switching happens via POST /v1/session/agent instead.
      const result = await forwardStream(cf.messages, reqData, res, { model: TARGET_MODEL, sessionId });

      // Store turn in session context
      if (session) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
        if (result.fullText) session.context.push({ role: 'assistant', content: result.fullText });
        session.turns++;
        // Cache-predictor state: what we forwarded this turn + provider hit.
        session.lastForwarded = cf.messages;
        session.lastCacheHits = result.cacheHits;
        session.lastForwardedHash = serializeForwarded(cf.messages).slice(0, 200);
      }

      // ── Repeated-read detection (cross-agent knowledge signal) ──
      // Parse the model's tool calls for file operations. A repeated read
      // means the agent opened a file that was already read in this session
      // without an intervening write to it — a potential context-inefficiency
      // signal (agent is re-reading rather than using conversation context).
      let repeatedReads = 0;
      if (session && result.toolCalls) {
        const readTools = /^(read|Read|view|glimpse|open)$/i;
        const writeTools = /^(edit|write|Write|create)$/i;
        for (const tc of result.toolCalls) {
          const name = tc.name || '';
          const args = tc.args || '';
          const filePath = extractFilePath(name, args);
          if (!filePath) continue;
          const turn = session.turns || 0;
          if (readTools.test(name)) {
            const lastRead = session.fileReads.get(filePath);
            const lastWrite = session.fileWrites.get(filePath);
            if (lastRead !== undefined && (!lastWrite || lastWrite < lastRead)) {
              repeatedReads++;
            }
            session.fileReads.set(filePath, turn);
          } else if (writeTools.test(name)) {
            session.fileWrites.set(filePath, turn);
          }
        }
      }
      if (repeatedReads > 0) {
        logCall({ event: 'repeated_reads', count: repeatedReads, turns: session?.turns ?? 0 }, sessionId);
        console.error(`[cf-proxy] repeated_reads: ${repeatedReads} file(s) re-read on this turn (session ${sessionId})`);
      }

      logCall({
        event: 'turn', agent: activeAgent || '(unassigned)', turns: session?.turns ?? 0,
        passthrough: false,
        agent_changed: changed,
        // Uniform metrics schema across both arms (cf and rf) so per-agent
        // comparison is direct: same field names, same savings math.
        tokens: result.inputTokens, cached: result.cacheHits, cache_miss: result.cacheMisses || 0, output: result.outputTokens,
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ╔══════════════════════════════════════════════════════╗`);
  console.log(`  ║  Content-First Proxy (session-aware)                ║`);
  console.log(`  ║  Port: ${PORT}   Sessions: ${sessions.size}  Agents: ${AGENTS.size}       ║`);
  console.log(`  ║  Target: ${TARGET_BASE}  ║`);
  console.log(`  ║  Model: ${TARGET_MODEL}  Virtual tool: ${INJECT_TOOL ? 'on' : 'off'}        ║`);
  console.log(`  ║  Log base: ${LOG_BASE}  ║`);
  console.log(`  ╚══════════════════════════════════════════════════════╝\n`);
});
