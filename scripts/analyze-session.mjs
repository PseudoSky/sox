#!/usr/bin/env node
/**
 * scripts/analyze-session.mjs — Claude Code session log profiler.
 *
 * Analyzes a session JSONL file (from ~/.claude/projects/<project>/<sessionId>.jsonl)
 * and reports on tool call frequency/size, thinking burn, subagent costs, file
 * hotspots, bash patterns, tool sequence patterns, mode churn, and rate limiting.
 *
 * Usage:
 *   node scripts/analyze-session.mjs <session-file.jsonl>
 *   node scripts/analyze-session.mjs <sessionId>
 *   node scripts/analyze-session.mjs <sessionId> --project path/to/project
 *   node scripts/analyze-session.mjs --list
 *   node scripts/analyze-session.mjs --help
 *
 * Output modes:
 *   --format json          Machine-readable JSON
 *   --format human         Human-readable tables (default)
 *
 * Examples:
 *   node scripts/analyze-session.mjs c31c63d7-95a9-4204-aaad-4941ef00172f
 *   node scripts/analyze-session.mjs ~/.claude/projects/.../file.jsonl --format json
 *   node scripts/analyze-session.mjs --list | node -e "JSON.parse(require('fs').readFileSync(0,'utf8')).filter(s=>s.agent!='unknown').forEach(s=>console.log(s.agent,s.sessionId))"
 */

// ──────────────────────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const { homedir } = os;

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const CLAUDE_DIR = path.join(homedir(), '.claude');

const TOOL_CATEGORIES = {
  'CORE (built-in)':  ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch', 'Skill'],
  'AGENT (dispatch)': ['Agent', 'task', 'SendMessage', 'AskUserQuestion', 'Artifact', 'TaskCreate', 'TaskUpdate'],
  'MEMORY (MCP)':     ['mcp__memory-server__memory_recall', 'mcp__memory-server__memory_write',
                        'mcp__memory-server__memory_search_entities', 'mcp__memory-server__memory_related',
                        'mcp__memory-server__memory_topics', 'mcp__memory-server__memory_curate',
                        'mcp__memory-server__memory_stats', 'mcp__memory-server__memory_ping'],
  'WEB (research)':   ['WebSearch', 'WebFetch'],
};

