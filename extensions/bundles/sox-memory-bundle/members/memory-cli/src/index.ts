/**
 * Memory CLI — memory init|import|status|list|promote|registry|export|fts-optimize|fts-rebuild|restore
 * Deterministic: no LLM calls, predictable output.
 *
 * P3: multi-scope with registry.json.
 *
 * Usage:
 *   memory init [--scope project|user|org|local] [--path DIR]
 *   memory status [--path DIR]
 *   memory list [--path DIR]
 *   memory registry
 *   memory export [--scope <s>] [--base-path <p>] [--dir <path>] [--db <path>]
 *
 * Scope → default store path (design.md §2.1):
 *   project  → <cwd>/.memory/project.db
 *   user     → ~/.memory/user.db
 *   org      → ~/.memory/org.db
 *   local    → <cwd>/.memory/local.db
 *
 * Export config resolution (highest precedence first):
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 *   --db  flag  >  SOX_CONFIG_DB_PATH env var     >  resolveDbPath(scope, basePath)
 *   export_enabled: --enabled/--no-enabled flag  >  SOX_CONFIG_EXPORT_ENABLED env var  >  true
 */

import {
  exportMarkdown,
  initScope,
  openDb,
  reembedStore,
  writeRegistry,
  backupStore,
  isBackupStoreError,
  runCompactionPass,
  // BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001: pipeline status/drain/reset/resume.
  memoryCurate,
  WriteQueue,
  readEnrichHealthLedger,
  computePipelineHealthVerdict,
  readEnrichAlarm,
  countPoisonedRows,
  embedBacklogStats,
} from '@adhd/sox-memory-core';
import type {
  CurateDrainResult,
  CurateResetPipelineResult,
  CurateResumeResult,
} from '@adhd/sox-memory-core';

/** The curate error-variant shape (a failed/unknown op). */
type CurateOpError = { code: string; message?: string; op?: string };
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTelemetry, resolveProcessRole, type InitTelemetryOptions } from '@adhd/sox-telemetry';
import {
  optimizeFtsIndexes,
  rebuildStoreOffline,
  restoreStoreOffline,
  type StorePageStats,
  type StoreReplacementVerification,
} from '@adhd/sox-store-adapter';

export type ScopeKind = 'project' | 'user' | 'org' | 'local';

const VALID_SCOPES: ScopeKind[] = ['project', 'user', 'org', 'local'];

/**
 * Default DB path for a scope when no --path override given.
 * project/local: <cwd>/.memory/<scope>.db
 * user/org:      ~/.memory/<scope>.db
 */
function defaultDbPath(scope: ScopeKind): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  if (scope === 'user' || scope === 'org') {
    return path.join(home, '.memory', `${scope}.db`);
  }
  return path.join(process.cwd(), '.memory', `${scope}.db`);
}

function resolveDbPath(scope: ScopeKind, basePath: string): string {
  if (basePath) {
    return path.resolve(basePath, '.memory', `${scope}.db`);
  }
  return defaultDbPath(scope);
}

interface ParsedArgs {
  command: string;
  scope: ScopeKind;
  basePath: string;
  /** --dir override for export subcommand */
  exportDir: string;
  /** --db override for export + reembed + compact subcommands */
  dbPathOverride: string;
  /** reembed: --dry-run */
  dryRun: boolean;
  /** reembed: --force */
  force: boolean;
  /** reembed: --no-backup */
  noBackup: boolean;
  /** reembed: --limit N */
  limit: number;
  /** backup: --dest <path> */
  destPath: string;
  /** compact: --no-optimize (skip PRAGMA optimize) */
  noOptimize: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv starts AFTER `node <compiled-entry>`
  const command = argv[0] ?? 'help';
  let scope: ScopeKind = 'project';
  let basePath = '';
  let exportDir = '';
  let dbPathOverride = '';
  let dryRun = false;
  let force = false;
  let noBackup = false;
  let limit = 0;
  let destPath = '';
  let noOptimize = false;
  const rest: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scope') {
      const s = argv[++i];
      if (!VALID_SCOPES.includes(s as ScopeKind)) {
        console.error(`Invalid scope: ${s}. Valid: ${VALID_SCOPES.join(', ')}`);
        process.exit(1);
      }
      scope = s as ScopeKind;
    } else if (arg === '--path' || arg === '--base-path') {
      basePath = argv[++i] ?? '';
    } else if (arg === '--dir') {
      exportDir = argv[++i] ?? '';
    } else if (arg === '--db') {
      dbPathOverride = argv[++i] ?? '';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--no-backup') {
      noBackup = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[++i] ?? '0', 10) || 0;
    } else if (arg === '--dest') {
      destPath = argv[++i] ?? '';
    } else if (arg === '--no-optimize') {
      noOptimize = true;
    } else {
      rest.push(arg ?? '');
    }
  }

  return { command, scope, basePath, exportDir, dbPathOverride, dryRun, force, noBackup, limit, destPath, noOptimize, rest };
}

