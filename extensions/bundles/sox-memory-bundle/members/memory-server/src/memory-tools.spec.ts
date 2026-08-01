/**
 * memory-tools.spec.ts — focused P4 enrichment tool tests.
 *
 * Exercises CONTRACTS.md C2 shapes for:
 *   - memory_topics (C2.3)
 *   - memory_list_projects (C2.4)
 *   - memory_recall with filters (C2.2 — project_path + topic + query-optional)
 *   - memory_list_entities (C2.5)
 *   - memory_near_duplicates (C2.10)
 *   - memory_supersession_chain (C2.9)
 *   - memory_stats (C2.12)
 *   - memory_curate (C2.11 — set_topic, retag, set_importance)
 *   - memory_get_community v1 (C2.6 — community_uid direct lookup)
 *
 * Setup: a small SQLite DB with a couple of writes + a cluster pass,
 * so the tool outputs can be asserted against the contract shapes.
 *
 * All operations are deterministic — no LLM calls. Embeddings use the real local
 * fastembed/ONNX backend (BL-250: the hash backend was removed — EmbedBackend is
 * 'auto' | 'real' only, and both resolve to the same real model; see embed.ts).
 */

import { clusterStore, openDb } from '@adhd/sox-memory-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './index.js';

// ── Test DB setup ──────────────────────────────────────────────────────────────

const TEST_DIR = path.join(os.tmpdir(), `sox-p4-spec-${process.pid}`);
const DB_PATH = path.join(TEST_DIR, 'test.db');

/** Written episode UIDs, populated in beforeAll. */
const uids: string[] = [];

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Write several episodes with different topics and project paths
  const writes = [
    {
      content: 'The TypeScript compiler enforces strict null checks.',
      topic: 'typescript',
      project_path: '/home/user/projects/ts-app',
      tags: ['compiler', 'typescript'],
    },
    {
      content: 'SQLite supports full-text search via FTS5 extension.',
      topic: 'databases',
      project_path: '/home/user/projects/db-project',
      tags: ['sqlite', 'fts5'],
    },
    {
      content: 'Node.js uses an event-loop for I/O concurrency.',
      topic: 'nodejs',
      project_path: '/home/user/projects/ts-app',
      tags: ['node', 'event-loop'],
    },
    {
      content: 'TypeScript generics allow type-safe abstractions over collections.',
      topic: 'typescript',
      project_path: '/home/user/projects/ts-app',
      tags: ['generics', 'typescript'],
    },
  ];

  for (const w of writes) {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: w.content,
      topic: w.topic,
      project_path: w.project_path,
      tags: w.tags,
    });

    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text) as {
      episode_uid?: string;
      code?: string;
      existing_uid?: string;
    };

    const uid = parsed.episode_uid ?? parsed.existing_uid;
    if (uid) uids.push(uid);
  }

  // Run a cluster pass so community data is available
  const db = await openDb(DB_PATH);
  await clusterStore(db);
});

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type JsonObj = Record<string, unknown>;

