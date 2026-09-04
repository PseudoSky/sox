#!/usr/bin/env node
/**
 * cf-replay-oneshot.mjs — v3: EXACT parameter parity with the original proxy request.
 *
 * The captured raw_request the proxy forwarded (verified from proxy-cf-log.jsonl):
 *   model: "cf"           → proxy rewrites to deepseek-v4-flash
 *   max_tokens: 32000
 *   messages              (no tools array, no reasoning_effort — reasoning ON,
 *                          which is where the architect decided)
 *   stream: true, stream_options: {include_usage: true}
 *
 * v1/v2 bugs (user-caught): I sent max_tokens:6000, a 6-tool `tools` array the
 * original lacked, and reasoning_effort:'none' — suppressing the reasoning
 * mechanism that produced the decision. That was a DIFFERENT experiment.
 *
 * v3: identical request shape; the ONLY variable is persona placement
 * (sp0 = persona appended to system at position 0; sptail = persona appended
 * to last user message). One call per fork, no tool execution, no continuation.
 */
import fs from 'node:fs';

// READ - From Human: I moved the logs so that they can be more organized but have not confirmed they properly work still
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_NS = "cf-replay"
const LOG_BASE = path.join(__dirname, "logs", LOG_NS);

const API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash'; // = proxy TARGET_MODEL
const KEY = process.env.DEEPSEEK_AUTH_TOKEN;
const MAX_TOKENS = 32000; // exact parity with the captured request

function classifyDecision(content)
{
  if (!content) return 'PENDING';
  const createsTemplate = /templates\.ts/.test(content);
  const canonical = /canonical (?:template|emission)|own(?:ing)? the emitted|own the template|switch.*own|Replace the fragile regex|overwrite.*vite\.config/i.test(content);
  const patch = /regex-patch|patch-and-drift|string-surgery|post-scaffold patches|patch (?:the|these|output|strings|shared\/generator)|keep.*patch|patchViteConfig|patchReleasePublish|patchProjectJson|patchPackageJson|patchEslintrc/i.test(content);
  if (createsTemplate || canonical) return 'TEMPLATE';
  if (patch) return 'PATCH';
  return 'PENDING';
}

async function oneshot(arm, variant)
{
  const firstLine = fs.readFileSync(`${LOG_BASE}/${arm}-${variant}-run1.jsonl`, 'utf8').split('\n')[0];
  const base = JSON.parse(firstLine);
  const messages = base.request;

  // EXACT parity: no tools, no reasoning_effort, max_tokens 32000
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      stream: false, // false for capture; content identical to streamed
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const content = msg?.content || '';
  const reasoning = msg?.reasoning_content || '';
  const decision = classifyDecision(content + '\n' + reasoning);
  const record = {
    ts: new Date().toISOString(), arm, variant,
    decision,
    finish_reason: data.choices?.[0]?.finish_reason,
    usage: data.usage || {},
    content,
    reasoning,
    tool_calls: msg?.tool_calls || null,
  };
  const logFile = `${LOG_BASE}/${arm}-${variant}-oneshot.jsonl`;
  fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
  return record;
}

export { classifyDecision, oneshot };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const arm of ['cf-pre', 'cf-fixed']) {
    for (const variant of ['sp0', 'sptail']) {
      try {
        const r = await oneshot(arm, variant);
        const tcs = (r.tool_calls || []).map(t => t.function?.name).join(',');
        console.log(`${arm}-${variant}: decision=${r.decision} finish=${r.finish_reason} tools=[${tcs}] in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens}`);
        console.log(`  content: ${r.content.replace(/\s+/g, ' ').slice(0, 350)}`);
        if (r.reasoning) console.log(`  reasoning: ${r.reasoning.replace(/\s+/g, ' ').slice(0, 250)}`);
        console.log('');
      } catch (e) {
        console.log(`${arm}-${variant} ERROR: ${e.message.slice(0, 250)}`);
      }
    }
  }
}
