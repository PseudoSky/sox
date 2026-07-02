/**
 * Client — MCP-agnostic backing logic for the memory-server tools.
 *
 * Each tool file exports:
 *   - `inputSchema` — the exact JSON Schema object from the TOOLS array
 *   - An async function accepting `(db: Database.Database, args: Record<string, unknown>)`
 *     that returns a plain result object (NOT an MCP ToolResult).
 *   - Result types for the return shape.
 *
 * Shared utilities (db.ts) provide connection caching, tilde expansion, tag
 * parsing, and enrichment helper queries (isSuperseded, rowidsToUids, etc.).
 *
 * [inv:no-mcp] — no imports from @adhd/sox-mcp-runtime, no ToolResult wrapping.
 */

// ── Shared utilities ──────────────────────────────────────────────────────────
export type { Database } from 'better-sqlite3';
export {
  getDb,
  expandTilde,
  parseTags,
  isSuperseded,
  supersedesUidForRowid,
  communityUidForRowid,
  rowidsToUids,
} from './db.js';

// ── Ping ──────────────────────────────────────────────────────────────────────
export { pingMemory, inputSchema as pingSchema } from './ping.js';
export type { PingResult } from './ping.js';

// ── Write ─────────────────────────────────────────────────────────────────────
export { writeMemory, inputSchema as writeMemorySchema } from './write.js';
export type { WriteMemoryResult, WriteResult, WriteError } from './write.js';

// ── Recall ────────────────────────────────────────────────────────────────────
export { recallMemory, inputSchema as recallSchema } from './recall.js';
export type { RecallResult, RecallEpisode } from './recall.js';

// ── Search entities ───────────────────────────────────────────────────────────
export { searchEntities, inputSchema as searchEntitiesSchema } from './search-entities.js';
export type { SearchEntitiesResult, EntityEntry } from './search-entities.js';

// ── Session state ─────────────────────────────────────────────────────────────
export { getSessionState, inputSchema as getSessionStateSchema } from './get-session-state.js';
export type { GetSessionStateResult } from './get-session-state.js';
export { saveSessionState, inputSchema as saveSessionStateSchema } from './save-session-state.js';
export type { SaveSessionStateResult } from './save-session-state.js';

// ── Community ─────────────────────────────────────────────────────────────────
export { getCommunity, inputSchema as getCommunitySchema } from './get-community.js';
export type { GetCommunityResult, CommunityInfo, MemberSummary } from './get-community.js';

// ── Invalidate ────────────────────────────────────────────────────────────────
export { invalidateClaim, inputSchema as invalidateSchema } from './invalidate.js';
export type { InvalidateResult } from './invalidate.js';

// ── Update ────────────────────────────────────────────────────────────────────
export { updateMemory, inputSchema as updateSchema } from './update.js';
export type { UpdateMemoryResult, UpdateResult, UpdateError } from './update.js';

// ── Link ──────────────────────────────────────────────────────────────────────
export { linkNodes, inputSchema as linkSchema } from './link.js';
export type { LinkResult } from './link.js';

// ── Topics ────────────────────────────────────────────────────────────────────
export { listTopics, inputSchema as topicsSchema } from './topics.js';
export type { TopicsResult, TopicEntry } from './topics.js';

// ── List projects ─────────────────────────────────────────────────────────────
export { listProjects, inputSchema as listProjectsSchema } from './list-projects.js';
export type { ListProjectsResult, ProjectEntry } from './list-projects.js';

// ── List entities ─────────────────────────────────────────────────────────────
export { listEntities, inputSchema as listEntitiesSchema } from './list-entities.js';
export type { ListEntitiesResult, EntityListingEntry } from './list-entities.js';

// ── Entity episodes ───────────────────────────────────────────────────────────
export { getEntityEpisodes, inputSchema as entityEpisodesSchema } from './entity-episodes.js';
export type { EntityEpisodesResult, EntityInfo, EpisodeSummary } from './entity-episodes.js';

// ── Related ───────────────────────────────────────────────────────────────────
export { getRelated, inputSchema as relatedSchema } from './related.js';
export type { RelatedResult, EdgeEntry, EpisodeBase } from './related.js';

// ── Supersession chain ────────────────────────────────────────────────────────
export { getSupersessionChain, inputSchema as supersessionChainSchema } from './supersession-chain.js';
export type { SupersessionChainResult, ChainLink } from './supersession-chain.js';

// ── Near duplicates ───────────────────────────────────────────────────────────
export { getNearDuplicates, inputSchema as nearDuplicatesSchema } from './near-duplicates.js';
export type { NearDuplicatesResult, NearDuplicatePair } from './near-duplicates.js';

// ── Curate ────────────────────────────────────────────────────────────────────
export { curate, inputSchema as curateSchema } from './curate.js';
export type {
  CurateResult,
  CurateRetagResult,
  CurateSetTopicResult,
  CurateSetImportanceResult,
  CurateMergeResult,
  CurateReclusterSubsetResult,
  CurateReclusterGlobalResult,
  CurateDropLensResult,
  CurateListLensesResult,
} from './curate.js';

// ── Stats ─────────────────────────────────────────────────────────────────────
export { getStats, inputSchema as statsSchema } from './stats.js';
export type { StatsResult } from './stats.js';