/**
 * Default export directory for a scope when no --dir or SOX_CONFIG_EXPORT_DIR is set.
 *   user/org  → ~/.memory/export
 *   project   → <cwd>/.memory/export
 *   local     → <cwd>/.memory/export
 */
function defaultExportDir(scope: ScopeKind): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  if (scope === 'user' || scope === 'org') {
    return path.join(home, '.memory', 'export');
  }
  return path.join(process.cwd(), '.memory', 'export');
}

/**
 * Resolve the export directory with precedence:
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 */
function resolveExportDir(scope: ScopeKind, dirFlag: string): string {
  if (dirFlag) return path.resolve(dirFlag);
  const envDir = process.env['SOX_CONFIG_EXPORT_DIR'];
  if (envDir) return path.resolve(envDir);
  return defaultExportDir(scope);
}

/**
 * Resolve whether export is enabled:
 *   SOX_CONFIG_EXPORT_ENABLED env var  >  true (default on)
 */
function resolveExportEnabled(): boolean {
  const env = process.env['SOX_CONFIG_EXPORT_ENABLED'];
  if (env === 'false' || env === '0') return false;
  return true;
}

async function cmdInit(scope: ScopeKind, basePath: string): Promise<void> {
  const dbPath = resolveDbPath(scope, basePath);
  const memoryDir = path.dirname(dbPath);
  fs.mkdirSync(memoryDir, { recursive: true });

  const isNew = !fs.existsSync(dbPath);
  const adapter = await openDb(dbPath);

  const existing = await adapter.executeGet<{ scope_id: string }>(
    'SELECT scope_id FROM memory_scope WHERE scope = ?',
    [scope],
  );

  const scopeId = existing?.scope_id ?? crypto.randomUUID();
  const meta = await initScope(adapter, scope, scopeId);

  await adapter.close();

  const verb = isNew ? 'Created' : 'Already exists (idempotent)';
  console.log(`${verb}: ${dbPath}`);
  console.log(`  scope:       ${meta.scope}`);
  console.log(`  scope_id:    ${meta.scope_id}`);
  console.log(`  embed_model: ${meta.embed_model}`);
  console.log(`  embed_dim:   ${meta.embed_dim}`);
  console.log(`  created_at:  ${meta.created_at}`);

  // Write/update registry
  writeRegistry(scope, dbPath);
  const registryPath = path.join(process.env['HOME'] ?? '', '.memory', 'registry.json');
  console.log(`Registry updated: ${registryPath}`);
}

async function cmdStatus(basePath: string): Promise<void> {
  // BL-95: discovery mirrors cmdList exactly via the shared discoverStorePaths()
  // helper — same fallback order, same unregistered-store scan. Do not fork this
  // logic; two commands disagreeing about where stores live is the next bug.
  const { paths, unregisteredStores } = discoverStorePaths(basePath);

  if (paths.length === 0) {
    console.log('No memory stores found.');
    return;
  }
  for (const dbPath of paths) {
    try {
      const adapter = await openDb(dbPath);
      const meta = await adapter.executeGet<{ scope: string; embed_model: string; created_at: string }>(
        'SELECT * FROM memory_scope',
      );
      const nodeCountRow = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM node');
      const nodeCount = nodeCountRow?.c ?? 0;

      // BL-95: surface the unregistered note
      const unreg = unregisteredStores.find((s) => s.path === dbPath);
      const scopeLabel = unreg
        ? unreg.scope
        : (meta?.scope ?? '?');

      console.log(`${path.basename(dbPath)}: scope=${scopeLabel} nodes=${nodeCount} model=${meta?.embed_model ?? '?'} path=${dbPath}`);
      await adapter.close();
    } catch (e) {
      console.log(`${path.basename(dbPath)}: error - ${String(e)}`);
    }
  }

  // BL-95: if any bare stores found, print registration guidance
  if (unregisteredStores.length > 0) {
    console.log(`\n${unregisteredStores.length} unregistered store(s) found. Run 'memory init --scope <scope> --path <dir>' to register.`);
  }
}

/**
 * Discover live store paths for a given basePath, using the exact same
 * fallback order + unregistered-store scan as cmdStatus's BL-95 fix.
 *
 * Fallback order (mirrors cmdStatus):
 *   1. --base-path/--path given  → <basePath>/.memory/*.db
 *   2. no basePath               → registry.json entries + <cwd>/.memory/*.db
 *   3. always                    → BL-95 scan of KNOWN_STORE_DIRS
 *      (~/.memory, <cwd>/.memory) for bare *.db files not already found above,
 *      so a live store that predates the scope-naming convention (e.g. a bare
 *      ~/.memory/memory.db) is never silently skipped.
 *
 * Do NOT diverge this from cmdStatus's discovery — two commands disagreeing
 * about where stores live is the next bug (see BL-95).
 */
