/**
 * Shared template helpers — used by all per-type template modules.
 *
 * [inv:nx-free-core] — zero nx-packages imports.
 * [ref:host-keyed-target] — NO literal host paths (.claude/, ~/.claude/, .codex/)
 *   outside libs/host-registry. Templates emit install: { type, hosts, profiles, serves }
 *   and the engine resolves target paths from libs/host-registry at install time.
 */

import type { ActiveType } from '../index.js';

/**
 * The subset of ScaffoldOpts that templates receive (title/description always present).
 *
 * Appendix-A generator options — carried through from ScaffoldOpts to templates.
 * [generators.1]: all Appendix-A options must reach the emitted descriptor.
 */
export interface TemplateOpts {
  type: ActiveType;
  id: string;
  title: string;
  description: string;
  author: string | undefined;
  keywords: string[] | undefined;
  // ── Appendix-A: content / provenance ─────────────────────────────────────
  /** --content @path body text (filled when @source used at init). */
  content?: string | undefined;
  /**
   * [def:source-provenance] Origin path when --content @path / --from @dir used.
   * Stamped into install.source on the manifest. [generators.3]
   */
  source?: string | undefined;
  // ── Appendix-A: install descriptor ──────────────────────────────────────
  /** --host: chosen host targets (e.g. ['claude', 'codex']). [inv:host-agnostic-type] */
  hosts?: string[] | undefined;
  /** --scope: install scope (project | user | local). */
  scope?: string | undefined;
  /** --permissions: declared permission overrides. */
  permissions?: Record<string, unknown> | undefined;
  /** --env: environment variable declarations. */
  env?: Record<string, string> | undefined;
  // ── Appendix-A: mcp-server specific ──────────────────────────────────────
  /** --transports: mcp transports (stdio | sse | http). [def:serves] */
  transports?: string[] | undefined;
  /** --profile / --mode: install-layer preset name (e.g. standalone | shared). [def:profile] */
  profile?: string | undefined;
  /** --trust: mcp trust disposition (prompt | auto). [inv:never-managed] */
  trust?: string | undefined;
  // ── Appendix-A: command specific ─────────────────────────────────────────
  /** --surface: command surface override (e.g. claude-commands | codex-commands). */
  surface?: string | undefined;
  // ── Appendix-A: prompt specific ──────────────────────────────────────────
  /** --inject: prompt injection target (rules | claude-md). Used only by prompt type. */
  inject?: string | undefined;
}

/** Compatibility block used by all templates */
const COMPATIBILITY = { host: '>=1.0.0 <2.0.0' };

/** Schema reference — points to the registry v2 schema */
const SCHEMA = 'https://your-registry/schemas/extension/v2.json';

// ─── extension.json builders ──────────────────────────────────────────────────

interface BaseManifest {
  $schema: string;
  id: string;
  version: string;
  type: string;
  title: string;
  description: string;
  compatibility: Record<string, string>;
  license: string;
  author?: string;
  keywords?: string[];
  [key: string]: unknown;
}

function baseManifest(opts: TemplateOpts, extra: Record<string, unknown> = {}): BaseManifest {
  const m: BaseManifest = {
    $schema: SCHEMA,
    id: opts.id,
    version: '0.1.0',
    type: opts.type,
    title: opts.title,
    description: opts.description,
    compatibility: COMPATIBILITY,
    license: 'MIT',
  };
  if (opts.author !== undefined && opts.author !== '') {
    m['author'] = opts.author;
  }
  if (opts.keywords !== undefined && opts.keywords.length > 0) {
    m['keywords'] = opts.keywords;
  }
  return Object.assign(m, extra);
}

/**
 * Build the [shape:install-descriptor] block for the manifest.
 *
 * [inv:host-agnostic-type] — only type + hosts + profiles/serves/source are emitted;
 * target paths are resolved from libs/host-registry at install time (not here).
 * [ref:host-keyed-target] — no literal .claude/ or ~/.claude/ paths here.
 *
 * @param type     The extension type (host-agnostic).
 * @param opts     TemplateOpts carrying Appendix-A values.
 * @param serves   Transports the mcp type implements (mcp-server only).
 * @param profiles Install-layer presets (mcp-server only; key → preset config).
 */
export function buildInstallDescriptor(
  type: string,
  opts: TemplateOpts,
  serves?: string[],
  profiles?: Record<string, unknown>,
): Record<string, unknown> {
  const install: Record<string, unknown> = { type };

  // hosts — chosen targets; engine resolves paths from host-registry at install time
  if (opts.hosts !== undefined && opts.hosts.length > 0) {
    install['hosts'] = opts.hosts;
  }

  // serves — mcp transport declarations [def:serves]
  const effectiveServes = serves ?? opts.transports;
  if (effectiveServes !== undefined && effectiveServes.length > 0) {
    install['serves'] = effectiveServes;
  }

  // profiles — install-layer presets [def:profile]
  if (profiles !== undefined && Object.keys(profiles).length > 0) {
    // Merge: use template defaults; inject opts.profile as a named preset if provided and absent.
    const merged: Record<string, unknown> = { ...profiles };
    if (opts.profile !== undefined && merged[opts.profile] === undefined) {
      merged[opts.profile] = {};
    }
    install['profiles'] = merged;
  } else if (opts.profile !== undefined) {
    install['profiles'] = { [opts.profile]: {} };
  }

  // source — [def:source-provenance] — stamped when --content @path / --from used [generators.3]
  if (opts.source !== undefined && opts.source !== '') {
    install['source'] = opts.source;
  }

  return install;
}

/** Serialize a manifest to pretty JSON */
export function manifestJson(opts: TemplateOpts, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(baseManifest(opts, extra), null, 2);
}

// ─── package.json builder ─────────────────────────────────────────────────────

/** Build a per-extension package.json. Includes tsconfig + scripts. */
export function packageJson(opts: TemplateOpts): string {
  const pkg: Record<string, unknown> = {
    name: `@sox/extension-${opts.id}`,
    version: '0.1.0',
    description: opts.description,
    private: true,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    files: ['dist'],
    scripts: {
      build: 'tsc --project tsconfig.json',
      typecheck: 'tsc --noEmit --project tsconfig.json',
      test: 'vitest run',
    },
    license: 'MIT',
  };
  if (opts.author !== undefined && opts.author !== '') {
    pkg['author'] = opts.author;
  }
  if (opts.keywords !== undefined && opts.keywords.length > 0) {
    pkg['keywords'] = opts.keywords;
  }
  return JSON.stringify(pkg, null, 2);
}

/** Build a per-extension tsconfig.json (the gap from new-extension.ts — now fixed). */
export function tsconfigJson(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        lib: ['ES2022'],
        types: ['node'],
        strict: true,
        noImplicitAny: true,
        strictNullChecks: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

/** Build a CHANGELOG.md stub */
export function changelogMd(): string {
  return '# Changelog\n\n## 0.1.0\n\n- Initial release\n';
}

/** Build a basic README.md */
export function readmeMd(opts: TemplateOpts, sections: string[] = []): string {
  const base = [
    `# ${opts.title}`,
    '',
    `> ${opts.description}`,
    '',
    '## Overview',
    '',
    `<!-- Describe what this ${opts.type} does and the problem it solves. -->`,
    '',
  ];
  return [...base, ...sections, '', '## License', '', 'MIT'].join('\n');
}
