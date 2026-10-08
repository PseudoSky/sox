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
 *   AC2 pre-existing path byte-identical; no ownership/ledger entry; no staging left
 *       (os.tmpdir()/sox-render is untouched: the guard runs before the renderers).
 *   AC3 an agent id, a skill id AND the hook path; asserts file bytes AND the ownership
 *       index. The hook refusal additionally leaves the settings file byte-identical (the
 *       guard runs before the settings merge, [inv:no-untracked-injection]).
 *   AC4 override is the explicit `--force` CLI flag only (never an env var, ADR-0013);
 *       the clobber is loud (emitted after the write) and says the previous content is
 *       gone; uninstall after a forced overwrite removes the path and restores nothing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { declarativeInstall, type InstallDescriptor } from './install.js';
import { ledgerPathFor, ownershipPathFor } from './data-paths.js';
import { OwnershipIndex } from './ownership.js';
import { uninstallOwned } from './lifecycle.js';

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
let prevTmpdir: string | undefined;

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the engine reports real paths.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-6c9fbf52-')));
  workspace = path.join(base, 'ws');
  dataDir = path.join(base, 'data');
  sandboxRoot = path.join(base, 'sandbox');
  for (const d of [workspace, dataDir, sandboxRoot]) fs.mkdirSync(d, { recursive: true });
  prevHome = process.env['SOX_ECOSYSTEM_HOME'];
  prevSandbox = process.env['SOX_SANDBOX_ROOT'];
  prevTmpdir = process.env['TMPDIR'];
  // Isolate os.tmpdir() so the renderers' sox-render staging dir is observable per test.
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  process.env['TMPDIR'] = path.join(base, 'tmp');
  process.env['SOX_ECOSYSTEM_HOME'] = dataDir;
  process.env['SOX_SANDBOX_ROOT'] = sandboxRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = prevHome;
  if (prevSandbox === undefined) delete process.env['SOX_SANDBOX_ROOT'];
  else process.env['SOX_SANDBOX_ROOT'] = prevSandbox;
  if (prevTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = prevTmpdir;
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
  /** Substrings that occur only in the planted (pre-existing) content. */
  markers: string[];
}

function writeExt(type: 'agent' | 'skill', id: string): string {
  const dir = path.join(workspace, 'extensions', `${type}s`, id);
  fs.mkdirSync(dir, { recursive: true });
  const entrypoint = type === 'agent' ? `${id}.md` : 'SKILL.md';
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify(
      {
        id,
        version: '0.1.0',
        type,
        title: id,
        description: `${id} ${type}`,
        entrypoint,
        // A renderable IR makes the agent path stage through the renderer (sox-render),
        // so the "no staging left" assertion can actually fail.
        ...(type === 'agent' ? { agent: { description: `${id} agent` } } : {}),
      },
      null,
      2,
    ),
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
    markers: ['user-authored reviewer'],
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
    markers: ['hand-written skill', 'private notes'],
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

/** Plant the unowned destination, first proving it lies inside the sandbox (never real HOME). */
function plantChecked(c: Case, dest: string): void {
  expect(dest.startsWith(sandboxRoot + path.sep), `${dest} must be inside the sandbox ${sandboxRoot}`).toBe(true);
  c.plant(dest);
}

/** Entries the renderers staged under os.tmpdir()/sox-render for this extension id. */
function stagingFor(ext: string): string[] {
  const dir = path.join(os.tmpdir(), 'sox-render');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(`${ext}-`)) : [];
}

/** Every file under the given roots whose bytes contain `needle`. */
function filesContaining(roots: string[], needle: string): string[] {
  const hits: string[] = [];
  const walk = (abs: string): void => {
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const n of fs.readdirSync(abs)) walk(path.join(abs, n));
    } else if (fs.readFileSync(abs, 'utf8').includes(needle)) {
      hits.push(abs);
    }
  };
  roots.forEach(walk);
  return hits;
}

function ownedEntryFor(c: Case, dest: string): boolean {
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user', workspace));
  return (
    idx.get(c.id, 'user')?.entries?.some((e) => e.kind === 'file-drop' && e.path === dest) ?? false
  );
}

// ─── dangling symlink at the destination ──────────────────────────────────────

describe('6c9fbf52 — a DANGLING symlink at the destination counts as an existing unowned path', () => {
  it('6c9fbf52 AC1: is refused, the link is untouched and its target is never created', async () => {
    const c = CASES[0]!;
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    expect(dest.startsWith(sandboxRoot + path.sep)).toBe(true);
    const linkTarget = path.join(base, 'elsewhere', 'target.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(linkTarget, dest);
    expect(fs.existsSync(dest)).toBe(false); // dangling: existsSync follows the link

    await expect(
      declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir),
    ).rejects.toThrow(/refusing to overwrite unowned file/);

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dest)).toBe(linkTarget);
    expect(fs.existsSync(linkTarget)).toBe(false);
    expect(ownedEntryFor(c, dest)).toBe(false);
  });
});

