/**
 * cf-proxy.mjs  —  Content-First Proxy Server
 *
 * OpenAI-compatible HTTP server that transparently rewrites
 * role-first calls into content-first before forwarding to the provider.
 * Supports passthrough mode (CF_PASSTHROUGH=1) for use as a standard
 * transparent proxy without the rewrite — e.g. as an opencode provider.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY="sk-..."
 *   node proxy/cf-proxy.mjs
 *   # Then set model to cf-proxy/cf-v4-flash in opencode
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI chat API with streaming support
 *   POST /v1/chat/fork          — Fork N agents from shared context
 *   GET  /v1/health             — Health check with cache stats
 *
 * Env:
 *   CF_PORT=3333        Port to listen on
 *   CF_LOG=<path>       JSONL log path (default: proxy/cf-proxy-log.jsonl)
 *   CF_VERBOSE=1        Print per-call comparisons to stdout
 *   CF_PASSTHROUGH=1    Transparent proxy mode — skip content-first rewrite,
 *                       forward messages as-is (for use as opencode provider)
 *   CF_TARGET=<url>     Upstream API base URL (default: https://api.deepseek.com/v1)
 *   CF_MODEL=<id>       Model name sent to upstream (default: deepseek-v4-flash)
 *   DEEPSEEK_API_KEY    Required
 *   OPENAI_API_KEY      Falls back to this if DEEPSEEK_API_KEY not set
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CF_PORT || '3333', 10);
const TARGET_BASE = process.env.CF_TARGET || 'https://api.deepseek.com/v1';
const TARGET_MODEL = process.env.CF_MODEL || 'deepseek-v4-flash';
const VERBOSE = process.env.CF_VERBOSE === '1';
const PASSTHROUGH = process.env.CF_PASSTHROUGH === '1';
const LOG_PATH = process.env.CF_LOG || path.join(__dirname, 'proxy-cf-log.jsonl');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ADHD_AGENT_DEEPSEEK_SECRET || process.env.OPENAI_API_KEY || '';

// ──────── Agent-file aware split ────────

const AGENT_DIR = path.join(process.env.HOME || '/Users/nix', '.config', 'opencode', 'agents');

function loadAgentBodies() {
  const agents = [];
  try {
    for (const file of fs.readdirSync(AGENT_DIR)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
      // Strip YAML frontmatter (---\n...\n---)
      const body = raw.replace(/^---[\s\S]*?---\n+/, '').trim();
      if (body.length > 100) agents.push({ name: file.replace('.md', ''), body });
    }
  } catch {}
  return agents;
}
const _agentBodies = loadAgentBodies();

/**
 * Split the composed system prompt into shared boilerplate + agent role.
 *
 * Opencode prepends the agent .md body FIRST, then appends the shared
 * boilerplate (opencode base prompt + AGENTS.md + tools + skills + env).
 * So the structure is:
 *   system = [agent_body][shared_boilerplate]
 *
 * Strategy: find which known agent body the system prompt STARTS with.
 */
function splitSystemPrompt(system) {
  if (!system) return { shared: '', agentRole: '' };

  // Find which agent body the prompt starts with (longest prefix match wins)
  let bestMatch = '';
  for (const agent of _agentBodies) {
    if (system.startsWith(agent.body)) {
      if (agent.body.length > bestMatch.length) {
        bestMatch = agent.body;
      }
    }
  }

  if (bestMatch.length > 50) {
    return {
      agentRole: bestMatch,
      shared: system.slice(bestMatch.length).trim(),
    };
  }

  // Fallback: no agent body found at start — treat everything as brute-force suffix
  return { shared: '', agentRole: system };
}

// ──────── Cache simulation ────────

class BlockCacheSim {
  constructor() { this.blocks = new Map(); this.hits = 0; this.misses = 0; }
  get(hash) { const hit = this.blocks.has(hash); if (hit) this.hits++; else this.misses++; return hit; }
  set(hash, size) { this.blocks.set(hash, size); }
  stats() { const total = this.hits + this.misses; return { blocks: this.blocks.size, hits: this.hits, misses: this.misses, hitRate: total > 0 ? (this.hits / total * 100).toFixed(1) + '%' : '0%' }; }
}
const cache = new BlockCacheSim();

// ──────── Logger ────────

