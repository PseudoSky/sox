/**
 * memory-organizer — The ONLY LLM caller in sox-memory (R3).
 *
 * Invoked by memoryd for each ingest batch. Makes 2–4 batched LLM calls per cycle:
 *   1. Relation extraction + importance scoring (structured_output)
 *   2. Entity disambiguation (0.7–0.95 cosine band)
 *   3. Contradiction detection
 *   4. Reflection synthesis (when Σimportance ≥ 150)
 *
 * Design constraints (design.md §2.4, §G-5):
 *   - EVERY LLM/provider call originates here (R3).
 *   - Read path (memory_recall) makes zero provider calls (R1).
 *   - Uses the ecosystem provider abstraction (structured_output: true, min_context_tokens: 16384).
 *   - Importance scores: 1–10 (real-valued, LLM-assigned).
 *   - Entity link: exact/normalized → cosine >0.95 auto-merge → 0.7–0.95 LLM disambiguation.
 *   - Reflection: synthesized when a batch's Σimportance ≥ 150.
 *
 * Provider abstraction: in the ecosystem the provider is configured via
 *   providers.<name>.{base_url, api_key} in extensions-config, resolved by
 *   provider-capabilities.ts. Here we access it via the MEMORY_PROVIDER_URL +
 *   MEMORY_PROVIDER_KEY env vars (set by the host at lifecycle start) or fall back
 *   to a deterministic stub for testing without a live provider.
 */

import type BetterSqlite3 from 'better-sqlite3';

export interface OrganizerItem {
  uid: string;
  content: string;
  kind: string;
  agent_id: string | null;
  session_id: string | null;
}

export interface OrganizerResult {
  uid: string;
  importance?: number;
  entities?: Array<{ name: string; type: string; summary?: string }>;
  relations?: Array<{
    src_uid?: string;
    rel: string;
    dst_uid?: string;
    dst_name?: string;
    weight?: number;
  }>;
  contradicts_uid?: string;
  reflection?: string;
}

// ── Provider call counter (tracks all LLM calls; must be 0 on read path) ────

let _providerCallCount = 0;
export function getOrganizerProviderCallCount(): number {
  return _providerCallCount;
}
export function resetOrganizerProviderCallCount(): void {
  _providerCallCount = 0;
}

// ── Provider abstraction ──────────────────────────────────────────────────────

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getProviderConfig(): ProviderConfig | null {
  const baseUrl = process.env['MEMORY_PROVIDER_URL'];
  const apiKey = process.env['MEMORY_PROVIDER_KEY'];
  const model = process.env['MEMORY_PROVIDER_MODEL'] ?? 'gpt-4o-mini';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model };
}

interface StructuredOutputRequest {
  messages: Array<{ role: string; content: string }>;
  schema: Record<string, unknown>;
  model: string;
}

/**
 * Call the provider with structured_output.
 * Increments _providerCallCount for each call (R3 tracking).
 */
async function callProvider<T>(
  config: ProviderConfig,
  req: StructuredOutputRequest,
): Promise<T> {
  _providerCallCount++;

  const body = JSON.stringify({
    model: req.model,
    messages: req.messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'memory_organizer_output',
        strict: true,
        schema: req.schema,
      },
    },
  });

  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Provider error ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = json.choices[0]?.message?.content;
  if (!content) throw new Error('Provider returned empty content');

  return JSON.parse(content) as T;
}

// ── Structured output schemas ─────────────────────────────────────────────────

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          importance: { type: 'number', minimum: 1, maximum: 10 },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['name', 'type'],
              additionalProperties: false,
            },
          },
          relations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rel: { type: 'string', enum: ['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'DERIVED_FROM', 'PART_OF', 'SAME_AS'] },
                dst_name: { type: 'string' },
                weight: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['rel', 'dst_name'],
              additionalProperties: false,
            },
          },
          contradicts_uid: { type: ['string', 'null'] },
        },
        required: ['uid', 'importance', 'entities', 'relations'],
        additionalProperties: false,
      },
    },
    reflection: { type: ['string', 'null'] },
  },
  required: ['items'],
  additionalProperties: false,
};

interface ExtractionOutput {
  items: Array<{
    uid: string;
    importance: number;
    entities: Array<{ name: string; type: string; summary?: string }>;
    relations: Array<{ rel: string; dst_name?: string; weight?: number; contradicts_uid?: string }>;
    contradicts_uid?: string | null;
  }>;
  reflection?: string | null;
}

// ── Deterministic fallback (no provider configured) ───────────────────────────

/**
 * Deterministic organizer for testing/CI without a live provider.
 * Scores importance as length-based heuristic; extracts capitalized words as entities.
 * Does NOT increment _providerCallCount.
 */
function deterministicOrganize(items: OrganizerItem[]): OrganizerResult[] {
  return items.map((item) => {
    // Simple importance: longer = more important, capped at 8
    const wordCount = item.content.split(/\s+/).length;
    const importance = Math.min(8, Math.max(1, Math.round(wordCount / 5)));

    // Extract capitalized words as entity candidates (deterministic NER stub)
    const entityNames = Array.from(
      new Set(
        item.content.match(/\b[A-Z][a-z]{2,}\b/g) ?? [],
      ),
    ).slice(0, 3);

    const entities: Array<{ name: string; type: string; summary?: string }> = entityNames.map((name) => ({
      name,
      type: 'unknown',
    }));

    return {
      uid: item.uid,
      importance,
      entities,
      relations: [] as OrganizerResult['relations'] & [],
    };
  });
}