function parseResult(result: Awaited<ReturnType<typeof handleToolCall>>): JsonObj {
  expect(result.isError).toBeFalsy();
  return JSON.parse((result.content[0] as { type: string; text: string }).text) as JsonObj;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('memory_topics (C2.3)', () => {
  it('returns topics array with required fields', async () => {
    const out = parseResult(await handleToolCall('memory_topics', { db_path: DB_PATH }));
    const topics = out['topics'] as JsonObj[];
    expect(Array.isArray(topics)).toBe(true);
    expect(typeof out['total']).toBe('number');
    expect(topics.length).toBeGreaterThan(0);

    // Each topic entry must have the C2.3 shape
    for (const t of topics) {
      expect(typeof t['topic']).toBe('string');
      expect(typeof t['episode_count']).toBe('number');
      expect(typeof t['avg_importance']).toBe('number');
      expect(typeof t['last_written']).toBe('string');
      expect(typeof t['has_community']).toBe('boolean');
      // community_uid: null or string
      expect(t['community_uid'] === null || typeof t['community_uid'] === 'string').toBe(true);
    }
  });

  it('counts typescript topic episodes correctly', async () => {
    const out = parseResult(await handleToolCall('memory_topics', { db_path: DB_PATH, sort_by: 'episode_count' }));
    const topics = out['topics'] as JsonObj[];
    const ts = topics.find((t) => t['topic'] === 'typescript');
    expect(ts).toBeDefined();
    expect(ts!['episode_count']).toBe(2); // two typescript writes above
  });

  it('project_path filter returns only relevant topics', async () => {
    const out = parseResult(await handleToolCall('memory_topics', {
      db_path: DB_PATH,
      project_path: '/home/user/projects/db-project',
    }));
    const topics = out['topics'] as JsonObj[];
    // Only the db-project episode has topic=databases
    expect(topics.every((t) => t['topic'] === 'databases')).toBe(true);
  });

  it('search filter narrows by substring', async () => {
    const out = parseResult(await handleToolCall('memory_topics', { db_path: DB_PATH, search: 'type' }));
    const topics = out['topics'] as JsonObj[];
    expect(topics.every((t) => (t['topic'] as string).toLowerCase().includes('type'))).toBe(true);
  });
});

describe('memory_list_projects (C2.4)', () => {
  it('returns projects array with required fields', async () => {
    const out = parseResult(await handleToolCall('memory_list_projects', { db_path: DB_PATH }));
    const projects = out['projects'] as JsonObj[];
    expect(Array.isArray(projects)).toBe(true);
    expect(typeof out['total']).toBe('number');
    expect(projects.length).toBeGreaterThan(0);

    for (const p of projects) {
      expect(typeof p['project_path']).toBe('string');
      expect(typeof p['episode_count']).toBe('number');
      expect(typeof p['last_written']).toBe('string');
    }
  });

  it('lists both distinct project paths', async () => {
    const out = parseResult(await handleToolCall('memory_list_projects', { db_path: DB_PATH }));
    const projects = out['projects'] as JsonObj[];
    const paths = projects.map((p) => p['project_path'] as string);
    expect(paths).toContain('/home/user/projects/ts-app');
    expect(paths).toContain('/home/user/projects/db-project');
  });

  it('episode_count is correct for ts-app (3 episodes)', async () => {
    const out = parseResult(await handleToolCall('memory_list_projects', { db_path: DB_PATH }));
    const projects = out['projects'] as JsonObj[];
    const tsApp = projects.find((p) => p['project_path'] === '/home/user/projects/ts-app');
    expect(tsApp).toBeDefined();
    expect(tsApp!['episode_count']).toBe(3);
  });
});

describe('memory_recall with filters (C2.2)', () => {
  it('returns v1 enrichment fields on each result', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: DB_PATH,
      query: 'TypeScript compiler',
    }));
    const results = out['results'] as JsonObj[];
    expect(Array.isArray(results)).toBe(true);
    expect(typeof out['provider_call_count']).toBe('number');
    // BL-324 symptom group 3 — and NOT, as that item guessed, a cascade from
    // group 2. BL-254 (2026-07-23) repointed this counter at LOCAL embed calls, which are
    // uncached — a query-path recall embeds the query exactly once. It is NOT a
    // remote-call counter; "zero LLM calls" means zero NETWORK calls, and that
    // invariant is guaranteed by the provider architecture (no remote API exists
    // to call), not by this number. See recall.ts header §1.
    expect(out['provider_call_count']).toBe(1);

    if (results.length > 0) {
      const r = results[0]!;
      // v0 fields
      expect(typeof r['uid']).toBe('string');
      expect(typeof r['score']).toBe('number');
      // v1 enrichment fields
      expect('summary' in r).toBe(true);
      expect('topic' in r).toBe(true);
      expect('tags' in r).toBe(true);
      expect(Array.isArray(r['tags'])).toBe(true);
      expect('project_path' in r).toBe(true);
      expect('is_superseded' in r).toBe(true);
      expect('supersedes_uid' in r).toBe(true);
      expect('community_uid' in r).toBe(true);
      expect(typeof r['is_superseded']).toBe('boolean');
    }
  });

  it('topic filter narrows results to matching topic', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: DB_PATH,
      query: 'type system',
      filters: { topic: 'typescript' },
    }));
    const results = out['results'] as JsonObj[];
    // All results that have a topic should be typescript
    for (const r of results) {
      if (r['topic'] !== null) {
        expect(r['topic']).toBe('typescript');
      }
    }
  });

  it('project_path filter (exact) narrows to correct project', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: DB_PATH,
      filters: { project_path: '/home/user/projects/db-project' },
    }));
    const results = out['results'] as JsonObj[];
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r['project_path']).toBe('/home/user/projects/db-project');
    }
  });

  it('empty/absent query returns importance-ranked listing', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: DB_PATH,
    }));
    const results = out['results'] as JsonObj[];
    expect(Array.isArray(results)).toBe(true);
    // Results are ordered by importance DESC — verify non-increasing importance
    const importances = results.map((r) => r['importance'] as number);
    for (let i = 1; i < importances.length; i++) {
      expect(importances[i]!).toBeLessThanOrEqual(importances[i - 1]!);
    }
  });
});

