#!/usr/bin/env node
/**
 * cf-replay-continue.mjs — v2: continue a replayed fork to its DECISION.
 *
 * Key fix over v1: pass the `tools` array so the model emits STRUCTURED
 * tool_calls (matching how the original sessions worked — the raw capture
 * shows API-form tool_calls, not text <invoke> blocks). Structured calls are
 * trivially parseable and continuable via {role:'tool', tool_call_id}.
 *
 * Loop per fork: send messages → model returns content + tool_calls →
 * execute read-only tools against the ORIGINAL cf-run worktree (write tools
 * are STUBBED — the SPEC write content itself is the decision artifact) →
 * append assistant + tool results → repeat until the fork's SPEC write is
 * classified (PATCH | TEMPLATE) or step cap.
 *
 * Fully resumable: every step appends one JSONL line {step, request, response,
 * tool_results, decision}. A later process resumes from the last line.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// READ - From Human: I moved the logs so that they can be more organized but have not confirmed they properly work still
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_NS = "cf-replay"
const LOG_BASE = path.join(__dirname, "logs", LOG_NS);

const WORKTREE = '/Users/nix/dev/sdlc-experiments/arm-cf/cf-run';
const API = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const KEY = process.env.DEEPSEEK_AUTH_TOKEN;
const MAX_STEPS = 4;
const MAX_TOKENS = 4000;

const TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command (read-only allowed)', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write', description: 'Write a file (SPEC content)', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, required: ['filePath', 'oldString', 'newString'] } } },
];

function loadFork(file)
{
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

function rebuildMessages(records)
{
  const base = JSON.parse(JSON.stringify(records[0].request));
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec.assistantContent || rec.response?.content || rec.response?.tool_calls) {
      const am = { role: 'assistant', content: rec.assistantContent || rec.response?.content || '' };
      if (rec.response?.tool_calls?.length) am.tool_calls = rec.response.tool_calls;
      base.push(am);
    }
    if (rec.toolResults?.length) {
      for (const tr of rec.toolResults) {
        base.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
      }
    }
  }
  return base;
}

function executeTool(name, args)
{
  if (name === 'read') {
    const p = args.filePath || '';
    if (!p.startsWith(WORKTREE)) return `[stub] read outside worktree: ${p}`;
    try { return fs.readFileSync(p, 'utf8').slice(0, 6000); }
    catch (e) { return `[error] ${e.message}`; }
  }
  if (name === 'grep') {
    try {
      const out = execSync(`rg -n --max-count 20 ${JSON.stringify(args.pattern)} ${JSON.stringify(args.path || WORKTREE)} 2>&1`, { encoding: 'utf8', timeout: 15000 });
      return out.slice(0, 4000);
    } catch (e) { return `[grep] ${(e.stdout || e.message || '').toString().slice(0, 2000)}`; }
  }
  if (name === 'glob') {
    try {
      const out = execSync(`find ${JSON.stringify(args.path || WORKTREE)} -name ${JSON.stringify(args.pattern || '*')} | head -40`, { encoding: 'utf8', timeout: 15000 });
      return out.slice(0, 3000);
    } catch (e) { return `[glob] ${e.message}`; }
  }
  if (name === 'bash') {
    const cmd = args.command || '';
    if (/write|edit|rm |mkdir|mv |cp |touch|cat >|tee |git (commit|add|checkout|restore)/.test(cmd)) {
      return `[stub] write-command not executed (read-only replay): ${cmd.slice(0, 150)}`;
    }
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, cwd: WORKTREE });
      return out.slice(0, 4000);
    } catch (e) {
      return `[bash exit ${e.status}] ${(e.stdout || '').slice(0, 2000)}${(e.stderr || '').slice(0, 500)}`;
    }
  }
  return `[stub] ${name} not executed in read-only replay`;
}

function classifyDecision(content)
{
  // The decision artifact is the SPEC write content.
  if (!content) return 'PENDING';
  const isSpec = /implementation spec|SPEC\.md|canonicalViteConfig|# Implementation/.test(content);
  const createsTemplate = /templates\.ts/.test(content);
  const canonical = /canonical (?:template|emission)|own(?:ing)? the emitted|own the template|Replace the fragile regex|overwrite.*vite\.config/i.test(content);
  const patch = /regex-patch|patch-and-drift|string-surgery|post-scaffold patches|patch (?:the|these|output|strings|shared\/generator)|keep.*patch|patchViteConfig|patchReleasePublish|patchProjectJson|patchPackageJson|patchEslintrc/i.test(content);
  if (createsTemplate || canonical) return 'TEMPLATE';
  if (patch) return 'PATCH';
  if (isSpec) return 'SPEC-NO-APPROACH';
  return 'PENDING';
}

async function callLLM(messages)
{
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, max_tokens: MAX_TOKENS, stream: false, reasoning_effort: 'none' }),
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
  };
}

async function continueFork(arm, variant, run = 1, opts = {})
{
  const logFile = path.join(LOG_BASE, `${arm}-${variant}-run${run}.jsonl`);
  let records = [];
  if (fs.existsSync(logFile)) records = loadFork(logFile);
  let messages = records.length ? rebuildMessages(records) : null;
  const maxSteps = opts.maxSteps || MAX_STEPS;
  let step = records.length || 1;

  while (step < records.length + maxSteps + 1) {
    if (!messages) {
      console.error(`[${arm}-${variant}] no initial request in log — run step 1 first`);
      return { decision: 'NO-BASE', step };
    }
    const resp = await callLLM(messages);
    const content = resp.content || '';
    const decision = classifyDecision(content);
    const record = {
      step, ts: new Date().toISOString(), arm, variant, run,
      decision, usage: resp.usage, finish_reason: resp.finish_reason,
      assistantContent: content, response: resp,
    };
    if (resp.tool_calls?.length) {
      record.toolResults = resp.tool_calls.map(tc => ({
        id: tc.id, name: tc.function?.name,
        args: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })(),
        content: executeTool(tc.function?.name, (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()),
      }));
    }
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
    records.push(record);

    const short = content.replace(/\s+/g, ' ').slice(0, 120);
    const tcs = (resp.tool_calls || []).map(t => t.function?.name).join(',');
    console.log(`[${arm}-${variant} step ${step}] decision=${decision} tools=[${tcs}] finish=${resp.finish_reason} | ${short}`);
    if (decision === 'TEMPLATE' || decision === 'PATCH' || decision === 'SPEC-NO-APPROACH' || decision === 'MIXED') {
      return { decision, step, logFile };
    }
    messages = rebuildMessages(records);
    step++;
  }
  return { decision: 'CAP', step, logFile };
}

export { classifyDecision, continueFork, executeTool, loadFork, rebuildMessages };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const arms = ['cf-pre', 'cf-fixed'];
  for (const arm of arms) {
    for (const variant of ['sp0', 'sptail']) {
      const res = await continueFork(arm, variant, 1);
      console.log(`→ ${arm}-${variant}: ${res.decision} at step ${res.step}`);
    }
  }
}
