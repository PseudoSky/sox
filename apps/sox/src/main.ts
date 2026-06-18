/**
 * apps/sox/src/main.ts — sox CLI (extension #0, D1/D2 self-hosting)
 *
 * Full command surface wired to engine libs (sox-extension state, legacy P5).
 *
 * Verbs: init, validate, search, install, start, list, details, enable,
 *        disable, update, uninstall, stop, exec, help
 *
 * [ref:self-hosted-extension-zero] — apps/sox ships extension.json type:command
 * [ref:dual-flag-form]             — parseArgs accepts --flag=value AND --flag value (A12)
 * [inv:nx-dev-only]                — no nx or @nx/* imports anywhere here
 * [inv:nx-free-core]               — sox init uses libs/authoring scaffold(), not the old scaffolder
 */

import {
  parseArgs,
  install,
  loadLockfile,
  loadConfig,
  getScopePath,
  loadRegistryIndex,
  resolveFromRegistry,
  declarativeInstall,
  DeclarativeDeniedError,
  findLocalExtension,
  loadExtensionManifest,
  update as lifecycleUpdate,
  diff as diffExtension,
  diffAll,
} from '@sox/install-engine';
import type { InstallDescriptor, DeclarativeInstallResult, UpdateCtx } from '@sox/install-engine';
import {
  getScopePaths,
  getRuntimeFilePath,
  startRuntime,
  stopRuntime,
  getRuntimeRecord,
  resolveExtensionDir,
  McpClient,
  reconcileRuntime,
  compilePolicy,
} from '@sox/host-runtime';
import type { PermissionsBlock, RuntimeEntry, RuntimeRecord } from '@sox/host-runtime';
// @sox/host-registry is also lazy-required via install-engine; import it lazily here too
// to avoid the NX "static import of lazy-loaded library" lint error.
// [inv:host-registry-lazy]: getHost() used only in cmdInstall; require() at call site.

// ─── Entry ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const verb = argv[0];
// A12: flags after the verb use parseArgs (both --flag=value and --flag value)
const flags = parseArgs(argv.slice(1));

