#!/usr/bin/env node
/**
 * memory-daemon — supervised Unix-socket writer daemon entry point.
 *
 * Config (injected as SOX_CONFIG_* env vars by sox start at launch):
 *   SOX_CONFIG_DB_PATH        — path to SQLite database file (required)
 *   SOX_CONFIG_SOCK_PATH      — Unix socket path (default: ~/.memory/memoryd.sock)
 *   SOX_CONFIG_PROVIDER_URL   — OpenAI-compatible base URL (default: http://localhost:1234/v1)
 *   SOX_CONFIG_PROVIDER_KEY   — API key (falls back to LM_API_KEY env var)
 *   SOX_CONFIG_PROVIDER_MODEL — model ID to use for entity/relation extraction
 *
 * CLI args (optional, override env):
 *   --db-path <path>   Path to .db file
 *   --scope <scope>    Scope for priority decisions (default: project)
 */

import { MemoryDaemon } from './memoryd.js';
import type { OrganizerItem, OrganizerResult } from './memoryd.js';
import Database from 'better-sqlite3';

const cliArgs = process.argv.slice(2);
let dbPath: string | null = null;
let scope = 'project';

for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  const next = cliArgs[i + 1];
  if (arg === '--db-path' && next) { dbPath = next; i++; }
  else if (arg === '--scope' && next) { scope = next; i++; }
}

if (!dbPath) dbPath = process.env['SOX_CONFIG_DB_PATH'] ?? null;

if (!dbPath) {
  console.error('[memory-daemon] Error: db_path required — set via: sox config set memory-daemon db_path <path>');
  process.exit(1);
}

const PROVIDER_URL = process.env['SOX_CONFIG_PROVIDER_URL'] ?? 'http://localhost:1234/v1';
const PROVIDER_KEY = process.env['SOX_CONFIG_PROVIDER_KEY'] ?? process.env['LM_API_KEY'] ?? '';
const PROVIDER_MODEL = process.env['SOX_CONFIG_PROVIDER_MODEL'] ?? '';

const SYSTEM_PROMPT = `You are a memory organizer. Given an episode of text, extract structured semantic information.
Return ONLY a JSON object (no markdown, no explanation) with EXACTLY these fields:
{
  "importance": <integer 1-10>,
  "entities": [{"name": "<string>", "type": "<person|place|project|concept|event|technology|organization>", "summary": "<string>"}],
  "relations": [{"rel": "<string>", "dst_name": "<string>", "weight": <0.1-1.0>}],
  "reflection": "<string or omit>"
}
importance: 1=trivial, 5=useful context, 8=key fact or decision, 10=critical unique knowledge.
entities: named things explicitly mentioned (people, projects, tools, concepts). Skip generic words.
relations: use field names "rel" and "dst_name" exactly. rel values: PART_OF, USES, RELATES_TO, MEMBER_OF, MENTIONS, SAME_AS.
Return empty arrays if nothing clearly present. Field names must match exactly.`;

interface LLMResponse {
  choices: Array<{ message: { content: string } }>;
}

interface ParsedOrganizer {
  importance?: number;
  entities?: Array<{ name: string; type: string; summary?: string }>;
  relations?: Array<{ rel: string; dst_name?: string; weight?: number }>;
  reflection?: string;
}

function extractJson(text: string): string {
  // Strip <think>...</think> blocks (Qwen3 reasoning models emit these)
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Try to find a JSON object in the response
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : stripped;
}

async function organizeItem(item: OrganizerItem): Promise<OrganizerResult> {
  const response = await fetch(`${PROVIDER_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(PROVIDER_KEY ? { 'Authorization': `Bearer ${PROVIDER_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: PROVIDER_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Episode (uid: ${item.uid}, kind: ${item.kind}):\n${item.content}` },
      ],
      temperature: 0.1,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as LLMResponse;
  const raw = data.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(extractJson(raw)) as ParsedOrganizer;

  return {
    uid: item.uid,
    importance: typeof parsed.importance === 'number'
      ? Math.min(10, Math.max(1, Math.round(parsed.importance)))
      : 1,
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
    relations: Array.isArray(parsed.relations)
      ? parsed.relations.map(r => ({
          rel: r.rel,
          ...(r.dst_name !== undefined && { dst_name: r.dst_name }),
          ...(r.weight !== undefined && { weight: r.weight }),
        }))
      : [],
    ...(parsed.reflection ? { reflection: parsed.reflection } : {}),
  };
}

async function llmOrganizer(
  items: OrganizerItem[],
  _db: Database.Database,
): Promise<OrganizerResult[]> {
  if (!PROVIDER_MODEL) {
    console.warn('[memory-daemon] no provider_model set — using deterministic fallback');
    return items.map(item => ({ uid: item.uid, importance: 1, entities: [], relations: [] }));
  }

  const results: OrganizerResult[] = [];
  for (const item of items) {
    try {
      const result = await organizeItem(item);
      console.log(`[memory-daemon] organized ${item.uid}: importance=${result.importance} entities=${result.entities?.length ?? 0} relations=${result.relations?.length ?? 0}`);
      results.push(result);
    } catch (err) {
      console.error(`[memory-daemon] organizer failed for ${item.uid}:`, err);
      results.push({ uid: item.uid, importance: 1, entities: [], relations: [] });
    }
  }
  return results;
}

const daemon = new MemoryDaemon(dbPath, llmOrganizer);

daemon.start().then(() => {
  const providerInfo = PROVIDER_MODEL
    ? `provider=${PROVIDER_URL} model=${PROVIDER_MODEL}`
    : 'provider=none (deterministic fallback)';
  console.log(`[memory-daemon] started — db: ${dbPath}, scope: ${scope}, ${providerInfo}`);
}).catch((err: unknown) => {
  console.error('[memory-daemon] startup error:', err);
  process.exit(1);
});
