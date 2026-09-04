/**
 * schema-parity.spec.ts — BL-623: schema.json ↔ inlined ManifestSchema parity.
 *
 * libs/manifest/src/schema.json is declared the "single source of truth"
 * (index.ts:770) but index.ts ALSO inlines a copy as `ManifestSchema` so the
 * dist output is self-contained. The two drifted: the inlined copy gained
 * `opencode` in install.hosts (3 hosts) and install.additionalProperties:true,
 * while the JSON file stayed at 2 hosts + additionalProperties:false. Runtime
 * validation follows the INLINED copy + KNOWN_HOSTS, so the JSON file was
 * misleading (a future consumer reading the file would reject a valid opencode
 * manifest).
 *
 * This test makes the drift impossible: the JSON file must deep-equal the
 * inlined schema, so either edit is caught at test time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestSchema } from './index.js';

// libs/manifest compiles as CommonJS (tsconfig module=CommonJS), so `import.meta`
// is not available to typecheck; `__dirname` is (and vitest shims it for ESM).
declare const __dirname: string;
const schemaJsonPath = join(__dirname, 'schema.json');

describe('schema.json ↔ ManifestSchema parity (BL-623)', () => {
  it('schema.json parses to valid JSON', () => {
    const raw = readFileSync(schemaJsonPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('schema.json deep-equals the inlined ManifestSchema (no drift)', () => {
    const onDisk = JSON.parse(readFileSync(schemaJsonPath, 'utf8'));
    expect(onDisk).toEqual(ManifestSchema);
  });

  it('install.hosts enumerates all three hosts', () => {
    const props = ManifestSchema['properties'] as Record<string, unknown>;
    const install = props['install'] as Record<string, unknown>;
    const installProps = install['properties'] as Record<string, unknown>;
    const hosts = installProps['hosts'] as { items: { enum: string[] } };
    expect(hosts.items.enum).toEqual(['claude', 'codex', 'opencode']);
  });
});