// ─── AC1 / AC2 / AC3 — refusal ────────────────────────────────────────────────

describe.each(CASES)('6c9fbf52 — unowned existing $label destination is refused', (c) => {
  it(`6c9fbf52 AC1: throws the BUG-028 error naming path, ext id, scope and the exact remedy`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    plantChecked(c, dest);

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
    plantChecked(c, dest);

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
    // AC2: no render staging either — the guard runs before the renderers stage into
    // os.tmpdir()/sox-render/<ext>-...
    expect(stagingFor(c.id), `${c.label}: refusal must leave no sox-render staging`).toEqual([]);
  });

  it(`6c9fbf52 AC4: --force (library option force:true) is the only override; it warns loudly and the old content is gone`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    plantChecked(c, dest);
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

  it(`6c9fbf52 AC4: uninstall after a forced overwrite removes the path and does NOT restore the old content`, async () => {
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    plantChecked(c, dest);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const m of c.markers) expect(filesContaining([dest], m).length).toBeGreaterThan(0);

    await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir, { force: true });
    expect(fs.existsSync(dest)).toBe(true);
    for (const m of c.markers) expect(filesContaining([dest], m), `old content '${m}' replaced`).toEqual([]);

    const result = await uninstallOwned({
      ext: c.id,
      scope: 'user',
      dataDir,
      workspaceRoot: workspace,
      isProject: false,
      ownership: OwnershipIndex.loadFromFile(ownershipPathFor('user', workspace)),
    });

    expect(result.full).toBe(true);
    expect(fs.existsSync(dest), 'the clobbered path is gone after uninstall').toBe(false);
    // Nothing restored the previous content anywhere (placement root or data root).
    for (const m of c.markers) {
      expect(filesContaining([sandboxRoot, dataDir], m), `old content '${m}' must not reappear`).toEqual([]);
    }
  });

  it(`6c9fbf52 AC4: --force over byte-identical unowned content replaces nothing and the warning says it adopted the path`, async () => {
    const srcPath = c.makeSrc();
    const first = await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir);
    const dest = first.find((r) => r.capability === 'file-drop')!.target;
    // Drop ownership: the on-disk bytes are now identical to the extension's but unowned.
    const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user', workspace));
    idx.remove(c.id, 'user');
    idx.save();
    const before = snapshot(dest);
    await expect(
      declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir),
    ).rejects.toThrow(/refusing to overwrite unowned file/);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const results = await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir, { force: true });
    const fd = results.find((r) => r.capability === 'file-drop');
    expect(fd?.applied, 'identical bytes: nothing replaced').toBe(false);
    expect(snapshot(dest)).toEqual(before);
    const warned = warn.mock.calls.map((a) => String(a[0])).join('\n');
    expect(warned).toContain(dest);
    expect(warned).toContain('adopted');
    expect(warned).not.toContain('overwrote');
    expect(fd?.hints?.some((h) => h.includes('adopted'))).toBe(true);
    expect(ownedEntryFor(c, dest)).toBe(true);
  });

  it(`6c9fbf52 AC2 control: a successful install DOES stage under sox-render (the no-staging assertion can fail)`, async () => {
    const srcPath = c.makeSrc();
    await declarativeInstall(descriptorFor(c, srcPath), 'user', workspace, dataDir);
    expect(stagingFor(c.id).length).toBeGreaterThan(0);
  });
});

// ─── AC4 — no env-var override (ADR-0013) ─────────────────────────────────────