// ── BL-229: agent_id scoping leak on the importance-ranked listing path ────────
//
// `memory_recall` accepts a top-level `agent_id` param. On the QUERY path
// (recall.ts) it is a hard SQL scope filter (`AND n.agent_id = ?`) applied to
// every channel (vec/FTS/temporal). On the no-query "importance-ranked listing"
// branch (index.ts, `if (!query || !query.trim())`), the WHERE clause was built
// from `filters` ONLY — `agent_id` was accepted into the schema, read nowhere,
// and silently dropped: a caller doing "list my memories" with no `query` and
// `agent_id:'A'` got EVERY agent's episodes back, not just A's. Fixed via option
// (a) — the listing path applies `agent_id` to its own WHERE, matching the
// query path's scope semantics exactly (same column, same store).
describe('memory_recall — BL-229 agent_id scoping (importance-ranked listing)', () => {
  const BL229_DIR = path.join(os.tmpdir(), `sox-bl229-spec-${process.pid}`);
  const BL229_DB_PATH = path.join(BL229_DIR, 'test.db');
  // Deliberately lexically DISSIMILAR content (not a templated "agent A"/"agent B"
  // near-duplicate pair) — this suite runs with SOX_SYNC_EMBED=1 (vitest.setup.ts),
  // so E8 near-dup detection runs INLINE on every write and would invalidate the
  // older of two near-identical episodes (neardup.ts: `should_invalidate: cosine >=
  // threshold`), silently removing it from every listing regardless of agent_id —
  // a fixture artifact, not the BL-229 behavior under test. Distinct topics avoid it.
  const AGENT_A_CONTENT = 'Quarterly revenue projections rely on the Q3 pipeline forecast.';
  const AGENT_B_CONTENT = 'The kitchen faucet needs a new O-ring washer to stop the drip.';

  beforeAll(async () => {
    fs.mkdirSync(BL229_DIR, { recursive: true });
    const r1 = await handleToolCall('memory_write', {
      db_path: BL229_DB_PATH,
      content: AGENT_A_CONTENT,
      agent_id: 'agent-A',
      importance: 5,
      project_path: '/test/project',
    });
    if ('isError' in r1 && r1.isError) throw new Error(`BL-229 fixture write (agent-A) failed: ${JSON.stringify(r1)}`);
    const r2 = await handleToolCall('memory_write', {
      db_path: BL229_DB_PATH,
      content: AGENT_B_CONTENT,
      agent_id: 'agent-B',
      importance: 9, // deliberately HIGHER importance than A's episode: if agent_id
      // scoping is broken, B's higher-importance episode sorts FIRST and would be
      // the most likely to be surfaced/observed by a caller scoped to A — a strong
      // negative control against "it happened to not show up" false negatives.
      project_path: '/test/project',
    });
    if ('isError' in r2 && r2.isError) throw new Error(`BL-229 fixture write (agent-B) failed: ${JSON.stringify(r2)}`);
  });

  afterAll(() => {
    try { fs.rmSync(BL229_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('BL-229: a no-query listing scoped to agent_id:"agent-A" returns ONLY agent-A-authored episodes — never agent-B content', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: BL229_DB_PATH,
      agent_id: 'agent-A',
      // no `query` — exercises the importance-ranked listing branch specifically.
    }));
    const results = out['results'] as JsonObj[];
    expect(results.length).toBeGreaterThan(0);

    // Assert on AUTHORSHIP (agent_id field + actual content), not merely on count —
    // a count-only assertion would pass even if the WHERE clause silently matched
    // the wrong column or the fixture only ever had one agent's data.
    for (const r of results) {
      expect(r['agent_id']).toBe('agent-A');
      expect(r['content']).not.toBe(AGENT_B_CONTENT);
    }
    expect(results.some((r) => r['content'] === AGENT_A_CONTENT)).toBe(true);
    expect(results.some((r) => r['content'] === AGENT_B_CONTENT)).toBe(false);
  });

  it('BL-229: symmetric check — agent_id:"agent-B" returns ONLY agent-B content, never agent-A', async () => {
    const out = parseResult(await handleToolCall('memory_recall', {
      db_path: BL229_DB_PATH,
      agent_id: 'agent-B',
    }));
    const results = out['results'] as JsonObj[];
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r['agent_id']).toBe('agent-B');
    }
    expect(results.some((r) => r['content'] === AGENT_A_CONTENT)).toBe(false);
    expect(results.some((r) => r['content'] === AGENT_B_CONTENT)).toBe(true);
  });

  it('BL-229: negative control — an unscoped listing (no agent_id) DOES return both agents (proves the fixture + endpoint are otherwise working, isolating the assertion to the scoping behavior)', async () => {
    const out = parseResult(await handleToolCall('memory_recall', { db_path: BL229_DB_PATH }));
    const results = out['results'] as JsonObj[];
    const authors = new Set(results.map((r) => r['agent_id']));
    expect(authors.has('agent-A')).toBe(true);
    expect(authors.has('agent-B')).toBe(true);
  });
});

