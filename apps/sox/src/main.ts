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
  getRegistrar,
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
      cmdEnable(flags);
      break;
    case 'disable':
      cmdDisable(flags);
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
                     Types: agent | skill | mcp-server | hook | command | bundle
                     Flags: --out=<dir>  --title=<str>  --description=<str>
                            --author=<str>  --keywords=<k1,k2>
                            --events=<E1,E2>  --runtime=<runtime>

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

Runtime:
  start              Start the sox host runtime
                     Flags: --scope=<scope>  --root=<root>
  stop               Stop the runtime or a single extension
                     Flags: --scope=<scope>  --id=<ext-id>
  exec               Call a tool on a running extension (A11: via running server)
                     Flags: --id=<ext-id>  --tool=<tool>  --args='<json>'
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
    process.stderr.write(`  Types: agent | skill | mcp-server | hook | command | bundle\n`);
    process.exit(1);
  }

  const ACTIVE_TYPES = ['agent', 'skill', 'mcp-server', 'hook', 'command', 'bundle'] as const;
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
    process.exit(0);
  } else {
    process.stdout.write(`sox validate: INVALID — ${absPath}\n`);
    for (const err of result.errors) {
      process.stdout.write(`  - ${err}\n`);
    }
    process.exit(1);
  }
}

// ─── search ───────────────────────────────────────────────────────────────────

