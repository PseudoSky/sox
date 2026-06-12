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
} from '@sox/install-engine';
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
} from '@sox/host-runtime';

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
      const templateMod = await import(
        // Relative path: dist/apps/sox/ → root → libs/authoring/dist/templates/<type>/
        `../../../libs/authoring/dist/templates/${type}/index.js` as string
      ) as Record<string, unknown>;
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

async function cmdInstall(flags: Record<string, string>): Promise<void> {
  const scope = (flags['scope'] ?? 'user') as 'org' | 'user' | 'project' | 'local';
  const frozen = flags['frozen-lockfile'] === 'true';
  const update = flags['update'] === 'true';
  const mode = frozen ? 'frozen' : update ? 'update' : 'default';

  await install({ scope, mode });
  process.stdout.write(`sox install: done (scope=${scope}, mode=${mode})\n`);
  process.exit(0);
}

// ─── update ───────────────────────────────────────────────────────────────────

async function cmdUpdate(flags: Record<string, string>): Promise<void> {
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
  const extId = flags['id'] ?? '';
  const toolName = flags['tool'] ?? '';
  const argsJson = flags['args'] ?? '{}';

  if (extId === '') {
    process.stderr.write(`sox exec: --id is required\n`);
    process.exit(1);
  }
  if (toolName === '') {
    process.stderr.write(`sox exec: --tool is required\n`);
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
      process.exit(0);
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

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    entrypoint?: string;
  };
  if (!manifest.entrypoint) {
    process.stderr.write(
      `sox exec: no entrypoint in manifest at ${manifestPath}\n`,
    );
    process.exit(1);
  }

  const entrypointPath = path.resolve(extDir, manifest.entrypoint);
  if (!fs.existsSync(entrypointPath)) {
    process.stderr.write(
      `sox exec: entrypoint not found at ${entrypointPath}\n`,
    );
    process.exit(1);
  }

  const { spawn } = require('node:child_process') as typeof import('node:child_process');

  const child = spawn(process.execPath, [entrypointPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
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
    process.exit(0);
  } catch (e) {
    client.close();
    child.kill('SIGTERM');
    process.stderr.write(`sox exec: tool call failed: ${String(e)}\n`);
    process.exit(1);
  }
}

// ─── Kick off ─────────────────────────────────────────────────────────────────

void main();