describe('memory_list_entities (C2.5)', () => {
  it('returns entities array with required fields', async () => {
    const out = parseResult(await handleToolCall('memory_list_entities', { db_path: DB_PATH }));
    const entities = out['entities'] as JsonObj[];
    expect(Array.isArray(entities)).toBe(true);
    expect(typeof out['total']).toBe('number');

    for (const e of entities) {
      expect(typeof e['uid']).toBe('string');
      expect(typeof e['name']).toBe('string');
      expect(typeof e['mention_count']).toBe('number');
      expect(typeof e['first_seen']).toBe('string');
      expect(typeof e['last_seen']).toBe('string');
    }
  });

  it('entities are sorted by mention_count DESC', async () => {
    const out = parseResult(await handleToolCall('memory_list_entities', { db_path: DB_PATH }));
    const entities = out['entities'] as JsonObj[];
    const counts = entities.map((e) => e['mention_count'] as number);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('search filter by name substring', async () => {
    const out = parseResult(await handleToolCall('memory_list_entities', {
      db_path: DB_PATH,
      search: 'type',
    }));
    const entities = out['entities'] as JsonObj[];
    for (const e of entities) {
      expect((e['name'] as string).toLowerCase()).toContain('type');
    }
  });
});

describe('memory_stats (C2.12)', () => {
  it('reports capability presence by tool NAME, not a tool_version semver (ADR-0003)', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    // tool_version is gone — replaced by the registered tool-name surface.
    expect(out).not.toHaveProperty('tool_version');
    const tools = out['tools'] as string[];
    expect(Array.isArray(tools)).toBe(true);
    // The v1.1 capability is detected by the tool's presence, not a version string.
    expect(tools).toContain('memory_update');
    expect(tools).toContain('memory_ping');
  });

  it('returns all required C2.12 fields', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(typeof out['enrich_version']).toBe('string');
    expect(typeof out['embed_model']).toBe('string');
    expect(typeof out['total_episodes']).toBe('number');
    expect(typeof out['with_topic']).toBe('number');
    expect(typeof out['with_summary']).toBe('number');
    expect(typeof out['with_tags']).toBe('number');
    expect(typeof out['with_project_path']).toBe('number');
    expect(typeof out['with_community']).toBe('number');
    expect(typeof out['legacy_episodes']).toBe('number');
    expect(typeof out['stale_episodes']).toBe('number');
    expect(typeof out['cluster_count']).toBe('number');
    expect(typeof out['largest_cluster_size']).toBe('number');
    expect(typeof out['mean_intra_cluster_sim']).toBe('number');
    expect(typeof out['coverage']).toBe('number');
    expect(typeof out['cluster_quality']).toBe('object');
  });

  it('total_episodes matches written count', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(out['total_episodes']).toBe(4);
  });

  it('with_topic = 4 (all writes supplied topic)', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(out['with_topic']).toBe(4);
  });

  it('with_tags = 4 (all writes supplied tags)', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(out['with_tags']).toBe(4);
  });

  it('with_project_path = 4 (all writes supplied project_path)', async () => {
    const out = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(out['with_project_path']).toBe(4);
  });

  it('project_path filter scopes stats to one project', async () => {
    const out = parseResult(await handleToolCall('memory_stats', {
      db_path: DB_PATH,
      project_path: '/home/user/projects/db-project',
    }));
    expect(out['total_episodes']).toBe(1);
  });
});

describe('memory_curate (C2.11)', () => {
  it('set_topic changes topic and reports old/new', async () => {
    const uid = uids[1]; // SQLite episode with topic 'databases'
    if (!uid) return;

    const out = parseResult(await handleToolCall('memory_curate', {
      db_path: DB_PATH,
      op: 'set_topic',
      uid,
      topic: 'storage',
    }));
    expect(out['op']).toBe('set_topic');
    expect(out['uid']).toBe(uid);
    expect(out['old_topic']).toBe('databases');
    expect(out['new_topic']).toBe('storage');

    // Verify it persisted
    const topicsOut = parseResult(await handleToolCall('memory_topics', { db_path: DB_PATH }));
    const topics = (topicsOut['topics'] as JsonObj[]).map((t) => t['topic'] as string);
    expect(topics).toContain('storage');
    expect(topics).not.toContain('databases');
  });

  it('retag adds tags additively and reports added tags', async () => {
    const uid = uids[0]; // typescript episode
    if (!uid) return;

    const out = parseResult(await handleToolCall('memory_curate', {
      db_path: DB_PATH,
      op: 'retag',
      uid,
      tags: ['type-safety', 'compiler'], // 'compiler' is a duplicate, should be ignored
    }));
    expect(out['op']).toBe('retag');
    expect(out['uid']).toBe(uid);
    // Only new tags reported
    const added = out['tags_added'] as string[];
    expect(added).toContain('type-safety');
    expect(added).not.toContain('compiler'); // already present — not re-added
  });

  it('set_importance persists override and marks user_override', async () => {
    const uid = uids[2]; // nodejs episode
    if (!uid) return;

    const out = parseResult(await handleToolCall('memory_curate', {
      db_path: DB_PATH,
      op: 'set_importance',
      uid,
      importance: 8,
    }));
    expect(out['op']).toBe('set_importance');
    expect(out['new_importance']).toBe(8);

    // Verify it shows up in stats — episode is now high importance
    const adapter = await openDb(DB_PATH);
    const row = (adapter.unwrap() as Database.Database).prepare<[string], { importance: number; enrich_ver: string | null }>(
      `SELECT importance, enrich_ver FROM node WHERE uid = ?`,
    ).get(uid);
    expect(row?.importance).toBe(8);
    if (row?.enrich_ver) {
      const ev = JSON.parse(row.enrich_ver) as { note?: string };
      expect(ev.note).toBe('user_override');
    }
  });

  it('recluster dry_run returns enqueued: false without writing', async () => {
    const out = parseResult(await handleToolCall('memory_curate', {
      db_path: DB_PATH,
      op: 'recluster',
      dry_run: true,
    }));
    expect(out['op']).toBe('recluster');
    expect(out['enqueued']).toBe(false);
    expect(out['dry_run']).toBe(true);
  });

  it('merge_duplicates invalidates uid_drop and creates SAME_AS edge', async () => {
    const uidKeep = uids[0];
    const uidDrop = uids[3]; // second typescript episode
    if (!uidKeep || !uidDrop) return;

    const out = parseResult(await handleToolCall('memory_curate', {
      db_path: DB_PATH,
      op: 'merge_duplicates',
      uid_keep: uidKeep,
      uid_drop: uidDrop,
    }));
    expect(out['op']).toBe('merge_duplicates');
    expect(out['uid_kept']).toBe(uidKeep);
    expect(out['uid_dropped']).toBe(uidDrop);
    expect(out['dry_run']).toBe(false);

    // uid_drop should now be invalidated
    const adapter = await openDb(DB_PATH);
    const dropped = (adapter.unwrap() as Database.Database).prepare<[string], { t_invalid: string | null }>(
      `SELECT t_invalid FROM node WHERE uid = ?`,
    ).get(uidDrop);
    expect(dropped?.t_invalid).not.toBeNull();
  });
});

