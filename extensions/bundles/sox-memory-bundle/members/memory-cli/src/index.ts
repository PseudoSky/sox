/**
 * Memory CLI — memory init|import|status|list|promote|registry|export
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
} from '@adhd/sox-memory-core';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  const db = (adapter as any).unwrap() as import('better-sqlite3').Database;

  const existing = db
    .prepare('SELECT scope_id FROM memory_scope WHERE scope = ?')
    .get(scope) as { scope_id: string } | undefined;

  const scopeId = existing?.scope_id ?? crypto.randomUUID();
  const meta = initScope(db, scope, scopeId);

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
      const db = (adapter as any).unwrap() as import('better-sqlite3').Database;
      const meta = db.prepare('SELECT * FROM memory_scope').get() as
        | { scope: string; embed_model: string; created_at: string }
        | undefined;
      const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM node').get() as { c: number }).c;

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
      const db = (adapter as any).unwrap() as import('better-sqlite3').Database;
      const nodes = db
        .prepare(
          `SELECT uid, kind, content, t_created FROM node WHERE t_invalid IS NULL ORDER BY t_created DESC LIMIT 20`,
        )
        .all() as { uid: string; kind: string; content: string | null; t_created: string }[];
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
    const result = exportMarkdown(adapter, { dir: exportDir, enabled });
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
      console.log(`  integrity:      ${result.integrityCheck}`);
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
`);
  }
}

// When invoked directly (not required as a library), run the CLI.
if (require.main === module) {
  void runCli(process.argv.slice(2));
}

