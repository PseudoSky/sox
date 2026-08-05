// ────────────────────────────────────────────────────────────────────────────
// fj-proxy.mjs — the fork-join (proxy/fj) proxy, as a STANDALONE module.
//
// Completely independent of cf-proxy.mjs's code. The only couplings are:
//   (a) cf-proxy.mjs MOUNTS this module as a route handler in its
//       /v1/chat/completions endpoint (the `isFJModel` case), and
//   (b) this module SELF-CALLS the same HTTP server's /v1/chat/completions
//       with model=cf for EVERY fj request — main turns AND forks.
//
// Every fj request therefore flows through the CF path's proven rewrite and
// streaming machinery. The fj module owns only the orchestration:
//   - the persona tail (persona + FJ instructions for the main turn; the fork
//     persona for each fork) pre-appended to the last message,
//   - the parallel fork barrier (interleaved streaming, ONE final stop when
//     the last fork's stream ends),
//   - per-fork ISOLATED sub-session capture (`<main>#fj-<uuid>`),
//   - the one-shot auto-reset.
//
// CACHE-SAFE SHAPE: fj self-calls send NO sessionId. The CF path's position-0
// CF-instruction injection is gated on sessionId, so with none present the
// forwarded request keeps the RAW opencode SP at position 0 — byte-identical
// across forks AND across the main session's turns. That is the exact shape
// measured at 90.2% fork-round cache hits (session 02fa12a19: no
// CF-instructions marker in any fork body; per-fork hit ratios 86.8-92.0%).
// This is how "disable cf instruction injection" is applied in the fj layer,
// with the CF code path itself untouched (2026-08-05 directive).
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { MARKERS, buildFJInstructions, buildPersonaSuffix, resolveAgent } from './cf-rewrite.mjs';