describe('memory_supersession_chain (C2.9)', () => {
  it('returns chain for a standalone episode', async () => {
    const uid = uids[0];
    if (!uid) return;

    const out = parseResult(await handleToolCall('memory_supersession_chain', {
      db_path: DB_PATH,
      uid,
    }));
    expect(typeof out['canonical_uid']).toBe('string');
    expect(Array.isArray(out['chain'])).toBe(true);
    expect(typeof out['is_current']).toBe('boolean');

    const chain = out['chain'] as JsonObj[];
    expect(chain.length).toBeGreaterThanOrEqual(1);
    for (const link of chain) {
      expect(typeof link['uid']).toBe('string');
      expect(typeof link['t_created']).toBe('string');
      expect('t_invalid' in link).toBe(true);
      expect('reason' in link).toBe(true);
    }
  });
});

describe('memory_near_duplicates (C2.10)', () => {
  it('returns pairs array and total', async () => {
    const out = parseResult(await handleToolCall('memory_near_duplicates', { db_path: DB_PATH }));
    expect(Array.isArray(out['pairs'])).toBe(true);
    expect(typeof out['total']).toBe('number');
  });

  it('pairs have required C2.10 shape', async () => {
    const out = parseResult(await handleToolCall('memory_near_duplicates', { db_path: DB_PATH }));
    const pairs = out['pairs'] as JsonObj[];
    for (const p of pairs) {
      expect(typeof p['uid_a']).toBe('string');
      expect(typeof p['uid_b']).toBe('string');
      expect(typeof p['cosine_sim']).toBe('number');
      expect(typeof p['content_preview_a']).toBe('string');
      expect(typeof p['content_preview_b']).toBe('string');
      expect(typeof p['already_merged']).toBe('boolean');
      // previews are truncated at 120 chars
      expect((p['content_preview_a'] as string).length).toBeLessThanOrEqual(120);
      expect((p['content_preview_b'] as string).length).toBeLessThanOrEqual(120);
    }
  });
});

describe('memory_get_community v1 (C2.6)', () => {
  it('community_uid direct lookup returns v1 shape', async () => {
    // Fetch a community uid from stats first
    const statsOut = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    if ((statsOut['cluster_count'] as number) === 0) {
      // No clusters formed with hash backend at this scale — skip gracefully
      return;
    }

    // Get a community_uid from topics
    const topicsOut = parseResult(await handleToolCall('memory_topics', { db_path: DB_PATH }));
    const topics = topicsOut['topics'] as JsonObj[];
    const withCommunity = topics.find((t) => t['community_uid'] !== null);
    if (!withCommunity) return; // no communities formed yet

    const communityUid = withCommunity['community_uid'] as string;
    const out = parseResult(await handleToolCall('memory_get_community', {
      db_path: DB_PATH,
      community_uid: communityUid,
    }));

    const community = out['community'] as JsonObj;
    expect(typeof community['uid']).toBe('string');
    expect(typeof community['label']).toBe('string');
    expect(typeof community['member_count']).toBe('number');
    expect(typeof community['mean_intra_sim']).toBe('number');
    expect(typeof community['t_created']).toBe('string');

    const members = out['members'] as JsonObj[];
    expect(Array.isArray(members)).toBe(true);
    for (const m of members) {
      expect(typeof m['uid']).toBe('string');
      expect('summary' in m).toBe(true);
      expect('topic' in m).toBe(true);
      expect(typeof m['importance']).toBe('number');
      expect(typeof m['t_created']).toBe('string');
      expect(Array.isArray(m['tags'])).toBe(true);
    }
  });

  it('supplying both entity_uid and community_uid returns E_AMBIGUOUS', async () => {
    const result = await handleToolCall('memory_get_community', {
      db_path: DB_PATH,
      entity_uid: 'ep-1',
      community_uid: 'comm-1',
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ code: 'E_AMBIGUOUS' });
  });
});