function categorizeTool(name) {
  for (const [cat, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (tools.includes(name)) return cat;
  }
  // MCP catch-all: anything prefixed with mcp__
  if (name.startsWith('mcp__')) return 'MCP (other)';
  return 'OTHER';
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function fmtBytes(b) {
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtPct(n, total) {
  if (!total) return '0%';
  return `${(n / total * 100).toFixed(1)}%`;
}

function trunc(s, n = 120) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  if (str.length <= n) return str;
  return str.substring(0, n) + '…';
}

function estTokens(bytes) {
  return Math.round(bytes / 3.5);
}

// ──────────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────────

function parseSession(lines) {
  const stats = {
    totalLines: lines.length,
    messageTypes: {},
    assistantCount: 0,
    userCount: 0,
    realUserCount: 0,
    toolResultFeedbacks: 0,
    metaCount: 0,
    thinkingCount: 0,
    queueOperations: {},
    modeChanges: 0,
    lastPromptCount: 0,
    attachmentCount: 0,
    fileHistoryCount: 0,
  };

  // Tool counters
  const toolNames = {};
  const toolInputSizes = {};
  const toolResultSizes = {};          // tool name → number[] (output sizes, resolved via toolUseMap)
  const toolResultDetails = {};        // tool name → {command/file, outputSize, outputLines}[]
  const toolTotalsByCategory = {};
  const filesRead = {};
  const filesEdited = {};
  const filesWritten = {};
  const bashCommands = {};
  const bashOutputDetails = [];        // {command, outputSize, outputLines, normalized}
  const readOutputDetails = [];        // {filePath, outputSize, outputLines}
  const largestResults = [];           // top N across all tools
  const agentDispatches = [];
  const askUserQuestions = [];
  const sendMessages = [];
  const thinkingBlocks = [];
  const assistantTurnSizes = [];
  const userTimeline = [];
  let totalAssistantTextSize = 0;
  const textOnlySizes = [];

  // Map tool_use_id → {name, input} to resolve tool results back to their originating tool
  const toolUseMap = new Map();

  // Tool result storage tracking
  let toolResultContentSize = 0;     // from message[].content tool_result blocks
  let toolUseResultSize = 0;        // from entry.toolUseResult
  let toolResultContentCount = 0;
  let toolUseResultCount = 0;
  let toolResultOverlapCount = 0;   // entries with BOTH

  // Sequence tracking
  const turnSequences = [];
  let pendingSequence = [];
  let inUserTurn = false;

  // Thinking-flow tracking
  const messageFlow = [];

  lines.forEach((rawLine) => {
    if (!rawLine.trim()) return;
    let entry;
    try { entry = JSON.parse(rawLine); } catch { return; }

    const t = entry.type || 'unknown';
    stats.messageTypes[t] = (stats.messageTypes[t] || 0) + 1;

    if (t === 'queue-operation') {
      const op = entry.subtype || entry.operation || entry.status || 'unknown';
      stats.queueOperations[op] = (stats.queueOperations[op] || 0) + 1;
    }
    if (t === 'mode') stats.modeChanges++;
    if (t === 'attachment') stats.attachmentCount++;
    if (t === 'last-prompt') stats.lastPromptCount++;
    if (t === 'file-history-snapshot' || t === 'file-history-delta') stats.fileHistoryCount++;

    // ── User entries ────────────────────────────────────────────────────
    if (t === 'user') {
      stats.userCount++;
      const msg = entry.message?.content;
      const isMeta = entry.isMeta === true;

      if (isMeta) { stats.metaCount++; return; }

      // Classify
      const isSystemCmd = typeof msg === 'string' &&
        (msg.includes('<command-name>') || msg.includes('<local-command') || msg.trim() === '' || msg.trim() === '/clear');
      const isToolResult = Array.isArray(msg) && msg.some(b => b?.type === 'tool_result');

      if (isSystemCmd) {
        stats.metaCount++;
      } else if (isToolResult) {
        stats.toolResultFeedbacks++;

        // Track tool_result content blocks
        msg.forEach(b => {
          if (b?.type === 'tool_result') {
            const resultContent = b.content || b.output || '';
            const resultSize = resultContent.length;
            toolResultContentSize += resultSize;
            toolResultContentCount++;

            // Resolve the tool name via toolUseMap
            const mapped = toolUseMap.get(b.tool_use_id);
            const toolName = mapped?.name || 'unknown';
            const toolInput = mapped?.input || {};

            // Track by resolved tool name
            if (!toolResultSizes[toolName]) toolResultSizes[toolName] = [];
            toolResultSizes[toolName].push(resultSize);

            // Track largest results across all tools
            if (resultSize > 1000) {
              largestResults.push({
                tool: toolName,
                size: resultSize,
                lines: resultContent.split('\n').length,
                cmd: toolName === 'Bash' ? (toolInput.command || '').substring(0, 120) : '',
                file: (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write')
                  ? (toolInput.file_path || toolInput.filePath || '') : '',
                isError: !!b.is_error,
              });
            }

            // Bash-specific detail tracking
            if (toolName === 'Bash') {
              const cmd = toolInput.command || '';
              // Normalize: extract key operation
              let normalized = cmd;
              if (cmd.includes('nx build')) normalized = 'nx build';
              else if (cmd.includes('nx test') || cmd.includes('nx run-many -t test')) normalized = 'nx test';
              else if (cmd.includes('vitest') || cmd.includes('jest')) normalized = 'test runner';
              else if (cmd.includes('git commit')) normalized = 'git commit';
              else if (cmd.includes('git add')) normalized = 'git add';
              else if (cmd.includes('git push')) normalized = 'git push';
              else if (cmd.includes('git log') || cmd.includes('git diff') || cmd.includes('git status')) normalized = 'git status/log/diff';
              else if (cmd.includes('grep') || cmd.includes('rg ')) normalized = 'grep/rg search';
              else if (cmd.includes('find ')) normalized = 'find';
              else if (cmd.includes('ls ')) normalized = 'ls';
              else if (cmd.includes('cat ')) normalized = 'cat';
              else if (cmd.includes('head ')) normalized = 'head';
              else if (cmd.includes('tail ')) normalized = 'tail';
              else if (cmd.includes('python3') || cmd.includes('python -')) normalized = 'python script';
              else if (cmd.includes('node ')) normalized = 'node script';
              else if (cmd.includes('npx ')) normalized = 'npx';
              else if (cmd.includes('sed ')) normalized = 'sed';
              else if (cmd.includes('echo ')) normalized = 'echo';
              else if (cmd.includes('mkdir') || cmd.includes('rm ') || cmd.includes('cp ') || cmd.includes('mv ')) normalized = 'file ops';
              else if (cmd.includes('npm ')) normalized = 'npm';

              bashOutputDetails.push({
                command: cmd.substring(0, 200),
                normalized,
                outputSize: resultSize,
                outputLines: resultContent.split('\n').length,
              });
            }

            // Read-specific detail tracking
            if (toolName === 'Read') {
              const fp = toolInput.file_path || toolInput.filePath || '(unknown)';
              readOutputDetails.push({
                filePath: fp,
                outputSize: resultSize,
                outputLines: resultContent.split('\n').length,
              });
            }
          }
        });

        // Track entry-level toolUseResult
        if (entry.toolUseResult) {
          const rStr = typeof entry.toolUseResult === 'string'
            ? entry.toolUseResult
            : JSON.stringify(entry.toolUseResult);
          toolUseResultSize += rStr.length;
          toolUseResultCount++;
          toolResultOverlapCount++;
        }
      } else if (typeof msg === 'string' && !msg.startsWith('[')) {
        stats.realUserCount++;
        userTimeline.push({ timestamp: entry.timestamp || entry.updatedAt, content: trunc(msg, 180) });

        // Flush previous turn sequence
        if (pendingSequence.length > 0 || inUserTurn) {
          turnSequences.push(pendingSequence);
        }
        pendingSequence = [];
        inUserTurn = true;
      }
    }

    // ── Assistant entries ─────────────────────────────────────────────
    if (t === 'assistant') {
      stats.assistantCount++;
      const content = entry.message?.content;
      if (!Array.isArray(content)) return;

      let turnSize = 0;
      let hasThinking = false;
      let hasTools = false;
      let hasText = false;
      const turnTools = [];

      content.forEach(block => {
        const blkStr = JSON.stringify(block);
        turnSize += blkStr.length;

        if (block.type === 'tool_use') {
          hasTools = true;
          const name = block.name || 'unknown';
          const input = block.input || {};
          const inputSize = JSON.stringify(input).length;

          // Map this tool_use_id so we can attribute results back
          if (block.id) toolUseMap.set(block.id, { name, input });

          toolNames[name] = (toolNames[name] || 0) + 1;
          if (!toolInputSizes[name]) toolInputSizes[name] = [];
          toolInputSizes[name].push(inputSize);
          turnTools.push(name);

          // Track by category
          const cat = categorizeTool(name);
          if (!toolTotalsByCategory[cat]) toolTotalsByCategory[cat] = { count: 0, inputSize: 0 };
          toolTotalsByCategory[cat].count++;
          toolTotalsByCategory[cat].inputSize += inputSize;

          // File operations
          const fp = input.file_path || input.filePath || '';
          if (name === 'Read' && fp) filesRead[fp] = (filesRead[fp] || 0) + 1;
          else if (name === 'Edit' && fp) filesEdited[fp] = (filesEdited[fp] || 0) + 1;
          else if (name === 'Write' && fp) filesWritten[fp] = (filesWritten[fp] || 0) + 1;

          // Bash commands
          if (name === 'Bash' && input.command) {
            bashCommands[input.command.substring(0, 200)] = (bashCommands[input.command.substring(0, 200)] || 0) + 1;
          }

          // Agent dispatches
          if (name === 'Agent' || name === 'task') {
            agentDispatches.push({
              type: input.subagent_type || input.name || 'unknown',
              prompt: trunc(input.prompt || input.description || '', 300),
              size: inputSize,
              id: block.id,
            });
          }

          // AskUserQuestion
          if (name === 'AskUserQuestion') {
            askUserQuestions.push({ question: trunc(input.question || input.message || '', 300), size: inputSize });
          }

          // SendMessage
          if (name === 'SendMessage') {
            sendMessages.push({ message: trunc(input.message || '', 200), size: inputSize });
          }
        } else if (block.type === 'tool_result') {
          // tool_result blocks may appear inside assistant messages (thinking format).
          // They have tool_use_id, not name. Resolve via toolUseMap if available.
          const resultSize = (block.content || block.output || '').length;
          const mapped = toolUseMap.get(block.tool_use_id);
          const toolName = mapped?.name || block.name || 'unknown';
          if (!toolResultSizes[toolName]) toolResultSizes[toolName] = [];
          toolResultSizes[toolName].push(resultSize);
        } else if (block.type === 'thinking') {
          hasThinking = true;
          stats.thinkingCount++;
          const hasSig = !!block.signature && block.signature.length > 0;
          thinkingBlocks.push({
            size: (block.thinking || block.content || '').length,
            encrypted: hasSig,
            signatureLen: hasSig ? block.signature.length : 0,
          });
        } else if (block.type === 'text') {
          hasText = true;
          totalAssistantTextSize += (block.text || '').length;
        }
      });

      // Update message flow
      if (hasThinking && !hasTools) messageFlow.push('thinking');
      else if (hasTools && !hasThinking) messageFlow.push('tools');
      else if (hasThinking && hasTools) messageFlow.push('think+tools');
      else if (hasText && !hasThinking && !hasTools) {
        textOnlySizes.push(turnSize);
        messageFlow.push('text');
      }

      // Accumulate tools into current user turn
      if (turnTools.length > 0) {
        pendingSequence.push(...turnTools);
        inUserTurn = true;
      }

      assistantTurnSizes.push(turnSize);
    }
  });

  // Flush last turn
  if (pendingSequence.length > 0) turnSequences.push(pendingSequence);
  // Flush last thinking flow entry if incomplete
  messageFlow.push('END');

  // ────────────────────────────────────────────────────────────────────
  // Derived metrics
  // ────────────────────────────────────────────────────────────────────

  const toolCallCount = Object.values(toolNames).reduce((a, b) => a + b, 0);

  // Tool summary by name
  const toolSummary = Object.entries(toolInputSizes)
    .map(([name, sizes]) => ({
      name,
      category: categorizeTool(name),
      count: sizes.length,
      totalSize: sizes.reduce((a, b) => a + b, 0),
      avgSize: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      maxSize: Math.max(...sizes),
      pctOfCalls: fmtPct(sizes.length, toolCallCount),
    }))
    .sort((a, b) => b.totalSize - a.totalSize);

  // Summary by category
  const categorySummary = Object.entries(toolTotalsByCategory)
    .map(([cat, data]) => ({
      category: cat,
      count: data.count,
      inputSize: data.inputSize,
      avgInputSize: Math.round(data.inputSize / data.count),
      pctOfCalls: fmtPct(data.count, toolCallCount),
    }))
    .sort((a, b) => b.count - a.count);

  // Tool result summary
  const toolResultSummary = Object.entries(toolResultSizes)
    .map(([name, sizes]) => ({
      name,
      count: sizes.length,
      totalSize: sizes.reduce((a, b) => a + b, 0),
      avgSize: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      maxSize: Math.max(...sizes),
    }))
    .sort((a, b) => b.totalSize - a.totalSize);

  // Tool result storage analysis
  const toolResultStorage = {
    contentBlockSize: toolResultContentSize,
    contentBlockCount: toolResultContentCount,
    toolUseResultSize: toolUseResultSize,
    toolUseResultCount: toolUseResultCount,
    overlapCount: toolResultOverlapCount,
    overlapPct: toolUseResultCount > 0 ? fmtPct(toolResultOverlapCount, toolUseResultCount) : '0%',
    duplicationWaste: toolUseResultCount > 0 && toolResultContentCount > 0
      ? Math.min(toolUseResultSize, toolResultContentSize)
      : 0,
  };

  // Thinking
  const thinkingSorted = [...thinkingBlocks].sort((a, b) => b.size - a.size);
  const thinkingTotal = thinkingBlocks.reduce((a, b) => a + b.size, 0);
  const thinkingEncrypted = thinkingBlocks.filter(s => s.encrypted).length;
  const thinkingSigTotal = thinkingBlocks.reduce((a, b) => a + b.signatureLen, 0);
  const thinkingCatCounts = {};
  thinkingBlocks.forEach(b => {
    const cat = b.encrypted ? 'encrypted' : 'plaintext';
    thinkingCatCounts[cat] = (thinkingCatCounts[cat] || 0) + 1;
  });

  // Thinking position flow
  const thinkThenTool = messageFlow.filter((v, i) => v === 'thinking' && messageFlow[i + 1] === 'tools').length;
  const toolThenThink = messageFlow.filter((v, i) => v === 'tools' && messageFlow[i + 1] === 'thinking').length;
  const thinkOnly = messageFlow.filter(v => v === 'thinking').length;
  const toolOnly = messageFlow.filter(v => v === 'tools').length;

  // Turn sequences → sequence patterns
  const seqPatterns = {};
  turnSequences.forEach(seq => {
    if (seq.length === 0) return;
    const cats = {};
    seq.forEach(t => {
      const c = categorizeTool(t);
      cats[c] = (cats[c] || 0) + 1;
    });
    const summary = Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c.replace(/ \(.*/, '')}×${n}`)
      .join(' + ');
    seqPatterns[summary] = (seqPatterns[summary] || 0) + 1;
  });

  // Tool count per user turn
  const turnToolCounts = turnSequences.map(s => s.length);
  const toolCountHist = {};
  turnToolCounts.forEach(c => { toolCountHist[c] = (toolCountHist[c] || 0) + 1; });

  const turnSorted = [...assistantTurnSizes].sort((a, b) => b - a);

  const mostRead = Object.entries(filesRead).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const mostEdited = Object.entries(filesEdited).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const mostWritten = Object.entries(filesWritten).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topBash = Object.entries(bashCommands).sort((a, b) => b[1] - a[1]).slice(0, 25);

  // Context consumption estimates
  const context = {
    toolInput: toolSummary.reduce((a, t) => a + t.totalSize, 0),
    toolResult: toolResultContentSize,
    thinking: thinkingTotal,
    thinkingSignature: thinkingSigTotal,
    assistantText: assistantTurnSizes.reduce((a, t) => a + t, 0) -
      toolSummary.reduce((a, t) => a + t.totalSize, 0),
    userText: userTimeline.reduce((a, t) => a + t.content.length, 0),
  };
  // Recalculate assistant text more carefully
  const totalAssistantContent = assistantTurnSizes.reduce((a, t) => a + t, 0);
  const toolAndThinking = toolSummary.reduce((a, t) => a + t.totalSize, 0) +
    thinkingBlocks.reduce((a, b) => a + b.size + b.signatureLen, 0);
  context.assistantText = Math.max(0, totalAssistantContent - toolAndThinking);

  const contextTotal = Object.values(context).reduce((a, b) => a + b, 0);

  // ── Bash output by normalized command ──────────────────────────────────
  const bashByCommand = {};
  bashOutputDetails.forEach(d => {
    const key = d.normalized;
    if (!bashByCommand[key]) bashByCommand[key] = { count: 0, totalOutput: 0, maxOutput: 0, instances: [] };
    bashByCommand[key].count++;
    bashByCommand[key].totalOutput += d.outputSize;
    if (d.outputSize > bashByCommand[key].maxOutput) bashByCommand[key].maxOutput = d.outputSize;
    bashByCommand[key].instances.push(d);
  });
  const bashOutputSummary = Object.entries(bashByCommand)
    .map(([cmd, data]) => ({
      command: cmd,
      count: data.count,
      totalOutput: data.totalOutput,
      avgOutput: Math.round(data.totalOutput / data.count),
      maxOutput: data.maxOutput,
    }))
    .sort((a, b) => b.totalOutput - a.totalOutput);

  // ── Read output by file ────────────────────────────────────────────────
  const readByFile = {};
  readOutputDetails.forEach(d => {
    const key = d.filePath.replace(os.homedir(), '~');
    if (!readByFile[key]) readByFile[key] = { count: 0, totalOutput: 0, maxOutput: 0, totalLines: 0 };
    readByFile[key].count++;
    readByFile[key].totalOutput += d.outputSize;
    if (d.outputSize > readByFile[key].maxOutput) readByFile[key].maxOutput = d.outputSize;
    readByFile[key].totalLines += d.outputLines;
  });
  const readOutputSummary = Object.entries(readByFile)
    .map(([file, data]) => ({
      file,
      count: data.count,
      totalOutput: data.totalOutput,
      avgOutput: Math.round(data.totalOutput / data.count),
      maxOutput: data.maxOutput,
    }))
    .sort((a, b) => b.totalOutput - a.totalOutput);

  // ── Top N most expensive single operations ────────────────────────────
  const topOperations = largestResults
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);

  // ── Threshold analysis ────────────────────────────────────────────────
  const allSizes = bashOutputDetails.map(d => d.outputSize)
    .concat(readOutputDetails.map(d => d.outputSize))
    .concat(Object.values(toolResultSizes).flat());
  const totalToolOutputBytes = allSizes.reduce((a, b) => a + b, 0) || 0;
  const thresholds = [1024, 8192, 51200, 102400];
  const thresholdAnalysis = thresholds.map(t => ({
    threshold: t,
    thresholdLabel: fmtBytes(t),
    count: allSizes.filter(s => s > t).length,
    totalBytes: allSizes.filter(s => s > t).reduce((a, b) => a + b, 0),
    pctOfAll: fmtPct(allSizes.filter(s => s > t).length, allSizes.length),
  }));

  // ── Output cost by tool (resolved via toolUseMap, not block.name) ──────
  const outputByTool = Object.entries(toolResultSizes)
    .map(([name, sizes]) => ({
      name,
      category: categorizeTool(name),
      count: sizes.length,
      totalSize: sizes.reduce((a, b) => a + b, 0),
      avgSize: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      maxSize: Math.max(...sizes),
    }))
    .sort((a, b) => b.totalSize - a.totalSize);

  return {
    stats,
    toolSummary,
    categorySummary,
    toolResultSummary: outputByTool,  // was toolResultSummary — now properly resolved
    toolResultStorage,
    thinkingSummary: {
      count: stats.thinkingCount,
      encrypted: thinkingEncrypted,
      plaintext: stats.thinkingCount - thinkingEncrypted,
      totalSigBytes: thinkingSigTotal,
      totalContentBytes: thinkingTotal,
      avgContentBytes: thinkingBlocks.length ? Math.round(thinkingTotal / thinkingBlocks.length) : 0,
      avgSigBytes: thinkingBlocks.length ? Math.round(thinkingSigTotal / thinkingBlocks.length) : 0,
      maxContentBytes: thinkingSorted[0]?.size || 0,
      maxSigBytes: Math.max(...thinkingBlocks.map(b => b.signatureLen)),
      catCounts: thinkingCatCounts,
    },
    thinkingFlow: { thinkThenTool, toolThenThink, thinkOnly, toolOnly },
    turnSorted,
    turnToolCounts,
    toolCountHist,
    seqPatterns: Object.entries(seqPatterns).sort((a, b) => b[1] - a[1]),
    mostRead,
    mostEdited,
    mostWritten,
    topBash,
    agentDispatches,
    askUserQuestions,
    sendMessages,
    userTimeline,
    context,
    contextTotal,
    bashOutputSummary,
    readOutputSummary,
    topOperations,
    thresholdAnalysis,
    outputByTool,
    subagents: [],
    meta: {},
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Subagent discovery
// ──────────────────────────────────────────────────────────────────────────────

function discoverSubagents(sessionDir) {
  const subDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subDir)) return [];

  const agents = fs.readdirSync(subDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const metaFile = f.replace('.jsonl', '.meta.json');
      const metaPath = path.join(subDir, metaFile);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}

      const fp = path.join(subDir, f);
      const stat = fs.statSync(fp);
      const content = fs.readFileSync(fp, 'utf-8');
      const lineCount = content.split('\n').filter(Boolean).length;

      return {
        id: f.replace('.jsonl', ''),
        name: meta.name || '(unnamed)',
        agentType: meta.agentType || meta.subagent_type || null,
        model: meta.model || null,
        size: stat.size,
        sizeHuman: fmtBytes(stat.size),
        lines: lineCount,
      };
    })
    .sort((a, b) => b.size - a.size);

  return agents;
}

// ──────────────────────────────────────────────────────────────────────────────
// Subagent tool usage aggregation
// ──────────────────────────────────────────────────────────────────────────────

function aggregateSubagentTools(sessionDir) {
  const subDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subDir)) return null;

  const files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
  const toolCounts = {};
  const toolInputSizes = {};
  let totalCalls = 0;
  let totalSize = 0;

  files.forEach(f => {
    try {
      const content = fs.readFileSync(path.join(subDir, f), 'utf-8');
      content.split('\n').filter(Boolean).forEach(line => {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
            entry.message.content.forEach(block => {
              if (block.type === 'tool_use') {
                const name = block.name;
                const size = JSON.stringify(block.input || '').length;
                toolCounts[name] = (toolCounts[name] || 0) + 1;
                toolInputSizes[name] = (toolInputSizes[name] || 0) + size;
                totalCalls++;
                totalSize += size;
              }
            });
          }
        } catch {}
      });
    } catch {}
  });

  return {
    toolCounts,
    toolInputSizes,
    toolsUsed: Object.keys(toolCounts).length,
    totalCalls,
    totalSize,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Session metadata helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildSessionMetaIndex() {
  const metaIndex = new Map();
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return metaIndex;
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
      if (meta.sessionId) metaIndex.set(meta.sessionId, meta);
    } catch {}
  }
  return metaIndex;
}

const _metaIndex = buildSessionMetaIndex();

function loadSessionMeta(sessionId) {
  return _metaIndex.get(sessionId) ?? null;
}

function listSessions() {
  const sessions = [];
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return sessions;

  fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .forEach(dir => {
      const dirPath = path.join(projectsDir, dir.name);
      fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')).forEach(f => {
        const sessionId = f.replace('.jsonl', '');
        const fp = path.join(dirPath, f);
        const stat = fs.statSync(fp);
        const meta = loadSessionMeta(sessionId);
        sessions.push({
          sessionId,
          project: dir.name.replace(/^-/, '').replace(/--/g, '/'),
          agent: meta?.agent || 'unknown',
          file: fp,
          size: stat.size,
          sizeHuman: fmtBytes(stat.size),
          startedAt: meta?.startedAt ? new Date(meta.startedAt).toISOString() : null,
          status: meta?.status || 'unknown',
        });
      });
    });

  sessions.sort((a, b) => (b.startedAt || '') > (a.startedAt || '') ? 1 : -1);
  return sessions;
}

function resolveSessionPath(sessionId, projectHint) {
  if (fs.existsSync(sessionId) && sessionId.endsWith('.jsonl')) {
    return { filePath: path.resolve(sessionId), sessionDir: null };
  }

  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const projectDirs = projectHint
    ? [fs.readdirSync(projectsDir).find(d => d.includes(projectHint.replace(/\//g, '-')))].filter(Boolean)
    : fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

  for (const dir of projectDirs) {
    const fp = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(fp)) {
      const sessionDir = path.join(projectsDir, dir, sessionId);
      return { filePath: fp, sessionDir: fs.existsSync(sessionDir) ? sessionDir : null };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Human output formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatHuman(result) {
  const {
    stats, toolSummary, categorySummary, toolResultStorage,
    thinkingSummary, thinkingFlow,
    turnSorted, toolCountHist, seqPatterns,
    mostEdited, mostWritten, topBash,
    agentDispatches, askUserQuestions,
    userTimeline, subagents, meta, context, contextTotal, fileSize, filePath,
    bashOutputSummary, readOutputSummary, topOperations, thresholdAnalysis, outputByTool,
  } = result;

  const output = [];
  const sep = '─'.repeat(72);

  const h = (title) => {
    output.push(`┌─ ${title}${'─'.repeat(Math.max(0, 64 - title.length))}┐`);
  };

  output.push('');
  output.push('╔' + sep + '╗');
  output.push('║  Claude Code Session Analysis');
  output.push('╚' + sep + '╝');
  output.push('');

  if (meta) {
    output.push(`  Session:    ${meta.sessionId || '?'}`);
    output.push(`  Agent:      ${meta.agent || '?'}`);
    output.push(`  File:       ${filePath ? (filePath.replace(homedir(), '~')) : '?'}`);
    output.push(`  Size:       ${fileSize ? fmtBytes(fileSize) : '?'}`);
    output.push(`  Started:    ${meta.startedAt ? new Date(meta.startedAt).toISOString() : '?'}`);
    output.push(`  Status:     ${meta.status || '?'}`);
    output.push('');
  }

  // ── Message Overview ──────────────────────────────────────────────────
  h('MESSAGE OVERVIEW');
  output.push(`  Total lines:       ${stats.totalLines}`);
  output.push(`  Assistant msgs:    ${stats.assistantCount}`);
  output.push(`  User entries:      ${stats.userCount}`);
  output.push(`  ├─ Real user:      ${stats.realUserCount}`);
  output.push(`  ├─ Tool feedback:  ${stats.toolResultFeedbacks}`);
  output.push(`  └─ System/meta:    ${stats.metaCount}`);
  output.push(`  Mode changes:      ${stats.modeChanges}`);
  output.push(`  Queue operations:  ${Object.values(stats.queueOperations).reduce((a, b) => a + b, 0)}`);
  output.push('');

  // ── Tool Calls by Category ────────────────────────────────────────────
  const totalToolCalls = toolSummary.reduce((a, t) => a + t.count, 0);
  h('TOOL CALLS BY CATEGORY');
  output.push(`  Total tool calls: ${totalToolCalls} across ${toolSummary.length} tool types`);
  output.push('');
  for (const cat of categorySummary) {
    output.push(`  ${cat.category.padEnd(20)} ${String(cat.count).padStart(5)} calls  ${fmtBytes(cat.inputSize).padStart(9)} input  ${cat.pctOfCalls.padStart(6)}`);
  }
  output.push('');

  // ── Tool Calls Detail ─────────────────────────────────────────────────
  h('TOOL CALLS BY NAME (sorted by total input size)');
  output.push(`  ${'Tool'.padEnd(30)} ${'Count'.padStart(5)} ${'Avg'.padStart(8)} ${'Max'.padStart(8)} ${'Total'.padStart(9)} ${'%'.padStart(5)}`);
  output.push(`  ${''.padEnd(30, '─')} ${''.padStart(5, '─')} ${''.padStart(8, '─')} ${''.padStart(8, '─')} ${''.padStart(9, '─')} ${''.padStart(5, '─')}`);
  for (const t of toolSummary) {
    output.push(`  ${t.name.padEnd(30)} ${String(t.count).padStart(5)} ${fmtBytes(t.avgSize).padStart(8)} ${fmtBytes(t.maxSize).padStart(8)} ${fmtBytes(t.totalSize).padStart(9)} ${t.pctOfCalls.padStart(5)}`);
  }
  output.push('');

  // ── Tool Result Storage ───────────────────────────────────────────────
  if (toolResultStorage.toolUseResultCount > 0) {
    h('TOOL RESULT STORAGE');
    output.push(`  Content blocks (message[].content tool_result):`);
    output.push(`    ${fmtBytes(toolResultStorage.contentBlockSize).padStart(8)} across ${toolResultStorage.contentBlockCount} entries — what the model sees`);
    output.push(`  Entry-level (entry.toolUseResult field):`);
    output.push(`    ${fmtBytes(toolResultStorage.toolUseResultSize).padStart(8)} across ${toolResultStorage.toolUseResultCount} entries — execution metadata`);
    output.push(`  Overlap (same entry has both):  ${toolResultStorage.overlapCount} (${toolResultStorage.overlapPct})`);
    if (toolResultStorage.duplicationWaste > 0) {
      output.push(`  Content dupe estimate:           ${fmtBytes(toolResultStorage.duplicationWaste)}`);
    }
    output.push(`  Note: toolUseResult is CLI/replay metadata. The model only attends to content blocks.`);
    output.push('');
  }

  // ── Thinking Burn ─────────────────────────────────────────────────────
  h('THINKING BURN');
  output.push(`  Thinking blocks:    ${thinkingSummary.count} (${fmtPct(thinkingSummary.count, stats.assistantCount)} of assistant msgs)`);
  if (thinkingSummary.encrypted > 0) {
    output.push(`  ├─ Encrypted:       ${thinkingSummary.encrypted}`);
    output.push(`  └─ Plaintext:       ${thinkingSummary.plaintext}`);
  }
  output.push(`  Signature total:    ${fmtBytes(thinkingSummary.totalSigBytes)}`);
  output.push(`  Largest signature:  ${fmtBytes(thinkingSummary.maxSigBytes)}`);
  output.push(`  Avg signature:      ${fmtBytes(thinkingSummary.avgSigBytes)}`);
  output.push(`  Largest raw block:  ${fmtBytes(thinkingSummary.maxContentBytes)}`);
  if (thinkingFlow.thinkThenTool > 0 || thinkingFlow.toolThenThink > 0 || thinkingFlow.thinkOnly > 0 || thinkingFlow.toolOnly > 0) {
    output.push(`  Flow pattern:`);
    if (thinkingFlow.thinkOnly > 0)   output.push(`    Thinking-only msgs: ${thinkingFlow.thinkOnly} — pure reasoning (no tools in same msg)`);
    if (thinkingFlow.toolOnly > 0)    output.push(`    Tools-only msgs:    ${thinkingFlow.toolOnly} — action messages`);
    if (thinkingFlow.thinkThenTool > 0) output.push(`    Thinking→Tools:     ${thinkingFlow.thinkThenTool} — think then act in flow`);
    if (thinkingFlow.toolThenThink > 0) output.push(`    Tools→Thinking:     ${thinkingFlow.toolThenThink} — reflect on results`);
  }
  output.push('');

  // ── Largest Turns ─────────────────────────────────────────────────────
  if (turnSorted.length > 0) {
    h('LARGEST ASSISTANT TURNS');
    turnSorted.slice(0, 8).forEach((t, i) => output.push(`  ${i + 1}. ${fmtBytes(t)}`));
    output.push('');
  }

  // ── Tool Count Per Turn ────────────────────────────────────────────────
  h('TOOL CALLS PER USER TURN');
  Object.entries(toolCountHist).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([count, freq]) => {
    const bar = '█'.repeat(Math.min(Math.round(freq / 2), 40));
    output.push(`  ${String(count).padStart(3)} tools: ${String(freq).padStart(4)} turns ${bar}`);
  });
  const maxTools = Object.keys(toolCountHist).length ? Math.max(...Object.keys(toolCountHist).map(Number)) : 0;
  output.push(`  Max tools in one turn: ${maxTools}`);
  output.push('');

  // ── Tool Sequence Patterns ────────────────────────────────────────────
  if (seqPatterns.length > 0) {
    h('TOOL SEQUENCE PATTERNS (what tools run together per turn)');
    seqPatterns.slice(0, 15).forEach(([pat, count]) => {
      output.push(`  [${String(count).padStart(3)} turns] ${pat}`);
    });
    output.push('');
  }

  // ── OUTPUT BY TOOL (resolved) ─────────────────────────────────────────
  if (outputByTool && outputByTool.length > 0) {
    h('OUTPUT BY TOOL (what the model sees after each tool runs)');
    output.push(`  ${'Tool'.padEnd(16)} ${'Count'.padStart(5)} ${'Total'.padStart(9)} ${'Avg'.padStart(8)} ${'Max'.padStart(8)}`);
    output.push(`  ${''.padEnd(16, '─')} ${''.padStart(5, '─')} ${''.padStart(9, '─')} ${''.padStart(8, '─')} ${''.padStart(8, '─')}`);
    for (const t of outputByTool) {
      const pct = t.totalSize > 0 ? ` (${(t.totalSize / outputByTool.reduce((a, b) => a + b.totalSize, 0) * 100).toFixed(0)}%)` : '';
      output.push(`  ${t.name.padEnd(16)} ${String(t.count).padStart(5)} ${fmtBytes(t.totalSize).padStart(9)} ${fmtBytes(t.avgSize).padStart(8)} ${fmtBytes(t.maxSize).padStart(8)}${pct}`);
    }
    output.push('');
  }

  // ── BASH OUTPUT BY COMMAND ────────────────────────────────────────────
  if (bashOutputSummary && bashOutputSummary.length > 0) {
    h('BASH OUTPUT BY COMMAND (normalized, sorted by total output)');
    output.push(`  ${'Command'.padEnd(22)} ${'Runs'.padStart(5)} ${'Total'.padStart(9)} ${'Avg'.padStart(8)} ${'Max'.padStart(8)}`);
    output.push(`  ${''.padEnd(22, '─')} ${''.padStart(5, '─')} ${''.padStart(9, '─')} ${''.padStart(8, '─')} ${''.padStart(8, '─')}`);
    for (const b of bashOutputSummary) {
      output.push(`  ${b.command.padEnd(22)} ${String(b.count).padStart(5)} ${fmtBytes(b.totalOutput).padStart(9)} ${fmtBytes(b.avgOutput).padStart(8)} ${fmtBytes(b.maxOutput).padStart(8)}`);
    }
    output.push('');
  }

  // ── READ OUTPUT BY FILE ──────────────────────────────────────────────
  if (readOutputSummary && readOutputSummary.length > 0) {
    h('READ OUTPUT BY FILE (sorted by total bytes returned)');
    output.push(`  ${'File'.padEnd(38)} ${'Reads'.padStart(5)} ${'Total'.padStart(9)} ${'Avg'.padStart(8)} ${'Max'.padStart(8)}`);
    output.push(`  ${''.padEnd(38, '─')} ${''.padStart(5, '─')} ${''.padStart(9, '─')} ${''.padStart(8, '─')} ${''.padStart(8, '─')}`);
    for (const r of readOutputSummary.slice(0, 20)) {
      output.push(`  ${r.file.padEnd(38)} ${String(r.count).padStart(5)} ${fmtBytes(r.totalOutput).padStart(9)} ${fmtBytes(r.avgOutput).padStart(8)} ${fmtBytes(r.maxOutput).padStart(8)}`);
    }
    output.push('');
  }

  // ── TOP EXPENSIVE OPERATIONS ─────────────────────────────────────────
  if (topOperations && topOperations.length > 0) {
    h('MOST EXPENSIVE SINGLE OPERATIONS (tool results by size)');
    topOperations.slice(0, 15).forEach((op, i) => {
      const label = op.cmd || op.file || '';
      const shortLabel = label.replace(homedir(), '~').substring(0, 100);
      output.push(`  ${String(i + 1).padStart(2)}. [${op.tool}] ${fmtBytes(op.size).padStart(8)} (${op.lines} lines)  ${shortLabel}`);
    });
    output.push('');
  }

  // ── THRESHOLD ANALYSIS ───────────────────────────────────────────────
  if (thresholdAnalysis && thresholdAnalysis.length > 0) {
    h('OUTPUT SIZE THRESHOLDS');
    const totalResults = bashOutputSummary.reduce((a, b) => a + b.count, 0) + readOutputSummary.reduce((a, b) => a + b.count, 0);
    for (const t of thresholdAnalysis) {
      if (t.count > 0) {
        output.push(`  Over ${t.thresholdLabel.padStart(7)}: ${String(t.count).padStart(4)} results (${t.pctOfAll}) ${fmtBytes(t.totalBytes).padStart(9)} total`);
      }
    }
    output.push('');
  }

  // ── Files ─────────────────────────────────────────────────────────────
  if (mostEdited.length > 0) {
    h('MOST EDITED FILES');
    mostEdited.forEach(([f, c]) => output.push(`  [${c}] ${f.replace(homedir(), '~')}`));
    output.push('');
  }
  if (mostWritten.length > 0) {
    h('FILES CREATED');
    mostWritten.forEach(([f, c]) => output.push(`  [${c}] ${f.replace(homedir(), '~')}`));
    output.push('');
  }

  // ── Top Bash Commands ─────────────────────────────────────────────────
  if (topBash.length > 0) {
    h('MOST FREQUENT BASH COMMANDS (full command text)');
    topBash.slice(0, 12).forEach(([cmd, c]) => output.push(`  [${c}] ${cmd}`));
    output.push('');
  }

  // ── Subagents ─────────────────────────────────────────────────────────
  if (subagents.length > 0) {
    h('SUBAGENTS');
    output.push(`  Total: ${subagents.length}`);
    output.push(`  Total size: ${fmtBytes(subagents.reduce((a, s) => a + s.size, 0))}`);
    output.push('');
    subagents.forEach(sa => {
      const meta = [sa.sizeHuman, `${sa.lines} lines`, sa.name].join('  ');
      output.push(`  [${meta}]`);
    });
    output.push('');
  }

  // ── Agent Dispatches ─────────────────────────────────────────────────
  if (agentDispatches.length > 0) {
    h('SUBAGENT DISPATCHES');
    agentDispatches.forEach((d, i) => {
      output.push(`  ${i + 1}. ${d.type} (${fmtBytes(d.size)})`);
      output.push(`     ${d.prompt}`);
    });
    output.push('');
  }

  // ── AskUserQuestions ─────────────────────────────────────────────────
  if (askUserQuestions.length > 0) {
    h('ASK_USER_QUESTIONS');
    askUserQuestions.forEach((q, i) => output.push(`  ${i + 1}. [${fmtBytes(q.size)}] ${q.question}`));
    output.push('');
  }

  // ── Context Consumption ───────────────────────────────────────────────
  h('CONTEXT CONSUMPTION (estimated from log size)');
  const ctxRows = [
    ['Tool INPUT (prompts)', context.toolInput],
    ['Tool RESULTS (content)', context.toolResult],
    ['Thinking (encrypted sigs)', context.thinking + context.thinkingSignature],
    ['Assistant text', context.assistantText],
    ['User text', context.userText],
  ];
  const totalCtx = ctxRows.reduce((a, r) => a + r[1], 0);
  output.push(`  ${'Component'.padEnd(34)} ${'Size'.padStart(9)} ${'Est.Tokens'.padStart(12)} ${'%'.padStart(6)}`);
  output.push(`  ${''.padEnd(34, '─')} ${''.padStart(9, '─')} ${''.padStart(12, '─')} ${''.padStart(6, '─')}`);
  ctxRows.forEach(([label, size]) => {
    output.push(`  ${label.padEnd(34)} ${fmtBytes(size).padStart(9)} ${String(estTokens(size)).padStart(12)} ${fmtPct(size, totalCtx).padStart(6)}`);
  });
  output.push(`  ${'TOTAL'.padEnd(34)} ${fmtBytes(totalCtx).padStart(9)} ${String(estTokens(totalCtx)).padStart(12)}`);
  output.push('');

  // ── User Timeline ────────────────────────────────────────────────────
  if (userTimeline.length > 0) {
    h('USER INPUT TIMELINE');
    const first = userTimeline[0];
    const last = userTimeline[userTimeline.length - 1];
    const firstTs = first.timestamp ? new Date(first.timestamp).toLocaleString() : '?';
    const lastTs = last.timestamp ? new Date(last.timestamp).toLocaleString() : '?';
    output.push(`  First:  ${firstTs} — ${first.content}`);
    output.push(`  Last:   ${lastTs} — ${last.content}`);
    output.push(`  Total real user inputs: ${userTimeline.length}`);
    if (first.timestamp && last.timestamp) {
      const dur = new Date(last.timestamp) - new Date(first.timestamp);
      const hrs = Math.floor(dur / 3600000);
      const mins = Math.floor((dur % 3600000) / 60000);
      output.push(`  Duration: ~${hrs}h ${mins}m`);
    }
    output.push('');
  }

  output.push(sep);
  return output.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Claude Code Session Analyzer
=============================
Analyzes a session JSONL file and reports tool usage, thinking burn,
subagent costs, file hotspots, and sequence patterns.

Usage:
  node scripts/analyze-session.mjs <session-file.jsonl>
  node scripts/analyze-session.mjs <sessionId>
  node scripts/analyze-session.mjs <sessionId> --project /path/to/project
  node scripts/analyze-session.mjs --list
  node scripts/analyze-session.mjs --help

Flags:
  --format json     Machine-readable JSON output
  --format human    Human-readable tables (default)
  --project <path>  Hint for session discovery (optional with sessionId)
  --list            List all available sessions as JSON
  --help            This message
`);
    return;
  }

  if (args.includes('--list')) {
    console.log(JSON.stringify(listSessions(), null, 2));
    return;
  }

  const format = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json' ? 'json' : 'human';
  const formatFlagPos = args.indexOf('--format');
  const cleanArgs = formatFlagPos >= 0 ? args.filter((_, i) => i < formatFlagPos || i > formatFlagPos + 1) : args;

  const projectHint = cleanArgs.includes('--project') && cleanArgs[cleanArgs.indexOf('--project') + 1]
    ? cleanArgs[cleanArgs.indexOf('--project') + 1] : null;
  const projectPos = cleanArgs.indexOf('--project');
  const sessionArg = projectPos >= 0
    ? cleanArgs.filter((_, i) => i < projectPos || i > projectPos + 1).find(a => !a.startsWith('--'))
    : cleanArgs.find(a => !a.startsWith('--'));

  if (!sessionArg) {
    console.error('Usage: node scripts/analyze-session.mjs <sessionId|file.jsonl> [--format json] [--project /path]');
    console.error('       node scripts/analyze-session.mjs --list');
    process.exit(1);
  }

  const resolved = resolveSessionPath(sessionArg, projectHint);
  if (!resolved) {
    console.error(`Session not found: ${sessionArg}`);
    console.error('Use --list to see available sessions.');
    process.exit(1);
  }

  const content = fs.readFileSync(resolved.filePath, 'utf-8');
  const lines = content.split('\n');
  const result = parseSession(lines);

  // Metadata
  const meta = loadSessionMeta(path.basename(sessionArg, '.jsonl').replace(/\.jsonl$/, ''));
  result.meta = meta || {};

  // Subagents
  if (resolved.sessionDir) {
    result.subagents = discoverSubagents(resolved.sessionDir);
    result.subagentTools = aggregateSubagentTools(resolved.sessionDir);
  }

  // File info
  result.filePath = resolved.filePath;
  result.fileSize = fs.statSync(resolved.filePath).size;

  // Output
  if (format === 'json') {
    console.log(formatJson(result));
  } else {
    console.log(formatHuman(result));
  }
}

main();