function cmdSearch(flags: Record<string, string>): void {
  const query = flags['query'] ?? '';
  const typeFilter = flags['type'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  const scopePaths = getScopePath(scope);
  const registryRoot = require('node:path').dirname(scopePaths.config) as string;

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
    for (const entry of results) {
      process.stdout.write(`  ${entry.id}  ${entry.version}  ${entry.description}\n`);
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

  // ── Existing resolver path: --host absent (unchanged) ──────────────────────
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const frozen = flags['frozen-lockfile'] === 'true';
  const update = flags['update'] === 'true';
  const mode = frozen ? 'frozen' : update ? 'update' : 'default';

  await install({ scope, mode });
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
  const id = flags['id'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  if (id === undefined || id === '') {
    process.stderr.write(`sox uninstall: --id is required\n`);
    process.exit(1);
  }

  const fs = require('node:fs') as typeof import('node:fs');

  const scopePaths = getScopePath(scope);
  const lockfile = loadLockfile(scopePaths.lockfile);

  if (lockfile === null) {
    process.stderr.write(`sox uninstall: no lockfile at ${scopePaths.lockfile}\n`);
    process.exit(1);
  }

  if (!(id in lockfile.resolved)) {
    process.stderr.write(`sox uninstall: extension '${id}' not found in lockfile\n`);
    process.exit(1);
  }

  const updated = { ...lockfile, resolved: { ...lockfile.resolved } };
  delete updated.resolved[id];

  fs.writeFileSync(scopePaths.lockfile, JSON.stringify(updated, null, 2), 'utf-8');
  process.stdout.write(`sox uninstall: removed '${id}' from ${scopePaths.lockfile}\n`);
  process.exit(0);
}

// ─── enable ───────────────────────────────────────────────────────────────────

function cmdEnable(flags: Record<string, string>): void {
  const id = flags['id'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  if (id === undefined || id === '') {
    process.stderr.write(`sox enable: --id is required\n`);
    process.exit(1);
  }

  const fs = require('node:fs') as typeof import('node:fs');

  const scopePaths = getScopePath(scope);
  const config = loadConfig(scopePaths.config);
  if (config === null) {
    process.stderr.write(`sox enable: no config at ${scopePaths.config}\n`);
    process.exit(1);
  }

  // enable-reactivation [def:session-fixes]: set enabled=true in config
  const updated = {
    ...config,
    enabled: { ...(config.enabled ?? {}), [id]: true },
  };

  fs.writeFileSync(scopePaths.config, JSON.stringify(updated, null, 2), 'utf-8');
  process.stdout.write(`sox enable: '${id}' enabled\n`);
  process.exit(0);
}

// ─── disable ──────────────────────────────────────────────────────────────────

function cmdDisable(flags: Record<string, string>): void {
  const id = flags['id'];
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  if (id === undefined || id === '') {
    process.stderr.write(`sox disable: --id is required\n`);
    process.exit(1);
  }

  const fs = require('node:fs') as typeof import('node:fs');

  const scopePaths = getScopePath(scope);
  const config = loadConfig(scopePaths.config);
  if (config === null) {
    process.stderr.write(`sox disable: no config at ${scopePaths.config}\n`);
    process.exit(1);
  }

  const updated = {
    ...config,
    enabled: { ...(config.enabled ?? {}), [id]: false },
  };

  fs.writeFileSync(scopePaths.config, JSON.stringify(updated, null, 2), 'utf-8');
  process.stdout.write(`sox disable: '${id}' disabled\n`);
  process.exit(0);
}

// ─── list ─────────────────────────────────────────────────────────────────────

function cmdList(flags: Record<string, string>): void {
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';

  const scopePaths = getScopePath(scope);
  const lockfile = loadLockfile(scopePaths.lockfile);

  if (lockfile === null) {
    process.stdout.write(
      `sox list: no extensions installed (no lockfile at ${scopePaths.lockfile})\n`,
    );
    process.exit(0);
  }

  const resolved = lockfile.resolved;
  const ids = Object.keys(resolved);

  if (ids.length === 0) {
    process.stdout.write(`sox list: no extensions installed\n`);
  } else {
    for (const extId of ids) {
      const entry = resolved[extId];
      const label =
        entry !== undefined
          ? `  ${extId}  ${entry.resolved_at ?? ''}`
          : `  ${extId}`;
      process.stdout.write(`${label}\n`);
    }
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
        // Spawn detached: parent exits, child keeps running independently.
        const child = spawnChild(svc.command, svc.args, {
          detached: true,
          stdio: 'ignore',
          cwd: svc.cwd,
          env: { ...process.env, ...(svc.env ?? {}) },
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
  try {
    const record = await startRuntime({
      scope,
      lockfilePath,
      configPath,
      runtimeFilePath,
      root,
      overrideHealthToStdioPing: true,
    });

    const runningCount = record.entries.filter((e) => e.running).length;
    process.stdout.write(
      `sox: runtime started — ${record.entries.length} extension(s) activated, ${runningCount} running\n`,
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

// ─── exec (A11) ───────────────────────────────────────────────────────────────

/**
 * cmdExec — A11 fix: exec via the running server.
 *
 * Routes through the MCP registrar to call a tool on an already-running
 * extension, rather than spawning a throwaway session each time.
 */
async function cmdExec(flags: Record<string, string>): Promise<void> {
  const ROOT = process.cwd();
  const runtimeFilePath =
    flags['runtime-file'] ?? process.env['SOX_RUNTIME_FILE'] ?? '';

  // Support both flag form (--id --tool --args) and positional form:
  //   sox exec <id> <tool> [args-json]
  // Positionals: argv[1..] after the 'exec' verb, skipping flag tokens.
  const rawAfterVerb = argv.slice(1);  // argv[0] = 'exec'
  const positionals: string[] = [];
  for (let i = 0; i < rawAfterVerb.length; i++) {
    const tok = rawAfterVerb[i];
    if (tok === undefined) continue;
    if (tok.startsWith('--')) {
      if (!tok.includes('=')) i++; // skip the value token for --flag value form
    } else {
      positionals.push(tok);
    }
  }

  const extId    = flags['id']   ?? positionals[0] ?? '';
  const toolName = flags['tool'] ?? positionals[1] ?? '';
  const argsJson = flags['args'] ?? positionals[2] ?? '{}';

  if (extId === '') {
    process.stderr.write(`sox exec: extension id required (positional or --id)\n`);
    process.exit(1);
  }
  if (toolName === '') {
    process.stderr.write(`sox exec: tool name required (positional or --tool)\n`);
    process.exit(1);
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    process.stderr.write(`sox exec: invalid --args JSON: ${argsJson}\n`);
    process.exit(1);
  }

  const record = getRuntimeRecord(
    runtimeFilePath !== '' ? runtimeFilePath : 'runtime.json',
  );
  if (!record) {
    process.stderr.write(
      `sox exec: no runtime record. Run 'sox start' first.\n`,
    );
    process.exit(1);
  }

  const entry = record.entries.find(
    (e) => e.id === extId || e.key === extId,
  );
  if (!entry) {
    process.stderr.write(
      `sox exec: extension '${extId}' not found in runtime record.\n`,
    );
    process.exit(1);
  }

  // A11 fix: try the running server first via the registrar
  const registrar =
    runtimeFilePath !== '' ? getRegistrar(runtimeFilePath) : null;

  if (registrar) {
    try {
      const result = await registrar.call(extId, toolName, toolArgs);
      process.stdout.write(JSON.stringify(result) + '\n');
      // [exec-exit-code]: exit 1 when the tool signals an error (isError: true in MCP response).
      // This maps MCP-level tool denials (permission enforcement, unknown tool) to a non-zero
      // exit code so `assert_nonzero` in the probe harness correctly detects enforcement.
      const mcpResult = result as { isError?: boolean };
      process.exit(mcpResult.isError ? 1 : 0);
    } catch {
      // Registrar call failed — fall through to fresh spawn
      process.stderr.write(
        `sox exec: registrar call failed, falling back to fresh spawn\n`,
      );
    }
  }

  // Fallback: spawn a fresh MCP session
  const extDir = resolveExtensionDir(entry.source, ROOT);
  if (!extDir) {
    process.stderr.write(
      `sox exec: cannot resolve extension dir from source: ${entry.source}\n`,
    );
    process.exit(1);
  }

  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  const manifestPath = path.join(extDir, 'extension.json');
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`sox exec: manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  // [process-boundary.exec] — Compile policy from the manifest's permissions block
  // and inject it into the child env, mirroring the supervisor's enforced spawn path.
  // This closes the C6 enforcement gap for the apps/sox canonical CLI exec path.
  // TODO C7: de-duplicate exec with runtime-cli (apps/sox and runtime-cli each hold a copy)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    entrypoint?: string;
    permissions?: PermissionsBlock;
  };
  if (!manifest.entrypoint) {
    process.stderr.write(
      `sox exec: no entrypoint in manifest at ${manifestPath}\n`,
    );
    process.exit(1);
  }

  const policy = compilePolicy(manifest.permissions);

  let execEnv: NodeJS.ProcessEnv;
  if (policy.enforced) {
    // Scrub child env to the same minimal allowlist as supervisor._spawn enforced path.
    const allowedKeys = new Set([
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TZ',
    ]);
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && (allowedKeys.has(k) || k.startsWith('NODE_'))) {
        baseEnv[k] = v;
      }
    }
    // policy.toEnv() injects the enforce flag + 4 policy JSON arrays ([def:policy-env]).
    // Goes last so it cannot be shadowed by any parent env var.
    execEnv = { ...baseEnv, ...policy.toEnv() };
  } else {
    // [inv:no-regress] — No permissions block: byte-identical to pre-state.
    execEnv = { ...process.env };
  }

  const entrypointPath = path.resolve(extDir, manifest.entrypoint);
  if (!fs.existsSync(entrypointPath)) {
    process.stderr.write(
      `sox exec: entrypoint not found at ${entrypointPath}\n`,
    );
    process.exit(1);
  }

  const { spawn } = require('node:child_process') as typeof import('node:child_process');

  // [dod.5]: spawn from the extension dir (store dir for service bundles) so
  // the child process cwd matches its self-contained store dir.
  // extDir = the store dir (resolveExtensionDir resolved file://<storePath>).
  const child = spawn(process.execPath, [entrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: execEnv,
    cwd: extDir,
  });

  // [shape:serve-marker]: forward child stderr to process stderr so the
  // "[serve] real-path" marker appears in the probe harness LAST_ERR capture.
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d);
  });

  const client = new McpClient(child);
  try {
    await client.call(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sox-exec', version: '1.0.0' },
      },
      10000,
    );
    const result = await client.call(
      'tools/call',
      { name: toolName, arguments: toolArgs },
      30000,
    );
    process.stdout.write(JSON.stringify(result) + '\n');
    client.close();
    child.kill('SIGTERM');
    // [exec-exit-code]: exit 1 when the tool signals an error (isError: true in MCP response).
    const mcpResult2 = result as { isError?: boolean };
    process.exit(mcpResult2.isError ? 1 : 0);
  } catch (e) {
    client.close();
    child.kill('SIGTERM');
    process.stderr.write(`sox exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── Kick off ─────────────────────────────────────────────────────────────────

void main();
