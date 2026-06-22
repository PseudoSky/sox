/**
 * DB→markdown export mirror for sox-memory.
 *
 * Renders live episode nodes to a topic-organised directory tree so that
 * memory written via `memory_write` has a git-reviewable, auditable
 * representation on disk.
 *
 * Layout:
 *   <dir>/INDEX.md                       — top-level topic list
 *   <dir>/topics/<slug>/INDEX.md         — per-topic node list (importance desc, recency)
 *   <dir>/topics/<slug>/<uid>.md         — one file per episode
 *
 * Topic derivation (TOPIC-BASED, not agent-based):
 *   1. community the episode belongs to via MEMBER_OF edge (strongest link)
 *   2. first entity it MENTIONS via edge
 *   3. "general"
 *
 * Idempotency: keyed by uid (overwrite); stale files for invalidated/deleted
 * episodes are pruned on each run.
 *
 * Safety: only manages `<dir>/topics/**` and `<dir>/INDEX.md`.
 * Never touches other paths (e.g. `<dir>/principles/`).
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportOpts {
  /** Root directory to write the mirror into. */
  dir: string;
  /** When false, export is a no-op (returns zeros immediately). */
  enabled: boolean;
}

export interface ExportResult {
  nodesWritten: number;
  topics: number;
  dir: string;
}

interface EpisodeRow {
  rowid: number;
  uid: string;
  content: string | null;
  name: string | null;
  summary: string | null;
  source: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  session_id: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a topic name to a filesystem-safe slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')      // strip special chars
    .replace(/[\s_]+/g, '-')       // spaces → hyphens
    .replace(/-+/g, '-')           // collapse runs
    .replace(/^-+|-+$/g, '')       // trim edges
    .slice(0, 64)                  // cap length
    || 'general';
}

/** ISO timestamp for the generated-by header. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Derive a topic name for an episode.
 * Priority:
 *   1. an explicit `[<topic>]` prefix in the content — the author's intended topic and the
 *      dominant convention in written findings (e.g. "[acceptance-testing] …"). This is the
 *      most direct "topic-based" signal, so it wins.
 *   2. community the episode is a member of (MEMBER_OF) — organizer-derived cluster.
 *   3. first entity it MENTIONS.
 *   4. "general".
 */
function deriveTopicName(
  db: Database.Database,
  episodeRowid: number,
  content: string | null,
): { name: string; slug: string } {
  // First preference: an explicit `[<topic>]` prefix at the start of the content.
  const prefix = content?.match(/^\s*\[([^\]\n]{1,64})\]/);
  if (prefix && prefix[1] && prefix[1].trim()) {
    const name = prefix[1].trim();
    return { name, slug: slugify(name) };
  }

  // Next preference: community this episode is a member of
  const communityEdge = db
    .prepare<[number], { name: string | null; uid: string }>(
      `SELECT n.name, n.uid
       FROM edge e
       JOIN node n ON n.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'MEMBER_OF' AND n.kind = 'community'
         AND e.t_expired IS NULL AND n.t_invalid IS NULL
       LIMIT 1`,
    )
    .get(episodeRowid);

  if (communityEdge) {
    const name = communityEdge.name ?? 'general';
    return { name, slug: slugify(name) };
  }

  // Second preference: first entity this episode MENTIONS
  const mentionEdge = db
    .prepare<[number], { name: string | null; uid: string }>(
      `SELECT n.name, n.uid
       FROM edge e
       JOIN node n ON n.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'MENTIONS' AND n.kind = 'entity'
         AND e.t_expired IS NULL AND n.t_invalid IS NULL
       ORDER BY e.rowid ASC
       LIMIT 1`,
    )
    .get(episodeRowid);

  if (mentionEdge) {
    const name = mentionEdge.name ?? 'general';
    return { name, slug: slugify(name) };
  }

  return { name: 'general', slug: 'general' };
}

/**
 * Collect all entity uids this episode MENTIONS (for frontmatter).
 */
function collectMentionedEntities(
  db: Database.Database,
  episodeRowid: number,
): string[] {
  return db
    .prepare<[number], { uid: string }>(
      `SELECT n.uid
       FROM edge e
       JOIN node n ON n.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'MENTIONS' AND n.kind = 'entity'
         AND e.t_expired IS NULL AND n.t_invalid IS NULL
       ORDER BY e.rowid ASC`,
    )
    .all(episodeRowid)
    .map((r) => r.uid);
}

