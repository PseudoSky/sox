#!/usr/bin/env node
/**
 * cf-replay-decision.mjs — controlled SP-placement replay experiment.
 *
 * Question: at the architect's decision point, did SP *placement* (position 0
 * vs tail) change the decision (patch vs canonical-template), or was it the
 * evidence in context / sampling?
 *
 * Design: for each arm's exact decision context (messages as captured), create
 * two variants:
 *   - SP@0:   system prompt (persona) at position 0 — as captured
 *   - SP@tail: persona moved to the LAST user message (the v4 always-tail style)
 * Replay BOTH against deepseek-v4-flash and capture the FULL response so the
 * fork can be CONTINUED SEQUENTIALLY (append response as assistant message and
 * re-send) — i.e. the saved state per fork is a resumable conversation.
 *
 * Output per run (append-only JSONL, one line = one completed fork step):
 *   /tmp/cf-replay/<arm>-<variant>-<run>.jsonl
 * each line: {step, ts, model, prompt_tokens, completion_tokens, request:{...}, response:{...}}
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const KEY = process.env.DEEPSEEK_AUTH_TOKEN;

if (!KEY) { console.error('DEEPSEEK_AUTH_TOKEN not set'); process.exit(1); }

// READ - From Human: I moved the logs so that they can be more organized but have not confirmed they properly work still
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_NS = "cf-replay"
const LOG_BASE = path.join(__dirname, "logs", LOG_NS);

fs.mkdirSync(LOG_BASE, { recursive: true });

function loadCtx(file)
{
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return d.messages;
}

/**
 * Build the two variants from a captured message array.
 * The captured array has the persona in the SYSTEM message at index 0 (and
 * scattered suffix markers). For the tail variant we extract the persona block
 * from the system prompt and append it as a user message at the very end.
 */
function extractPersona(sysContent)
{
  // The v4 rewrite separates system + agent body. Find the architect body.
  // In the chain SP the persona is a self-contained block starting with the
  // agent name line. Use the known architect.md content as the canonical body.
  const arch = fs.readFileSync('/Users/nix/.config/opencode/agents/architect.md', 'utf8');
  // If the sys content embeds the architect persona, strip nothing — we'll
  // instead append the architect body verbatim at the tail and keep system as-is.
  return { sysContent, persona: arch };
}

function buildVariants(messages)
{
  const sys = messages[0];
  const sysContent = typeof sys.content === 'string'
    ? sys.content
    : (Array.isArray(sys.content) ? sys.content.map(x => x.text || '').join('') : String(sys.content));
  const { persona } = extractPersona(sysContent);
  // Preserve the EXACT message shape (role/content/tool_calls/tool_call_id).
  const rest = JSON.parse(JSON.stringify(messages.slice(1)));

  // Variant SP@0: exactly as captured (persona in system at position 0)
  const sp0 = [
    { role: 'system', content: sysContent },
    ...rest,
  ];

  // Variant SP@tail: keep system (shared anchor) but append persona to the last
  // USER message (v4 style). If last message isn't user, append a new user msg.
  const tailMsgs = JSON.parse(JSON.stringify(rest));
  let lastUserIdx = -1;
  for (let i = tailMsgs.length - 1; i >= 0; i--) {
    if (tailMsgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  const personaBlock = `\n\n--- Role: architect ---\n\n${persona}`;
  if (lastUserIdx >= 0) {
    const cur = typeof tailMsgs[lastUserIdx].content === 'string'
      ? tailMsgs[lastUserIdx].content
      : JSON.stringify(tailMsgs[lastUserIdx].content);
    tailMsgs[lastUserIdx] = { ...tailMsgs[lastUserIdx], content: cur + personaBlock };
  } else {
    tailMsgs.push({ role: 'user', content: personaBlock });
  }
  const spTail = [
    { role: 'system', content: sysContent },
    ...tailMsgs,
  ];

  return { sp0, spTail };
}

async function callLLM(messages, maxTokens = 3500)
{
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, stream: false, reasoning_effort: 'none' }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content || '',
    reasoning: msg?.reasoning_content || '',
    tool_calls: msg?.tool_calls || null,
    usage: data.usage || {},
    finish_reason: data.choices?.[0]?.finish_reason || '',
    raw: data,
  };
}

/**
 * Replay a fork: given messages, call the model, and persist the FULL exchange
 * (request + response) to the fork's JSONL so a later step can continue by
 * appending the assistant response and calling again.
 */
async function replayFork(arm, variant, run, messages, label, maxTokens = 1500)
{
  const logFile = path.join(LOG_BASE, `${arm}-${variant}-run${run}.jsonl`);
  const reqForLog = JSON.parse(JSON.stringify(messages));
  const resp = await callLLM(messages, 3500);
  const record = {
    step: 1,
    ts: new Date().toISOString(),
    model: MODEL,
    arm, variant, run, label,
    usage: resp.usage,
    finish_reason: resp.finish_reason,
    request: reqForLog,
    response: resp,
  };
  fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
  return { record, logFile };
}

export { buildVariants, callLLM, loadCtx, MODEL, OUT, replayFork };

// ── CLI: replay all 4 forks ────────────────────────────────────────────────
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const arms = [
    { name: 'cf-pre', ctx: '/tmp/cf-pre-decision-ctx.json', label: 'patch-decision' },
    { name: 'cf-fixed', ctx: '/tmp/cf-fixed-decision-ctx.json', label: 'template-decision' },
  ];
  const runs = 2; // 2 runs per arm/variant for sampling variance
  for (const arm of arms) {
    const messages = loadCtx(arm.ctx);
    const { sp0, spTail } = buildVariants(messages);
    console.log(`${arm.name}: ctx ${messages.length} msgs`);
    for (let run = 1; run <= runs; run++) {
      const r0 = await replayFork(arm.name, 'sp0', run, sp0, arm.label);
      console.log(`  sp0 run${run}: ${r0.record.usage.prompt_tokens} in / ${r0.record.usage.completion_tokens} out → ${r0.record.response.content.slice(0, 60).replace(/\n/g, ' ')}...`);
      const rT = await replayFork(arm.name, 'sptail', run, spTail, arm.label);
      console.log(`  sptail run${run}: ${rT.record.usage.prompt_tokens} in / ${rT.record.usage.completion_tokens} out → ${rT.record.response.content.slice(0, 60).replace(/\n/g, ' ')}...`);
    }
  }
  console.log(`\nLogs: ${LOG_BASE}/`);
}
