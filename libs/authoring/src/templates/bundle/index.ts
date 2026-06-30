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
    `// soxe guarantees SIGKILL after stop_timeout_ms if this handler does not exit.`,
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

/**
 * BORN-PUBLISHABLE package.json for a bundle member (G4 / SCOPE §7).
 * No `private` (Q3: members publish too); publishConfig + engines + files so the
 * tarball is publish + fresh-machine-install ready. No bare-`tsc` script — the nx
 * project.json builds a SELF-CONTAINED esbuild bundle (Model A: zero `@adhd/sox-*`
 * runtime deps). A member that imports `@adhd/sox-*` declares them in
 * devDependencies (inlined by the bundler); a member with a native addon adds it
 * to `dependencies` and `--external` in its project.json build.
 */
function memberPackageJson(memberId: string): string {
  return JSON.stringify(
    {
      name: `@adhd/sox-extension-${memberId}`,
      version: '0.1.0',
      license: 'MIT',
      publishConfig: { access: 'public' },
      engines: { node: '>=20' },
      files: ['dist', 'extension.json'],
      main: 'dist/index.js',
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
            // Model A / BL-37/38: SELF-CONTAINED esbuild bundle — inlines every
            // @adhd/sox-* (resolved from each lib's dist) so the published artifact
            // carries ZERO @adhd runtime deps and runs from an npm-package store on
            // a fresh machine. A native addon (e.g. better-sqlite3) is declared in
            // package.json `dependencies` AND added here as `--external <pkg>`.
            commands: [
              `rm -rf ${memberPath}/dist`,
              `node tools/bundle-extension.cjs --entry ${memberPath}/src/index.ts --outdir ${memberPath}/dist --tsconfig ${memberPath}/tsconfig.json`,
            ],
            parallel: false,
            cwd: '.',
          },
          cache: true,
          // NB: no per-target `inputs` override. Cache policy lives in nx.json
          // targetDefaults (`build`/`test` carry `^production` + `^build`). A narrow
          // project-level `inputs` REPLACES (does not merge with) the defaults and
          // silently drops dependency-awareness — an upstream source change would no
          // longer invalidate this project's cache. See docs/nx-cache-conformance.md.
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

  // Bundles are declarative (no build) but still PUBLISH as a tiny package so the
  // manifest (members[]) is fetchable on a fresh machine (G4). Born-publishable:
  // no `private`, publishConfig + engines, files carries extension.json.
  const bundlePkg = JSON.stringify(
    {
      name: `@adhd/sox-extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      license: 'MIT',
      publishConfig: { access: 'public' },
      engines: { node: '>=20' },
      files: ['extension.json'],
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
      `soxe install ${opts.id} --scope user`,
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