// ── Self-call: route one fj request through the CF proxy over HTTP ──
// Fetches the local /v1/chat/completions (model=cf) and streams the response
// to `res`. Modes:
//   - no onChunk: forward the response BYTES verbatim (main turn — the
//     provider's finish_reason and [DONE] pass through as-is).
//   - onChunk(data): per parsed chunk (fork path — writeChunk rewrites
//     finish_reason → null; the barrier owns the single stop).
// Raw events are captured under logSessionId (per-fork isolation).
// Returns { inputTokens, outputTokens, cacheHits, cacheMisses }.
async function selfCallChat(body, res, ctx, opts = {}) {
  const { onChunk = null, logSessionId = null, fork = null, signal } = opts;
  if (ctx.RAW_CAPTURE) {
    ctx.logCall({
      _ts: new Date().toISOString(), event: 'raw_request', sessionId: logSessionId, fork,
      body_keys: Object.keys(body), model: body.model,
      tools_count: Array.isArray(body.tools) ? body.tools.length : null,
      stream: true, full_body: body,
    }, logSessionId);
  }
  // ── BOUNDARY: convert every failure into the SSE response contract — never
  // throw. An uncaught throw here crashed the whole proxy (2026-08-05: a
  // transient provider "fetch failed" made the CF path return 500 to the
  // self-call; selfCallChat threw; process died). `fail` writes the error into
  // the stream opencode is consuming and returns a zeroed result the caller
  // can log and move on from. The response contract is handled HERE, at the
  // edge where the failure becomes a response — not by a surrounding try.
  const fail = (msg) => {
    try {
      if (onChunk) {
        // fork mode: emit an error marker chunk; the caller marks it failed.
        onChunk({ choices: [{ delta: { content: `\n[${fork} self-call failed: ${String(msg).slice(0, 200)}]` } }] });
      } else {
        res.write(`data: ${JSON.stringify({ error: `[fj-proxy] ${String(msg).slice(0, 300)}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch {}
    return { inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0, failed: true };
  };

  let response;
  try {
    response = await fetch(`http://localhost:${ctx.PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    return fail(`self-call fetch failed: ${err?.message || err}`);
  }
  if (!response.ok) {
    const errText = await response.text();
    return fail(`self-call ${response.status}: ${errText.slice(0, 200)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawSSE = '';
  const usage = { input: 0, output: 0, hit: 0, miss: 0, reasoning: 0 };
  const accumulateUsage = (u) => {
    if (!u) return;
    usage.input = u.prompt_tokens ?? usage.input;
    usage.output = u.completion_tokens ?? usage.output;
    usage.hit = u.prompt_cache_hit_tokens ?? usage.hit;
    if (u.prompt_cache_miss_tokens != null) usage.miss = u.prompt_cache_miss_tokens;
    else if (u.prompt_cache_write_tokens != null) usage.miss = u.prompt_cache_write_tokens;
    else if (u.prompt_tokens != null) usage.miss = u.prompt_tokens - (u.prompt_cache_hit_tokens || 0);
    usage.reasoning = u.completion_tokens_details?.reasoning_tokens ?? usage.reasoning;
  };
  const parseChunks = (text, cb) => {
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          accumulateUsage(data.usage);
          if (cb) cb(data);
        } catch {}
      }
    }
  };
  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      return fail(`stream read failed: ${err?.message || err}`);
    }
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (ctx.RAW_CAPTURE) rawSSE += text;
    if (onChunk) {
      parseChunks(text, onChunk);
    } else {
      // verbatim byte passthrough (main turn) — still parse usage for metrics
      if (res.destroyed || res.writableEnded) break;
      try { res.write(text); } catch { break; }
      parseChunks(text);
    }
  }
  // Passthrough mode owns the stream end (the fork path's barrier does).
  if (!onChunk && !res.destroyed && !res.writableEnded) {
    try { res.end(); } catch {}
  }
  if (ctx.RAW_CAPTURE) {
    ctx.logCall({
      event: 'raw_response', status: 200, sessionId: logSessionId, fork,
      sse: rawSSE, sse_bytes: rawSSE.length,
      usage: { prompt: usage.input, completion: usage.output, cache_hit: usage.hit, cache_miss: usage.miss, reasoning_tokens: usage.reasoning },
      _ts: new Date().toISOString(),
    }, logSessionId);
  }
  return { inputTokens: usage.input, outputTokens: usage.output, cacheHits: usage.hit, cacheMisses: usage.miss, failed: false };
}

// ── The fj route handler (mounted by cf-proxy.mjs) ──
export async function handleFJ(req, res, ctx) {
  try {
    await handleFJInner(req, res, ctx);
  } catch (err) {
    // NEVER let an exception escape the fj route — an uncaught throw here
    // crashes the whole proxy (observed 2026-08-05: main-turn self-call hit a
    // provider "fetch failed" → CF path returned 500 → selfCallChat threw →
    // process.exit). Surface a clean SSE error to opencode instead.
    try {
      res.write(`data: ${JSON.stringify({ error: `[fj-proxy] ${err?.message || String(err)}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {}
    try {
      ctx.logCall({ event: 'fj_error', sessionId: ctx.sessionId, error: String(err?.message || err), _ts: new Date().toISOString() }, ctx.sessionId);
    } catch {}
  }
}

async function handleFJInner(req, res, ctx) {
  const {
    sessionId, session, messages, reqData, opencodeSP, personaSP, activeAgent,
    AGENTS, logCall, getSession, jsonResponse,
    PORT, TARGET_MODEL, RAW_CAPTURE,
  } = ctx;

  const preset = session?.presetSet || [];
  const fjPrompt = sessionId ? buildFJInstructions(sessionId, PORT) : null;

  // ── Main turn (no preset): standard single-agent turn via a CF self-call ──
  if (preset.length === 0) {
    // The FJ instructions ride the persona TAIL (directive) so the model knows
    // the agent-set endpoint exists before it triggers a fork. Pre-appended
    // here because the self-call sends NO sessionId (which disables CF-
    // instruction injection) and therefore carries no session-derived persona.
    console.error(`[fj-proxy] session ${sessionId} — main turn via CF self-call (FJ instructions on persona tail)`);
    const personaBody = personaSP ? `${personaSP}\n\n${fjPrompt}` : fjPrompt;
    const mainMessages = messages.map(m => ({ ...m, content: m.content }));
    const lastMsg = mainMessages[mainMessages.length - 1];
    if (lastMsg && personaBody && !String(lastMsg.content || '').includes(MARKERS.agentEnd)) {
      lastMsg.content = String(lastMsg.content || '') + buildPersonaSuffix(activeAgent || '', personaBody, null);
    }
    const { sessionId: _s, session_id: _s2, ...rest } = reqData;  // NEVER send a sessionId → no CF injection
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const body = { ...rest, model: 'cf', messages: mainMessages, stream: true };
    const result = await selfCallChat(body, res, ctx, { logSessionId: sessionId });
    logCall({
      event: 'fj_turn', agent: '(passthrough)', join_mode: session?.joinMode || 'concat',
      preset: [], turns: session?.turns ?? 0,
      note: result.failed ? 'main turn self-call FAILED (error SSE sent)' : 'no preset set — main turn via CF self-call',
      shared_chars: mainMessages[0]?.content?.length || 0,
      tokens: result.inputTokens, cached: result.cacheHits,
      savings_pct: result.inputTokens > 0 ? ((result.cacheHits / result.inputTokens) * 100).toFixed(1) : '0.0',
    }, sessionId);
    return;
  }

  // ── Fork round: one isolated sub-session + one CF self-call per agent ──
  const presetAgents = preset.map(name => resolveAgent(name, AGENTS)).filter(Boolean);
  if (presetAgents.length === 0) {
    return jsonResponse(res, 404, { error: 'preset agents no longer resolve in registry', preset });
  }

  // Fork construction: each fork gets its own sub-session (`<main>#fj-<uuid>`)
  // and the self-call now CARRIES that suffixed id — CF treats the fork as a
  // REAL isolated session: session_start + raw logs under subId, persona
  // resolved from sub.activeAgent, and the Task block embedded from
  // sub.pendingInput (the same handoff mechanism CF uses for persona switches,
  // which is what makes a new persona ACT instead of narrating).
  //
  // [fj:trim-trigger-tail] (2026-08-05) The fork's context is CUT at the
  // fork-trigger boundary: everything from the first tool message carrying the
  // preset response (`"presetSet"`) onward is the main agent's fork-MECHANISM
  // narration ("Fork registered…") — echoing that is what produced narration
  // instead of analysis. The persona+Task suffix then continues from the main
  // agent's real work. Cache-safe: the trimmed prefix is still a prefix of the
  // main session's turns.
  //
  // MEASURE THIS: because the self-call carries sessionId=subId, the CF path
  // injects CF instructions rendered with subId at position 0 — a different
  // position 0 per fork. Whether the cross-fork cache prefix survives is the
  // open measurement of this change.
  const forks = presetAgents.map(agent => {
    const uuid = randomUUID().slice(0, 8);
    const subId = sessionId ? `${sessionId}#fj-${uuid}` : `fj-${uuid}`;
    const sub = getSession(subId);
    sub.activeAgent = agent.name;   // CF resolves the fork persona from this
    // CRITICAL (2026-08-05, proxy-killer): seed the change-detection
    // bookkeeping on the fresh sub-session. resolveSessionPersona compares the
    // opencodeSP's detected agent against session.opencodeAgent; on a brand-new
    // sub-session opencodeAgent=null, so the MAIN agent's SP (e.g. backend)
    // registers as a manual change vs activeAgent=architect → corruptionCheck
    // HARD-FAILS with process.exit(1), killing the proxy for every session
    // (observed: ses_02f749b49...#fj-a172bb65: architect → backend, shutdown).
    // Recording the detected agent + SP makes opencodeChanged=false → the
    // persona resolves from activeAgent and the corruption path never fires.
    sub.opencodeAgent = resolveAgent(opencodeSP, AGENTS)?.name ?? null;
    sub.opencodeSP = opencodeSP || null;
    sub.pendingInput = `Provide your ${agent.name} specialist reading of the task in the shared context above — as the ${agent.name} perspective, directly.`;
    const triggerIdx = messages.findIndex(m => m.role === 'tool' && String(m.content || '').includes('"presetSet"'));
    let forkBase = triggerIdx !== -1 ? messages.slice(0, triggerIdx) : messages;
    // [fj:no-dangling-toolcalls] The trigger cut can leave a trailing
    // assistant message whose tool_calls have no following tool response —
    // DeepSeek rejects that with 400 ("An assistant message with 'tool_calls'
    // must be followed by tool messages responding to each 'tool_call_id'").
    // Drop trailing assistant tool-call messages so the fork base ends on a
    // complete turn (tool result / user text).
    while (forkBase.length > 0) {
      const last = forkBase[forkBase.length - 1];
      const tcs = last.tool_calls;
      if (last.role === 'assistant' && Array.isArray(tcs) && tcs.length > 0) {
        forkBase = forkBase.slice(0, -1);
      } else {
        break;
      }
    }
    return {
      subId,
      agent: agent.name,
      // The self-call CARRIES the suffixed sub-session id (real isolated
      // session: persona from activeAgent, Task from pendingInput, logs under
      // subId) AND disables CF-instruction injection so position 0 stays the
      // RAW opencode SP — byte-identical across forks → the cross-fork shared
      // cache prefix survives (measured: 70% with the disable, 0% without).
      body: { ...reqData, model: 'cf', sessionId: subId, cf_instructions: false, messages: forkBase, stream: true },
    };
  });

  // ── Execute: full parallel streaming with a single final stop barrier ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const forkResults = [];
  const streamedParts = [];   // accumulated content → session context
  const controllers = new Set();
  // ── Per-agent FIFO stream queues (2026-08-05) ──
  // Raw arrival-order interleaving of N concurrent fork streams garbles the
  // assembled output (fork A's chunk lands mid-sentence of fork B). Instead:
  //   - every fork's chunks are pushed to its OWN queue as they arrive
  //     (all queues load concurrently while the forks stream),
  //   - a single drainer streams ONE agent's queue incrementally — pulling
  //     chunks as they arrive — until that agent's stream is DONE, then moves
  //     to the NEXT agent's queue and drains it the same way.
  // The client sees each agent's response contiguous and coherent (streamed,
  // not burst), and the one-stop barrier fires after the last queue drains.
  const queues = forks.map(() => []);        // per-agent chunk queues (load while incoming)
  const doneFlags = forks.map(() => false);  // set when an agent's stream ends
  const queueWaiters = forks.map(() => []);  // drainer waiters per queue
  let barrierDone = false;
  res.on('close', () => { for (const ac of controllers) ac.abort(); });

  const writeChunk = (data) => {
    // Forward the provider chunk verbatim; ONLY finish_reason rewritten to
    // null (the barrier owns the single final 'stop').
    if (res.destroyed || res.writableEnded) return;
    try {
      const chunk = data.choices
        ? { ...data, choices: data.choices.map(c => ({ ...c, finish_reason: null })) }
        : data;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } catch {}
  };
  const pushChunk = (idx, data) => {
    queues[idx].push(data);
    const w = queueWaiters[idx];
    queueWaiters[idx] = [];
    for (const resolve of w) resolve();
  };
  const markDone = (idx) => {
    doneFlags[idx] = true;
    const w = queueWaiters[idx];
    queueWaiters[idx] = [];
    for (const resolve of w) resolve();
  };
  // Drain ONE agent's queue: keep pulling chunks as they arrive until the
  // agent's stream is done AND its queue is empty, then return (the caller
  // moves to the next agent).
  const drainQueue = async (idx) => {
    while (true) {
      if (queues[idx].length > 0) {
        writeChunk(queues[idx].shift());
        continue;
      }
      if (doneFlags[idx]) break;
      await new Promise((resolve) => queueWaiters[idx].push(resolve));
    }
  };
  const finishBarrier = () => {
    if (barrierDone) return;
    barrierDone = true;
    try {
      const totalIn = forkResults.reduce((s, f) => s + f.tokensIn, 0);
      const totalHit = forkResults.reduce((s, f) => s + f.cacheHit, 0);
      const totalOut = forkResults.reduce((s, f) => s + f.tokensOut, 0);
      res.write(`data: ${JSON.stringify({
        id: `fj-${Date.now()}`, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: TARGET_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: totalIn, completion_tokens: totalOut, prompt_cache_hit_tokens: totalHit },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {}
  };

  const runFork = async (fork, idx) => {
    const start = Date.now();
    const ac = new AbortController();
    controllers.add(ac);
    try {
      let fullText = '', fullReasoning = '';
      const toolCalls = [];
      const result = await selfCallChat(fork.body, res, ctx, {
        logSessionId: fork.subId, fork: fork.agent, signal: ac.signal,
        onChunk: (data) => {
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) { fullText += delta.content; streamedParts.push(delta.content); }
          if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              let cur = toolCalls.find(t => t.id === tc.id);
              if (!cur) { cur = { id: tc.id, name: '', args: '' }; toolCalls.push(cur); }
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
            }
          }
          pushChunk(idx, data);   // queue it — the drainer writes it in this agent's turn
        },
      });
      if (result.failed) {
        // The self-call boundary already queued the error marker; record the
        // fork as failed (zero tokens) so the metrics stay accurate.
        forkResults.push({
          index: idx, agent: fork.agent, warm: idx > 0, latencyMs: Date.now() - start,
          tokensIn: 0, cacheHit: 0, tokensOut: 0, output: '', reasoning: '', toolCalls: [],
        });
      } else {
        forkResults.push({
          index: idx, agent: fork.agent, warm: idx > 0, latencyMs: Date.now() - start,
          tokensIn: result.inputTokens, cacheHit: result.cacheHits, tokensOut: result.outputTokens,
          output: fullText, reasoning: fullReasoning, toolCalls,
        });
      }
    } catch (err) {
      const msg = (err?.message || String(err)).slice(0, 200);
      streamedParts.push(`\n[${fork.agent} fork failed: ${msg}]`);
      pushChunk(idx, {
        id: `fj-${idx}-err`, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: TARGET_MODEL,
        choices: [{ index: 0, delta: { content: `\n[${fork.agent} fork failed: ${msg}]` }, finish_reason: null }],
      });
      forkResults.push({
        index: idx, agent: fork.agent, warm: idx > 0, latencyMs: Date.now() - start,
        tokensIn: 0, cacheHit: 0, tokensOut: 0, output: '', reasoning: '', toolCalls: [],
      });
    } finally {
      controllers.delete(ac);
      markDone(idx);   // the drainer can now finish this agent and move on
    }
  };

  // ALL forks fire concurrently — the shared prefix is already provider-cached
  // from the session's prior turns, so there is no cold seed to wait for; wall
  // time = max(all forks). Their chunks land in the per-agent queues while the
  // drainer below streams them out, one agent at a time.
  forks.forEach((f, i) => {
    void runFork(f, i).catch((err) => {
      // runFork catches everything; this is a belt-and-suspenders guard so the
      // drain loop can never hang on a fork that died outside its try.
      console.error(`[fj-proxy] fork ${f.agent} runFork threw: ${err?.message || err}`);
      markDone(i);
    });
  });
  // Drain agent-by-agent in order: stream agent 0's queue until done, then
  // agent 1's, … then the single final stop.
  for (let i = 0; i < forks.length; i++) {
    await drainQueue(i);
  }
  finishBarrier();

  // ── Post-stream bookkeeping ──
  // The wire response already streamed (writeHead + barrier above). What
  // remains: the accumulated content for the session context — the next turn's
  // cache prefix. Internal bookkeeping, NOT a concat of the wire output.
  const joined = streamedParts.join('');
  if (session) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) session.context.push({ role: 'user', content: lastUser.content });
    session.context.push({ role: 'assistant', content: joined });
    session.turns++;
  }
  const totalIn = forkResults.reduce((s, f) => s + f.tokensIn, 0);
  const totalHit = forkResults.reduce((s, f) => s + f.cacheHit, 0);
  const totalOut = forkResults.reduce((s, f) => s + f.tokensOut, 0);
  logCall({
    event: 'fj_turn', agent: presetAgents.map(a => a.name).join(','),
    join_mode: session?.joinMode || 'concat', fork_count: forkResults.length, turns: session?.turns ?? 0,
    tokens: totalIn, cached: totalHit, cache_miss: totalIn - totalHit, output: totalOut,
    savings_pct: totalIn > 0 ? ((totalHit / totalIn) * 100).toFixed(1) : '0.0',
    tool_calls_merged: 0,   // dedup removed (2026-08-05 directive) — forks stream tool_calls raw
    tool_calls_raw: forkResults.reduce((n, f) => n + (f.toolCalls?.length || 0), 0),
    forks: forkResults.map(f => ({
      agent: f.agent, warm: f.warm, tokens_in: f.tokensIn,
      cache_hit: f.cacheHit, tokens_out: f.tokensOut, latency_ms: f.latencyMs,
      hit_ratio: f.tokensIn > 0 ? ((f.cacheHit / f.tokensIn) * 100).toFixed(1) : '0.0',
      tool_calls: f.toolCalls?.map(tc => tc.name) || [],
    })),
  }, sessionId);

  // ── AUTO-RESET (2026-08-05) — the fork is a ONE-SHOT trigger ──
  // After this fork runs, clear the preset so the session returns to standard
  // single-agent mode: an ALTERNATION (trigger → fork → back to normal), not a
  // sticky mode. Without this, every subsequent request (including opencode's
  // tool continuations of the SAME user message) forks forever.
  if (session) {
    const wasPreset = session.presetSet;
    session.presetSet = [];
    console.error(`[fj-proxy] session ${sessionId} — fork completed, preset auto-reset (was [${wasPreset.join(', ')}]) → standard mode`);
    logCall({
      event: 'fj_auto_reset', sessionId, turns: session.turns,
      cleared: wasPreset,
    }, sessionId);
  }
}
