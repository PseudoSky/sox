/**
 * apps/sox/src/main.ts — soxe CLI (extension #0, D1/D2 self-hosting)
 *
 * Full command surface wired to engine libs (sox-extension state, legacy P5).
 *
 * Verbs: init, validate, search, install, start, list, details, enable,
 *        disable, update, uninstall, stop, serve, exec, help
 *
 * [ref:self-hosted-extension-zero] — apps/soxe ships extension.json type:command
 * [ref:dual-flag-form]             — parseArgs accepts --flag=value AND --flag value (A12)
 * [inv:nx-dev-only]                — no nx or @nx/* imports anywhere here
 * [inv:nx-free-core]               — soxe init uses libs/authoring scaffold(), not the old scaffolder
 */

import type { PermissionsBlock, RuntimeEntry, RuntimeRecord } from '@adhd/sox-host-runtime';
import {
  // Slice 4 (docs/spec/service-lifecycle.md §10.2/§14): doctor reconcile.
  chooseSurvivor,
  classifyReconcileTargets,
  compilePolicy,
  computeSupervisorId,
  // Slice 3 (docs/spec/service-lifecycle.md §11.3): crash-loop give-up markers.
  crashLoopMarkerDir,
  dataRoot,
  userDataRoot,
  deriveOsUnitSpec,
  detectOsSupervisor,
  disableOsUnit,
  enableOsUnit,
  findAllLogStreamsForExt,
  findCrossScopeSharers,
  findOrphansByIdentity,
  findOrphansByServiceId,
  gatherProcessSnapshot,
  readProcessEnv,
  // Slice 2 (docs/spec/service-lifecycle.md §9): OS-supervisor control surface.
  getOsUnitPlatform,
  getRuntimeFilePath,
  getRuntimeRecord,
  getScopePaths,
  healSingletonDuplicates,
  identityToken,
  installRegistryPath,
  killAndVerify,
  listCrashLoopMarkers,
  logDirFor,
  McpClient,
  osUnitLabel,
  pidAlive as pidAliveRT,
  // BL-176: fast-path GC + split-brain heal (phases 0/3), wired into cmdList/cmdStatus.
  quickReconcile,
  readGlobalRegistry,
  readUnitMeta,
  realOsExec,
  reapByIdentity,
  reapOrphansForExtension,
  reconcileRuntime,
  CrashLoopGuard,
  resolveExtensionDir,
  // BL-393: singleton-violation heal marker — surfaced by `service status`.
  runDir,
  // Slice 1 (docs/spec/service-lifecycle.md): cross-scope singleton.
  resolveStoreResource,
  resolveUnitNodePath,
  restartAndVerify,
  restartOsUnit,
  singletonKey,
  socketDir,
  socketOwnerPids,
  startRuntime,
  stopRuntime,
  // BL-201: dead-holder proxy spawn-lock debris sweep (reconcile step 6).
  sweepProxyBackendLocks,
  unloadThenReap,
  // BL-185: interval-schedule detection for SCHEDULED status rendering.
  isScheduledOsUnitContent,
  // BL-344: the ONE env-scrub definition. This file previously carried three
  // independent copies of it (~4632, ~8071, ~8728) which had drifted from each
  // other and from host-runtime's two, so a tunable reached some spawn paths
  // and not others — silently.
  scrubEnvReported,
  type DataScope,
  type OsSupervisor,
  type OsUnitPlatform,
  type ReconcileMatch,
  type ScopeResource,
  type StoreResource,
} from '@adhd/sox-host-runtime';
// NOTE: `@adhd/sox-manifest` is deliberately LAZY-LOADED in this file (see the
// `await import('@adhd/sox-manifest')` in cmdValidate, and printHelp below).
// A static import here pulls the whole manifest library into CLI startup just to
// print help text, and `@nx/enforce-module-boundaries` rejects it:
//   "Static imports of lazy-loaded libraries are forbidden."
import {
  SCOPES,
  type DeclarativeInstallResult,
  type InstallDescriptor,
  type InstallRecord,
  type OwnedEntry,
  type Scope,
  type UpdateCtx,
} from '@adhd/sox-install-engine';
import {
  DeclarativeDeniedError,
  declarativeInstall,
  diffAll,
  diff as diffExtension,
  findLocalExtension,
  getScopePath,
  install,
  uninstall as lifecycleUninstall,
  update as lifecycleUpdate,
  loadConfig,
  loadExtensionManifest,
  loadLockfile,
  loadRegistryIndex,
  OwnershipIndex,
  parseArgs,
  readInstallRegistry,
  registerUserMcpServer,
  removeInstallRecord,
  resolveFromRegistry,
  reverseMcpTrustFromProjects,
  reverseUserMcpFromProjects,
  syncMcpTrustToProjects,
  syncUserMcpToProjects,
  IntegrityResult,
  verifyIntegrity,
} from '@adhd/sox-install-engine';
import { registerBundleMember, resolveBundleDir } from './bundle-init.js';
// @adhd/sox-host-registry is also lazy-required via install-engine; import it lazily here too
// to avoid the NX "static import of lazy-loaded library" lint error.
// [inv:host-registry-lazy]: getHost() used only in cmdInstall; require() at call site.

// ─── CLI name ─────────────────────────────────────────────────────────────────
// Single source of truth for the CLI command name used in all usage strings.
// To rename the CLI: change the bin key in apps/sox/package.json to match.
const CLI = 'soxe';

// ─── Entry ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const verb = argv[0];
// A12: flags after the verb use parseArgs (both --flag=value and --flag value)
const flags = parseArgs(argv.slice(1));

async function main(): Promise<void> {
  // ADR-0004: SOX_HOME is RETIRED and fully INERT — data placement is governed solely
  // by SOX_ECOSYSTEM_HOME (data root) and SOX_SANDBOX_ROOT (test isolation). We do NOT
  // warn on a set SOX_HOME: the name is not exclusively ours (it collides with the
  // `sox` audio tool and may be claimed by other tooling, e.g. an unrelated project),
  // so nagging about a variable soxe no longer reads is presumptuous noise (BL-57). If a
  // user genuinely has legacy soxe data to relocate, `soxe migrate-home` / `soxe doctor`
  // detect it from the default locations, independent of SOX_HOME.
  if (process.env['SOX_ECOSYSTEM_HOME'] && verb !== 'help' && verb !== undefined) {
    process.stderr.write(
      `[sox] SOX_ECOSYSTEM_HOME is set — data root: ${process.env['SOX_ECOSYSTEM_HOME']} (placement unaffected)\n`,
    );
  }

  // ── Command audit log (append-only JSONL) ──────────────────────────────────
  try {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const auditScope = (flags['scope'] ?? 'user') as DataScope;
    const rootDir = dataRoot(auditScope);
    const runDir = join(rootDir, 'run');
    mkdirSync(runDir, { recursive: true });
    const entry = {
      t: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      verb,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      scope: auditScope,
    };
    appendFileSync(join(runDir, 'sox-audit.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // audit logging must never crash the CLI
  }

  switch (verb) {
    // ── Lifecycle management ──────────────────────────────────────────────────
    case 'start':
      await cmdStart(flags);
      break;
    case 'stop':
      await cmdStop(flags);
      break;
    case 'exec':
      await cmdExec(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'service':
      await cmdService(argv, flags);
      break;

    // ── Config management ─────────────────────────────────────────────────────
    case 'config':
      await cmdConfig(argv, flags);
      break;

    // ── Extension management ──────────────────────────────────────────────────
    case 'install':
      await cmdInstall(flags);
      break;
    case 'build':
      await cmdBuild(flags);
      break;
    case 'diff':
      await cmdDiff(flags);
      break;
    case 'update':
      await cmdUpdate(flags);
      break;
    case 'upgrade':
      await cmdUpgrade(flags);
      break;
    case 'uninstall':
      await cmdUninstall(flags);
      break;
    case 'enable':
      await cmdEnable(flags);
      break;
    case 'disable':
      await cmdDisable(flags);
      break;

    // ── Query ─────────────────────────────────────────────────────────────────
    case 'list':
      await cmdList(flags);
      break;
    case 'details':
      cmdDetails(flags);
      break;
    case 'search':
      cmdSearch(flags);
      break;
    case 'status':
      await cmdStatus(flags);
      break;
    case 'logs':
      await cmdLogs(flags);
      break;
    case 'ps':
      await cmdPs(flags);
      break;
    case 'follow':
      await cmdFollow(flags);
      break;
    case 'doctor':
      await cmdDoctor(flags);
      break;
    case 'migrate-home':
      await cmdMigrateHome(flags);
      break;

    // ── Authoring (A1) ────────────────────────────────────────────────────────
    case 'init':
      await cmdInit(argv.slice(1));
      break;

    // ── Validation ────────────────────────────────────────────────────────────
    case 'validate':
      await cmdValidate(argv.slice(1));
      break;

    // ── Help ──────────────────────────────────────────────────────────────────
    case '--help':
    case '-h':
    case 'help':
      await printHelp();
      break;

    // ── Version ───────────────────────────────────────────────────────────────
    case '--version':
    case '-V':
      printVersion();
      break;

    default:
      if (verb === undefined) {
        await printHelp();
      } else {
        process.stderr.write(`sox: unknown verb '${String(verb)}'\n`);
        process.stderr.write(`Run '${CLI} --help' for usage.\n`);
        process.exit(1);
      }
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Load the registry index with a fresh-machine fallback (D-D / BL-42).
 *
 * Primary source is `registry/index.json` under the invoking cwd (the dev/repo
 * path — unchanged behaviour). When that is absent or empty (a consumer running
 * the published `@adhd/sox-cli` with NO repo checkout, OR running the CLI's own
 * dev build from outside its repo), fall back to the registry copy embedded
 * inside the CLI bundle (written by apps/sox/scripts/embed-registry.cjs at
 * build time, which only ever targets `apps/sox/dist/registry/index.json`).
 *
 * BL-217: which directory `__dirname` actually is at runtime depends on which
 * of the CLI's two build outputs is executing — the same three layouts
 * printVersion() already disambiguates. Published bundle / dev esbuild land
 * `__dirname` AT the embedded copy's directory; dev tsc build — what `bin/soxe`
 * runs — lands `__dirname` at `dist/apps/sox`, which has no embedded copy of its
 * own. Try both rather than assuming one.
 */
function loadRegistryResolved(cwdRoot: string): ReturnType<typeof loadRegistryIndex> {
  try {
    const fromCwd = loadRegistryIndex(cwdRoot);
    if (fromCwd.length > 0) return fromCwd;
  } catch {
    /* fall through to bundled copy */
  }
  const pathMod = require('node:path') as typeof import('node:path');
  const bundledCandidates = [
    __dirname,
    // dev tsc build (`dist/apps/sox`): the embedded copy lives in the sibling
    // esbuild output at `apps/sox/dist`, three levels up then back down.
    pathMod.resolve(__dirname, '../../../apps/sox/dist'),
  ];
  for (const dir of bundledCandidates) {
    try {
      const fromBundle = loadRegistryIndex(dir);
      if (fromBundle.length > 0) return fromBundle;
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

/**
 * Build SOX_CONFIG_* env vars from cascade-resolved config for a given extension.
 * Reads all four scopes (org→user→project→local, narrowest wins) and converts
 * each config key to SOX_CONFIG_<KEY>, with tilde and ${VAR} expansion.
 * Used by cmdStart, cmdExec (fresh-spawn), and cmdServe.
 */
function buildExtConfigEnv(extId: string, root: string): Record<string, string> {
  const configEnv: Record<string, string> = {};
  const merged: Record<string, unknown> = {};
  const { homedir } = require('node:os') as typeof import('node:os');
  for (const cs of ['org', 'user', 'project', 'local'] as const) {
    try {
      const csp = getScopePaths(cs, root);
      const cfg = loadConfig(csp.config);
      const blk = (cfg?.config as Record<string, Record<string, unknown>> | undefined)?.[extId] ?? {};
      Object.assign(merged, blk);
    } catch { /* skip missing scope */ }
  }
  const homeDir = homedir();
  for (const [k, v] of Object.entries(merged)) {
    const envKey = `SOX_CONFIG_${k.toUpperCase().replace(/[-\s]/g, '_')}`;
    let strVal = typeof v === 'string' ? v : (v === null || v === undefined ? '' : JSON.stringify(v));
    if (strVal.startsWith('~/')) strVal = homeDir + strVal.slice(1);
    strVal = strVal.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, varName: string) => process.env[varName] ?? _m);
    configEnv[envKey] = strVal;
  }
  return configEnv;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

async function printHelp(): Promise<void> {
  // Lazy: keep @adhd/sox-manifest out of CLI startup (nx boundary rule).
  const { VALID_TYPES, VALID_RUNTIMES, VALID_HOOK_EVENTS, KNOWN_HOSTS } =
    await import('@adhd/sox-manifest');
  process.stdout.write(`${CLI} — LLM extension ecosystem CLI

Usage: ${CLI} <verb> [flags]

Authoring:
  init <type> <id>   Scaffold a new extension
                     id: lowercase, kebab-case, must not end in the type name
                      Types: ${Array.from(VALID_TYPES).filter((t: string) => t !== 'prompt').join(' | ')}
                     Flags: --out=<dir>       write into <dir>/<id>/ (default: cwd)
                            --bundle=<name>   scaffold into a bundle's members/ dir
                            --title=<str>  --description=<str>
                            --author=<str>  --keywords=<k1,k2>
                            --events=<E1,E2>  (hook: ${Array.from(VALID_HOOK_EVENTS).slice(0, 3).join(', ')}, ...)
                            --runtime=<runtime>  (${Array.from(VALID_RUNTIMES).filter((r: string) => r !== 'stdio-any').join(' | ')})
                            --transport=<t>  --transports=<t1,t2>  (stdio | sse | http)

Validation:
  validate [path]    Validate extension.json at path (default: ./extension.json)

Registry / Search:
  search <query>     Search the extension registry
                     Flags: --type=<type>  --json

Extension management:
  install <id|bundle>   Install extension by id (or expand a bundle) at scope
                       Flags: --scope=<scope>  --host=<hosts>  --frozen-lockfile  --update
                            --no-restart
  update             Update installed extensions
                     Flags: --scope=<scope>
  upgrade <ext-id>   Re-install stale consumers across all scopes/projects
                     Flags: --all (required)
                            --force  also reconcile user-scope MCP servers into
                                     every known project .mcp.json
                            --host=<host>  host for the --force reconcile (default: claude)
  uninstall          Remove an extension
                     Flags: --id=<ext-id>  --scope=<scope>
  enable             Enable a disabled extension
                     Flags: --id=<ext-id>  --scope=<scope>
  disable            Disable an extension
                     Flags: --id=<ext-id>  --scope=<scope>

Config:
  config get   <ext> <key>         Get a cascade-resolved config value
  config set   <ext> <key> <val>   Persist a value to scope config (default: user)
  config list  <ext>               Show all keys with cascade origin per key
  config unset <ext> <key>         Remove a key from a scope config
  config check <ext>               Validate config against extension's config_schema
                     Flags: --scope=<scope>  --no-restart  --dry-run

Runtime:
  start [<ext-id>]   Start the host runtime (or a specific extension)
                     Flags: --scope=<scope>  --root=<root>  --id=<ext-id>
  stop [<ext-id>]    Stop the runtime or a single extension
                     Flags: --scope=<scope>  --id=<ext-id>
  serve <ext-id>     Launch an MCP server with live cascade config (for .mcp.json)
                     Flags: --scope=<scope>  --root=<dir>
  service            OS-supervisor control (launchd/systemd) for reboot persistence
                     Sub: enable | disable | status | list
                     Flags: --scope=<scope>  --dry-run  --unit-dir=<dir>
                            --supervisor=<launchd|systemd>  --node-path=<path>
                            --allow-volatile-node
  exec <ext-id> <tool> Call a tool on a running extension
                     Flags: --scope=<scope>  --id=<ext-id>  --tool=<tool>  --args='<json>'
  list               List activated extensions
                     Flags: --scope=<scope>  --all  --global  --id=<ext>  --json
  details <id>       Show details for an extension
                     Flags: --id=<ext-id>  --scope=<scope>
  status [<ext-id>]  Show live health for all running extensions
                     Flags: --id=<ext-id>  --project=<path>  --scope=<scope>
                     --lines=<n>  --json
                     Exit: 0=healthy 1=degraded 2=dead
  doctor [<ext-id>]  Diagnose and repair soxe state (stray processes, orphans)
                     Flags: --id=<ext-id>  --fix (reap strays)  --scope=<scope>
                             --old-match  (use old path-based matching for comparison)
                      Continuous supervision:
                             --reconcile [--dry-run]  safe idempotent heal pass
                             --install-tick [--interval <sec>]  schedule periodic
                               reconcile under launchd/systemd (default 300s)
                             --remove-tick  reverse --install-tick
  logs <ext-id>      Tail or follow extension log output
                     Flags: --id=<ext-id>  --scope=<scope>  --lines=<n>
                     --follow  --history  --json
                     --stream=<label> (process|backend|os-out|os-err|serve)
  ps                 Show merged process snapshot (supervisor + OS-units + locks)
                     Flags: --scope=<scope>  --json
  follow [<ext-id>]  Merged, prefixed, colorized live tail
                     Flags: --id=<ext-id>  --scope=<scope>  --lines=<n>
  migrate-home       Relocate soxe data to the .adhd/sox-ecosystem layout
                     Flags: --old-home  --old-config  --old-sandbox  --new-home
                            --dry-run

Scopes:  ${SCOPES.join(' | ')}  (narrower overrides wider)
Hosts:   ${Array.from(KNOWN_HOSTS).join(' | ')}
Types:   ${Array.from(VALID_TYPES).filter((t: string) => t !== 'prompt').join(' | ')}
`);
}

// ─── Version ──────────────────────────────────────────────────────────────────

function printVersion(): void {
  let version = '0.0.0';
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    // Three layouts to support:
    //   - PUBLISHED bundle: __dirname is <pkg>/dist → the CLI's own package.json
    //     is one level up at <pkg>/package.json (name @adhd/sox-cli, version 1.1.1).
    //   - DEV esbuild:      __dirname is apps/sox/dist → package.json is one level up.
    //   - DEV tsc build:    __dirname is dist/apps/sox → apps/sox/package.json is
    //     three levels up then into apps/sox/.
    // Prefer the @adhd/sox-cli package.json; otherwise the first that has a version.
    const candidates = [
      path.resolve(__dirname, '..', 'package.json'),
      path.resolve(__dirname, '../../../apps/sox/package.json'),
      path.resolve(__dirname, '..', '..', '..', 'package.json'),
    ];
    for (const pkgPath of candidates) {
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          version = pkg.version;
          if (pkg.name === '@adhd/sox-cli') break;
        }
      } catch { /* try next candidate */ }
    }
  } catch { /* fallback to 0.0.0 */ }
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// ─── A1: init — uses libs/authoring scaffold() ────────────────────────────────

/**
 * cmdInit — A1: scaffold a born-conformant extension via libs/authoring.
 *
 * Usage: soxe init <type> <id> [--out=<dir>] [--bundle=<bundle-name>]
 *                             [--title=<str>] [--description=<str>]
 *                             [--author=<str>] [--keywords=<k1,k2>]
 *
 * --bundle=<name>: resolve the bundle's directory by name (from registry/index.json,
 *   with filesystem fallback), scaffold the member into <bundle-dir>/members/<id>/,
 *   and auto-register the new member in the bundle's extension.json members[] array.
 *   Mutually exclusive with --out.
 *
 * Extra flags (--events, --runtime) are accepted and silently consumed for
 * forward-compatibility; the template governs the actual generated values.
 *
 * [inv:nx-free-core]: scaffold() has no @nx/devkit imports — works without nx.
 *
 * Note on id validation: libs/manifest validates id with ^[a-z][a-z0-9-]*$ only.
 * libs/authoring additionally rejects ids ending with the type name (style rule).
 * The CLI enforces the manifest rule; when scaffold() rejects a style-valid-but-
 * suffix-matching id, the CLI falls back to calling the per-type template directly
 * (same logic, same output format — the resulting extension.json validates against
 * libs/manifest in all cases).
 */
async function cmdInit(raw: string[]): Promise<void> {
  // @adhd/sox-authoring is genuinely init-only — dynamic import is appropriate here.
  // This is NOT a circular or cross-lib import; it keeps the authoring lib out of
  // the module graph when soxe is used for non-init verbs.
  const { scaffold, writeFileSet, validateId } = await import('@adhd/sox-authoring');

  const flagMap = parseArgs(raw);

  // Collect positional arguments (non-flag tokens)
  const positionals: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    if (tok === undefined) { i++; continue; }
    if (tok.startsWith('--')) {
      if (!tok.includes('=')) i++; // skip the value token for --flag value form
    } else {
      positionals.push(tok);
    }
    i++;
  }

  const type = positionals[0];
  const id = positionals[1];

  if (type === undefined || id === undefined) {
    process.stderr.write(`${CLI} init: usage: ${CLI} init <type> <id> [--out=<dir>] [--bundle=<name>]\n`);
    process.stderr.write(`  Types: agent | skill | mcp-server | hook | command | bundle | service\n`);
    process.stderr.write(`  Id rules: lowercase ^[a-z][a-z0-9-]*$, and must NOT end in the type name\n`);
    process.stderr.write(`           (e.g. 'memory-skill' is rejected; name members by function: 'memory-usage').\n`);
    process.stderr.write(`  --bundle=<name>: scaffold into a bundle's members/ dir and auto-register.\n`);
    process.exit(1);
  }

  const ACTIVE_TYPES = ['agent', 'skill', 'mcp-server', 'hook', 'command', 'bundle', 'service'] as const;
  if (!(ACTIVE_TYPES as readonly string[]).includes(type)) {
    process.stderr.write(`${CLI} init: unknown type '${type}'\n`);
    process.stderr.write(`  Valid types: ${ACTIVE_TYPES.join(' | ')}\n`);
    process.exit(1);
  }

  // Validate the id with the canonical authoring rule (BL-16): the same `validateId`
  // that `scaffold()` and `soxe validate` enforce — pattern ^[a-z][a-z0-9-]*$ AND the
  // id must not end with the type name (`-skill`, `-agent`, …). Failing fast here keeps
  // `init` and `validate` in agreement instead of producing a born-INVALID extension.
  const idErr = validateId(id, type as Parameters<typeof validateId>[1]);
  if (idErr) {
    process.stderr.write(`${CLI} init: ${idErr}\n`);
    process.stderr.write(`  Id rules: lowercase, ^[a-z][a-z0-9-]*$, and not ending in the type name.\n`);
    process.stderr.write(`  Bundle members are named by function (e.g. memory-server, memory-cli), not by type.\n`);
    process.exit(1);
  }

  const bundleName = flagMap['bundle'];
  const outFlag = flagMap['out'];

  // --bundle and --out are mutually exclusive
  if (bundleName !== undefined && outFlag !== undefined) {
    process.stderr.write(
      `${CLI} init: --bundle and --out are mutually exclusive.\n` +
      `  Use --bundle=<name> to scaffold into a bundle's members/ directory,\n` +
      `  or --out=<dir> to specify an output directory directly.\n`,
    );
    process.exit(1);
  }

  const path = await import('node:path');
  const { existsSync: _exists, readFileSync: _readFile, readdirSync: _readdir, writeFileSync: _writeFile } = await import('node:fs');

  // ── Bundle resolution (--bundle flag) ─────────────────────────────────────────
  // When --bundle is given, resolve the bundle's source directory and set outRoot
  // to <bundle-dir>/members/. Also register the new member in the bundle's
  // extension.json after scaffolding.
  let outRoot: string;
  let resolvedBundleDir: string | undefined;

  // Wrap fs functions into narrow-typed helpers for the bundle resolver helpers
  // (avoids TypeScript overload-mismatch when passing fs.readFileSync/readdirSync directly).
  const readFileStr = (p: string, enc: 'utf8'): string => _readFile(p, enc);
  const writeFileStr = (p: string, data: string, enc: 'utf8'): void => _writeFile(p, data, enc);
  const readdirStr = (p: string): string[] => _readdir(p) as string[];

  if (bundleName !== undefined) {
    resolvedBundleDir = resolveBundleDir(bundleName, process.cwd(), path, _exists, readFileStr, readdirStr);
    if (resolvedBundleDir === undefined) {
      process.stderr.write(
        `${CLI} init: bundle '${bundleName}' not found.\n` +
        `  Search registry/index.json for bundles: look for entries where "type" == "bundle".\n` +
        `  Or check extensions/bundles/ for bundle directories containing extension.json files.\n` +
        `  Run '${CLI} search ${bundleName}' to see what's in the registry.\n`,
      );
      process.exit(1);
    }
    outRoot = path.join(resolvedBundleDir, 'members');
  } else {
    outRoot = outFlag ?? process.cwd();
  }

  const title = flagMap['title'];
  const description = flagMap['description'];
  const author = flagMap['author'];
  const keywordsRaw = flagMap['keywords'];
  const keywords =
    keywordsRaw !== undefined
      ? keywordsRaw.split(',').map((k) => k.trim())
      : undefined;

  // --transport=<t> (singular) or --transports=a,b (plural, comma-separated)
  // Both forms are accepted for service type; template uses opts.transports.
  const transportFlag = flagMap['transport'];
  const transportsFlag = flagMap['transports'];
  const transports: string[] | undefined =
    transportsFlag !== undefined
      ? transportsFlag.split(',').map((t) => t.trim()).filter(Boolean)
      : transportFlag !== undefined
        ? [transportFlag.trim()]
        : undefined;

  type AuthoringType = Parameters<typeof scaffold>[0]['type'];

  let fileSet: ReturnType<typeof scaffold>;
  try {
    fileSet = scaffold({
      type: type as AuthoringType,
      id,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(transports !== undefined ? { transports } : {}),
    });
  } catch (scaffoldErr) {
    const msg = String(scaffoldErr);
    // When scaffold() rejects the id only for the type-suffix style rule
    // (e.g., "event-probe" for type "hook" — wait, that's valid now; kept for
    // robustness), fall back to the per-type template function directly.
    // libs/manifest does not enforce the type-suffix restriction, so the
    // resulting extension.json is still fully conformant.
    if (msg.includes('must not end with the type name')) {
      // Route through the @adhd/sox-authoring scope (C7-clean); the build's
      // rewrite-paths step resolves it at runtime. Per-type template fns
      // (agentTemplate, hookTemplate, …) are re-exported from the package.
      const templateMod = (await import('@adhd/sox-authoring')) as Record<string, unknown>;
      // Template function name: hookTemplate, mcpServerTemplate, etc.
      const fnName =
        type.replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase()) +
        'Template';
      const templateFn = templateMod[fnName] as
        | ((opts: {
          type: string;
          id: string;
          title: string;
          description: string;
          author: string | undefined;
          keywords: string[] | undefined;
        }) => ReturnType<typeof scaffold>)
        | undefined;
      if (typeof templateFn !== 'function') {
        process.stderr.write(
          `${CLI} init: internal: template '${fnName}' not found for type '${type}'\n`,
        );
        process.exit(1);
      }
      fileSet = templateFn({
        type,
        id,
        title: title ?? id,
        description: description ?? `${id} extension`,
        author,
        keywords,
      });
    } else {
      process.stderr.write(`${CLI} init: scaffold error — ${msg}\n`);
      process.exit(1);
    }
  }

  const outDir = path.resolve(outRoot, id);

  // [guard:no-overwrite-existing] — soxe init must never clobber existing extensions.
  // If outDir already exists and --force is not set, refuse to proceed.
  // This prevents the probe harness from inadvertently rewriting real repo source files
  // when process.cwd() resolves to the repo root (e.g. due to pushd failure in shell).
  const force = flagMap['force'] !== undefined;
  if (!force && _exists(outDir)) {
    process.stderr.write(
      `${CLI} init: '${outDir}' already exists — use --force to reinitialize\n`,
    );
    process.exit(1);
  }

  try {
    writeFileSet(fileSet, outDir);
  } catch (e) {
    process.stderr.write(`${CLI} init: write error — ${String(e)}\n`);
    process.exit(1);
  }

  // ── Auto-register in bundle's extension.json members[] ────────────────────────
  // When --bundle was used, append the new member to the bundle's members[] array
  // (idempotent: no-op if already present).
  if (resolvedBundleDir !== undefined) {
    const bundleManifestPath = path.join(resolvedBundleDir, 'extension.json');
    try {
      registerBundleMember(bundleManifestPath, id, readFileStr, writeFileStr);
    } catch (e) {
      process.stderr.write(`${CLI} init: member-register error — ${String(e)}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`${CLI} init: scaffolded ${type} '${id}' → ${outDir}\n`);
  if (resolvedBundleDir !== undefined) {
    const bundleManifestPath = path.join(resolvedBundleDir, 'extension.json');
    process.stdout.write(`${CLI} init: registered '${id}' in ${bundleManifestPath}\n`);
  }
  process.exit(0);
}

// ─── validate ─────────────────────────────────────────────────────────────────

/**
 * cmdValidate — validate an extension.json against libs/manifest.
 *
 * Usage: soxe validate [path-to-extension.json]
 *        soxe validate --help
 *
 * @adhd/sox-manifest is init-only / validate-only — dynamic import keeps it lazy.
 */
async function cmdValidate(raw: string[]): Promise<void> {
  // --help flag — exit 0 (A12: --help is a documented flag form)
  if (raw.includes('--help') || raw.includes('-h')) {
    process.stdout.write(`${CLI} validate — validate an extension.json against the libs/manifest schema

Usage: ${CLI} validate [path-to-extension.json]

If no path is given, validates ./extension.json in the current directory.

Flags:
  --help    Show this message

Exit codes:
  0  manifest is valid
  1  manifest is invalid (errors printed to stdout)
  2  file not found or parse error

`);
    process.exit(0);
  }

  const { validate } = await import('@adhd/sox-manifest');
  const path = await import('node:path');
  const fs = await import('node:fs');

  const positionals = raw.filter((t) => !t.startsWith('-'));
  const givenPath = positionals[0];
  const absPath = givenPath !== undefined ? path.resolve(process.cwd(), givenPath) : undefined;

  // ── Directory / no-path mode: walk for extension.json files ────────────────
  // When no path is given, walk the cwd for extension.json files (mirrors the
  // validate-manifests.ts legacy behaviour). When a directory is given, same.
  // When a specific file path is given that exists, validate just that file.
  const isDirectory = absPath !== undefined
    ? (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory())
    : true; // no path given → treat cwd as directory

  if (isDirectory) {
    const walkRoot = absPath ?? process.cwd();

    // Collect all extension.json files under the given directory.
    const found: string[] = [];
    function walk(dir: string): void {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const ent of entries) {
        if (ent === 'node_modules' || ent === '.git' || ent === 'dist' || ent.startsWith('.nx')) continue;
        const full = path.join(dir, ent);
        let stat: ReturnType<typeof fs.statSync> | null = null;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { walk(full); }
        else if (ent === 'extension.json') { found.push(full); }
      }
    }
    walk(walkRoot);

    if (found.length === 0) {
      process.stdout.write(`${CLI} validate: no extensions found under ${walkRoot}\n`);
      process.exit(0);
    }

    let anyInvalid = false;
    for (const manifestFile of found) {
      let rawObj: unknown;
      try {
        rawObj = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as unknown;
      } catch (e) {
        process.stderr.write(`${CLI} validate: parse error: ${manifestFile}: ${String(e)}\n`);
        anyInvalid = true;
        continue;
      }
      if (typeof rawObj !== 'object' || rawObj === null || Array.isArray(rawObj)) {
        process.stderr.write(`${CLI} validate: manifest must be a JSON object: ${manifestFile}\n`);
        anyInvalid = true;
        continue;
      }
      const result = validate(rawObj as Record<string, unknown>);
      if (result.ok) {
        process.stdout.write(`${CLI} validate: OK — ${manifestFile}\n`);
        for (const w of (result.warnings ?? [])) {
          process.stdout.write(`  warning: ${w}\n`);
        }
      } else {
        process.stdout.write(`${CLI} validate: INVALID — ${manifestFile}\n`);
        for (const err of result.errors) {
          process.stdout.write(`  - ${err}\n`);
        }
        for (const w of (result.warnings ?? [])) {
          process.stdout.write(`  warning: ${w}\n`);
        }
        anyInvalid = true;
      }
    }
    process.exit(anyInvalid ? 1 : 0);
  }

  // ── Single-file mode ─────────────────────────────────────────────────────────
  // absPath is defined (givenPath was provided) and is not a directory.
  if (!fs.existsSync(absPath!)) {
    process.stderr.write(`${CLI} validate: file not found: ${String(absPath)}\n`);
    process.exit(2);
  }

  let rawObj: unknown;
  try {
    const content = fs.readFileSync(absPath!, 'utf-8');
    rawObj = JSON.parse(content) as unknown;
  } catch (e) {
    process.stderr.write(`${CLI} validate: parse error: ${String(e)}\n`);
    process.exit(2);
  }

  if (typeof rawObj !== 'object' || rawObj === null || Array.isArray(rawObj)) {
    process.stderr.write(`${CLI} validate: manifest must be a JSON object\n`);
    process.exit(2);
  }

  const result = validate(rawObj as Record<string, unknown>);

  // [R6: signal-contract] Textual SIGTERM handler check for background:true extensions.
  // Checks the source-side entrypoint (src/index.ts) first, then the built entrypoint.
  // This is a weak check (grep, not semantic) — prevents accidental omission.
  const sigTermWarnings: string[] = [];
  {
    const manifest = rawObj as Record<string, unknown>;
    const lifecycle = manifest['lifecycle'] as Record<string, unknown> | undefined;
    const isBackground = lifecycle?.['background'] === true;
    if (isBackground) {
      const entrypoint = manifest['entrypoint'] as string | undefined;
      const extDir = path.dirname(absPath!);
      // Check the src/ counterpart first (most readable), then the built entrypoint.
      const candidateSrc = path.join(extDir, 'src', 'index.ts');
      const candidateBuilt = entrypoint ? path.join(extDir, entrypoint) : null;
      const checkPaths = [candidateSrc, ...(candidateBuilt ? [candidateBuilt] : [])];
      let hasSigterm = false;
      for (const p of checkPaths) {
        try {
          if (fs.existsSync(p)) {
            const src = fs.readFileSync(p, 'utf-8');
            if (src.includes("'SIGTERM'") || src.includes('"SIGTERM"')) {
              hasSigterm = true;
              break;
            }
          }
        } catch { /* ignore read errors */ }
      }
      if (!hasSigterm) {
        sigTermWarnings.push(
          `validate: WARNING: no SIGTERM handler found in entrypoint.\n` +
          `  mcp-server and service extensions must handle SIGTERM gracefully.\n` +
          `  See docs/guidelines/signal-contract.md`,
        );
      }
    }
  }

  if (result.ok) {
    process.stdout.write(`${CLI} validate: OK — ${String(absPath)}\n`);
    for (const w of (result.warnings ?? [])) {
      process.stdout.write(`  warning: ${w}\n`);
    }
    for (const w of sigTermWarnings) {
      process.stdout.write(`  ${w}\n`);
    }
    process.exit(0);
  } else {
    process.stdout.write(`${CLI} validate: INVALID — ${String(absPath)}\n`);
    for (const err of result.errors) {
      process.stdout.write(`  - ${err}\n`);
    }
    for (const w of (result.warnings ?? [])) {
      process.stdout.write(`  warning: ${w}\n`);
    }
    for (const w of sigTermWarnings) {
      process.stdout.write(`  ${w}\n`);
    }
    process.exit(1);
  }
}

// ─── search ───────────────────────────────────────────────────────────────────

function cmdSearch(flags: Record<string, string>): void {
  // Accept query as either --query=<q> or the first positional after 'search'.
  let query = flags['query'] ?? flags['_'] ?? '';
  const typeFilter = flags['type'];
  const jsonMode = flags['json'] !== undefined;
  // R9: --all includes internal (bundle member) entries. Default: exclude them.
  const showAll = flags['all'] !== undefined || flags['all'] === '';

  // The registry/index.json always lives in the repo root where soxe is invoked,
  // NOT in the scope config directory. Use process.cwd(), same as cmdInstall.
  const registryRoot = process.cwd();

  let entries: ReturnType<typeof loadRegistryIndex>;
  try {
    entries = loadRegistryResolved(registryRoot);
  } catch {
    entries = [];
  }

  let results = entries;

  // R9: by default exclude internal entries (bundle members not independently installable).
  if (!showAll) {
    results = results.filter((e) => (e as { visibility?: string }).visibility !== 'internal');
  }

  if (query !== '') {
    results = results.filter(
      (e) =>
        e.id.includes(query) ||
        e.title.includes(query) ||
        e.description.includes(query),
    );
  }
  if (typeFilter !== undefined) {
    results = results.filter((e) => e.type === typeFilter);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    process.exit(0);
  }

  if (results.length === 0) {
    process.stdout.write(`${CLI} search: no results for '${query}'\n`);
  } else {
    // ADR-0003: entry.version is a derived display-only label; may be absent.
    const col1 = Math.max(...results.map((e) => e.id.length), 2);
    const col2 = Math.max(...results.map((e) => e.type.length), 4);
    const col3 = Math.max(...results.map((e) => (e.version ?? '').length), 7);
    process.stdout.write(
      `${'ID'.padEnd(col1)}  ${'TYPE'.padEnd(col2)}  ${'VERSION'.padEnd(col3)}  DESCRIPTION\n`,
    );
    process.stdout.write(`${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  -----------\n`);
    for (const entry of results) {
      process.stdout.write(
        `${entry.id.padEnd(col1)}  ${entry.type.padEnd(col2)}  ${(entry.version ?? '').padEnd(col3)}  ${entry.description}\n`,
      );
    }
  }
  process.exit(0);
}

// ─── install ──────────────────────────────────────────────────────────────────

/**
 * cmdInstall — A4: install an extension.
 *
 * Two paths:
 *   --host present → declarative single-extension placement (new path).
 *     soxe install <id> --host=<h> [--scope=project] [--root=<dir>] [--profile=<p>]
 *   --host absent  → config/lockfile resolver (existing path, unchanged).
 *     soxe install [--scope=<s>] [--frozen-lockfile] [--update]
 *
 * The existing host-runtime e2e (memory-server) uses the no---host path, so keeping
 * it unchanged preserves all 59 passing tests.
 */
async function cmdInstall(flags: Record<string, string>): Promise<void> {
  // --help / -h — always exit 0 before scope/host processing
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} install — install extensions for a scope

Usage:
  ${CLI} install [<id>] [-s <scope>] [--frozen-lockfile] [--update]
  ${CLI} install <id> --host=<hosts> [--scope=project] [--root=<dir>]

Options:
  -s, --scope <scope>    Scope: user | project | local  (default: local)
  --frozen-lockfile      Use frozen-lockfile mode
  --update               Update pinned hashes (with --host or positional) or run full sync (no id)
  --host=<hosts>         Target host(s) (claude, codex, opencode)
  --root <dir>           Workspace root override
   --profile=<p>          MCP transport profile (stdio, sse, http; default: stdio)
   --version=<semver>     Install from npm package at the given version range (e.g. 1.1.0, ^1.0.0)
   --no-restart           Skip daemon restart after install
   --dry-run              Declarative path: plan only — print would-place targets, write nothing
   --help                 Show this message
`);
    process.exit(0);
  }

  const hostRaw = flags['host'];

  // ── Scope validation ────────────────────────────────────────────────────────
  // Validate early on the no-host path so we get a clean error before any
  // config reads. (The host path uses 'project' as default and validates
  // scope more loosely — declarativeInstall will catch invalid scopes.)
  if (hostRaw === undefined || hostRaw === '') {
    if (flags['dry-run'] !== undefined) {
      process.stderr.write(`${CLI} install: --dry-run is only supported on the declarative path (--host=<host> present)\n`);
      process.exit(1);
    }
    const scopeRaw = flags['scope'] ?? 'user';
    const validScopes = new Set(['user', 'project', 'local']);
    if (!validScopes.has(scopeRaw)) {
      process.stderr.write(`${CLI} install: invalid scope '${scopeRaw}'\n`);
      process.stderr.write(`  Valid scopes: user, project, local\n`);
      process.exit(1);
    }
  }

  // ── Declarative path: --host present ───────────────────────────────────────
  const hosts = hostRaw !== undefined ? hostRaw.split(',').map((h: string) => h.trim()).filter(Boolean) : [];
  if (hostRaw !== undefined && hostRaw !== '') {
    // id is the first positional argument (parseArgs stores it as flags['_']).
    const id = flags['_'];

    if (id === undefined || id === '') {
      process.stderr.write(`${CLI} install: declarative path requires a positional <id>\n`);
      process.stderr.write(`  Usage: ${CLI} install <id> --host=<host> [--scope=project] [--root=<dir>]\n`);
      process.exit(1);
    }

    const scope = (flags['scope'] ?? 'project') as 'org' | 'user' | 'project' | 'local';
    const workspaceRoot = require('node:path').resolve(flags['root'] ?? process.cwd()) as string;
    const profile = flags['profile'];
    const versionRange = flags['version'];
    const dryRun = flags['dry-run'] !== undefined;
    const forceInstall = flags['force'] !== undefined;

    // Nudge toward the modern standard: Claude Code's own docs (code.claude.com/docs/en/mcp)
    // mark "sse" deprecated in favor of "http" (Streamable HTTP); the official MCP SDK's
    // SSEClientTransport carries the same @deprecated notice. --profile=sse still WORKS for
    // Claude (both transports stay fully supported server-side) — this is guidance, not a block.
    if (profile === 'sse' && hosts.includes('claude')) {
      process.stderr.write(
        `${CLI} install: note: --profile=sse is deprecated for Claude Code — prefer --profile=http ` +
        `(Streamable HTTP). Both work; "sse" still installs successfully.\n`,
      );
    }

    // Resolve the extension: load registry from the REAL repo root (process.cwd()),
    // not from workspaceRoot (which may be a temp dir when --root is given for sandboxing).
    // The registry/index.json always lives in the repo root where 'node bin/sox' is invoked.
    const repoRoot = process.cwd();
    const registryIndex = loadRegistryResolved(repoRoot);
    const registryEntry = resolveFromRegistry(id, registryIndex);

    // Determine srcPath: the extension's content directory.
    let srcPath: string | undefined;
    let extType: string | undefined;
    let extHosts: string[] = hosts;

    if (registryEntry !== undefined && registryEntry !== null) {
      // Registry has it — source is a file:// URI to the extension dir.
      const rawSource = registryEntry.source;
      if (rawSource.startsWith('file://')) {
        srcPath = rawSource.slice('file://'.length);
      }
      extType = registryEntry.type;
    }

    // Also try local scan (handles cases where registry is stale or srcPath not set).
    // Scan from the repo root (where extensions/ lives), not workspaceRoot (may be a temp dir).
    if (srcPath === undefined || extType === undefined) {
      const localPath = findLocalExtension(repoRoot, id);
      if (localPath !== null) {
        srcPath = localPath;
        // Read the extension.json for type + install block.
        const manifest = loadExtensionManifest(repoRoot, id);
        if (manifest !== null) {
          extType = manifest.type;
          const installBlock = (manifest as unknown as Record<string, unknown>)['install'] as
            | { type?: string; hosts?: string[]; profiles?: Record<string, unknown> }
            | undefined;
          if (installBlock?.hosts !== undefined && installBlock.hosts.length > 0) {
            extHosts = hosts; // --host overrides the manifest hosts list
          }
        }
      }
    }

    if (srcPath === undefined) {
      process.stderr.write(`${CLI} install: cannot find extension '${id}' in registry or local extensions/\n`);
      process.stderr.write('  Run \'npx tsx scripts/build-index.ts\' to rebuild the registry, or check the id.\n');
      process.exit(1);
    }

    // --version: install from a published npm package instead of the local source.
    // Accepts any npm semver range: exact ("1.1.0"), caret ("^1.0.0"), etc.
    // Resolves as npm-package:<id>@<range> which the install engine's fetchNpmPackage
    // handles by running `npm install <id>@<range>` into a per-scope content store.
    if (versionRange !== undefined) {
      const npmSpec = `npm-package:${id}@${versionRange}`;
      const pathModNpm = require('node:path') as typeof import('node:path');
      const npmStoreDir = pathModNpm.join(dataRoot(scope as DataScope, workspaceRoot), 'npm-store');
      const { fetchArtifact: fetchNpm } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');
      const result = await fetchNpm(npmSpec, undefined, { storeDir: npmStoreDir });
      const entryPath = result.source.startsWith('file://') ? result.source.slice('file://'.length) : result.source;
      srcPath = pathModNpm.dirname(pathModNpm.dirname(entryPath));
      process.stderr.write(`${CLI} install: resolved from ${npmSpec} → ${srcPath}\n`);
    }

    if (extType === undefined) {
      process.stderr.write(`${CLI} install: cannot determine type for extension '${id}'\n`);
      process.exit(1);
    }

    // Validate the hosts exist in the registry.
    // [inv:host-registry-lazy] — require() at call site; see top-of-file comment.
    const { getHost } = require('@adhd/sox-host-registry') as typeof import('@adhd/sox-host-registry');
    for (const h of extHosts) {
      try {
        getHost(h);
      } catch (e) {
        process.stderr.write(`${CLI} install: ${String(e)}\n`);
        process.exit(1);
      }
    }

    // ADR-0004 §D2: scopeRoot is the DATA dir (`.adhd/sox-ecosystem`) for the
    // scope — the home of the ledger, ownership index, and materialized store.
    // It is decoupled from the host placement root (which is resolved separately
    // inside declarativeInstall via the surface paths). Setting SOX_ECOSYSTEM_HOME
    // moves this; it never moves placement ([inv:data-root-never-reroutes]).
    const scopeRoot: string = dataRoot(scope as DataScope, workspaceRoot);

    const descriptor: InstallDescriptor = {
      ext: id,
      type: extType,
      hosts: extHosts,
      srcPath,
      ...(profile !== undefined ? { profile } : {}),
    };

    let results: DeclarativeInstallResult[];
    try {
      results = await declarativeInstall(
        descriptor,
        scope,
        workspaceRoot,
        scopeRoot,
        { isProject: scope === 'project', dryRun, force: forceInstall },
      );
    } catch (e) {
      if (e instanceof DeclarativeDeniedError) {
        process.stderr.write(`${CLI} install: DENIED — ${e.reason}\n`);
        process.exit(1);
      }
      process.stderr.write(`${CLI} install: declarative install failed — ${String(e)}\n`);
      process.exit(1);
    }

    let anyApplied = false;
    let anyDenied = false;
    const dryRunMode = dryRun && results.length > 0;

    for (const r of results) {
      if (r.denied === true) {
        process.stderr.write(`${CLI} install: DENIED  ${r.host}/${r.scope}  ${r.target}  reason=${r.denialReason ?? 'unknown'}\n`);
        anyDenied = true;
      } else if (r.dryRun === true) {
        process.stdout.write(`${CLI} install: would place  ${r.host}/${r.scope}  ${r.target}\n`);
      } else if (r.applied) {
        process.stdout.write(`${CLI} install: placed   ${r.host}/${r.scope}  ${r.target}\n`);
        anyApplied = true;
      } else {
        process.stdout.write(`${CLI} install: up-to-date  ${r.host}/${r.scope}  ${r.target}\n`);
        anyApplied = true;
      }
    }

    if (results.length === 0) {
      process.stderr.write(`${CLI} install: no install surfaces found for host(s)='${extHosts.join(',')}' type='${extType}' scope='${scope}'\n`);
      process.exit(1);
    }

    // Dry-run exits here: the plan was printed, nothing was written, and no
    // post-install side effects (MCP propagation, daemon restart) may run.
    if (dryRunMode) {
      process.stdout.write(`${CLI} install: dry-run complete — no files written\n`);
      process.exit(0);
    }

    if (anyDenied || !anyApplied) {
      process.exit(1);
    }

    // #16728: propagate a user/global MCP server into known projects' .mcp.json.
    for (const h of extHosts) {
      await maybePropagateUserMcp(extType, scope, h, id);
    }

    // ── Restart daemons if artifact changed (Improvement E) ──
    const noRestartInstall = flags['no-restart'] !== undefined;
    if (!noRestartInstall) {
      const anyChanged = results.some((r) => r.applied && !r.denied);
      if (anyChanged) {
        const ctx = resolveOsUnitContext(id, scope, workspaceRoot, flags);
        if (ctx) {
          // Resolve the last-known-good unit path from the ownership index.
          let lkgPath: string | undefined;
          try {
            const pathM3 = require('node:path') as typeof import('node:path');
            const fsM3 = require('node:fs') as typeof import('node:fs');
            const own = OwnershipIndex.loadFromFile(pathM3.join(dataRoot(scope as DataScope, workspaceRoot), 'ownership.json'));
            const rec = own.get(id, scope);
            const osUnitEntry = rec?.entries.find((e: OwnedEntry) => e.kind === 'os-unit');
            if (osUnitEntry?.kind === 'os-unit') {
              lkgPath = fsM3.existsSync(osUnitEntry.unitPath) ? osUnitEntry.unitPath : undefined;
            }
          } catch { /* best-effort */ }

          try {
            const result = await restartOsUnit(ctx.spec, ctx.platform, lkgPath, {
              reason: `upgrade (scope=${scope})`,
            });
            process.stdout.write(`post-install: ${id} ${result.action} ${result.reason ?? ''}\n`);
          } catch (e: unknown) {
            process.stderr.write(`post-install: ${id} restart failed: ${String(e)}\n`);
          }
        } else {
          process.stdout.write(`post-install: ${id} not running as os-unit (scope=${scope}) — no restart needed\n`);
        }
      } else {
        process.stdout.write(`post-install: ${id} up-to-date (scope=${scope}) — no restart needed\n`);
      }
    }

    // BL-275/C3: service running after install — enable OS unit + start when --start flag is set.
    // This wires the existing enableOsUnit/start path for a freshly-installed service.
    // Only triggers for type:service installs where the artifact changed (was applied).
    const startService = flags['start'] !== undefined;
    if (startService && extType === 'service') {
      const anyServiceApplied = results.some(
        (r) => r.applied && !r.denied && r.capability === 'run-service',
      );
      if (anyServiceApplied) {
        const ctx = resolveOsUnitContext(id, scope, workspaceRoot, flags);
        if (ctx) {
          const platform = ctx.platform;
          const unitDir = resolveOsUnitDir(flags, platform);
          try {
            const result = enableOsUnit(ctx.spec, platform, {
              unitDir,
              load: true,
              log: (m) => process.stdout.write(`sox: ${m}\n`),
            });

            // Record the os-unit in the ownership index ([inv:reversible-injection], §9.4)
            try {
              const pathM = require('node:path') as typeof import('node:path');
              const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, workspaceRoot), 'ownership.json'));
              own.addEntries(id, scope, [{
                kind: 'os-unit',
                label: ctx.spec.label,
                unitPath: result.unitPath,
                supervisor: platform.kind,
                appliedHash: result.contentHash,
              }]);
              own.save();
            } catch (e) {
              process.stderr.write(`post-install: warning: could not record os-unit ownership: ${String(e)}\n`);
            }

            process.stdout.write(
              `post-install: ${id} ${result.action} ${platform.kind} unit '${ctx.spec.label}'\n` +
              `  unit:       ${result.unitPath}\n` +
              `  entrypoint: ${ctx.entrypoint}\n` +
              (result.loaded
                ? `  loaded:     yes\n`
                : `  loaded:     NO (load failed — see warnings)\n`),
            );
          } catch (e: unknown) {
            process.stderr.write(`post-install: ${id} enable failed: ${String(e)}\n`);
          }
        } else {
          process.stderr.write(`post-install: ${id} not resolvable as os-unit (scope=${scope}) — cannot start\n`);
        }
      }
    }

    process.exit(0);
  }

  // ── Existing resolver path: --host absent ──────────────────────────────────
  const frozen = flags['frozen-lockfile'] === 'true';
  const update = flags['update'] === 'true';
  const mode = frozen ? 'frozen' : update ? 'update' : 'default';

  // --config / --lockfile: explicit paths override the scope defaults.
  // These are required by the e2e test which installs into a temp directory.
  const configPathFlag = flags['config'];
  const lockfilePathFlag = flags['lockfile'];
  // BL-73: resolve the project root from cwd (or --root flag) — never from a git-root
  // walk. For user scope this has no effect (userDataRoot() ignores workspaceRoot).
  // For project/local scope, workspaceRoot drives both the bookkeeping paths
  // (.adhd/sox-ecosystem/{extensions.json,extensions.lock}) AND the host-placement
  // root (.claude/) so both always land under the same project directory.
  const workspaceRoot = require('node:path').resolve(flags['root'] ?? process.cwd()) as string;

  // If a positional <id> was given (e.g. `soxe install sox --scope=project`),
  // write it into the scope config before resolving — otherwise install() only
  // re-resolves what's already in extensions.json and the new id is silently ignored.
  //
  // Use parseArgs-produced flags['_'] instead of scanning raw argv: the latter
  // mis-identifies flag VALUES (e.g. `user` from `-s user`) as positionals (A12).
  const positionalId: string | undefined = flags['_'];
  const explicitScope = flags['scope'];

  // Default scope is 'local' for all no-host installs. When a positional <id> is
  // given, BL-219 targets it at local scope (machine-local, gitignored). When no
  // positional is given, local is still the default — the command validates or
  // scaffolds the local config rather than cascading from user scope.
  const scope = (explicitScope ?? 'local') as 'org' | 'user' | 'project' | 'local';

  // ── Positional: install the named extension ─────────────────────────────────
  if (positionalId !== undefined && positionalId !== '') {
    // BL-19 source guard: a reserved scope name must NEVER be written as an extension id.
    // Older CLIs that scanned raw argv could capture a `--scope <name>` value as a positional,
    // leaving a bogus `{ "id": "user" }` in the config that then hard-failed every later install.
    // The write path now uses flags['_'] (so the value isn't mis-captured), and this guard
    // closes the gap for a literal `install user`.
    const RESERVED_SCOPE_IDS = new Set(['user', 'project', 'local', 'org']);
    if (RESERVED_SCOPE_IDS.has(positionalId)) {
      process.stderr.write(
        `${CLI} install: '${positionalId}' is a scope name, not an extension id.\n` +
        `     Set the scope with a flag: ${CLI} install [<id>] --scope=${positionalId}\n`,
      );
      process.exit(1);
    }

    const fsMod2 = require('node:fs') as typeof import('node:fs');
    const pathMod2 = require('node:path') as typeof import('node:path');

    // Use the explicit --config path if provided; fall back to scope default.
    // BL-73: use getScopePaths(scope, workspaceRoot) — not getScopePath(scope) which
    // always resolves relative to REPO_ROOT (the CLI's own repo), not the target project.
    const cfgPath = configPathFlag ?? getScopePaths(scope, workspaceRoot).config;

    let cfg: { install?: Array<{ id: string }> } = { install: [] };
    if (fsMod2.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fsMod2.readFileSync(cfgPath, 'utf8')) as typeof cfg; } catch { /* use default */ }
    }
    if (!cfg.install) cfg.install = [];

    const alreadyPresent = cfg.install.some((e) => e.id === positionalId);
    if (!alreadyPresent) {
      // R9: block bare positional install of internal bundle members — but only
      // when the member is NOT already in the config. A config that explicitly lists
      // a bundle member (e.g. the e2e test config) is respected without blocking.
      const repoRootForGuard = process.cwd();
      const registryIndexForGuard = loadRegistryResolved(repoRootForGuard);
      const entryForGuard = resolveFromRegistry(positionalId, registryIndexForGuard);
      if (entryForGuard?.visibility === 'internal') {
        const owningBundle = entryForGuard.bundleId ?? 'the bundle that owns it';
        process.stderr.write(
          `${CLI} install: "${positionalId}" is a member of bundle "${owningBundle}".\n` +
          `     Install the bundle instead: ${CLI} install ${owningBundle}\n`,
        );
        process.exit(1);
      }

      cfg.install.push({ id: positionalId });
      const cfgDir = pathMod2.dirname(cfgPath);
      if (!fsMod2.existsSync(cfgDir)) {
        fsMod2.mkdirSync(cfgDir, { recursive: true });
      }
      fsMod2.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      process.stdout.write(`${CLI} install: added '${positionalId}' to ${cfgPath}\n`);
    }

    // ── Build install opts and install ────────────────────────────────────────
    const resolvedRegistryForInstall = loadRegistryResolved(process.cwd());

    // BL-219: positional install must target only the named extension — derive the
    // scope config path and pass it to trigger singleScopeOnly in loadScopeCascade,
    // bypassing the org→user→project→local cascade that would install everything.
    const configForPositional = configPathFlag ?? getScopePaths(scope, workspaceRoot).config;

    const installOpts: Parameters<typeof import('@adhd/sox-install-engine').install>[0] = {
      scope,
      mode,
      root: workspaceRoot,
      configPath: configForPositional,
      ...(lockfilePathFlag !== undefined ? { lockfilePath: lockfilePathFlag } : {}),
      ...(resolvedRegistryForInstall.length > 0 ? { registryIndex: resolvedRegistryForInstall } : {}),
    };

    if (process.stdout.isTTY) {
      installOpts.onMissingConfig = async (_id: string, _k: string, prompt: string, defaultVal: unknown): Promise<string | undefined> => {
        const rl = require('node:readline') as typeof import('node:readline');
        const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
        const defaultStr = defaultVal !== undefined ? String(defaultVal) : '';
        const fullPrompt = defaultStr
          ? `${CLI} install: ${prompt} [${defaultStr}]: `
          : `${CLI} install: ${prompt}: `;
        return new Promise((resolve) => {
          iface.question(fullPrompt, (answer: string) => {
            iface.close();
            resolve(answer.trim() || defaultStr || undefined);
          });
        });
      };
    }

    await install(installOpts);

    // ── Re-materialize + host-place (same as positional path) ────────────────
    rematerializeServiceStores(
      scope,
      workspaceRoot,
      lockfilePathFlag ?? getScopePaths(scope, workspaceRoot).lockfile,
    );

    {
      const fsMod4 = require('node:fs') as typeof import('node:fs');
      const pathMod4 = require('node:path') as typeof import('node:path');
      const lockfilePath4 = lockfilePathFlag ?? getScopePaths(scope, workspaceRoot).lockfile;
      const lockfile4 = loadLockfile(lockfilePath4);

      if (lockfile4 !== null) {
        const repoRoot4 = process.cwd();
        for (const [lockKey, lkEntry4] of Object.entries(lockfile4.resolved)) {
          const atIdx = lockKey.lastIndexOf('@');
          const extId4 = atIdx > 0 ? lockKey.slice(0, atIdx) : lockKey;
          const resolved4 = resolveExtensionDir(lkEntry4.source, repoRoot4);
          if (!resolved4) continue;
          const extDir4 = fsMod4.existsSync(resolved4) && fsMod4.statSync(resolved4).isDirectory()
            ? resolved4
            : pathMod4.dirname(resolved4);
          const manifestPath4 = pathMod4.join(extDir4, 'extension.json');
          if (!fsMod4.existsSync(manifestPath4)) continue;
          let mf4: Record<string, unknown>;
          try { mf4 = JSON.parse(fsMod4.readFileSync(manifestPath4, 'utf8')) as Record<string, unknown>; } catch { continue; }
          const installBlock4 = mf4['install'] as
            | { type?: string; hosts?: string[] }
            | undefined;
          if (!installBlock4?.hosts || installBlock4.hosts.length === 0) continue;
          const extType4 = (mf4['type'] as string | undefined) ?? '';
          if (extType4 === 'service' || extType4 === 'bundle') continue;
          await hostPlaceExtension(extId4, extDir4, extType4, installBlock4.hosts, scope, repoRoot4);
        }
      }
    }

    // ── Check if already installed and up-to-date ─────────────────────────────
    // After install(), verify the lockfile has the extension and print status.
    const lfPath = lockfilePathFlag ?? getScopePaths(scope, workspaceRoot).lockfile;
    const lf = loadLockfile(lfPath);
    const entry = lf?.resolved?.[positionalId];
    if (entry) {
      process.stdout.write(`${CLI} install: installed ${positionalId} (scope=${scope})\n`);
    } else {
      process.stdout.write(`${CLI} install: done (scope=${scope})\n`);
    }
    process.exit(0);
  }

  // ── No positional: validate/suggest mode (or --update for backwards compat) ──
  const fsMod3 = require('node:fs') as typeof import('node:fs');
  const pathMod3 = require('node:path') as typeof import('node:path');

  const scopePaths = getScopePaths(scope, workspaceRoot);
  const cfgDir = pathMod3.dirname(scopePaths.config);
  const cfgExists = fsMod3.existsSync(scopePaths.config);

  if (!cfgExists) {
    // Scaffold empty config + first-run experience
    fsMod3.mkdirSync(cfgDir, { recursive: true });
    fsMod3.writeFileSync(scopePaths.config, JSON.stringify({ install: [] }, null, 2) + '\n', 'utf8');
    process.stdout.write(
      `${CLI} install: initialised empty extension list at ${scopePaths.config}\n` +
      `  Run '${CLI} search' to see all installable extensions\n` +
      `  Run '${CLI} install <id>' to install an extension\n`,
    );
    process.exit(0);
  }

  // --update flag: run full install with cascade for backwards compat
  if (update) {
    const resolvedRegistryForInstall = loadRegistryResolved(process.cwd());
    const installOpts: Parameters<typeof import('@adhd/sox-install-engine').install>[0] = {
      scope,
      mode,
      root: workspaceRoot,
      ...(configPathFlag !== undefined ? { configPath: configPathFlag } : {}),
      ...(lockfilePathFlag !== undefined ? { lockfilePath: lockfilePathFlag } : {}),
      ...(resolvedRegistryForInstall.length > 0 ? { registryIndex: resolvedRegistryForInstall } : {}),
    };

    if (process.stdout.isTTY) {
      installOpts.onMissingConfig = async (_id: string, _k: string, prompt: string, defaultVal: unknown): Promise<string | undefined> => {
        const rl = require('node:readline') as typeof import('node:readline');
        const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
        const defaultStr = defaultVal !== undefined ? String(defaultVal) : '';
        const fullPrompt = defaultStr
          ? `${CLI} install: ${prompt} [${defaultStr}]: `
          : `${CLI} install: ${prompt}: `;
        return new Promise((resolve) => {
          iface.question(fullPrompt, (answer: string) => {
            iface.close();
            resolve(answer.trim() || defaultStr || undefined);
          });
        });
      };
    }

    await install(installOpts);
    rematerializeServiceStores(
      scope,
      workspaceRoot,
      lockfilePathFlag ?? getScopePaths(scope, workspaceRoot).lockfile,
    );

    {
      const fsMod4 = require('node:fs') as typeof import('node:fs');
      const pathMod4 = require('node:path') as typeof import('node:path');
      const lockfilePath4 = lockfilePathFlag ?? getScopePaths(scope, workspaceRoot).lockfile;
      const lockfile4 = loadLockfile(lockfilePath4);
      if (lockfile4 !== null) {
        const repoRoot4 = process.cwd();
        for (const [lockKey, lkEntry4] of Object.entries(lockfile4.resolved)) {
          const atIdx = lockKey.lastIndexOf('@');
          const extId4 = atIdx > 0 ? lockKey.slice(0, atIdx) : lockKey;
          const resolved4 = resolveExtensionDir(lkEntry4.source, repoRoot4);
          if (!resolved4) continue;
          const extDir4 = fsMod4.existsSync(resolved4) && fsMod4.statSync(resolved4).isDirectory()
            ? resolved4
            : pathMod4.dirname(resolved4);
          const manifestPath4 = pathMod4.join(extDir4, 'extension.json');
          if (!fsMod4.existsSync(manifestPath4)) continue;
          let mf4: Record<string, unknown>;
          try { mf4 = JSON.parse(fsMod4.readFileSync(manifestPath4, 'utf8')) as Record<string, unknown>; } catch { continue; }
          const installBlock4 = mf4['install'] as
            | { type?: string; hosts?: string[] }
            | undefined;
          if (!installBlock4?.hosts || installBlock4.hosts.length === 0) continue;
          const extType4 = (mf4['type'] as string | undefined) ?? '';
          if (extType4 === 'service' || extType4 === 'bundle') continue;
          await hostPlaceExtension(extId4, extDir4, extType4, installBlock4.hosts, scope, repoRoot4);
        }
      }
    }

    process.stdout.write(`${CLI} install: done (scope=${scope}, mode=${mode})\n`);
    process.exit(0);
  }

  // Load config
  let installList: Array<{ id: string }> = [];
  try {
    const parsed = JSON.parse(fsMod3.readFileSync(scopePaths.config, 'utf8')) as { install?: Array<{ id: string }> };
    installList = parsed.install ?? [];
  } catch {
    process.stderr.write(`${CLI} install: failed to parse ${scopePaths.config}\n`);
    process.exit(1);
  }

  if (installList.length === 0) {
    process.stdout.write(`${CLI} install: no extensions configured at '${scope}' scope.\n`);
    process.stdout.write(`  Run '${CLI} install <id>' to install an extension.\n`);
    process.exit(0);
  }

  // Load lockfile if it exists
  const lockfile = fsMod3.existsSync(scopePaths.lockfile)
    ? loadLockfile(scopePaths.lockfile)
    : null;

  // Validate each configured extension
  const registryIndex = loadRegistryResolved(process.cwd());
  const upgradeNeeded: string[] = [];

  for (const entry of installList) {
    const extId = entry.id;
    const locked = lockfile?.resolved?.[extId];

    if (!locked) {
      upgradeNeeded.push(extId);
      process.stdout.write(`  ${extId} — not installed\n`);
      continue;
    }

    const srcPath = locked.source.startsWith('file://') ? locked.source.slice(7) : locked.source;
    if (!fsMod3.existsSync(srcPath)) {
      upgradeNeeded.push(extId);
      process.stdout.write(`  ${extId} — source missing (was: ${srcPath})\n`);
      continue;
    }

    // Verify against registry checksum
    const regEntry = resolveFromRegistry(extId, registryIndex);
    if (regEntry && regEntry.checksum !== locked.checksum) {
      upgradeNeeded.push(extId);
      process.stdout.write(`  ${extId} — update available\n`);
      continue;
    }

    process.stdout.write(`  ${extId} — installed\n`);
  }

  if (upgradeNeeded.length > 0) {
    process.stdout.write(`\n  Run '${CLI} upgrade --scope=${scope}' to update ${upgradeNeeded.length} extension(s)\n`);
    process.exit(1);
  }

  process.stdout.write(`\n  All ${installList.length} extension(s) up-to-date at '${scope}' scope.\n`);
  process.exit(0);
}

// ─── hostPlaceExtension ───────────────────────────────────────────────────────
//
// Shared host-placement helper — called by both the --host path (via
// declarativeInstall directly) and the no-host config/lockfile path (BL-17).
//
// Places the content of `srcPath` at each host's discovery directory for the
// given scope. Uses declarativeInstall so placement is idempotent (hash-gated)
// and ledger-recorded. Non-fatal: placement errors are warnings; they do not
// abort the install.
//
// [inv:host-registry-lazy]: @adhd/sox-host-registry loaded via require() inside
// declarativeInstall — no static import here.
//
async function hostPlaceExtension(
  id: string,
  srcPath: string,
  extType: string,
  hosts: string[],
  scope: 'org' | 'user' | 'project' | 'local',
  workspaceRoot: string,
): Promise<void> {
  const pathMod = require('node:path') as typeof import('node:path');
  const { getHost } = require('@adhd/sox-host-registry') as typeof import('@adhd/sox-host-registry');

  for (const hostName of hosts) {
    // Validate the host is registered; skip unknown hosts gracefully.
    try {
      getHost(hostName); // validate the host exists in the registry
    } catch {
      process.stderr.write(`${CLI} install: warning: unknown host '${hostName}' in manifest for '${id}' — skipping\n`);
      continue;
    }

    // ADR-0004 §D2: scopeRoot = the DATA dir for the scope (ledger/ownership/store),
    // decoupled from the host placement root. SOX_ECOSYSTEM_HOME moves it; placement
    // is unaffected ([inv:data-root-never-reroutes]).
    const scopeRoot: string = dataRoot(scope as DataScope, workspaceRoot);

    const descriptor: import('@adhd/sox-install-engine').InstallDescriptor = {
      ext: id,
      type: extType,
      hosts: [hostName],
      srcPath: pathMod.resolve(srcPath),
    };

    let results: import('@adhd/sox-install-engine').DeclarativeInstallResult[];
    try {
      results = await declarativeInstall(
        descriptor,
        scope,
        workspaceRoot,
        scopeRoot,
        { isProject: scope === 'project' },
      );
    } catch (e) {
      process.stderr.write(`${CLI} install: warning: host-placement failed for '${id}' on '${hostName}' — ${String(e)}\n`);
      continue;
    }

    for (const r of results) {
      if (r.denied === true) {
        process.stderr.write(`${CLI} install: warning: host-placement DENIED  ${r.host}/${r.scope}  ${r.target}  reason=${r.denialReason ?? 'unknown'}\n`);
      } else if (r.applied) {
        process.stdout.write(`${CLI} install: placed   ${r.host}/${r.scope}  ${r.target}\n`);
      } else {
        process.stdout.write(`${CLI} install: up-to-date  ${r.host}/${r.scope}  ${r.target}\n`);
      }
    }

    // ── #16728 durable fix: propagate a user/global MCP server into projects ──
    // When a user/global-scope MCP server is registered globally (~/.claude.json),
    // ALSO merge its entry into every known project's .mcp.json (which otherwise
    // OVERRIDES — does not inherit — user-scope servers). Best-effort: a failure
    // here must not fail the install.
    await maybePropagateUserMcp(extType, scope, hostName, id);

    // ── mcp-trust durable fix: ensure Claude Code will actually load the entry ──
    // .mcp.json alone is not enough — Claude Code gates it behind a per-project
    // enabledMcpjsonServers approval. Best-effort: a failure here must not fail
    // the install (matches maybePropagateUserMcp's own non-fatal contract).
    await maybeSyncMcpTrust(extType, scope, hostName, id, workspaceRoot);
  }
}

/**
 * #16728: if (extType is an mcp-server) AND (scope is user/global), merge the
 * just-registered server entry into every known project's .mcp.json. Auto-hook
 * shared by cmdInstall's host path and the no-host config/lockfile path.
 * Best-effort + non-fatal — placement of the global entry already succeeded.
 */
async function maybePropagateUserMcp(
  extType: string,
  scope: 'org' | 'user' | 'project' | 'local',
  host: string,
  id: string,
): Promise<void> {
  if (extType !== 'mcp-server') return;
  if (scope !== 'user' && scope !== 'org') return;
  try {
    const results = await syncUserMcpToProjects({ extId: id, host });
    for (const r of results) {
      if (r.action === 'merged') {
        process.stdout.write(`${CLI} install: mcp-sync merged   ${id} → ${r.mcpJsonPath}\n`);
      } else if (r.action === 'up-to-date') {
        process.stdout.write(`${CLI} install: mcp-sync up-to-date ${id} → ${r.mcpJsonPath}\n`);
      } else if (r.action === 'skipped') {
        process.stderr.write(`${CLI} install: mcp-sync skipped   ${id} → ${r.projectRoot} (${r.reason ?? ''})\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`${CLI} install: warning: mcp project-sync failed for '${id}' — ${String(e)}\n`);
  }
}

/**
 * mcp-trust durable fix: ensure Claude Code will actually LOAD the `.mcp.json`/
 * `~/.claude.json` entry `hostPlaceExtension` just wrote — Claude gates every
 * remote MCP server behind a per-project `enabledMcpjsonServers` approval, and
 * without an entry there any context that cannot answer the interactive trust
 * prompt (a background job, a fresh headless session) silently gets zero tools.
 *
 * Appends ONLY the exact extId just installed — never a blanket
 * enableAllProjectMcpServers-style bypass — mirroring maybePropagateUserMcp's
 * scope split: a project/local-scope install trusts exactly the project being
 * installed into; a user/org-scope install trusts every known project root
 * (since its `.mcp.json` entry is itself propagated to every known project by
 * maybePropagateUserMcp above). Claude-specific; a no-op for any other host.
 * Best-effort + non-fatal, matching maybePropagateUserMcp's contract.
 */
async function maybeSyncMcpTrust(
  extType: string,
  scope: 'org' | 'user' | 'project' | 'local',
  host: string,
  id: string,
  workspaceRoot: string,
): Promise<void> {
  if (extType !== 'mcp-server') return;
  if (host !== 'claude') return;
  try {
    const rootsOpt = scope === 'project' || scope === 'local' ? { roots: [workspaceRoot] } : {};
    const results = await syncMcpTrustToProjects({ extId: id, host, ...rootsOpt });
    for (const r of results) {
      if (r.action === 'trusted') {
        process.stdout.write(`${CLI} install: mcp-trust enabled ${id} → ${r.projectRoot}\n`);
      } else if (r.action === 'skipped' && r.reason !== 'no ~/.claude.json project entry yet') {
        process.stderr.write(`${CLI} install: mcp-trust skipped ${id} → ${r.projectRoot} (${r.reason ?? ''})\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`${CLI} install: warning: mcp-trust sync failed for '${id}' — ${String(e)}\n`);
  }
}

// ─── build ────────────────────────────────────────────────────────────────────

/**
 * cmdBuild — A: build an extension in the current working directory.
 *
 * Usage: soxe build <id>
 *
 * If the extension's built entrypoint already exists (e.g. dist/index.js pre-compiled
 * by the template), this exits 0 immediately.  Otherwise it attempts `npm run build`
 * in the extension directory.
 *
 * [cli-wiring.3]: verb is wired and exits 0 after `soxe init mcp-server <id>`.
 */
async function cmdBuild(_flags: Record<string, string>): Promise<void> {
  const pathMod = require('node:path') as typeof import('node:path');
  const fsMod = require('node:fs') as typeof import('node:fs');
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

  // Resolve id from positional arg (first non-flag token after verb).
  const rawAfterVerb = argv.slice(1);
  let id: string | undefined;
  for (const tok of rawAfterVerb) {
    if (!tok.startsWith('-')) { id = tok; break; }
  }

  if (id === undefined || id === '') {
    process.stderr.write(`${CLI} build: extension id required\n`);
    process.stderr.write(`  Usage: ${CLI} build <id>\n`);
    process.exit(1);
  }

  // Find the extension directory: <id>/ relative to cwd.
  const extDir = pathMod.resolve(process.cwd(), id);
  const manifestPath = pathMod.join(extDir, 'extension.json');

  if (!fsMod.existsSync(manifestPath)) {
    process.stderr.write(`${CLI} build: extension not found at ${extDir}\n`);
    process.stderr.write(`  Expected extension.json at ${manifestPath}\n`);
    process.exit(1);
  }

  // Read the entrypoint from the manifest.
  let entrypoint: string | undefined;
  try {
    const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    entrypoint = manifest['entrypoint'] as string | undefined;
  } catch {
    // proceed without entrypoint check
  }

  // If the entrypoint already exists on disk (e.g. pre-compiled stub from template),
  // the extension is already built — nothing to do.
  if (entrypoint !== undefined && fsMod.existsSync(pathMod.join(extDir, entrypoint))) {
    process.stdout.write(`${CLI} build: ${id} — entrypoint present, nothing to rebuild\n`);
    process.exit(0);
  }

  // Attempt npm run build in the extension directory.
  const pkgJsonPath = pathMod.join(extDir, 'package.json');
  if (!fsMod.existsSync(pkgJsonPath)) {
    process.stderr.write(`${CLI} build: no package.json found in ${extDir}\n`);
    process.exit(1);
  }

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: extDir,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    process.stderr.write(`${CLI} build: build failed for ${id}\n`);
    process.exit(result.status ?? 1);
  }

  process.stdout.write(`${CLI} build: ${id} built\n`);
  process.exit(0);
}

// ─── diff ─────────────────────────────────────────────────────────────────────

/**
 * cmdDiff — diff ledger vs disk for an extension.
 *
 * Usage: soxe diff <id> [--host=<h>] [--scope=<s>] [--root=<dir>]
 *
 * Compares the ledger's recorded state against what's on disk.
 * Exits 0 if clean (no drift), exits 1 if drift detected.
 *
 * [cli-wiring.4]: new verb, wired to diffExtension() from libs/install-engine/src/diff.ts.
 */
async function cmdDiff(flags: Record<string, string>): Promise<void> {
  const pathMod = require('node:path') as typeof import('node:path');

  // Resolve id from positional arg (first non-flag token after verb).
  const rawAfterVerb = argv.slice(1);
  let id: string | undefined;
  for (const tok of rawAfterVerb) {
    if (!tok.startsWith('-')) { id = tok; break; }
  }

  const host = flags['host'] ?? 'claude';
  const scope = (flags['scope'] ?? 'project') as 'org' | 'user' | 'project' | 'local';
  const workspaceRoot = pathMod.resolve(flags['root'] ?? process.cwd());
  // ADR-0004 §D2: scopeRoot = the DATA dir (ledger lives here), per scope.
  const scopeRoot = dataRoot(scope as DataScope, workspaceRoot);

  if (id !== undefined && id !== '') {
    // Single-extension diff.
    // [inv:diff-exits-zero]: diff is a query command — always exits 0; drift reported on stdout.
    const result = diffExtension(id, host, scope, scopeRoot, { isProject: scope === 'project' });
    if (result.clean) {
      process.stdout.write(`${CLI} diff: ${id} — up to date (no drift)\n`);
    } else {
      process.stdout.write(`${CLI} diff: ${id} — drift detected\n`);
      for (const action of result.actions) {
        if (action.kind !== 'up-to-date') {
          process.stdout.write(`  ${action.kind}  ${action.file}\n`);
        }
      }
    }
    process.exit(0);
  } else {
    // No id → diff all installed extensions at this scope root.
    // diffAll is statically imported at the top of this file.
    const results = diffAll(scopeRoot, { isProject: scope === 'project' });
    const dirty = results.filter((r) => !r.clean);
    if (dirty.length === 0) {
      process.stdout.write(`${CLI} diff: all extensions up to date (scope=${scope})\n`);
    } else {
      process.stdout.write(`${CLI} diff: ${dirty.length} extension(s) have drift\n`);
      for (const r of dirty) {
        process.stdout.write(`  ${r.ext} (${r.host}/${r.scope})\n`);
        for (const action of r.actions) {
          if (action.kind !== 'up-to-date') {
            process.stdout.write(`    ${action.kind}  ${action.file}\n`);
          }
        }
      }
    }
    // Always exit 0 — drift is informational, not an error.
    process.exit(0);
  }
}

// ─── update ───────────────────────────────────────────────────────────────────

/**
 * cmdUpdate — update an installed extension.
 *
 * Two paths:
 *   --host present → declarative single-extension update via lifecycle.update().
 *     soxe update <id> --host=<h> [--scope=project] [--root=<dir>]
 *   --host absent  → config/lockfile update (existing path).
 *     soxe update [--scope=<s>]
 *
 * [cli-wiring.5]: verb is wired and exits 0.
 */
async function cmdUpdate(flags: Record<string, string>): Promise<void> {
  const hostRaw = flags['host'];

  // ── Declarative path: --host present ───────────────────────────────────────
  if (hostRaw !== undefined && hostRaw !== '') {
    const pathMod = require('node:path') as typeof import('node:path');

    // Resolve id from positional arg.
    const rawAfterVerb = argv.slice(1);
    let id: string | undefined;
    for (const tok of rawAfterVerb) {
      if (!tok.startsWith('-')) { id = tok; break; }
    }

    if (id === undefined || id === '') {
      process.stderr.write(`${CLI} update: declarative path requires a positional <id>\n`);
      process.stderr.write(`  Usage: ${CLI} update <id> --host=<h1,h2,...> [--scope=project] [--root=<dir>]\n`);
      process.exit(1);
    }

    const scope = (flags['scope'] ?? 'project') as 'org' | 'user' | 'project' | 'local';
    const workspaceRoot = pathMod.resolve(flags['root'] ?? process.cwd());
    // ADR-0004 §D2: scopeRoot = the DATA dir for the scope (ledger/store/ownership).
    const scopeRoot = dataRoot(scope as DataScope, workspaceRoot);

    const hosts = hostRaw !== undefined ? hostRaw.split(',').map((h: string) => h.trim()).filter(Boolean) : [];
    if (hosts.length === 0) {
      process.stderr.write(`${CLI} update: --host must specify at least one valid host\n`);
      process.exit(1);
    }
    let updatedAny = false;
    for (const h of hosts) {
      const ctx: UpdateCtx = {
        ext: id,
        host: h,
        scope,
        scopeRoot,
        workspaceRoot,
        isProject: scope === 'project',
      };
      const result = await lifecycleUpdate(ctx);
      if (result.kind === 'updated') {
        process.stdout.write(`${CLI} update: ${id} updated on ${h} (${result.actions.join(', ')})\n`);
        updatedAny = true;
      } else {
        process.stdout.write(`${CLI} update: ${id} — up to date on ${h}\n`);
      }
    }
    if (!updatedAny) {
      process.stdout.write(`${CLI} update: ${id} already up to date across all hosts\n`);
    }
    process.exit(0);
  }

  // ── Existing resolver path: --host absent (unchanged) ──────────────────────
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  // BL-73: derive the project root from cwd (not REPO_ROOT).
  const updateRoot = require('node:path').resolve(flags['root'] ?? process.cwd()) as string;

  await install({ scope, mode: 'update', root: updateRoot });
  // BL-39 / ADR-0004 §D6: re-materialize service stores so an updated artifact is
  // re-copied into the store (a running daemon must not keep stale copied code).
  rematerializeServiceStores(scope, updateRoot, getScopePaths(scope, updateRoot).lockfile);
  process.stdout.write(`${CLI} update: done (scope=${scope})\n`);
  process.exit(0);
}

// ─── upgrade ─────────────────────────────────────────────────────────────────

/**
 * Resolve the lockfile path for an install-registry record's scope+root.
 * Covers all four ADR-0003 scopes. `getScopePaths` (host-runtime) handles
 * user/project/local; org is repo-rooted and resolved via install-engine's
 * `getScopePath('org')`.
 */
function lockfilePathForRecord(scope: string, root: string): string {
  if (scope === 'org') return getScopePath('org').lockfile;
  return getScopePaths(scope, root).lockfile;
}

/**
 * Resolve the config path for an install-registry record's scope+root.
 * Symmetric with lockfilePathForRecord — the re-install during upgrade MUST
 * target the consumer's actual config + lockfile (at record.root), never the
 * scope default. (install()'s getScopePath is REPO_ROOT/homedir-based and would
 * otherwise re-pin the wrong scope file for a project/local consumer whose root
 * is not the repo — clobbering an unrelated lockfile.)
 */
function configPathForRecord(scope: string, root: string): string {
  if (scope === 'org') return getScopePath('org').config;
  return getScopePaths(scope, root).config;
}

/**
 * Read an extension's declared `type` from the manifest at its store dir.
 * `source` is a file:// URL to the built entrypoint (…/dist/index.js) or a
 * declarative content file (…/SKILL.md). The extension.json sits at the
 * directory that contains `dist/` (or the content file's directory). We walk
 * up from the artifact until an extension.json is found (bounded to 3 levels).
 * Returns null if it cannot be resolved.
 */
function manifestTypeForSource(source: string): string | null {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  if (!source.startsWith('file://')) return null;
  let dir = pathM.dirname(source.slice('file://'.length));
  for (let i = 0; i < 4; i++) {
    const ext = pathM.join(dir, 'extension.json');
    if (fsM.existsSync(ext)) {
      try {
        const m = JSON.parse(fsM.readFileSync(ext, 'utf8')) as { type?: string };
        return typeof m.type === 'string' ? m.type : null;
      } catch { return null; }
    }
    const parent = pathM.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export type RestartDisposition =
  | 'restarted'
  | 'backend-restarted'
  | 'reconnect-needed'
  | 'placement-only'
  | 'not-running';

export interface RestartResult {
  disposition: RestartDisposition;
  /** Human-readable detail for the report / logs. */
  detail: string;
}

// ─── BL-65: dist-sha warning (§C, CLAUDE.md) ──────────────────────────────────
//
// At build time `apps/sox/scripts/stamp-build.cjs` writes
// `dist/apps/sox/build-info.json` with { gitSha, dirty, builtAt }.
//
// `warnIfDistSha()` reads that stamp and emits a clear WARNING to stderr when
// the running `dist` was:
//   (a) built from a DIRTY tree (uncommitted WIP), or
//   (b) built from a sha that is NOT the current HEAD of the repo (stale build).
//
// Either condition means the serving process may be running code that differs
// from HEAD — exactly the BL-65 hazard that quarantined the svc-proxy-default
// branch. The WARNING is deliberately noisy (goes to stderr on EVERY cmdServe
// invocation) so a developer cannot miss it.
//
// This function is called at the TOP of cmdServe, before any subprocess or shim
// starts, so the operator sees the warning before the MCP client connects.
//
// [inv:no-stdout-diagnostics]: warning goes to stderr only. stdout is the
// JSON-RPC channel in proxy/shim mode.

interface BuildInfo {
  gitSha: string;
  dirty: boolean;
  builtAt: string;
}

function readBuildInfo(): BuildInfo | null {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  // __dirname in the compiled CJS = dist/apps/sox/ — the stamp sits next to main.js.
  const stampPath = pathM.join(__dirname, 'build-info.json');
  try {
    return JSON.parse(fsM.readFileSync(stampPath, 'utf8')) as BuildInfo;
  } catch {
    return null; // no stamp → old build before this feature; warn anyway
  }
}

/**
 * Emit a BL-65 WARNING to stderr when the running dist is from a dirty or
 * sha-mismatched tree. Reads HEAD sha via `git rev-parse` in cwd.
 * Never throws — warnings are best-effort; a failure must not block serve.
 */
function warnIfDistSha(): void {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const info = readBuildInfo();

    // Determine the current HEAD sha.
    let headSha = 'unknown';
    try {
      headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      headSha = 'unknown';
    }

    if (info === null) {
      process.stderr.write(
        `[${CLI} serve] BL-65 WARNING: dist/apps/sox/build-info.json missing — ` +
        `this dist was built before sha-stamping was added. ` +
        `Run 'npx nx build sox' in a CLEAN worktree, not in the live checkout.\n`,
      );
      return;
    }

    const warnings: string[] = [];
    if (info.dirty) {
      warnings.push(
        `dist was built from a DIRTY tree (uncommitted WIP at sha ${info.gitSha}) — ` +
        `the running code may differ from HEAD; any MCP session spawned by this serve ` +
        `will load the WIP code.`,
      );
    }
    if (headSha !== 'unknown' && info.gitSha !== 'unknown' && headSha !== info.gitSha) {
      warnings.push(
        `dist was built from sha ${info.gitSha} but HEAD is now ${headSha} — ` +
        `stale build; run 'npx nx build sox' to refresh.`,
      );
    }

    for (const w of warnings) {
      process.stderr.write(
        `[${CLI} serve] BL-65 WARNING: ${w}\n` +
        `  SAFE path: build in an ISOLATED WORKTREE (not the live checkout) so ` +
        `live MCP sessions are not disrupted. See BACKLOG BL-65.\n`,
      );
    }
  } catch {
    // Best-effort; never block serve.
  }
}

/**
 * Resolve the install directory of an mcp-server from the lockfile source, then
 * read its manifest. Returns null when it cannot be resolved. Mirrors cmdServe's
 * extDir resolution so proxy-mode detection matches the actual serve path.
 */
interface ServeManifestShape {
  type?: string;
  entrypoint?: string;
  lifecycle?: { proxy?: boolean; serve_mode?: string; schema_path?: string };
}

function resolveServeManifest(
  extId: string,
  scope: string,
  root: string,
): { extDir: string; manifest: ServeManifestShape } | null {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  let extDir: string | null = null;
  try {
    const sp = getScopePaths(scope, root);
    const lf = loadLockfile(sp.lockfile);
    const found =
      lf?.resolved?.[extId] ??
      Object.entries(lf?.resolved ?? {}).find(([k]) => k.startsWith(extId + '@'))?.[1];
    if (found) extDir = resolveExtensionDir(found.source, root);
  } catch {
    extDir = null;
  }
  if (!extDir) {
    // Signature is findLocalExtension(root, id) (install.ts:984) — correct order
    // here (BL-59 documents the reversed call in cmdServe's discovery fallback).
    const local = findLocalExtension(root, extId);
    if (local) extDir = pathM.dirname(local);
  }
  if (!extDir) return null;
  const manifestPath = pathM.join(extDir, 'extension.json');
  if (!fsM.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fsM.readFileSync(manifestPath, 'utf8')) as ServeManifestShape;
    return { extDir, manifest };
  } catch {
    return null;
  }
}

/**
 * Is this mcp-server served in PROXY mode? (Slice 1.6 §9.5.) Mirrors cmdServe's
 * default: proxy ON for type:mcp-server unless explicitly opted out
 * (serve_mode:"direct" / lifecycle.proxy:false); forced on by
 * serve_mode:"proxy" / lifecycle.proxy:true.
 */
function mcpServerIsProxyMode(extId: string, scope: string, root: string): boolean {
  const resolved = resolveServeManifest(extId, scope, root);
  if (!resolved) return false;
  const lc = resolved.manifest.lifecycle ?? {};
  const forced = lc.proxy === true || lc.serve_mode === 'proxy';
  const optedOut = lc.proxy === false || lc.serve_mode === 'direct';
  const isMcpServer = resolved.manifest.type === 'mcp-server';
  return forced || (isMcpServer && !optedOut);
}

/**
 * Rolling-restart the PROXY BACKEND of a proxy-mode mcp-server (§9.5, step 4).
 *
 * The backend is the persistent, detached, sox-owned process running the server
 * entrypoint with SOX_PROXY_BACKEND=1. We:
 *   1. derive the [def:singleton-key]-keyed backend socket (the same path the shim
 *      dials), and the entrypoint identity token (BL-31 reaper-compatible);
 *   2. find every live backend pid by that token + verified-stop it (killAndVerify);
 *   3. let the BACKEND come back up — the next shim's `ensure` respawns it; we also
 *      proactively re-ensure here so the backend is live again immediately even if
 *      no shim is currently connected.
 *
 * The shims re-dial across the sub-second gap → the MCP client NEVER reconnects.
 * Returns 'backend-restarted'.
 */
async function restartProxyBackend(
  extId: string,
  scope: string,
  root: string,
  log: (m: string) => void,
): Promise<RestartResult> {
  const resolved = resolveServeManifest(extId, scope, root);
  if (!resolved || !resolved.manifest.entrypoint) {
    return { disposition: 'reconnect-needed', detail: 'proxy-mode mcp-server but entrypoint unresolvable — falling back to reconnect' };
  }
  const pathM = require('node:path') as typeof import('node:path');
  const fsM = require('node:fs') as typeof import('node:fs');
  const entrypointPath = pathM.resolve(resolved.extDir, resolved.manifest.entrypoint);

  // Derive the backend socket + singleton key exactly as cmdServe does.
  const configEnv = buildExtConfigEnv(extId, root);
  const manifestPath = pathM.join(resolved.extDir, 'extension.json');
  const storeResource = resolveStoreResource(manifestPath, configEnv);
  const key = singletonKey(extId, storeResource) ?? `${extId} none:`;

  const { backendSocketPath, ensureBackend } =
    require('@adhd/sox-service-proxy') as typeof import('@adhd/sox-service-proxy');
  const backendSock = backendSocketPath(socketDir(), key);

  // [inv:unload-then-reap] (§8.5): unload any OS unit BEFORE verified-stop so
  // the OS supervisor does not immediately respawn the backend (F3 resurrection).
  // Best-effort; unloadOnlyTargetId wraps unloadOwnedOsUnitsBeforeReap for a
  // single extension.
  unloadOwnedOsUnitsBeforeReap({
    root,
    onlyIds: [extId],
    log: (m) => log(`[unload-then-reap] ${m}`),
  });

  // Find + VERIFIED-STOP (await — the kill MUST complete before we re-ensure, or
  // ensureBackend would see the old backend still live and no-op) the live
  // backend(s) by the entrypoint identity token. The backend was spawned as
  // `node --enable-source-maps <entrypointPath>` so the reaper matches the token.
  const token = identityToken(`file://${entrypointPath}`);
  const live = findOrphansByIdentity(token, { excludePids: [process.pid] });
  if (live.length === 0) {
    log(`proxy backend for ${extId}: none live; ensuring fresh backend on new code`);
  } else {
    for (const m of live) {
      log(`verified-stop proxy backend pid ${m.pid} (${extId})`);
      const outcome = await killAndVerify(m.pid, { graceMs: 5000, log: (s) => log(`  ${s}`) });
      if (outcome === 'undead') {
        return { disposition: 'reconnect-needed', detail: `proxy backend pid ${m.pid} did not die (undead) — NOT restarted; reconnect required` };
      }
    }
  }
  // Unlink the now-stale socket so the fresh backend binds cleanly.
  try {
    if (fsM.existsSync(backendSock)) fsM.unlinkSync(backendSock);
  } catch {
    /* serveBackend also unlinks; best-effort */
  }

  // Re-ensure the backend on the NEW code (detached, singleton-guarded). Build the
  // backend env mirroring cmdServe (SOX_CONFIG_* + the backend-mode signal + socket).
  let backendSchemaPath: string | undefined;
  if (resolved.manifest.lifecycle?.schema_path) {
    const sp = pathM.resolve(resolved.extDir, resolved.manifest.lifecycle.schema_path);
    if (fsM.existsSync(sp)) backendSchemaPath = sp;
  }
  const backendEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...configEnv,
    SOX_PROXY_BACKEND: '1',
    SOX_PROXY_BACKEND_SOCKET: backendSock,
    ...(backendSchemaPath !== undefined ? { SOX_PROXY_BACKEND_SCHEMA: backendSchemaPath } : {}),
  };
  // [inv:no-fd-inherit] The backend is detached; its stderr must NEVER inherit
  // the upgrade process's fd 2. Redirect to a dated log file so diagnostics are
  // preserved without holding any parent pipe open (BL-67 — the upgrade process's
  // stderr may be piped: `soxe upgrade --all 2>&1 | tail`).
  const pathMRB = require('node:path') as typeof import('node:path');
  const backendLogDirRB = logDirFor(`proxy-backend-${extId}`);
  const backendLogDateRB = new Date().toISOString().slice(0, 10);
  const backendLogPathRB = pathMRB.join(backendLogDirRB, `${extId}-backend-${backendLogDateRB}.log`);
  const r = await ensureBackend({
    socketPath: backendSock,
    singletonKey: key,
    command: process.execPath,
    args: ['--enable-source-maps', entrypointPath],
    cwd: resolved.extDir,
    env: backendEnv,
    stderrLogPath: backendLogPathRB,
    onDiagnostic: (l) => log(l),
  });
  log(`ensure-backend: ${r.disposition} — ${r.detail}`);
  if (r.disposition === 'failed') {
    return { disposition: 'reconnect-needed', detail: `proxy backend re-ensure failed: ${r.detail}` };
  }

  return {
    disposition: 'backend-restarted',
    detail: 'proxy backend verified-stopped + re-ensured on new code — shims re-dial, NO client reconnect',
  };
}

/**
 * Roll a single just-upgraded consumer onto its new artifact.
 *
 * Classification (ADR-0003 + BL-31):
 *   - `service` running as a live supervised pid → VERIFIED-STOP (BL-31
 *     killAndVerify + reapOrphansForExtension so the old pid cannot survive) then
 *     dedup-guarded START on the new code. Honest rolling handoff (the daemon is
 *     a socket singleton; stop→start, not zero-downtime overlap).
 *   - `mcp-server` (stdio / on-demand, spawned by the client) → 'reconnect-needed'.
 *     The next client connection respawns it on the new code; we don't own its pid.
 *   - declarative (skill/hook/command/prompt/agent) → 'placement-only'. The
 *     re-install already refreshed placement; there is no process.
 *
 * The stop and start are executed by shelling out to THIS CLI's own
 * `stop --id` / `start --id` so the exact, tested BL-31 verified-stop and
 * dedup-guarded start paths are reused verbatim — no signal logic is duplicated.
 * Services are rolled SEQUENTIALLY by the caller (one at a time).
 */
async function rollingRestartConsumer(
  extId: string,
  scope: string,
  root: string,
  log: (m: string) => void,
): Promise<RestartResult> {
  const lockfilePath = lockfilePathForRecord(scope, root);
  const runtimeFilePath = getRuntimeFilePath(lockfilePath);

  // What is this extension? The MANIFEST type is authoritative. BL-36 fixed the
  // service-registry start path so it now records the real manifest type in the
  // runtime entry (no longer hardcoded to 'mcp-server'). The resolution order
  // below is kept as defense-in-depth for runtime records written by older
  // binaries: lockfile source → runtime entry source → runtime entry type.
  const record = getRuntimeRecord(runtimeFilePath);
  const liveEntry = record?.entries?.find((e) => e.id === extId || e.key === extId);
  const lockSource = (() => {
    const lock = loadLockfile(lockfilePath);
    if (!lock) return undefined;
    const key = Object.keys(lock.resolved).find((k) => k === extId || k.startsWith(`${extId}@`));
    return key ? lock.resolved[key]?.source : undefined;
  })();
  const declaredType =
    (lockSource ? manifestTypeForSource(lockSource) : null) ??
    (liveEntry?.source ? manifestTypeForSource(liveEntry.source) : null) ??
    liveEntry?.type ??
    null;

  // Is it a running supervised service (live pid)?
  const liveRunning =
    liveEntry !== undefined &&
    liveEntry.running === true &&
    typeof liveEntry.pid === 'number' &&
    pidAliveRT(liveEntry.pid);

  if (declaredType === 'mcp-server') {
    // Slice 1.6 (§9.5): a PROXY-mode mcp-server is insulated by the front-shim. The
    // tool implementation lives in a persistent, sox-owned BACKEND that the shim
    // proxies to over a UDS. An upgrade is a rolling restart of the BACKEND — the
    // shims re-dial across the sub-second gap and the MCP client NEVER reconnects.
    // A DIRECT-mode mcp-server (opt-out) keeps the legacy reconnect-needed path.
    const proxyMode = mcpServerIsProxyMode(extId, scope, root);
    if (proxyMode) {
      return await restartProxyBackend(extId, scope, root, log);
    }
    return {
      disposition: 'reconnect-needed',
      detail: 'stdio/on-demand server (direct mode) — respawns with new code on next client connection',
    };
  }

  if (declaredType !== 'service') {
    // declarative content type (skill/hook/command/prompt/agent) — placement already refreshed.
    return { disposition: 'placement-only', detail: `${declaredType ?? 'declarative'} — placement refreshed, no process` };
  }

  if (!liveRunning) {
    return { disposition: 'not-running', detail: 'service not currently running — nothing to restart' };
  }

  // ── Rolling restart: verified-stop → dedup-guarded start, via this CLI. ──────
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const selfArgv1 = process.argv[1] as string;

  const stopArgs = [
    '--enable-source-maps', selfArgv1, 'stop',
    `--id=${extId}`, `--scope=${scope}`, `--root=${root}`,
  ];
  log(`verified-stop ${extId} (BL-31 killAndVerify + orphan reap)`);
  const stop = spawnSync(process.execPath, stopArgs, { encoding: 'utf8' });
  const stopOut = `${stop.stdout ?? ''}${stop.stderr ?? ''}`.trim();
  if (stopOut) for (const line of stopOut.split('\n')) log(`  stop: ${line}`);
  if (stop.status !== 0) {
    return { disposition: 'restarted', detail: `STOP FAILED (exit ${String(stop.status)}) — old pid may survive; NOT restarted` };
  }

  const startArgs = [
    '--enable-source-maps', selfArgv1, 'start',
    `--id=${extId}`, `--scope=${scope}`, `--root=${root}`,
  ];
  log(`start ${extId} on new artifact (dedup-guarded)`);
  const start = spawnSync(process.execPath, startArgs, { encoding: 'utf8' });
  const startOut = `${start.stdout ?? ''}${start.stderr ?? ''}`.trim();
  if (startOut) for (const line of startOut.split('\n')) log(`  start: ${line}`);
  if (start.status !== 0) {
    return { disposition: 'restarted', detail: `START FAILED (exit ${String(start.status)})` };
  }

  // §9.3 [inv:os-unit-content-addressed]: if this service has an owned OS unit,
  // re-enable it so the unit follows the NEW artifact (content-addressed — a no-op
  // when the rendered unit is unchanged).
  reEnableOwnedOsUnit(extId, scope, root, log);

  return { disposition: 'restarted', detail: 'verified-stop → start on new artifact (no orphan)' };
}

/**
 * Verify that the running process for (extId, scope) loaded the artifact whose
 * sha256 matches the lockfile's expected checksum. Reads the runtime record to
 * find the entrypoint file path, then sha256s the file on disk and compares.
 *
 * Returns { ok: true } on match, { ok: false, detail } on mismatch or error.
 */
async function verifyRunningArtifact(
  extId: string, lockfilePath: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // 1. Get expected checksum from lockfile.
  const lock = loadLockfile(lockfilePath);
  if (!lock) return { ok: false, detail: 'no lockfile' };
  const lockKey = Object.keys(lock.resolved).find((k) => k === extId || k.startsWith(`${extId}@`));
  if (!lockKey) return { ok: false, detail: 'not in lockfile' };
  const expected = lock.resolved[lockKey]!.checksum;
  if (!expected) return { ok: false, detail: 'no checksum in lockfile' };

  // 2. Find the running process's entrypoint from the runtime record.
  const runtimeFilePath = getRuntimeFilePath(lockfilePath);
  const record = getRuntimeRecord(runtimeFilePath);
  const entry = record?.entries?.find((e) => e.id === extId || e.key === extId);
  if (!entry) return { ok: false, detail: 'no runtime entry' };
  const artifactPath = entry.source;
  if (!artifactPath) return { ok: false, detail: 'no source in runtime entry' };

  // 3. Sha256 the artifact file the process loaded.
  const fs = require('node:fs') as typeof import('node:fs');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  let actual: string;
  try {
    const data = fs.readFileSync(artifactPath);
    actual = crypto.createHash('sha256').update(data).digest('hex');
  } catch (e) {
    return { ok: false, detail: `cannot read artifact ${artifactPath}: ${String(e)}` };
  }

  if (actual === expected) return { ok: true };
  return { ok: false, detail: `entrypoint sha256 ${actual.slice(0, 19)}… ≠ expected ${expected.slice(0, 19)}…` };
}

/**
 * §9.3: re-`enable` an extension's OS unit on upgrade so it tracks the new artifact.
 * No-op when no OS unit is owned for (extId, scope). Content-addressed: enableOsUnit
 * rewrites + reloads only when the generated unit differs. Honors SOX_OS_UNIT_DIR.
 */
function reEnableOwnedOsUnit(extId: string, scope: string, root: string, log: (m: string) => void): void {
  const pathM = require('node:path') as typeof import('node:path');
  let owned;
  try {
    const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
    owned = own.get(extId, scope)?.entries.find((e) => e.kind === 'os-unit');
  } catch {
    return;
  }
  if (!owned || owned.kind !== 'os-unit') return;
  const ctx = resolveOsUnitContext(extId, scope, root, {});
  if (!ctx) return;
  const unitDir = process.env['SOX_OS_UNIT_DIR'] ?? pathM.dirname(owned.unitPath);
  const r = enableOsUnit(ctx.spec, ctx.platform, { unitDir, load: true, log: (m) => log(`os-unit: ${m}`) });
  if (r.action !== 'unchanged') {
    try {
      const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
      const rec = own.get(extId, scope);
      if (rec) {
        const kept: OwnedEntry[] = rec.entries.filter((e) => e.kind !== 'os-unit');
        kept.push({ kind: 'os-unit', label: ctx.spec.label, unitPath: r.unitPath, supervisor: ctx.platform.kind, appliedHash: r.contentHash });
        own.record({ extId, scope, entries: kept, ...(rec.host !== undefined ? { host: rec.host } : {}) });
        own.save();
      }
    } catch { /* best-effort */ }
  }
}

interface ConsumerOutcome {
  extId: string;
  scope: string;
  root: string;
  state: 'current' | 'upgraded' | 'restarted' | 'restart-mismatch' | 'backend-restarted' | 'backend-restart-mismatch' | 'reconnect-needed' | 'not-installed' | 'unresolvable' | 'failed';
  detail: string;
}

/**
 * cmdUpgrade — content-addressed upgrade tooling (ADR-0003 + BL-31).
 *
 * Two modes:
 *   soxe upgrade <id> --all   — upgrade every install-registry consumer of <id>.
 *   soxe upgrade --all        — upgrade EVERY consumer of EVERY id (full deploy).
 *
 * For each consumer (extId × scope × root) the flow is uniform:
 *   1. verifyIntegrity(scope, id) — the ONE is-this-current check (sha256 of the
 *      artifact at the lockfile `source` vs the recorded checksum).
 *   2. CURRENT → report current, make ZERO changes (idempotent — a fully-current
 *      system is the verification; there is no separate doctor/verify command).
 *   3. STALE → re-install (mode:'update' refreshes artifact + re-pins lockfile),
 *      then ROLLING-RESTART the consumer if it is a running supervised service
 *      (BL-31 verified-stop → dedup-guarded start; sequential, one at a time).
 *      stdio servers → reconnect-needed; declarative → placement refreshed.
 */
async function cmdUpgrade(flags: Record<string, string>): Promise<void> {
  // Accept positional id as well as --id flag.
  const rawAfterVerbUpg = argv.slice(1);
  let positionalUpg: string | undefined;
  for (const tok of rawAfterVerbUpg) {
    if (!tok.startsWith('-')) { positionalUpg = tok; break; }
  }
  const extId = flags['id'] ?? positionalUpg;

  if (flags['all'] === undefined) {
    process.stderr.write(`${CLI} upgrade: --all flag required\n`);
    process.stderr.write(`  Usage: ${CLI} upgrade [<ext-id>] --all\n`);
    process.exit(1);
  }

  // ADR-0004 §D7: global install registry under the user data root.
  const registryPath = installRegistryPath();
  const registry = readInstallRegistry(registryPath);

  // Consumer set: every InstallRecord (optionally filtered to a single id).
  const consumers = extId !== undefined && extId !== ''
    ? registry.installs.filter((r) => r.extId === extId)
    : registry.installs;

  if (consumers.length === 0) {
    process.stdout.write(
      extId
        ? `${CLI} upgrade: no install records found for '${extId}'\n`
        : `${CLI} upgrade: no install records found (nothing installed via this machine)\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `${CLI} upgrade --all${extId ? ` ${extId}` : ''}: verifying ${consumers.length} consumer${consumers.length === 1 ? '' : 's'}\n\n`,
  );

  const outcomes: ConsumerOutcome[] = [];
  // Services that were upgraded AND need a rolling restart — rolled sequentially
  // AFTER all re-installs so we never interleave artifact churn with a restart.
  const toRestart: Array<{ extId: string; scope: string; root: string }> = [];

  let changed = 0;
  let failed = 0;

  // ── Pre-compute integrity snapshot ──────────────────────────────────────────
  // Snapshot all verdicts BEFORE any re-install so a bundle install that updates
  // the lockfile mid-pass can't taint subsequent consumers' is-this-current check.
  // Each consumer's verdict is computed from the lockfile as it was at pass start.
  interface Snapshot { record: typeof consumers[0]; verdict: IntegrityResult | null; tag: string }
  const snapshot: Snapshot[] = [];
  for (let i = 0; i < consumers.length; i++) {
    const record = consumers[i]!;
    const tag = `[${i + 1}/${consumers.length}] ${record.extId} (scope: ${record.scope}, root: ${record.root})`;
    const lockfilePath = lockfilePathForRecord(record.scope, record.root);

    const currentLockfile = loadLockfile(lockfilePath);
    const inLockfile = currentLockfile !== null &&
      Object.keys(currentLockfile.resolved).some(
        (k) => k === record.extId || k.startsWith(`${record.extId}@`),
      );
    if (!inLockfile) {
      // not-in-lockfile is a terminal state — no re-install needed, no verdict.
      process.stdout.write(`  ${tag}\n    → not in lockfile (skipped — run ${CLI} install to re-add)\n`);
      outcomes.push({ extId: record.extId, scope: record.scope, root: record.root, state: 'not-installed', detail: 'not in lockfile' });
      snapshot.push({ record, verdict: null, tag });
      continue;
    }

    const verdict = await verifyIntegrity(record.scope as Scope, record.extId, { lockfilePath });
    snapshot.push({ record, verdict, tag });
  }

  // ── Re-install pass ─────────────────────────────────────────────────────────
  // Uses the snapshot verdicts — NEVER re-reads the lockfile — so a bundle
  // install that updates the lockfile does not taint subsequent consumers.
  for (const { record, verdict, tag } of snapshot) {
    if (verdict === null) continue; // already emitted not-installed above

    if (verdict.status === 'current') {
      process.stdout.write(`  ${tag}\n    → current (${(verdict.actual ?? '').slice(0, 19)}…) — no change\n`);
      outcomes.push({ extId: record.extId, scope: record.scope, root: record.root, state: 'current', detail: 'checksum matches' });
      continue;
    }

    if (verdict.status === 'unresolvable') {
      process.stdout.write(`  ${tag}\n    → UNRESOLVABLE: ${verdict.error ?? 'artifact missing'}\n`);
      outcomes.push({ extId: record.extId, scope: record.scope, root: record.root, state: 'unresolvable', detail: verdict.error ?? 'artifact missing' });
      failed++;
      continue;
    }

    // STALE — re-install (refresh artifact + re-pin lockfile).
    const lockfilePath = lockfilePathForRecord(record.scope, record.root);
    process.stdout.write(
      `  ${tag}\n    → STALE (expected ${(verdict.expected ?? '').slice(0, 19)}…, got ${(verdict.actual ?? '').slice(0, 19)}…) — re-installing\n`,
    );
    try {
      await install({
        scope: record.scope as Scope,
        mode: 'update',
        root: record.root,
        configPath: configPathForRecord(record.scope, record.root),
        lockfilePath,
      });
      rematerializeServiceStores(record.scope, record.root, lockfilePath);
    } catch (e) {
      process.stdout.write(`    → RE-INSTALL FAILED: ${String(e)}\n`);
      outcomes.push({ extId: record.extId, scope: record.scope, root: record.root, state: 'failed', detail: String(e) });
      failed++;
      continue;
    }

    // PI-5 / BL-141: cold-spawn gate — verify soxe serve <ext> resolution succeeds
    // (no pre-existing socket required, just that the lockfile resolves to a real
    // extension dir with a valid manifest). Runs AFTER re-install so the fresh
    // artifact is what gets resolved.
    const serveManifest = resolveServeManifest(record.extId, record.scope, record.root);
    if (!serveManifest || !serveManifest.manifest.entrypoint) {
      process.stdout.write(
        `    → COLD-SPAWN GATE FAILED: extension '${record.extId}' resolved but ` +
        `entrypoint not found at scope '${record.scope}' — re-install may have produced an incomplete state\n`,
      );
      outcomes.push({
        extId: record.extId, scope: record.scope, root: record.root,
        state: 'failed', detail: 'cold-spawn gate: entrypoint not resolvable post-upgrade',
      });
      failed++;
      continue;
    }
    process.stdout.write(`    → cold-spawn gate OK (entrypoint: ${serveManifest.manifest.entrypoint})\n`);

    changed++;
    outcomes.push({ extId: record.extId, scope: record.scope, root: record.root, state: 'upgraded', detail: 're-pinned to new artifact' });
    toRestart.push({ extId: record.extId, scope: record.scope, root: record.root });
  }

  // 3. Rolling restart pass — SEQUENTIAL, one service at a time.
  if (toRestart.length > 0) {
    process.stdout.write(`\n${CLI} upgrade: rolling restart pass (${toRestart.length} upgraded consumer${toRestart.length === 1 ? '' : 's'})\n`);
    for (const r of toRestart) {
      process.stdout.write(`  ${r.extId} (scope: ${r.scope})\n`);
      const res = await rollingRestartConsumer(
        r.extId, r.scope, r.root,
        (m) => process.stdout.write(`    ${m}\n`),
      );
      // Reflect the disposition back onto the matching outcome.
      const oc = outcomes.find((o) => o.extId === r.extId && o.scope === r.scope && o.root === r.root && o.state === 'upgraded');
      if (oc) {
        if (res.disposition === 'restarted' && !res.detail.includes('FAILED')) {
          oc.state = 'restarted';
          // Verify the running process actually loaded the new artifact.
          const verified = await verifyRunningArtifact(r.extId, lockfilePathForRecord(r.scope, r.root));
          if (!verified.ok) {
            oc.state = 'restart-mismatch';
            oc.detail = verified.detail;
            process.stdout.write(`    ⚠ verify: ${verified.detail}\n`);
          } else {
            oc.detail = res.detail;
          }
        } else if (res.disposition === 'backend-restarted') {
          oc.state = 'backend-restarted';
          // Verify proxy backend process artifact.
          const verified = await verifyRunningArtifact(r.extId, lockfilePathForRecord(r.scope, r.root));
          if (!verified.ok) {
            oc.state = 'backend-restart-mismatch';
            oc.detail = verified.detail;
            process.stdout.write(`    ⚠ verify: ${verified.detail}\n`);
          } else {
            oc.detail = res.detail;
          }
        } else if (res.disposition === 'reconnect-needed') {
          oc.state = 'reconnect-needed';
        } else {
          oc.detail = res.detail;
        }
      }
      if (res.detail.includes('FAILED')) failed++;
    }
  }

  // 4. MCP propagation reconcile (--force) — the fold of the retired `sync-mcp` verb.
  //    A project's `.mcp.json` OVERRIDES (does not inherit) user-scope MCP servers
  //    (#16728), so a user-scope MCP install is invisible in any project that has its
  //    own `.mcp.json`. Install/upgrade already propagate when the artifact changes;
  //    `--force` re-propagates UNCONDITIONALLY across every known project — the
  //    reconcile that catches a newly-created or drifted project whose artifact never
  //    went stale (the only gap a plain `upgrade --all` leaves).
  //
  //    Discovery is driven from the install-registry consumers we just walked (the
  //    user-scope records), NOT the ownership index — the ownership index can miss a
  //    server's `mcpServers.<id>` config-key, whereas the install registry always has
  //    the user-scope install record. `syncUserMcpToProjects` self-filters any id with
  //    no global `~/.claude.json` registration, so non-MCP consumers are cheap no-ops.
  if (flags['force'] !== undefined) {
    const reconcileHost = flags['host'] ?? 'claude';
    const userExtIds = [
      ...new Set(consumers.filter((r) => r.scope === 'user').map((r) => r.extId)),
    ];
    process.stdout.write(
      `\n${CLI} upgrade --force: MCP propagation reconcile (#16728) across known projects\n`,
    );
    let mcpMerged = 0;
    let mcpUpToDate = 0;
    for (const id of userExtIds) {
      let results;
      try {
        results = await syncUserMcpToProjects({ extId: id, host: reconcileHost });
      } catch (e) {
        process.stderr.write(`  warning: reconcile failed for '${id}' — ${String(e)}\n`);
        continue;
      }
      for (const r of results) {
        switch (r.action) {
          case 'merged':
            mcpMerged++;
            process.stdout.write(`  merged     ${id} → ${r.mcpJsonPath}\n`);
            break;
          case 'up-to-date':
            mcpUpToDate++;
            break;
          case 'skipped':
            process.stderr.write(`  skipped    ${id} → ${r.projectRoot} (${r.reason ?? ''})\n`);
            break;
          default:
            break;
        }
      }
    }
    process.stdout.write(`  reconcile done (merged=${mcpMerged}, up-to-date=${mcpUpToDate})\n`);
  }

  // ── Per-consumer report ──────────────────────────────────────────────────────
  process.stdout.write(`\n${CLI} upgrade — per-consumer report\n`);
  process.stdout.write(
    `  ${'EXTENSION'.padEnd(18)} ${'SCOPE'.padEnd(8)} ${'STATE'.padEnd(17)} DETAIL\n`,
  );
  process.stdout.write(`  ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(17)} ${'─'.repeat(40)}\n`);
  for (const o of outcomes) {
    process.stdout.write(
      `  ${o.extId.padEnd(18)} ${o.scope.padEnd(8)} ${o.state.padEnd(17)} ${o.detail}\n`,
    );
  }

  const currentCount = outcomes.filter((o) => o.state === 'current').length;
  process.stdout.write(
    `\n${currentCount} current, ${changed} upgraded, ${failed} failed.\n`,
  );
  if (changed === 0 && failed === 0) {
    process.stdout.write(`${CLI} upgrade: system fully current — zero changes.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

// ─── re-materialize service stores (BL-39 / ADR-0004 §D6) ──────────────────────

/**
 * Re-copy every service-registered extension's bundle from its (current) lockfile
 * source into its materialized store dir, so a running daemon never keeps stale
 * COPIED code after an install/update/upgrade. This is the BL-39 fix: it runs on
 * EVERY install path (install, update, upgrade), not just a fresh install.
 *
 * Idempotent + overwriting: the store is rebuilt from the source each call. The
 * ownership index's materialize entry is refreshed so uninstall still removes it.
 */
function rematerializeServiceStores(scope: string, root: string, lockfilePath: string): void {
  const fsMod3 = require('node:fs') as typeof import('node:fs');
  const pathMod3 = require('node:path') as typeof import('node:path');

  const registryPath3 = pathMod3.join(dataRoot(scope as DataScope, root), 'registry.json');
  const lockfile3 = loadLockfile(lockfilePath);
  if (!fsMod3.existsSync(registryPath3) || lockfile3 === null) return;

  let registry3: Record<string, { id: string; storePath: string }> = {};
  try {
    registry3 = JSON.parse(fsMod3.readFileSync(registryPath3, 'utf8')) as typeof registry3;
  } catch { return; /* malformed — nothing to refresh */ }

  const copyDirSync3 = (src: string, dest: string): void => {
    if (!fsMod3.existsSync(dest)) fsMod3.mkdirSync(dest, { recursive: true });
    for (const ent of fsMod3.readdirSync(src, { withFileTypes: true })) {
      const s = pathMod3.join(src, ent.name);
      const d = pathMod3.join(dest, ent.name);
      if (ent.isDirectory()) copyDirSync3(s, d);
      else fsMod3.copyFileSync(s, d);
    }
  };

  for (const [svcId, svc] of Object.entries(registry3)) {
    const lkEntry3 = lockfile3.resolved[svcId] ??
      Object.entries(lockfile3.resolved).find(([k]) => k.startsWith(svcId + '@'))?.[1];
    if (!lkEntry3) continue;

    const extDir3 = resolveExtensionDir(lkEntry3.source, root);
    if (!extDir3) continue;

    const bundleDir3 = pathMod3.join(extDir3, 'bundle');
    const distDir3 = pathMod3.join(extDir3, 'dist');
    const srcDir3 = fsMod3.existsSync(bundleDir3) ? bundleDir3
      : fsMod3.existsSync(distDir3) ? distDir3
        : null;
    if (!srcDir3) continue;

    const storePath3 = svc.storePath;
    // BL-39: clear the old store first so a renamed/removed file in the new artifact
    // does not linger, then re-copy the current bundle.
    try { if (fsMod3.existsSync(storePath3)) fsMod3.rmSync(storePath3, { recursive: true, force: true }); }
    catch { /* best-effort */ }
    copyDirSync3(srcDir3, storePath3);

    const srcManifest3 = pathMod3.join(extDir3, 'extension.json');
    if (fsMod3.existsSync(srcManifest3)) {
      const mf3 = JSON.parse(fsMod3.readFileSync(srcManifest3, 'utf8')) as Record<string, unknown>;
      mf3['entrypoint'] = 'index.js';
      fsMod3.writeFileSync(
        pathMod3.join(storePath3, 'extension.json'),
        JSON.stringify(mf3, null, 2) + '\n',
        'utf8',
      );
    }

    // Keep the ownership index's materialize entry current (idempotent upsert).
    try {
      const idx = OwnershipIndex.loadFromFile(
        pathMod3.join(dataRoot(scope as DataScope, root), 'ownership.json'),
      );
      const existing = idx.get(svcId, scope);
      const hasStore = existing?.entries.some(
        (e) => e.kind === 'materialize' && e.path === storePath3,
      );
      if (!hasStore) {
        idx.addEntries(svcId, scope, [{ kind: 'materialize', path: storePath3 }]);
        idx.save();
      }
    } catch { /* ownership refresh best-effort */ }

    process.stdout.write(`${CLI} install: refreshed store   ${storePath3}\n`);
  }
}

// ─── uninstall helpers (BL-275 bundle-level uninstall) ─────────────────────────

/**
 * Resolve bundle members for uninstall. Returns null if `id` is NOT a bundle
 * (resolved by checking the registry for a type:bundle entry with members).
 */
function resolveBundleMembersForUninstall(
  bundleId: string,
  registryIndex: ReturnType<typeof loadRegistryIndex>,
  _root: string,
): string[] | null {
  const entry = registryIndex.find((e) => e.id === bundleId && e.type === 'bundle');
  if (entry?.members !== undefined && entry.members.length > 0) {
    return entry.members.map((m) => m.id);
  }
  return null;
}

/**
 * Uninstall one extension id at a given scope/root.
 * This is the CORE uninstall logic, extracted so bundle-level uninstall can
 * recurse per member without re-parsing argv.
 */
async function uninstallOne(
  id: string,
  scope: string,
  root: string,
  flags: Record<string, string>,
  _opts?: { isBundleMember?: boolean },
): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const scopeTyped = scope as 'org' | 'user' | 'project' | 'local';

  let scopePaths5: { config: string; lockfile: string };
  try {
    scopePaths5 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} uninstall: ${String(e)}\n`);
    process.exit(1);
  }

  // Honor explicit --lockfile / --config overrides (used by e2e to operate on temp paths).
  const lockfilePath5 = flags['lockfile'] ?? scopePaths5.lockfile;
  const configPath5 = flags['config'] ?? scopePaths5.config;

  const lockfile = loadLockfile(lockfilePath5);

  // BL-275/C2: lockfile-less --host file-drop uninstall.
  if (lockfile === null) {
    // Fall through with an empty lockfile.
  }

  const lockKeys = lockfile !== null ? Object.keys(lockfile.resolved) : [];
  const matchKey = lockKeys.find((k) => {
    if (k === id) return true;
    const atIdx = k.lastIndexOf('@');
    return atIdx !== -1 && k.slice(0, atIdx) === id;
  });

  if (lockfile === null) {
    // No lockfile — rely entirely on ownership/ledger index below.
  } else if (matchKey === undefined) {
    // BL-109: fall back to ownership index.
    try {
      const pathM4 = require('node:path') as typeof import('node:path');
      const dataDir4 = dataRoot(scopeTyped as DataScope, root);
      const ownPath4 = pathM4.join(dataDir4, 'ownership.json');
      if (fsMod.existsSync(ownPath4)) {
        const ownership4 = OwnershipIndex.loadFromFile(ownPath4);
        const ownedRec = ownership4.get(id, scopeTyped);
        if (ownedRec && ownedRec.entries.length > 0) {
          process.stderr.write(`${CLI} uninstall: '${id}' found in ownership index (not lockfile) — proceeding with ledger reversal\n`);
        } else {
          process.stderr.write(`${CLI} uninstall: extension '${id}' not found in lockfile or ownership index\n`);
          process.stderr.write(`  Installed: ${lockKeys.join(', ') || '(none)'}\n`);
          process.exit(1);
        }
      } else {
        process.stderr.write(`${CLI} uninstall: extension '${id}' not found in lockfile\n`);
        process.stderr.write(`  Installed: ${lockKeys.join(', ') || '(none)'}\n`);
        process.exit(1);
      }
    } catch {
      process.stderr.write(`${CLI} uninstall: extension '${id}' not found in lockfile\n`);
      process.stderr.write(`  Installed: ${lockKeys.join(', ') || '(none)'}\n`);
      process.exit(1);
    }
  }

  // ── ADR-0004 §D6 [inv:reversible-injection]: consume the ownership index ────
  const dataDir = dataRoot(scopeTyped as DataScope, root);
  const pathMod = require('node:path') as typeof import('node:path');
  const ownership = OwnershipIndex.loadFromFile(pathMod.join(dataDir, 'ownership.json'));
  const owned = ownership.get(id, scopeTyped);

  // BL-275/C2 left a gap: when there is no lockfile at all (fresh/lockfile-less
  // scope), the not-found check above (lines 2980-3005) never runs — it lives
  // entirely inside the `matchKey === undefined` branch, which is only reached
  // when `lockfile !== null`. Without this guard, an id that is in neither the
  // lockfile nor the ownership index silently no-ops "successfully" instead of
  // failing, and cmdUninstall unconditionally exits 0 afterwards.
  if (lockfile === null && owned === undefined) {
    process.stderr.write(`${CLI} uninstall: extension '${id}' not found (no lockfile in scope '${scopeTyped}', and not in ownership index)\n`);
    process.exit(1);
  }

  // ── #16728 durable fix: reverse the propagated project .mcp.json merges ─────
  if (scopeTyped === 'user' || scopeTyped === 'org') {
    try {
      const host0 = owned?.host ?? 'claude';
      const reversed = await reverseUserMcpFromProjects({ extId: id, host: host0 });
      for (const p of reversed) {
        process.stdout.write(`${CLI} uninstall: mcp-sync removed  ${id} ← ${p}\n`);
      }
    } catch (e) {
      process.stderr.write(`${CLI} uninstall: warning: mcp project-sync reversal failed for '${id}' — ${String(e)}\n`);
    }
  }

  // ── mcp-trust durable fix: reverse any trust grants sox made (any scope) ────
  // Trust entries always live in the user-scope ownership record regardless of
  // which install scope created them (~/.claude.json is a single user-level
  // file) — unlike the .mcp.json propagation above, this is NOT scope-gated.
  try {
    const hostTrust = owned?.host ?? 'claude';
    const untrusted = await reverseMcpTrustFromProjects({ extId: id, host: hostTrust });
    for (const p of untrusted) {
      process.stdout.write(`${CLI} uninstall: mcp-trust removed  ${id} ← ${p}\n`);
    }
  } catch (e) {
    process.stderr.write(`${CLI} uninstall: warning: mcp-trust reversal failed for '${id}' — ${String(e)}\n`);
  }

  if (owned !== undefined) {
    const host = owned.host ?? 'claude';
    try {
      await lifecycleUninstall({
        ext: id,
        host,
        scope: scopeTyped,
        scopeRoot: dataDir,
        isProject: scopeTyped === 'project',
      });
    } catch (e) {
      process.stderr.write(`${CLI} uninstall: config reversal aborted: ${String(e)}\n`);
      process.exit(1);
    }

    for (const entry of owned.entries) {
      if (entry.kind !== 'os-unit') continue;
      const platform = getOsUnitPlatform(entry.supervisor);
      const unitDir = process.env['SOX_OS_UNIT_DIR'] ?? pathMod.dirname(entry.unitPath);
      const ctx = resolveOsUnitContext(id, scopeTyped, root, {});
      if (ctx?.entrypoint) {
        const res = await unloadThenReap({
          label: entry.label,
          entrypoint: ctx.entrypoint,
          platform,
          unitDir,
          excludePids: [process.pid],
          log: (m) => process.stdout.write(`${CLI} uninstall: ${m}\n`),
        });
        if (res.undead) {
          process.stderr.write(`${CLI} uninstall: warning: a survivor of '${entry.label}' could not be confirmed dead\n`);
        }
      }
      disableOsUnit(entry.label, platform, { unitDir, log: (m) => process.stdout.write(`${CLI} uninstall: ${m}\n`) });
    }

    for (const entry of owned.entries) {
      if (entry.kind === 'file-drop' || entry.kind === 'materialize') {
        try {
          if (fsMod.existsSync(entry.path)) {
            fsMod.rmSync(entry.path, { recursive: true, force: true });
          }
        } catch (e) {
          process.stderr.write(
            `${CLI} uninstall: warning: could not remove ${entry.path}: ${String(e)}\n`,
          );
        }
      }
    }

    ownership.remove(id, scopeTyped);
    ownership.save();
  }

  // Remove from lockfile.
  if (lockfile !== null) {
    const updatedLock = { ...lockfile, resolved: { ...lockfile.resolved } };
    if (matchKey !== undefined) {
      delete updatedLock.resolved[matchKey];
    }
    fsMod.writeFileSync(lockfilePath5, JSON.stringify(updatedLock, null, 2) + '\n', 'utf-8');
  }

  // Also remove from extensions.json.
  if (fsMod.existsSync(configPath5)) {
    try {
      const cfg = JSON.parse(fsMod.readFileSync(configPath5, 'utf8')) as {
        install?: Array<{ id: string }>;
      };
      if (Array.isArray(cfg.install)) {
        cfg.install = cfg.install.filter((e) => e.id !== id);
        fsMod.writeFileSync(configPath5, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      }
    } catch { /* config parse failure — lockfile is already cleaned up */ }
  }

  // P9: remove the install record from the global install ledger.
  try {
    removeInstallRecord(id, scopeTyped, root);
  } catch (e) {
    process.stderr.write(`${CLI} uninstall: warning: failed to remove install record: ${String(e)}\n`);
  }

  process.stdout.write(`${CLI} uninstall: done  ${id} (${scopeTyped})\n`);
}

// ─── uninstall ────────────────────────────────────────────────────────────────

async function cmdUninstall(flags: Record<string, string>): Promise<void> {
  // --help / -h — exit 0 immediately
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} uninstall — remove an installed extension from a scope

Usage:
  ${CLI} uninstall <id> [-s <scope>]

Options:
  -s, --scope <scope>    Scope: user | project | local  (default: user)
  --help                 Show this message
`);
    process.exit(0);
  }

  const ROOT5 = process.cwd();
  // Accept positional (flags['_']) or --id flag.
  const id = flags['id'] ?? flags['_'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const root = flags['root'] ?? ROOT5;

  if (id === undefined || id === '') {
    process.stderr.write(`${CLI} uninstall: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  // BL-275: bundle-level uninstall — resolve bundle id → member set → reverse each.
  // Lockfile + ownership are keyed by member ids, not bundle id. When the user runs
  // `soxe uninstall <bundleId>`, we resolve the member set from the registry and
  // uninstall each member individually. Each member has its own ownership record
  // (with bundleId field) so the reversal is identical to per-member uninstall.
  const registryIndexForUninstall = loadRegistryResolved(ROOT5);
  const bundleMemberIds = resolveBundleMembersForUninstall(id, registryIndexForUninstall, ROOT5);
  if (bundleMemberIds !== null) {
    process.stdout.write(`${CLI} uninstall: '${id}' is a bundle — uninstalling ${bundleMemberIds.length} member(s): ${bundleMemberIds.join(', ')}\n`);
    let anyFailed = false;
    for (const memberId of bundleMemberIds) {
      process.stdout.write(`${CLI} uninstall:  → ${memberId}\n`);
      try {
        // Recurse: run uninstall for each member id. We reuse the same flags but
        // override the id. We call the internal uninstall logic directly rather than
        // re-parsing argv to avoid infinite recursion.
        await uninstallOne(memberId, scope, root, flags, { isBundleMember: true });
      } catch (e) {
        process.stderr.write(`${CLI} uninstall: member '${memberId}' failed: ${String(e)}\n`);
        anyFailed = true;
      }
    }
    process.exit(anyFailed ? 1 : 0);
  }

  await uninstallOne(id, scope, root, flags);
  process.exit(0);
}

// ─── enable ───────────────────────────────────────────────────────────────────

async function cmdEnable(flags: Record<string, string>): Promise<void> {
  const ROOT3 = process.cwd();
  // Accept positional id as well as --id flag.
  const rawAfterVerbEn = argv.slice(1);
  let positionalEn: string | undefined;
  for (const tok of rawAfterVerbEn) {
    if (!tok.startsWith('-')) { positionalEn = tok; break; }
  }
  const id = flags['id'] ?? positionalEn;
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const root = flags['root'] ?? ROOT3;

  if (id === undefined || id === '') {
    process.stderr.write(`${CLI} enable: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');

  let scopePaths3: { config: string; lockfile: string };
  try {
    scopePaths3 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} enable: ${String(e)}\n`);
    process.exit(1);
  }

  const configPath3 = flags['config'] ?? scopePaths3.config;
  const lockfilePath3 = flags['lockfile'] ?? scopePaths3.lockfile;
  const runtimeFilePath3 =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath3);

  // 1. Update config: mark extension as enabled in install[] (matches readShouldRunSet).
  const cfg3 = loadConfig(configPath3);
  if (cfg3 !== null && Array.isArray(cfg3.install)) {
    const installEntry = (cfg3.install as Array<{ id: string; enabled?: boolean }>).find(
      (e) => e.id === id,
    );
    if (installEntry) installEntry.enabled = true;
    fsMod.writeFileSync(configPath3, JSON.stringify(cfg3, null, 2) + '\n', 'utf-8');
  }

  // 2. Send SIGHUP to the running supervisor so it reconciles.
  //    reconcileRuntime (runtime.ts) now also *starts* newly-enabled extensions,
  //    so the original supervisor keeps ownership — it is NOT killed here.
  //    This preserves the test's startProcess reference until `soxe stop` kills it
  //    cleanly with process.exit(0), keeping exitCode === 0 (not null).
  const rtRaw3 = fsMod.existsSync(runtimeFilePath3)
    ? (() => {
      try {
        return JSON.parse(fsMod.readFileSync(runtimeFilePath3, 'utf8')) as {
          supervisorPid?: number;
        };
      } catch { return null; }
    })()
    : null;
  const supPid3 = typeof rtRaw3?.supervisorPid === 'number' ? rtRaw3.supervisorPid : null;

  if (supPid3 === null) {
    process.stderr.write(`${CLI} enable: no running supervisor found in runtime record — try '${CLI} start' first\n`);
    process.exit(1);
  }

  try {
    process.stdout.write(`sox: signaling supervisor (pid=${supPid3}) to reconcile (enable '${id}')...\n`);
    process.kill(supPid3, 'SIGHUP');
  } catch (e) {
    process.stderr.write(`${CLI} enable: could not signal supervisor: ${String(e)}\n`);
    process.exit(1);
  }

  // 3. Poll runtime record until the target extension appears running (up to 10 s).
  const deadline3 = Date.now() + 10000;
  let isRunning3 = false;
  while (Date.now() < deadline3) {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    if (fsMod.existsSync(runtimeFilePath3)) {
      try {
        const rec3 = JSON.parse(fsMod.readFileSync(runtimeFilePath3, 'utf8')) as {
          entries?: Array<{ id: string; key?: string; running?: boolean }>;
        };
        const e3 = (rec3.entries ?? []).find((e) => e.id === id || e.key === id);
        if (e3?.running) { isRunning3 = true; break; }
      } catch { /* retry */ }
    }
  }

  if (isRunning3) {
    process.stdout.write(`${CLI} enable: '${id}' enabled and running\n`);
  } else {
    process.stderr.write(
      `${CLI} enable: '${id}' enabled but process did not appear running within timeout\n`,
    );
  }
  process.exit(0);
}

// ─── disable ──────────────────────────────────────────────────────────────────

async function cmdDisable(flags: Record<string, string>): Promise<void> {
  const ROOT4 = process.cwd();
  // Accept positional id as well as --id flag.
  const rawAfterVerbDis = argv.slice(1);
  let positionalDis: string | undefined;
  for (const tok of rawAfterVerbDis) {
    if (!tok.startsWith('-')) { positionalDis = tok; break; }
  }
  const id = flags['id'] ?? positionalDis;
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const root = flags['root'] ?? ROOT4;

  if (id === undefined || id === '') {
    process.stderr.write(`${CLI} disable: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');

  let scopePaths4: { config: string; lockfile: string };
  try {
    scopePaths4 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} disable: ${String(e)}\n`);
    process.exit(1);
  }

  const configPath4 = flags['config'] ?? scopePaths4.config;
  const lockfilePath4 = flags['lockfile'] ?? scopePaths4.lockfile;
  const runtimeFilePath4 =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath4);

  // Update config FIRST: mark extension as disabled so supervisor reconcile stops it.
  const cfg4 = loadConfig(configPath4);
  if (cfg4 !== null && Array.isArray(cfg4.install)) {
    const installEntry = (cfg4.install as Array<{ id: string; enabled?: boolean }>).find(
      (e) => e.id === id,
    );
    if (installEntry) installEntry.enabled = false;
    fsMod.writeFileSync(configPath4, JSON.stringify(cfg4, null, 2) + '\n', 'utf-8');
  }

  // Read runtime record to find child pid + supervisor pid.
  function pidAlive4(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  const rtRaw4 = fsMod.existsSync(runtimeFilePath4)
    ? (() => {
      try {
        return JSON.parse(fsMod.readFileSync(runtimeFilePath4, 'utf8')) as {
          entries?: Array<{ id: string; key?: string; running?: boolean; pid?: number | null }>;
          supervisorPid?: number;
        };
      } catch { return null; }
    })()
    : null;

  const rtEntry4 = (rtRaw4?.entries ?? []).find((e) => e.id === id || e.key === id);
  const childPid4 = (rtEntry4?.running && rtEntry4.pid != null) ? rtEntry4.pid : null;
  const supPid4 = typeof rtRaw4?.supervisorPid === 'number' ? rtRaw4.supervisorPid : null;

  if (supPid4 !== null && pidAlive4(supPid4)) {
    // Signal supervisor to reconcile — it reads the updated config (enabled=false) and
    // stops the extension without restarting it.
    process.stdout.write(`sox: signaling supervisor (pid=${supPid4}) to reconcile...\n`);
    try { process.kill(supPid4, 'SIGHUP'); } catch (e) {
      process.stderr.write(`sox: SIGHUP to supervisor failed: ${String(e)}\n`);
    }
    // Wait up to 6 s for the runtime record to show running=false, NOT for a specific
    // pid — the supervisor may restart the child between our read and the reconcile,
    // giving a new pid.  Polling the record (updated by reconcile when it finishes)
    // ensures we wait for the right signal.
    const stopDeadline4 = Date.now() + 6000;
    let reconciled4 = false;
    while (Date.now() < stopDeadline4) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (fsMod.existsSync(runtimeFilePath4)) {
        try {
          const chk4 = JSON.parse(fsMod.readFileSync(runtimeFilePath4, 'utf8')) as {
            entries?: Array<{ id: string; key?: string; running?: boolean }>;
          };
          const chkEntry4 = (chk4.entries ?? []).find((e) => e.id === id || e.key === id);
          if (!chkEntry4 || chkEntry4.running === false) { reconciled4 = true; break; }
        } catch { /* retry */ }
      } else {
        reconciled4 = true; break;
      }
    }
    if (!reconciled4) {
      process.stderr.write(`sox: reconcile timed out for '${id}' — killing directly\n`);
    }
    // After reconcile, also hard-kill any pid still shown as running
    // (handles the case where reconcile completed but a re-spawned child slipped through).
    if (fsMod.existsSync(runtimeFilePath4)) {
      try {
        const final4 = JSON.parse(fsMod.readFileSync(runtimeFilePath4, 'utf8')) as {
          entries?: Array<{ id: string; key?: string; running?: boolean; pid?: number | null }>;
        };
        const finalEntry4 = (final4.entries ?? []).find((e) => e.id === id || e.key === id);
        if (finalEntry4?.running && finalEntry4.pid != null) {
          try { process.kill(finalEntry4.pid, 'SIGKILL'); } catch { /* gone */ }
        }
      } catch { /* ignore */ }
    }
    // Additionally kill the original child pid if it's somehow still alive.
    if (childPid4 !== null && pidAlive4(childPid4)) {
      try { process.kill(childPid4, 'SIGKILL'); } catch { /* gone */ }
    }
  } else if (childPid4 !== null) {
    // No supervisor — kill the child directly.
    try {
      process.kill(childPid4, 'SIGTERM');
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      if (pidAlive4(childPid4)) {
        try { process.kill(childPid4, 'SIGKILL'); } catch { /* gone */ }
      }
    } catch (e) {
      process.stderr.write(`sox: could not stop ${id} (pid=${childPid4}): ${String(e)}\n`);
    }
  }

  // Update runtime record to reflect the stopped state.
  if (fsMod.existsSync(runtimeFilePath4)) {
    try {
      const fresh4 = JSON.parse(fsMod.readFileSync(runtimeFilePath4, 'utf8')) as {
        entries?: Array<{ id: string; key?: string; running?: boolean; pid?: number | null }>;
      };
      const freshEntry4 = (fresh4.entries ?? []).find((e) => e.id === id || e.key === id);
      if (freshEntry4) { freshEntry4.running = false; freshEntry4.pid = null; }
      fsMod.writeFileSync(runtimeFilePath4, JSON.stringify(fresh4, null, 2) + '\n', 'utf-8');
    } catch { /* ignore */ }
  }

  process.stdout.write(`${CLI} disable: '${id}' disabled\n`);
  process.exit(0);
}

// ─── list ─────────────────────────────────────────────────────────────────────

async function cmdList(flags: Record<string, string>): Promise<void> {
  // --help / -h — exit 0 immediately
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} list — list installed extensions and their running state

Usage:
  ${CLI} list [-s <scope>] [--all] [--global] [--json]

Options:
  -s, --scope <scope>    Scope: user | project | local  (default: all scopes)
  --all                  Include all extensions (including disabled)
  --global               Show global install registry (~/.sox/install-registry.json)
  --json                 Output as JSON array
  --help                 Show this message
`);
    process.exit(0);
  }

  const ROOT2 = process.cwd();
  const jsonMode = flags['json'] !== undefined;
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  // ── --global mode: reads the global install registry (P9, ADR-0004 §D7) ────
  // Shows every extension ever installed on this machine, across all projects.
  // No live probing — works without any supervisor running.
  if (flags['global'] !== undefined) {
    const registryPath = installRegistryPath();
    const registry = readInstallRegistry(registryPath);
    let records: InstallRecord[] = registry.installs;

    // Apply filters: --id and --scope
    const idFilter = flags['id'];
    const scopeFilter = flags['scope'];
    if (idFilter !== undefined) {
      records = records.filter((r) => r.extId === idFilter);
    }
    if (scopeFilter !== undefined) {
      records = records.filter((r) => r.scope === scopeFilter);
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(records, null, 2) + '\n');
      process.exit(0);
    }

    if (records.length === 0) {
      process.stdout.write(`${CLI} list --global: no install records found\n`);
      process.exit(0);
    }

    // Compute column widths.
    const col1 = Math.max(...records.map((r) => r.extId.length), 2);
    const col2 = Math.max(...records.map((r) => r.version.length), 7);
    const col3 = Math.max(...records.map((r) => r.scope.length), 5);
    const col4 = Math.max(...records.map((r) => require('node:path').basename(r.root as string).length), 7);
    const col5 = 17; // "2026-06-01T09:00Z" (truncated to minute)
    const col6 = 17;

    // Truncate ISO timestamp to minute: "2026-06-01T09:00Z"
    const fmtTs = (ts: string): string => {
      // ts = "2026-06-01T09:00:00.000Z" → "2026-06-01T09:00Z"
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(ts);
      return m ? `${m[1]}Z` : ts.slice(0, 17);
    };

    process.stdout.write(
      `${'ID'.padEnd(col1)}  ${'VERSION'.padEnd(col2)}  ${'SCOPE'.padEnd(col3)}  ${'PROJECT'.padEnd(col4)}  ${'INSTALLED'.padEnd(col5)}  ${'UPDATED'.padEnd(col6)}\n`,
    );
    process.stdout.write(
      `${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  ${'-'.repeat(col4)}  ${'-'.repeat(col5)}  ${'-'.repeat(col6)}\n`,
    );
    for (const r of records) {
      const project = (require('node:path').basename(r.root as string) as string).padEnd(col4);
      process.stdout.write(
        `${r.extId.padEnd(col1)}  ${r.version.padEnd(col2)}  ${r.scope.padEnd(col3)}  ${project}  ${fmtTs(r.installedAt).padEnd(col5)}  ${fmtTs(r.updatedAt).padEnd(col6)}\n`,
      );
    }
    process.exit(0);
  }

  // ── --all mode: reads ~/.sox/supervisors.json and merges runtime records ───
  // Shows what is running across all projects on this machine.
  // Stale entries (dead pid or unreachable socket) are cleaned up by quickReconcile.
  if (flags['all'] !== undefined) {
    // R2 / BL-176: quickReconcile phase 0 (readGlobalRegistry — full
    // probeEntryLiveness pid+socket, removes stale entries) + phase 3
    // (split-brain runtime.json heal, persisted) before rendering.
    const { liveSupervisors: supervisors } = await quickReconcile({ root: flags['root'] ?? ROOT2 });

    type AllRow = {
      id: string;
      key: string;
      version: string;
      scope: string;
      root: string;
      running: boolean;
      pid: number | null;
    };
    const allRows: AllRow[] = [];

    for (const sup of supervisors) {
      // Read the runtime.json for this supervisor.
      if (!fsMod.existsSync(sup.runtimeFilePath)) continue;
      let runtimeEntries: Array<{
        id: string;
        key?: string;
        running?: boolean;
        pid?: number | null;
      }> = [];
      try {
        const rec = JSON.parse(fsMod.readFileSync(sup.runtimeFilePath, 'utf8')) as {
          entries?: Array<{ id: string; key?: string; running?: boolean; pid?: number | null }>;
        };
        runtimeEntries = rec.entries ?? [];
      } catch { continue; }

      for (const rtEntry of runtimeEntries) {
        if (rtEntry.running !== true) continue; // --all only shows running extensions
        const key = rtEntry.key ?? rtEntry.id;
        const atIdx = key.lastIndexOf('@');
        const extId = atIdx === -1 ? key : key.slice(0, atIdx);
        const ver = atIdx === -1 ? '' : key.slice(atIdx + 1);
        const pid = (rtEntry.pid != null && typeof rtEntry.pid === 'number') ? rtEntry.pid : null;

        allRows.push({
          id: extId,
          key,
          version: ver,
          scope: sup.scope,
          root: sup.root,
          running: true,
          pid,
        });
      }
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(allRows, null, 2) + '\n');
      process.exit(0);
    }

    if (allRows.length === 0) {
      process.stdout.write(`${CLI} list --all: no running extensions found across all supervisors\n`);
      process.exit(0);
    }

    const col1 = Math.max(...allRows.map((r) => r.id.length), 4);
    const col2 = Math.max(...allRows.map((r) => r.version.length), 7);
    const col3 = Math.max(...allRows.map((r) => r.scope.length), 5);
    const col4 = Math.max(...allRows.map((r) => r.root.length), 4);

    process.stdout.write(
      `${'ID'.padEnd(col1)}  ${'VERSION'.padEnd(col2)}  ${'SCOPE'.padEnd(col3)}  ${'STATUS'.padEnd(8)}  PID     ROOT\n`,
    );
    process.stdout.write(
      `${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  ${'-'.repeat(8)}  ------  ${'-'.repeat(col4)}\n`,
    );
    for (const r of allRows) {
      const pidStr = r.pid !== null ? String(r.pid) : '';
      process.stdout.write(
        `${r.id.padEnd(col1)}  ${r.version.padEnd(col2)}  ${r.scope.padEnd(col3)}  ${'RUNNING'.padEnd(8)}  ${pidStr.padEnd(6)}  ${r.root}\n`,
      );
    }
    process.exit(0);
  }

  // When no explicit --scope is given, scan all scopes (user, project, local) —
  // matching the old bin/soxe behaviour and allowing `soxe list --root=TMP` to find
  // project-scope extensions without requiring `-s project`.
  const scopeOverride = flags['scope'];
  const root = flags['root'] ?? ROOT2;
  const statusFilter = flags['status']; // e.g. --status=running

  const runtimeFileOverride = flags['runtime-file'] ?? process.env['SOX_RUNTIME_FILE'];

  // When --runtime-file is explicitly provided, read the scope declared in that
  // record so we scan only the matching lockfile. This prevents a runtime record
  // for scope=project being attributed to scope=user because the user lockfile is
  // scanned first and inherits the shared runtimeFileOverride. ([inv:scope-provenance])
  let effectiveScopeOverride = scopeOverride;
  if (runtimeFileOverride !== undefined && effectiveScopeOverride === undefined) {
    try {
      const overrideRec = JSON.parse(
        (require('node:fs') as typeof import('node:fs')).readFileSync(runtimeFileOverride, 'utf8'),
      ) as { scope?: string };
      if (overrideRec.scope !== undefined) effectiveScopeOverride = overrideRec.scope;
    } catch { /* ignore — fall through to scanning all scopes */ }
  }

  const scopesToScan = effectiveScopeOverride !== undefined
    ? [effectiveScopeOverride]
    : ['user', 'project', 'local'];

  // BL-176: fast-path reconcile — phase 0 (GC dead supervisors) + phase 3
  // (split-brain runtime.json heal, persisted) before reading runtime.json for
  // display, so a stale running:true survives neither this read NOR a
  // subsequent one ([inv:list-never-lies], §10.2). Never touches a scope whose
  // runtime.json is owned by a still-live supervisor.
  await quickReconcile({ root, scopes: scopesToScan });

  // Strip file:// scheme prefix from a source path for clean display.
  function cleanSource(src: string | undefined): string {
    if (!src) return '';
    return src.startsWith('file://') ? src.slice('file://'.length) : src;
  }

  const allRows: Array<{
    id: string;
    key: string;
    version: string;
    scope: string;
    running: boolean;
    source: string;
    pid: number | null;
  }> = [];

  for (const sc of scopesToScan) {
    let sp: { config: string; lockfile: string };
    try {
      sp = getScopePaths(sc, root);
    } catch {
      continue;
    }

    const lf = loadLockfile(sp.lockfile);
    if (lf === null) continue;

    const runtimeFilePath = runtimeFileOverride ?? getRuntimeFilePath(sp.lockfile);

    let runtimeEntries: Array<{
      id: string;
      key?: string;
      source?: string;
      running?: boolean;
      pid?: number | null;
    }> = [];
    if (fsMod.existsSync(runtimeFilePath)) {
      try {
        const rec = JSON.parse(fsMod.readFileSync(runtimeFilePath, 'utf8')) as {
          entries?: Array<{ id: string; key?: string; source?: string; running?: boolean; pid?: number | null }>;
        };
        runtimeEntries = rec.entries ?? [];
      } catch { /* ignore */ }
    }

    for (const lockKey of Object.keys(lf.resolved)) {
      const entry = lf.resolved[lockKey];
      const atIdx = lockKey.lastIndexOf('@');
      const extId = atIdx === -1 ? lockKey : lockKey.slice(0, atIdx);
      const ver = atIdx === -1 ? '' : lockKey.slice(atIdx + 1);

      const rtEntry = runtimeEntries.find((r) => (r.key ?? r.id) === lockKey || r.id === extId);
      const pid = (rtEntry?.pid != null && typeof rtEntry.pid === 'number') ? rtEntry.pid : null;
      // C4: validate RUNNING state against the OS process table, not just the bookkeeping record.
      // A stale runtime.json entry (crash, SIGKILL, reboot) must not appear as RUNNING.
      const pidAlive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
      let running = rtEntry?.running === true && pid !== null && pidAlive(pid);
      let finalPid = pid;

      // [inv:list-never-lies] fallback (BL-332): runtime.json has no entry at all for an
      // M4 (OS-unit-adopted) service — `service enable` never writes one. Only attempted
      // when the runtime.json-derived check above already found the row not-running (§3.4
      // of SPEC-PKT-39): a live GC-verified supervisor record already IS reality-verified.
      // Reuses the same identity-based reality primitives cmdService's `status` subcommand
      // uses (main.ts:4932-4936), resolving the entrypoint inline from data already in this
      // loop rather than via resolveOsUnitContext (§3.2 — that helper does unrelated,
      // expensive work: nvm/asdf/volta path probing, ownership-index reads).
      if (!running && entry?.source !== undefined) {
        try {
          const extDir = resolveExtensionDir(entry.source, root);
          const manifestPath = extDir !== null ? pathMod.join(extDir, 'extension.json') : null;
          if (extDir !== null && manifestPath !== null && fsMod.existsSync(manifestPath)) {
            const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as { entrypoint?: string };
            if (manifest.entrypoint) {
              const entrypointAbs = pathMod.resolve(extDir, manifest.entrypoint);
              const token = identityToken(`file://${entrypointAbs}`);
              const liveMatches = findOrphansByIdentity(token, { excludePids: [process.pid] });
              if (liveMatches.length > 0) {
                running = true;
                finalPid = Math.min(...liveMatches.map((m) => m.pid));
              }
            }
          }
        } catch { /* best-effort reality check; on any failure, keep the runtime.json-derived state */ }
      }

      const rawSrc = rtEntry?.source ?? entry?.source ?? '';
      const source = cleanSource(typeof rawSrc === 'string' ? rawSrc : '');

      allRows.push({ id: extId, key: lockKey, version: ver, scope: sc, running, source, pid: finalPid });
    }
  }

  // Apply --status filter.
  const statusLower = statusFilter?.toLowerCase();
  const displayRows = statusLower !== undefined
    ? allRows.filter((r) => (r.running ? 'running' : 'inactive') === statusLower)
    : allRows;

  // ── JSON output ───────────────────────────────────────────────────────────
  if (jsonMode) {
    process.stdout.write(JSON.stringify(displayRows, null, 2) + '\n');
    process.exit(0);
  }

  // ── Human table ───────────────────────────────────────────────────────────
  if (displayRows.length === 0) {
    process.stdout.write(
      `${CLI} list: no extensions installed (scopes: ${scopesToScan.join(', ')})\n`,
    );
    process.exit(0);
  }

  const col1 = Math.max(...displayRows.map((r) => r.id.length), 4);
  const col2 = Math.max(...displayRows.map((r) => r.version.length), 7);
  const col3 = Math.max(...displayRows.map((r) => r.scope.length), 5);
  const col4 = 8; // INACTIVE / RUNNING

  process.stdout.write(
    `${'ID'.padEnd(col1)}  ${'VERSION'.padEnd(col2)}  ${'SCOPE'.padEnd(col3)}  ${'STATUS'.padEnd(col4)}  PID     SOURCE\n`,
  );
  process.stdout.write(
    `${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  ${'-'.repeat(col4)}  ------  ------\n`,
  );
  for (const r of displayRows) {
    const status = r.running ? 'RUNNING' : 'INACTIVE';
    const pidStr = r.pid !== null ? String(r.pid) : '';
    process.stdout.write(
      `${r.id.padEnd(col1)}  ${r.version.padEnd(col2)}  ${r.scope.padEnd(col3)}  ${status.padEnd(col4)}  ${pidStr.padEnd(6)}  ${r.source}\n`,
    );
  }
  process.exit(0);
}

// ─── details ─────────────────────────────────────────────────────────────────

/**
 * cmdDetails — show manifest fields + scope provenance for a named extension.
 *
 * Accepts the id as either a positional arg or --id flag.
 * Reads from registry/index.json (not the lockfile) so it works for any
 * registry entry, installed or not.
 * Shows type, version, source, members (bundle), requires, and installed-in
 * provenance across all scope lockfiles.
 */
function cmdDetails(flags: Record<string, string>): void {
  // --help / -h — exit 0 before touching any id
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} details — Show details for a named extension

Usage:
  ${CLI} details <id> [--scope=<scope>]

Looks up the extension in registry/index.json and prints its manifest fields.
Also shows scope provenance (installed-in) and running state.
Exits non-zero if the id is not found.
`);
    process.exit(0);
  }

  // Accept positional arg (flags['_']) or --id flag
  const id = flags['_'] ?? flags['id'];

  if (id === undefined || id === '') {
    process.stderr.write(`${CLI} details: extension id is required\n`);
    process.stderr.write(`Usage: ${CLI} details <id>\n`);
    process.exit(1);
  }

  // ── Registry lookup ──────────────────────────────────────────────────────
  const repoRoot = process.cwd();
  const registryIndex = loadRegistryResolved(repoRoot);
  const entry = registryIndex.find((e) => e.id === id);

  if (entry === undefined) {
    process.stderr.write(`${CLI} details: unknown extension '${id}'\n`);
    process.stderr.write(`Run '${CLI} search' to see available extensions.\n`);
    process.exit(1);
  }

  // ── Scope provenance: find which lockfiles contain this id ───────────────
  const fsDet = require('node:fs') as typeof import('node:fs');
  // BL-78: resolve the workspace root from cwd (or --root flag) — not repo root.
  // Use getScopePaths(scope, workspaceRoot) to get the correct lockfile paths for
  // project and local scopes, matching the BL-73 fix in cmdInstall.
  const workspaceRoot = require('node:path').resolve(flags['root'] ?? process.cwd()) as string;

  type InstalledEntry = {
    scope: string;
    source: string;
    resolved_at: string;
    running: boolean;
    pid: number | null;
  };
  const installedIn: InstalledEntry[] = [];

  for (const sc of ['user', 'project', 'local'] as const) {
    try {
      const sp = sc === 'user'
        ? getScopePath('user')
        : getScopePaths(sc, workspaceRoot);

      const lock = loadLockfile(sp.lockfile);
      if (!lock || typeof lock.resolved !== 'object') continue;

      // Read runtime record for running state
      const runtimeFilePath =
        flags['runtime-file'] ??
        process.env['SOX_RUNTIME_FILE'] ??
        sp.lockfile.replace(/\.lock$/, '.json').replace(/extensions\.json$/, 'runtime.json');
      let runtimeEntries: Array<{ id: string; key: string; running: boolean; pid: number | null }> = [];
      try {
        if (fsDet.existsSync(runtimeFilePath)) {
          const rec = JSON.parse(fsDet.readFileSync(runtimeFilePath, 'utf8')) as {
            entries?: Array<{ id: string; key: string; running: boolean; pid: number | null }>;
          };
          runtimeEntries = Array.isArray(rec.entries) ? rec.entries : [];
        }
      } catch { /* skip unreadable runtime record */ }

      for (const [key, lockEntry] of Object.entries(lock.resolved)) {
        const baseKey = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;
        if (key !== id && baseKey !== id) continue;

        const runtimeEntry = runtimeEntries.find((e) => e.key === key || e.id === baseKey);
        installedIn.push({
          scope: sc,
          source: (lockEntry as { source?: string }).source ?? '—',
          resolved_at: (lockEntry as { resolved_at?: string }).resolved_at ?? '—',
          running: runtimeEntry?.running ?? false,
          pid: runtimeEntry?.pid ?? null,
        });
      }
    } catch { /* skip inaccessible scope */ }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const lines: string[] = [
    `id:          ${entry.id}`,
    `type:        ${entry.type}`,
    `version:     ${entry.version ?? '-'}`,
    `title:       ${entry.title}`,
    `description: ${entry.description}`,
    `source:      ${entry.source}`,
    `checksum:    ${entry.checksum}`,
    `host:        ${entry.compatibility?.host ?? '—'}`,
  ];

  if (entry.requires !== undefined) {
    const reqs = Object.entries(entry.requires)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    lines.push(`requires:    ${reqs}`);
  }

  if (Array.isArray(entry.members) && entry.members.length > 0) {
    // ADR-0003: members are referenced by id only.
    const memberStr = entry.members
      .map((m: { id: string }) => m.id)
      .join(', ');
    lines.push(`members:     ${memberStr}`);
  }

  // P6 scope provenance block — always emitted (even if empty, to make "not installed" explicit)
  if (installedIn.length > 0) {
    lines.push(`installed-in:`);
    for (const p of installedIn) {
      const runStr = p.running ? `RUNNING pid=${String(p.pid)}` : 'stopped';
      lines.push(`  scope=${p.scope}  status=${runStr}  source=${p.source}  resolved_at=${p.resolved_at}`);
    }
  } else {
    lines.push(`installed-in: (not installed in any scope)`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

// ─── start ────────────────────────────────────────────────────────────────────

async function cmdStart(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} start: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const configPath = flags['config'] ?? scopePaths.config;

  // ── --list: show what's in the lockfile (startable extensions) ───────────
  if (flags['list'] !== undefined) {
    const fsMod0 = require('node:fs') as typeof import('node:fs');
    const rtp0 =
      flags['runtime-file'] ??
      process.env['SOX_RUNTIME_FILE'] ??
      getRuntimeFilePath(lockfilePath);

    // Read lockfile for what's available.
    const lockfile = loadLockfile(lockfilePath);
    if (!lockfile || Object.keys(lockfile.resolved ?? {}).length === 0) {
      process.stdout.write(`${CLI} start: no extensions in lockfile at ${lockfilePath}\n`);
      process.stdout.write(`Run '${CLI} install <ext> -s ${scope}' to install an extension.\n`);
      process.exit(0);
    }

    // Read runtime record for current status.
    let runningSet = new Set<string>();
    if (fsMod0.existsSync(rtp0)) {
      try {
        const rec0 = JSON.parse(fsMod0.readFileSync(rtp0, 'utf8')) as {
          entries?: Array<{ id: string; running?: boolean }>;
        };
        for (const e of rec0.entries ?? []) {
          if (e.running) runningSet.add(e.id);
        }
      } catch { /* ignore */ }
    }

    // Read config for enabled flags.
    const cfg0 = loadConfig(configPath);
    const enabledMap = new Map<string, boolean>();
    for (const e of (cfg0?.install ?? []) as Array<{ id: string; enabled?: boolean }>) {
      enabledMap.set(e.id, e.enabled !== false);
    }

    process.stdout.write(`\nExtensions available to start  (scope: ${scope})\n\n`);
    process.stdout.write(
      `  ${'EXTENSION'.padEnd(22)} ${'VERSION'.padEnd(9)} ${'STATUS'.padEnd(10)} ENABLED\n`,
    );
    process.stdout.write(`  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(7)}\n`);
    for (const [key, entry] of Object.entries(lockfile.resolved ?? {})) {
      const baseId = key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key;
      const ver = key.includes('@')
        ? key.slice(key.lastIndexOf('@') + 1)
        : ((entry as { version?: string }).version ?? '?');
      const running = runningSet.has(baseId);
      const enabled = enabledMap.get(baseId) ?? true;
      const status = running ? 'RUNNING' : 'STOPPED';
      const enabledStr = enabled ? 'yes' : 'no (disabled)';
      process.stdout.write(
        `  ${baseId.padEnd(22)} ${ver.padEnd(9)} ${status.padEnd(10)} ${enabledStr}\n`,
      );
    }
    process.stdout.write('\n');
    process.stdout.write(
      `Run '${CLI} start -s ${scope}' to start all extensions.\n` +
      `Run '${CLI} exec --list -s ${scope}' to see available tools once running.\n\n`,
    );
    process.exit(0);
  }

  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  // ── BL-31: pre-spawn dedup guard — never end up with two daemons ─────────────
  // Before starting, reap any live/orphaned instance of the extension(s) we are
  // about to spawn. The incident was: `soxe stop` left an orphaned daemon alive,
  // then `soxe start` spawned a SECOND one. By reaping by identity here, a stale
  // detached instance (even PPID-1, even absent from runtime.json) is killed
  // before we spawn, so a start can never duplicate a daemon. Opt out with
  // --no-reap (e.g. to deliberately run alongside, which we never want here).
  if (flags['no-reap'] === undefined && flags['_daemon-child'] === undefined) {
    const startId = flags['_'] ?? flags['id'];
    const lock0 = loadLockfile(lockfilePath);
    const reapIds: string[] = startId
      ? [startId]
      : Object.keys(lock0?.resolved ?? {}).map((k) =>
        k.includes('@') ? k.slice(0, k.lastIndexOf('@')) : k,
      );
    // Exclude the current live supervisor's own children — if a healthy
    // supervisor is already running these, killAndVerify-by-identity would be
    // disruptive. We only reap when there is NO live supervisor for this scope.
    const rec0 = getRuntimeRecord(runtimeFilePath);
    const supLive = typeof rec0?.supervisorPid === 'number' && pidAliveRT(rec0.supervisorPid);
    if (!supLive) {
      // [inv:unload-then-reap] (§8.4): unload the OS units of the ids we are
      // ABOUT TO REAP, so the OS supervisor does NOT immediately respawn the
      // pid we kill (the F3 resurrection loop). Scoped to reapIds — BL-203:
      // an unscoped unload here booted unrelated units (doctor-tick).
      unloadOwnedOsUnitsBeforeReap({
        root,
        onlyIds: reapIds,
        log: (m) => process.stdout.write(`sox: ${m}\n`),
      });
      for (const rid of reapIds) {
        const reap = await reapOrphansForExtension(rid, {
          runtimeFilePath,
          lockfilePath,
          log: (m) => process.stdout.write(`sox: pre-start reap ${rid}: ${m}\n`),
        });
        for (const k of reap.killed) {
          process.stdout.write(
            `sox: pre-start reaped stale ${rid} pid=${k.pid}` +
            `${k.orphaned ? ' (orphan, PPID 1)' : ''} → ${k.outcome}\n`,
          );
        }
      }
    }
  }

  // ── R8: daemon mode ──────────────────────────────────────────────────────────
  // When --daemon is passed (and --_daemon-child is NOT), re-spawn ourselves
  // detached with stdio redirected to a log file, print the background PID and
  // log path, then exit 0.  The child runs with --_daemon-child which skips
  // this branch.
  //
  // Spec: IMPLEMENTATION.md Section 5 (R8)
  if (flags['daemon'] !== undefined && flags['_daemon-child'] === undefined) {
    const fsDaemon = require('node:fs') as typeof import('node:fs');
    const pathDaemon = require('node:path') as typeof import('node:path');
    const { spawn: spawnDaemon } = require('node:child_process') as typeof import('node:child_process');

    const supervisorIdDaemon = computeSupervisorId(scope, root);
    // ADR-0004 §D2: supervisor logs under the user data root's run/logs/.
    const logDirDaemon = logDirFor(supervisorIdDaemon);
    fsDaemon.mkdirSync(logDirDaemon, { recursive: true });

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logPathDaemon = pathDaemon.join(logDirDaemon, `supervisor-${today}.log`);
    const logFd = fsDaemon.openSync(logPathDaemon, 'a');

    const selectIdDaemon = flags['id'];
    const childArgs = [
      '--enable-source-maps',
      process.argv[1] as string,
      'start',
      `--scope=${scope}`,
      `--root=${root}`,
      '--_daemon-child',
      ...(selectIdDaemon !== undefined ? [`--id=${selectIdDaemon}`] : []),
    ];

    const child = spawnDaemon(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fsDaemon.closeSync(logFd);

    process.stdout.write(
      `[sox] Supervisor started in background.\n` +
      `  PID:     ${String(child.pid)}\n` +
      `  Logs:    ${logPathDaemon}\n` +
      `  Follow:  ${CLI} logs --id=<ext> --follow\n`,
    );
    process.exit(0);
  }

  // ── [dod.5] Service-registry path ──────────────────────────────────────────
  // When soxe install --profile service was used, services are recorded in
  // <root>/.sox/registry.json (written by run-service.ts), NOT in the lockfile.
  // We spawn each service as a detached background process, write the runtime
  // record, then EXIT 0 — the service keeps running independently.
  // This path is taken when registry.json exists and has ≥1 entry.
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const { spawn: spawnChild } = require('node:child_process') as typeof import('node:child_process');

  const serviceRegistryPath = pathMod.join(root, '.sox', 'registry.json');
  if (fsMod.existsSync(serviceRegistryPath)) {
    let serviceRegistry: Record<string, {
      id: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      storePath: string;
      status: string;
    }> = {};
    try {
      serviceRegistry = JSON.parse(fsMod.readFileSync(serviceRegistryPath, 'utf8')) as typeof serviceRegistry;
    } catch {
      // malformed — treat as empty
    }

    const entries = Object.values(serviceRegistry);
    if (entries.length > 0) {
      const now = new Date().toISOString();
      const runtimeEntries: RuntimeEntry[] = [];

      for (const svc of entries) {
        const svcConfigEnv = buildExtConfigEnv(svc.id, root);

        // BL-36: resolve the extension's REAL manifest type from the store's
        // extension.json so the runtime entry records 'service' vs 'mcp-server'
        // correctly. The registry.json written by run-service.ts does not carry
        // the manifest type field; the store dir always has extension.json
        // post-install (the install engine copies it there). Fall back to 'service'
        // rather than 'mcp-server' when the manifest is unreadable — a service is
        // what this code path exclusively registers.
        const source = `file://${svc.storePath}`;
        const svcManifestType = manifestTypeForSource(source) ?? 'service';

        // ── Singleton guard (spec §5.2: socket probe + entrypoint scan +
        //    cross-scope ownership check), keyed on [def:singleton-key] =
        //    (id, resolved-store-resource), NOT on scope or socket alone.
        //
        // The invariant protected is ONE WRITER PER BACKING STORE. Slice 1
        // closes the genuinely-open half of BL-50 (F1/F7): a second scope that
        // overrides sock_path but shares db_path used to slip past the
        // socket-only guard and produce two writers.
        const svcResource = resolveStoreResourceForScope(svc.id, svc.storePath, scope, root);
        const svcKey = singletonKey(svc.id, svcResource);
        const entrypointToken = entrypointTokenForService(svc);
        const recordExisting = (note: string): void => {
          process.stdout.write(`sox: ${svc.id} ${note} — skipping spawn (singleton guard §5.2)\n`);
          runtimeEntries.push({
            key: svc.id, id: svc.id, type: svcManifestType, scope, source,
            pid: null, running: true, activatedAt: now,
          });
        };

        // §5.2 step 4: a duplicate already-live PAIR for this key ⇒ heal it
        // (kill the loser deterministically), never reap a single healthy daemon.
        // Exclude our own pid; the survivor we keep is then the live instance.
        if (svcKey && entrypointToken) {
          const heal = await healSingletonDuplicates({
            key: svcKey,
            entrypointToken,
            excludePids: [process.pid],
            graceMs: 5000,
            log: (m) => process.stdout.write(`sox: ${m}\n`),
          });
          if (heal.found.length >= 1) {
            recordExisting(
              `already live (entrypoint scan: pid=${heal.survivor}` +
              `${heal.killed.length ? `, healed ${heal.killed.length} duplicate(s)` : ''})`,
            );
            continue;
          }
        }

        // §5.2 step 4: cross-scope collision — another scope's install resolves
        // the SAME store-resource and has a live instance ⇒ reuse, don't spawn.
        if (svcResource.kind !== 'none') {
          const others = collectCrossScopeResources(svc.id, root, scope);
          const sharers = findCrossScopeSharers(scope, svcResource, others);
          if (sharers.length > 0 && entrypointToken) {
            const live = findOrphansByIdentity(entrypointToken, { excludePids: [process.pid] });
            if (live.length > 0) {
              recordExisting(
                `shares store ${svcResource.kind}:${svcResource.value} with scope(s) ` +
                `${sharers.join(', ')} (live pid=${live[0]!.pid})`,
              );
              continue;
            }
          }
        }

        // §5.2 step 2: socket probe — refuse a second instance already live on
        // the declared health socket (BL-50 original guard, retained).
        const healthSockPath = resolveServiceHealthSocketPath(svc.storePath, svcConfigEnv);
        if (healthSockPath) {
          const alreadyLive = await probeUnixSocketLive(healthSockPath, 500);
          if (alreadyLive) {
            recordExisting(`health socket is already live at ${healthSockPath}`);
            continue;
          }
        }

        // Spawn detached: parent exits, child keeps running independently.
        const child = spawnChild(svc.command, svc.args, {
          detached: true,
          stdio: 'ignore',
          cwd: svc.cwd,
          // svcConfigEnv first so explicit svc.env overrides (then process.env last so
          // sox-set values take precedence over inherited shell environment).
          env: { ...process.env, ...svcConfigEnv, ...(svc.env ?? {}) },
        });
        child.unref();

        const pid = child.pid ?? null;
        // source points to the store dir so soxe exec can find extension.json there.
        // (source and svcManifestType are resolved from extension.json above — BL-36)
        runtimeEntries.push({
          key: svc.id,
          id: svc.id,
          type: svcManifestType,
          scope,
          source,
          pid,
          running: pid !== null,
          activatedAt: now,
        });

        process.stdout.write(
          `sox: started service ${svc.id} (pid=${String(pid)}) cwd=${svc.cwd}\n`,
        );
      }

      // Write runtime record so soxe exec can find the entries.
      const record: RuntimeRecord = {
        version: 1,
        scope,
        startedAt: now,
        entries: runtimeEntries,
        supervisorPid: process.pid,
      };
      const runtimeDir = pathMod.dirname(runtimeFilePath);
      if (!fsMod.existsSync(runtimeDir)) fsMod.mkdirSync(runtimeDir, { recursive: true });
      fsMod.writeFileSync(runtimeFilePath, JSON.stringify(record, null, 2) + '\n', 'utf8');

      process.stdout.write(
        `sox: runtime started (service mode) — ${runtimeEntries.length} service(s) spawned\n`,
      );
      process.exit(0);
    }
  }

  // ── Lockfile path (existing supervisor mode) ────────────────────────────────
  // --id: selective start — filter lockfile entries to a single extension id.
  const selectId = flags['id'];

  // Log file: supervisor stdout/stderr currently goes to the terminal (no log file in this mode).
  // Print the runtime record path so users can see where state is persisted.
  process.stdout.write(
    `sox: starting runtime (scope: ${scope})...\n` +
    `  runtime record : ${runtimeFilePath}\n` +
    (selectId !== undefined ? `  extension filter: ${selectId}\n` : ''),
  );

  try {
    const record = await startRuntime({
      scope,
      lockfilePath,
      configPath,
      runtimeFilePath,
      root,
      // overrideHealthToStdioPing omitted — runtime.ts default (false) applies.
      // Explicit true here caused every extension to appear as healthy via a
      // stdio ping even when the extension declared its own health check.
      ...(selectId !== undefined ? { filterIds: [selectId] } : {}),
    });

    const runningCount = record.entries.filter((e) => e.running).length;
    process.stdout.write(
      `sox: runtime started — ${record.entries.length} extension(s) activated, ${runningCount} running\n` +
      `  logs           : (attached to this terminal — use Ctrl+C or '${CLI} stop' to shut down)\n`,
    );

    process.on('SIGTERM', () => {
      void (async () => {
        await stopRuntime({ scope, runtimeFilePath });
        process.exit(0);
      })();
    });
    process.on('SIGINT', () => {
      void (async () => {
        await stopRuntime({ scope, runtimeFilePath });
        process.exit(0);
      })();
    });
    process.on('SIGHUP', () => {
      void reconcileRuntime(runtimeFilePath, configPath);
    });

    // Keep alive
    setInterval(() => {
      /* heartbeat */
    }, 5000);
  } catch (e) {
    process.stderr.write(`${CLI} start: failed — ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── stop ─────────────────────────────────────────────────────────────────────

/**
 * Reap UNTRACKED proxy backends (§9.5 + spec §8 [contract:signal]).
 *
 * An mcp-server served in proxy mode (the DEFAULT, Slice 1.6) is fronted by a thin
 * stdio shim; the tool implementation lives in a persistent, detached, sox-owned
 * BACKEND that the shim auto-spawns via `ensureBackend`. That backend is NOT created
 * by `soxe start`, so it appears in NO runtime.json entry — the entry-driven reap in
 * `cmdStop` never touches it and it survives `soxe stop`, re-introducing the BL-31/
 * BL-50 orphan leak (a detached backend whose every spawning shim has exited).
 *
 * This reaper closes that hole independent of tracking or scope: it enumerates every
 * installed mcp-server from the lockfile (the source of truth for "what could have an
 * auto-spawned backend"), and for each one served in proxy mode it reaps any live
 * process matching the backend's entrypoint IDENTITY TOKEN — the exact token
 * `ensureBackend` puts in the backend's argv (`node --enable-source-maps <entrypoint>`,
 * BL-31 reaper-compatible). The supervisor pid is excluded so a tracked direct-stdio
 * server signalled elsewhere is never double-killed here.
 *
 * Scope note: the backend identity is the entrypoint PATH, which is stable across
 * scopes for a given install — so reaping by identity catches a backend whose serve
 * resolved a DIFFERENT scope than the stop target (the suspected scope-mismatch leak).
 * We honor [contract:signal] verified-stop via reapByIdentity → killAndVerify.
 *
 * Returns the per-extension reap results so the caller can report + detect undead.
 */
async function reapUntrackedProxyBackends(opts: {
  lockfilePath: string;
  root: string;
  excludePids: number[];
  graceMs: number;
  onlyId?: string | undefined;
  log: (m: string) => void;
}): Promise<{ killedAny: boolean; undead: boolean }> {
  let killedAny = false;
  let undead = false;

  const lock = loadLockfile(opts.lockfilePath);
  if (!lock?.resolved) return { killedAny, undead };

  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');

  // Map each installed extension id → its resolved source (entrypoint identity).
  // Lockfile keys are `id` or `id@version`; collapse to the base id.
  const seen = new Set<string>();
  for (const [lockKey, lkEntry] of Object.entries(lock.resolved)) {
    const baseId = lockKey.includes('@') ? lockKey.slice(0, lockKey.indexOf('@')) : lockKey;
    if (opts.onlyId !== undefined && baseId !== opts.onlyId) continue;
    if (seen.has(baseId)) continue;
    seen.add(baseId);

    const source = (lkEntry as { source?: string }).source;
    if (!source) continue;

    // Read the manifest from THIS lockfile's source (not a re-derived scope lockfile)
    // so an explicit --lockfile is honored — resolveServeManifest re-derives via
    // getScopePaths and would miss a custom lockfile path. Only proxy-mode mcp-servers
    // can have an auto-spawned untracked backend.
    const extDir = resolveExtensionDir(source, opts.root);
    if (!extDir) continue;
    const manifestPath = pathM.join(extDir, 'extension.json');
    if (!fsM.existsSync(manifestPath)) continue;
    let manifest: { type?: string; lifecycle?: { proxy?: boolean; serve_mode?: string } };
    try {
      manifest = JSON.parse(fsM.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const lc = manifest.lifecycle ?? {};
    const forced = lc.proxy === true || lc.serve_mode === 'proxy';
    const optedOut = lc.proxy === false || lc.serve_mode === 'direct';
    const isProxy = forced || (manifest.type === 'mcp-server' && !optedOut);
    if (!isProxy) continue;

    const token = identityToken(source);
    if (!token) continue;

    // Reap every live backend matching the entrypoint identity (verified-stop).
    const reap = await reapByIdentity(token, {
      excludePids: opts.excludePids,
      graceMs: opts.graceMs,
      log: (m) => opts.log(`reap ${baseId} (proxy backend): ${m}`),
    });
    for (const k of reap.killed) {
      killedAny = true;
      opts.log(
        `reaped ${baseId} proxy backend pid=${k.pid}` +
        `${k.orphaned ? ' (orphan, PPID 1)' : ''} → ${k.outcome}`,
      );
      if (k.outcome === 'undead') undead = true;
    }
  }

  return { killedAny, undead };
}

/**
 * [inv:unload-then-reap] (§8.4/§8.5) for `soxe stop`: before the identity reap
 * runs, UNLOAD any OS unit (launchd/systemd) soxe owns for the target service(s),
 * so the OS supervisor will NOT immediately respawn the pid the reap is about to
 * kill (the F3 resurrection loop). The unit FILE is left in place (stop is not
 * disable — the unit persists for the next start/boot); only `soxe service disable`
 * / `soxe uninstall` remove it. Best-effort + scope-scanning: an os-unit may exist
 * in any scope's ownership index.
 */
function unloadOwnedOsUnitsBeforeReap(opts: {
  root: string;
  /**
   * BL-203: the ids whose processes the caller is ABOUT TO REAP. The
   * [inv:unload-then-reap] invariant only requires unloading units launchd
   * could use to resurrect a pid the reap will kill — an unscoped unload
   * additionally booted UNRELATED units (the doctor-tick, twice: 2026-07-04
   * post-upgrade and 2026-07-06 ~02:55 post-enable) that nothing reloaded.
   * Callers MUST pass exactly the reap target ids; there is deliberately no
   * unload-everything mode.
   */
  onlyIds: readonly string[];
  log: (m: string) => void;
}): void {
  if (opts.onlyIds.length === 0) return;
  const targetIds = new Set(opts.onlyIds);
  const pathM = require('node:path') as typeof import('node:path');
  for (const sc of ['org', 'user', 'project', 'local'] as const) {
    let dir: string;
    try {
      dir = dataRoot(sc as DataScope, opts.root);
    } catch {
      continue;
    }
    let own: OwnershipIndex;
    try {
      own = OwnershipIndex.loadFromFile(pathM.join(dir, 'ownership.json'));
    } catch {
      continue;
    }
    for (const rec of own.all()) {
      if (!targetIds.has(rec.extId)) continue;
      for (const e of rec.entries) {
        if (e.kind !== 'os-unit') continue;
        const platform = getOsUnitPlatform(e.supervisor);
        const unitDir = process.env['SOX_OS_UNIT_DIR'] ?? pathM.dirname(e.unitPath);
        if (!platform.isLoaded(e.label, realOsExec)) continue;
        // Unload only (removeFile:false) — stop ≠ disable.
        disableOsUnit(e.label, platform, {
          unitDir,
          removeFile: false,
          log: (m) => opts.log(`[unload-then-reap] ${m}`),
        });
      }
    }
  }
}

async function cmdStop(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;
  const id = flags['id'] ?? flags['_'];

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} stop: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  // ── --list: show what's currently running (stoppable) ────────────────────
  if (flags['list'] !== undefined) {
    const record0 = getRuntimeRecord(runtimeFilePath);
    if (!record0) {
      process.stdout.write(`${CLI} stop: no runtime running at scope '${scope}'.\n`);
      process.stdout.write(`Run '${CLI} start -s ${scope}' to start the runtime.\n`);
      process.exit(0);
    }
    const running = record0.entries.filter((e) => e.running);
    if (running.length === 0) {
      process.stdout.write(`${CLI} stop: no extensions currently running (scope: ${scope}).\n`);
      process.exit(0);
    }
    process.stdout.write(`\nRunning extensions you can stop  (scope: ${scope})\n\n`);
    process.stdout.write(
      `  ${'EXTENSION'.padEnd(22)} ${'PID'.padEnd(8)} STATUS\n`,
    );
    process.stdout.write(`  ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)}\n`);
    for (const e of running) {
      process.stdout.write(
        `  ${e.id.padEnd(22)} ${String(e.pid ?? '').padEnd(8)} RUNNING\n`,
      );
    }
    process.stdout.write('\n');
    process.stdout.write(
      `Run '${CLI} stop -s ${scope}' to stop all.\n` +
      `Run '${CLI} stop --id=<ext> -s ${scope}' to stop one extension.\n\n`,
    );
    process.exit(0);
  }

  // ── BL-31: configurable grace period for SIGTERM→SIGKILL escalation ──────────
  const graceMs = (() => {
    const raw = flags['grace-ms'] ?? process.env['SOX_STOP_GRACE_MS'];
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 5000;
  })();

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    // No runtime record — nothing was started via the supervisor. But an UNTRACKED
    // proxy backend (auto-spawned by a serve shim, §9.5) can still be alive with no
    // record at all; reap it by identity so `soxe stop` is a true teardown.
    process.stdout.write(`sox: no runtime record at ${runtimeFilePath}\n`);
    // [inv:unload-then-reap]: unload the targeted id's OS unit before reaping its
    // (untracked) pid. With no id, the only reap below is untracked proxy backends —
    // which have no OS units — so there is nothing to unload (BL-203: the former
    // unscoped unload here booted unrelated units; os-unit services are controlled
    // via `service disable`, not a bare `stop`).
    unloadOwnedOsUnitsBeforeReap({ root, onlyIds: id !== undefined ? [id] : [], log: (m) => process.stdout.write(`sox: ${m}\n`) });
    const proxyReap = await reapUntrackedProxyBackends({
      lockfilePath,
      root,
      excludePids: [],
      graceMs,
      ...(id !== undefined ? { onlyId: id } : {}),
      log: (m) => process.stdout.write(`sox: ${m}\n`),
    });
    if (proxyReap.killedAny) {
      process.stdout.write(proxyReap.undead ? `sox: stop INCOMPLETE — see warnings above\n` : `sox: stop complete\n`);
    }
    process.exit(proxyReap.undead ? 1 : 0);
  }

  // ── stop-via-supervisor: signal the supervisor process, then VERIFY it died.
  // The pre-BL-31 code signalled the supervisor and exited immediately — no
  // confirmation, no escalation, and (critically) no reaping of a daemon whose
  // supervisor had already exited (PPID-1 orphan). We now: signal the
  // supervisor, poll-verify its exit (escalating to SIGKILL), and THEN run the
  // identity-matched orphan reap so a detached daemon can never survive.
  if (id === undefined && typeof record.supervisorPid === 'number') {
    if (pidAliveRT(record.supervisorPid)) {
      process.stdout.write(
        `sox: signaling supervisor (pid=${record.supervisorPid}) to stop\n`,
      );
      const outcome = await killAndVerify(record.supervisorPid, {
        graceMs,
        group: false, // the supervisor's own shutdown signals its children's groups
        log: (m) => process.stdout.write(`sox: supervisor ${m}\n`),
      });
      if (outcome === 'undead') {
        process.stderr.write(
          `sox: WARNING — supervisor (pid=${record.supervisorPid}) could not be killed; reaping its children directly\n`,
        );
      }
    } else {
      process.stdout.write(
        `sox: supervisor (pid=${record.supervisorPid}) already gone\n`,
      );
    }
    // [inv:unload-then-reap] (§8.5): unload the OS units of the entries we are
    // about to reap, so the OS supervisor cannot resurrect those pids. Scoped to
    // the runtime record's entries — BL-203: the former unscoped unload here
    // booted unrelated units (doctor-tick) that nothing ever reloaded.
    unloadOwnedOsUnitsBeforeReap({
      root,
      onlyIds: (record.entries ?? []).map((e) => e.id),
      log: (m) => process.stdout.write(`sox: ${m}\n`),
    });
    // Whether or not the supervisor was alive, reap every extension's orphans by
    // identity. This catches a daemon whose supervisor died and left it detached.
    let undead = false;
    for (const entry of record.entries ?? []) {
      const reap = await reapOrphansForExtension(entry.id, {
        runtimeFilePath,
        lockfilePath,
        graceMs,
        log: (m) => process.stdout.write(`sox: reap ${entry.id}: ${m}\n`),
      });
      for (const k of reap.killed) {
        process.stdout.write(
          `sox: reaped ${entry.id} pid=${k.pid}` +
          `${k.orphaned ? ' (orphan, PPID 1)' : ''} → ${k.outcome}\n`,
        );
        if (k.outcome === 'undead') undead = true;
      }
    }
    // §9.5: also reap UNTRACKED proxy backends — auto-spawned by a serve shim, in
    // NO runtime entry, so the entry loop above never touches them. Identity-matched,
    // cross-scope, verified-stop. Excludes the supervisor pid (already handled).
    const proxyReap = await reapUntrackedProxyBackends({
      lockfilePath,
      root,
      excludePids: [record.supervisorPid],
      graceMs,
      log: (m) => process.stdout.write(`sox: ${m}\n`),
    });
    if (proxyReap.undead) undead = true;
    process.stdout.write(undead ? `sox: stop INCOMPLETE — see warnings above\n` : `sox: stop complete\n`);
    process.exit(undead ? 1 : 0);
  }

  // ── Non-supervisor path (per-id stop, or no supervisorPid recorded) ──────────
  // stopRuntime now verifies + escalates + reaps by identity internally.
  await stopRuntime({ scope, runtimeFilePath, id });

  // Belt-and-suspenders: if an id was targeted, run an explicit identity reap in
  // case the daemon was a detached orphan absent from runtime.json entirely.
  let undead = false;
  if (id !== undefined) {
    // [inv:unload-then-reap] (§8.5): unload this id's OS unit before reaping it.
    unloadOwnedOsUnitsBeforeReap({ root, onlyIds: [id], log: (m) => process.stdout.write(`sox: ${m}\n`) });
    const reap = await reapOrphansForExtension(id, {
      runtimeFilePath,
      lockfilePath,
      graceMs,
      log: (m) => process.stdout.write(`sox: reap ${id}: ${m}\n`),
    });
    for (const k of reap.killed) {
      process.stdout.write(
        `sox: reaped ${id} pid=${k.pid}${k.orphaned ? ' (orphan, PPID 1)' : ''} → ${k.outcome}\n`,
      );
      if (k.outcome === 'undead') undead = true;
    }
    // §9.5: also reap this id's UNTRACKED proxy backend (auto-spawned, no entry).
    const proxyReap = await reapUntrackedProxyBackends({
      lockfilePath,
      root,
      excludePids: typeof record.supervisorPid === 'number' ? [record.supervisorPid] : [],
      graceMs,
      onlyId: id,
      log: (m) => process.stdout.write(`sox: ${m}\n`),
    });
    if (proxyReap.undead) undead = true;
  }
  process.stdout.write(undead ? `sox: stop INCOMPLETE — see warnings above\n` : `sox: stop complete\n`);
  process.exit(undead ? 1 : 0);
}

// ─── service: OS-supervisor control surface (spec §9, Slice 2) ─────────────────

/**
 * Resolve the unit directory the OS supervisor reads. INJECTABLE for safe testing:
 *   --unit-dir <dir>  >  SOX_OS_UNIT_DIR env  >  platform default.
 * The platform default is ~/Library/LaunchAgents (launchd) / ~/.config/systemd/user
 * (systemd). Tests + e2e ALWAYS inject a sandbox so the real machine is untouched
 * (spec Appendix B item 3 — real activation needs a human node-path ack).
 */
function resolveOsUnitDir(flags: Record<string, string>, platform: OsUnitPlatform): string {
  return flags['unit-dir'] ?? process.env['SOX_OS_UNIT_DIR'] ?? platform.defaultUnitDir();
}

/**
 * Build the OS-unit EnvironmentVariables (§9.2) — the SAME minimal scrub allowlist
 * the supervisor uses (supervisor.ts §7 step 5) MERGED with the resolved
 * SOX_CONFIG_* cascade. Mirrored here so the OS-supervised process sees the exact
 * env the in-supervisor path would. [Never widen this silently — §13.2.5.]
 */
function buildOsUnitEnv(extId: string, root: string): Record<string, string> {
  // BL-344: was a hand-maintained allowlist; every new tunable had to be added
  // here AND in four other copies, and none ever were. `SOX_*` now forwards by
  // default (minus the host-authoritative `SOX_PERM_*`/`SOX_CONFIG_*`), so a
  // brake or a log control reaches the generated unit without an edit here.
  const env = scrubEnvReported('os-unit');
  Object.assign(env, buildExtConfigEnv(extId, root));
  return env;
}

/**
 * Resolve everything needed to render/enable an extension's OS unit at a scope:
 * the install dir + manifest, the absolute entrypoint, the resolved env, the
 * pinned node path (with volatility guard), the store/working dir, and the
 * artifact content-address (from the ownership index). Returns null when the
 * extension is not installed at that scope / has no manifest+entrypoint.
 */
function resolveOsUnitContext(
  extId: string,
  scope: string,
  root: string,
  flags: Record<string, string>,
): {
  platform: OsUnitPlatform;
  spec: ReturnType<typeof deriveOsUnitSpec>;
  extDir: string;
  entrypoint: string;
  nodeRes: ReturnType<typeof resolveUnitNodePath>;
  manifestType: string;
} | null {
  const pathM = require('node:path') as typeof import('node:path');
  const fsM = require('node:fs') as typeof import('node:fs');
  const resolved = resolveServeManifest(extId, scope, root);
  if (!resolved || !resolved.manifest.entrypoint) return null;
  const entrypoint = pathM.resolve(resolved.extDir, resolved.manifest.entrypoint);

  const platform = getOsUnitPlatform(
    (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
  );

  // Pinned node path (§9.2 / Appendix B item 3). --node-path overrides.
  const nodeRes = flags['node-path']
    ? { nodePath: flags['node-path'], volatile: false as const }
    : resolveUnitNodePath();

  // artifact content-address (ADR-0003) from the ownership index, if recorded.
  let artifactHash: string | undefined;
  try {
    const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
    artifactHash = own.get(extId, scope)?.artifactChecksum;
  } catch { /* best-effort */ }

  const manifestPath = pathM.join(resolved.extDir, 'extension.json');
  const env = buildOsUnitEnv(extId, root);
  const logDir = logDirFor(`os-${scope}-${extId}`);

  // BL-156: a proxy-mode mcp-server with a configured port must not run the bare
  // entrypoint (that is DIRECT-STDIO mode, which listens on nothing — the launchd
  // daemon would idle unreachable). Instead the unit runs the port-listening
  // front-shim `soxe serve <id> --port <port>`, which serves stdio+http+sse and
  // auto-ensures the singleton UDS backend. The BACKEND still runs `entrypoint`
  // (SOX_PROXY_BACKEND=1), so the reaper's identity token stays `entrypoint`.
  let execArgs: string[] | undefined;
  const port = env['SOX_CONFIG_PORT'];
  if (port && mcpServerIsProxyMode(extId, scope, root)) {
    // The CLI that is enabling this unit — run the SAME soxe for the shim so the
    // served code matches the resolved entrypoint (dev checkout vs installed CLI).
    let cliPath = process.argv[1] ?? '';
    try { cliPath = fsM.realpathSync(cliPath); } catch { /* keep as-is */ }
    if (cliPath) {
      execArgs = ['--enable-source-maps', cliPath, 'serve', extId, '--port', String(port)];
    }
  }

  const spec = deriveOsUnitSpec({
    id: extId,
    scope,
    manifestPath,
    nodePath: nodeRes.nodePath,
    entrypoint,
    ...(execArgs !== undefined ? { execArgs } : {}),
    env,
    workingDirectory: resolved.extDir,
    logDir,
    ...(artifactHash !== undefined ? { artifactHash } : {}),
  });
  // sanity: entrypoint must exist on disk
  if (!fsM.existsSync(entrypoint)) return null;
  return { platform, spec, extDir: resolved.extDir, entrypoint, nodeRes, manifestType: resolved.manifest.type ?? '' };
}

/**
 * `soxe service <enable|disable|status|list>` — the ONLY sanctioned way to create
 * or remove an OS unit ([inv:os-unit-generated], §9.1). Hand-authoring a plist is
 * forbidden. Reconciles the unit with soxe tracking ([inv:list-never-lies]) and
 * tears down via unload-then-reap ([inv:unload-then-reap], §8.5).
 */
async function cmdService(argvIn: string[], flags: Record<string, string>): Promise<void> {
  const sub = argvIn[1];
  if (sub === undefined || flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} service — OS-supervisor control (launchd / systemd)

Usage:
  ${CLI} service enable  <ext> [-s <scope>]   Generate + load an OS unit (reboot persistence)
  ${CLI} service disable <ext> [-s <scope>]   Unload + remove the unit; reap any survivor
  ${CLI} service restart <ext> [-s <scope>]   Deploy the on-disk bundle to the RUNNING process
  ${CLI} service status  <ext> [-s <scope>]   Show the unit state reconciled with sox
  ${CLI} service list                          All sox-owned OS units across scopes

Options:
  -s, --scope <scope>     Scope: org | user | project | local  (default: user)
  --dry-run               enable: render + write the unit but do NOT load it (no launchctl)
  --unit-dir <dir>        Override the unit directory (also SOX_OS_UNIT_DIR) — for testing
  --supervisor <kind>     Force 'launchd' or 'systemd' (default: per-platform)
  --node-path <path>      Override the pinned node binary baked into the unit
  --allow-volatile-node   Proceed even if the pinned node is under nvm/asdf/volta
  --unset <key>[,<key>]   enable: acknowledge dropping previously-set shell-sourced env
                          key(s) that this invocation's shell no longer exports
                          (BL-375 [inv:env-preserved-on-regenerate]) — named keys only,
                          no blanket bypass
  --wait-ms <ms>          restart: how long to wait for the pid to rotate (default 15000)
  --help                  Show this message

'service restart' is BL-372 / spec §9.4a's [inv:deploy-verified]: it kickstarts the
managed process WITHOUT rewriting the unit file (never touches env — see BL-375), then
reaps any survivor by identity so a zero-downtime proxy-mode backend (§9.5) that
kickstart alone leaves running the OLD bundle is forced to respawn on the NEW one.
It exits non-zero if the pid did not actually rotate — a green kickstart exit code is
NOT evidence of a deploy.

OS units are GENERATED from the manifest; hand-editing them is unsupported.
`);
    process.exit(sub === undefined ? 1 : 0);
  }

  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? process.cwd();
  const graceMs = (() => {
    const raw = flags['grace-ms'] ?? process.env['SOX_STOP_GRACE_MS'];
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 5000;
  })();

  if (sub === 'list') {
    await cmdServiceList(flags);
    return;
  }

  const extId = argvIn[2] ?? flags['id'];
  if (!extId) {
    process.stderr.write(`${CLI} service ${sub}: extension id required\n`);
    process.exit(1);
  }

  if (sub === 'enable') {
    const ctx = resolveOsUnitContext(extId, scope, root, flags);
    if (!ctx) {
      process.stderr.write(`${CLI} service enable: '${extId}' not installed at scope '${scope}', or no entrypoint\n`);
      process.exit(1);
    }
    const dryRun = flags['dry-run'] !== undefined;

    // §9.2 / Appendix B item 3 — node-path human ack for a VOLATILE node.
    if (ctx.nodeRes.volatile) {
      process.stderr.write(`${CLI} service enable: WARNING — ${ctx.nodeRes.volatileReason}\n`);
      if (ctx.nodeRes.preferredNonVolatile) {
        process.stderr.write(
          `  A non-volatile node is available at ${ctx.nodeRes.preferredNonVolatile}; ` +
          `re-run with --node-path=${ctx.nodeRes.preferredNonVolatile} to pin it.\n`,
        );
      }
      if (flags['allow-volatile-node'] === undefined) {
        process.stderr.write(
          `  Refusing to pin a volatile node. Re-run with --allow-volatile-node to proceed anyway, ` +
          `or --node-path=<stable node>.\n`,
        );
        process.exit(1);
      }
    }

    const platform = ctx.platform;
    const unitDir = resolveOsUnitDir(flags, platform);
    const unsetKeys = (flags['unset'] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const result = enableOsUnit(ctx.spec, platform, {
      unitDir,
      load: !dryRun,
      log: (m) => process.stdout.write(`sox: ${m}\n`),
      unsetKeys,
    });

    // BL-375: a BLOCKED regeneration writes NOTHING — the enableOsUnit call
    // already logged the detailed BLOCKED message (dropped key list, how to
    // proceed) via the injected `log` callback above. Print nothing further
    // and exit non-zero; this is not a success path.
    if (result.action === 'blocked') {
      process.exit(1);
    }

    // Record the os-unit in the ownership index ([inv:reversible-injection], §9.4)
    // so uninstall/disable can reverse it and `service list`/`doctor` enumerate it.
    try {
      const pathM = require('node:path') as typeof import('node:path');
      const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
      own.addEntries(extId, scope, [{
        kind: 'os-unit',
        label: ctx.spec.label,
        unitPath: result.unitPath,
        supervisor: platform.kind,
        appliedHash: result.contentHash,
      }]);
      own.save();
    } catch (e) {
      process.stderr.write(`sox: warning: could not record os-unit ownership: ${String(e)}\n`);
    }

    process.stdout.write(
      `${CLI} service enable: ${result.action} ${platform.kind} unit '${ctx.spec.label}'\n` +
      `  unit:       ${result.unitPath}\n` +
      `  node:       ${ctx.spec.nodePath}\n` +
      `  entrypoint: ${ctx.entrypoint}\n` +
      `  content:    ${result.contentHash}\n` +
      (dryRun
        ? `  (--dry-run: unit written but NOT loaded — no ${platform.kind === 'launchd' ? 'launchctl' : 'systemctl'} call)\n`
        : `  loaded:     ${result.loaded ? 'yes' : 'NO (load failed — see warnings)'}\n`),
    );
    process.exit(!dryRun && !result.loaded ? 1 : 0);
  }

  if (sub === 'disable') {
    const ctx = resolveOsUnitContext(extId, scope, root, flags);
    const platform = ctx?.platform ?? getOsUnitPlatform(
      (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
    );
    const unitDir = resolveOsUnitDir(flags, platform);
    const label = ctx?.spec.label ?? osUnitLabel(scope, extId);
    // Resolve the entrypoint identity token from the ownership/lockfile even if the
    // install is gone — fall back to a best-effort path.
    const entrypoint = ctx?.entrypoint ?? '';

    // [inv:unload-then-reap] (§8.5): unload the unit FIRST, THEN reap any survivor.
    let undead = false;
    if (entrypoint) {
      const res = await unloadThenReap({
        label,
        entrypoint,
        platform,
        unitDir,
        excludePids: [process.pid],
        graceMs,
        log: (m) => process.stdout.write(`sox: ${m}\n`),
      });
      undead = res.undead;
    } else {
      // No entrypoint resolvable — just unload + remove the unit file.
      disableOsUnit(label, platform, { unitDir, log: (m) => process.stdout.write(`sox: ${m}\n`) });
    }
    // Remove the unit FILE + clear the ownership os-unit entry.
    disableOsUnit(label, platform, { unitDir, log: (m) => process.stdout.write(`sox: ${m}\n`) });
    try {
      const pathM = require('node:path') as typeof import('node:path');
      const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
      const rec = own.get(extId, scope);
      if (rec) {
        const kept = rec.entries.filter((e) => e.kind !== 'os-unit');
        own.record({ extId, scope, entries: kept, ...(rec.host !== undefined ? { host: rec.host } : {}) });
        own.save();
      }
    } catch { /* best-effort */ }

    process.stdout.write(
      undead
        ? `${CLI} service disable: INCOMPLETE — a survivor could not be confirmed dead (undead)\n`
        : `${CLI} service disable: '${label}' unloaded + removed\n`,
    );
    process.exit(undead ? 1 : 0);
  }

  if (sub === 'restart') {
    await cmdServiceRestart(extId, scope, root, flags);
    return;
  }

  if (sub === 'status') {
    const ctx = resolveOsUnitContext(extId, scope, root, flags);
    const platform = ctx?.platform ?? getOsUnitPlatform(
      (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
    );
    const unitDir = resolveOsUnitDir(flags, platform);
    const label = ctx?.spec.label ?? osUnitLabel(scope, extId);
    const fsM = require('node:fs') as typeof import('node:fs');
    const pathM = require('node:path') as typeof import('node:path');
    const unitPath = pathM.join(unitDir, platform.unitFileName(label));
    const fileExists = fsM.existsSync(unitPath);
    const loaded = platform.isLoaded(label, realOsExec);
    // Reality-verified liveness ([inv:list-never-lies], §10.3): the OS unit owns it
    // only if the entrypoint process is actually live.
    let livePids: number[] = [];
    if (ctx?.entrypoint) {
      livePids = findOrphansByIdentity(identityToken(`file://${ctx.entrypoint}`), { excludePids: [process.pid] })
        .map((m) => m.pid);
    }
    const owner = loaded ? 'os-unit' : (livePids.length > 0 ? 'none' : 'none');
    // BL-393: a doctor-reconcile singleton-violation heal silently SIGTERMs a
    // duplicate backend — surface the last such heal loudly instead of leaving
    // it buried in run/logs/doctor-reconcile/*.log. Not an error by itself (the
    // heal is correct self-healing behavior); it IS a rotation the operator did
    // not initiate and needs to know happened.
    const healMarker = readSingletonHealMarker(extId, scope);
    process.stdout.write(
      `${CLI} service status: ${label} (scope ${scope}, ${platform.kind})\n` +
      `  unit file:  ${fileExists ? unitPath : '(none)'}\n` +
      `  loaded:     ${loaded ? 'yes' : 'no'}\n` +
      `  owner:      ${owner}\n` +
      `  live pids:  ${livePids.length ? livePids.join(', ') : '(none)'}\n` +
      (ctx ? `  entrypoint: ${ctx.entrypoint}\n` : '') +
      (ctx?.spec.artifactHash ? `  artifact:   ${ctx.spec.artifactHash}\n` : '') +
      (healMarker
        ? `  ⚠ silent respawn (BL-393): doctor-reconcile SIGTERM'd a duplicate backend ` +
          `at ${healMarker.healedAt} (killed pid ${healMarker.killedPid}, survivor pid ` +
          `${healMarker.survivorPid} → ${healMarker.outcome}) — nobody chose this restart; ` +
          `verify the running artifact still matches what was reviewed.\n`
        : ''),
    );
    process.exit(0);
  }

  process.stderr.write(`${CLI} service: unknown subcommand '${sub}' (enable|disable|restart|status|list)\n`);
  process.exit(1);
}

/**
 * `soxe service restart <ext>` — BL-372 / docs/spec/service-lifecycle.md §9.4a
 * `[inv:deploy-verified]`: deploy a rebuilt bundle to the RUNNING process.
 *
 * `launchctl kickstart -k` / `systemctl restart` alone is NOT a deploy for a
 * proxy-mode (§9.5) mcp-server: the front-shim keeps its backend alive across
 * proxy restarts for zero-downtime, so the backend survives a bare kickstart as
 * a `PPID 1` orphan still executing the OLD bundle — measured twice on
 * 2026-07-31. This verb:
 *
 *   1. snapshots the pids CURRENTLY matching the extension's identity token
 *      (the entrypoint path — the front-shim runs `soxe serve`, but the
 *      backend it spawns always execs `entrypoint` directly, so the token
 *      catches the backend even in proxy mode; for a direct-mode service the
 *      token IS the managed process itself).
 *   2. kickstarts the unit — restarts the managed process WITHOUT touching the
 *      unit file (no `enable`, no env regeneration — BL-375).
 *   3. reaps any survivor matching that token by identity (`reapByIdentity` /
 *      `killAndVerify`) — this is what forces a proxy-mode backend to die, which
 *      makes the already-kickstarted proxy's live backend connection notice the
 *      disconnect and respawn a NEW backend on the current bundle.
 *   4. polls until a pid NOT in the pre-restart snapshot appears for that token.
 *   5. exits NON-ZERO if no such pid appears within `--wait-ms` (default 15s) —
 *      a kickstart that exited 0 and a unit that shows loaded are NOT evidence
 *      the code changed; only a rotated pid is.
 */
async function cmdServiceRestart(
  extId: string,
  scope: string,
  root: string,
  flags: Record<string, string>,
): Promise<void> {
  const pathM = require('node:path') as typeof import('node:path');
  const fsM = require('node:fs') as typeof import('node:fs');

  const ctx = resolveOsUnitContext(extId, scope, root, flags);
  if (!ctx) {
    process.stderr.write(
      `${CLI} service restart: '${extId}' not installed at scope '${scope}', or no entrypoint\n`,
    );
    process.exit(1);
  }

  const { platform, entrypoint } = ctx;
  const label = ctx.spec.label;
  const unitDir = resolveOsUnitDir(flags, platform);
  const unitPath = pathM.join(unitDir, platform.unitFileName(label));

  if (!fsM.existsSync(unitPath)) {
    process.stderr.write(
      `${CLI} service restart: no unit file for '${label}' at ${unitPath} — run \`${CLI} service enable ${extId}\` first\n`,
    );
    process.exit(1);
  }
  if (!platform.isLoaded(label, realOsExec)) {
    process.stderr.write(
      `${CLI} service restart: '${label}' is not loaded — run \`${CLI} service enable ${extId}\` first\n`,
    );
    process.exit(1);
  }

  const waitMsRaw = flags['wait-ms'] ?? process.env['SOX_SERVICE_RESTART_WAIT_MS'];
  const waitMsParsed = waitMsRaw !== undefined ? Number(waitMsRaw) : NaN;
  const waitMs = Number.isFinite(waitMsParsed) && waitMsParsed >= 0 ? waitMsParsed : 15000;

  const token = identityToken(entrypoint);
  const beforeMainPid = platform.mainPid(label, realOsExec);
  process.stdout.write(`${CLI} service restart: ${label}\n  before: main=${beforeMainPid ?? '(none)'}\n`);

  // [inv:deploy-verified] (BL-372, §9.4a) — kickstart, reap any survivor by
  // identity, and refuse to report success unless a pid actually rotated.
  const result = await restartAndVerify({
    label,
    token,
    platform,
    exec: realOsExec,
    waitMs,
    excludePids: [process.pid],
    log: (m: string) => process.stdout.write(`  ${m}\n`),
  });

  const afterMainPid = platform.mainPid(label, realOsExec);
  process.stdout.write(`  after:  main=${afterMainPid ?? '(none)'}\n`);

  if (!result.ok) {
    process.stderr.write(
      `${CLI} service restart: FAILED — ${result.reason ?? 'deploy could not be verified'}. ` +
      `See docs/spec/service-lifecycle.md §9.4a.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `${CLI} service restart: '${label}' deployed — pid(s) rotated ` +
    `([${result.before.join(', ') || '(none)'}] -> [${result.after.join(', ')}])\n`,
  );
  process.exit(0);
}

/**
 * `soxe service list` — enumerate every sox-owned OS unit across all scopes from
 * the ownership index, reconciled with the OS supervisor's loaded state
 * ([inv:list-never-lies]).
 */
async function cmdServiceList(flags: Record<string, string>): Promise<void> {
  const pathM = require('node:path') as typeof import('node:path');
  const root = flags['root'] ?? process.cwd();

  type Row = { id: string; scope: string; label: string; supervisor: string; loaded: boolean; unitPath: string; appliedHash: string };
  const rows: Row[] = [];
  for (const sc of ['org', 'user', 'project', 'local'] as const) {
    let dir: string;
    try {
      dir = dataRoot(sc as DataScope, root);
    } catch {
      continue;
    }
    const ownPath = pathM.join(dir, 'ownership.json');
    let own: OwnershipIndex;
    try {
      own = OwnershipIndex.loadFromFile(ownPath);
    } catch {
      continue;
    }
    for (const rec of own.all()) {
      for (const e of rec.entries) {
        if (e.kind !== 'os-unit') continue;
        const platform = getOsUnitPlatform(e.supervisor);
        const unitDir = resolveOsUnitDir(flags, platform);
        const probePath = pathM.join(unitDir, platform.unitFileName(e.label));
        const loaded = platform.isLoaded(e.label, realOsExec);
        rows.push({
          id: rec.extId, scope: rec.scope, label: e.label, supervisor: e.supervisor,
          loaded, unitPath: flags['unit-dir'] !== undefined || process.env['SOX_OS_UNIT_DIR'] ? probePath : e.unitPath,
          appliedHash: e.appliedHash,
        });
      }
    }
  }

  if (flags['json'] !== undefined) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    process.exit(0);
  }
  if (rows.length === 0) {
    process.stdout.write(`${CLI} service list: no sox-owned OS units found\n`);
    process.exit(0);
  }
  process.stdout.write(`\nsox-owned OS units\n\n`);
  process.stdout.write(`  ${'EXTENSION'.padEnd(20)} ${'SCOPE'.padEnd(8)} ${'SUPERVISOR'.padEnd(10)} ${'LOADED'.padEnd(7)} LABEL\n`);
  process.stdout.write(`  ${'─'.repeat(20)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(30)}\n`);
  for (const r of rows) {
    process.stdout.write(
      `  ${r.id.padEnd(20)} ${r.scope.padEnd(8)} ${r.supervisor.padEnd(10)} ${(r.loaded ? 'yes' : 'no').padEnd(7)} ${r.label}\n`,
    );
  }
  process.stdout.write('\n');
  process.exit(0);
}

// ─── doctor (PI-1: identity-based stray detection + cross-build orphan repair) ─

// ─── Slice 4 (spec §10.2/§14): the universal reconcile + its OS-scheduled tick ──

/** The pseudo-extension id the scheduled reconcile unit is owned under. */
const DOCTOR_TICK_ID = 'doctor-tick';
/** Default tick interval (seconds). Overridable via --interval / SOX_DOCTOR_TICK_INTERVAL. */
const DOCTOR_TICK_DEFAULT_INTERVAL_SEC = 300;

/**
 * `soxe doctor --install-tick [--interval <sec>]` — schedule `soxe doctor
 * --reconcile` under the OS supervisor. The unit is GENERATED through the
 * standard os-unit layer ([inv:os-unit-generated], content-addressed,
 * ownership-tracked as an `os-unit` OwnedEntry under the pseudo-id
 * `doctor-tick`, [inv:reversible-injection]) and is removable via
 * `soxe doctor --remove-tick` OR the standard `soxe service disable doctor-tick`
 * path (the label matches). launchd renders `StartInterval`; systemd renders a
 * paired `.timer` unit (the renderTimerUnit seam).
 *
 * This is what makes supervision CONTINUOUS: the reaper/identity-scan machinery
 * was previously verb-triggered only — nothing watched between invocations.
 */
async function doctorInstallTick(flags: Record<string, string>): Promise<void> {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? process.cwd();
  const dryRun = flags['dry-run'] !== undefined;

  // Interval: flag > env > default. Clamped to ≥10s (the §11.3 ThrottleInterval floor).
  const rawInterval = flags['interval'] ?? process.env['SOX_DOCTOR_TICK_INTERVAL'];
  let intervalSec = rawInterval !== undefined ? Number(rawInterval) : DOCTOR_TICK_DEFAULT_INTERVAL_SEC;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = DOCTOR_TICK_DEFAULT_INTERVAL_SEC;
  if (intervalSec < 10) {
    process.stderr.write(`${CLI} doctor: --interval ${intervalSec}s is below the 10s floor — clamped to 10s\n`);
    intervalSec = 10;
  }

  const platform = getOsUnitPlatform(
    (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
  );
  const unitDir = resolveOsUnitDir(flags, platform);

  // Pinned node path + volatility guard — the SAME policy as `service enable`
  // (§9.2 / Appendix B item 3).
  const nodeRes = flags['node-path']
    ? { nodePath: flags['node-path'], volatile: false as const }
    : resolveUnitNodePath();
  if (nodeRes.volatile) {
    process.stderr.write(`${CLI} doctor --install-tick: WARNING — ${nodeRes.volatileReason ?? 'volatile node path'}\n`);
    if (nodeRes.preferredNonVolatile) {
      process.stderr.write(
        `  A non-volatile node is available at ${nodeRes.preferredNonVolatile}; ` +
        `re-run with --node-path=${nodeRes.preferredNonVolatile} to pin it.\n`,
      );
    }
    if (flags['allow-volatile-node'] === undefined) {
      process.stderr.write(
        `  Refusing to pin a volatile node. Re-run with --allow-volatile-node to proceed anyway, ` +
        `or --node-path=<stable node>.\n`,
      );
      process.exit(1);
    }
  }

  // The tick runs THIS soxe: `node <cli> doctor --reconcile` (the BL-156
  // execArgs pattern — the unit launches the CLI, not a bare extension entrypoint).
  let cliPath = process.argv[1] ?? '';
  try { cliPath = fsM.realpathSync(cliPath); } catch { /* keep as-is */ }
  if (!cliPath) {
    process.stderr.write(`${CLI} doctor --install-tick: cannot resolve the CLI path (process.argv[1] empty)\n`);
    process.exit(1);
  }

  const workingDirectory = dataRoot(scope as DataScope, root);
  try { fsM.mkdirSync(workingDirectory, { recursive: true }); } catch { /* best-effort */ }

  // §9.2 env mirror. SOX_ECOSYSTEM_HOME is forwarded EXPLICITLY (documented in
  // the spec 1.4.0 changelog): a custom data root must be visible to the
  // scheduled reconcile or it would inspect the wrong store. This does NOT widen
  // the supervisor scrub allowlist — it is tick-unit-only.
  const env = buildOsUnitEnv(DOCTOR_TICK_ID, root);
  const ecoHome = process.env['SOX_ECOSYSTEM_HOME'];
  if (ecoHome !== undefined && ecoHome !== '') env['SOX_ECOSYSTEM_HOME'] = ecoHome;

  const spec = deriveOsUnitSpec({
    id: DOCTOR_TICK_ID,
    scope,
    // No manifest exists for the pseudo-extension: an absent manifest derives
    // runAtLoad=true (run once at load) + keepAlive=false (a tick job exits;
    // the OS supervisor relaunches it on the interval).
    manifestPath: pathM.join(workingDirectory, '.doctor-tick-has-no-manifest'),
    nodePath: nodeRes.nodePath,
    entrypoint: cliPath,
    execArgs: ['--enable-source-maps', cliPath, 'doctor', '--reconcile'],
    env,
    workingDirectory,
    logDir: logDirFor(`os-${scope}-${DOCTOR_TICK_ID}`),
    startIntervalSec: intervalSec,
  });

  const result = enableOsUnit(spec, platform, {
    unitDir,
    load: !dryRun,
    log: (m) => process.stdout.write(`sox: ${m}\n`),
  });

  // systemd: the schedule is a paired, content-addressed `.timer` unit.
  let timerPath: string | undefined;
  const timerContent = platform.renderTimerUnit?.(spec);
  if (timerContent !== undefined) {
    const timerName = platform.unitFileName(spec.label).replace(/\.service$/, '.timer');
    timerPath = pathM.join(unitDir, timerName);
    fsM.mkdirSync(pathM.dirname(timerPath), { recursive: true });
    fsM.writeFileSync(`${timerPath}.tmp`, timerContent, 'utf8');
    fsM.renameSync(`${timerPath}.tmp`, timerPath);
    process.stdout.write(`sox: os-unit ${spec.label}: timer written ${timerPath}\n`);
    if (!dryRun) {
      realOsExec('systemctl', ['--user', 'daemon-reload']);
      realOsExec('systemctl', ['--user', 'enable', '--now', timerName]);
    }
  }

  // Ownership ([inv:reversible-injection], §9.4): recorded like any os-unit so
  // `service list`/`doctor` enumerate it and disable/remove-tick reverse it.
  try {
    const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
    own.addEntries(DOCTOR_TICK_ID, scope, [{
      kind: 'os-unit',
      label: spec.label,
      unitPath: result.unitPath,
      supervisor: platform.kind,
      appliedHash: result.contentHash,
    }]);
    own.save();
  } catch (e) {
    process.stderr.write(`sox: warning: could not record doctor-tick ownership: ${String(e)}\n`);
  }

  process.stdout.write(
    `${CLI} doctor --install-tick: ${result.action} ${platform.kind} unit '${spec.label}'\n` +
    `  unit:      ${result.unitPath}\n` +
    (timerPath !== undefined ? `  timer:     ${timerPath}\n` : '') +
    `  runs:      ${CLI} doctor --reconcile  (every ${intervalSec}s)\n` +
    `  node:      ${spec.nodePath}\n` +
    `  content:   ${result.contentHash}\n` +
    (dryRun
      ? `  (--dry-run: unit written but NOT loaded — no ${platform.kind === 'launchd' ? 'launchctl' : 'systemctl'} call)\n`
      : `  loaded:    ${result.loaded ? 'yes' : 'NO (load failed — see warnings)'}\n`) +
    `  remove:    ${CLI} doctor --remove-tick   (or: ${CLI} service disable ${DOCTOR_TICK_ID})\n`,
  );
  process.exit(!dryRun && !result.loaded ? 1 : 0);
}

/**
 * `soxe doctor --remove-tick` — reverse --install-tick: unload + remove the unit
 * (and the systemd `.timer` twin) and clear the ownership entry. Idempotent.
 */
async function doctorRemoveTick(flags: Record<string, string>): Promise<void> {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? process.cwd();
  const platform = getOsUnitPlatform(
    (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
  );
  const unitDir = resolveOsUnitDir(flags, platform);
  const label = osUnitLabel(scope, DOCTOR_TICK_ID);

  // systemd: tear the .timer twin down first (the schedule outranks the job).
  const svcName = platform.unitFileName(label);
  if (platform.kind === 'systemd' && svcName.endsWith('.service')) {
    const timerName = svcName.replace(/\.service$/, '.timer');
    const timerPath = pathM.join(unitDir, timerName);
    if (fsM.existsSync(timerPath)) {
      realOsExec('systemctl', ['--user', 'disable', '--now', timerName]);
      try { fsM.unlinkSync(timerPath); process.stdout.write(`sox: os-unit ${label}: removed ${timerPath}\n`); } catch { /* best-effort */ }
    }
  }

  disableOsUnit(label, platform, { unitDir, log: (m) => process.stdout.write(`sox: ${m}\n`) });

  // Clear the ownership os-unit entry ([inv:reversible-injection]).
  try {
    const own = OwnershipIndex.loadFromFile(pathM.join(dataRoot(scope as DataScope, root), 'ownership.json'));
    const rec = own.get(DOCTOR_TICK_ID, scope);
    if (rec) {
      const kept = rec.entries.filter((e) => e.kind !== 'os-unit');
      own.record({ extId: DOCTOR_TICK_ID, scope, entries: kept, ...(rec.host !== undefined ? { host: rec.host } : {}) });
      own.save();
    }
  } catch { /* best-effort */ }

  process.stdout.write(`${CLI} doctor --remove-tick: '${label}' unloaded + removed\n`);
  process.exit(0);
}

/** One reconcile finding/action (the --reconcile report + durable-log record). */
interface ReconcileFinding {
  kind:
    | 'zombie-stray'            // token-matched, zero fds on the live writer socket (BL-170)
    | 'stray-skipped'           // report+skip (accounted / socket holder / unattributable / lone)
    | 'singleton-duplicate'     // ≥2 live, no socket — §5.3 heal (oldest survives)
    | 'split-brain-runtime'     // runtime.json running:true with no process reality (F4/F6)
    | 'os-unit-file-missing'    // ownership records a unit whose file is gone
    | 'os-unit-stale'           // on-disk unit hash ≠ ownership appliedHash / artifact drift (F12)
    | 'os-unit-orphaned'        // sox-labelled unit file with no ownership entry (F15)
    | 'crash-loop-give-up'      // Slice 3 marker (§11.3) — explicit start clears
    | 'lock-debris';            // BL-201: dead-holder proxy spawn-lock file swept
  extId: string;
  scope: string;
  pid: number;
  detail: string;
  action: 'healed' | 'would-heal' | 'report-only' | 'skipped' | 'failed';
}

/**
 * `soxe doctor --reconcile [--dry-run]` — the Slice 4 universal reconcile pass
 * (§10.2, F4/F6/F12/F15 + the BL-170 zombie class). Non-interactive, idempotent,
 * SAFE BY CONSTRUCTION:
 *
 *   - GC-prunes dead supervisors (readGlobalRegistry — the existing gc.ts pass).
 *   - Scans every installed service/mcp-server for identity strays (the BL-136
 *     env+argv matchers) and heals ONLY what it can positively attribute:
 *     the live writer-socket holder is NEVER touched; an unattributable live
 *     socket reaps NOTHING; a lone unaccounted process is report-only; a ≥2
 *     no-socket duplicate set is healed per §5.3 (oldest survives). All kills go
 *     through killAndVerify ([contract:signal] verified-stop).
 *   - Heals split-brain runtime.json records ([inv:list-never-lies]).
 *   - Reconciles os-units against ownership (stale/missing/orphaned — F12/F15,
 *     report-only: loading/unloading a unit needs the human node-path context).
 *   - Surfaces crash-loop give-up markers (Slice 3, §11.3 — explicit start clears).
 *
 * Every action is written to the durable log
 * `run/logs/doctor-reconcile/doctor-reconcile-<date>.log`
 * (`soxe logs --id doctor-reconcile`). `--dry-run` reports what WOULD be done.
 * Exit: 0 = reconciled (report-only findings do not fail a scheduled tick);
 *       1 = a reap failed verification ('undead') or the pass errored.
 */
/**
 * BL-393 — a doctor-reconcile singleton-violation heal SIGTERMs a duplicate
 * backend process silently: the only trace was a line in
 * `run/logs/doctor-reconcile/doctor-reconcile-<date>.log`, a file no operator
 * checks by default. Measured live 2026-08-02T00:14:42Z: the reconcile pass
 * killed a duplicate memory-server backend (pid 56514, survivor 8820), and
 * within the same minute the proxy's live backend connection ALSO rotated
 * (final pid 65352) — a real production respawn with zero signal in
 * `memory_ping` or `service status`. Persist the last heal event per
 * extId+scope so `service status` can surface it loudly instead.
 */
interface SingletonHealMarker {
  extId: string;
  scope: string;
  healedAt: string;
  survivorPid: number;
  killedPid: number;
  outcome: string;
}

function singletonHealMarkerPath(extId: string, scope: string): string {
  const pathM = require('node:path') as typeof import('node:path');
  return pathM.join(runDir(), 'reconcile-heals', `${extId}@${scope}.json`);
}

function writeSingletonHealMarker(marker: SingletonHealMarker): void {
  const fsM = require('node:fs') as typeof import('node:fs');
  const pathM = require('node:path') as typeof import('node:path');
  const p = singletonHealMarkerPath(marker.extId, marker.scope);
  try {
    fsM.mkdirSync(pathM.dirname(p), { recursive: true });
    fsM.writeFileSync(p, JSON.stringify(marker, null, 2));
  } catch { /* never fail the reconcile pass on marker bookkeeping */ }
}

/** Exported for `cmdService`'s `status` subcommand (BL-393 loud surfacing). */
function readSingletonHealMarker(extId: string, scope: string): SingletonHealMarker | null {
  const fsM = require('node:fs') as typeof import('node:fs');
  try {
    return JSON.parse(fsM.readFileSync(singletonHealMarkerPath(extId, scope), 'utf8')) as SingletonHealMarker;
  } catch {
    return null;
  }
}

async function doctorReconcile(flags: Record<string, string>): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const root = flags['root'] ?? process.cwd();
  const filterId = flags['id'];
  const filterScope = flags['scope'];
  const dryRun = flags['dry-run'] !== undefined;
  const jsonMode = flags['json'] !== undefined;
  const graceMs = (() => {
    const raw = flags['grace-ms'] ?? process.env['SOX_STOP_GRACE_MS'];
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 5000;
  })();

  // Durable action log — every line is `soxe logs --id doctor-reconcile`-visible.
  // SYNCHRONOUS appends (not LogManager's WriteStream): the pass ends in
  // process.exit(), which would drop async-buffered lines. The dated filename
  // follows the LogManager `<extId>-<YYYY-MM-DD>.log` convention (daily files).
  const reconLogDir = logDirFor('doctor-reconcile');
  const reconLogPath = pathMod.join(reconLogDir, `doctor-reconcile-${new Date().toISOString().slice(0, 10)}.log`);
  try { fsMod.mkdirSync(reconLogDir, { recursive: true }); } catch { /* best-effort */ }
  const findings: ReconcileFinding[] = [];
  let undead = false;
  const log = (m: string): void => {
    try { fsMod.appendFileSync(reconLogPath, `${new Date().toISOString()} ${m}\n`, 'utf8'); } catch { /* never fail the pass on logging */ }
    if (!jsonMode) process.stdout.write(`${CLI} doctor: ${m}\n`);
  };
  log(`[reconcile] pass starting (root=${root}${dryRun ? ', DRY-RUN' : ''})`);

  // ── 0. GC — prunes dead supervisors + heals their runtime.json (gc.ts). ──────
  const liveSupervisors = await readGlobalRegistry();

  // ── 1. Accounted pids ([auth:supervisor-then-os-then-os-reality]): a pid a
  //       live GC-verified supervisor, a runtime record, or a loaded OS unit
  //       claims is NEVER a reap candidate.
  const accounted = new Set<number>([process.pid, process.ppid]);
  for (const sup of liveSupervisors) {
    accounted.add(sup.pid);
    try {
      const rec = JSON.parse(fsMod.readFileSync(sup.runtimeFilePath, 'utf8')) as {
        entries?: Array<{ pid?: number | null }>;
      };
      for (const e of rec.entries ?? []) {
        if (typeof e.pid === 'number' && e.pid > 0) accounted.add(e.pid);
      }
    } catch { /* stale runtime file — gc already handled */ }
  }
  const scopes = ['org', 'user', 'project', 'local'] as const;
  for (const sc of scopes) {
    let dir: string;
    try { dir = dataRoot(sc, root); } catch { continue; }
    let own: OwnershipIndex;
    try { own = OwnershipIndex.loadFromFile(pathMod.join(dir, 'ownership.json')); } catch { continue; }
    for (const rec of own.all()) {
      for (const e of rec.entries) {
        if (e.kind !== 'os-unit' || e.supervisor !== 'launchd') continue;
        const platform = getOsUnitPlatform(e.supervisor);
        if (!platform.isLoaded(e.label, realOsExec)) continue;
        const probe = realOsExec('launchctl', ['list', e.label]);
        const pidMatch = probe.code === 0 ? probe.stdout.match(/"PID"\s*=\s*(\d+)/) : null;
        if (pidMatch) accounted.add(parseInt(pidMatch[1]!, 10));
      }
    }
  }

  // ── 2. Identity-token stray scan + SAFE heal per installed service/mcp-server. ──
  const registry = readInstallRegistry(installRegistryPath());
  const seenInstalls = new Set<string>();
  for (const inst of registry.installs) {
    if (filterId !== undefined && inst.extId !== filterId) continue;
    if (filterScope !== undefined && inst.scope !== filterScope) continue;
    const dedupeKey = `${inst.scope}:${inst.extId}`;
    if (seenInstalls.has(dedupeKey)) continue;
    seenInstalls.add(dedupeKey);

    const extDir = resolveExtensionDir(inst.source, inst.root);
    if (!extDir) continue;
    let manifest: { type?: string; entrypoint?: string };
    try {
      manifest = JSON.parse(fsMod.readFileSync(pathMod.join(extDir, 'extension.json'), 'utf8'));
    } catch { continue; }
    if (manifest.type !== 'service' && manifest.type !== 'mcp-server') continue;
    if (!manifest.entrypoint) continue;
    const entrypointPath = pathMod.resolve(extDir, manifest.entrypoint);
    const token = identityToken(`file://${entrypointPath}`);

    const matches: ReconcileMatch[] = findOrphansByServiceId(inst.extId, token, {
      excludePids: [process.pid],
    }).map((m) => ({ pid: m.pid, ppid: m.ppid, orphaned: m.orphaned }));
    if (matches.length === 0) continue;

    // The store's writer socket: the proxy-backend UDS for a proxy-mode
    // mcp-server; the declared socket health endpoint for a socket service.
    let sockPath: string | null = null;
    if (manifest.type === 'mcp-server' && mcpServerIsProxyMode(inst.extId, inst.scope, inst.root)) {
      const configEnv = buildExtConfigEnv(inst.extId, inst.root);
      const storeResource = resolveStoreResource(pathMod.join(extDir, 'extension.json'), configEnv);
      const key = singletonKey(inst.extId, storeResource) ?? `${inst.extId} none:`;
      const { backendSocketPath } =
        require('@adhd/sox-service-proxy') as typeof import('@adhd/sox-service-proxy');
      sockPath = backendSocketPath(socketDir(), key);
    } else {
      sockPath = resolveServiceHealthSocketPath(extDir, buildExtConfigEnv(inst.extId, inst.root));
    }
    const socketLive = sockPath !== null && (await probeUnixSocketLive(sockPath, 750));
    const socketPids = socketLive && sockPath !== null ? socketOwnerPids(sockPath) : null;

    const plan = classifyReconcileTargets({
      matches,
      accountedPids: accounted,
      socketLive,
      socketPids,
    });

    for (const s of plan.skip) {
      if (s.reason === 'accounted') continue; // healthy tracked process — not a finding
      findings.push({
        kind: 'stray-skipped', extId: inst.extId, scope: inst.scope, pid: s.match.pid,
        detail: `pid ${s.match.pid} skipped (${s.reason})`,
        action: s.reason === 'writer-socket-holder' ? 'skipped' : 'report-only',
      });
      if (s.reason !== 'writer-socket-holder') {
        log(`[reconcile] ${inst.extId}@${inst.scope}: pid ${s.match.pid} REPORT+SKIP — ${s.reason}`);
      }
    }

    for (const z of plan.reap) {
      const desc = `${inst.extId}@${inst.scope} pid ${z.pid}${z.orphaned ? ' (orphan, PPID 1)' : ''} — token-matched with ZERO fds on the live writer socket (BL-170 zombie class)`;
      if (dryRun) {
        findings.push({ kind: 'zombie-stray', extId: inst.extId, scope: inst.scope, pid: z.pid, detail: desc, action: 'would-heal' });
        log(`[reconcile] WOULD reap ${desc}`);
        continue;
      }
      const outcome = await killAndVerify(z.pid, { graceMs, log: (m) => log(`[reconcile] reap ${inst.extId} pid ${z.pid}: ${m}`) });
      if (outcome === 'undead') {
        undead = true;
        findings.push({ kind: 'zombie-stray', extId: inst.extId, scope: inst.scope, pid: z.pid, detail: `${desc} — UNDEAD`, action: 'failed' });
        log(`[reconcile] FAILED to reap ${desc} (undead)`);
      } else {
        findings.push({ kind: 'zombie-stray', extId: inst.extId, scope: inst.scope, pid: z.pid, detail: `${desc} → ${outcome}`, action: 'healed' });
        log(`[reconcile] reaped ${desc} → ${outcome}`);
      }
    }

    if (plan.duplicateSetNoSocket.length >= 2) {
      // §5.3 singleton violation with no socket to attribute: the EXISTING
      // deterministic survivor rule (oldest by lstart) picks the keeper.
      const pids = plan.duplicateSetNoSocket.map((p) => p.pid);
      const { survivor, losers } = chooseSurvivor(pids);
      log(`[reconcile] [singleton-violation] ${inst.extId}@${inst.scope}: ${pids.length} live, no socket — survivor=${survivor} losers=${losers.join(',')}`);
      for (const loser of losers) {
        if (dryRun) {
          findings.push({ kind: 'singleton-duplicate', extId: inst.extId, scope: inst.scope, pid: loser, detail: `duplicate of survivor ${survivor}`, action: 'would-heal' });
          log(`[reconcile] WOULD reap duplicate ${inst.extId} pid ${loser} (survivor ${survivor})`);
          continue;
        }
        const outcome = await killAndVerify(loser, { graceMs, log: (m) => log(`[reconcile] heal ${inst.extId} pid ${loser}: ${m}`) });
        if (outcome === 'undead') { undead = true; }
        findings.push({
          kind: 'singleton-duplicate', extId: inst.extId, scope: inst.scope, pid: loser,
          detail: `duplicate of survivor ${survivor} → ${outcome}`,
          action: outcome === 'undead' ? 'failed' : 'healed',
        });
        log(`[reconcile] [singleton-violation healed] ${inst.extId} pid ${loser} → ${outcome}`);
        // BL-393: this SIGTERM is exactly the kind of silent respawn trigger that
        // produced the 2026-08-02T00:15:29Z incident — persist it so `service
        // status` surfaces the rotation instead of only the reconcile log file.
        writeSingletonHealMarker({
          extId: inst.extId,
          scope: inst.scope,
          healedAt: new Date().toISOString(),
          survivorPid: survivor,
          killedPid: loser,
          outcome,
        });
      }
    }
  }

  // ── 3. Split-brain runtime.json heal (F4/F6, [inv:list-never-lies]). ─────────
  for (const sc of scopes) {
    let scopePaths: { config: string; lockfile: string };
    try { scopePaths = getScopePaths(sc, root); } catch { continue; }
    const runtimeFilePath = getRuntimeFilePath(scopePaths.lockfile);
    if (!fsMod.existsSync(runtimeFilePath)) continue;
    let recRt: RuntimeRecord;
    try { recRt = JSON.parse(fsMod.readFileSync(runtimeFilePath, 'utf8')) as RuntimeRecord; } catch { continue; }
    // Authority rule 1: a LIVE supervisor owns its record — never rewritten here.
    if (typeof recRt.supervisorPid === 'number' && pidAliveRT(recRt.supervisorPid)) continue;
    let changed = false;
    for (const e of recRt.entries ?? []) {
      if (e.running !== true) continue;
      if (filterId !== undefined && e.id !== filterId) continue;
      const pidLive = typeof e.pid === 'number' && e.pid > 0 && pidAliveRT(e.pid);
      const tokenLive = e.source
        ? findOrphansByIdentity(identityToken(e.source), { excludePids: [process.pid] }).length > 0
        : false;
      if (pidLive || tokenLive) continue;
      const desc = `runtime.json ${sc}: '${e.id}' running:true with NO process reality (pid=${String(e.pid)})`;
      if (dryRun) {
        findings.push({ kind: 'split-brain-runtime', extId: e.id, scope: sc, pid: e.pid ?? 0, detail: desc, action: 'would-heal' });
        log(`[reconcile] WOULD heal ${desc} → running:false`);
        continue;
      }
      e.running = false;
      e.pid = null;
      changed = true;
      findings.push({ kind: 'split-brain-runtime', extId: e.id, scope: sc, pid: 0, detail: `${desc} → running:false`, action: 'healed' });
      log(`[reconcile] healed ${desc} → running:false`);
    }
    if (changed) {
      const tmp = `${runtimeFilePath}.tmp`;
      fsMod.writeFileSync(tmp, JSON.stringify(recRt, null, 2) + '\n', 'utf8');
      fsMod.renameSync(tmp, runtimeFilePath);
    }
  }

  // ── 4. OS-unit ⇄ ownership reconcile (F12/F15) — report-only remedies:
  //       loading/unloading a unit requires the human node-path context (§9.2),
  //       so the reconcile proposes the exact command instead of guessing.
  {
    const platform = getOsUnitPlatform(
      (flags['supervisor'] as OsSupervisor | undefined) ?? detectOsSupervisor(),
    );
    const unitDir = resolveOsUnitDir(flags, platform);
    const ownedUnitFiles = new Set<string>();
    for (const sc of scopes) {
      let dir: string;
      try { dir = dataRoot(sc, root); } catch { continue; }
      let own: OwnershipIndex;
      try { own = OwnershipIndex.loadFromFile(pathMod.join(dir, 'ownership.json')); } catch { continue; }
      for (const rec of own.all()) {
        if (filterId !== undefined && rec.extId !== filterId) continue;
        for (const e of rec.entries) {
          if (e.kind !== 'os-unit') continue;
          const entryPlatform = getOsUnitPlatform(e.supervisor);
          const unitPath = (flags['unit-dir'] !== undefined || process.env['SOX_OS_UNIT_DIR'])
            ? pathMod.join(unitDir, entryPlatform.unitFileName(e.label))
            : e.unitPath;
          const base = pathMod.basename(unitPath);
          ownedUnitFiles.add(base);
          if (base.endsWith('.service')) ownedUnitFiles.add(base.replace(/\.service$/, '.timer'));
          if (!fsMod.existsSync(unitPath)) {
            findings.push({
              kind: 'os-unit-file-missing', extId: rec.extId, scope: sc, pid: 0,
              detail: `ownership records os-unit ${e.label} but ${unitPath} is missing — re-run \`${CLI} service enable ${rec.extId} -s ${sc}\``,
              action: 'report-only',
            });
            log(`[reconcile] os-unit ${e.label}: unit FILE MISSING (${unitPath})`);
            continue;
          }
          try {
            const meta = readUnitMeta(fsMod.readFileSync(unitPath, 'utf8'));
            if (meta.contentHash !== undefined && meta.contentHash !== e.appliedHash) {
              findings.push({
                kind: 'os-unit-stale', extId: rec.extId, scope: sc, pid: 0,
                detail: `os-unit ${e.label}: on-disk content-hash ${meta.contentHash} ≠ ownership appliedHash ${e.appliedHash} — re-run \`${CLI} service enable ${rec.extId} -s ${sc}\``,
                action: 'report-only',
              });
              log(`[reconcile] os-unit ${e.label}: STALE content (disk ${meta.contentHash} ≠ owned ${e.appliedHash})`);
            }
            const installedHash = own.get(rec.extId, sc)?.artifactChecksum;
            if (meta.artifactHash !== undefined && installedHash !== undefined && meta.artifactHash !== installedHash) {
              findings.push({
                kind: 'os-unit-stale', extId: rec.extId, scope: sc, pid: 0,
                detail: `os-unit ${e.label}: unit artifact ${meta.artifactHash} ≠ installed ${installedHash} (F12 stale-artifact) — re-run \`${CLI} service enable ${rec.extId} -s ${sc}\``,
                action: 'report-only',
              });
              log(`[reconcile] os-unit ${e.label}: STALE ARTIFACT (unit ${meta.artifactHash} ≠ installed ${installedHash})`);
            }
          } catch { /* unreadable unit — the file-missing branch covers the actionable case */ }
        }
      }
    }
    // F15: sox-labelled unit files with NO ownership entry anywhere.
    try {
      if (fsMod.existsSync(unitDir)) {
        for (const f of fsMod.readdirSync(unitDir)) {
          const isSox = /^com\.sox\..+\.plist$/.test(f) || /^sox-.+\.(service|timer)$/.test(f);
          if (!isSox || ownedUnitFiles.has(f)) continue;
          findings.push({
            kind: 'os-unit-orphaned', extId: f, scope: '?', pid: 0,
            detail: `unit file ${pathMod.join(unitDir, f)} has NO ownership entry (F15 orphaned unit) — remove via \`${CLI} service disable <ext>\``,
            action: 'report-only',
          });
          log(`[reconcile] os-unit ORPHANED: ${f} (no ownership entry)`);
        }
      }
    } catch { /* unit dir unreadable — nothing to report */ }
  }

  // ── 5. Crash-loop give-up markers (Slice 3, §11.3). Report-only by design:
  //       only an explicit start/enable may clear a give-up.
  for (const mk of listCrashLoopMarkers(crashLoopMarkerDir())) {
    const baseId = mk.key.includes('@') ? mk.key.slice(0, mk.key.lastIndexOf('@')) : mk.key;
    if (filterId !== undefined && baseId !== filterId) continue;
    findings.push({
      kind: 'crash-loop-give-up', extId: baseId, scope: '?', pid: 0,
      detail: `${mk.reason} (capped at ${mk.cappedAt})`,
      action: 'report-only',
    });
    log(`[reconcile] ${mk.reason} (capped at ${mk.cappedAt}) — clear with \`${CLI} start --id=${baseId}\``);
  }

  // ── 6. BL-201: dead-holder proxy spawn-lock debris sweep. A holder that dies
  //       between tryAcquireLock and its finally-release leaves the file behind;
  //       correctness is unaffected (pidAlive+TTL reclaim), but the debris misleads
  //       forensics. Sweep per-scope run/supervisors dirs; missing dirs are no-ops.
  for (const sc of scopes) {
    let dir: string;
    try { dir = dataRoot(sc, root); } catch { continue; }
    const lockDir = pathMod.join(dir, 'run', 'supervisors');
    const sweep = sweepProxyBackendLocks(lockDir, { dryRun, log: (m) => log(m) });
    for (const entry of sweep.entries) {
      if (entry.action === 'kept') continue;
      findings.push({
        kind: 'lock-debris', extId: pathMod.basename(entry.file), scope: sc, pid: 0,
        detail: entry.reason,
        action: entry.action === 'swept' ? 'healed' : 'would-heal',
      });
    }
  }

  // ── Summary + honest exit. ────────────────────────────────────────────────────
  const healed = findings.filter((f) => f.action === 'healed').length;
  const would = findings.filter((f) => f.action === 'would-heal').length;
  const reported = findings.filter((f) => f.action === 'report-only').length;
  const failed = findings.filter((f) => f.action === 'failed').length;
  log(
    `[reconcile] pass complete: ${healed} healed, ${would} would-heal (dry-run), ` +
    `${reported} report-only, ${failed} failed${dryRun ? ' [DRY-RUN — nothing was changed]' : ''}`,
  );

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ dryRun, undead, findings }, null, 2) + '\n');
  }
  // A scheduled tick must not flap on report-only findings; only a verification
  // failure (undead) is a reconcile FAILURE.
  process.exit(undead ? 1 : 0);
}

/**
 * cmdDoctor — diagnose and repair soxe process state.
 *
 * Scans for strays by logical service identity (SOX_SERVICE_ID), NOT by
 * entrypoint path — catches cross-build strays that the old path-based reaper
 * cannot match. Reports all anomalies; with --fix, reaps strays.
 *
 * Flags:
 *   --id=<ext-id>    Limit scan to a specific extension/service id.
 *   --scope=<scope>  Limit scan to a specific scope.
 *   --fix            Reap found strays (verified-stop).
 *   --old-match      Use the OLD path-based findOrphansByIdentity instead of
 *                    the NEW env-based findOrphansByServiceId — for the
 *                    negative-control adversarial test (NC).
 *   --json           Structured JSON output for machine consumption.
 *
 * Slice 4 (spec §10.2/§14 — continuous supervision):
 *   --reconcile      Non-interactive, idempotent, SAFE reconcile pass: GC +
 *                    stray heal + split-brain runtime.json heal + os-unit
 *                    reconcile + crash-loop surfacing. Honors --dry-run.
 *   --install-tick   Schedule `doctor --reconcile` under the OS supervisor
 *                    (launchd StartInterval / systemd .timer). --interval <sec>
 *                    (default 300; env SOX_DOCTOR_TICK_INTERVAL). Honors
 *                    --dry-run/--unit-dir/--supervisor/--node-path/
 *                    --allow-volatile-node exactly like `service enable`.
 *   --remove-tick    Reverse --install-tick (unload + remove + clear ownership).
 */
async function cmdDoctor(flags: Record<string, string>): Promise<void> {
  // ── Slice 4: the universal reconcile + its OS-scheduled tick. ───────────────
  if (flags['install-tick'] !== undefined) {
    await doctorInstallTick(flags);
    return;
  }
  if (flags['remove-tick'] !== undefined) {
    await doctorRemoveTick(flags);
    return;
  }
  if (flags['reconcile'] !== undefined) {
    await doctorReconcile(flags);
    return;
  }

  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const root = flags['root'] ?? process.cwd();
  const filterId = flags['_'] ?? flags['id'];
  const filterScope = flags['scope'];
  const doFix = flags['fix'] !== undefined;
  const useOldMatch = flags['old-match'] !== undefined;
  const jsonMode = flags['json'] !== undefined;
  const log = (m: string): void => { process.stdout.write(`${CLI} doctor: ${m}\n`); };

  // Collect all installed extensions from the install registry.
  const registryPath = installRegistryPath();
  const registry = readInstallRegistry(registryPath);

  const findings: Array<{
    kind: 'stray-process' | 'os-unit-not-loaded' | 'cross-build-stray' | 'crash-loop-give-up' | 'legacy-residue';
    extId: string;
    scope: string;
    pid: number;
    ppid: number;
    orphaned: boolean;
    detail: string;
  }> = [];

  // ── BL-57: legacy repo-root residue scan. ──────────────────────────────────
  // An older soxe binary (pre-ADR-0004) wrote global state files directly into
  // $SOX_HOME, which users often pointed at a repo root. Now that the variable is
  // fully inert, those files become orphaned residue. We check the cwd/--root
  // directory for these well-known filenames and report them with a suggested
  // migrate-home command. REPORT-ONLY — doctor never deletes anything.
  {
    const legacyResidueNames = [
      'install-registry.json',
      'supervisors.json',
      'logs',     // directory
      '.sox',     // directory
    ] as const;
    // Scan the root dir itself for stale files placed there by an old binary.
    // Skip when root IS the canonical user data root (SOX_ECOSYSTEM_HOME or
    // ~/.adhd/sox-ecosystem/) — those files belong there.
    const canonicalUserRoot = userDataRoot();
    const rootResolved = pathMod.resolve(root);
    const isCanonical = rootResolved === pathMod.resolve(canonicalUserRoot);
    if (!isCanonical) {
      for (const name of legacyResidueNames) {
        const candidate = pathMod.join(root, name);
        let exists = false;
        try { exists = fsMod.existsSync(candidate); } catch { /* permission deny — skip */ }
        if (!exists) continue;
        findings.push({
          kind: 'legacy-residue',
          extId: name,
          scope: 'global',
          pid: 0,
          ppid: 0,
          orphaned: false,
          detail:
            `legacy soxe data file/dir at ${candidate} — written by a pre-ADR-0004 binary. ` +
            `Cleanup: \`${CLI} migrate-home --old-home ${root}\`  (or remove manually if already migrated)`,
        });
      }
    }
  }

  // ── Slice 3 (§11.3): surface crash-loop give-up markers. Report-only — only an
  //    explicit `soxe start`/`enable` may clear a give-up state.
  try {
    for (const mk of listCrashLoopMarkers(crashLoopMarkerDir())) {
      const baseId = mk.key.includes('@') ? mk.key.slice(0, mk.key.lastIndexOf('@')) : mk.key;
      if (filterId !== undefined && baseId !== filterId) continue;
      findings.push({
        kind: 'crash-loop-give-up',
        extId: baseId,
        scope: '?',
        pid: 0,
        ppid: 0,
        orphaned: false,
        detail: `${mk.reason} (capped at ${mk.cappedAt}) — clear with \`${CLI} start --id=${baseId}\``,
      });
    }
  } catch { /* best-effort */ }

  // [auth:socket-reality] (BL-203 follow-on): a pid holding a live proxy
  // singleton socket IS the accounted writer — never a stray. The reconcile
  // pass has always attributed by socket; plain `doctor` did not, so it
  // reported the LIVE backend as a [STRAY] (observed: 32 duplicate findings
  // for the socket holder) — and `doctor --fix` would killAndVerify it.
  const socketOwnerPidSet = new Set<number>();
  for (const sc of ['org', 'user', 'project', 'local'] as const) {
    let dir: string;
    try { dir = dataRoot(sc as DataScope, root); } catch { continue; }
    const supDir = pathMod.join(dir, 'run', 'supervisors');
    let names: string[] = [];
    try { names = fsMod.readdirSync(supDir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.sock')) continue;
      for (const p of socketOwnerPids(pathMod.join(supDir, n)) ?? []) socketOwnerPidSet.add(p);
    }
  }
  // Dedupe stray findings by pid — one process is one finding, regardless of
  // how many install records (scopes/projects) its identity matches.
  const seenStrayPids = new Set<number>();

  // Scan each install record.
  for (const rec of registry.installs) {
    if (filterId !== undefined && rec.extId !== filterId) continue;
    if (filterScope !== undefined && rec.scope !== filterScope) continue;

    // Resolve the extension's store dir and entrypoint.
    const extDir = resolveExtensionDir(rec.source, rec.root);
    if (!extDir) continue;
    let manifest: { type?: string; entrypoint?: string };
    try {
      manifest = JSON.parse(fsMod.readFileSync(pathMod.join(extDir, 'extension.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.entrypoint) continue;
    const entrypointPath = pathMod.resolve(extDir, manifest.entrypoint);

    // Match by service identity env var (SOX_SERVICE_ID).
    let matches: Array<{ pid: number; ppid: number; orphaned: boolean }>;
    if (useOldMatch) {
      // Old path-based matching — will miss cross-build strays.
      const token = identityToken(`file://${entrypointPath}`);
      matches = findOrphansByIdentity(token, { excludePids: [process.pid] }).map(
        (m) => ({ pid: m.pid, ppid: m.ppid, orphaned: m.orphaned }),
      );
    } else {
      // New env-based matching — finds processes by logical identity.
      matches = findOrphansByServiceId(rec.extId, identityToken(`file://${entrypointPath}`), {
        excludePids: [process.pid],
      }).map((m) => ({ pid: m.pid, ppid: m.ppid, orphaned: m.orphaned }));
    }

    for (const m of matches) {
      // Live singleton socket holder — accounted by reality, never a stray.
      if (socketOwnerPidSet.has(m.pid)) continue;
      // One process = one finding across all matching install records.
      if (seenStrayPids.has(m.pid)) continue;
      seenStrayPids.add(m.pid);
      // Determine if this is a cross-build stray (different entrypoint path
      // than expected, same SOX_SERVICE_ID).
      const env = readProcessEnv(m.pid);
      const actualPath = env?.['SOX_PROXY_BACKEND'] !== undefined
        ? '(proxy backend)'
        : '(unknown)';
      const isCrossBuild = useOldMatch
        ? false  // old matching can't detect cross-build by definition
        : !findOrphansByIdentity(identityToken(`file://${entrypointPath}`), { excludePids: [process.pid] })
            .some((o) => o.pid === m.pid);

      findings.push({
        kind: isCrossBuild ? 'cross-build-stray' : 'stray-process',
        extId: rec.extId,
        scope: rec.scope,
        pid: m.pid,
        ppid: m.ppid,
        orphaned: m.orphaned,
        detail: isCrossBuild
          ? `cross-build stray (same SOX_SERVICE_ID, different entrypoint path) — old path-based matching CANNOT detect this`
          : `stray process — ${actualPath}`,
      });
    }

    // Check OS-unit owned services for load state.
    for (const sc of ['org', 'user', 'project', 'local'] as const) {
      if (filterScope !== undefined && sc !== filterScope) continue;
      let dir: string;
      try { dir = dataRoot(sc as DataScope, root); } catch { continue; }
      const ownPath = pathMod.join(dir, 'ownership.json');
      let own: OwnershipIndex;
      try { own = OwnershipIndex.loadFromFile(ownPath); } catch { continue; }
      const rec_ = own.get(rec.extId, sc);
      if (!rec_) continue;
      for (const e of rec_.entries) {
        if (e.kind !== 'os-unit') continue;
        const platform = getOsUnitPlatform(e.supervisor as OsSupervisor);
        const loaded = platform.isLoaded(e.label, realOsExec);
        if (!loaded) {
          // OS unit exists but is not loaded — report as anomaly if a process
          // matching the entrypoint is running (orphan outside OS supervision).
          findings.push({
            kind: 'os-unit-not-loaded',
            extId: rec.extId,
            scope: sc,
            pid: 0,
            ppid: 0,
            orphaned: false,
            detail: `os-unit ${e.label} exists but NOT LOADED (may need \`soxe service enable\`)`,
          });
        }
      }
    }
  }

  // ── Ownership-only os-units (BL-203 follow-on): the not-loaded scan above
  //    iterates the INSTALL REGISTRY, but some os-units exist only in
  //    ownership.json — the doctor-tick foremost. When the tick was booted out
  //    (the BL-203 incidents), `doctor` reported a clean bill while the
  //    supervision heartbeat was down. Sweep ownership entries the install
  //    loop never covered so the diagnostic can't be blind to its own tick.
  {
    const coveredIds = new Set(
      findings.filter((f) => f.kind === 'os-unit-not-loaded').map((f) => f.extId),
    );
    for (const sc of ['org', 'user', 'project', 'local'] as const) {
      let dir: string;
      try { dir = dataRoot(sc as DataScope, root); } catch { continue; }
      let own: OwnershipIndex;
      try { own = OwnershipIndex.loadFromFile(pathMod.join(dir, 'ownership.json')); } catch { continue; }
      for (const rec of own.all()) {
        if (coveredIds.has(rec.extId)) continue;
        if (registry.installs.some((inst) => inst.extId === rec.extId)) continue; // install loop's territory
        for (const e of rec.entries) {
          if (e.kind !== 'os-unit') continue;
          const platform = getOsUnitPlatform(e.supervisor as OsSupervisor);
          if (platform.isLoaded(e.label, realOsExec)) continue;
          const remedy = rec.extId === 'doctor-tick'
            ? `\`${CLI} doctor --install-tick\``
            : `\`${CLI} service enable ${rec.extId}\``;
          findings.push({
            kind: 'os-unit-not-loaded',
            extId: rec.extId,
            scope: sc,
            pid: 0,
            ppid: 0,
            orphaned: false,
            detail: `os-unit ${e.label} exists (ownership-only) but NOT LOADED — reload via ${remedy}`,
          });
        }
      }
    }
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
    process.exit(findings.length > 0 ? 1 : 0);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  if (findings.length === 0) {
    log('no anomalies found — system state is clean');
    process.exit(0);
  }

  const strayCount = findings.filter((f) => f.kind === 'stray-process' || f.kind === 'cross-build-stray').length;
  const osUnitCount = findings.filter((f) => f.kind === 'os-unit-not-loaded').length;
  const crashLoopCount = findings.filter((f) => f.kind === 'crash-loop-give-up').length;
  const residueCount = findings.filter((f) => f.kind === 'legacy-residue').length;
  log(`found ${findings.length} anomal${findings.length === 1 ? 'y' : 'ies'}:`);
  log(`  ${strayCount} stray processe${strayCount === 1 ? '' : 's'}`);
  log(`  ${osUnitCount} unloaded os-unit${osUnitCount === 1 ? '' : 's'}`);
  if (crashLoopCount > 0) log(`  ${crashLoopCount} crash-loop give-up${crashLoopCount === 1 ? '' : 's'} (§11.3)`);
  if (residueCount > 0) log(`  ${residueCount} legacy residue file${residueCount === 1 ? '' : 's'} (BL-57)`);

  for (const f of findings) {
    const tag = f.kind === 'cross-build-stray' ? 'CROSS-BUILD'
      : f.kind === 'os-unit-not-loaded' ? 'OS-UNIT'
      : f.kind === 'crash-loop-give-up' ? 'CRASH-LOOP'
      : f.kind === 'legacy-residue' ? 'RESIDUE'
      : 'STRAY';
    const pidInfo = f.pid > 0 ? ` (pid=${f.pid}, ppid=${f.ppid}${f.orphaned ? ', orphan' : ''})` : '';
    log(`  [${tag}] ${f.extId}@${f.scope}${pidInfo}: ${f.detail}`);
  }

  // ── Fix: reap strays ────────────────────────────────────────────────────────
  if (doFix) {
    let reaped = 0;
    let undead = false;
    for (const f of findings) {
      if (f.kind === 'stray-process' || f.kind === 'cross-build-stray') {
        if (f.pid <= 0) continue;
        const outcome = await killAndVerify(f.pid, {
          graceMs: 5000,
          log: (m) => log(`  reap ${f.extId}: ${m}`),
        });
        if (outcome === 'undead') {
          undead = true;
          log(`  FAILED to kill pid ${f.pid} for ${f.extId} — undead`);
        } else {
          reaped++;
          log(`  reaped pid ${f.pid} for ${f.extId} → ${outcome}`);
        }
      }
    }

    // Also fix unloaded os-units by attempting to enable them.
    for (const f of findings) {
      if (f.kind === 'os-unit-not-loaded') {
        log(`  os-unit ${f.extId} enable recommended: run \`soxe service enable ${f.extId}\``);
      }
    }

    log(`reaped ${reaped} stray${reaped === 1 ? '' : 's'}${undead ? ' (SOME UNDEAD)' : ''}`);
    process.exit(undead ? 1 : 0);
  }

  process.stdout.write(
    `\nRun '${CLI} doctor --fix' to reap strays and reconcile.\n` +
    `Run '${CLI} service enable <ext>' to reload unloaded OS units.\n\n`,
  );
  process.exit(1);
}

// ─── migrate-home (ADR-0004 §D8) ───────────────────────────────────────────────

/**
 * cmdMigrateHome — relocate an existing soxe data dir to the ADR-0004 layout and
 * re-place user-scope skills/MCP that a prior sandboxed SOX_HOME wrote under the
 * WRONG root to the REAL ~/.claude. Idempotent: a second run is a no-op.
 *
 * Flags:
 *   --old-home <dir>     The legacy data root to migrate FROM (default: $SOX_HOME
 *                        if set, else ~/.sox). Holds install-registry.json,
 *                        supervisors.json, ext/ stores, ledger.json, lockfiles.
 *   --old-config <dir>   Legacy user config/lockfile dir (default: ~/.config/extensions).
 *   --old-sandbox <dir>  The path a prior sandboxed SOX_HOME used as the host base
 *                        (skills/MCP landed under <old-sandbox>/.claude). When given,
 *                        user-scope skills + ~/.claude.json mcpServers are re-placed
 *                        into the REAL ~/.claude. (Often == --old-home.)
 *   --new-home <dir>     The new data root (default: $SOX_ECOSYSTEM_HOME or
 *                        ~/.adhd/sox-ecosystem).
 *   --dry-run            Print the plan; change nothing.
 */
async function cmdMigrateHome(flags: Record<string, string>): Promise<void> {
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} migrate-home — relocate soxe data to the ADR-0004 layout

Usage:
  ${CLI} migrate-home [--old-home <dir>] [--old-config <dir>] [--old-sandbox <dir>] [--new-home <dir>] [--dry-run]

Moves install-registry.json, supervisors.json, ext/ stores, ledgers, and lockfiles
into ~/.adhd/sox-ecosystem/ (or $SOX_ECOSYSTEM_HOME). With --old-sandbox, re-places
user-scope skills + ~/.claude.json MCP entries from the sandboxed path to the REAL
~/.claude. Idempotent.
`);
    process.exit(0);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const osMod = require('node:os') as typeof import('node:os');
  const HOME = osMod.homedir();
  const dryRun = flags['dry-run'] !== undefined;

  const oldHome = flags['old-home'] ?? process.env['SOX_HOME'] ?? pathMod.join(HOME, '.sox');
  const oldConfig = flags['old-config'] ?? pathMod.join(HOME, '.config', 'extensions');
  const oldSandbox = flags['old-sandbox'];
  const newHome = flags['new-home']
    ?? process.env['SOX_ECOSYSTEM_HOME']
    ?? pathMod.join(HOME, '.adhd', 'sox-ecosystem');

  const log = (m: string): void => { process.stdout.write(`${CLI} migrate-home: ${m}\n`); };
  log(`old data root : ${oldHome}`);
  log(`old config dir: ${oldConfig}`);
  log(`new data root : ${newHome}`);
  if (oldSandbox !== undefined) log(`old sandbox   : ${oldSandbox} (skills/MCP re-placement source)`);
  if (dryRun) log('DRY RUN — no changes will be written');

  let moved = 0;
  let skipped = 0;

  const ensureDir = (d: string): void => { if (!dryRun) fsMod.mkdirSync(d, { recursive: true }); };
  ensureDir(newHome);

  // Move a top-level data file (idempotent: skip if the target already exists).
  const moveFile = (relFrom: string, fromRoot: string, toName: string): void => {
    const src = pathMod.join(fromRoot, relFrom);
    const dst = pathMod.join(newHome, toName);
    if (!fsMod.existsSync(src)) return;
    if (fsMod.existsSync(dst)) { log(`skip (exists): ${toName}`); skipped++; return; }
    log(`move: ${src} → ${dst}`);
    if (!dryRun) { ensureDir(newHome); fsMod.renameSync(src, dst); }
    moved++;
  };

  // Move a directory subtree (ext/ stores, run/ state). Idempotent per-entry.
  const moveDir = (src: string, dst: string): void => {
    if (!fsMod.existsSync(src)) return;
    if (!dryRun) ensureDir(dst);
    for (const ent of fsMod.readdirSync(src, { withFileTypes: true })) {
      const s = pathMod.join(src, ent.name);
      const d = pathMod.join(dst, ent.name);
      if (fsMod.existsSync(d)) { skipped++; continue; }
      log(`move: ${s} → ${d}`);
      if (!dryRun) fsMod.renameSync(s, d);
      moved++;
    }
  };

  // 1. Global state files: install-registry.json, supervisors.json.
  moveFile('install-registry.json', oldHome, 'install-registry.json');
  moveFile('supervisors.json', oldHome, 'supervisors.json');

  // 2. Materialized service stores: <oldHome>/ext/ → <newHome>/ext/.
  moveDir(pathMod.join(oldHome, 'ext'), pathMod.join(newHome, 'ext'));

  // 3. Legacy user ledger (<oldHome>/ledger.json) → <newHome>/ledger.json.
  moveFile('ledger.json', oldHome, 'ledger.json');

  // 4. Legacy user config/lockfile (~/.config/extensions) → <newHome>.
  moveFile('extensions.json', oldConfig, 'extensions.json');
  moveFile('extensions.lock', oldConfig, 'extensions.lock');

  // 5. Re-place user-scope skills + MCP from the sandboxed path to the REAL ~/.claude.
  if (oldSandbox !== undefined) {
    const sbxSkills = pathMod.join(oldSandbox, '.claude', 'skills');
    const realSkills = pathMod.join(HOME, '.claude', 'skills');
    if (fsMod.existsSync(sbxSkills)) {
      if (!dryRun) fsMod.mkdirSync(realSkills, { recursive: true });
      for (const ent of fsMod.readdirSync(sbxSkills, { withFileTypes: true })) {
        const s = pathMod.join(sbxSkills, ent.name);
        const d = pathMod.join(realSkills, ent.name);
        if (fsMod.existsSync(d)) { log(`skip skill (exists): ${ent.name}`); skipped++; continue; }
        log(`re-place skill: ${s} → ${d}`);
        if (!dryRun) fsMod.cpSync(s, d, { recursive: true });
        moved++;
      }
    }
    // MCP: re-place sandboxed <oldSandbox>/.claude.json mcpServers into the real
    // ~/.claude.json — WITH ownership + ledger tracking via registerUserMcpServer.
    // A raw JSON merge here is an UNTRACKED injection ([inv:no-untracked-injection]
    // violation): invisible to discovery (upgrade --force found nothing for a
    // migrated server) and irreversible on uninstall. The tracked path records the
    // ledger action (reversal) AND the ownership config-key (inventory/discovery),
    // co-located in the destination data root (newHome), exactly like a fresh install.
    const sbxMcp = pathMod.join(oldSandbox, '.claude.json');
    const realMcp = pathMod.join(HOME, '.claude.json');
    if (fsMod.existsSync(sbxMcp)) {
      try {
        const sbxCfg = JSON.parse(fsMod.readFileSync(sbxMcp, 'utf8')) as { mcpServers?: Record<string, unknown> };
        const realCfg = fsMod.existsSync(realMcp)
          ? JSON.parse(fsMod.readFileSync(realMcp, 'utf8')) as { mcpServers?: Record<string, unknown> }
          : {};
        const srcServers = sbxCfg.mcpServers ?? {};
        const realServers = realCfg.mcpServers ?? {};
        for (const [k, v] of Object.entries(srcServers)) {
          if (realServers[k] !== undefined) { skipped++; continue; }
          log(`re-place MCP: mcpServers.${k} → ~/.claude.json (tracked)`);
          if (!dryRun) {
            await registerUserMcpServer({
              extId: k,
              serverEntry: v,
              host: 'claude',
              scopeRoot: newHome,
              workspaceRoot: HOME,
            });
          }
          moved++;
        }
      } catch (e) {
        process.stderr.write(`${CLI} migrate-home: warning: could not re-place MCP from ${sbxMcp}: ${String(e)}\n`);
      }
    }
  }

  log(`done — ${moved} moved, ${skipped} already-present (idempotent)${dryRun ? ' [dry-run]' : ''}`);
  process.exit(0);
}

// ─── status (R7 / P7) ─────────────────────────────────────────────────────────

/**
 * HealthRecord — live health snapshot for a single running extension.
 * Populated by probing the global supervisor registry + runtime.json + run-history.json.
 */
interface HealthRecord {
  /** Extension ID as declared in extension.json */
  id: string;
  /** Versioned key as stored in the lockfile (e.g. "memory-server@0.1.0") */
  key: string;
  scope: string;
  /** The supervisor's root directory (--root used at soxe start time) */
  root: string;
  /** Basename of root — used in the table PROJECT column for readability */
  project: string;
  /** Stable supervisor identifier: sha256(scope + ":" + root)[0..12] */
  supervisorId: string;
  /** ISO 8601 timestamp when the supervisor activated this extension */
  activatedAt: string;
  /** Elapsed seconds since activatedAt (current session only) */
  uptimeSeconds: number;
  /** OS process check: process.kill(pid, 0) returned true */
  pidAlive: boolean;
  pid: number | null;
  /** Exec socket connectivity (list request round-trip succeeded within 2s) */
  socketReachable: boolean;
  /** Round-trip latency in ms for the socket ping, or null if unreachable */
  socketLatencyMs: number | null;
  /** Last N lines of the extension's log file (only populated in detail view) */
  logTail: string[];
  /** Path to the active log file */
  logPath: string | null;
  /** ISO 8601 timestamp when the supervisor last spawned this extension */
  lastStartedAt: string | null;
  /** ISO 8601 timestamp when the extension last stopped, or null if currently running */
  lastStoppedAt: string | null;
  /** Duration in ms of the last completed run, or null if still running or no prior run */
  lastRunDurationMs: number | null;
  /** Cumulative uptime in ms across all runs recorded in the current supervisor session */
  totalUptimeMs: number;
  /**
   * Derived:
   *   healthy   — pid alive + socket reachable (or in-process adapter, socket reachable)
   *   degraded  — pid alive but socket unreachable, or orphan process, or crash-loop
   *   dead      — no pid (and no schedule explaining the absence)
   *   scheduled — OS interval unit (StartInterval/StartCalendarInterval) loaded by
   *               launchd/systemd but not currently running (between firings); this is
   *               healthy by design (BL-185, [inv:list-never-lies])
   */
  status: 'healthy' | 'degraded' | 'dead' | 'scheduled';
  /** OS supervisor kind (e.g. 'launchd', 'systemd') when managed by OS unit */
  osKind?: string;
  /** OS supervisor exit code when process exited (null if alive or unknown) */
  osExitCode?: number | null;
  /** When the extension manifest is newer than the generated OS unit, describes what changed */
  staleReason?: string;
  /**
   * BL-162 remainder — enrichment pipeline health (additive, never breaks on absence).
   * Set when a memory_ping RPC via the exec socket reveals store.enrichment.state ===
   * 'stalled'. The service status is promoted to 'degraded' with this reason.
   */
  enrichmentReason?: string;
  /**
   * BL-185 — for SCHEDULED os-units: the launchd LastExitStatus of the most recent run.
   * Null when the unit has never fired or the value is unavailable.
   */
  scheduleLastExitCode?: number | null;
}

/**
 * BL-50: Probe a Unix domain socket for raw TCP-level reachability (connection-only,
 * no application protocol). Used to test if a service health socket is already live
 * before spawning a second instance.
 *
 * Returns true iff a connection can be established within `timeoutMs`.
 * Does NOT send or read any data — pure connection test.
 */
async function probeUnixSocketLive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  const net = require('node:net') as typeof import('node:net');
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ path: socketPath });
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (timer.unref) timer.unref();
    sock.once('connect', () => { clearTimeout(timer); done(true); });
    sock.once('error', () => { clearTimeout(timer); done(false); });
  });
}

/**
 * BL-50: Resolve the health socket path for a service from its manifest lifecycle block.
 * Expands tilde and substitutes ${SOX_CONFIG_*} placeholders using the given config env.
 * Returns null if no socket health check is declared.
 */
function resolveServiceHealthSocketPath(
  storePath: string,
  configEnv: Record<string, string>,
): string | null {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const osMod = require('node:os') as typeof import('node:os');

  const manifestPath = pathMod.join(storePath, 'extension.json');
  if (!fsMod.existsSync(manifestPath)) return null;

  let manifest: {
    lifecycle?: {
      health?: { type?: string; endpoint?: string };
    };
  };
  try {
    manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return null;
  }

  const health = manifest.lifecycle?.health;
  if (health?.type !== 'socket' || !health.endpoint) return null;

  // Substitute ${SOX_CONFIG_*} placeholders with resolved config values.
  let endpoint = health.endpoint;
  endpoint = endpoint.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, varName: string) => {
    return configEnv[varName] ?? process.env[varName] ?? _m;
  });

  // Expand leading tilde.
  if (endpoint.startsWith('~/')) {
    endpoint = pathMod.join(osMod.homedir(), endpoint.slice(2));
  } else if (endpoint === '~') {
    endpoint = osMod.homedir();
  }

  return endpoint;
}

/**
 * Slice 1 (docs/spec/service-lifecycle.md §4.3/§5.2): resolve the canonical
 * store-resource an extension binds AT a given scope. Builds that scope's config
 * env, reads the manifest, and derives the `[def:singleton-key]` anchor
 * (db_path → socket → host:port). Returns kind 'none' when no resource is
 * declared or the scope has no install/config.
 */
function resolveStoreResourceForScope(
  extId: string,
  storePath: string,
  scope: string,
  root: string,
): StoreResource {
  const pathMod = require('node:path') as typeof import('node:path');
  const fsMod = require('node:fs') as typeof import('node:fs');
  const configEnv = buildExtConfigEnv(extId, root);
  // Prefer the per-scope materialized store's manifest; fall back to the given
  // storePath's manifest (they are the same for the live scope).
  let manifestPath = pathMod.join(storePath, 'extension.json');
  if (!fsMod.existsSync(manifestPath)) {
    try {
      const sp = getScopePaths(scope as DataScope, root);
      const storeRoot = pathMod.join(pathMod.dirname(sp.lockfile), 'ext', extId);
      manifestPath = pathMod.join(storeRoot, 'extension.json');
    } catch { /* keep original */ }
  }
  return resolveStoreResource(manifestPath, configEnv);
}

/**
 * Slice 1 (§5.2 step 4): collect the store-resource each OTHER scope resolves
 * for `extId`, so the start guard can detect a cross-scope collision (two scopes
 * sharing one backing store). Only scopes that actually have an install of the
 * extension in their lockfile are considered.
 */
function collectCrossScopeResources(
  extId: string,
  root: string,
  excludeScope: string,
): ScopeResource[] {
  const pathMod = require('node:path') as typeof import('node:path');
  const out: ScopeResource[] = [];
  for (const sc of ['org', 'user', 'project', 'local'] as const) {
    if (sc === excludeScope) continue;
    let sp: { lockfile: string };
    try {
      sp = getScopePaths(sc, root);
    } catch {
      continue;
    }
    const lf = loadLockfile(sp.lockfile);
    const installed =
      lf?.resolved?.[extId] !== undefined ||
      Object.keys(lf?.resolved ?? {}).some((k) => k.startsWith(extId + '@'));
    if (!installed) continue;
    const storeRoot = pathMod.join(pathMod.dirname(sp.lockfile), 'ext', extId);
    out.push({ scope: sc, resource: resolveStoreResourceForScope(extId, storeRoot, sc, root) });
  }
  return out;
}

/**
 * Slice 1: derive the entrypoint identity token (the absolute artifact path the
 * reaper matches in argv) for a service-registry entry. Prefers the `.js`
 * entrypoint among the spawn args; falls back to `<storePath>/dist/index.js`.
 */
function entrypointTokenForService(
  svc: { args?: string[]; storePath: string },
): string {
  const pathMod = require('node:path') as typeof import('node:path');
  const jsArg = (svc.args ?? []).find((a) => a.endsWith('.js'));
  if (jsArg) return identityToken(jsArg);
  return identityToken(pathMod.join(svc.storePath, 'dist', 'index.js'));
}

/**
 * Probe a single extension's exec socket reachability by sending a { list: true }
 * JSON request. Returns { reachable, latencyMs }.
 *
 * Reuses the existing listViaExecSocket helper which exercises the full socket
 * stack. Latency is measured from connection-open to response-parsed.
 */
async function probeSocketReachability(
  socketPath: string,
  timeoutMs = 2000,
): Promise<{ reachable: boolean; latencyMs: number | null }> {
  const t0 = Date.now();
  try {
    await listViaExecSocket(socketPath, undefined, timeoutMs);
    return { reachable: true, latencyMs: Date.now() - t0 };
  } catch {
    return { reachable: false, latencyMs: null };
  }
}

/**
 * Read run history from <logDir>/run-history.json and compute per-extension stats.
 * Returns a map of extId → { lastStartedAt, lastStoppedAt, lastRunDurationMs, totalUptimeMs }.
 */
function readRunStats(logDir: string): Map<string, {
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastRunDurationMs: number | null;
  totalUptimeMs: number;
}> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const result = new Map<string, {
    lastStartedAt: string | null;
    lastStoppedAt: string | null;
    lastRunDurationMs: number | null;
    totalUptimeMs: number;
  }>();

  const histPath = pathMod.join(logDir, 'run-history.json');
  if (!fsMod.existsSync(histPath)) return result;

  let hist: {
    version: number; runs: Array<{
      extId: string;
      startedAt: string;
      stoppedAt: string | null;
      exitCode: number | null;
      stopReason: string | null;
    }>
  };
  try {
    hist = JSON.parse(fsMod.readFileSync(histPath, 'utf8')) as typeof hist;
  } catch {
    return result;
  }

  // Group runs by extId.
  const byExt = new Map<string, typeof hist.runs>();
  for (const run of hist.runs) {
    if (!byExt.has(run.extId)) byExt.set(run.extId, []);
    byExt.get(run.extId)!.push(run);
  }

  for (const [extId, runs] of byExt.entries()) {
    if (runs.length === 0) continue;
    const last = runs[runs.length - 1]!;
    let totalUptimeMs = 0;
    for (const run of runs) {
      if (run.stoppedAt) {
        totalUptimeMs += new Date(run.stoppedAt).getTime() - new Date(run.startedAt).getTime();
      } else {
        // Currently running — count up to now.
        totalUptimeMs += Date.now() - new Date(run.startedAt).getTime();
      }
    }
    const lastRunDurationMs = last.stoppedAt
      ? new Date(last.stoppedAt).getTime() - new Date(last.startedAt).getTime()
      : null;
    result.set(extId, {
      lastStartedAt: last.startedAt,
      lastStoppedAt: last.stoppedAt,
      lastRunDurationMs,
      totalUptimeMs,
    });
  }
  return result;
}

/**
 * Find the most recent log file for the given extId in logDir.
 */
function findMostRecentLogFile(logDir: string, extId: string): string | null {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  if (!fsMod.existsSync(logDir)) return null;
  try {
    const files = fsMod.readdirSync(logDir)
      .filter((f: string) => f.startsWith(`${extId}-`) && f.endsWith('.log'))
      .sort();
    if (files.length === 0) return null;
    return pathMod.join(logDir, files[files.length - 1] as string);
  } catch {
    return null;
  }
}

/**
 * cmdStatus — R7 health surface.
 *
 * Usage:
 *   soxe status [--id=<extId>] [--project=<path>] [--scope=user|project|local]
 *              [--json] [--lines=<n>]
 *
 * Default (no flags): read ~/.sox/supervisors.json, GC stale entries, probe
 * every extension across all live supervisors and render a health table.
 *
 * Filtering (ANDed):
 *   --id=<extId>       filter by extension id (matches across projects)
 *   --project=<path>   filter by supervisor root (absolute or basename)
 *   --scope=<scope>    filter by scope
 *
 * When --id matches exactly one extension, switches to the detail view with
 * a log tail (last --lines lines, default 20).
 *
 * Exit codes:
 *   0 — all healthy
 *   1 — any degraded (pid alive, socket unreachable)
 *   2 — any dead (pid not found)
 */
async function cmdStatus(flags: Record<string, string>): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  const filterId = flags['_'] ?? flags['id'];
  const filterProject = flags['project'];
  const filterScope = flags['scope'];
  const jsonMode = flags['json'] !== undefined;
  const linesArg = parseInt(flags['lines'] ?? '20', 10);
  const logLines = Number.isFinite(linesArg) && linesArg > 0 ? linesArg : 20;

  // R2 / BL-176: fast-path reconcile — phase 0 (lazy GC: returns only live
  // supervisors, dead entries cleaned up) + phase 3 (split-brain runtime.json
  // heal, persisted) on every `status` invocation ([inv:list-never-lies], §10.2).
  const { liveSupervisors } = await quickReconcile({ root: process.cwd() });
  const hasRuntimeSupervisors = liveSupervisors.length > 0;

  // PI-5 / BL-141: detect lockfile-empty-but-registry-populated divergence.
  // When the install-registry has records but scope lockfiles are empty/missing,
  // the user likely has a stale system that needs `soxe install` to re-sync.
  try {
    const regPath = installRegistryPath();
    const reg = readInstallRegistry(regPath);
    if (reg.installs.length > 0) {
      // Check user scope lockfile (most common)
      const userLockPath = getScopePaths('user', process.cwd()).lockfile;
      const userLock = loadLockfile(userLockPath);
      if (userLock === null || Object.keys(userLock.resolved).length === 0) {
        process.stdout.write(
          `${CLI} status: WARNING — install-registry has ${reg.installs.length} record(s) but user-scope lockfile at ${userLockPath} ` +
          `is empty/missing. Run '${CLI} install' to re-sync.\n\n`,
        );
      }
    }
  } catch { /* best-effort */ }

  // ── Collect HealthRecords from all live supervisors ─────────────────────────
  const records: HealthRecord[] = [];

  for (const sup of liveSupervisors) {
    // Apply project filter.
    if (filterProject !== undefined) {
      const rootBase = pathMod.basename(sup.root);
      if (sup.root !== filterProject && rootBase !== filterProject) continue;
    }
    // Apply scope filter.
    if (filterScope !== undefined && sup.scope !== filterScope) continue;

    // Read runtime.json for this supervisor.
    if (!fsMod.existsSync(sup.runtimeFilePath)) continue;
    let runtimeEntries: Array<{
      id: string;
      key?: string;
      running?: boolean;
      pid?: number | null;
      activatedAt?: string;
    }> = [];
    try {
      const rec = JSON.parse(fsMod.readFileSync(sup.runtimeFilePath, 'utf8')) as {
        entries?: Array<{ id: string; key?: string; running?: boolean; pid?: number | null; activatedAt?: string }>;
      };
      runtimeEntries = rec.entries ?? [];
    } catch {
      continue;
    }

    // Read run history for all extensions under this supervisor (ADR-0004 §D2).
    const logDir = logDirFor(sup.supervisorId);
    const runStats = readRunStats(logDir);

    // Probe socket reachability once per supervisor (not per extension).
    // The socket is supervisor-level; all extensions share it.
    const { reachable: socketReachable, latencyMs: socketLatencyMs } =
      await probeSocketReachability(sup.execSocketPath);

    for (const rtEntry of runtimeEntries) {
      const extId = rtEntry.id;
      const key = rtEntry.key ?? extId;
      const atIdx = key.lastIndexOf('@');
      const version = atIdx === -1 ? '' : key.slice(atIdx + 1);

      // Apply id filter.
      if (filterId !== undefined && extId !== filterId) continue;

      const pid = (rtEntry.pid != null && typeof rtEntry.pid === 'number')
        ? rtEntry.pid
        : null;

      // C4: pid liveness via OS signal.
      const pidAlive = pid !== null && (() => {
        try { process.kill(pid, 0); return true; }
        catch { return false; }
      })();

      const activatedAt = rtEntry.activatedAt ?? sup.startedAt;
      const uptimeSeconds = Math.floor(
        (Date.now() - new Date(activatedAt).getTime()) / 1000,
      );

      // Find log file for this extension.
      const logPath = findMostRecentLogFile(logDir, extId);

      // Run stats from run-history.json.
      const stats = runStats.get(extId) ?? {
        lastStartedAt: null,
        lastStoppedAt: null,
        lastRunDurationMs: null,
        totalUptimeMs: 0,
      };

      // Derive health status.
      // In-process adapters (agent/hook/command) have no pid — they live inside
      // the supervisor process.  Their health mirrors the supervisor socket:
      //   • socket reachable + rtEntry.running=true → healthy
      //   • socket unreachable                      → dead
      // Spawned extensions (mcp-server) have a pid and are probed directly.
      let status: HealthRecord['status'];
      const inProcess = pid === null && (rtEntry as { running?: boolean }).running === true;
      if (inProcess) {
        status = socketReachable ? 'healthy' : 'dead';
      } else if (!pidAlive) {
        status = 'dead';
      } else if (!socketReachable) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      // BL-162 remainder — enrichment pipeline health (Part 1).
      // When the extension is healthy and the exec socket is reachable, attempt a
      // memory_ping RPC to check store.enrichment.state. If any store reports
      // 'stalled', demote status to 'degraded' with a descriptive reason.
      // Additive: missing fields (older servers, non-memory extensions) → no change.
      // Timeout is short (2 s default) so status output stays fast; overridable
      // via SOX_STATUS_PING_TIMEOUT_MS (integration tests raise it — under CPU
      // contention a fixed 2 s probe times out and silently skips the demotion).
      let enrichmentReason: string | undefined;
      if (status === 'healthy' && socketReachable && sup.execSocketPath) {
        try {
          const pingTimeoutMs =
            Number(process.env['SOX_STATUS_PING_TIMEOUT_MS']) > 0
              ? Number(process.env['SOX_STATUS_PING_TIMEOUT_MS'])
              : 2000;
          const pingResult = await callViaExecSocket(
            sup.execSocketPath, extId, 'memory_ping', {}, pingTimeoutMs,
          ) as null | { content?: Array<{ text?: string }> };
          // MCP tool result wraps JSON in content[0].text
          const rawText = pingResult?.content?.[0]?.text;
          if (rawText) {
            const ping = JSON.parse(rawText) as {
              store?: {
                enrichment?: { state?: string; oldest_pending_at?: string | null };
              };
            };
            const enrich = ping.store?.enrichment;
            if (enrich?.state === 'stalled') {
              status = 'degraded';
              const age = enrich.oldest_pending_at != null
                ? `oldest pending ${formatDuration(Date.now() - new Date(enrich.oldest_pending_at).getTime())} ago`
                : 'age unknown';
              enrichmentReason = `enrichment stalled: ${age}`;
            }
          }
        } catch { /* best-effort: non-memory extensions, socket errors, timeouts → no change */ }
      }

      records.push({
        id: extId,
        key: `${extId}@${version}`,
        scope: sup.scope,
        root: sup.root,
        project: pathMod.basename(sup.root),
        supervisorId: sup.supervisorId,
        activatedAt,
        uptimeSeconds,
        pidAlive,
        pid,
        socketReachable,
        socketLatencyMs,
        logTail: [],   // populated only in detail view
        logPath,
        lastStartedAt: stats.lastStartedAt,
        lastStoppedAt: stats.lastStoppedAt,
        lastRunDurationMs: stats.lastRunDurationMs,
        totalUptimeMs: stats.totalUptimeMs,
        status,
        ...(enrichmentReason !== undefined ? { enrichmentReason } : {}),
      });
    }
  }

  const seenIds = new Set(records.map((r) => r.id));

  // ── Also scan OS units from the ownership index ─────────────────────────────
  // Extensions installed as OS-supervised services (launchd/systemd) that aren't
  // tracked by a runtime supervisor are probed here.

  // Build a lookup of installed extensions' manifest paths (for staleness checks).
  const manifestPathFor: Map<string, string> = new Map();
  try {
    const reg = readInstallRegistry(installRegistryPath());
    for (const inst of reg.installs) {
      const key = `${inst.scope}:${inst.extId}`;
      if (manifestPathFor.has(key)) continue;
      const extDir = resolveExtensionDir(inst.source, inst.root);
      if (!extDir) continue;
      const candidate = pathMod.join(extDir, 'extension.json');
      if (fsMod.existsSync(candidate)) manifestPathFor.set(key, candidate);
    }
  } catch { /* best-effort */ }

  {
    for (const sc of ['org', 'user', 'project', 'local'] as const) {
      if (filterScope !== undefined && sc !== filterScope) continue;
      let dir: string;
      try { dir = dataRoot(sc as DataScope); } catch { continue; }
      const ownPath = pathMod.join(dir, 'ownership.json');
      let own: OwnershipIndex;
      try { own = OwnershipIndex.loadFromFile(ownPath); } catch { continue; }
      for (const rec of own.all()) {
        if (filterId !== undefined && rec.extId !== filterId) continue;
        if (rec.scope !== sc) continue;
        for (const e of rec.entries) {
          if (e.kind !== 'os-unit') continue;
          if (seenIds.has(rec.extId)) continue;
          seenIds.add(rec.extId);

          const osKind: string = e.supervisor;
          const platform = getOsUnitPlatform(osKind as OsSupervisor);
          const loaded = platform.isLoaded(e.label, realOsExec);

          // Probe process-level health from the OS supervisor.
          let pid: number | null = null;
          let pidAlive = false;
          let osExitCode: number | null = null;
          let osOrphanPids: number[] = [];
          if (loaded && osKind === 'launchd') {
            const probe = realOsExec('launchctl', ['list', e.label]);
            if (probe.code === 0) {
              const pidMatch = probe.stdout.match(/"PID"\s*=\s*(\d+)/);
              if (pidMatch) {
                pid = parseInt(pidMatch[1]!, 10);
                pidAlive = true;
              }
              const exitMatch = probe.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
              if (exitMatch) osExitCode = parseInt(exitMatch[1]!, 10);
            }
          } else if (loaded && osKind === 'systemd') {
            const probe = realOsExec('systemctl', ['--user', 'is-active', platform.unitFileName(e.label)]);
            pidAlive = probe.code === 0 && probe.stdout.trim() === 'active';
          }

          // BL-185: detect interval schedule from the unit file (additive, never breaks
          // on missing/unreadable unit). Uses isScheduledOsUnitContent from os-unit.ts
          // which checks launchd StartInterval/StartCalendarInterval and systemd
          // OnUnitActiveSec/OnCalendar (paired .timer file). See that function for full
          // rules.
          let isScheduled = false;
          let plistContent = '';
          if (!pidAlive && loaded && fsMod.existsSync(e.unitPath)) {
            try {
              plistContent = fsMod.readFileSync(e.unitPath, 'utf8');
              isScheduled = isScheduledOsUnitContent(plistContent);
            } catch { /* best-effort */ }
          }
          // systemd timer seam: check for the paired .timer file.
          if (!pidAlive && loaded && osKind === 'systemd' && !isScheduled) {
            const timerPath = e.unitPath.replace(/\.service$/, '.timer');
            if (fsMod.existsSync(timerPath)) {
              try {
                const timerContent = fsMod.readFileSync(timerPath, 'utf8');
                isScheduled = isScheduledOsUnitContent(timerContent);
              } catch { /* best-effort */ }
            }
          }

          // If the OS supervisor says dead, check for orphan processes still running
          // (launchd unit was unloaded/replaced but the process survived).
          if (!pidAlive && !isScheduled && osKind === 'launchd' && fsMod.existsSync(e.unitPath)) {
            try {
              // Reuse the already-read plistContent if available.
              const plist = plistContent || fsMod.readFileSync(e.unitPath, 'utf8');
              const argsSection = plist.split('<key>ProgramArguments</key>')[1]?.split('</array>')[0];
              if (argsSection) {
                const argRe = /<string>(.*?)<\/string>/g;
                let argMatch: RegExpExecArray | null;
                let lastArg: string | null = null;
                while ((argMatch = argRe.exec(argsSection)) !== null) {
                  lastArg = argMatch[1]!;
                }
                if (lastArg) {
                  osOrphanPids = findOrphansByIdentity(
                    identityToken(`file://${lastArg}`),
                    { excludePids: [process.pid] },
                  ).map((m) => m.pid);
                }
              }
            } catch { /* best-effort */ }
          }

          // Determine health: OS-supervised process > orphan survivor > dead.
          let isOrphan = false;
          if (!pidAlive && osOrphanPids.length > 0) {
            pid = osOrphanPids[0]!;
            pidAlive = true;
            isOrphan = true;
          }

          // Find the OS log file (stderr preferred, fall back to stdout).
          const osLogDir = logDirFor(`os-${sc}-${rec.extId}`);
          let osLogFile = findMostRecentLogFile(osLogDir, rec.extId);
          if (osLogFile) {
            const osErrFile = findMostRecentLogFile(osLogDir, `${rec.extId}-os`);
            if (osErrFile) osLogFile = osErrFile;
          }

          // Determine last-stopped timestamp for dead processes.
          let activatedAt = '';
          let lastStoppedAt: string | null = null;
          if (pidAlive) {
            // Read actual process start time from OS so uptime is accurate.
            try {
              const ps = realOsExec('ps', ['-o', 'lstart=', '-p', String(pid)]);
              if (ps.code === 0 && ps.stdout.trim()) {
                const d = new Date(ps.stdout.trim());
                if (!isNaN(d.getTime())) activatedAt = d.toISOString();
              }
            } catch { /* fall through */ }
            if (!activatedAt) activatedAt = new Date().toISOString();
          } else {
            if (osLogFile) {
              try {
                const mtime = fsMod.statSync(osLogFile).mtime;
                lastStoppedAt = mtime.toISOString();
              } catch { /* fall through */ }
            }
            activatedAt = '';
          }

          // BL-185: SCHEDULED supersedes DEAD when the unit is a loaded interval
          // job between firings. DEAD remains correct for: (a) non-interval units
          // with no pid; (b) interval units that launchd no longer has loaded.
          // ([inv:list-never-lies]: "no current pid" ≠ "dead" for a tick job.)
          const status: HealthRecord['status'] = pidAlive
            ? (isOrphan ? 'degraded' : 'healthy')
            : (isScheduled ? 'scheduled' : 'dead');

          // Check if the extension manifest is newer than the generated OS unit.
          let staleReason: string | undefined;
          const manifestCandidate = manifestPathFor.get(`${sc}:${rec.extId}`);
          if (manifestCandidate && fsMod.existsSync(e.unitPath)) {
            try {
              const manifestMtime = fsMod.statSync(manifestCandidate).mtimeMs;
              const unitMtime = fsMod.statSync(e.unitPath).mtimeMs;
              if (manifestMtime > unitMtime + 1000) {
                staleReason = 'manifest updated, re-run `soxe service disable/enable` to reload OS unit';
              }
            } catch { /* best-effort */ }
          }

          records.push({
            id: rec.extId,
            key: `${rec.extId}@os-unit`,
            scope: sc,
            root: '(os-unit)',
            project: isOrphan ? `os-${osKind}-orphan` : (isScheduled ? `os-${osKind}-scheduled` : `os-${osKind}`),
            supervisorId: `os-${osKind}`,
            activatedAt,
            uptimeSeconds: pidAlive ? Math.floor((Date.now() - new Date(activatedAt).getTime()) / 1000) : 0,
            pidAlive,
            pid,
            socketReachable: pidAlive,
            socketLatencyMs: pidAlive ? 0 : null,
            logTail: [],
            logPath: osLogFile,
            lastStartedAt: pidAlive ? activatedAt : null,
            lastStoppedAt,
            lastRunDurationMs: null,
            totalUptimeMs: 0,
            status,
            osKind,
            osExitCode,
            // BL-185: for SCHEDULED units, expose the last exit code as
            // scheduleLastExitCode so the detail view can show "last exit 0".
            ...(isScheduled ? { scheduleLastExitCode: osExitCode ?? null } : {}),
            ...(staleReason ? { staleReason } : {}),
          });
        }
      }
    }
  }

  // ── Also scan installed services not tracked by any manager ─────────────────
  // Service and singleton extensions that are installed but have no runtime
  // supervisor and no OS unit are reported as not-started.
  {
    let registry: { version: number; installs: Array<{ extId: string; scope: string; root: string; source: string }> };
    try {
      registry = readInstallRegistry(installRegistryPath());
    } catch {
      registry = { version: 1, installs: [] };
    }
    for (const rec of registry.installs) {
      if (filterId !== undefined && rec.extId !== filterId) continue;
      if (filterScope !== undefined && rec.scope !== filterScope) continue;
      if (seenIds.has(rec.extId)) continue;

      // Resolve extension dir and read manifest.
      const extDir = resolveExtensionDir(rec.source, rec.root);
      if (!extDir) continue;
      let manifest: { type?: string; entrypoint?: string; lifecycle?: { singleton?: boolean; background?: boolean } };
      try {
        manifest = JSON.parse(fsMod.readFileSync(pathMod.join(extDir, 'extension.json'), 'utf8'));
      } catch { continue; }
      if (manifest.type !== 'service' && manifest.type !== 'mcp-server') continue;

      // Check for orphan processes still running.
      const entrypointPath = manifest.entrypoint
        ? pathMod.resolve(extDir, manifest.entrypoint)
        : null;
      let orphanPids: number[] = [];
      if (entrypointPath) {
        try {
          orphanPids = findOrphansByIdentity(
            identityToken(`file://${entrypointPath}`),
            { excludePids: [process.pid] },
          ).map((m) => m.pid);
        } catch { /* best-effort */ }
      }

      seenIds.add(rec.extId);
      const pidAlive = orphanPids.length > 0;
      const rec_: HealthRecord = {
        id: rec.extId,
        key: `${rec.extId}@not-started`,
        scope: rec.scope,
        root: '(not-started)',
        project: 'not-started',
        supervisorId: 'not-started',
        activatedAt: '',
        uptimeSeconds: 0,
        pidAlive,
        pid: orphanPids[0] ?? null,
        socketReachable: pidAlive,
        socketLatencyMs: pidAlive ? 0 : null,
        logTail: [],
        logPath: null,
        lastStartedAt: null,
        lastStoppedAt: null,
        lastRunDurationMs: null,
        totalUptimeMs: 0,
        status: pidAlive ? 'degraded' : 'dead',
      };
      records.push(rec_);
    }
  }

  // ── PI-1: Identity-based stray reconciliation ────────────────────────────────
  // Run findOrphansByServiceId for every registered install to detect cross-build
  // strays that path-based findOrphansByIdentity cannot match. A cross-build stray
  // is a process whose SOX_SERVICE_ID matches a known install but whose entrypoint
  // path differs from the current artifact (different build version). This section
  // reports them as additional degraded-or-worse health records.
  {
    const registry = readInstallRegistry(installRegistryPath());
    for (const rec of registry.installs) {
      if (filterId !== undefined && rec.extId !== filterId) continue;
      if (filterScope !== undefined && rec.scope !== filterScope) continue;
      if (seenIds.has(rec.extId)) continue;

      const extDir = resolveExtensionDir(rec.source, rec.root);
      if (!extDir) continue;
      let manifest: { type?: string; entrypoint?: string };
      try {
        manifest = JSON.parse(fsMod.readFileSync(pathMod.join(extDir, 'extension.json'), 'utf8'));
      } catch { continue; }
      if (!manifest.type || (manifest.type !== 'service' && manifest.type !== 'mcp-server')) continue;

      const entrypointPath = manifest.entrypoint
        ? pathMod.resolve(extDir, manifest.entrypoint)
        : null;
      const token = entrypointPath ? identityToken(`file://${entrypointPath}`) : '';

      // Use env-based SOX_SERVICE_ID matching to find cross-build strays.
      const crossBuild = findOrphansByServiceId(rec.extId, token, {
        excludePids: [process.pid],
      });

      // Filter out any already caught by the path-based matching above.
      if (entrypointPath) {
        const pathMatched = findOrphansByIdentity(token, { excludePids: [process.pid] });
        const pathPids = new Set(pathMatched.map((m) => m.pid));
        const trulyCrossBuild = crossBuild.filter((m) => !pathPids.has(m.pid));
        if (trulyCrossBuild.length > 0) {
          seenIds.add(rec.extId);
          for (const m of trulyCrossBuild) {
            records.push({
              id: rec.extId + '-cross-build',
              key: `${rec.extId}@cross-build-stray`,
              scope: rec.scope,
              root: '(cross-build)',
              project: 'cross-build-stray',
              supervisorId: 'cross-build',
              activatedAt: '',
              uptimeSeconds: 0,
              pidAlive: true,
              pid: m.pid,
              socketReachable: true,
              socketLatencyMs: 0,
              logTail: [],
              logPath: null,
              lastStartedAt: null,
              lastStoppedAt: null,
              lastRunDurationMs: null,
              totalUptimeMs: 0,
              status: 'degraded',
              staleReason: `CROSS-BUILD STRAY (SOX_SERVICE_ID=${rec.extId}, different entrypoint path) — run \`soxe doctor --fix\` to reap`,
            });
          }
        }
      }
    }
  }

  // ── Live untracked proxy backends ([inv:list-never-lies], BL-216 follow-on) ──
  // The singleton writer of a proxy-mode mcp-server is a detached, socket-holding
  // process tracked by NO supervisor record and NO os-unit pid. Without a row,
  // the board can read "DEAD" (an unused os-unit) while the real writer serves
  // every request — which is exactly what sent the operator down the
  // doctor→--fix→enable path on 2026-07-06. Attribute by socket, the same
  // reality source the reconcile pass uses.
  if (filterProject === undefined) {
    try {
      const knownPids = new Set(
        records.map((r) => r.pid).filter((p): p is number => typeof p === 'number' && p > 0),
      );
      const { backendSocketPath: bsp } =
        require('@adhd/sox-service-proxy') as typeof import('@adhd/sox-service-proxy');
      const seenBackendPids = new Set<number>();
      for (const inst of readInstallRegistry(installRegistryPath()).installs) {
        if (filterId !== undefined && inst.extId !== filterId) continue;
        if (filterScope !== undefined && inst.scope !== filterScope) continue;
        try {
          if (!mcpServerIsProxyMode(inst.extId, inst.scope, inst.root)) continue;
          const resolved = resolveServeManifest(inst.extId, inst.scope, inst.root);
          if (!resolved) continue;
          const configEnv = buildExtConfigEnv(inst.extId, inst.root);
          const storeResource = resolveStoreResource(
            pathMod.join(resolved.extDir, 'extension.json'), configEnv,
          );
          const key = singletonKey(inst.extId, storeResource) ?? `${inst.extId} none:`;
          const sock = bsp(socketDir(), key);
          for (const pid of socketOwnerPids(sock) ?? []) {
            if (knownPids.has(pid) || seenBackendPids.has(pid)) continue;
            seenBackendPids.add(pid);
            // BSD/macOS ps has `etime` ([[dd-]hh:]mm:ss), NOT procps' `etimes`
            // (numeric seconds) — the same portability trap as BL-177.
            let uptimeSeconds = 0;
            const et = realOsExec('ps', ['-o', 'etime=', '-p', String(pid)]);
            if (et.code === 0) {
              const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(et.stdout.trim());
              if (m) {
                uptimeSeconds =
                  (m[1] ? parseInt(m[1], 10) * 86400 : 0) +
                  (m[2] ? parseInt(m[2], 10) * 3600 : 0) +
                  parseInt(m[3]!, 10) * 60 +
                  parseInt(m[4]!, 10);
              }
            }
            const backendLogDir = logDirFor(`proxy-backend-${inst.extId}`);
            const backendLogPath = pathMod.join(
              backendLogDir,
              `${inst.extId}-backend-${new Date().toISOString().slice(0, 10)}.log`,
            );
            records.push({
              id: inst.extId,
              key: `${inst.extId}@proxy-backend`,
              scope: inst.scope,
              root: inst.root ?? '',
              project: 'proxy-backend',
              supervisorId: 'proxy-backend',
              activatedAt: '',
              uptimeSeconds,
              pidAlive: true,
              pid,
              socketReachable: true,
              socketLatencyMs: null,
              logTail: [],
              logPath: fsMod.existsSync(backendLogPath) ? backendLogPath : null,
              lastStartedAt: null,
              lastStoppedAt: null,
              lastRunDurationMs: null,
              totalUptimeMs: uptimeSeconds * 1000,
              status: 'healthy',
            });
          }
        } catch { /* per-extension best-effort — a bad manifest never breaks status */ }
      }
    } catch { /* the proxy scan itself is additive — never break status */ }
  }

  // ── Slice 3 (§11.3, [inv:crash-loop-cap]): surface crash-loop give-up markers ─
  // A capped service is DEGRADED (give-up) — never a silent stop
  // ([inv:list-never-lies]). The marker is written by the supervisor's guard and
  // cleared only by an explicit start/enable.
  try {
    for (const mk of listCrashLoopMarkers(crashLoopMarkerDir())) {
      const baseId = mk.key.includes('@') ? mk.key.slice(0, mk.key.lastIndexOf('@')) : mk.key;
      if (filterId !== undefined && baseId !== filterId) continue;
      const reason =
        `[crash-loop] gave up after ${mk.failures.length} unexpected exits within ${mk.windowMs}ms ` +
        `(capped at ${mk.cappedAt}) — run '${CLI} start --id=${baseId}' to clear`;
      const existing = records.find((r) => r.id === baseId);
      if (existing) {
        if (existing.status === 'healthy') existing.status = 'degraded';
        existing.staleReason = reason;
      } else {
        records.push({
          id: baseId,
          key: mk.key.includes('@') ? mk.key : `${baseId}@crash-loop`,
          scope: filterScope ?? '?',
          root: '(crash-loop)',
          project: 'crash-loop-give-up',
          supervisorId: 'crash-loop',
          activatedAt: '',
          uptimeSeconds: 0,
          pidAlive: false,
          pid: null,
          socketReachable: false,
          socketLatencyMs: null,
          logTail: [],
          logPath: null,
          lastStartedAt: null,
          lastStoppedAt: mk.cappedAt,
          lastRunDurationMs: null,
          totalUptimeMs: 0,
          status: 'degraded',
          staleReason: reason,
        });
      }
    }
  } catch { /* best-effort */ }

  // ── Determine overall exit code ─────────────────────────────────────────────
  let exitCode = 0;
  for (const r of records) {
    if (r.status === 'dead' && exitCode < 2) exitCode = 2;
    else if (r.status === 'degraded' && exitCode < 1) exitCode = 1;
  }

  // ── JSON output ─────────────────────────────────────────────────────────────
  if (jsonMode) {
    // Populate logTail for all records in JSON mode.
    for (const r of records) {
      if (r.logPath) {
        r.logTail = readLastLines(r.logPath, logLines).split('\n').filter((l) => l.length > 0);
      }
    }
    process.stdout.write(JSON.stringify(records, null, 2) + '\n');
    process.exit(exitCode);
  }

  // ── No matching extensions found at all ─────────────────────────────────────
  if (records.length === 0) {
    const parts: string[] = [];
    if (filterId) parts.push(`id=${filterId}`);
    if (filterProject) parts.push(`project=${filterProject}`);
    if (filterScope) parts.push(`scope=${filterScope}`);
    const filterDesc = parts.length > 0 ? ` (filters: ${parts.join(', ')})` : '';
    if (!hasRuntimeSupervisors) {
      process.stdout.write(`${CLI} status: no running services found${filterDesc}\n`);
      process.stdout.write(`  Start the runtime with: ${CLI} start\n`);
    } else {
      process.stdout.write(`${CLI} status: no running extensions found${filterDesc}\n`);
    }
    process.exit(exitCode);
  }

  // ── Single-extension detail view ────────────────────────────────────────────
  if (filterId !== undefined && records.length === 1) {
    const r = records[0]!;
    const uptimeStr = formatDuration(r.uptimeSeconds * 1000);
    const totalUptimeStr = formatDuration(r.totalUptimeMs);
    // BL-185: SCHEDULED renders as "SCHEDULED (last exit N)" derived from the
    // launchd LastExitStatus — not pid presence.
    // BL-162 remainder: enrichmentReason appended when enrichment is stalled.
    let statusTag = r.status.toUpperCase();
    if (r.status === 'scheduled') {
      const exitLabel = r.scheduleLastExitCode != null
        ? `last exit ${r.scheduleLastExitCode}`
        : 'last exit unknown';
      statusTag = `SCHEDULED (${exitLabel})`;
    } else if (r.status === 'degraded' && r.enrichmentReason) {
      statusTag = `DEGRADED (${r.enrichmentReason})`;
    }
    const pidLine = r.pid !== null
      ? `${r.pid}  (${r.pidAlive ? 'alive' : 'dead'})`
      : 'none';
    const socketLine = r.socketReachable
      ? `reachable (latency: ${r.socketLatencyMs ?? '?'}ms)`
      : 'unreachable';
    const lastStopLine = r.lastStoppedAt ?? 'never';
    const logLine = r.logPath ?? 'none';

    const deadSinceStr = r.status === 'dead' && r.lastStoppedAt
      ? `Dead since:   ${r.lastStoppedAt} (${formatDuration(Date.now() - new Date(r.lastStoppedAt).getTime())} ago)`
      : '';
    const osUnitStr = r.osKind ? `OS unit:      ${r.osKind}` : '';
    const osExitStr = r.osKind && r.osExitCode != null ? `OS exit:      ${r.osExitCode}` : '';

    process.stdout.write(`\nExtension:    ${r.id}\n`);
    process.stdout.write(`Key:          ${r.key}\n`);
    process.stdout.write(`Scope:        ${r.scope}\n`);
    process.stdout.write(`Project:      ${r.project} (${r.root})\n`);
    process.stdout.write(`Supervisor:   ${r.supervisorId}\n`);
    process.stdout.write(`Status:       ${statusTag}\n`);
    process.stdout.write(`PID:          ${pidLine}\n`);
    if (osUnitStr) process.stdout.write(`${osUnitStr}\n`);
    if (osExitStr) process.stdout.write(`${osExitStr}\n`);
    if (r.staleReason) process.stdout.write(`Stale:        ${r.staleReason}\n`);
    if (r.enrichmentReason) process.stdout.write(`Enrichment:   STALLED — ${r.enrichmentReason}\n`);
    process.stdout.write(`Socket:       ${socketLine}\n`);
    process.stdout.write(`Uptime:       ${uptimeStr}  (started ${r.activatedAt})\n`);
    process.stdout.write(`Last stop:    ${lastStopLine}\n`);
    if (deadSinceStr) process.stdout.write(`${deadSinceStr}\n`);
    process.stdout.write(`Total uptime: ${totalUptimeStr} (this session)\n`);
    process.stdout.write(`Log:          ${logLine}\n`);

    if (r.logPath) {
      process.stdout.write(`\n--- Last ${logLines} log lines ---\n`);
      const tail = readLastLines(r.logPath, logLines);
      process.stdout.write(tail);
      if (tail.length > 0 && !tail.endsWith('\n')) process.stdout.write('\n');
    }
    process.stdout.write('\n');
    process.exit(exitCode);
  }

  // ── Multi-extension table view ──────────────────────────────────────────────
  const col1 = Math.max(...records.map((r) => r.id.length), 4);
  const col2 = Math.max(...records.map((r) => r.key.length), 7);
  const col3 = Math.max(...records.map((r) => r.scope.length), 5);
  const col4 = Math.max(...records.map((r) => r.project.length), 7);
  // BL-185: SCHEDULED is 9 chars; BL-162: DEGRADED is 7 chars — col5 fits both.
  const col5 = 9; // HEALTHY / DEGRADED / DEAD / SCHEDULED

  process.stdout.write(
    `${'ID'.padEnd(col1)}  ${'KEY'.padEnd(col2)}  ${'SCOPE'.padEnd(col3)}  ${'PROJECT'.padEnd(col4)}  ${'STATUS'.padEnd(col5)}  PID     UPTIME      NOTE\n`,
  );
  process.stdout.write(
    `${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  ${'-'.repeat(col4)}  ${'-'.repeat(col5)}  ------  ----------  ----\n`,
  );
  for (const r of records) {
    const pidStr = r.pid !== null ? String(r.pid) : '';
    const uptimeStr = formatDuration(r.uptimeSeconds * 1000);
    // NOTE column: enrichment stall, scheduled exit, socket latency, or dead indicator.
    let noteStr: string;
    if (r.enrichmentReason) {
      noteStr = `DEGRADED: ${r.enrichmentReason}`;
    } else if (r.status === 'scheduled') {
      const exitLabel = r.scheduleLastExitCode != null
        ? `last exit ${r.scheduleLastExitCode}`
        : 'between runs';
      noteStr = exitLabel;
    } else if (r.socketReachable) {
      // Proxy-backend rows are attributed by socket ownership (no RPC probe) —
      // render the attribution honestly instead of a "?ms" latency.
      noteStr = r.socketLatencyMs != null ? `${r.socketLatencyMs}ms` : 'socket held';
    } else {
      noteStr = r.pidAlive ? 'unreachable' : '—';
    }
    process.stdout.write(
      `${r.id.padEnd(col1)}  ${r.key.padEnd(col2)}  ${r.scope.padEnd(col3)}  ${r.project.padEnd(col4)}  ${r.status.toUpperCase().padEnd(col5)}  ${pidStr.padEnd(6)}  ${uptimeStr.padEnd(10)}  ${noteStr}\n`,
    );
  }
  process.exit(exitCode);
}

// ─── ps (PI-4) ─────────────────────────────────────────────────────────────────

/**
 * cmdPs — show a merged process snapshot: supervisor registry + OS-units +
 * proxy locks/sockets + OS-truth ps scan, flagging UNMANAGED/STALE rows.
 *
 * Usage:
 *   soxe ps [--scope=<scope>] [--json]
 *
 * Negative control: a planted unmanaged stray (process with SOX_SERVICE_ID but
 * NOT in the supervisor registry) appears flagged as UNMANAGED.
 */
async function cmdPs(flags: Record<string, string>): Promise<void> {
  const jsonMode = flags['json'] !== undefined;
  const scope = flags['scope'] ?? 'user';

  // Gather live supervisor registry entries.
  const liveSupers = await readGlobalRegistry();
  const sDir = socketDir();
  const root = dataRoot(scope as DataScope);

  const rows = gatherProcessSnapshot(liveSupers, sDir, root, scope);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    process.exit(0);
  }

  // Human-readable table.
  if (rows.length === 0) {
    process.stdout.write(`${CLI} ps: no processes found for scope "${scope}"\n`);
    process.exit(0);
  }

  const colId = Math.max(20, ...rows.map((r) => r.id.length));
  const colType = 20;
  const colPid = 8;
  const colExt = 20;
  const colStatus = 12;

  process.stdout.write(
    `\x1b[1m${'ID'.padEnd(colId)}  ${'TYPE'.padEnd(colType)}  ${'PID'.padEnd(colPid)}  ${'EXT'.padEnd(colExt)}  ${'STATUS'.padEnd(colStatus)}  DETAIL\x1b[0m\n`,
  );
  process.stdout.write(
    `${'-'.repeat(colId)}  ${'-'.repeat(colType)}  ${'-'.repeat(colPid)}  ${'-'.repeat(colExt)}  ${'-'.repeat(colStatus)}  ------\n`,
  );

  // Sort: alive first, then unmanaged, then stale, then dead.
  const sortOrder: Record<string, number> = { alive: 0, unmanaged: 1, stale: 2, dead: 3 };
  const sorted = [...rows].sort((a, b) => (sortOrder[a.status] ?? 9) - (sortOrder[b.status] ?? 9));

  for (const row of sorted) {
    const pidStr = row.pid > 0 ? String(row.pid) : '—';
    const detail = row.detail ?? '';

    process.stdout.write(
      `${row.id.padEnd(colId)}  ${row.source.padEnd(colType)}  ${pidStr.padEnd(colPid)}  ${row.extId.padEnd(colExt)}  ${(row.status.toUpperCase()).padEnd(colStatus)}  ${detail}\n`,
    );
  }
  process.exit(0);
}

// ─── follow (PI-4) ─────────────────────────────────────────────────────────────

/**
 * cmdFollow — merged, prefixed, colorized live tail (docker-compose semantics)
 * over the PI-3 log layout. Watches ALL log streams for a given extension (or
 * all extensions if no --id).
 *
 * Usage:
 *   soxe follow [--id=<extId>] [--scope=<scope>] [--lines=<n>]
 */
async function cmdFollow(flags: Record<string, string>): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  const id = flags['_'] ?? flags['id'];
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? process.cwd();
  const linesArg = parseInt(flags['lines'] ?? '20', 10);
  const lines = Number.isFinite(linesArg) && linesArg > 0 ? linesArg : 20;

  const supervisorId = computeSupervisorId(scope, root);

  // Discover all stream descriptors.
  const allExtIds: string[] = id ? [id] : discoverExtensionIds(scope, root);

  // Color palette per ext (cycling).
  const EXT_COLORS: string[] = [
    '\x1b[36m', '\x1b[33m', '\x1b[32m', '\x1b[35m', '\x1b[34m', '\x1b[31m',
    '\x1b[96m', '\x1b[93m', '\x1b[92m', '\x1b[95m',
  ];
  const STREAM_COLORS: Record<string, string> = {
    process: '\x1b[36m',
    backend: '\x1b[33m',
    'os-out': '\x1b[32m',
    'os-err': '\x1b[31m',
    serve: '\x1b[35m',
  };
  const RESET = '\x1b[0m';

  // Collect all stream files.
  interface FollowFile {
    extId: string;
    label: string;
    logDir: string;
    path: string;
    fileSize: number;
  }
  const files: FollowFile[] = [];

  for (const extId of allExtIds) {
    const streams = findAllLogStreamsForExt(extId, supervisorId, scope);
    for (const s of streams) {
      const logPath = findMostRecentLogFile(s.logDir, s.filePrefix);
      if (!logPath) continue;
      let fileSize: number;
      try { fileSize = fsMod.statSync(logPath).size; } catch { fileSize = 0; }
      files.push({ extId, label: s.label, logDir: s.logDir, path: logPath, fileSize });
    }
  }

  if (files.length === 0) {
    process.stderr.write(`${CLI} follow: no log files found\n`);
    process.exit(1);
  }

  // Print initial content for each file.
  for (const f of files) {
    const extColorIdx = allExtIds.indexOf(f.extId) % EXT_COLORS.length;
    const extColor = EXT_COLORS[extColorIdx] ?? '';
    const streamColor = STREAM_COLORS[f.label] ?? '';
    const prefix = `${extColor}${f.extId}${RESET}|${streamColor}${f.label.toUpperCase()}${RESET}`;
    const text = readLastLines(f.path, lines);
    for (const line of text.split('\n').filter(Boolean)) {
      process.stdout.write(`${prefix} ${line}\n`);
    }
  }

  // Multi-file follow.
  let watching = true;

  // Watch all unique parent directories.
  const watchedDirs = new Set(files.map((f) => pathMod.dirname(f.path)));
  for (const dir of watchedDirs) {
    if (!fsMod.existsSync(dir)) continue;
    const dirWatcher = fsMod.watch(dir, { persistent: true }, () => {
      if (!watching) return;
      for (const f of files) {
        if (!fsMod.existsSync(f.path)) continue;
        let stat: { size: number };
        try { stat = fsMod.statSync(f.path); } catch { continue; }
        if (stat.size > f.fileSize) {
          const fd = fsMod.openSync(f.path, 'r');
          try {
            const toRead = stat.size - f.fileSize;
            const buf = Buffer.allocUnsafe(toRead);
            fsMod.readSync(fd, buf, 0, toRead, f.fileSize);
            const extColorIdx = allExtIds.indexOf(f.extId) % EXT_COLORS.length;
            const extColor = EXT_COLORS[extColorIdx] ?? '';
            const streamColor = STREAM_COLORS[f.label] ?? '';
            const prefix = `${extColor}${f.extId}${RESET}|${streamColor}${f.label.toUpperCase()}${RESET}`;
            for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
              process.stdout.write(`${prefix} ${line}\n`);
            }
          } finally {
            fsMod.closeSync(fd);
          }
          f.fileSize = stat.size;
        }
      }
    });
    process.on('SIGINT', () => {
      watching = false;
      dirWatcher.close();
      process.exit(0);
    });
  }

  await new Promise<void>(() => { /* never resolves — SIGINT exits */ });
}

/**
 * Discover extension ids installed in a given scope+root by reading the lockfile.
 */
function discoverExtensionIds(scope: string, root: string): string[] {
  const { loadLockfile } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');
  const { scopeConfigPaths } = require('@adhd/sox-host-runtime') as typeof import('@adhd/sox-host-runtime');
  const paths = scopeConfigPaths(scope as DataScope, root);
  const lock = loadLockfile(paths.lockfile);
  if (!lock?.resolved) return [];
  const ids = new Set<string>();
  for (const key of Object.keys(lock.resolved)) {
    const baseId = key.includes('@') ? key.slice(0, key.indexOf('@')) : key;
    if (baseId) ids.add(baseId);
  }
  return [...ids].sort();
}

// ─── logs (R4 / PI-3) ─────────────────────────────────────────────────────────

/**
 * cmdLogs — stream or tail log files for a running extension (R4 / PI-3).
 *
 * PI-3 Unified log keying: discovers ALL streams including proxy-backend logs,
 * OS-unit output logs, and serve logs — not just the supervisor-managed stream.
 *
 * Usage:
 *   soxe logs --id=<extId> [--scope=<scope>] [--lines=<n>] [--follow] [--json]
 *            [--history] [--stream=<label>]
 *
 * --stream=<label>: filter to a specific stream (process, backend, os-out, os-err,
 *                   serve). Without --stream, all discovered streams are shown.
 *
 * Without --follow: prints the last --lines lines (default 100) from each stream.
 * With --follow: watches all stream files for new writes (pure Node.js, no tail).
 * With --history: prints the run-history.json table instead of log lines.
 */
async function cmdLogs(flags: Record<string, string>): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  const id = flags['_'] ?? flags['id'];
  if (!id) {
    process.stderr.write(`${CLI} logs: extension id is required (positional or --id)\n`);
    process.exit(1);
  }

  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? process.cwd();
  const linesArg = parseInt(flags['lines'] ?? '100', 10);
  const lines = Number.isFinite(linesArg) && linesArg > 0 ? linesArg : 100;
  const follow = flags['follow'] !== undefined;
  const jsonMode = flags['json'] !== undefined;
  const showHistory = flags['history'] !== undefined;
  const streamFilter = flags['stream'];

  const supervisorId = computeSupervisorId(scope, root);

  // ── Run history mode (unchanged) ──────────────────────────────────────────
  if (showHistory) {
    const logDir = logDirFor(supervisorId);
    const histPath = pathMod.join(logDir, 'run-history.json');
    if (!fsMod.existsSync(histPath)) {
      process.stdout.write(`${CLI} logs: no run history at ${histPath}\n`);
      process.exit(0);
    }
    let hist: { version: number; runs: Array<{ extId: string; startedAt: string; stoppedAt: string | null; exitCode: number | null; stopReason: string | null }> };
    try {
      hist = JSON.parse(fsMod.readFileSync(histPath, 'utf8')) as typeof hist;
    } catch (e) {
      process.stderr.write(`${CLI} logs: failed to read run history: ${String(e)}\n`);
      process.exit(1);
    }
    const runs = hist.runs.filter((r) => r.extId === id);
    if (jsonMode) {
      process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
      process.exit(0);
    }
    const h1 = 16, h2 = 26, h3 = 26, h4 = 10;
    process.stdout.write(
      `${'EXT'.padEnd(h1)}  ${'STARTED'.padEnd(h2)}  ${'STOPPED'.padEnd(h3)}  ${'DURATION'.padEnd(h4)}  REASON\n`,
    );
    process.stdout.write(
      `${'-'.repeat(h1)}  ${'-'.repeat(h2)}  ${'-'.repeat(h3)}  ${'-'.repeat(h4)}  ------\n`,
    );
    for (const run of [...runs].reverse()) {
      const stopped = run.stoppedAt ?? '—';
      let duration = 'running';
      if (run.stoppedAt) {
        const ms = new Date(run.stoppedAt).getTime() - new Date(run.startedAt).getTime();
        duration = formatDuration(ms);
      }
      const reason = run.stopReason ?? '—';
      process.stdout.write(
        `${run.extId.padEnd(h1)}  ${run.startedAt.padEnd(h2)}  ${stopped.padEnd(h3)}  ${duration.padEnd(h4)}  ${reason}\n`,
      );
    }
    process.exit(0);
  }

  // ── PI-3: Discover all log streams ───────────────────────────────────────
  const streams = findAllLogStreamsForExt(id!, supervisorId, scope)
    .filter((s) => !streamFilter || s.label === streamFilter);

  // Resolve the most recent file for each stream.
  type StreamFile = { label: string; path: string; logDir: string };
  const streamFiles: StreamFile[] = [];
  for (const s of streams) {
    const logPath = findMostRecentLogFile(s.logDir, s.filePrefix);
    if (logPath) {
      streamFiles.push({ label: s.label, path: logPath, logDir: s.logDir });
    }
  }

  if (streamFiles.length === 0) {
    const dirs = streams.map((s) => s.logDir);
    const uniqueDirs = [...new Set(dirs)];
    process.stderr.write(
      `${CLI} logs: no log files found for "${id}" — searched:\n` +
      uniqueDirs.map((d) => `  ${d}`).join('\n') + '\n' +
      `  Make sure the extension has been started at least once.\n`,
    );
    process.exit(1);
  }

  // ── Without --follow: tail last N lines for each stream ──────────────────
  if (!follow) {
    if (jsonMode) {
      const result: Record<string, string[]> = {};
      for (const sf of streamFiles) {
        result[sf.label] = readLastLines(sf.path, lines).split('\n').filter(Boolean);
      }
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      for (const sf of streamFiles) {
        const header = `${'───'} ${sf.label.toUpperCase()} (${sf.path}) ${'───'}`;
        process.stdout.write(header + '\n');
        const text = readLastLines(sf.path, lines);
        process.stdout.write(text);
        if (text.length > 0 && !text.endsWith('\n')) process.stdout.write('\n');
        process.stdout.write('\n');
      }
    }
    process.exit(0);
  }

  // ── With --follow: merged, prefixed, colorized live tail ─────────────────
  // First print the last N lines for each stream, then watch all dirs.
  // Output is prefixed with [streamLabel] so the user can tell sources apart.
  const COLORS: Record<string, string> = {
    process: '\x1b[36m', // cyan
    backend: '\x1b[33m', // yellow
    'os-out': '\x1b[32m', // green
    'os-err': '\x1b[31m', // red
    serve: '\x1b[35m',   // magenta
  };
  const RESET = '\x1b[0m';

  // Print initial content.
  for (const sf of streamFiles) {
    const color = COLORS[sf.label] ?? '\x1b[37m';
    const header = `${color}[${sf.label.toUpperCase()}]${RESET}`;
    const text = readLastLines(sf.path, lines);
    for (const line of text.split('\n').filter(Boolean)) {
      process.stdout.write(`${header} ${line}\n`);
    }
  }

  // Multi-file follow state: per-stream { path, fileSize, logDir, label }.
  interface FollowState {
    label: string;
    logDir: string;
    path: string;
    fileSize: number;
  }
  const watchers: Map<string, FollowState> = new Map();
  for (const sf of streamFiles) {
    let fileSize: number;
    try { fileSize = fsMod.statSync(sf.path).size; } catch { fileSize = 0; }
    watchers.set(sf.label, { label: sf.label, logDir: sf.logDir, path: sf.path, fileSize });
  }
  let watching = true;

  // Re-resolve the latest file for all streams on each dir watch event.
  function refreshStreams(): void {
    const current = findAllLogStreamsForExt(id!, supervisorId, scope)
      .filter((s) => !streamFilter || s.label === streamFilter);
    for (const s of current) {
      const logPath = findMostRecentLogFile(s.logDir, s.filePrefix);
      if (!logPath) continue;
      const existing = watchers.get(s.label);
      if (!existing) {
        // New stream appeared.
        let fileSize: number;
        try { fileSize = fsMod.statSync(logPath).size; } catch { fileSize = 0; }
        watchers.set(s.label, { label: s.label, logDir: s.logDir, path: logPath, fileSize });
      } else if (logPath !== existing.path) {
        // File rotated — reset position.
        existing.path = logPath;
        existing.fileSize = 0;
      }
    }
  }

  // Watch all unique parent directories.
  const watchedDirs = new Set(streamFiles.map((sf) => pathMod.dirname(sf.path)));
  for (const dir of watchedDirs) {
    if (!fsMod.existsSync(dir)) continue;
    const dirWatcher = fsMod.watch(dir, { persistent: true }, () => {
      if (!watching) return;
      refreshStreams();
      // Check all tracked files for new content.
      for (const [, state] of watchers) {
        if (!fsMod.existsSync(state.path)) continue;
        let stat: { size: number };
        try { stat = fsMod.statSync(state.path); } catch { continue; }
        if (stat.size > state.fileSize) {
          const fd = fsMod.openSync(state.path, 'r');
          try {
            const toRead = stat.size - state.fileSize;
            const buf = Buffer.allocUnsafe(toRead);
            fsMod.readSync(fd, buf, 0, toRead, state.fileSize);
            const color = COLORS[state.label] ?? '\x1b[37m';
            // Prepend [LABEL] to each line.
            const lines2 = buf.toString('utf8').split('\n');
            for (const line of lines2) {
              if (line.length > 0) {
                process.stdout.write(`${color}[${state.label.toUpperCase()}]${RESET} ${line}\n`);
              }
            }
          } finally {
            fsMod.closeSync(fd);
          }
          state.fileSize = stat.size;
        }
      }
    });
    // Cleanup on ctrl-c.
    process.on('SIGINT', () => {
      watching = false;
      dirWatcher.close();
      process.exit(0);
    });
  }

  // Keep process alive.
  await new Promise<void>(() => { /* never resolves — SIGINT exits */ });
}

function readLastLines(filePath: string, n: number): string {
  const fsMod = require('node:fs') as typeof import('node:fs');
  let stat: { size: number };
  try {
    stat = fsMod.statSync(filePath);
  } catch {
    return '';
  }
  if (stat.size === 0) return '';

  const CHUNK = 65536; // 64 KB
  let remaining = stat.size;
  let lineCount = 0;
  const parts: Buffer[] = [];

  const fd = fsMod.openSync(filePath, 'r');
  try {
    while (remaining > 0 && lineCount <= n) {
      const toRead = Math.min(CHUNK, remaining);
      remaining -= toRead;
      const buf = Buffer.allocUnsafe(toRead);
      fsMod.readSync(fd, buf, 0, toRead, remaining);
      parts.unshift(buf);
      // Count newlines to know if we have enough.
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] === 10 /* '\n' */) {
          lineCount++;
          if (lineCount > n) break;
        }
      }
    }
  } finally {
    fsMod.closeSync(fd);
  }

  const full = Buffer.concat(parts).toString('utf8');
  const allLines = full.split('\n');
  // Take the last n lines (the initial split may have an empty string at the end).
  const tail = allLines.slice(Math.max(0, allLines.length - n - 1));
  return tail.join('\n');
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── exec (A11) ──────────────────────────────────────────────────────────────

/**
 * callViaExecSocket — send one tool-call request to the supervisor's exec socket.
 *
 * [inv:exec-socket]: The supervisor writes `execSocketPath` into runtime.json when it
 * starts (supervisor mode only). This function connects, sends one JSON line, reads
 * one JSON line back, then closes the connection.  The entire round-trip is handled
 * inside the live supervisor process — no throwaway spawn.
 */
async function callViaExecSocket(
  socketPath: string,
  ext: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const netMod = require('node:net') as typeof import('node:net');
  const rlMod = require('node:readline') as typeof import('node:readline');

  return new Promise((resolve, reject) => {
    const socket = netMod.createConnection(socketPath);
    const rl = rlMod.createInterface({ input: socket, crlfDelay: Infinity });

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${CLI} exec: timeout waiting for exec socket response (${timeoutMs}ms)`)));
    }, timeoutMs);

    rl.once('line', (line: string) => {
      finish(() => {
        try {
          const resp = JSON.parse(line) as { result?: unknown; error?: string };
          if (resp.error !== undefined) {
            reject(new Error(resp.error));
          } else {
            resolve(resp.result);
          }
        } catch {
          reject(new Error(`${CLI} exec: invalid response from exec socket: ${line.slice(0, 120)}`));
        }
      });
    });

    socket.on('error', (e: Error) => {
      finish(() => reject(e));
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({ ext, tool, args }) + '\n');
    });
  });
}

// ─── Tool list types (shared between listViaExecSocket and cmdExec display) ───

interface ExecToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

interface ExecExtEntry {
  key: string;
  id: string;
  serverInfo: { name: string; version: string };
  live: boolean;
  tools: ExecToolDescriptor[];
}

interface ExecListResult {
  extensions: ExecExtEntry[];
}

/**
 * listViaExecSocket — send a { list: true } (or { ext, list: true }) request to the
 * supervisor's exec socket and return the cached tool descriptors from the registrar.
 * No process is spawned; the registrar already fetched tools/list during register().
 */
async function listViaExecSocket(
  socketPath: string,
  ext?: string,
  timeoutMs = 10000,
): Promise<ExecListResult> {
  const netMod = require('node:net') as typeof import('node:net');
  const rlMod = require('node:readline') as typeof import('node:readline');

  return new Promise((resolve, reject) => {
    const socket = netMod.createConnection(socketPath);
    const rl = rlMod.createInterface({ input: socket, crlfDelay: Infinity });

    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timeout waiting for list response (${timeoutMs}ms)`)));
    }, timeoutMs);

    rl.once('line', (line: string) => {
      finish(() => {
        try {
          const resp = JSON.parse(line) as { result?: unknown; error?: string };
          if (resp.error !== undefined) {
            reject(new Error(resp.error));
          } else {
            resolve(resp.result as ExecListResult);
          }
        } catch {
          reject(new Error(`invalid response from exec socket: ${line.slice(0, 120)}`));
        }
      });
    });

    socket.on('error', (e: Error) => { finish(() => reject(e)); });
    socket.on('connect', () => {
      const req: Record<string, unknown> = { list: true };
      if (ext !== undefined) req['ext'] = ext;
      socket.write(JSON.stringify(req) + '\n');
    });
  });
}

/**
 * renderToolSchema — format an MCP tool's inputSchema into human-readable lines.
 * Returns an array of indented strings (without trailing newline).
 */
function renderToolSchema(tool: ExecToolDescriptor): string[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return [];
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== 'object') return [];
  const required = new Set<string>(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  const lines: string[] = [];
  for (const [propName, propDef] of Object.entries(props)) {
    const typeStr = typeof propDef['type'] === 'string' ? propDef['type'] : '';
    const enumVals = Array.isArray(propDef['enum'])
      ? (propDef['enum'] as unknown[]).map(String).join(' | ')
      : '';
    const desc = typeof propDef['description'] === 'string' ? propDef['description'] : '';
    const req = required.has(propName) ? '*' : ' ';
    const typeDisplay = enumVals ? `${typeStr}: ${enumVals}` : typeStr;
    const descDisplay = desc ? `  — ${desc}` : '';
    lines.push(`      ${req} ${propName.padEnd(20)} ${typeDisplay.padEnd(18)}${descDisplay}`);
  }
  return lines;
}

/**
 * printToolList — render ExecListResult to stdout in a readable format.
 */
function printToolList(listResult: ExecListResult, scope: string): void {
  if (listResult.extensions.length === 0) {
    process.stdout.write(`sox: no extensions registered in running runtime (scope: ${scope})\n`);
    process.stdout.write(`Run '${CLI} start -s ${scope}' to start the runtime.\n`);
    return;
  }

  process.stdout.write(`\nRunning extensions & tools  (scope: ${scope})\n\n`);

  for (const ext of listResult.extensions) {
    const liveTag = ext.live ? 'LIVE' : 'INACTIVE';
    process.stdout.write(`  ${ext.id}  v${ext.serverInfo.version}  [${liveTag}]\n`);
    process.stdout.write(`  ${'─'.repeat(56)}\n`);

    if (ext.tools.length === 0) {
      process.stdout.write(`  (no tools registered)\n`);
    } else {
      for (const tool of ext.tools) {
        const desc = tool.description ? `  ${tool.description}` : '';
        process.stdout.write(`  ${tool.name}${desc}\n`);
        const schemaLines = renderToolSchema(tool);
        for (const line of schemaLines) {
          process.stdout.write(line + '\n');
        }
      }
    }
    process.stdout.write('\n');
  }

  // Print canonical example from the first tool of the first extension that has tools.
  const firstExt = listResult.extensions.find((e) => e.tools.length > 0);
  const firstTool = firstExt?.tools[0];
  if (firstExt && firstTool) {
    const reqProps = (() => {
      const s = firstTool.inputSchema;
      if (!s || typeof s !== 'object') return {};
      const p = s['properties'] as Record<string, unknown> | undefined;
      const r = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
      const out: Record<string, string> = {};
      for (const k of r) { if (p && k in p) out[k] = '...'; }
      return out;
    })();
    const argsJson = JSON.stringify(reqProps);
    process.stdout.write(
      `Example:\n  ${CLI} exec ${firstExt.id} ${firstTool.name} --args='${argsJson}' -s ${scope}\n\n` +
      `  (* = required argument)\n\n`,
    );
  }
}

/**
 * cmdExec — A11: exec via the supervisor's Unix exec socket (airtight).
 *
 * Routing priority:
 *   1. If runtime.json has execSocketPath and the socket is reachable →
 *      route through the live supervisor session (McpRegistrar.call).
 *   2. Else if runtime.json exists but no socket (service-mode detached spawn) →
 *      fall back to fresh MCP spawn with policy enforcement.
 *   3. No runtime.json → hard error: "run soxe start first."
 *
/**
 * soxe serve <id> [--scope=<scope>] [--root=<dir>]
 *
 * Launch an extension as a long-lived process with live cascade config injected.
 * Resolves the entrypoint, builds SOX_CONFIG_* env from the current cascade,
 * then replaces the soxe process image via execFileSync (stdio inherited).
 *
 * This is the correct command to use as the .mcp.json "command" entry for stdio
 * MCP servers — the process stays alive reading stdin/stdout, and config is always
 * fresh (re-resolved on each session start).
 */

/**
 * Build a diagnostic message when soxe serve cannot find the extension in a
 * lockfile. Cross-references the install registry and registry index to suggest
 * a repair command.
 */
async function buildServeLockfileMissDiagnostic(
  extId: string,
  root: string,
  _searched: string[],
  cli: string,
): Promise<{ message: string; repair: string | null }> {
  const regPath = installRegistryPath();
  const reg = readInstallRegistry(regPath);
  const extRecord = reg.installs.find((r: { extId: string }) => r.extId === extId);
  if (!extRecord) return { message: `Extension "${extId}" not found in install registry.`, repair: null };
  const index = loadRegistryIndex(root);
  const idxEntry = index.find(
    (e) => e.members?.some((m) => m.id === extId) || e.bundleId === extId,
  );
  if (!idxEntry) return { message: `Extension "${extId}" found in registry but no owning bundle found.`, repair: null };
  const bundleId = idxEntry.bundleId || idxEntry.id;
  const repair = `${cli} install ${bundleId} --scope=${extRecord.scope}`;
  return {
    message: `Extension "${extId}" is member of bundle "${bundleId}" but missing from lockfile.`,
    repair,
  };
}

async function cmdServe(flags: Record<string, string>): Promise<void> {
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} serve — launch an extension process with live cascade config

Usage:
  ${CLI} serve <ext-id> [--scope=<scope>] [--root=<dir>] [--no-log]

Resolves the extension entrypoint, injects SOX_CONFIG_* env vars from the
current cascade config, then exec()s the Node process (replaces this process).
Designed for use as the .mcp.json command for stdio MCP servers.

Flags:
  --scope=<scope>   Restrict lookup to one scope (default: cascade project→user→org→local)
  --root=<dir>      Workspace root (default: cwd)
  --proxy           Force front-shim proxy mode: serve initialize +
                    tools/list from a cached schema and proxy tools/call to a
                    persistent sox-owned backend over a UDS, so a backend upgrade
                    is a rolling restart with NO client reconnect. The shim
                    auto-ensures (spawns, singleton-guarded) the backend.
                    DEFAULT for type:mcp-server — pass this only to force proxy
                    for a non-mcp-server type, or to be explicit.
  --no-proxy        Opt OUT of proxy mode for an mcp-server (escape hatch / rollback):
                    run the original direct-stdio exec path (this process IS the
                    server). Equivalent to manifest lifecycle.serve_mode:"direct"
                    or lifecycle.proxy:false.
   --log             (legacy) Alias for the default ON behaviour — no-op when logging
                     is already on. Use --no-log to suppress instead.
   --no-log          Opt OUT of the stderr log-tee: run direct exec() with inherited
                     stdio (zero intermediary). Also: SOX_SERVE_LOG=0.
                     NEVER tees stdout regardless — stdout is the JSON-RPC channel.
   --port=<port>     Start an HTTP listener on the given port in addition to stdio.
                     Supports dual transport — stdio and HTTP clients simultaneously.
                     Compatible with proxy mode: the shim proxies both to the backend.
   --help            Show this message
`);
    process.exit(0);
  }

  const extId = flags['_0'] ?? flags['id'] ?? argv[1];
  if (!extId) {
    process.stderr.write(`${CLI} serve: extension id required\n`);
    process.stderr.write(`Usage: ${CLI} serve <ext-id> [--scope=<scope>]\n`);
    process.exit(1);
  }

  // BL-65: emit a warning when the running dist is from a dirty or sha-mismatched
  // tree. Goes to stderr BEFORE any subprocess starts so the operator sees it.
  // [inv:no-stdout-diagnostics]: stderr only — never stdout (JSON-RPC channel).
  warnIfDistSha();

  const ROOT2 = process.cwd();
  const explicitScope2 = flags['scope'];
  const root2 = flags['root'] ?? ROOT2;

  const fsMod2 = require('node:fs') as typeof import('node:fs');
  const pathMod2 = require('node:path') as typeof import('node:path');

  // Cascade scope resolution: project → user → org → local (innermost wins).
  // If --scope is explicit, search only that scope (preserves explicit-scope behaviour).
  const SERVE_SCOPE_ORDER = ['project', 'user', 'org', 'local'] as const;
  const scopesToSearch2 = explicitScope2 ? [explicitScope2] : (SERVE_SCOPE_ORDER as readonly string[]);

  let extDir2: string | null = null;

  for (const sc of scopesToSearch2) {
    let sp: { lockfile: string; config: string };
    try {
      sp = getScopePaths(sc, root2);
    } catch {
      continue; // scope path may not exist (e.g. no org scope configured)
    }
    const lf = loadLockfile(sp.lockfile);
    const found = lf?.resolved?.[extId]
      ?? Object.entries(lf?.resolved ?? {}).find(([k]) => k.startsWith(extId + '@'))?.[1];
    if (found) {
      extDir2 = resolveExtensionDir(found.source, root2);
      break;
    }
  }

  if (!extDir2) {
    const localExt2 = findLocalExtension(root2, extId);
    if (localExt2) {
      extDir2 = localExt2;
    }
  }

  if (!extDir2) {
    const diag = await buildServeLockfileMissDiagnostic(extId, root2, [...scopesToSearch2], CLI);
    process.stderr.write(`\n${diag.message}\n`);
    if (diag.repair) process.stderr.write(`Repair: ${diag.repair}\n`);
    process.exit(1);
  }

  const manifestPath2 = pathMod2.join(extDir2, 'extension.json');
  if (!fsMod2.existsSync(manifestPath2)) {
    process.stderr.write(`${CLI} serve: manifest not found at ${manifestPath2}\n`);
    process.exit(1);
  }

  const manifest2 = JSON.parse(fsMod2.readFileSync(manifestPath2, 'utf8')) as {
    type?: string;
    entrypoint?: string;
    permissions?: PermissionsBlock;
    // Slice 1.5 / Slice 1.6 (§9.5): manifest may opt the served process into (or
    // out of) proxy/shim mode. serve_mode:"direct" + lifecycle.proxy:false are the
    // explicit opt-OUT escape hatches now that proxy is the DEFAULT for mcp-server.
    lifecycle?: { proxy?: boolean; serve_mode?: string; schema_path?: string };
  };
  if (!manifest2.entrypoint) {
    process.stderr.write(`${CLI} serve: no entrypoint in manifest at ${manifestPath2}\n`);
    process.exit(1);
  }

  const entrypointPath2 = pathMod2.resolve(extDir2, manifest2.entrypoint);
  if (!fsMod2.existsSync(entrypointPath2)) {
    process.stderr.write(`${CLI} serve: entrypoint not found at ${entrypointPath2}\n`);
    process.exit(1);
  }

  // Inject live cascade config as SOX_CONFIG_* env vars.
  const configEnv2 = buildExtConfigEnv(extId, root2);

  // Policy env (permissions enforcement).
  const policy2 = compilePolicy(manifest2.permissions);
  let serveEnv: NodeJS.ProcessEnv;
  if (policy2.enforced) {
    // BL-52: forward SOX_EMBED_* and XDG_CACHE_HOME so the embed backend resolves
    // to real BGE (ONNX) instead of silently falling back to hash embedding when the
    // served process inherits a scrubbed env. Also forward SOX_SERVE_LOG so the
    // child's own diagnostics path is consistent if a sub-server is spawned.
    // BL-344/BL-339: this is the SERVE path — it builds serveEnv, which becomes
    // backendEnv for the proxy-spawned backend. It is the copy that actually
    // gates the live symptom: patching the os-unit builder alone looks like it
    // worked (var present in the .plist) but does nothing, because the proxy
    // re-scrubs here before spawning the child. The observed signature was the
    // var present in the plist and absent from `ps eww <backend-pid>`.
    //
    // ⚠️ stderr, never stdout — this path serves MCP over stdio, where stdout
    // is the JSON-RPC channel. `scrubEnvReported` writes to stderr by default.
    const baseEnv2 = scrubEnvReported('serve backend');
    serveEnv = { ...baseEnv2, ...configEnv2, ...policy2.toEnv() };
  } else {
    serveEnv = { ...process.env, ...configEnv2 };
  }

  // BL-56: attribute memories to the CLIENT's workspace, not the extension install dir.
  // The served process runs with cwd = extDir2 (the install location, below), so the
  // enricher's cwd-based project_path detection would resolve to wherever the extension
  // is installed (e.g. the dev repo, or ~/.adhd for a user-scoped install) — wrong. We
  // inject the launch workspace (root2 = the dir the MCP client started `soxe serve`
  // from) as SOX_CONFIG_PROJECT_PATH so resolveProjectPath attributes to the real
  // project. ALWAYS define it (to the git root, else '') so the install-dir cwd fallback
  // is disabled in the served context. A per-project config.<id>.project_path already in
  // configEnv2 wins (we only set it when config did not).
  if (serveEnv['SOX_CONFIG_PROJECT_PATH'] === undefined || serveEnv['SOX_CONFIG_PROJECT_PATH'] === '') {
    let clientProjectRoot = '';
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      clientProjectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: root2,
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
    } catch {
      // root2 is not a git repo (e.g. the client launched from ~) — leave '' so the
      // server records NO project rather than mis-attributing to the install dir.
      clientProjectRoot = '';
    }
    serveEnv['SOX_CONFIG_PROJECT_PATH'] = clientProjectRoot;
  }

  // ── Slice 1.6 (§9.5): front-shim proxy mode — DEFAULT for mcp-server ────────
  //
  // For an mcp-server service, the served process runs by DEFAULT as the thin
  // stdio front-shim (it holds NO tool implementation): it serves initialize +
  // tools/list from a cached schema and proxies tools/call to a persistent,
  // sox-owned BACKEND over a Unix domain socket. A backend upgrade then becomes a
  // rolling restart with NO client reconnect for behaviour-only changes; an
  // interface change emits notifications/tools/list_changed (§9.5.3).
  //
  // The shim AUTO-ENSURES the backend: if no backend is live on the store's UDS it
  // spawns one detached, singleton-guarded per [def:singleton-key] (one backend per
  // store, even across many sessions' shims → single-writer). On a dropped backend
  // connection it re-ensures (a crashed backend is brought back up; a clean
  // rolling-restart respawns itself).
  //
  // The backend socket path is derived from the data-root resolver (socketDir(),
  // ADR-0004) keyed by the [def:singleton-key] (id + canonical store-resource),
  // identical to the Slice-1 singleton key — so the shim dials the exact one
  // backend per store, with no port-selection problem.
  //
  // Resolution precedence (highest wins): CLI flag > manifest > type default.
  //   1. CLI flag — `--no-proxy` (opt-OUT, the rollback path without a code revert)
  //      or `--proxy` (force) is the operator's explicit override and beats the
  //      manifest. `--no-proxy` wins if BOTH are somehow present (safest default).
  //   2. Manifest — lifecycle.serve_mode:"direct"/proxy:false (opt out) or
  //      serve_mode:"proxy"/proxy:true (force).
  //   3. Type default — proxy ON for type:mcp-server, off for everything else.
  const isMcpServer = manifest2.type === 'mcp-server';
  let wantProxy: boolean;
  if (flags['no-proxy'] !== undefined) {
    wantProxy = false; // explicit operator opt-out — overrides the manifest
  } else if (flags['proxy'] !== undefined) {
    wantProxy = true; // explicit operator force — overrides the manifest
  } else if (manifest2.lifecycle?.serve_mode === 'direct' || manifest2.lifecycle?.proxy === false) {
    wantProxy = false; // manifest opt-out
  } else if (manifest2.lifecycle?.serve_mode === 'proxy' || manifest2.lifecycle?.proxy === true) {
    wantProxy = true; // manifest force
  } else {
    wantProxy = isMcpServer; // type default
  }

  if (wantProxy) {
    const { runFrontShim, backendSocketPath, ensureBackend } =
      require('@adhd/sox-service-proxy') as typeof import('@adhd/sox-service-proxy');

    // Derive the [def:singleton-key] for the backend from the SAME resolver Slice 1
    // uses, so the shim and the backend agree on one socket per store-resource.
    const storeResource = resolveStoreResource(manifestPath2, serveEnv as Record<string, string>);
    const key = singletonKey(extId, storeResource) ?? `${extId} none:`;
    const backendSock = backendSocketPath(socketDir(), key);

    // --port: start an HTTP listener alongside stdio for dual transport support.
    const httpPort: number | undefined =
      flags['port'] !== undefined ? parseInt(String(flags['port']), 10) : undefined;

    // A backend MAY publish a schema.json (manifest lifecycle.schema_path, relative
    // to the install dir) so the shim can serve tools/list instantly even while the
    // backend is mid-restart. Optional — absent ⇒ schema is read from the backend.
    // We resolve the path even if the file does not exist yet: the BACKEND writes it
    // on first start, and the shim re-reads through to the live backend until then.
    let schemaCachePath: string | undefined;
    let backendSchemaPath: string | undefined;
    if (manifest2.lifecycle?.schema_path) {
      const sp = pathMod2.resolve(extDir2, manifest2.lifecycle.schema_path);
      backendSchemaPath = sp;
      if (fsMod2.existsSync(sp)) schemaCachePath = sp;
    }

    // The backend is spawned in BACKEND mode with the SAME entrypoint + policy-env +
    // SOX_CONFIG_* this serve invocation resolved, so C6 enforcement + store
    // resolution are byte-identical to the direct-stdio path. SOX_PROXY_BACKEND=1
    // selects backend mode; the socket + schema paths are passed via env (the shim
    // owns the [def:singleton-key]-derived paths). The backend entrypoint token is
    // the SAME entrypointPath2 the reaper matches (BL-31 reaper-compatible).
    const backendEnv: NodeJS.ProcessEnv = {
      ...serveEnv,
      SOX_PROXY_BACKEND: '1',
      SOX_PROXY_BACKEND_SOCKET: backendSock,
      ...(backendSchemaPath !== undefined ? { SOX_PROXY_BACKEND_SCHEMA: backendSchemaPath } : {}),
    };

    process.stderr.write(
      `[soxe serve] proxy mode (DEFAULT for mcp-server): shim → backend UDS ${backendSock} ` +
      `(singleton-key: ${key})\n`,
    );

    // Slice 3 (§11.3): cap the backend re-ensure loop. 5 failed ensures in 60s ⇒
    // stop respawning (no spawn-fail-spawn storm across reconnect loops); the
    // durable marker surfaces the give-up in `soxe status`/`doctor`. Any
    // successful ensure resets the window.
    const backendCrashLoop = new CrashLoopGuard({ key: `${extId}@proxy-backend` });

    const handle = runFrontShim({
      id: extId,
      socketPath: backendSock,
      ...(schemaCachePath !== undefined ? { schemaCachePath } : {}),
      ...(httpPort !== undefined && !Number.isNaN(httpPort) ? { httpPort } : {}),
      // BL-62: per-request project attribution — the shim forwards ITS client's
      // workspace (BL-56 injects SOX_CONFIG_PROJECT_PATH at shim spawn; MCP hosts
      // spawn the shim in the project dir, so cwd is the honest fallback) on every
      // tools/call so the SHARED backend attributes writes to the caller's
      // project, not to whichever shim spawned the backend.
      clientProjectPath: process.env['SOX_CONFIG_PROJECT_PATH'] || process.cwd(),
      // §9.5 step 3: auto-managed, singleton-guarded backend lifecycle.
      ensure: async () => {
        // [inv:no-fd-inherit] The backend is detached; its stderr must NEVER inherit
        // the shim's fd 2. Redirect to a dated log file so diagnostics are
        // preserved without holding any parent pipe open (BL-67).
        const backendLogDir2 = logDirFor(`proxy-backend-${extId}`);
        const backendLogDate2 = new Date().toISOString().slice(0, 10);
        const backendLogPath2 = pathMod2.join(backendLogDir2, `${extId}-backend-${backendLogDate2}.log`);
        if (backendCrashLoop.isCapped()) {
          process.stderr.write(backendCrashLoop.giveUpLine() + '\n');
          return;
        }
        const r = await ensureBackend({
          socketPath: backendSock,
          singletonKey: key,
          command: process.execPath,
          args: ['--enable-source-maps', entrypointPath2],
          cwd: extDir2 as string,
          env: backendEnv,
          stderrLogPath: backendLogPath2,
          onDiagnostic: (l) => process.stderr.write(l + '\n'),
        });
        process.stderr.write(`[soxe serve] ensure-backend: ${r.disposition} — ${r.detail}\n`);
        if (r.disposition === 'failed') backendCrashLoop.recordFailure();
        else backendCrashLoop.recordSuccess();
      },
    });
    // The shim lives until the client closes the stdio pipe, or until a signal
    // is received (SIGHUP when the MCP host disconnects, or SIGTERM/SIGINT).
    if (httpPort !== undefined && !Number.isNaN(httpPort)) {
      await new Promise<void>((resolve) => {
        process.on('SIGTERM', () => resolve());
        process.on('SIGINT', () => resolve());
      });
    } else {
      // BL-310: In pure-stdio mode, install SIGHUP/SIGTERM handlers so the shim
      // exits when the MCP host disconnects without cleanly closing its stdin pipe
      // (crash, SIGKILL, terminal session end). Without these, `handle.done` never
      // resolves → the shim becomes an orphan with PPID=1.
      const signalDone = new Promise<void>((resolve) => {
        const onSignal = () => {
          handle.close();
          resolve();
        };
        process.on('SIGHUP', onSignal);
        process.on('SIGTERM', onSignal);
        // Clean up listeners when handle.done resolves first (graceful pipe close).
        handle.done.then(() => {
          process.off('SIGHUP', onSignal);
          process.off('SIGTERM', onSignal);
        });
      });
      await Promise.race([handle.done, signalDone]);
    }
    process.exit(0);
  }

  // BL-46 / BL-178: durable stderr sink for the served child process.
  //
  // Default (BL-178): tee the child's STDERR to both process.stderr (so the MCP
  // client still sees errors) AND a dated log file under
  // <logDir>/<extId>-serve-<YYYY-MM-DD>.log via LogManager.
  //
  // Opt-out: --no-log OR SOX_SERVE_LOG=0 disables the tee and runs the original
  // direct exec() path (stdio:'inherit'), zero intermediary.
  // Opt-in alias: --log / SOX_SERVE_LOG=1 are accepted for backwards compatibility
  // but are now no-ops when the default is already ON.
  //
  // NEVER tee stdout — stdout is the JSON-RPC channel; corrupting it breaks MCP.
  const wantLog = (() => {
    // Explicit opt-out wins regardless of any flag.
    if (flags['no-log'] !== undefined) return false;
    if (process.env['SOX_SERVE_LOG'] === '0') return false;
    // Explicit opt-in (legacy flag; preserved for backwards compat).
    if (flags['log'] !== undefined) return true;
    if (process.env['SOX_SERVE_LOG'] === '1') return true;
    // Default: tee ON (BL-178).
    return true;
  })();

  if (!wantLog) {
    // Opt-out path: replace this process (stdio inherited) — MCP server takes over
    // stdin/stdout directly with no intermediary.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    try {
      execFileSync(process.execPath, ['--enable-source-maps', entrypointPath2], {
        stdio: 'inherit',
        env: serveEnv,
        cwd: extDir2,
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      process.exit(code);
    }
    return;
  }

  // Log-tee path: spawn (not exec) with stderr piped; inherit stdin+stdout.
  // supervisorId-style label "serve-<extId>" keeps log paths unique and discoverable.
  const { LogManager } = require('@adhd/sox-host-runtime') as typeof import('@adhd/sox-host-runtime');
  const serveLogDir = logDirFor(`serve-${extId}`);
  const lm = new LogManager({ logDir: serveLogDir, extId: `${extId}-serve` });

  process.stderr.write(
    `[soxe serve] stderr log: ${serveLogDir}/${extId}-serve-<date>.log\n`,
  );

  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const child = spawn(
    process.execPath,
    ['--enable-source-maps', entrypointPath2],
    {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: serveEnv,
      cwd: extDir2,
    },
  );

  // Pipe child stderr → parent stderr AND the log file.
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    lm.write(chunk);
  });

  // Propagate exit code; close the log stream cleanly.
  child.on('close', (code: number | null) => {
    lm.close();
    process.exit(code ?? 0);
  });

  child.on('error', (err: Error) => {
    process.stderr.write(`[soxe serve] spawn error: ${err.message}\n`);
    lm.close();
    process.exit(1);
  });
}

/**
 * soxe exec — call a tool on a running extension (A11).
 *
 * Routing:
 *   1. If runtime.json has execSocketPath and the socket file exists →
 *      route through the live supervisor session (McpRegistrar.call).
 *   2. Else if runtime.json exists but no socket (service-mode detached spawn) →
 *      fall back to fresh MCP spawn with policy enforcement.
 *   3. No runtime.json → hard error: "run soxe start first."
 *
 * [inv:exec-socket]: The socket is only present in supervisor mode (lockfile-based
 * start where the soxe process stays alive). Service-mode starts (detached via
 * registry.json) legitimately have no socket — fresh spawn is correct there.
 */
async function cmdExec(flags: Record<string, string>): Promise<void> {
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`${CLI} exec — call a tool on a running extension (A11)

Usage:
  ${CLI} exec <ext-id> <tool> [--args=<json>] [-s <scope>]
  ${CLI} exec --id=<ext-id> --tool=<tool> [--args=<json>] [--scope=<scope>]
  ${CLI} exec --list [-s <scope>]           # list all tools on running extensions
  ${CLI} exec --list --id=<ext-id>          # list tools for one extension
  ${CLI} exec <tool-name>                   # show schema + example for a named tool

Flags:
  --id=<ext-id>    Extension id (must be running — see '${CLI} exec --list')
  --tool=<name>    MCP tool name declared by the extension
  --args=<json>    JSON object of tool arguments (default: {})
  --scope=<scope>  Scope of the runtime record (default: user)
  --list           List all executable tools (no tool call made)

Routing:
  1. If the runtime has an exec socket (supervisor mode) → routes through the
     live supervisor session; no process spawned.
  2. If no socket (service-mode detached start) → spawns a fresh MCP session.

Examples:
  ${CLI} exec --list -s project
  ${CLI} exec memory-server memory_write --args='{"content":"hello"}' -s project
  ${CLI} exec memory_write                # show schema for memory_write
`);
    process.exit(0);
  }

  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  // Resolve runtimeFilePath using same scope → lockfile → getRuntimeFilePath
  // chain as cmdStop / cmdList / cmdDetails, so the default is always correct.
  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`${CLI} exec: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  // ── --list: show all tools from the live registrar ────────────────────────
  if (flags['list'] !== undefined) {
    const record0 = getRuntimeRecord(runtimeFilePath);
    if (!record0) {
      process.stderr.write(
        `${CLI} exec: no runtime record at ${runtimeFilePath}. Run '${CLI} start -s ${scope}' first.\n`,
      );
      process.exit(1);
    }
    // ── Supervisor mode: use exec socket (fast, cached) ─────────────────────
    if (record0.execSocketPath && fsMod.existsSync(record0.execSocketPath)) {
      try {
        const filterExt = flags['id'];
        const listResult = await listViaExecSocket(record0.execSocketPath, filterExt);
        printToolList(listResult, scope);
      } catch (e) {
        process.stderr.write(`${CLI} exec: list failed: ${String(e)}\n`);
        process.exit(1);
      }
      process.exit(0);
    }

    // ── Service-mode fallback: spawn fresh MCP per entry, call tools/list ───
    // Used when soxe start ran in service mode (no supervisor / no exec socket).
    {
      const pathMod2 = require('node:path') as typeof import('node:path');
      const { spawn: spawnMcp } = require('node:child_process') as typeof import('node:child_process');
      const filterExtId = flags['id'];
      const entriesToList = record0.entries.filter((e) =>
        filterExtId === undefined || e.id === filterExtId || e.key === filterExtId,
      );
      const extensions: ExecExtEntry[] = [];
      for (const entry of entriesToList) {
        const extDir2 = resolveExtensionDir(entry.source, root);
        if (!extDir2) continue;
        const manifestPath2 = pathMod2.join(extDir2, 'extension.json');
        if (!fsMod.existsSync(manifestPath2)) continue;
        let manifest2: { entrypoint?: string; version?: string } = {};
        try { manifest2 = JSON.parse(fsMod.readFileSync(manifestPath2, 'utf8')) as typeof manifest2; }
        catch { continue; }
        if (!manifest2.entrypoint) continue;
        const entrypointPath2 = pathMod2.resolve(extDir2, manifest2.entrypoint);
        if (!fsMod.existsSync(entrypointPath2)) continue;
        const child2 = spawnMcp(process.execPath, ['--enable-source-maps', entrypointPath2], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env },
          cwd: extDir2,
        });
        const client2 = new McpClient(child2);
        try {
          await client2.call(
            'initialize',
            { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sox-exec-list', version: '1.0.0' } },
            10000,
          );
          const toolsResp = await client2.call('tools/list', {}, 10000) as {
            tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
          };
          client2.close(); child2.kill('SIGTERM');
          // ADR-0003: the lockfile key is the bare id; there is no `@version`.
          // serverInfo.version is a display-only label (from the manifest's optional
          // displayVersion when present), never an identity input.
          const rawId = entry.id ?? (entry.key.includes('@')
            ? entry.key.slice(0, entry.key.lastIndexOf('@'))
            : entry.key);
          extensions.push({
            key: entry.key,
            id: rawId,
            serverInfo: { name: rawId, version: manifest2.version ?? '?' },
            live: entry.running,
            tools: (toolsResp.tools ?? []) as ExecToolDescriptor[],
          });
        } catch {
          client2.close(); child2.kill('SIGTERM');
        }
      }
      printToolList({ extensions }, scope);
      process.exit(0);
    }
  }

  // Support both positional and flag form:
  //   soxe exec <ext-id> <tool> [args-json]
  //   soxe exec --id <ext-id> --tool <tool> [--args <json>]
  //   soxe exec <tool-name>   (single positional → show schema)
  const rawAfterVerb = argv.slice(1);  // argv[0] = 'exec'
  const positionals: string[] = [];
  for (let i = 0; i < rawAfterVerb.length; i++) {
    const tok = rawAfterVerb[i];
    if (tok === undefined) continue;
    if (tok.startsWith('-')) {
      if (tok.startsWith('--') && !tok.includes('=')) i++; // skip value for --flag value form
    } else {
      positionals.push(tok);
    }
  }

  const extIdFlag = flags['id'];
  const toolFlag = flags['tool'];
  const argsJson = flags['args'] ?? positionals[2] ?? '{}';

  // ── Single positional with no --id / --tool → schema lookup ──────────────
  // `soxe exec memory_write` — find the tool across all extensions, show schema.
  if (positionals.length === 1 && extIdFlag === undefined && toolFlag === undefined) {
    const queryTool = positionals[0] ?? '';
    const record0 = getRuntimeRecord(runtimeFilePath);
    if (record0?.execSocketPath && fsMod.existsSync(record0.execSocketPath)) {
      try {
        const listResult = await listViaExecSocket(record0.execSocketPath);
        for (const ext of listResult.extensions) {
          const found = ext.tools.find((t) => t.name === queryTool);
          if (found) {
            process.stdout.write(`\nTool: ${found.name}\n`);
            process.stdout.write(`Extension: ${ext.key}  [${ext.live ? 'LIVE' : 'INACTIVE'}]\n\n`);
            if (found.description) {
              process.stdout.write(`Description:\n  ${found.description}\n\n`);
            }
            const schemaLines = renderToolSchema(found);
            if (schemaLines.length > 0) {
              process.stdout.write(`Input (* = required):\n`);
              for (const line of schemaLines) { process.stdout.write(line + '\n'); }
              process.stdout.write('\n');
            } else {
              process.stdout.write(`Input: (none — call with --args='{}')\n\n`);
            }
            const reqProps = (() => {
              const s = found.inputSchema;
              if (!s || typeof s !== 'object') return {};
              const p = s['properties'] as Record<string, unknown> | undefined;
              const r = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
              const out: Record<string, string> = {};
              for (const k of r) { if (p && k in p) out[k] = '...'; }
              return out;
            })();
            const argsEx = JSON.stringify(reqProps);
            process.stdout.write(
              `Example:\n  ${CLI} exec ${ext.id} ${found.name} --args='${argsEx}' -s ${scope}\n\n`,
            );
            process.exit(0);
          }
        }
        process.stderr.write(
          `${CLI} exec: tool '${queryTool}' not found in any running extension.\n` +
          `Run '${CLI} exec --list -s ${scope}' to see available tools.\n`,
        );
      } catch {
        // socket unavailable — fall through to normal error path
      }
    }
    process.stderr.write(
      `${CLI} exec: tool '${queryTool}' not found. Run '${CLI} exec --list -s ${scope}' to see available tools.\n`,
    );
    process.exit(1);
  }

  const extId = extIdFlag ?? positionals[0] ?? '';
  const toolName = toolFlag ?? positionals[1] ?? '';

  if (extId === '' || toolName === '') {
    if (extId === '') {
      process.stderr.write(
        `${CLI} exec: extension id required.\n` +
        `Run '${CLI} exec --list -s ${scope}' to see running extensions and their tools.\n`,
      );
    } else {
      process.stderr.write(
        `${CLI} exec: tool name required.\n` +
        `Run '${CLI} exec --list --id=${extId} -s ${scope}' to see tools for '${extId}'.\n`,
      );
    }
    process.exit(1);
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    process.stderr.write(`${CLI} exec: invalid --args JSON: ${argsJson}\n`);
    process.exit(1);
  }

  // ── Config default injection ──────────────────────────────────────────────
  // Cascade-merge config across all scopes (org→user→project→local, narrowest
  // wins) so an extension installed at project scope still gets its config
  // injected even when --scope is not specified.
  // String values get tilde expansion and ${VAR} resolution before merge.
  // Caller-supplied args always win on conflict.
  {
    const EXEC_CASCADE_SCOPES = ['org', 'user', 'project', 'local'] as const;
    const extConfigMerged: Record<string, unknown> = {};
    for (const cs of EXEC_CASCADE_SCOPES) {
      try {
        const csp = getScopePaths(cs, root);
        const cfg4 = loadConfig(flags['config'] === undefined ? csp.config : (cs === scope ? flags['config'] : csp.config));
        const scopeBlock =
          (cfg4?.config as Record<string, Record<string, unknown>> | undefined)?.[extId] ?? {};
        Object.assign(extConfigMerged, scopeBlock); // narrower scope overwrites wider
      } catch { /* skip missing scope */ }
    }
    if (Object.keys(extConfigMerged).length > 0) {
      const { homedir } = require('node:os') as typeof import('node:os');
      const homeDir4 = homedir();
      const resolved4: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(extConfigMerged)) {
        let val: unknown = v;
        if (typeof val === 'string') {
          if (val.startsWith('~/')) val = homeDir4 + val.slice(1);
          val = (val as string).replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, varName: string) =>
            process.env[varName] ?? _m,
          );
        }
        resolved4[k] = val;
      }
      // caller-supplied args win
      toolArgs = { ...resolved4, ...toolArgs };
    }
  }

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stderr.write(
      `${CLI} exec: no runtime record at ${runtimeFilePath}. Run '${CLI} start -s ${scope}' first.\n`,
    );
    process.exit(1);
  }

  const entry = record.entries.find((e) => e.id === extId || e.key === extId);
  if (!entry) {
    const available = record.entries.map((e) => e.id).join(', ');
    process.stderr.write(
      `${CLI} exec: extension '${extId}' not found in runtime.\n` +
      (available ? `Running extensions: ${available}\n` : `No extensions in runtime record.\n`) +
      `Run '${CLI} exec --list -s ${scope}' to see available extensions and tools.\n`,
    );
    process.exit(1);
  }

  // ── Route 1: exec socket (supervisor mode — airtight) ─────────────────────
  // [inv:exec-socket]: present in runtime.json only when startRuntime() opened it.

  if (record.execSocketPath && fsMod.existsSync(record.execSocketPath)) {
    try {
      const result = await callViaExecSocket(record.execSocketPath, extId, toolName, toolArgs);
      process.stdout.write(JSON.stringify(result) + '\n');
      // [exec-exit-code]: isError → exit 1 so probe harness detects enforcement denials.
      const mcpResult = result as { isError?: boolean };
      process.exit(mcpResult.isError ? 1 : 0);
    } catch (e) {
      const errMsg = String(e);
      const isToolNotFound = errMsg.toLowerCase().includes('no client found') ||
        errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('unknown tool');
      if (isToolNotFound) {
        process.stderr.write(
          `${CLI} exec: tool '${toolName}' not found on '${extId}'.\n` +
          `Run '${CLI} exec --list --id=${extId} -s ${scope}' to see available tools.\n`,
        );
        process.exit(1);
      }
      // Other socket error — fall through to fresh spawn with a warning.
      process.stderr.write(`${CLI} exec: exec socket failed (${errMsg}), falling back to fresh spawn\n`);
    }
  }

  // ── Route 2: fresh MCP spawn (service-mode detached, or socket unavailable) ─
  // Spawn a fresh MCP session with the same policy enforcement as the supervisor.
  // [inv:no-regress]: identical behaviour to the pre-A11 path when socket is absent.
  const extDir = resolveExtensionDir(entry.source, ROOT);
  if (!extDir) {
    process.stderr.write(
      `${CLI} exec: cannot resolve extension dir from source: ${entry.source}\n`,
    );
    process.exit(1);
  }

  const manifestPath = pathMod.join(extDir, 'extension.json');
  if (!fsMod.existsSync(manifestPath)) {
    process.stderr.write(`${CLI} exec: manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  // [process-boundary.exec] — mirror supervisor enforced-spawn for C6 compliance.
  const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as {
    entrypoint?: string;
    permissions?: PermissionsBlock;
  };
  if (!manifest.entrypoint) {
    process.stderr.write(`${CLI} exec: no entrypoint in manifest at ${manifestPath}\n`);
    process.exit(1);
  }

  const policy = compilePolicy(manifest.permissions);

  const extConfigEnv = buildExtConfigEnv(extId, root);

  let execEnv: NodeJS.ProcessEnv;
  if (policy.enforced) {
    // BL-52: forward SOX_EMBED_* and XDG_CACHE_HOME so the embed backend resolves
    // to real BGE (ONNX) instead of silently falling back to hash embedding.
    // BL-344: this was the THIRD copy of the allowlist in this file, and its own
    // comment recorded the defect ("Adding a tunable requires remembering every
    // one of them"). That is now structurally impossible — there is one
    // definition, in host-runtime's env-policy.ts.
    const baseEnv = scrubEnvReported('exec');
    execEnv = { ...baseEnv, ...extConfigEnv, ...policy.toEnv() };
  } else {
    execEnv = { ...process.env, ...extConfigEnv };
  }

  const entrypointPath = pathMod.resolve(extDir, manifest.entrypoint);
  if (!fsMod.existsSync(entrypointPath)) {
    process.stderr.write(`${CLI} exec: entrypoint not found at ${entrypointPath}\n`);
    process.exit(1);
  }

  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  // --enable-source-maps: resolve bundle stack traces back to TypeScript source locations.
  const child = spawn(process.execPath, ['--enable-source-maps', entrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: execEnv,
    cwd: extDir,
  });

  child.stderr?.on('data', (d: Buffer) => { process.stderr.write(d); });

  const client = new McpClient(child);
  try {
    await client.call(
      'initialize',
      { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sox-exec', version: '1.0.0' } },
      10000,
    );
    const result = await client.call('tools/call', { name: toolName, arguments: toolArgs }, 30000);
    process.stdout.write(JSON.stringify(result) + '\n');
    client.close();
    child.kill('SIGTERM');
    const mcpResult2 = result as { isError?: boolean };
    process.exit(mcpResult2.isError ? 1 : 0);
  } catch (e) {
    client.close();
    child.kill('SIGTERM');
    process.stderr.write(`${CLI} exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── soxe config ───────────────────────────────────────────────────────────────

/**
 * cmdConfig — manage per-extension install-time configuration.
 *
 * Sub-verbs:
 *   soxe config get   <ext> <key>           [--scope=<scope>]
 *   soxe config set   <ext> <key> <value>   [--scope=<scope>]
 *   soxe config list  <ext>                 [--scope=<scope>]
 *   soxe config unset <ext> <key>           [--scope=<scope>]
 *   soxe config check <ext>                 [--scope=<scope>]
 *
 * Config is stored in extensions.json under the "config" block keyed by ext id.
 * get/list operate on the active scope's file (pass --scope to target another).
 * set/unset write to the specified scope (default: user).
 * check validates the cascade-resolved config against the extension's config_schema.
 */
async function cmdConfig(argv: string[], flags: Record<string, string>): Promise<void> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const osMod = require('node:os') as typeof import('node:os');

  const subVerb = argv[1];
  const ROOT = flags['root'] ?? process.cwd();

  if (!subVerb || subVerb === '--help' || subVerb === '-h') {
    process.stdout.write(`${CLI} config — manage per-extension install-time configuration

Sub-verbs:
  ${CLI} config get   <ext> <key> [--scope=<scope>]   Get a config value (cascade-resolved)
  ${CLI} config set   <ext> <key> <value> [--scope]   Write a value to the scope config (default: user)
  ${CLI} config list  <ext> [--scope=<scope>]          List all config keys with cascade origin
  ${CLI} config unset <ext> <key> [--scope=<scope>]   Remove a key from the scope config
  ${CLI} config check <ext> [--scope=<scope>]          Validate config against config_schema

Flags:
  --scope=<scope>       Scope: org | user | project | local  (default: user for set/unset, current for get/list/check)
  --no-restart          config set: skip daemon restart after config change
  --dry-run             config set: log what would be restarted without doing it

Config is persisted in extensions.json under the "config" block.
Sensitive values should use env refs: \${VAR_NAME}
`);
    process.exit(0);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Load extensions.json for a given scope, return { config, install, ... } or {} */
  function loadScopeConfig(sc: string, rt: string): Record<string, unknown> {
    try {
      const sp = getScopePaths(sc, rt);
      const raw = loadConfig(sp.config);
      return (raw ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Write a mutated config object back to the scope's extensions.json */
  function writeScopeConfig(sc: string, rt: string, data: Record<string, unknown>): void {
    const sp = getScopePaths(sc, rt);
    const dir = pathMod.dirname(sp.config);
    if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
    fsMod.writeFileSync(sp.config, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  /** Expand ~ and resolve ${VAR} in a string value */
  function resolveValue(val: string): string {
    let v = val;
    if (v.startsWith('~/')) v = osMod.homedir() + v.slice(1);
    v = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, name: string) => process.env[name] ?? _m);
    return v;
  }

  // ── SCOPES in cascade order ───────────────────────────────────────────────
  // org → user → project → local (narrowest wins)
  const CASCADE_SCOPES = ['org', 'user', 'project', 'local'];

  /** Build cascade-resolved config map for one extension across all scopes */
  function cascadeExtConfig(extId: string): { value: Record<string, unknown>; origins: Record<string, string> } {
    const merged: Record<string, unknown> = {};
    const origins: Record<string, string> = {};
    for (const sc of CASCADE_SCOPES) {
      let sp: { config: string };
      try { sp = getScopePaths(sc, ROOT); } catch { continue; }
      const raw = loadConfig(sp.config);
      const extCfg = ((raw as Record<string, unknown>)?.['config'] as Record<string, Record<string, unknown>> | undefined)?.[extId] ?? {};
      for (const [k, v] of Object.entries(extCfg)) {
        merged[k] = v;
        origins[k] = sc;
      }
    }
    return { value: merged, origins };
  }

  // ── sub-verb dispatch ─────────────────────────────────────────────────────

  const positionals = argv.slice(1).filter((a) => !a.startsWith('-'));
  // positionals: [subVerb, extId, key?, value?]
  const extId = positionals[1];
  const key = positionals[2];
  const value = positionals[3];

  switch (subVerb) {
    // ── get ────────────────────────────────────────────────────────────────
    case 'get': {
      if (!extId || !key) {
        process.stderr.write(`${CLI} config get: usage: ${CLI} config get <ext> <key> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const { value: cascaded } = cascadeExtConfig(extId);
      if (key in cascaded) {
        process.stdout.write(String(cascaded[key]) + '\n');
        process.exit(0);
      } else {
        process.stderr.write(`${CLI} config get: key '${key}' not set for '${extId}'\n`);
        process.exit(1);
      }
    }

    // ── set ────────────────────────────────────────────────────────────────
    case 'set': {
      if (!extId || !key || value === undefined) {
        process.stderr.write(`${CLI} config set: usage: ${CLI} config set <ext> <key> <value> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const writeScope = flags['scope'] ?? 'user';
      const cfgObj = loadScopeConfig(writeScope, ROOT);
      const configBlock = (cfgObj['config'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      if (!configBlock[extId]) configBlock[extId] = {};
      configBlock[extId][key] = value;
      cfgObj['config'] = configBlock;
      // Warn on likely secret values that aren't using env refs
      if (typeof value === 'string' && !value.startsWith('${') &&
        /key|token|secret|password|api[-_]?key|credential/i.test(key)) {
        process.stderr.write(
          `${CLI} config set: warning: '${key}' looks like a secret — consider using an env ref instead: \${${key.toUpperCase().replace(/[-\s]/g, '_')}}\n`,
        );
      }
      writeScopeConfig(writeScope, ROOT, cfgObj);
      process.stdout.write(`${CLI} config: set ${extId}.${key} = ${value}  (scope: ${writeScope})\n`);

      // ── Restart affected daemons (Improvement E) ──
      const noRestartCfg = flags['no-restart'] !== undefined;
      const dryRunCfg = flags['dry-run'] !== undefined;
      if (!noRestartCfg) {
        let restarted = 0;
        for (const s of (['org', 'user', 'project', 'local'] as const)) {
          const ctx = resolveOsUnitContext(extId, s, ROOT, flags);
          if (!ctx) continue;

          if (dryRunCfg) {
            process.stdout.write(`[dry-run] would restart ${extId} os-unit in scope=${s} (config ${key}=${value})\n`);
            restarted++;
            continue;
          }

          // Resolve the last-known-good unit path from the ownership index.
          let lkgPath: string | undefined;
          try {
            const own = OwnershipIndex.loadFromFile(pathMod.join(dataRoot(s as DataScope, ROOT), 'ownership.json'));
            const rec = own.get(extId, s);
            const osUnitEntry = rec?.entries.find((e: OwnedEntry) => e.kind === 'os-unit');
            if (osUnitEntry?.kind === 'os-unit') {
              lkgPath = fsMod.existsSync(osUnitEntry.unitPath) ? osUnitEntry.unitPath : undefined;
            }
          } catch { /* best-effort */ }

          try {
            const result = await restartOsUnit(ctx.spec, ctx.platform, lkgPath, {
              reason: `config change: ${key}=${value} (scope=${writeScope})`,
            });

            if (result.action === 'restarted') restarted++;
            process.stdout.write(`${extId}: ${result.action} (scope=${s}, ${result.reason ?? ''})\n`);
          } catch (e: unknown) {
            process.stderr.write(`${extId}: restart failed in scope=${s}: ${String(e)}\n`);
          }
        }

        if (restarted > 0) {
          process.stdout.write(`restarted ${restarted} daemon(s) affected by config change\n`);
        }
        if (dryRunCfg && restarted > 0) {
          process.stdout.write(`[dry-run] ${restarted} daemon(s) would be restarted\n`);
        }
      }

      process.exit(0);
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      if (!extId) {
        process.stderr.write(`${CLI} config list: usage: ${CLI} config list <ext> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const { value: cascaded, origins } = cascadeExtConfig(extId);
      if (Object.keys(cascaded).length === 0) {
        process.stdout.write(`(no config set for '${extId}')\n`);
        process.exit(0);
      }
      const COL = 24;
      const pad = (s: string, n: number) => s.padEnd(n);
      process.stdout.write(`Config for ${extId}  (cascade-resolved)\n\n`);
      process.stdout.write(`  ${pad('KEY', COL)}${pad('VALUE', 32)}SCOPE\n`);
      process.stdout.write(`  ${'─'.repeat(COL)}${'─'.repeat(32)}${'─'.repeat(10)}\n`);
      for (const [k, v] of Object.entries(cascaded)) {
        const displayVal = typeof v === 'string' ? resolveValue(v) : JSON.stringify(v);
        process.stdout.write(`  ${pad(k, COL)}${pad(displayVal.slice(0, 30), 32)}${origins[k] ?? '?'}\n`);
      }
      process.stdout.write('\n');
      process.exit(0);
    }

    // ── unset ──────────────────────────────────────────────────────────────
    case 'unset': {
      if (!extId || !key) {
        process.stderr.write(`${CLI} config unset: usage: ${CLI} config unset <ext> <key> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const unsetScope = flags['scope'] ?? 'user';
      const cfgObj2 = loadScopeConfig(unsetScope, ROOT);
      const configBlock2 = (cfgObj2['config'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      if (!configBlock2[extId] || !(key in configBlock2[extId])) {
        process.stderr.write(`${CLI} config unset: key '${key}' not set for '${extId}' in scope '${unsetScope}'\n`);
        process.exit(1);
      }
      delete configBlock2[extId][key];
      if (Object.keys(configBlock2[extId]).length === 0) delete configBlock2[extId];
      cfgObj2['config'] = configBlock2;
      writeScopeConfig(unsetScope, ROOT, cfgObj2);
      // Warn if required key becomes unset in cascade after removal
      const { value: cascaded2 } = cascadeExtConfig(extId);
      if (!(key in cascaded2)) {
        process.stdout.write(`${CLI} config: unset ${extId}.${key}  (scope: ${unsetScope})\n`);
        // Try to find config_schema to check if the key was required
        process.stdout.write(`  (key '${key}' is no longer set in any scope)\n`);
      } else {
        process.stdout.write(`${CLI} config: unset ${extId}.${key}  (scope: ${unsetScope}) — still set in '${cascaded2 ? (cascadeExtConfig(extId).origins[key] ?? '?') : '?'}' scope\n`);
      }
      process.exit(0);
    }

    // ── check ──────────────────────────────────────────────────────────────
    case 'check': {
      if (!extId) {
        process.stderr.write(`${CLI} config check: usage: ${CLI} config check <ext> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const { value: cascaded3 } = cascadeExtConfig(extId);
      // Find the extension's config_schema — search all scopes' lockfiles so an
      // extension installed at project scope is found even when --scope is omitted.
      let cfgSchema: Record<string, unknown> | undefined;
      let schemaSource = '(unknown)';
      const SEARCH_SCOPES = ['local', 'project', 'user', 'org'];
      for (const searchScope of SEARCH_SCOPES) {
        if (cfgSchema) break;
        try {
          const sp2 = getScopePaths(searchScope, ROOT);
          const lf = loadLockfile(flags['lockfile'] ?? sp2.lockfile);
          const entry = lf?.resolved?.[extId] ?? Object.entries(lf?.resolved ?? {}).find(([k]) => k.startsWith(extId + '@'))?.[1];
          if (entry) {
            const extDir3 = resolveExtensionDir(entry.source, ROOT);
            if (extDir3) {
              const mpath = pathMod.join(extDir3, 'extension.json');
              if (fsMod.existsSync(mpath)) {
                const mf = JSON.parse(fsMod.readFileSync(mpath, 'utf-8')) as Record<string, unknown>;
                cfgSchema = mf['config_schema'] as Record<string, unknown> | undefined;
                schemaSource = mpath;
              }
            }
          }
        } catch { /* best-effort */ }
      }

      if (!cfgSchema) {
        process.stdout.write(`${CLI} config check: no config_schema found for '${extId}' (${schemaSource})\n`);
        process.stdout.write(`Cascade-resolved config has ${Object.keys(cascaded3).length} key(s).\n`);
        process.exit(0);
      }

      const issues: string[] = [];
      const warnings4: string[] = [];
      // Required keys
      const required = Array.isArray(cfgSchema['required']) ? (cfgSchema['required'] as string[]) : [];
      for (const req of required) {
        if (!(req in cascaded3)) {
          issues.push(`required key '${req}' is not set in any scope — run: ${CLI} config set ${extId} ${req} <value>`);
        }
      }
      // Unknown keys (when additionalProperties: false)
      if (cfgSchema['additionalProperties'] === false) {
        const declared = Object.keys((cfgSchema['properties'] as Record<string, unknown> | undefined) ?? {});
        for (const k of Object.keys(cascaded3)) {
          if (!declared.includes(k)) {
            warnings4.push(`key '${k}' is not declared in config_schema — run: ${CLI} config unset ${extId} ${k}`);
          }
        }
      }
      if (issues.length === 0 && warnings4.length === 0) {
        process.stdout.write(`${CLI} config check: OK — '${extId}' config is valid\n`);
        process.stdout.write(`  ${Object.keys(cascaded3).length} key(s) set, all required keys present\n`);
      } else {
        process.stdout.write(`${CLI} config check: ${issues.length} issue(s), ${warnings4.length} warning(s) for '${extId}'\n\n`);
        for (const iss of issues) { process.stdout.write(`  ERROR:   ${iss}\n`); }
        for (const w of warnings4) { process.stdout.write(`  warning: ${w}\n`); }
        process.exit(issues.length > 0 ? 1 : 0);
      }
      process.exit(0);
    }

    default:
      process.stderr.write(`${CLI} config: unknown sub-verb '${subVerb}'. Use: get | set | list | unset | check\n`);
      process.exit(1);
  }
}

// ─── Kick off ─────────────────────────────────────────────────────────────────

void main();