function discoverStorePaths(basePath: string): { paths: string[]; unregisteredStores: Array<{ path: string; scope: string }> } {
  const paths: string[] = [];
  if (basePath) {
    const memDir = path.resolve(basePath, '.memory');
    if (fs.existsSync(memDir)) {
      fs.readdirSync(memDir).filter((f) => f.endsWith('.db')).forEach((f) => paths.push(path.join(memDir, f)));
    }
  } else {
    // Show all stores from registry + cwd
    const home = process.env['HOME'] ?? '';
    const registryPath = path.join(home, '.memory', 'registry.json');
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
      Object.values(reg).forEach((p) => { if (fs.existsSync(p)) paths.push(p); });
    } catch { /* no registry */ }
    const cwdMem = path.join(process.cwd(), '.memory');
    if (fs.existsSync(cwdMem)) {
      fs.readdirSync(cwdMem).filter((f) => f.endsWith('.db')).forEach((f) => {
        const p = path.join(cwdMem, f);
        if (!paths.includes(p)) paths.push(p);
      });
    }
  }

  // BL-95: scan known store dirs for bare memory.db files that aren't
  // registered in the registry. A live store at ~/.memory/memory.db that
  // predates the scope-naming convention is silently skipped by the
  // registry-only lookup, producing "No memory stores found."
  const KNOWN_STORE_DIRS = [
    path.join(os.homedir(), '.memory'),
    path.join(process.cwd(), '.memory'),
  ];
  const registeredPaths = new Set(paths);
  const unregisteredStores: Array<{ path: string; scope: string }> = [];

  for (const dir of KNOWN_STORE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.db')) continue;
        const p = path.join(dir, f);
        if (registeredPaths.has(p)) continue;
        const scopeName = f.replace('.db', '');
        unregisteredStores.push({ path: p, scope: `(unregistered/${scopeName})` });
        paths.push(p);
      }
    } catch { /* permission error */ }
  }

  return { paths, unregisteredStores };
}

async function cmdList(basePath: string): Promise<void> {
  const { paths, unregisteredStores } = discoverStorePaths(basePath);

  if (paths.length === 0) {
    console.log('No memory stores found.');
    return;
  }

  for (const dbPath of paths) {
    const dbFile = path.basename(dbPath);
    try {
      const adapter = await openDb(dbPath);
      const { rows: nodes } = await adapter.executeAll<{ uid: string; kind: string; content: string | null; t_created: string }>(
        `SELECT uid, kind, content, t_created FROM node WHERE t_invalid IS NULL ORDER BY t_created DESC LIMIT 20`,
      );
      const unreg = unregisteredStores.find((s) => s.path === dbPath);
      const label = unreg ? `${dbFile} ${unreg.scope}` : dbFile;
      console.log(`\n=== ${label} (${nodes.length} recent) ===`);
      for (const n of nodes) {
        const snippet = (n.content ?? '').slice(0, 80);
        console.log(`  [${n.kind}] ${n.uid}: ${snippet}`);
      }
      await adapter.close();
    } catch (e) {
      console.log(`${dbFile}: error - ${String(e)}`);
    }
  }

  // BL-95: if any bare stores found, print registration guidance (parity with cmdStatus)
  if (unregisteredStores.length > 0) {
    console.log(`\n${unregisteredStores.length} unregistered store(s) found. Run 'memory init --scope <scope> --path <dir>' to register.`);
  }
}

function cmdRegistry(): void {
  const home = process.env['HOME'] ?? '';
  const registryPath = path.join(home, '.memory', 'registry.json');
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
    console.log('Registry:', registryPath);
    for (const [scope, dbPath] of Object.entries(reg)) {
      const exists = fs.existsSync(dbPath) ? 'OK' : 'MISSING';
      console.log(`  ${scope}: ${dbPath} [${exists}]`);
    }
  } catch {
    console.log(`Registry not found at ${registryPath} — run 'memory init' first.`);
  }
}

/**
 * Export live episodes to a markdown mirror.
 *
 * DB resolution (highest precedence first):
 *   --db flag  >  SOX_CONFIG_DB_PATH env var  >  resolveDbPath(scope, basePath)
 *
 * Export-dir resolution:
 *   --dir flag  >  SOX_CONFIG_EXPORT_DIR env var  >  scope-relative default
 *
 * Enabled resolution:
 *   SOX_CONFIG_EXPORT_ENABLED env var  >  true (default on)
 */
async function cmdExport(scope: ScopeKind, basePath: string, dirFlag: string, dbFlag: string): Promise<void> {
  // Resolve db path
  const configDbPath = process.env['SOX_CONFIG_DB_PATH'];
  const dbPath = dbFlag
    ? path.resolve(dbFlag)
    : configDbPath
      ? path.resolve(configDbPath)
      : resolveDbPath(scope, basePath);

  if (!fs.existsSync(dbPath)) {
    console.error(`Memory store not found at ${dbPath} — run 'memory init' first.`);
    process.exit(1);
  }

  const exportDir = resolveExportDir(scope, dirFlag);
  const enabled = resolveExportEnabled();

  if (!enabled) {
    console.log('export disabled');
    return;
  }

  const adapter = await openDb(dbPath);
  try {
    const result = await exportMarkdown(adapter, { dir: exportDir, enabled });
    console.log(`exported ${result.nodesWritten} nodes across ${result.topics} topics → ${result.dir}`);
  } finally {
    await adapter.close();
  }
}

