/**
 * libs/install-engine/src/6c9fbf52-unowned-destination-refusal.spec.ts
 *
 * 6c9fbf52 — BUG-028 unowned-destination guard regression suite.
 *
 * An install must never clobber an existing destination this extension does not own
 * (incident: a user-authored ~/.config/opencode/agents/review.md vs the `review`
 * agent). The guard lives in declarativeInstall's file-drop apply path. Drives the
 * REAL declarativeInstall at USER scope against a sandboxed placement root
 * (SOX_SANDBOX_ROOT) + sandboxed data root (SOX_ECOSYSTEM_HOME); no real HOME is touched.
 *
 * ACs (6c9fbf52):
 *   AC1 refusal throws with the BUG-028 text: path, ext id, scope, exact remedy.
 *   AC2 pre-existing path byte-identical; no ownership/ledger entry; no staging left.
 *   AC3 both an agent id and a skill id; asserts file bytes AND the ownership index.
 *   AC4 override is the explicit `--force` CLI flag only (never an env var, ADR-0013);
 *       the clobber is loud and says the previous content is gone.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { declarativeInstall, type InstallDescriptor } from './install.js';
import { ledgerPathFor, ownershipPathFor } from './data-paths.js';
import { OwnershipIndex } from './ownership.js';

declare const __dirname: string;
const hostRegistryPath = path.resolve(__dirname, '../../host-registry/dist/index.js');

const M = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function patchedResolveFilename(
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
): string {
  if (request === '@adhd/sox-host-registry') return hostRegistryPath;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
afterAll(() => {
  M._resolveFilename = originalResolveFilename;
});

let base: string;
let workspace: string;
let dataDir: string;
let sandboxRoot: string;
let prevHome: string | undefined;
let prevSandbox: string | undefined;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-6c9fbf52-'));
  workspace = path.join(base, 'ws');
  dataDir = path.join(base, 'data');
  sandboxRoot = path.join(base, 'sandbox');
  for (const d of [workspace, dataDir, sandboxRoot]) fs.mkdirSync(d, { recursive: true });
  prevHome = process.env['SOX_ECOSYSTEM_HOME'];
  prevSandbox = process.env['SOX_SANDBOX_ROOT'];
  process.env['SOX_ECOSYSTEM_HOME'] = dataDir;
  process.env['SOX_SANDBOX_ROOT'] = sandboxRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = prevHome;
  if (prevSandbox === undefined) delete process.env['SOX_SANDBOX_ROOT'];
  else process.env['SOX_SANDBOX_ROOT'] = prevSandbox;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {
    process.stderr.write(`6c9fbf52 spec cleanup failed: ${String(e)}\n`);
  }
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface Case {
  label: 'agent' | 'skill';
  id: string;
  host: 'opencode' | 'claude';
  makeSrc: () => string;
  /** Plants the unowned pre-existing destination; returns its absolute path. */
  plant: (dest: string) => void;
}

function writeExt(type: 'agent' | 'skill', id: string): string {
  const dir = path.join(workspace, 'extensions', `${type}s`, id);
  fs.mkdirSync(dir, { recursive: true });
  const entrypoint = type === 'agent' ? `${id}.md` : 'SKILL.md';
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({ id, version: '0.1.0', type, title: id, description: `${id} ${type}`, entrypoint }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, entrypoint),
    `---\nname: ${id}\ndescription: ${id} ${type}\n---\n\n# ${id} from extension\n`,
    'utf8',
  );
  return dir;
}

const CASES: Case[] = [
  {
    label: 'agent',
    id: 'refuse-agent',
    host: 'opencode',
    makeSrc: () => writeExt('agent', 'refuse-agent'),
    plant: (dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, '---\ndescription: user-authored reviewer\n---\nedit: allow\n', 'utf8');
    },
  },
  {
    label: 'skill',
    id: 'refuse-skill',
    host: 'claude',
    makeSrc: () => writeExt('skill', 'refuse-skill'),
    plant: (dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'SKILL.md'), '# my own hand-written skill\n', 'utf8');
      fs.writeFileSync(path.join(dest, 'notes.txt'), 'private notes\n', 'utf8');
    },
  },
];

function descriptorFor(c: Case, srcPath: string): InstallDescriptor {
  return { ext: c.id, type: c.label, hosts: [c.host], srcPath } as InstallDescriptor;
}

/** Resolve where the install would place the file, via the engine's own dry-run. */
async function resolveDest(c: Case, srcPath: string): Promise<string> {
  const plan = await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir, { dryRun: true });
  const fd = plan.find((r) => r.capability === 'file-drop');
  expect(fd?.target, `${c.label}: dry-run must report a file-drop target`).toBeTruthy();
  return fd!.target;
}