/**
 * Collect uids of nodes this episode is DERIVED_FROM or SUPERSEDES.
 */
function collectRelatedUids(
  db: Database.Database,
  episodeRowid: number,
  rel: 'DERIVED_FROM' | 'SUPERSEDES',
): string[] {
  return db
    .prepare<[number, string], { uid: string }>(
      `SELECT n.uid
       FROM edge e
       JOIN node n ON n.rowid = e.dst
       WHERE e.src = ? AND e.rel = ? AND e.t_expired IS NULL AND n.t_invalid IS NULL`,
    )
    .all(episodeRowid, rel)
    .map((r) => r.uid);
}

/**
 * Render YAML frontmatter for an episode file.
 * Uses block-scalar style for multi-line arrays to stay readable.
 */
function renderFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      // Scalar — quote strings that need it
      const str = String(value);
      const needsQuoting = str.includes(':') || str.includes('#') || str.includes('"') || str.startsWith(' ');
      lines.push(`${key}: ${needsQuoting ? `"${str.replace(/"/g, '\\"')}"` : str}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Render a single episode node to a markdown string.
 */
function renderEpisodeMarkdown(
  episode: EpisodeRow,
  entities: string[],
  derivedFrom: string[],
  supersedes: string[],
): string {
  const title = episode.name
    ?? episode.content?.split('\n')[0]?.slice(0, 72)
    ?? episode.uid;

  const frontmatter = renderFrontmatter({
    uid: episode.uid,
    kind: episode.source ?? 'episode',
    source: episode.source,
    importance: episode.importance,
    t_created: episode.t_created,
    agent_id: episode.agent_id,
    session_id: episode.session_id,
    entities: entities,
    derived_from: derivedFrom,
    supersedes: supersedes,
  });

  const body = episode.content ?? '';

  return `${frontmatter}\n\n# ${title}\n\n${body}\n`;
}

// ── Main export function ───────────────────────────────────────────────────────

/**
 * Export live episode nodes from `db` to a markdown mirror under `opts.dir`.
 *
 * Returns { nodesWritten, topics, dir }.
 * When opts.enabled is false, returns zeros without touching the filesystem.
 */