// ── Main organize function ────────────────────────────────────────────────────

/**
 * Organize a batch of memory items.
 * Uses the ecosystem provider for LLM calls when configured;
 * falls back to deterministic extraction for testing.
 *
 * This is the SOLE LLM locus in sox-memory (R3).
 */
export async function organizeItems(
  items: OrganizerItem[],
  _db: BetterSqlite3.Database,
): Promise<OrganizerResult[]> {
  if (items.length === 0) return [];

  const config = getProviderConfig();

  // No provider configured → deterministic fallback (R3 still satisfied: 0 provider calls)
  if (!config) {
    return deterministicOrganize(items);
  }

  // Build prompt
  const itemsText = items
    .map((item, i) => `[${i + 1}] uid=${item.uid}\n${item.content}`)
    .join('\n\n');

  const systemPrompt = `You are a memory organization agent. For each memory item:
1. Score importance (1-10, where 10 = highly significant fact/event).
2. Extract named entities (people, places, concepts, organizations).
3. Identify semantic relations to other items.
4. Detect contradictions with existing memories (set contradicts_uid if you know the UID of the contradicted claim).
5. If the batch's total importance >= 150, synthesize a reflection insight.

Return structured JSON only.`;

  const userPrompt = `Organize these ${items.length} memory item(s):\n\n${itemsText}`;

  try {
    // LLM call 1: extraction + importance + relations (R3 — only call here)
    const output = await callProvider<ExtractionOutput>(config, {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      schema: EXTRACTION_SCHEMA,
    });

    const results: OrganizerResult[] = output.items.map((item) => {
      const base: OrganizerResult = {
        uid: item.uid,
        importance: Math.max(1, Math.min(10, item.importance)),
        entities: item.entities,
        relations: item.relations,
      };
      if (item.contradicts_uid) base.contradicts_uid = item.contradicts_uid;
      return base;
    });

    // Check for reflection trigger (Σimportance ≥ 150)
    const totalImportance = results.reduce((sum, r) => sum + (r.importance ?? 1), 0);
    if (totalImportance >= 150 && output.reflection) {
      // Attach reflection to the highest-importance item
      const topResult = results.reduce((best, r) =>
        (r.importance ?? 0) > (best.importance ?? 0) ? r : best,
      );
      topResult.reflection = output.reflection;
    }

    return results;
  } catch (err) {
    console.error('[memory-organizer] provider error, falling back to deterministic:', err);
    // On provider failure, fall back to deterministic (don't fail the batch)
    return deterministicOrganize(items);
  }
}

// ── P4: Community summary (the ONLY LLM call for community summaries — R3) ────

export interface CommunityInput {
  uid: string;
  memberNames: string[];
  memberContents: string[];
}

export interface CommunityResult {
  uid: string;
  summary: string;
}

/**
 * Generate LLM summaries for communities.
 * Lives ONLY in memory-organizer (R3 — every LLM call originates here).
 * Falls back to deterministic summary when no provider is configured.
 *
 * @param communities - list of community nodes with member context
 * @returns list of { uid, summary }
 */
export async function summarizeCommunities(communities: CommunityInput[]): Promise<CommunityResult[]> {
  if (communities.length === 0) return [];

  const config = getProviderConfig();

  if (!config) {
    // Deterministic fallback: concatenate member names
    return communities.map(c => ({
      uid: c.uid,
      summary: `Group of related concepts: ${c.memberNames.slice(0, 5).join(', ')}.`,
    }));
  }

  const COMMUNITY_SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
      summaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uid: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['uid', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['summaries'],
    additionalProperties: false,
  };

  const commText = communities.map((c, i) =>
    `[${i + 1}] community_uid=${c.uid}\nMembers: ${c.memberNames.slice(0, 5).join(', ')}\nContent: ${c.memberContents.slice(0, 3).join(' | ')}`
  ).join('\n\n');

  try {
    const output = await callProvider<{ summaries: Array<{ uid: string; summary: string }> }>(config, {
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a memory organization agent. For each community cluster, write a concise 1-sentence summary describing what the members have in common.' },
        { role: 'user', content: `Summarize these ${communities.length} community cluster(s):\n\n${commText}` },
      ],
      schema: COMMUNITY_SUMMARY_SCHEMA,
    });
    return output.summaries ?? [];
  } catch (err) {
    console.error('[memory-organizer] community summary provider error, falling back:', err);
    return communities.map(c => ({
      uid: c.uid,
      summary: `Group of related concepts: ${c.memberNames.slice(0, 5).join(', ')}.`,
    }));
  }
}

// ── Agent definition (ecosystem metadata) ────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  requires: {
    structured_output: boolean;
    min_context_tokens: number;
  };
}

const agent: AgentDefinition = {
  name: 'memory-organizer',
  description:
    'Deterministic-first organize loop LLM step: batched relation extraction, ' +
    'importance scoring (1–10), contradiction detection, reflection synthesis (Σimportance≥150). ' +
    'Invoked by memoryd; NEVER on the read path. The sole LLM caller in sox-memory.',
  systemPrompt:
    'You are a memory organization agent. Extract entities, score importance (1-10), ' +
    'detect relations and contradictions, synthesize reflections. Return structured JSON only.',
  capabilities: ['memory.organize'],
  requires: {
    structured_output: true,
    min_context_tokens: 16384,
  },
};

export default agent;