function logCall(entry) {
  entry._ts = new Date().toISOString();
  const tag = entry._log_tag || entry._session_id || '';
  const logPath = tag ? path.join(__dirname, `proxy-${tag}.jsonl`) : LOG_PATH;
  delete entry._log_tag;
  delete entry._session_id;
  const line = JSON.stringify(entry) + '\n';
  try { fs.appendFileSync(logPath, line); } catch {}
  if (VERBOSE) {
    console.log('');
    console.log('── CF Proxy ──────────────────────────────────────────');
    if (entry.endpoint === '/v1/chat/completions') {
      console.log(`  System: ${(entry.system || '(none)').slice(0, 60).replace(/\n/g, ' ')}...`);
      console.log(`  Depth: ${entry.conversation_depth} turns  CF cached: ${entry.cf_cached}t  Savings: ${entry.savings_pct}%`);
      if (entry.agent_switch_verdict) console.log(`  ${entry.agent_switch_verdict}`);
    } else {
      console.log(`  Fork: ${entry.forks} agents  Tokens: ${entry.shared_context_tokens}t shared`);
    }
    console.log('──────────────────────────────────────────────────────');
  }
}

// ──────── Core rewrite logic ────────

function rewriteToContentFirst(messages) {
  const system = messages.find(m => m.role === 'system')?.content;
  const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
  if (lastUserIdx === -1 || !system) {
    return { messages, system, savings: 0, cachedSeed: false, seedTokens: 0, systemTokens: 0 };
  }

  // Split into shared boilerplate + agent-specific role
  const { shared, agentRole } = splitSystemPrompt(system);
  const hasSplit = shared.length > 0 && agentRole.length > 0;

  const systemTokens = Math.ceil(system.length / 4);
  const seedTokens = Math.ceil(messages[lastUserIdx].content.length / 4);

  if (hasSplit) {
    // CF thesis: shared boilerplate stays at position 0 (cached across agents).
    // Only the agent role is appended to the user message.
    const result = messages.map(m => ({ ...m }));
    result[lastUserIdx] = {
      ...result[lastUserIdx],
      content: `${result[lastUserIdx].content}\n\n--- Role ---\n${agentRole}`,
    };
    // Replace the full system prompt with only the shared boilerplate
    // so it remains at position 0 for caching across agent switches.
    const sysIdx = result.findIndex(m => m.role === 'system');
    if (sysIdx !== -1) {
      result[sysIdx] = { ...result[sysIdx], content: shared };
    }

    const seedHash = seedTokens > 100 ? `seed-${seedTokens}` : null;
    const cached = seedHash ? cache.get(seedHash) : false;
    if (seedHash && !cached) cache.set(seedHash, seedTokens);

    return {
      messages: result,
      system: shared,
      savings: cached ? ((seedTokens / (seedTokens + agentRole.length / 4)) * 100).toFixed(1) : '0.0',
      cachedSeed: cached,
      seedTokens,
      systemTokens,
      agentTokens: Math.ceil(agentRole.length / 4),
    };
  }

  // Fallback: no split found — brute-force move entire system to user message
  const rewritten = messages.map(m => ({ ...m }));
  rewritten[lastUserIdx] = {
    ...rewritten[lastUserIdx],
    content: `${rewritten[lastUserIdx].content}\n\n${system}`,
  };
  const filtered = rewritten.filter(m => m.role !== 'system');

  const seedHash = seedTokens > 100 ? `seed-${seedTokens}` : null;
  const cached = seedHash ? cache.get(seedHash) : false;
  if (seedHash && !cached) cache.set(seedHash, seedTokens);

  return {
    messages: filtered,
    system,
    savings: cached ? ((seedTokens / (seedTokens + systemTokens)) * 100).toFixed(1) : '0.0',
    cachedSeed: cached,
    seedTokens,
    systemTokens,
    agentTokens: systemTokens,
  };
}

// ──────── Forward with streaming support ────────

