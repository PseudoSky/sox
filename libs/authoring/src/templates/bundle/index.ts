/**
 * Bundle template — scaffolds a manifest-only bundle extension (no entrypoint).
 *
 * R9: supports --member=<type>:<member-id> to co-scaffold member extensions at
 * members/<member-id>/ with visibility: "internal" and bundle_id set automatically.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=bundle, members=[...],
 *                     install block with type+hosts)
 *   package.json
 *   CHANGELOG.md
 *   README.md
 *   members/<member-id>/extension.json    (when --member flags provided)
 *   members/<member-id>/src/index.ts
 *   members/<member-id>/package.json
 *   members/<member-id>/project.json
 *
 * Bundles have NO src/ directory and NO entrypoint. They are expanded to their
 * members at install time. tsconfig is omitted (nothing to compile).
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install.type used; no hardcoded host paths.
 * [ref:host-keyed-target] — target paths resolved from host-registry at install time.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { buildInstallDescriptor, changelogMd, manifestJson, readmeMd } from '../_shared.js';

/** Minimal stub src/index.ts for a member extension */
function memberStubSrc(memberId: string, memberType: string): string {
  return [
    `// ${memberId} — ${memberType} member of bundle`,
    `// Replace with real implementation.`,
    ``,
    `// R6: SIGTERM handler (required for background extensions).`,
    `// sox guarantees SIGKILL after stop_timeout_ms if this handler does not exit.`,
    `process.on('SIGTERM', () => {`,
    `  // TODO: complete in-flight requests, flush writes.`,
    `  process.exit(0);`,
    `});`,
    ``,
    `export function main(): void {`,
    `  process.stderr.write('${memberId}: not yet implemented\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
    `main();`,
  ].join('\n');
}

/** Minimal extension.json for a bundle member */
function memberManifestJson(bundleId: string, memberId: string, memberType: string): string {
  return JSON.stringify(
    {
      $schema: 'https://your-registry/schemas/extension/v2.json',
      id: memberId,
      version: '0.1.0',
      type: memberType,
      visibility: 'internal',
      bundle_id: bundleId,
      title: memberId,
      description: `${memberId} — member of ${bundleId}`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      runtime: 'node',
      entrypoint: 'dist/index.js',
    },
    null,
    2,
  );
}

/** Minimal package.json for a bundle member */
function memberPackageJson(memberId: string): string {
  return JSON.stringify(
    {
      name: `@adhd/sox-extension-${memberId}`,
      version: '0.1.0',
      private: true,
      main: 'dist/index.js',
      scripts: {
        build: 'tsc --project tsconfig.json',
      },
      license: 'MIT',
    },
    null,
    2,
  );
}

/** Minimal tsconfig.json for a bundle member (path relative to members/<id>/) */
function memberTsconfigJson(): string {
  return JSON.stringify(
    {
      extends: '../../../../../tsconfig.base.json',
      compilerOptions: {
        module: 'CommonJS',
        moduleResolution: 'node10',
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  );
}

/** Minimal project.json for a bundle member (Nx workspace integration) */
function memberProjectJson(bundleId: string, memberId: string): string {
  const memberPath = `extensions/bundles/${bundleId}/members/${memberId}`;
  return JSON.stringify(
    {
      $schema: '../../../../../../node_modules/nx/schemas/project-schema.json',
      name: memberId,
      projectType: 'library',
      root: memberPath,
      sourceRoot: `${memberPath}/src`,
      tags: ['type:extension'],
      targets: {
        build: {
          executor: 'nx:run-commands',
          outputs: [`{workspaceRoot}/${memberPath}/dist`],
          options: {
            command: `tsc --project ${memberPath}/tsconfig.json`,
            cwd: '.',
          },
          cache: true,
          inputs: [
            '{projectRoot}/src/**/*.ts',
            '{projectRoot}/tsconfig.json',
          ],
        },
        lint: {
          executor: '@nx/eslint:lint',
          options: {
            lintFilePatterns: [`${memberPath}/src/**/*.ts`],
          },
        },
      },
    },
    null,
    2,
  );
}

export function bundleTemplate(opts: TemplateOpts): FileSet {
  const members = opts.members ?? [];

  // Build the members array for the bundle manifest.
  // ADR-0003: members are referenced by `id` only (identity = id + checksum).
  const memberRefs = members.length > 0
    ? members.map((m) => ({ id: m.id }))
    : [
      { id: 'example-member-a' },
      { id: 'example-member-b' },
    ];

  // Bundles use a simplified package.json (no build/typecheck scripts needed)
  const bundlePkg = JSON.stringify(
    {
      name: `@adhd/sox-extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      private: true,
      license: 'MIT',
      ...(opts.author !== undefined && opts.author !== '' ? { author: opts.author } : {}),
      ...(opts.keywords !== undefined && opts.keywords.length > 0 ? { keywords: opts.keywords } : {}),
    },
    null,
    2,
  );

  const files: Record<string, string> = {
    'extension.json': manifestJson(opts, {
      // [flex:entrypoint-optional] — bundles have no entrypoint (schema allows omission)
      members: memberRefs,
      // [shape:install-descriptor] — host-agnostic; engine expands bundle members
      // and resolves each member's target from libs/host-registry at install time.
      // [ref:host-keyed-target] — NO literal host path here.
      install: buildInstallDescriptor('bundle', opts),
    }),

    'package.json': bundlePkg,

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe the scenario where installing this bundle makes sense. -->`,
      '',
      '## Members',
      '',
      '| Extension id       | Role            |',
      '| ------------------ | --------------- |',
      ...memberRefs.map((m) => `| ${m.id.padEnd(18)} | (describe role) |`),
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
      '',
      'The installer expands the bundle to its members — no entrypoint is required.',
    ]),
  };

  // R9: co-scaffold member extensions in members/<id>/ with visibility: "internal"
  for (const member of members) {
    const prefix = `members/${member.id}`;
    files[`${prefix}/extension.json`] = memberManifestJson(opts.id, member.id, member.type);
    files[`${prefix}/src/index.ts`] = memberStubSrc(member.id, member.type);
    files[`${prefix}/package.json`] = memberPackageJson(member.id);
    files[`${prefix}/tsconfig.json`] = memberTsconfigJson();
    files[`${prefix}/project.json`] = memberProjectJson(opts.id, member.id);
  }

  return files;
}