describe('backward compat — existing tools unbroken', () => {
  it('memory_ping returns the content address (ADR-0003 Decision 5)', async () => {
    const out = parseResult(await handleToolCall('memory_ping', {}));
    expect(out['ok']).toBe(true);
    expect(out['id']).toBe('memory-server');
    // artifact is the full sha256 content address of the running entrypoint.
    expect(out['artifact']).toMatch(/^sha256:[0-9a-f]{64}$/);
    // short is the first 12 hex of that digest.
    expect(out['short']).toMatch(/^[0-9a-f]{12}$/);
    expect((out['artifact'] as string)).toContain(out['short'] as string);
    // host_compat survives the version purge (a different axis).
    expect(typeof out['host_compat']).toBe('string');
    expect((out['host_compat'] as string).length).toBeGreaterThan(0);
  });

  it('memory_write still returns episode_uid', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: 'Backward compat test episode.',
      project_path: '/test/project',
    });
    // May be E_DEDUP if content matches; either way, no isError
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { episode_uid?: string; code?: string };
    expect(
      typeof parsed.episode_uid === 'string' || parsed.code === 'E_DEDUP',
    ).toBe(true);
  });
});

// ── memory_curate recluster — filtered (synchronous subset) wiring ───────────────
// The deep clustering / scoped-persist / UID-collision correctness is covered by
// the unit tests in @adhd/sox-memory-core (cluster-subset.spec.ts) with controlled
// embeddings. These integration tests verify only the SERVER WIRING: that
// `recluster` with `filters` routes to the synchronous subset path, selects the
// right candidate set, honours dry_run for persistence, and returns the generic
// response shape. The server carries no knowledge of what the tags mean.

describe('memory_curate recluster — filtered subset', () => {
  const UNIQ = 'synthtest';
  // Two deliberately DISSIMILAR episodes sharing a unique tag, so neither the
  // shared seed nor near-dup-on-write (E8) collapses them — the subset is a
  // stable 2.
  beforeAll(async () => {
    await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: 'Calibration of the pneumatic widget press requires a torque of forty newton metres.',
      tags: [UNIQ, 'alpha'],
      project_path: '/test/project',
    });
    await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: 'Migratory albatross navigation relies on geomagnetic field gradients over open ocean.',
      tags: [UNIQ, 'beta'],
      project_path: '/test/project',
    });
  });

  it('selects only episodes matching the filter and is read-only under dry_run', async () => {
    const out = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH,
        op: 'recluster',
        filters: { tags: [UNIQ] },
        dry_run: true,
      }),
    );
    expect(out['op']).toBe('recluster');
    expect(out['scope']).toBe('subset');
    expect(out['dry_run']).toBe(true);
    expect(out['persisted']).toBe(false); // dry_run never writes
    expect(out['candidate_count']).toBe(2); // the two uniquely-tagged episodes
    expect(typeof out['provenance_hash']).toBe('string');
    expect((out['provenance_hash'] as string).length).toBeGreaterThan(0);
    expect(Array.isArray(out['clusters'])).toBe(true);
  });

  it('treats the filter as an opaque predicate (non-matching filter → empty subset)', async () => {
    const out = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH,
        op: 'recluster',
        filters: { tags: ['no-such-tag-xyz'] },
        dry_run: true,
      }),
    );
    expect(out['candidate_count']).toBe(0);
    expect(out['cluster_count']).toBe(0);
  });

  it('derives a stable provenance hash for the same filter', async () => {
    const a = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH, op: 'recluster', filters: { tags: [UNIQ] }, dry_run: true,
      }),
    );
    const b = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH, op: 'recluster', filters: { tags: [UNIQ] }, dry_run: true,
      }),
    );
    expect(a['provenance_hash']).toBe(b['provenance_hash']);
  });

  it('no filters → unchanged global behaviour (daemon enqueue, not subset)', async () => {
    const out = parseResult(
      await handleToolCall('memory_curate', { db_path: DB_PATH, op: 'recluster', dry_run: true }),
    );
    // Global path reports enqueue semantics, never the subset shape.
    expect(out['scope']).toBeUndefined();
    expect(out).toHaveProperty('enqueued');
  });

  it('dry_run:false persists the subset and leaves global communities intact (BL-27 LOW-3)', async () => {
    // Capture the global cluster_count before the persist.
    const statsBefore = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    const globalCountBefore = statsBefore['cluster_count'] as number;

    // Persist the subset — response must declare persisted:true.
    const out = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH,
        op: 'recluster',
        filters: { tags: [UNIQ] },
        dry_run: false,
      }),
    );
    expect(out['op']).toBe('recluster');
    expect(out['scope']).toBe('subset');
    expect(out['persisted']).toBe(true);
    expect(out['dry_run']).toBe(false);
    expect(typeof out['provenance_hash']).toBe('string');

    // Global stats must be unchanged — subset communities must not inflate global count.
    const statsAfter = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(statsAfter['cluster_count']).toBe(globalCountBefore);

    // Use list_lenses to confirm the lens is visible.
    const lensesOut = parseResult(
      await handleToolCall('memory_curate', { db_path: DB_PATH, op: 'list_lenses' }),
    );
    expect(lensesOut['op']).toBe('list_lenses');
    const lenses = lensesOut['lenses'] as Array<{ provenance_hash: string }>;
    expect(lenses.some((l) => l.provenance_hash === out['provenance_hash'])).toBe(true);

    // Drop the lens and confirm it's gone.
    const dropOut = parseResult(
      await handleToolCall('memory_curate', {
        db_path: DB_PATH,
        op: 'drop_lens',
        provenance_hash: out['provenance_hash'] as string,
      }),
    );
    expect(dropOut['op']).toBe('drop_lens');
    expect(dropOut['communities_dropped']).toBeGreaterThan(0);

    // After drop, global stats still unchanged.
    const statsPostDrop = parseResult(await handleToolCall('memory_stats', { db_path: DB_PATH }));
    expect(statsPostDrop['cluster_count']).toBe(globalCountBefore);
  });
});