/** Deterministic byte snapshot of a file or directory tree: relpath -> content. */
function snapshot(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      out[`${rel}/`] = '<dir>';
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), `${rel}/${name}`);
    } else {
      out[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(p, '.');
  return out;
}

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** Entire-tree listing (relative paths) of a directory that may not exist. */
function listing(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return Object.keys(snapshot(root)).sort();
}

function ownedEntryFor(c: Case, dest: string): boolean {
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user', workspace));
  return (
    idx.get(c.id, 'user')?.entries?.some((e) => e.kind === 'file-drop' && e.path === dest) ?? false
  );
}

// ─── AC1 / AC2 / AC3 — refusal ────────────────────────────────────────────────

describe.each(CASES)('6c9fbf52 — unowned existing $label destination is refused', (c) => {
  it(`6c9fbf52 AC1: throws the BUG-028 error naming path, ext id, scope and the exact remedy`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    c.plant(dest);

    let err: unknown;
    try {
      await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir);
    } catch (e) {
      err = e;
    }
    expect(err, 'install over an unowned destination must throw').toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('refusing to overwrite unowned file');
    expect(msg).toContain('BUG-028');
    expect(msg).toContain(dest);
    expect(msg).toContain(`extension '${c.id}'`);
    expect(msg).toContain(`scope 'user'`);
    // The exact remedy: move/rename the path, or the explicit CLI flag. Never an env var
    // (ADR-0013) and never the library-option spelling `force=true`.
    expect(msg).toMatch(/move or rename/);
    expect(msg).toContain('--force');
    expect(msg).not.toContain('force=true');
    expect(msg).not.toMatch(/SOX_[A-Z_]*FORCE/);
  });

  it(`6c9fbf52 AC2+AC3: pre-existing bytes untouched, ownership index unchanged, no ledger entry, no staging left`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    c.plant(dest);

    const before = snapshot(dest);
    const parentBefore = listing(path.dirname(dest));
    const dataBefore = listing(dataDir);
    const ownershipFile = ownershipPathFor('user', workspace);
    const ownershipBefore = readIfExists(ownershipFile);
    const ledgerBefore = readIfExists(ledgerPathFor('user', workspace));

    await expect(
      declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir),
    ).rejects.toThrow(/refusing to overwrite unowned file/);

    // AC2/AC3: the file (or tree) is byte-identical.
    expect(snapshot(dest)).toEqual(before);
    // AC3: ownership index unchanged (byte-for-byte, incl. "still absent").
    expect(readIfExists(ownershipFile)).toBe(ownershipBefore);
    expect(ownedEntryFor(c, dest)).toBe(false);
    // AC2: no ledger entry written.
    expect(readIfExists(ledgerPathFor('user', workspace))).toBe(ledgerBefore);
    // AC2: no staging dir / temp sibling left in the host dir or the data root.
    expect(listing(path.dirname(dest))).toEqual(parentBefore);
    expect(listing(dataDir)).toEqual(dataBefore);
  });

  it(`6c9fbf52 AC4: --force (library option force:true) is the only override; it warns loudly and the old content is gone`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    c.plant(dest);
    const planted = snapshot(dest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir, { force: true });

    const fd = results.find((r) => r.capability === 'file-drop');
    expect(fd?.applied).toBe(true);
    expect(snapshot(dest)).not.toEqual(planted);

    const warned = warn.mock.calls.map((a) => String(a[0])).join('\n');
    expect(warned).toContain('WARNING');
    expect(warned).toContain('--force');
    expect(warned).toContain(dest);
    expect(warned).toMatch(/not backed\s+up/);
    expect(warned).toMatch(/will NOT restore the previous content/);
    // The warning also rides the result so non-console callers can surface it.
    expect(fd?.hints?.some((h) => h.includes(dest) && h.includes('WARNING'))).toBe(true);

    // The clobbered path is now owned (so uninstall will remove it) — and no backup of the
    // previous content exists anywhere (placement root or data root), so it cannot be restored.
    expect(ownedEntryFor(c, dest)).toBe(true);
    const everything = [...listing(sandboxRoot), ...listing(dataDir)];
    expect(everything.some((p) => /\.(bak|orig|backup)$|\.staging-/.test(p))).toBe(false);
  });
});

// ─── AC4 — no env-var override (ADR-0013) ─────────────────────────────────────

describe('6c9fbf52 AC4 — overriding the refusal is never driven by an environment variable (ADR-0013)', () => {
  it('a FORCE-style env var does not bypass the guard', async () => {
    const c = CASES[0]!;
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    c.plant(dest);
    const before = snapshot(dest);
    const saved = { a: process.env['SOX_FORCE'], b: process.env['SOX_INSTALL_FORCE'], c: process.env['FORCE'] };
    process.env['SOX_FORCE'] = '1';
    process.env['SOX_INSTALL_FORCE'] = '1';
    process.env['FORCE'] = '1';
    try {
      await expect(
        declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir),
      ).rejects.toThrow(/refusing to overwrite unowned file/);
      expect(snapshot(dest)).toEqual(before);
    } finally {
      for (const [k, v] of [['SOX_FORCE', saved.a], ['SOX_INSTALL_FORCE', saved.b], ['FORCE', saved.c]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ─── Positive control: an OWNED destination re-installs without --force ───────

describe('6c9fbf52 — control: guard does not block an extension re-installing its own file', () => {
  it.each(CASES)('$label: install, then re-install without force succeeds', async (c) => {
    const srcPath = c.makeSrc();
    const first = await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir);
    expect(first.find((r) => r.capability === 'file-drop')?.applied).toBe(true);
    const dest = first.find((r) => r.capability === 'file-drop')!.target;
    expect(ownedEntryFor(c, dest)).toBe(true);
    await expect(
      declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir),
    ).resolves.toBeDefined();
  });
});
