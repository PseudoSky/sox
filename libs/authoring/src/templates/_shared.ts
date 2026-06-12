/**
 * Shared template helpers — used by all per-type template modules.
 *
 * [inv:nx-free-core] — zero nx-packages imports.
 */

import type { ActiveType } from '../index.js';

/** The subset of ScaffoldOpts that templates receive (title/description always present). */
export interface TemplateOpts {
  type: ActiveType;
  id: string;
  title: string;
  description: string;
  author: string | undefined;
  keywords: string[] | undefined;
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