describe('6c9fbf52 AC4 — overriding the refusal is never driven by an environment variable (ADR-0013)', () => {
  it('a FORCE-style env var does not bypass the guard', async () => {
    const c = CASES[0]!;
    const srcPath = c.makeSrc();
    const dest = await resolveDest(c, srcPath);
    plantChecked(c, dest);
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

// ─── Hook path: settings merge + hook-script drop ─────────────────────────────

describe('6c9fbf52 — unowned existing hook-script destination is refused before ANY write', () => {
  const HOOK_ID = 'refuse-hook';
  const PLANTED = 'hand-rolled hook script\n';

  function writeHookExt(): string {
    const dir = path.join(workspace, 'extensions', 'hooks', HOOK_ID);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id: HOOK_ID, version: '0.1.0', type: 'hook', title: HOOK_ID, description: 'hook' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho from-extension\n', 'utf8');
    return dir;
  }

  const descriptor = (srcPath: string): InstallDescriptor =>
    ({
      ext: HOOK_ID,
      type: 'hook',
      hosts: ['claude'],
      srcPath,
      configEntries: [{ matcher: 'SessionEnd', hooks: [{ type: 'command', command: 'true' }] }],
    }) as InstallDescriptor;

  const settingsPath = (): string => path.join(sandboxRoot, '.claude', 'settings.json');
  const hookDest = (srcPath: string): string =>
    path.join(sandboxRoot, '.claude', 'hooks', path.basename(srcPath));
  const SETTINGS_BEFORE = `${JSON.stringify({ model: 'user-chosen', hooks: { PostToolUse: [] } }, null, 2)}\n`;

  function plantHook(srcPath: string): string {
    const dest = hookDest(srcPath);
    expect(dest.startsWith(sandboxRoot + path.sep), `${dest} must be inside the sandbox`).toBe(true);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'legacy.sh'), PLANTED, 'utf8');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), SETTINGS_BEFORE, 'utf8');
    return dest;
  }

  it('AC1+AC2+AC3: throws BUG-028 naming path/ext/scope/remedy; settings, hook dir, ownership and ledger are byte-identical', async () => {
    const srcPath = writeHookExt();
    const dest = plantHook(srcPath);
    const before = snapshot(dest);
    const ownershipBefore = readIfExists(ownershipPathFor('user', workspace));
    const ledgerBefore = readIfExists(ledgerPathFor('user', workspace));
    const dataBefore = listing(dataDir);

    let err: unknown;
    try {
      await declarativeInstall(descriptor(srcPath), 'user', workspace, dataDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('refusing to overwrite unowned file');
    expect(msg).toContain('BUG-028');
    expect(msg).toContain(dest);
    expect(msg).toContain(`extension '${HOOK_ID}'`);
    expect(msg).toContain(`scope 'user'`);
    expect(msg).toMatch(/move or rename/);
    expect(msg).toContain('--force');

    // "Nothing was changed": no settings entry was injected, so none is untracked.
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(SETTINGS_BEFORE);
    expect(snapshot(dest)).toEqual(before);
    expect(readIfExists(ownershipPathFor('user', workspace))).toBe(ownershipBefore);
    expect(readIfExists(ledgerPathFor('user', workspace))).toBe(ledgerBefore);
    expect(listing(dataDir)).toEqual(dataBefore);
  });

  it('AC4: --force replaces the unowned hook dir, merges the settings entry, owns both, warns after the write; uninstall restores nothing', async () => {
    const srcPath = writeHookExt();
    const dest = plantHook(srcPath);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const results = await declarativeInstall(descriptor(srcPath), 'user', workspace, dataDir, { force: true });

    const fd = results.find((r) => r.capability === 'file-drop');
    expect(fd?.target).toBe(dest);
    expect(fd?.applied).toBe(true);
    expect(fs.existsSync(path.join(dest, 'legacy.sh'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'scripts', 'run.sh'), 'utf8')).toContain('from-extension');

    const warned = warn.mock.calls.map((a) => String(a[0])).join('\n');
    expect(warned).toContain('WARNING');
    expect(warned).toContain('--force');
    expect(warned).toContain(dest);
    expect(warned).toMatch(/will NOT restore the previous content/);
    // Like the file-drop branch, the warning also rides the result hints.
    expect(fd?.hints?.some((h) => h.includes(dest) && h.includes('WARNING'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    const arr = (settings['hooks'] as { PostToolUse: Array<{ matcher?: string }> }).PostToolUse;
    expect(arr.map((h) => h.matcher)).toEqual(['SessionEnd']);
    expect(settings['model']).toBe('user-chosen');

    const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user', workspace));
    const entries = idx.get(HOOK_ID, 'user')?.entries ?? [];
    expect(entries.some((e) => e.kind === 'file-drop' && e.path === dest)).toBe(true);
    expect(entries.some((e) => e.kind === 'object-array-values')).toBe(true);

    const un = await uninstallOwned({
      ext: HOOK_ID,
      scope: 'user',
      dataDir,
      workspaceRoot: workspace,
      isProject: false,
      ownership: idx,
    });
    expect(un.full).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
    expect(filesContaining([sandboxRoot, dataDir], 'hand-rolled hook script')).toEqual([]);
    // The settings entry was reversed and the user's own keys survive.
    const after = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    expect((after['hooks'] as { PostToolUse: unknown[] }).PostToolUse).toEqual([]);
    expect(after['model']).toBe('user-chosen');
  });

  it('control: an OWNED hook destination re-installs without --force', async () => {
    const srcPath = writeHookExt();
    const first = await declarativeInstall(descriptor(srcPath), 'user', workspace, dataDir);
    expect(first.find((r) => r.capability === 'file-drop')?.target).toBe(hookDest(srcPath));
    await expect(declarativeInstall(descriptor(srcPath), 'user', workspace, dataDir)).resolves.toBeDefined();
  });
});