// ── Fix ①: server-level scope isolation ──────────────────────────────────────
// After persisting a subset lens, the global-scoped read paths (memory_stats)
// must NOT be influenced by the subset communities.
//
// We write directly to the DB (bypassing handleToolCall memoryWrite) to avoid
// triggering the near-dup code path in enrich.ts which has a pre-existing
// column-count bug unrelated to this feature.

describe('read-path scope isolation at server layer (fix ①)', () => {
  let ISO_DB_PATH: string;
  let isoDir: string;

  beforeAll(async () => {
    isoDir = path.join(os.tmpdir(), `sox-iso-spec-${process.pid}`);
    fs.mkdirSync(isoDir, { recursive: true });
    ISO_DB_PATH = path.join(isoDir, 'iso.db');

    // Open DB directly (bypasses memoryWrite near-dup path) and insert raw episodes.
    const isoDb = await openDb(ISO_DB_PATH);
    const raw = isoDb.unwrap() as Database.Database;
    const now = new Date().toISOString();
    type InsRow = { rowid: number };
    const ins = (content: string, tags: string[]): number => {
      const uid = `iso-ep-${Math.random().toString(36).slice(2)}`;
      return (raw.prepare<unknown[], InsRow>(
        `INSERT INTO node (uid, kind, content, t_created, t_valid, tags) VALUES (?, 'episode', ?, ?, ?, ?) RETURNING rowid`,
      ).get(uid, content, now, now, JSON.stringify(tags)) as InsRow).rowid;
    };
    // Insert 4 episodes: 2 iso:A, 2 iso:B. Content is long and lexically distinct
    // so hash embeddings don't collide at the 0.98 near-dup threshold.
    const r0 = ins('Aerobic respiration in eukaryotic cells produces adenosine triphosphate via the citric acid cycle and oxidative phosphorylation in mitochondria.', ['iso:A']);
    const r1 = ins('Plate tectonics describes the movement of lithospheric plates driven by mantle convection and ridge push and slab pull forces.', ['iso:A']);
    const r2 = ins('The Fourier transform decomposes a signal into its constituent sinusoidal frequency components represented as complex amplitudes.', ['iso:B']);
    const r3 = ins('A Byzantine fault tolerant consensus algorithm requires at least three f plus one nodes to tolerate f simultaneous Byzantine failures.', ['iso:B']);

    // Insert synthetic hash embeddings (group-orthogonal so they cluster correctly).
    const encodeVec = (group: number): string => {
      const v = new Float32Array(768);
      for (let i = 0; i < 100; i++) v[group * 100 + i] = 1;
      let norm = 0;
      for (let i = 0; i < 768; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm);
      for (let i = 0; i < 768; i++) v[i] = v[i]! / norm;
      return '[' + Array.from(v).map((x) => x.toFixed(8)).join(',') + ']';
    };
    for (const [rowid, g] of [[r0, 0], [r1, 0], [r2, 1], [r3, 1]] as [number, number][]) {
      raw.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(rowid, encodeVec(g));
    }

    // Run a global cluster pass — 2 communities (iso:A group, iso:B group).
    await clusterStore(isoDb);
    raw.close();
  });

  afterAll(() => {
    try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('memory_stats cluster_count unchanged after subset persist', async () => {
    // Capture global stats before persisting a subset.
    const before = parseResult(await handleToolCall('memory_stats', { db_path: ISO_DB_PATH }));
    const clusterCountBefore = before['cluster_count'] as number;
    expect(clusterCountBefore).toBeGreaterThan(0); // sanity: global pass ran

    // Persist a subset lens for iso:A.
    await handleToolCall('memory_curate', {
      db_path: ISO_DB_PATH, op: 'recluster',
      filters: { tags: ['iso:A'] }, dry_run: false,
    });

    // Global stats must be unchanged — subset communities must not inflate count.
    const after = parseResult(await handleToolCall('memory_stats', { db_path: ISO_DB_PATH }));
    expect(after['cluster_count']).toBe(clusterCountBefore);
  });

  it('memory_stats with_community unchanged after subset persist', async () => {
    const before = parseResult(await handleToolCall('memory_stats', { db_path: ISO_DB_PATH }));
    const withCommunityBefore = before['with_community'] as number;

    // Re-persist the same subset (idempotent).
    await handleToolCall('memory_curate', {
      db_path: ISO_DB_PATH, op: 'recluster',
      filters: { tags: ['iso:A'] }, dry_run: false,
    });

    const after = parseResult(await handleToolCall('memory_stats', { db_path: ISO_DB_PATH }));
    // Episodes in a subset community must not be counted in the global with_community stat.
    // The count must not grow beyond what the global pass established.
    expect(after['with_community']).toBeLessThanOrEqual(withCommunityBefore);
  });
});

// ── memory_update (CONTRACTS.md C2.15) ───────────────────────────────────────

describe('memory_update MCP tool', () => {
  const UPDATE_DIR = path.join(os.tmpdir(), `sox-mcp-update-${process.pid}`);
  const UPDATE_DB = path.join(UPDATE_DIR, 'update.db');

  beforeAll(() => {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
  });

  it('returns E_NOT_FOUND for an unknown uid', async () => {
    const result = await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      uid: '01JXNONEXISTENT',
      content: 'new',
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(body['code']).toBe('E_NOT_FOUND');
  });

  it('returns E_MISSING when uid not provided', async () => {
    const result = await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      content: 'oops',
    });
    expect(result.isError).toBe(true);
  });

  it('updates content and reports reembedded:true', async () => {
    // Write a fresh episode
    const wr = await handleToolCall('memory_write', {
      db_path: UPDATE_DB,
      content: 'initial mcp content',
      project_path: '/test/project',
    });
    const wrBody = parseResult(wr);
    const uid = wrBody['episode_uid'] as string;

    const result = await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      uid,
      content: 'updated mcp content',
    });
    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body['uid']).toBe(uid);
    expect((body['updated_fields'] as string[])).toContain('content');
    expect(body['reembedded']).toBe(true);
  });

  it('updates name, topic, importance (no re-embed)', async () => {
    const wr = await handleToolCall('memory_write', {
      db_path: UPDATE_DB,
      content: 'mcp field update test',
      name: 'old name',
      topic: 'old-topic',
      importance: 2,
      project_path: '/test/project',
    });
    const uid = (parseResult(wr))['episode_uid'] as string;

    const result = await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      uid,
      name: 'new name',
      topic: 'new-topic',
      importance: 9,
    });
    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body['reembedded']).toBe(false);
    const fields = body['updated_fields'] as string[];
    expect(fields).toContain('name');
    expect(fields).toContain('topic');
    expect(fields).toContain('importance');
  });

  it('deep-merges metadata by default', async () => {
    const wr = await handleToolCall('memory_write', {
      db_path: UPDATE_DB,
      content: 'mcp meta test',
      metadata: { a: { x: 1 }, list: [1, 2, 3] },
      project_path: '/test/project',
    });
    const uid = (parseResult(wr))['episode_uid'] as string;

    const result = await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      uid,
      metadata: { a: { y: 2 }, list: [4, 5] },
      // metadata_merge defaults to 'deep'
    });
    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body['reembedded']).toBe(false);
    expect((body['updated_fields'] as string[])).toContain('meta');

    // Verify DB state by reading back via a recall
    const adapter = await openDb(UPDATE_DB);
    const raw = adapter.unwrap() as Database.Database;
    const row = raw
      .prepare<[string], { meta: string | null }>(`SELECT meta FROM node WHERE uid = ?`)
      .get(uid);
    raw.close();
    const meta = JSON.parse(row!.meta!) as Record<string, unknown>;
    expect(meta['a']).toEqual({ x: 1, y: 2 });
    expect(meta['list']).toEqual([4, 5]);
  });

  it("metadata_merge:'replace' overwrites meta wholesale", async () => {
    const wr = await handleToolCall('memory_write', {
      db_path: UPDATE_DB,
      content: 'mcp meta replace test',
      metadata: { old: true, nested: { deep: 1 } },
      project_path: '/test/project',
    });
    const uid = (parseResult(wr))['episode_uid'] as string;

    await handleToolCall('memory_update', {
      db_path: UPDATE_DB,
      uid,
      metadata: { brand_new: 42 },
      metadata_merge: 'replace',
    });

    const adapter2 = await openDb(UPDATE_DB);
    const raw2 = adapter2.unwrap() as Database.Database;
    const row = raw2
      .prepare<[string], { meta: string | null }>(`SELECT meta FROM node WHERE uid = ?`)
      .get(uid);
    raw2.close();
    const meta = JSON.parse(row!.meta!) as Record<string, unknown>;
    expect(meta).toEqual({ brand_new: 42 });
    expect('old' in meta).toBe(false);
  });

  it('memory_stats still reports the memory_update capability by tool name after update ops', async () => {
    const statsResult = await handleToolCall('memory_stats', { db_path: UPDATE_DB });
    const stats = parseResult(statsResult);
    expect(stats).not.toHaveProperty('tool_version');
    expect(stats['tools']).toContain('memory_update');
  });
});