export function exportMarkdown(db: Database.Database, opts: ExportOpts): ExportResult {
  if (!opts.enabled) {
    return { nodesWritten: 0, topics: 0, dir: opts.dir };
  }

  const { dir } = opts;
  const topicsRoot = path.join(dir, 'topics');

  // ── Fetch live episodes ───────────────────────────────────────────────────
  const episodes = db
    .prepare<[], EpisodeRow>(
      `SELECT rowid, uid, content, name, summary, source, importance, t_created, agent_id, session_id
       FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL
       ORDER BY t_created ASC`,
    )
    .all();

  // ── Build topic → episodes mapping ────────────────────────────────────────
  // Maps slug → { name, episodes: EpisodeRow[] }
  const topicMap = new Map<string, { name: string; episodes: EpisodeRow[] }>();
  const episodeTopicSlug = new Map<string, string>(); // uid → slug

  for (const ep of episodes) {
    const { name: topicName, slug } = deriveTopicName(db, ep.rowid, ep.content);
    if (!topicMap.has(slug)) {
      topicMap.set(slug, { name: topicName, episodes: [] });
    }
    topicMap.get(slug)!.episodes.push(ep);
    episodeTopicSlug.set(ep.uid, slug);
  }

  // ── Ensure directories exist ──────────────────────────────────────────────
  // Only create the topics subtree — never mkdir anything outside <dir>/topics
  fs.mkdirSync(topicsRoot, { recursive: true });
  for (const slug of topicMap.keys()) {
    fs.mkdirSync(path.join(topicsRoot, slug), { recursive: true });
  }

  // ── Write episode files ───────────────────────────────────────────────────
  let nodesWritten = 0;

  for (const ep of episodes) {
    const slug = episodeTopicSlug.get(ep.uid)!;
    const entities = collectMentionedEntities(db, ep.rowid);
    const derivedFrom = collectRelatedUids(db, ep.rowid, 'DERIVED_FROM');
    const supersedes = collectRelatedUids(db, ep.rowid, 'SUPERSEDES');

    const content = renderEpisodeMarkdown(ep, entities, derivedFrom, supersedes);
    const destPath = path.join(topicsRoot, slug, `${ep.uid}.md`);
    fs.writeFileSync(destPath, content, 'utf8');
    nodesWritten++;
  }

  // ── Prune stale files ─────────────────────────────────────────────────────
  // Walk topics/** and delete .md files whose uid (basename without .md) is no longer live.
  // Only manages files under <dir>/topics/ — never touches anything else.
  if (fs.existsSync(topicsRoot)) {
    const topicDirs = fs.readdirSync(topicsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const topicDir of topicDirs) {
      const topicPath = path.join(topicsRoot, topicDir);
      const files = fs.readdirSync(topicPath).filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
      for (const file of files) {
        const uid = file.slice(0, -3); // strip .md
        // A file is valid only if this uid's CURRENT topic slug is this directory.
        // Prune if the uid is dead (not exported) OR has MOVED to a different topic
        // (otherwise re-categorising a node would leave a stale copy in its old topic).
        if (episodeTopicSlug.get(uid) !== topicDir) {
          fs.unlinkSync(path.join(topicPath, file));
        }
      }
      // Remove now-empty topic directories (only if all episode files pruned + no INDEX.md yet)
      const remaining = fs.readdirSync(topicPath).filter((f) => f !== 'INDEX.md');
      if (remaining.length === 0 && !topicMap.has(topicDir)) {
        // Will clean up INDEX.md too since topic is fully gone
        const indexPath = path.join(topicPath, 'INDEX.md');
        if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
        fs.rmdirSync(topicPath);
      }
    }
  }

  // ── Write per-topic INDEX.md ──────────────────────────────────────────────
  const genTimestamp = nowIso();

  for (const [slug, { name: topicName, episodes: topicEpisodes }] of topicMap) {
    // Sort: importance desc, then recency desc
    const sorted = [...topicEpisodes].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.t_created.localeCompare(a.t_created);
    });

    const rows = sorted.map((ep) => {
      const title = ep.name
        ?? ep.content?.split('\n')[0]?.slice(0, 60)
        ?? ep.uid;
      const importanceStr = ep.importance.toFixed(1);
      const created = ep.t_created.slice(0, 10);
      return `| [${title}](./${ep.uid}.md) | ${importanceStr} | ${created} |`;
    });

    const indexContent = [
      `<!-- generated by sox-memory export at ${genTimestamp} -->`,
      `# Topic: ${topicName}`,
      '',
      `${topicEpisodes.length} episode(s).`,
      '',
      '| Title | Importance | Date |',
      '|-------|-----------|------|',
      ...rows,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(topicsRoot, slug, 'INDEX.md'), indexContent, 'utf8');
  }

  // ── Write top-level INDEX.md ──────────────────────────────────────────────
  // Sorted by node count desc
  const topicsSorted = [...topicMap.entries()].sort(
    ([, a], [, b]) => b.episodes.length - a.episodes.length,
  );

  const lastUpdated = episodes.length > 0
    ? episodes.reduce((latest, ep) =>
        ep.t_created > latest ? ep.t_created : latest,
        episodes[0]!.t_created,
      ).slice(0, 10)
    : genTimestamp.slice(0, 10);

  const topicRows = topicsSorted.map(([slug, { name, episodes: topicEpisodes }]) => {
    const count = topicEpisodes.length;
    const newest = topicEpisodes
      .map((e) => e.t_created)
      .sort()
      .pop()
      ?.slice(0, 10) ?? '';
    return `| [${name}](./topics/${slug}/INDEX.md) | ${count} | ${newest} |`;
  });

  const indexContent = [
    `<!-- generated by sox-memory export at ${genTimestamp} -->`,
    '# Memory Export Index',
    '',
    `**Last updated:** ${lastUpdated}  `,
    `**Total episodes:** ${episodes.length}  `,
    `**Topics:** ${topicMap.size}`,
    '',
    '| Topic | Nodes | Last Updated |',
    '|-------|-------|-------------|',
    ...topicRows,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'INDEX.md'), indexContent, 'utf8');

  return { nodesWritten, topics: topicMap.size, dir };
}