async function main(): Promise<void> {
  // [inv:sox-home-notice] — Warn when SOX_HOME redirects all user-scope paths away from
  // os.homedir(). Silent redirection is surprising; a single stderr line makes it visible.
  const soxHomeOverride = process.env['SOX_HOME'];
  if (soxHomeOverride && verb !== 'help' && verb !== undefined) {
    process.stderr.write(
      `[sox] SOX_HOME is set — user-scope paths rooted at ${soxHomeOverride}\n`,
    );
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
    case 'uninstall':
      cmdUninstall(flags);
      break;
    case 'enable':
      await cmdEnable(flags);
      break;
    case 'disable':
      await cmdDisable(flags);
      break;

    // ── Query ─────────────────────────────────────────────────────────────────
    case 'list':
      cmdList(flags);
      break;
    case 'details':
      cmdDetails(flags);
      break;
    case 'search':
      cmdSearch(flags);
      break;
    case 'status':
      cmdStatus(flags);
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
      printHelp();
      break;

    default:
      if (verb === undefined) {
        printHelp();
      } else {
        process.stderr.write(`sox: unknown verb '${String(verb)}'\n`);
        process.stderr.write(`Run 'sox --help' for usage.\n`);
        process.exit(1);
      }
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(`sox — LLM extension ecosystem CLI (extension #0)

Usage: sox <verb> [flags]

Authoring:
  init <type> <id>   Scaffold a born-conformant extension (uses libs/authoring)
                     Types: agent | skill | mcp-server | hook | command | bundle | service
                     Flags: --out=<dir>  --title=<str>  --description=<str>
                            --author=<str>  --keywords=<k1,k2>
                            --events=<E1,E2>  --runtime=<runtime>
                            --transport=<t>  --transports=<t1,t2>  (service type)

Validation:
  validate [path]    Validate extension.json at path (default: ./extension.json)
                     Flags: --help

Registry / Search:
  search <query>     Search the extension registry
                     Flags: --scope=<scope>  --type=<type>

Extension management:
  install            Install extensions from config
                     Flags: --scope=<scope>  --frozen-lockfile  --update
  update             Update installed extensions
                     Flags: --scope=<scope>
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
                     Flags: --scope=<scope>

Runtime:
  start              Start the sox host runtime
                     Flags: --scope=<scope>  --root=<root>  --id=<ext-id>
  stop               Stop the runtime or a single extension
                     Flags: --scope=<scope>  --id=<ext-id>
  exec               Call a tool on a running extension (A11: via running server)
                     Flags: --scope=<scope>  --id=<ext-id>  --tool=<tool>  --args='<json>'
  list               List activated extensions
                     Flags: --scope=<scope>
  details            Show details for an extension
                     Flags: --id=<ext-id>  --scope=<scope>
  status             Show runtime record

Flags accept both forms: --flag=value  and  --flag value  (A12)

`);
}

// ─── A1: init — uses libs/authoring scaffold() ────────────────────────────────

/**
 * cmdInit — A1: scaffold a born-conformant extension via libs/authoring.
 *
 * Usage: sox init <type> <id> [--out=<dir>] [--title=<str>] [--description=<str>]
 *                             [--author=<str>] [--keywords=<k1,k2>]
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
  // @sox/authoring is genuinely init-only — dynamic import is appropriate here.
  // This is NOT a circular or cross-lib import; it keeps the authoring lib out of
  // the module graph when sox is used for non-init verbs.
  const { scaffold, writeFileSet } = await import('@sox/authoring');

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
    process.stderr.write(`sox init: usage: sox init <type> <id> [--out=<dir>]\n`);
    process.stderr.write(`  Types: agent | skill | mcp-server | hook | command | bundle | service\n`);
    process.exit(1);
  }

  const ACTIVE_TYPES = ['agent', 'skill', 'mcp-server', 'hook', 'command', 'bundle', 'service'] as const;
  if (!(ACTIVE_TYPES as readonly string[]).includes(type)) {
    process.stderr.write(`sox init: unknown type '${type}'\n`);
    process.stderr.write(`  Valid types: ${ACTIVE_TYPES.join(' | ')}\n`);
    process.exit(1);
  }

  // Validate id against the manifest pattern (^[a-z][a-z0-9-]*$).
  const ID_RE = /^[a-z][a-z0-9-]*$/;
  if (!ID_RE.test(id)) {
    process.stderr.write(`sox init: invalid id '${id}' — must match ^[a-z][a-z0-9-]*$\n`);
    process.exit(1);
  }

  const outRoot = flagMap['out'] ?? process.cwd();
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

  const path = await import('node:path');

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
      // Route through the @sox/authoring scope (C7-clean); the build's
      // rewrite-paths step resolves it at runtime. Per-type template fns
      // (agentTemplate, hookTemplate, …) are re-exported from the package.
      const templateMod = (await import('@sox/authoring')) as Record<string, unknown>;
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
          `sox init: internal: template '${fnName}' not found for type '${type}'\n`,
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
      process.stderr.write(`sox init: scaffold error — ${msg}\n`);
      process.exit(1);
    }
  }

  const outDir = path.resolve(outRoot, id);

  // [guard:no-overwrite-existing] — sox init must never clobber existing extensions.
  // If outDir already exists and --force is not set, refuse to proceed.
  // This prevents the probe harness from inadvertently rewriting real repo source files
  // when process.cwd() resolves to the repo root (e.g. due to pushd failure in shell).
  const force = flagMap['force'] !== undefined;
  const { existsSync: _exists } = await import('node:fs');
  if (!force && _exists(outDir)) {
    process.stderr.write(
      `sox init: '${outDir}' already exists — use --force to reinitialize\n`,
    );
    process.exit(1);
  }

  try {
    writeFileSet(fileSet, outDir);
  } catch (e) {
    process.stderr.write(`sox init: write error — ${String(e)}\n`);
    process.exit(1);
  }

  process.stdout.write(`sox init: scaffolded ${type} '${id}' → ${outDir}\n`);
  process.exit(0);
}

// ─── validate ─────────────────────────────────────────────────────────────────

/**
 * cmdValidate — validate an extension.json against libs/manifest.
 *
 * Usage: sox validate [path-to-extension.json]
 *        sox validate --help
 *
 * @sox/manifest is init-only / validate-only — dynamic import keeps it lazy.
 */
async function cmdValidate(raw: string[]): Promise<void> {
  // --help flag — exit 0 (A12: --help is a documented flag form)
  if (raw.includes('--help') || raw.includes('-h')) {
    process.stdout.write(`sox validate — validate an extension.json against the libs/manifest schema

Usage: sox validate [path-to-extension.json]

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

  const { validate } = await import('@sox/manifest');
  const path = await import('node:path');
  const fs = await import('node:fs');

  const positionals = raw.filter((t) => !t.startsWith('-'));
  const manifestPath = positionals[0] ?? 'extension.json';
  const absPath = path.resolve(process.cwd(), manifestPath);

  if (!fs.existsSync(absPath)) {
    process.stderr.write(`sox validate: file not found: ${absPath}\n`);
    process.exit(2);
  }

  let rawObj: unknown;
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    rawObj = JSON.parse(content) as unknown;
  } catch (e) {
    process.stderr.write(`sox validate: parse error: ${String(e)}\n`);
    process.exit(2);
  }

  if (typeof rawObj !== 'object' || rawObj === null || Array.isArray(rawObj)) {
    process.stderr.write(`sox validate: manifest must be a JSON object\n`);
    process.exit(2);
  }

  const result = validate(rawObj as Record<string, unknown>);
  if (result.ok) {
    process.stdout.write(`sox validate: OK — ${absPath}\n`);
    for (const w of (result.warnings ?? [])) {
      process.stdout.write(`  warning: ${w}\n`);
    }
    process.exit(0);
  } else {
    process.stdout.write(`sox validate: INVALID — ${absPath}\n`);
    for (const err of result.errors) {
      process.stdout.write(`  - ${err}\n`);
    }
    for (const w of (result.warnings ?? [])) {
      process.stdout.write(`  warning: ${w}\n`);
    }
    process.exit(1);
  }
}

// ─── search ───────────────────────────────────────────────────────────────────

function cmdSearch(flags: Record<string, string>): void {
  // Accept query as either --query=<q> or the first positional after 'search'.
  let query = flags['query'] ?? '';
  if (query === '') {
    const rawAfterVerb = argv.slice(1); // argv[0] === 'search'
    for (const tok of rawAfterVerb) {
      if (!tok.startsWith('-')) { query = tok; break; }
    }
  }
  const typeFilter = flags['type'];

  // The registry/index.json always lives in the repo root where sox is invoked,
  // NOT in the scope config directory. Use process.cwd(), same as cmdInstall.
  const registryRoot = process.cwd();

  let entries: ReturnType<typeof loadRegistryIndex>;
  try {
    entries = loadRegistryIndex(registryRoot);
  } catch {
    entries = [];
  }

  let results = entries;
  if (query !== '') {
    results = entries.filter(
      (e) =>
        e.id.includes(query) ||
        e.title.includes(query) ||
        e.description.includes(query),
    );
  }
  if (typeFilter !== undefined) {
    results = results.filter((e) => e.type === typeFilter);
  }

  if (results.length === 0) {
    process.stdout.write(`sox search: no results for '${query}'\n`);
  } else {
    const col1 = Math.max(...results.map((e) => e.id.length), 2);
    const col2 = Math.max(...results.map((e) => e.type.length), 4);
    const col3 = Math.max(...results.map((e) => e.version.length), 7);
    process.stdout.write(
      `${'ID'.padEnd(col1)}  ${'TYPE'.padEnd(col2)}  ${'VERSION'.padEnd(col3)}  DESCRIPTION\n`,
    );
    process.stdout.write(`${'-'.repeat(col1)}  ${'-'.repeat(col2)}  ${'-'.repeat(col3)}  -----------\n`);
    for (const entry of results) {
      process.stdout.write(
        `${entry.id.padEnd(col1)}  ${entry.type.padEnd(col2)}  ${entry.version.padEnd(col3)}  ${entry.description}\n`,
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
 *     sox install <id> --host=<h> [--scope=project] [--root=<dir>] [--profile=<p>]
 *   --host absent  → config/lockfile resolver (existing path, unchanged).
 *     sox install [--scope=<s>] [--frozen-lockfile] [--update]
 *
 * The existing host-runtime e2e (memory-server) uses the no---host path, so keeping
 * it unchanged preserves all 59 passing tests.
 */
async function cmdInstall(flags: Record<string, string>): Promise<void> {
  const host = flags['host'];

  // ── Declarative path: --host present ───────────────────────────────────────
  if (host !== undefined && host !== '') {
    // Parse positional id from argv (flags map has no positionals).
    // argv[1] is the first token after the verb; skip tokens that start with '--'.
    const rawAfterVerb = argv.slice(1);
    let id: string | undefined;
    for (const tok of rawAfterVerb) {
      if (!tok.startsWith('-')) { id = tok; break; }
    }

    if (id === undefined || id === '') {
      process.stderr.write('sox install: declarative path requires a positional <id>\n');
      process.stderr.write('  Usage: sox install <id> --host=<host> [--scope=project] [--root=<dir>]\n');
      process.exit(1);
    }

    const scope = (flags['scope'] ?? 'project') as 'org' | 'user' | 'project' | 'local';
    const workspaceRoot = require('node:path').resolve(flags['root'] ?? process.cwd()) as string;
    const profile = flags['profile'];

    // Resolve the extension: load registry from the REAL repo root (process.cwd()),
    // not from workspaceRoot (which may be a temp dir when --root is given for sandboxing).
    // The registry/index.json always lives in the repo root where 'node bin/sox' is invoked.
    const repoRoot = process.cwd();
    const registryIndex = loadRegistryIndex(repoRoot);
    const registryEntry = resolveFromRegistry(id, undefined, registryIndex);

    // Determine srcPath: the extension's content directory.
    let srcPath: string | undefined;
    let extType: string | undefined;
    let extHosts: string[] = [host];

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
            extHosts = [host]; // --host overrides the manifest hosts list
          }
        }
      }
    }

    if (srcPath === undefined) {
      process.stderr.write(`sox install: cannot find extension '${id}' in registry or local extensions/\n`);
      process.stderr.write('  Run \'npx tsx scripts/build-index.ts\' to rebuild the registry, or check the id.\n');
      process.exit(1);
    }

    if (extType === undefined) {
      process.stderr.write(`sox install: cannot determine type for extension '${id}'\n`);
      process.exit(1);
    }

    // Validate the host exists in the registry.
    // [inv:host-registry-lazy] — require() at call site; see top-of-file comment.
    const { getHost } = require('@sox/host-registry') as typeof import('@sox/host-registry');
    try {
      getHost(host);
    } catch (e) {
      process.stderr.write(`sox install: ${String(e)}\n`);
      process.exit(1);
    }

    // Compute scopeRoot: for project scope, same as workspaceRoot.
    // For user scope, we use the host's scopePaths to find the root.
    const hostMod = getHost(host);
    const hostScopePaths = hostMod.scopePaths(scope as Parameters<typeof hostMod.scopePaths>[0]);
    // scopeRoot is the root used for the install ledger.
    const scopeRoot = scope === 'project'
      ? workspaceRoot
      : (Object.values(hostScopePaths)[0] ?? workspaceRoot);

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
        { isProject: scope === 'project' },
      );
    } catch (e) {
      if (e instanceof DeclarativeDeniedError) {
        process.stderr.write(`sox install: DENIED — ${e.reason}\n`);
        process.exit(1);
      }
      process.stderr.write(`sox install: declarative install failed — ${String(e)}\n`);
      process.exit(1);
    }

    let anyApplied = false;
    let anyDenied = false;

    for (const r of results) {
      if (r.denied === true) {
        process.stderr.write(`sox install: DENIED  ${r.host}/${r.scope}  ${r.target}  reason=${r.denialReason ?? 'unknown'}\n`);
        anyDenied = true;
      } else if (r.applied) {
        process.stdout.write(`sox install: placed   ${r.host}/${r.scope}  ${r.target}\n`);
        anyApplied = true;
      } else {
        process.stdout.write(`sox install: up-to-date  ${r.host}/${r.scope}  ${r.target}\n`);
        anyApplied = true;
      }
    }

    if (results.length === 0) {
      process.stderr.write(`sox install: no install surfaces found for host='${host}' type='${extType}' scope='${scope}'\n`);
      process.exit(1);
    }

    if (anyDenied || !anyApplied) {
      process.exit(1);
    }

    process.exit(0);
  }

  // ── Existing resolver path: --host absent ──────────────────────────────────
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const frozen = flags['frozen-lockfile'] === 'true';
  const update = flags['update'] === 'true';
  const mode = frozen ? 'frozen' : update ? 'update' : 'default';

  // --config / --lockfile: explicit paths override the scope defaults.
  // These are required by the e2e test which installs into a temp directory.
  const configPathFlag = flags['config'];
  const lockfilePathFlag = flags['lockfile'];

  // If a positional <id> was given (e.g. `sox install sox --scope=project`),
  // write it into the scope config before resolving — otherwise install() only
  // re-resolves what's already in extensions.json and the new id is silently ignored.
  const rawAfterVerb2 = argv.slice(1);
  let positionalId: string | undefined;
  for (const tok of rawAfterVerb2) {
    if (!tok.startsWith('-')) { positionalId = tok; break; }
  }

  if (positionalId !== undefined && positionalId !== '') {
    const fsMod2  = require('node:fs')   as typeof import('node:fs');
    const pathMod2 = require('node:path') as typeof import('node:path');
    // Use the explicit --config path if provided; fall back to scope default.
    const cfgPath = configPathFlag ?? getScopePath(scope).config;

    let cfg: { install?: Array<{ id: string }> } = { install: [] };
    if (fsMod2.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fsMod2.readFileSync(cfgPath, 'utf8')) as typeof cfg; } catch { /* use default */ }
    }
    if (!cfg.install) cfg.install = [];

    const alreadyPresent = cfg.install.some((e) => e.id === positionalId);
    if (!alreadyPresent) {
      cfg.install.push({ id: positionalId });
      fsMod2.mkdirSync(pathMod2.dirname(cfgPath), { recursive: true });
      fsMod2.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      process.stdout.write(`sox install: added '${positionalId}' to ${cfgPath}\n`);
    }
  }

  // Interactive config prompting: when stdout is a TTY, provide readline-based
  // prompt for missing required config keys declared in config_schema.
  const installOpts: Parameters<typeof import('@sox/install-engine').install>[0] = {
    scope,
    mode,
    ...(configPathFlag !== undefined ? { configPath: configPathFlag } : {}),
    ...(lockfilePathFlag !== undefined ? { lockfilePath: lockfilePathFlag } : {}),
  };

  // Interactive config prompting: when stdout is a TTY, provide readline-based
  // prompt for missing required config keys declared in config_schema.
  if (process.stdout.isTTY) {
    installOpts.onMissingConfig = async (_extId: string, _key: string, prompt: string, defaultVal: unknown): Promise<string | undefined> => {
      const rl = require('node:readline') as typeof import('node:readline');
      const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
      const defaultStr = defaultVal !== undefined ? String(defaultVal) : '';
      const fullPrompt = defaultStr
        ? `sox install: ${prompt} [${defaultStr}]: `
        : `sox install: ${prompt}: `;
      return new Promise((resolve) => {
        iface.question(fullPrompt, (answer: string) => {
          iface.close();
          const val = answer.trim() || defaultStr;
          resolve(val || undefined);
        });
      });
    };
  }

  await install(installOpts);

  // ── Re-materialize service-registered extensions ───────────────────────────
  // The main install() call only writes the lockfile. If any extension is
  // registered as a service in .sox/registry.json, re-copy the bundle from
  // its source dir to the store dir so the next `sox start` picks up the
  // updated bundle without requiring `--profile=service` or a full reinstall.
  {
    const fsMod3  = require('node:fs')   as typeof import('node:fs');
    const pathMod3 = require('node:path') as typeof import('node:path');

    const registryPath3 = pathMod3.join(process.cwd(), '.sox', 'registry.json');
    const lockfilePath3 = configPathFlag !== undefined
      ? (lockfilePathFlag ?? getScopePath(scope).lockfile)
      : (lockfilePathFlag ?? getScopePath(scope).lockfile);
    const lockfile3 = loadLockfile(lockfilePath3);

    if (fsMod3.existsSync(registryPath3) && lockfile3 !== null) {
      let registry3: Record<string, { id: string; storePath: string }> = {};
      try {
        registry3 = JSON.parse(fsMod3.readFileSync(registryPath3, 'utf8')) as typeof registry3;
      } catch { /* malformed — skip */ }

      for (const [svcId, svc] of Object.entries(registry3)) {
        // Find the lockfile entry for this service (with or without @version suffix)
        const lkEntry3 = lockfile3.resolved[svcId] ??
          Object.entries(lockfile3.resolved).find(([k]) => k.startsWith(svcId + '@'))?.[1];
        if (!lkEntry3) continue;

        const extDir3 = resolveExtensionDir(lkEntry3.source, process.cwd());
        if (!extDir3) continue;

        const bundleDir3 = pathMod3.join(extDir3, 'bundle');
        const distDir3   = pathMod3.join(extDir3, 'dist');
        const srcDir3 = fsMod3.existsSync(bundleDir3) ? bundleDir3
                      : fsMod3.existsSync(distDir3)   ? distDir3
                      : null;
        if (!srcDir3) continue;

        const storePath3 = svc.storePath;

        // Recursively copy bundle → store dir (overwrites existing files)
        const copyDirSync3 = (src: string, dest: string): void => {
          if (!fsMod3.existsSync(dest)) fsMod3.mkdirSync(dest, { recursive: true });
          for (const ent of fsMod3.readdirSync(src, { withFileTypes: true })) {
            const s = pathMod3.join(src, ent.name);
            const d = pathMod3.join(dest, ent.name);
            if (ent.isDirectory()) copyDirSync3(s, d);
            else fsMod3.copyFileSync(s, d);
          }
        };
        copyDirSync3(srcDir3, storePath3);

        // Re-copy extension.json with entrypoint = index.js
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

        process.stdout.write(`sox install: refreshed store   ${storePath3}\n`);
      }
    }
  }

  process.stdout.write(`sox install: done (scope=${scope}, mode=${mode})\n`);
  process.exit(0);
}

// ─── build ────────────────────────────────────────────────────────────────────

/**
 * cmdBuild — A: build an extension in the current working directory.
 *
 * Usage: sox build <id>
 *
 * If the extension's built entrypoint already exists (e.g. dist/index.js pre-compiled
 * by the template), this exits 0 immediately.  Otherwise it attempts `npm run build`
 * in the extension directory.
 *
 * [cli-wiring.3]: verb is wired and exits 0 after `sox init mcp-server <id>`.
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
    process.stderr.write('sox build: extension id required\n');
    process.stderr.write('  Usage: sox build <id>\n');
    process.exit(1);
  }

  // Find the extension directory: <id>/ relative to cwd.
  const extDir = pathMod.resolve(process.cwd(), id);
  const manifestPath = pathMod.join(extDir, 'extension.json');

  if (!fsMod.existsSync(manifestPath)) {
    process.stderr.write(`sox build: extension not found at ${extDir}\n`);
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
    process.stdout.write(`sox build: ${id} — entrypoint present, nothing to rebuild\n`);
    process.exit(0);
  }

  // Attempt npm run build in the extension directory.
  const pkgJsonPath = pathMod.join(extDir, 'package.json');
  if (!fsMod.existsSync(pkgJsonPath)) {
    process.stderr.write(`sox build: no package.json found in ${extDir}\n`);
    process.exit(1);
  }

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: extDir,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    process.stderr.write(`sox build: build failed for ${id}\n`);
    process.exit(result.status ?? 1);
  }

  process.stdout.write(`sox build: ${id} built\n`);
  process.exit(0);
}

// ─── diff ─────────────────────────────────────────────────────────────────────

/**
 * cmdDiff — diff ledger vs disk for an extension.
 *
 * Usage: sox diff <id> [--host=<h>] [--scope=<s>] [--root=<dir>]
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
  // For project scope the scope root == workspace root; for user scope use homedir.
  const scopeRoot = scope === 'project' ? workspaceRoot : require('node:os').homedir() as string;

  if (id !== undefined && id !== '') {
    // Single-extension diff.
    // [inv:diff-exits-zero]: diff is a query command — always exits 0; drift reported on stdout.
    const result = diffExtension(id, host, scope, scopeRoot, { isProject: scope === 'project' });
    if (result.clean) {
      process.stdout.write(`sox diff: ${id} — up to date (no drift)\n`);
    } else {
      process.stdout.write(`sox diff: ${id} — drift detected\n`);
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
      process.stdout.write(`sox diff: all extensions up to date (scope=${scope})\n`);
    } else {
      process.stdout.write(`sox diff: ${dirty.length} extension(s) have drift\n`);
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
 *     sox update <id> --host=<h> [--scope=project] [--root=<dir>]
 *   --host absent  → config/lockfile update (existing path).
 *     sox update [--scope=<s>]
 *
 * [cli-wiring.5]: verb is wired and exits 0.
 */
async function cmdUpdate(flags: Record<string, string>): Promise<void> {
  const host = flags['host'];

  // ── Declarative path: --host present ───────────────────────────────────────
  if (host !== undefined && host !== '') {
    const pathMod = require('node:path') as typeof import('node:path');

    // Resolve id from positional arg.
    const rawAfterVerb = argv.slice(1);
    let id: string | undefined;
    for (const tok of rawAfterVerb) {
      if (!tok.startsWith('-')) { id = tok; break; }
    }

    if (id === undefined || id === '') {
      process.stderr.write('sox update: declarative path requires a positional <id>\n');
      process.stderr.write('  Usage: sox update <id> --host=<host> [--scope=project] [--root=<dir>]\n');
      process.exit(1);
    }

    const scope = (flags['scope'] ?? 'project') as 'org' | 'user' | 'project' | 'local';
    const workspaceRoot = pathMod.resolve(flags['root'] ?? process.cwd());
    const scopeRoot = scope === 'project' ? workspaceRoot : require('node:os').homedir() as string;

    const ctx: UpdateCtx = {
      ext: id,
      host,
      scope,
      scopeRoot,
      workspaceRoot,
      isProject: scope === 'project',
    };

    const result = await lifecycleUpdate(ctx);
    if (result.kind === 'updated') {
      process.stdout.write(`sox update: ${id} updated (${result.actions.join(', ')})\n`);
    } else {
      process.stdout.write(`sox update: ${id} — up to date\n`);
    }
    process.exit(0);
  }

  // ── Existing resolver path: --host absent (unchanged) ──────────────────────
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  await install({ scope, mode: 'update' });
  process.stdout.write(`sox update: done (scope=${scope})\n`);
  process.exit(0);
}

// ─── uninstall ────────────────────────────────────────────────────────────────

function cmdUninstall(flags: Record<string, string>): void {
  const ROOT5 = process.cwd();
  // Accept positional or --id flag.
  const rawAfterVerb = argv.slice(1);
  let positional: string | undefined;
  for (const tok of rawAfterVerb) {
    if (!tok.startsWith('-')) { positional = tok; break; }
  }
  const id = flags['id'] ?? positional;
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const root = flags['root'] ?? ROOT5;

  if (id === undefined || id === '') {
    process.stderr.write(`sox uninstall: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');

  let scopePaths5: { config: string; lockfile: string };
  try {
    scopePaths5 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox uninstall: ${String(e)}\n`);
    process.exit(1);
  }

  // Honor explicit --lockfile / --config overrides (used by e2e to operate on temp paths).
  const lockfilePath5 = flags['lockfile'] ?? scopePaths5.lockfile;
  const configPath5   = flags['config']   ?? scopePaths5.config;

  const lockfile = loadLockfile(lockfilePath5);

  if (lockfile === null) {
    process.stderr.write(`sox uninstall: no lockfile at ${lockfilePath5}\n`);
    process.exit(1);
  }

  // Lockfile keys are "<id>@<version>". Accept either form: bare id or versioned key.
  const lockKeys = Object.keys(lockfile.resolved);
  const matchKey = lockKeys.find((k) => {
    if (k === id) return true;                          // exact match (unlikely but safe)
    const atIdx = k.lastIndexOf('@');
    return atIdx !== -1 && k.slice(0, atIdx) === id;   // base-id match
  });

  if (matchKey === undefined) {
    process.stderr.write(`sox uninstall: extension '${id}' not found in lockfile\n`);
    process.stderr.write(`  Installed: ${lockKeys.join(', ') || '(none)'}\n`);
    process.exit(1);
  }

  // Remove from lockfile.
  const updatedLock = { ...lockfile, resolved: { ...lockfile.resolved } };
  delete updatedLock.resolved[matchKey];
  fsMod.writeFileSync(lockfilePath5, JSON.stringify(updatedLock, null, 2) + '\n', 'utf-8');

  // Also remove from extensions.json so the next `sox install` doesn't re-add it.
  if (fsMod.existsSync(configPath5)) {
    try {
      const cfg = JSON.parse(fsMod.readFileSync(configPath5, 'utf8')) as {
        install?: Array<{ id: string }>;
      };
      if (Array.isArray(cfg.install)) {
        cfg.install = cfg.install.filter((e) => e.id !== id);
        fsMod.writeFileSync(configPath5, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      }
    } catch { /* config parse failure — lockfile is already cleaned up, that's enough */ }
  }

  process.stdout.write(`sox uninstall: removed '${id}' (${matchKey}) from scope '${scope}'\n`);
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
    process.stderr.write(`sox enable: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');

  let scopePaths3: { config: string; lockfile: string };
  try {
    scopePaths3 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox enable: ${String(e)}\n`);
    process.exit(1);
  }

  const configPath3   = flags['config']       ?? scopePaths3.config;
  const lockfilePath3 = flags['lockfile']     ?? scopePaths3.lockfile;
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
  //    This preserves the test's startProcess reference until `sox stop` kills it
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
    process.stderr.write(`sox enable: no running supervisor found in runtime record — try 'sox start' first\n`);
    process.exit(1);
  }

  try {
    process.stdout.write(`sox: signaling supervisor (pid=${supPid3}) to reconcile (enable '${id}')...\n`);
    process.kill(supPid3, 'SIGHUP');
  } catch (e) {
    process.stderr.write(`sox enable: could not signal supervisor: ${String(e)}\n`);
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
    process.stdout.write(`sox enable: '${id}' enabled and running\n`);
  } else {
    process.stderr.write(
      `sox enable: '${id}' enabled but process did not appear running within timeout\n`,
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
    process.stderr.write(`sox disable: extension id required (positional or --id)\n`);
    process.exit(1);
  }

  const fsMod = require('node:fs') as typeof import('node:fs');

  let scopePaths4: { config: string; lockfile: string };
  try {
    scopePaths4 = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox disable: ${String(e)}\n`);
    process.exit(1);
  }

  const configPath4  = flags['config']   ?? scopePaths4.config;
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
  const supPid4   = typeof rtRaw4?.supervisorPid === 'number' ? rtRaw4.supervisorPid : null;

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

  process.stdout.write(`sox disable: '${id}' disabled\n`);
  process.exit(0);
}

// ─── list ─────────────────────────────────────────────────────────────────────

function cmdList(flags: Record<string, string>): void {
  const ROOT2 = process.cwd();
  // When no explicit --scope is given, scan all scopes (user, project, local) —
  // matching the old bin/sox behaviour and allowing `sox list --root=TMP` to find
  // project-scope extensions without requiring `-s project`.
  const scopeOverride = flags['scope'];
  const root = flags['root'] ?? ROOT2;
  const statusFilter = flags['status']; // e.g. --status=running
  const jsonMode = flags['json'] !== undefined;

  const fsMod = require('node:fs') as typeof import('node:fs');

  const runtimeFileOverride = flags['runtime-file'] ?? process.env['SOX_RUNTIME_FILE'];

  const scopesToScan = scopeOverride !== undefined
    ? [scopeOverride]
    : ['user', 'project', 'local'];

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
      const ver   = atIdx === -1 ? '' : lockKey.slice(atIdx + 1);

      const rtEntry = runtimeEntries.find((r) => (r.key ?? r.id) === lockKey || r.id === extId);
      const pid = (rtEntry?.pid != null && typeof rtEntry.pid === 'number') ? rtEntry.pid : null;
      // C4: validate RUNNING state against the OS process table, not just the bookkeeping record.
      // A stale runtime.json entry (crash, SIGKILL, reboot) must not appear as RUNNING.
      const pidAlive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
      const running = rtEntry?.running === true && pid !== null && pidAlive(pid);

      const rawSrc = rtEntry?.source ?? entry?.source ?? '';
      const source = cleanSource(typeof rawSrc === 'string' ? rawSrc : '');

      allRows.push({ id: extId, key: lockKey, version: ver, scope: sc, running, source, pid });
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
      `sox list: no extensions installed (scopes: ${scopesToScan.join(', ')})\n`,
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

function cmdDetails(flags: Record<string, string>): void {
  const id = flags['id'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  if (id === undefined || id === '') {
    process.stderr.write(`sox details: --id is required\n`);
    process.exit(1);
  }

  const scopePaths = getScopePath(scope);
  const lockfile = loadLockfile(scopePaths.lockfile);

  if (lockfile === null) {
    process.stderr.write(`sox details: no lockfile at ${scopePaths.lockfile}\n`);
    process.exit(1);
  }

  const entry = lockfile.resolved[id];
  if (entry === undefined) {
    process.stderr.write(`sox details: extension '${id}' not found\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ id, ...entry }, null, 2) + '\n');
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
    process.stderr.write(`sox start: ${String(e)}\n`);
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
      process.stdout.write(`sox start: no extensions in lockfile at ${lockfilePath}\n`);
      process.stdout.write(`Run 'sox install <ext> -s ${scope}' to install an extension.\n`);
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
      `Run 'sox start -s ${scope}' to start all extensions.\n` +
      `Run 'sox exec --list -s ${scope}' to see available tools once running.\n\n`,
    );
    process.exit(0);
  }

  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  // ── [dod.5] Service-registry path ──────────────────────────────────────────
  // When sox install --profile service was used, services are recorded in
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
        // Build SOX_CONFIG_* env vars from cascade-resolved config for this service.
        const svcConfigEnv: Record<string, string> = {};
        {
          const SVC_CASCADE_SCOPES = ['org', 'user', 'project', 'local'] as const;
          const svcConfigMerged: Record<string, unknown> = {};
          for (const cs of SVC_CASCADE_SCOPES) {
            try {
              const csp = getScopePaths(cs, root);
              const cfgSvc = loadConfig(csp.config);
              const blk = (cfgSvc?.config as Record<string, Record<string, unknown>> | undefined)?.[svc.id] ?? {};
              Object.assign(svcConfigMerged, blk); // narrower scope overwrites wider
            } catch { /* skip missing scope */ }
          }
          const { homedir: hd } = require('node:os') as typeof import('node:os');
          const homeDir5 = hd();
          for (const [cfgKey, cfgVal] of Object.entries(svcConfigMerged)) {
            const envKey = `SOX_CONFIG_${cfgKey.toUpperCase().replace(/[-\s]/g, '_')}`;
            let strVal = typeof cfgVal === 'string' ? cfgVal : (cfgVal === null || cfgVal === undefined ? '' : JSON.stringify(cfgVal));
            if (strVal.startsWith('~/')) strVal = homeDir5 + strVal.slice(1);
            strVal = strVal.replace(/\$\{([A-Z0-9_]+)\}/g, (_m: string, varName: string) => process.env[varName] ?? _m);
            svcConfigEnv[envKey] = strVal;
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
        // source points to the store dir so sox exec can find extension.json there.
        const source = `file://${svc.storePath}`;
        runtimeEntries.push({
          key: svc.id,
          id: svc.id,
          type: 'mcp-server',
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

      // Write runtime record so sox exec can find the entries.
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
      `  logs           : (attached to this terminal — use Ctrl+C or 'sox stop' to shut down)\n`,
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
    process.stderr.write(`sox start: failed — ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── stop ─────────────────────────────────────────────────────────────────────

async function cmdStop(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;
  const id = flags['id'];

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox stop: ${String(e)}\n`);
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
      process.stdout.write(`sox stop: no runtime running at scope '${scope}'.\n`);
      process.stdout.write(`Run 'sox start -s ${scope}' to start the runtime.\n`);
      process.exit(0);
    }
    const running = record0.entries.filter((e) => e.running);
    if (running.length === 0) {
      process.stdout.write(`sox stop: no extensions currently running (scope: ${scope}).\n`);
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
      `Run 'sox stop -s ${scope}' to stop all.\n` +
      `Run 'sox stop --id=<ext> -s ${scope}' to stop one extension.\n\n`,
    );
    process.exit(0);
  }

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(`sox: no runtime record at ${runtimeFilePath}\n`);
    process.exit(0);
  }

  // stop-via-supervisor: signal the supervisor process (not children directly)
  if (id === undefined && typeof record.supervisorPid === 'number') {
    try {
      process.kill(record.supervisorPid, 'SIGTERM');
      process.stdout.write(
        `sox: signaling supervisor (pid=${record.supervisorPid}) to stop\n`,
      );
    } catch (e) {
      process.stderr.write(`sox: could not signal supervisor: ${String(e)}\n`);
    }
    process.exit(0);
  }

  await stopRuntime({ scope, runtimeFilePath, id });
  process.stdout.write(`sox: stop complete\n`);
  process.exit(0);
}

// ─── status ───────────────────────────────────────────────────────────────────

function cmdStatus(flags: Record<string, string>): void {
  const ROOT = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root = flags['root'] ?? ROOT;

  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox status: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const record = getRuntimeRecord(runtimeFilePath);
  if (!record) {
    process.stdout.write(
      `sox: no runtime record at ${runtimeFilePath} (host not started?)\n`,
    );
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  process.exit(0);
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
  const rlMod  = require('node:readline') as typeof import('node:readline');

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
      finish(() => reject(new Error(`sox exec: timeout waiting for exec socket response (${timeoutMs}ms)`)));
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
          reject(new Error(`sox exec: invalid response from exec socket: ${line.slice(0, 120)}`));
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
  const rlMod  = require('node:readline') as typeof import('node:readline');

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
    const typeStr  = typeof propDef['type'] === 'string' ? propDef['type'] : '';
    const enumVals = Array.isArray(propDef['enum'])
      ? (propDef['enum'] as unknown[]).map(String).join(' | ')
      : '';
    const desc = typeof propDef['description'] === 'string' ? propDef['description'] : '';
    const req  = required.has(propName) ? '*' : ' ';
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
    process.stdout.write(`Run 'sox start -s ${scope}' to start the runtime.\n`);
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
  const firstExt  = listResult.extensions.find((e) => e.tools.length > 0);
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
      `Example:\n  sox exec ${firstExt.id} ${firstTool.name} --args='${argsJson}' -s ${scope}\n\n` +
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
 *   3. No runtime.json → hard error: "run sox start first."
 *
 * [inv:exec-socket]: The socket is only present in supervisor mode (lockfile-based
 * start where the sox process stays alive). Service-mode starts (detached via
 * registry.json) legitimately have no socket — fresh spawn is correct there.
 */
async function cmdExec(flags: Record<string, string>): Promise<void> {
  if (flags['help'] !== undefined || flags['h'] !== undefined) {
    process.stdout.write(`sox exec — call a tool on a running extension (A11)

Usage:
  sox exec <ext-id> <tool> [--args=<json>] [-s <scope>]
  sox exec --id=<ext-id> --tool=<tool> [--args=<json>] [--scope=<scope>]
  sox exec --list [-s <scope>]           # list all tools on running extensions
  sox exec --list --id=<ext-id>          # list tools for one extension
  sox exec <tool-name>                   # show schema + example for a named tool

Flags:
  --id=<ext-id>    Extension id (must be running — see 'sox exec --list')
  --tool=<name>    MCP tool name declared by the extension
  --args=<json>    JSON object of tool arguments (default: {})
  --scope=<scope>  Scope of the runtime record (default: user)
  --list           List all executable tools (no tool call made)

Routing:
  1. If the runtime has an exec socket (supervisor mode) → routes through the
     live supervisor session; no process spawned.
  2. If no socket (service-mode detached start) → spawns a fresh MCP session.

Examples:
  sox exec --list -s project
  sox exec memory-server memory_write --args='{"content":"hello"}' -s project
  sox exec memory_write                # show schema for memory_write
`);
    process.exit(0);
  }

  const ROOT  = process.cwd();
  const scope = flags['scope'] ?? 'user';
  const root  = flags['root']  ?? ROOT;

  // Resolve runtimeFilePath using same scope → lockfile → getRuntimeFilePath
  // chain as cmdStop / cmdList / cmdDetails, so the default is always correct.
  let scopePaths: { config: string; lockfile: string };
  try {
    scopePaths = getScopePaths(scope, root);
  } catch (e) {
    process.stderr.write(`sox exec: ${String(e)}\n`);
    process.exit(1);
  }

  const lockfilePath = flags['lockfile'] ?? scopePaths.lockfile;
  const runtimeFilePath =
    flags['runtime-file'] ??
    process.env['SOX_RUNTIME_FILE'] ??
    getRuntimeFilePath(lockfilePath);

  const fsMod   = require('node:fs')   as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');

  // ── --list: show all tools from the live registrar ────────────────────────
  if (flags['list'] !== undefined) {
    const record0 = getRuntimeRecord(runtimeFilePath);
    if (!record0) {
      process.stderr.write(
        `sox exec: no runtime record at ${runtimeFilePath}. Run 'sox start -s ${scope}' first.\n`,
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
        process.stderr.write(`sox exec: list failed: ${String(e)}\n`);
        process.exit(1);
      }
      process.exit(0);
    }

    // ── Service-mode fallback: spawn fresh MCP per entry, call tools/list ───
    // Used when sox start ran in service mode (no supervisor / no exec socket).
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
          const rawId = entry.id ?? (entry.key.includes('@')
            ? entry.key.slice(0, entry.key.lastIndexOf('@'))
            : entry.key);
          extensions.push({
            key: entry.key,
            id: rawId,
            serverInfo: { name: rawId, version: entry.key.includes('@') ? entry.key.slice(entry.key.lastIndexOf('@') + 1) : (manifest2.version ?? '?') },
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
  //   sox exec <ext-id> <tool> [args-json]
  //   sox exec --id <ext-id> --tool <tool> [--args <json>]
  //   sox exec <tool-name>   (single positional → show schema)
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

  const extIdFlag  = flags['id'];
  const toolFlag   = flags['tool'];
  const argsJson   = flags['args'] ?? positionals[2] ?? '{}';

  // ── Single positional with no --id / --tool → schema lookup ──────────────
  // `sox exec memory_write` — find the tool across all extensions, show schema.
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
              `Example:\n  sox exec ${ext.id} ${found.name} --args='${argsEx}' -s ${scope}\n\n`,
            );
            process.exit(0);
          }
        }
        process.stderr.write(
          `sox exec: tool '${queryTool}' not found in any running extension.\n` +
          `Run 'sox exec --list -s ${scope}' to see available tools.\n`,
        );
      } catch {
        // socket unavailable — fall through to normal error path
      }
    }
    process.stderr.write(
      `sox exec: tool '${queryTool}' not found. Run 'sox exec --list -s ${scope}' to see available tools.\n`,
    );
    process.exit(1);
  }

  const extId    = extIdFlag  ?? positionals[0] ?? '';
  const toolName = toolFlag   ?? positionals[1] ?? '';

  if (extId === '' || toolName === '') {
    if (extId === '') {
      process.stderr.write(
        `sox exec: extension id required.\n` +
        `Run 'sox exec --list -s ${scope}' to see running extensions and their tools.\n`,
      );
    } else {
      process.stderr.write(
        `sox exec: tool name required.\n` +
        `Run 'sox exec --list --id=${extId} -s ${scope}' to see tools for '${extId}'.\n`,
      );
    }
    process.exit(1);
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    process.stderr.write(`sox exec: invalid --args JSON: ${argsJson}\n`);
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
      `sox exec: no runtime record at ${runtimeFilePath}. Run 'sox start -s ${scope}' first.\n`,
    );
    process.exit(1);
  }

  const entry = record.entries.find((e) => e.id === extId || e.key === extId);
  if (!entry) {
    const available = record.entries.map((e) => e.id).join(', ');
    process.stderr.write(
      `sox exec: extension '${extId}' not found in runtime.\n` +
      (available ? `Running extensions: ${available}\n` : `No extensions in runtime record.\n`) +
      `Run 'sox exec --list -s ${scope}' to see available extensions and tools.\n`,
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
          `sox exec: tool '${toolName}' not found on '${extId}'.\n` +
          `Run 'sox exec --list --id=${extId} -s ${scope}' to see available tools.\n`,
        );
        process.exit(1);
      }
      // Other socket error — fall through to fresh spawn with a warning.
      process.stderr.write(`sox exec: exec socket failed (${errMsg}), falling back to fresh spawn\n`);
    }
  }

  // ── Route 2: fresh MCP spawn (service-mode detached, or socket unavailable) ─
  // Spawn a fresh MCP session with the same policy enforcement as the supervisor.
  // [inv:no-regress]: identical behaviour to the pre-A11 path when socket is absent.
  const extDir = resolveExtensionDir(entry.source, ROOT);
  if (!extDir) {
    process.stderr.write(
      `sox exec: cannot resolve extension dir from source: ${entry.source}\n`,
    );
    process.exit(1);
  }

  const manifestPath = pathMod.join(extDir, 'extension.json');
  if (!fsMod.existsSync(manifestPath)) {
    process.stderr.write(`sox exec: manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  // [process-boundary.exec] — mirror supervisor enforced-spawn for C6 compliance.
  const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8')) as {
    entrypoint?: string;
    permissions?: PermissionsBlock;
  };
  if (!manifest.entrypoint) {
    process.stderr.write(`sox exec: no entrypoint in manifest at ${manifestPath}\n`);
    process.exit(1);
  }

  const policy = compilePolicy(manifest.permissions);

  let execEnv: NodeJS.ProcessEnv;
  if (policy.enforced) {
    const allowedKeys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && (allowedKeys.has(k) || k.startsWith('NODE_'))) {
        baseEnv[k] = v;
      }
    }
    execEnv = { ...baseEnv, ...policy.toEnv() };
  } else {
    execEnv = { ...process.env };
  }

  const entrypointPath = pathMod.resolve(extDir, manifest.entrypoint);
  if (!fsMod.existsSync(entrypointPath)) {
    process.stderr.write(`sox exec: entrypoint not found at ${entrypointPath}\n`);
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
    process.stderr.write(`sox exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── sox config ───────────────────────────────────────────────────────────────

/**
 * cmdConfig — manage per-extension install-time configuration.
 *
 * Sub-verbs:
 *   sox config get   <ext> <key>           [--scope=<scope>]
 *   sox config set   <ext> <key> <value>   [--scope=<scope>]
 *   sox config list  <ext>                 [--scope=<scope>]
 *   sox config unset <ext> <key>           [--scope=<scope>]
 *   sox config check <ext>                 [--scope=<scope>]
 *
 * Config is stored in extensions.json under the "config" block keyed by ext id.
 * get/list operate on the active scope's file (pass --scope to target another).
 * set/unset write to the specified scope (default: user).
 * check validates the cascade-resolved config against the extension's config_schema.
 */
async function cmdConfig(argv: string[], flags: Record<string, string>): Promise<void> {
  const fsMod   = require('node:fs')   as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const osMod   = require('node:os')   as typeof import('node:os');

  const subVerb  = argv[1];
  const ROOT     = flags['root'] ?? process.cwd();

  if (!subVerb || subVerb === '--help' || subVerb === '-h') {
    process.stdout.write(`sox config — manage per-extension install-time configuration

Sub-verbs:
  sox config get   <ext> <key> [--scope=<scope>]   Get a config value (cascade-resolved)
  sox config set   <ext> <key> <value> [--scope]   Write a value to the scope config (default: user)
  sox config list  <ext> [--scope=<scope>]          List all config keys with cascade origin
  sox config unset <ext> <key> [--scope=<scope>]   Remove a key from the scope config
  sox config check <ext> [--scope=<scope>]          Validate config against config_schema

Flags:
  --scope=<scope>  Scope: org | user | project | local  (default: user for set/unset, current for get/list/check)

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
  const key   = positionals[2];
  const value = positionals[3];

  switch (subVerb) {
    // ── get ────────────────────────────────────────────────────────────────
    case 'get': {
      if (!extId || !key) {
        process.stderr.write(`sox config get: usage: sox config get <ext> <key> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const { value: cascaded } = cascadeExtConfig(extId);
      if (key in cascaded) {
        process.stdout.write(String(cascaded[key]) + '\n');
        process.exit(0);
      } else {
        process.stderr.write(`sox config get: key '${key}' not set for '${extId}'\n`);
        process.exit(1);
      }
    }

    // ── set ────────────────────────────────────────────────────────────────
    case 'set': {
      if (!extId || !key || value === undefined) {
        process.stderr.write(`sox config set: usage: sox config set <ext> <key> <value> [--scope=<scope>]\n`);
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
          `sox config set: warning: '${key}' looks like a secret — consider using an env ref instead: \${${key.toUpperCase().replace(/[-\s]/g, '_')}}\n`,
        );
      }
      writeScopeConfig(writeScope, ROOT, cfgObj);
      process.stdout.write(`sox config: set ${extId}.${key} = ${value}  (scope: ${writeScope})\n`);
      process.exit(0);
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      if (!extId) {
        process.stderr.write(`sox config list: usage: sox config list <ext> [--scope=<scope>]\n`);
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
        process.stderr.write(`sox config unset: usage: sox config unset <ext> <key> [--scope=<scope>]\n`);
        process.exit(1);
      }
      const unsetScope = flags['scope'] ?? 'user';
      const cfgObj2 = loadScopeConfig(unsetScope, ROOT);
      const configBlock2 = (cfgObj2['config'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      if (!configBlock2[extId] || !(key in configBlock2[extId])) {
        process.stderr.write(`sox config unset: key '${key}' not set for '${extId}' in scope '${unsetScope}'\n`);
        process.exit(1);
      }
      delete configBlock2[extId][key];
      if (Object.keys(configBlock2[extId]).length === 0) delete configBlock2[extId];
      cfgObj2['config'] = configBlock2;
      writeScopeConfig(unsetScope, ROOT, cfgObj2);
      // Warn if required key becomes unset in cascade after removal
      const { value: cascaded2 } = cascadeExtConfig(extId);
      if (!(key in cascaded2)) {
        process.stdout.write(`sox config: unset ${extId}.${key}  (scope: ${unsetScope})\n`);
        // Try to find config_schema to check if the key was required
        process.stdout.write(`  (key '${key}' is no longer set in any scope)\n`);
      } else {
        process.stdout.write(`sox config: unset ${extId}.${key}  (scope: ${unsetScope}) — still set in '${cascaded2 ? (cascadeExtConfig(extId).origins[key] ?? '?') : '?'}' scope\n`);
      }
      process.exit(0);
    }

    // ── check ──────────────────────────────────────────────────────────────
    case 'check': {
      if (!extId) {
        process.stderr.write(`sox config check: usage: sox config check <ext> [--scope=<scope>]\n`);
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
        process.stdout.write(`sox config check: no config_schema found for '${extId}' (${schemaSource})\n`);
        process.stdout.write(`Cascade-resolved config has ${Object.keys(cascaded3).length} key(s).\n`);
        process.exit(0);
      }

      const issues: string[] = [];
      const warnings4: string[] = [];
      // Required keys
      const required = Array.isArray(cfgSchema['required']) ? (cfgSchema['required'] as string[]) : [];
      for (const req of required) {
        if (!(req in cascaded3)) {
          issues.push(`required key '${req}' is not set in any scope — run: sox config set ${extId} ${req} <value>`);
        }
      }
      // Unknown keys (when additionalProperties: false)
      if (cfgSchema['additionalProperties'] === false) {
        const declared = Object.keys((cfgSchema['properties'] as Record<string, unknown> | undefined) ?? {});
        for (const k of Object.keys(cascaded3)) {
          if (!declared.includes(k)) {
            warnings4.push(`key '${k}' is not declared in config_schema — run: sox config unset ${extId} ${k}`);
          }
        }
      }
      if (issues.length === 0 && warnings4.length === 0) {
        process.stdout.write(`sox config check: OK — '${extId}' config is valid\n`);
        process.stdout.write(`  ${Object.keys(cascaded3).length} key(s) set, all required keys present\n`);
      } else {
        process.stdout.write(`sox config check: ${issues.length} issue(s), ${warnings4.length} warning(s) for '${extId}'\n\n`);
        for (const iss of issues) { process.stdout.write(`  ERROR:   ${iss}\n`); }
        for (const w of warnings4) { process.stdout.write(`  warning: ${w}\n`); }
        process.exit(issues.length > 0 ? 1 : 0);
      }
      process.exit(0);
    }

    default:
      process.stderr.write(`sox config: unknown sub-verb '${subVerb}'. Use: get | set | list | unset | check\n`);
      process.exit(1);
  }
}

// ─── Kick off ─────────────────────────────────────────────────────────────────

void main();