/**
 * Re-embed a sox-memory store with the current BGE model.
 *
 * DB resolution (highest precedence first):
 *   --db flag  >  positional arg (rest[0])  >  ~/.memory/memory.db
 */
async function cmdReembed(
  dbFlag: string,
  rest: string[],
  dryRun: boolean,
  force: boolean,
  noBackup: boolean,
  limit: number,
): Promise<void> {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const rawDb = dbFlag || rest[0] || path.join(home, '.memory', 'memory.db');
  const resolvedDb = path.resolve(rawDb.replace(/^~(?=\/|$)/, home));

  if (!fs.existsSync(resolvedDb)) {
    console.error(`[reembed] db not found: ${resolvedDb}`);
    process.exit(1);
  }

  try {
    const result = await reembedStore(resolvedDb, {
      dryRun,
      force,
      backup: !noBackup,
      limit,
      log: (...args) => console.log(...args),
    });

    if (result.alreadyCurrent) {
      console.log(`[reembed] store already on '${result.modelId}' — nothing to do (use --force to re-embed anyway).`);
    } else if (result.dryRun) {
      console.log(`[reembed] DRY-RUN complete: would migrate ${result.migrated} node(s). No writes performed.`);
    } else {
      console.log(`[reembed] complete: migrated ${result.migrated}, skipped ${result.skipped}, errors ${result.errors.length}.`);
      if (result.errors.length > 0) {
        for (const e of result.errors.slice(0, 10)) {
          console.error(`[reembed]   error node ${e.id}: ${e.error}`);
        }
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`[reembed] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Backup a sox-memory store to a destination path via VACUUM INTO.
 *
 * DB resolution (highest precedence first):
 *   --db flag  >  positional arg (rest[0])  >  ~/.memory/memory.db
 *
 * Destination resolution:
 *   --dest flag  >  positional arg (rest[1] or rest[0] when --db is supplied)
 *
 * Both source and destination must be inside ~/.memory/** (allowlist enforced).
 *
 * NOTE: A memory_backup MCP tool is a planned follow-up (outside this shard's scope).
 */
async function cmdBackup(dbFlag: string, destFlag: string, rest: string[]): Promise<void> {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();

  const rawDb = dbFlag || rest[0] || path.join(home, '.memory', 'memory.db');
  const resolvedDb = path.resolve(rawDb.replace(/^~(?=\/|$)/, home));

  // Dest: --dest flag > rest[1] (if --db supplied) or rest[1] (if positional db used)
  const rawDest = destFlag || (dbFlag ? rest[0] : rest[1]) || '';
  if (!rawDest) {
    console.error('[backup] ERROR: destination path required. Use --dest <path> or pass it as the second positional argument.');
    process.exit(1);
  }
  const resolvedDest = path.resolve(rawDest.replace(/^~(?=\/|$)/, home));

  try {
    const result = await backupStore(resolvedDb, resolvedDest, {
      log: (...args) => console.log(...args),
    });

    if (isBackupStoreError(result)) {
      console.error(`[backup] ERROR (${result.code}): ${result.message}`);
      process.exit(1);
    } else {
      console.log(`[backup] complete`);
      console.log(`  source:         ${result.sourcePath}`);
      console.log(`  dest:           ${result.destPath}`);
      // (BL-449) Print the structured verdict, not just the legacy string.
      // `integrityCheck` reports what `pragma_integrity_check` said, and on a
      // copy that could not be fully checked it genuinely did say `ok` — so
      // printing it alone tells an operator "verified" about a backup that
      // verified nothing. That false reassurance is the whole defect.
      const verdict = result.integrityReport;
      if (verdict === undefined) {
        console.log(`  integrity:      ${result.integrityCheck} (not checked)`);
      } else if (verdict.status === 'verified') {
        console.log(`  integrity:      verified (${verdict.probesRun.length} probes)`);
      } else {
        // `damaged` never reaches here — backupStore() deletes the copy and
        // returns E_IO. This is the `unverified` path: the backup is KEPT
        // because nothing was found broken, but something could not be
        // checked, and the operator has to be told which.
        console.log(
          `  integrity:      NOT VERIFIED — ${verdict.unknownCount} of ${verdict.probesRun.length} ` +
            `probe(s) established nothing` +
            (verdict.capped ? '; integrity_check output was truncated at its message cap' : ''),
        );
        for (const f of verdict.findings.filter((x) => x.status === 'unknown')) {
          console.log(`                  · ${f.object}: ${f.detail}`);
        }
      }
      console.log(`  started_at:     ${result.startedAt}`);
      console.log(`  completed_at:   ${result.completedAt}`);
    }
  } catch (err) {
    console.error(`[backup] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Run a single compaction pass (PRAGMA optimize + ANALYZE + WAL checkpoint) on a store.
 *
 * DB resolution (highest precedence first):
 *   --db flag  >  positional arg (rest[0])  >  ~/.memory/memory.db
 *
 * This is a one-shot pass; for a recurring tick, use startCompactionTick() from
 * @adhd/sox-memory-core in a long-running process.
 */
async function cmdCompact(dbFlag: string, rest: string[], noOptimize: boolean): Promise<void> {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const rawDb = dbFlag || rest[0] || path.join(home, '.memory', 'memory.db');
  const resolvedDb = path.resolve(rawDb.replace(/^~(?=\/|$)/, home));

  if (!fs.existsSync(resolvedDb)) {
    console.error(`[compact] db not found: ${resolvedDb}`);
    process.exit(1);
  }

  try {
    const adapter = await openDb(resolvedDb);
    try {
      const result = await runCompactionPass(adapter, {
        runOptimize: !noOptimize,
        log: (...args) => console.log(...args),
      });

      if (result.error) {
        console.error(`[compact] ERROR: ${result.error}`);
        process.exit(1);
      } else {
        console.log(`[compact] complete`);
        console.log(`  run_at:             ${result.runAt}`);
        console.log(`  optimized:          ${result.optimized}`);
        console.log(`  analyzed:           ${result.analyzed}`);
        console.log(`  checkpointed:       ${result.checkpointed}`);
        console.log(`  frames_checkpointed: ${result.framesCheckpointed}`);
      }
    } finally {
      await adapter.close();
    }
  } catch (err) {
    console.error(`[compact] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * (4cd68c4e) `fts-optimize` — OFFLINE merge of every Turso FTS index's
 * segment backlog (`OPTIMIZE INDEX`). The in-service idle pass only merges
 * steady-state growth; a pre-existing backlog (prod: ~5,001 segments, a
 * 27–34 s main-thread merge) must be merged here, with memory-server STOPPED
 * via `soxe service disable memory-server` — under launchd KeepAlive a killed
 * process respawns. `optimizeFtsIndexes` refuses while any store-lease peer is
 * live OR any live process has the store open (an idle memory-server holds no
 * lease but still has an opener entry), and this command exits non-zero on
 * refused or failed.
 */
async function cmdFtsOptimize(dbFlag: string, rest: string[]): Promise<void> {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const rawDb = dbFlag || rest[0] || path.join(home, '.memory', 'memory.db');
  const resolvedDb = path.resolve(rawDb.replace(/^~(?=\/|$)/, home));

  if (!fs.existsSync(resolvedDb)) {
    console.error(`[fts-optimize] db not found: ${resolvedDb}`);
    process.exit(1);
  }

  const report = await optimizeFtsIndexes(resolvedDb);
  if (report.status === 'refused') {
    const pids = (report.peer_pids ?? []).join(',');
    const why =
      report.reason === 'peers'
        ? `${report.peer_count ?? 0} live store peer(s) (pids ${pids})`
        : report.reason === 'openers'
          ? `${report.peer_count ?? 0} live process(es) have the store open (pids ${pids || 'unknown'})`
          : report.reason;
    console.error(
      `[fts-optimize] REFUSED: ${why} — run \`soxe service disable memory-server\` first (under launchd KeepAlive a killed memory-server respawns), stop every other process holding ${report.db_path}, then re-run`,
    );
    process.exit(2);
  }
  for (const r of report.per_index) {
    console.log(`  ${r.ok ? 'ok    ' : 'FAILED'} ${r.index}  ${r.duration_ms} ms${r.error ? `  ${r.error}` : ''}`);
  }
  if (report.status === 'failed') {
    console.error(`[fts-optimize] ERROR: ${report.error ?? 'unknown'} (${report.duration_ms} ms)`);
    process.exit(1);
  }
  console.log(`[fts-optimize] complete: ${report.db_path}`);
  console.log(`  indexes:     ${report.indexes.length === 0 ? '(no FTS index)' : report.indexes.join(', ')}`);
  console.log(`  duration_ms: ${report.duration_ms}`);
}

function resolveCliDb(dbFlag: string, positional: string | undefined): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const rawDb = dbFlag || positional || path.join(home, '.memory', 'memory.db');
  return path.resolve(rawDb.replace(/^~(?=\/|$)/, home));
}

function fmtStats(s: StorePageStats): string {
  return `${s.file_bytes} bytes, page_count ${s.page_count} × page_size ${s.page_size}, freelist_count ${s.freelist_count}`;
}

function printVerification(tag: string, v: StoreReplacementVerification): void {
  const tablesOk = v.table_counts.filter((t) => t.ok).length;
  const ftsOk = v.fts_round_trip.filter((f) => f.ok).length;
  console.log(`  verification: ${v.ok ? 'ok' : 'FAILED'}`);
  console.log(`    tables:     ${tablesOk}/${v.table_counts.length} row counts equal`);
  console.log(`    fts:        ${ftsOk}/${v.fts_round_trip.length} sentinel round-trips equal`);
  console.log(
    `    integrity:  ${v.integrity.ok ? 'ok' : 'DAMAGED'} (known false positives ${v.integrity.known_false_positives}, ` +
      `page-accounting ${v.integrity.page_accounting}${v.integrity.truncated ? ', TRUNCATED' : ''})`,
  );
  for (const f of v.failures) console.error(`[${tag}]   ${f}`);
}

function refusalMessage(tag: string, reason: string | undefined, pids: number[] | undefined, db: string, detail?: string): string {
  const p = (pids ?? []).join(',');
  const why =
    reason === 'peers'
      ? `${pids?.length ?? 0} live store peer(s) (pids ${p})`
      : reason === 'openers'
        ? `${pids?.length ?? 0} live process(es) have the store open (pids ${p || 'unknown'})`
        : `${reason ?? 'unknown'}${detail ? `: ${detail}` : ''}`;
  return (
    `[${tag}] REFUSED: ${why} — run \`soxe service disable memory-server\` first (under launchd KeepAlive a ` +
    `killed memory-server respawns), stop every other process holding ${db}, then re-run`
  );
}

/**
 * (BL-c5249cdd) `fts-rebuild` — OFFLINE compaction. Every interleaved
 * insert + OPTIMIZE round (the in-service FTS maintenance) orphans the merged-away
 * FTS segments on Turso 0.7.x; only `VACUUM INTO` reclaims them. This verb runs
 * `rebuildStoreOffline` (store-adapter/src/store-rebuild.ts): same refusal gate
 * as `fts-optimize`, VACUUM INTO `<db>.rebuild-<ts>`, verify, atomic swap, the
 * pre-swap file kept as `<db>.pre-rebuild-<ts>`. Exit 2 on refused, 1 on failed.
 */
async function cmdFtsRebuild(dbFlag: string, rest: string[], dryRun: boolean): Promise<void> {
  const resolvedDb = resolveCliDb(dbFlag, rest[0]);
  if (!fs.existsSync(resolvedDb)) {
    console.error(`[fts-rebuild] db not found: ${resolvedDb}`);
    process.exit(1);
  }
  const r = await rebuildStoreOffline(resolvedDb, { dryRun });
  if (r.status === 'refused') {
    console.error(refusalMessage('fts-rebuild', r.reason, r.peer_pids, r.db_path, r.error));
    if (r.reason === 'source_changed' && r.rebuild_path) {
      console.error(
        `[fts-rebuild] the store was written after the snapshot and was NOT swapped; the verified copy of the snapshot is kept: ${r.rebuild_path} — delete it and re-run once every writer is stopped`,
      );
    }
    process.exit(2);
  }
  if (r.before) console.log(`  before: ${fmtStats(r.before)}`);
  if (r.after) console.log(`  after:  ${fmtStats(r.after)}`);
  if (r.verification) printVerification('fts-rebuild', r.verification);
  if (r.status === 'failed') {
    console.error(`[fts-rebuild] ERROR (${r.reason ?? 'unknown'}): ${r.error ?? 'unknown'} (${r.duration_ms} ms)`);
    if (r.reason === 'verification_failed' && r.rebuild_path) {
      console.error(`[fts-rebuild] the unverified copy is kept for inspection: ${r.rebuild_path} — the store was NOT swapped`);
    }
    process.exit(1);
  }
  if (r.before && r.after) {
    const saved = r.before.file_bytes - r.after.file_bytes;
    const pct = r.before.file_bytes > 0 ? ((saved / r.before.file_bytes) * 100).toFixed(1) : '0.0';
    console.log(`  ${r.status === 'dry_run' ? 'would reclaim' : 'reclaimed'}: ${saved} bytes (${pct}%), ${r.before.page_count - r.after.page_count} pages`);
  }
  if (r.status === 'dry_run') {
    console.log(`[fts-rebuild] DRY-RUN: copy verified and deleted; ${r.db_path} was not swapped (${r.duration_ms} ms)`);
    return;
  }
  console.log(`[fts-rebuild] complete: ${r.db_path} (${r.duration_ms} ms)`);
  if (r.backup_path) {
    console.log(`  backup: ${r.backup_path}`);
    console.log(`  undo:   memory restore ${r.backup_path} --db ${r.db_path}`);
  }
}

/**
 * (BL-c5249cdd) `restore <backup>` — OFFLINE restore of a single-file backup
 * (the `fts-rebuild` pre-swap file) over the store. The backup is cloned, the
 * clone verified against it, the current store hard-linked to
 * `<db>.pre-restore-<ts>`, and the clone renamed over `<db>`. Exit 2 on
 * refused, 1 on failed.
 */
async function cmdRestore(dbFlag: string, rest: string[], dryRun: boolean): Promise<void> {
  const backupArg = rest[0];
  if (!backupArg) {
    console.error('[restore] ERROR: backup path required: memory restore <backup> [--db <path>] [--dry-run]');
    process.exit(1);
  }
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const resolvedBackup = path.resolve(backupArg.replace(/^~(?=\/|$)/, home));
  const resolvedDb = resolveCliDb(dbFlag, rest[1]);
  const r = await restoreStoreOffline(resolvedBackup, resolvedDb, { dryRun });
  if (r.status === 'refused') {
    console.error(refusalMessage('restore', r.reason, r.peer_pids, r.db_path, r.error));
    process.exit(2);
  }
  if (r.restored) console.log(`  restored: ${fmtStats(r.restored)}`);
  if (r.verification) printVerification('restore', r.verification);
  if (r.status === 'failed') {
    console.error(`[restore] ERROR (${r.reason ?? 'unknown'}): ${r.error ?? 'unknown'} (${r.duration_ms} ms)`);
    process.exit(1);
  }
  if (r.status === 'dry_run') {
    console.log(`[restore] DRY-RUN: clone of ${r.backup_path} verified and deleted; ${r.db_path} was not replaced`);
    return;
  }
  console.log(`[restore] complete: ${r.backup_path} -> ${r.db_path} (${r.duration_ms} ms)`);
  if (r.replaced_path) console.log(`  replaced store kept at: ${r.replaced_path}`);
}

export async function runCli(argv: string[]): Promise<void> {
  const { command, scope, basePath, exportDir, dbPathOverride, dryRun, force, noBackup, limit, destPath, noOptimize, rest } = parseArgs(argv);

  switch (command) {
    case 'init':
      await cmdInit(scope, basePath);
      break;
    case 'status':
      await cmdStatus(basePath);
      break;
    case 'list':
      await cmdList(basePath);
      break;
    case 'registry':
      cmdRegistry();
      break;
    case 'export':
      await cmdExport(scope, basePath, exportDir, dbPathOverride);
      break;
    case 'reembed':
      await cmdReembed(dbPathOverride, rest, dryRun, force, noBackup, limit);
      break;
    case 'backup':
      await cmdBackup(dbPathOverride, destPath, rest);
      break;
    case 'compact':
      await cmdCompact(dbPathOverride, rest, noOptimize);
      break;
    case 'pipeline':
      await cmdPipeline(rest[0], dbPathOverride, dryRun, limit);
      break;
    case 'fts-optimize':
      await cmdFtsOptimize(dbPathOverride, rest);
      break;
    case 'fts-rebuild':
      await cmdFtsRebuild(dbPathOverride, rest, dryRun);
      break;
    case 'restore':
      await cmdRestore(dbPathOverride, rest, dryRun);
      break;
    case 'help':
    default:
      console.log(`sox-memory CLI (P3: multi-scope)
Commands:
  init [--scope project|user|org|local] [--path DIR]   Create a .memory/<scope>.db
  status [--path DIR]                                   Show all store info
  list [--path DIR]                                     List recent memories
  registry                                              Show ~/.memory/registry.json
  export [--scope <s>] [--base-path <p>]               Export live episodes to markdown
         [--dir <path>] [--db <path>]
  reembed [--db <path>] [--dry-run] [--force]          Re-embed store with current BGE model
          [--no-backup] [--limit N]                     (promotes scripts/reembed-memory.mjs)
  backup  [--db <src>] --dest <dst>                    VACUUM INTO backup (must be inside ~/.memory/**)
          [<src> <dst> positional args also work]
  compact [--db <path>] [--no-optimize]                Run PRAGMA optimize+ANALYZE+WAL checkpoint
          [<path> positional arg also works]
  pipeline <status|drain|reset|resume> [--db <path>]   Enrich/embed pipeline control plane
          [--dry-run] [--limit N]
  fts-optimize [--db <path>]                           OFFLINE merge of FTS index segments
          [<path> positional arg also works]          (run \`soxe service disable memory-server\`
                                                      first — a killed one respawns under
                                                      launchd KeepAlive; refuses while any
                                                      process has the store open)
  fts-rebuild [--db <path>] [--dry-run]                OFFLINE compaction: VACUUM INTO a copy,
                                                      verify it (row counts, FTS round-trip,
                                                      integrity_check), atomically swap it in;
                                                      the pre-swap file is kept as the backup.
                                                      Same refusal rules as fts-optimize.
                                                      --dry-run verifies the copy, never swaps.
  restore <backup> [--db <path>] [--dry-run]           OFFLINE restore of a single-file backup
                                                      (e.g. <db>.pre-rebuild-<ts>) over the store;
                                                      the replaced store is kept as
                                                      <db>.pre-restore-<ts>. Refuses while any
                                                      process has the store open.
`);
  }
}

/**
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001: the lifetime operational control
 * plane verbs — `pipeline status|drain|reset|resume`. Deterministic read/write
 * of the health ledger, verdict, alarm, and poison table (no LLM).
 */
async function cmdPipeline(
  subcommand: string | undefined,
  dbPathOverride: string,
  dryRun: boolean,
  limit: number,
): Promise<void> {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const rawDb = dbPathOverride || path.join(home, '.memory', 'memory.db');
  const resolvedDb = path.resolve(rawDb.replace(/^~(?=\/|$)/, home));

  if (!fs.existsSync(resolvedDb)) {
    console.error(`[pipeline] db not found: ${resolvedDb}`);
    process.exit(1);
  }

  const adapter = await openDb(resolvedDb);
  try {
    switch (subcommand) {
      case 'status': {
        const ledger = await readEnrichHealthLedger(adapter);
        const backlog = await embedBacklogStats(adapter);
        const verdict = computePipelineHealthVerdict({ nowMs: Date.now(), backlog: backlog.count, ledger });
        const alarm = await readEnrichAlarm(adapter);
        const poisoned = await countPoisonedRows(adapter);
        console.log(`pipeline status: ${resolvedDb}`);
        console.log(`  verdict.state:     ${verdict.state}`);
        console.log(`  reasons:           ${verdict.reasons.join('; ') || '(none)'}`);
        console.log(`  embed_backlog:     ${backlog.count}`);
        console.log(`  poisoned_rows:     ${poisoned}`);
        console.log(`  last_successful:   ${ledger.last_successful_pass_at ?? 'never'}`);
        console.log(`  passes ok/failed:  ${ledger.passes_ok}/${ledger.passes_failed}`);
        console.log(`  net_drained:       ${ledger.net_drained}`);
        console.log(`  alarm:             ${alarm ? `${alarm.level} (ticks=${alarm.consecutive_non_ok_ticks}, state=${alarm.state})` : 'none'}`);
        break;
      }
      case 'drain': {
        const wq = await WriteQueue.forPath(resolvedDb);
        const result = (await memoryCurate(adapter, { op: 'drain', dry_run: dryRun, ...(limit > 0 ? { limit } : {}) }, wq)) as CurateDrainResult | CurateOpError;
        if ('code' in result) {
          console.error(`[pipeline drain] ${result.code}: ${result.message ?? ''}`);
          process.exit(1);
        }
        console.log(
          `[pipeline drain] ${result.dry_run ? 'DRY-RUN' : 'complete'}: ` +
          `remaining=${result.remaining} healed=${result.healed_total} failed=${result.failed_total} ` +
          `fully_drained=${result.fully_drained} verified=${result.verified}`,
        );
        break;
      }
      case 'reset': {
        const result = (await memoryCurate(adapter, { op: 'reset_pipeline' })) as CurateResetPipelineResult | CurateOpError;
        if ('code' in result) {
          console.error(`[pipeline reset] ${result.code}: ${result.message ?? ''}`);
          process.exit(1);
        }
        console.log(`[pipeline reset] ledger=${result.cleared_ledger} alarm=${result.cleared_alarm} unpoisoned=${result.unpoisoned_rows}`);
        break;
      }
      case 'resume': {
        const result = (await memoryCurate(adapter, { op: 'resume' })) as CurateResumeResult | CurateOpError;
        if ('code' in result) {
          console.error(`[pipeline resume] ${result.code}: ${result.message ?? ''}`);
          process.exit(1);
        }
        console.log(`[pipeline resume] ${result.resumed ? 'resumed' : 'not resumed'}`);
        break;
      }
      default:
        console.log('pipeline: unknown subcommand. Use status|drain|reset|resume.');
    }
  } finally {
    await adapter.close();
  }
}

// When invoked directly (not required as a library), run the CLI.
// (BL-568) COMPOSITION ROOT. Without this, `@adhd/sox-telemetry`'s gated
// substrate stays uninitialised for the whole process and every store-adapter
// emission — retry, preflight, engine-marker — is SILENTLY DROPPED with
// `logSink:'none'`. Reproduced directly against the shipped binary: it printed
// "emitting with no initTelemetry() call in this process (role:'harness',
// logSink:'none' — records are being silently dropped)".
//
// BL-404 fixed exactly this for memory-server but only at ITS composition root;
// memory-cli was never given one. That matters here specifically because the CLI
// owns `backup` and `reembed` — the operations whose failures you most need a
// durable record of.
//
// role:'cli' (not 'live-service') because this is a short-lived one-shot; the
// backlog tool used the SAME hardcoded-literal shape for the same reason and
// it silently mislabeled its own long-lived `serve` mode as 'cli' for its
// entire idle lifetime (2.5+ days observed) — see docs/reporting/memory/
// findings/2026-08-17-store-connection-lifetime-forensics.md §1d. memory-cli
// has no equivalent `serve` dispatch today, so structurally that specific
// failure cannot recur here, but the literal was still wrong for a different
// reason: scripts/smoke-test.mjs execs this exact compiled binary
// out-of-process, so smoke-test spawns also reported 'cli' — indistinguishable
// from a real one-shot operator invocation.
//
// BL-501: `role` is resolved via `resolveProcessRole('cli')`. Genuine CLI
// invocations are unaffected (no structural signal present -> unchanged
// 'cli'); a smoke-test.mjs spawn (SOX_TELEMETRY_HARNESS=1) now reports
// 'harness' instead.
// Exported (not an inline literal at the call site, mirroring memory-server's
// MEMORY_SERVER_TELEMETRY_INIT_OPTIONS) so bl501-cli-role-detection.spec.ts
// can assert against the SAME object this composition root actually uses.
export const MEMORY_CLI_TELEMETRY_INIT_OPTIONS: InitTelemetryOptions = {
  service: 'memory-cli',
  role: resolveProcessRole('cli'),
  logSink: 'file',
};

if (require.main === module) {
  initTelemetry(MEMORY_CLI_TELEMETRY_INIT_OPTIONS);
  void runCli(process.argv.slice(2));
}