async function forwardStream(providerMessages, reqData, res, options = {}) {
  const body = {
    ...reqData,            // pass through EVERYTHING from the client
    model: options.model || reqData.model || TARGET_MODEL,
    messages: providerMessages,
    stream: true,          // always stream
  };

  const response = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    // Return error as SSE so client gets a readable message
    const errMsg = `data: {"error":"Provider ${response.status}: ${errText.slice(0,200)}"}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(errMsg);
    return { inputTokens: 0, outputTokens: 0, cacheHits: 0, fullText: '' };
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Pipe the entire response body to the client
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let inputTokens = 0, outputTokens = 0, cacheHits = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);

    // Extract usage from the final chunk
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.usage) {
            inputTokens = data.usage.prompt_tokens || 0;
            outputTokens = data.usage.completion_tokens || 0;
            cacheHits = data.usage.prompt_cache_hit_tokens || 0;
          }
          if (data.choices?.[0]?.delta?.content) {
            fullText += data.choices[0].delta.content;
          }
        } catch {}
      }
    }
  }

  res.end();
  return { inputTokens, outputTokens, cacheHits, fullText };
}

// ──────── Non-streaming forward (for fork endpoint) ────────

async function forwardBlocking(messages, options = {}) {
  const body = {
    model: options.model || TARGET_MODEL,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.max_tokens ?? 2000,
  };

  const start = Date.now();
  const res = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
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

// ──────── HTTP Server ────────

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // GET /v1/health
    if (req.method === 'GET' && path === '/v1/health') {
      return jsonResponse(res, 200, {
        ok: true,
        mode: PASSTHROUGH ? 'passthrough' : 'content-first',
        target: { base: TARGET_BASE, model: TARGET_MODEL },
        cache: cache.stats(),
        provider: PASSTHROUGH ? 'content-first proxy (passthrough)' : 'content-first proxy',
      });
    }

    // POST /v1/chat/completions (streaming)
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      let body = '';
      req.on('data', chunk => body += chunk);
      await new Promise(resolve => req.on('end', resolve));
      const reqData = JSON.parse(body);
      const messages = reqData.messages || [];
      const system = messages.find(m => m.role === 'system')?.content;

      // Model-based routing: 'cf-*' models trigger rewrite, anything else is passthrough
      const doPassthrough = PASSTHROUGH || !(reqData.model && reqData.model.startsWith('cf-'));
      console.error(`[cf-proxy] Request: model="${reqData.model}" stream=${reqData.stream} depth=${messages.filter(m => m.role === 'user').length} mode=${doPassthrough ? 'passthrough' : 'cf'}`);

      if (doPassthrough) {
        // Forward as-is (no rewrite) — transparent proxy mode for opencode.
        // Map the model name to the real upstream model ID (the custom name
        // is for opencode's provider registry; DeepSeek expects its own ID).
        const result = await forwardStream(messages, reqData, res, { model: TARGET_MODEL });
        logCall({
          _log_tag: reqData.model,
          endpoint: '/v1/chat/completions',
          passthrough: true,
          system: system || '',
          user_first: (messages.find(m => m.role === 'user')?.content || '').slice(0, 120),
          user_last: (messages.find(m => m.role === 'user')?.content || '').slice(-120),
          conversation_depth: messages.filter(m => m.role === 'user').length,
          rf_tokens: result.inputTokens,
          rf_cached: result.cacheHits,
          rf_output: result.outputTokens,
        });
        return;
      }

      // Rewrite to content-first
      const cf = rewriteToContentFirst(messages);

      // Forward with streaming (override model to TARGET_MODEL)
      const result = await forwardStream(cf.messages, reqData, res, { model: TARGET_MODEL });

      const cfSystemMsg = cf.messages.find(m => m.role === 'system');
      logCall({
        _log_tag: reqData.model,
        endpoint: '/v1/chat/completions',
        passthrough: false,
        system_original: system || '',
        system: cfSystemMsg?.content || '',
        user_first: (messages.find(m => m.role === 'user')?.content || '').slice(0, 120),
        user_last: (cf.messages.find(m => m.role === 'user')?.content || '').slice(-120),
        conversation_depth: messages.filter(m => m.role === 'user').length,
        agent_switch: messages.length > 2,
        agent_switch_verdict: messages.length > 2
          ? (cf.cachedSeed
              ? '✅ Context survived agent switch (seed cached)'
              : cf.seedTokens > 1000
                ? '❌ Context NOT cached — different system prompt at position 0'
                : '⏳ Content too small for cache block')
          : null,
        cf_tokens: result.inputTokens,
        cf_cached: result.cacheHits,
        cf_output: result.outputTokens,
        savings_pct: cf.savings,
        cached_seed: cf.cachedSeed,
        seed_tokens: cf.seedTokens,
        system_tokens: cf.systemTokens,
      });
      return;
    }

    // POST /v1/chat/fork
    if (req.method === 'POST' && path === '/v1/chat/fork') {
      let body = '';
      req.on('data', chunk => body += chunk);
      await new Promise(resolve => req.on('end', resolve));
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
          { model: TARGET_MODEL, max_tokens: fork.max_tokens, temperature: fork.temperature ?? 0 }
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
        endpoint: '/v1/chat/fork',
        forks: forks.length,
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

    return jsonResponse(res, 404, { error: 'Not found', path });

  } catch (err) {
    console.error('Error:', err.message);
    if (!res.headersSent) {
      return jsonResponse(res, 500, { error: err.message });
    }
    res.end();
  }
});

server.listen(PORT, () => {
  const modeLabel = PASSTHROUGH ? 'Passthrough' : 'Content-First';
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  Content-First Proxy  [${modeLabel}]              ║`);
  console.log(`  ║  Port: ${PORT}   (streaming)                      ║`);
  console.log(`  ║  Target: ${TARGET_BASE}    ║`);
  console.log(`  ║  Model: ${TARGET_MODEL}                         ║`);
  console.log(`  ║  Log: ${LOG_PATH}  (model-named per request)    ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});
