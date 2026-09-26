/**
 * 27850011 — a user-scope OS unit must run the INSTALLED released soxe, never a
 * git checkout, unless explicitly requested.
 *
 * Prod: ~/Library/LaunchAgents/com.sox.user.memory-server.plist ran
 * `/Users/nix/dev/ai/sox-ecosystem/bin/soxe serve memory-server --port 3099`,
 * because `resolveOsUnitContext` baked `realpath(process.argv[1])` — the CLI
 * that ran `service enable`, i.e. the dev checkout — into the front shim's
 * argv. Any branch switch / build in that checkout changed production.
 *
 * Fix: `resolveUnitCliPath` (host-runtime) + `gateVolatileCli` (apps/sox).
 * RED (fix disabled — resolver returns the invoking CLI unconditionally, as
 * the old code did): the checkout CLI is chosen over an installed release and
 * is never reported volatile, so the user-scope gate passes it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveUnitCliPath, installedCliCandidates, isGitCheckoutPath } from '@adhd/sox-host-runtime';
import { gateVolatileCli } from './cli-path-gate.js';

let root: string;
let checkoutCli: string;
let prefix: string;
let nodePath: string;
let installedCli: string;
// (27850011) Homebrew-shaped fixture: <root>/brew/.git owns the WHOLE tree (like
// /opt/homebrew/.git in production), and a released CLI sits inside its own
// node_modules further down. A path under node_modules is installed, full stop
// — even though .git is a real ancestor if you keep walking past node_modules.
let brewRoot: string;
let brewCli: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '27850011-')));
  // A fake dev checkout: <root>/checkout/.git + bin/soxe
  fs.mkdirSync(path.join(root, 'checkout', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'checkout', 'bin'), { recursive: true });
  checkoutCli = path.join(root, 'checkout', 'bin', 'soxe');
  fs.writeFileSync(checkoutCli, '#!/usr/bin/env node\n');
  // A fake node prefix with a released @adhd/sox-cli in its global modules.
  prefix = path.join(root, 'prefix');
  nodePath = path.join(prefix, 'bin', 'node');
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(nodePath, '');
  // No `npm` sibling exists for this fake node, so `installedCliCandidates`
  // falls back to the realpath heuristic (`npm root -g` cannot be resolved).
  installedCli = installedCliCandidates(nodePath)[0]!;
  fs.mkdirSync(path.dirname(installedCli), { recursive: true });
  fs.writeFileSync(installedCli, '// released soxe\n');

  // Homebrew-shaped fixture: .git at the ROOT of the tree, released CLI under
  // node_modules several levels below it (mirrors /opt/homebrew/.git +
  // /opt/homebrew/lib/node_modules/@adhd/sox-cli).
  brewRoot = path.join(root, 'brew');
  fs.mkdirSync(path.join(brewRoot, '.git'), { recursive: true });
  brewCli = path.join(brewRoot, 'lib', 'node_modules', '@adhd', 'sox-cli', 'bin', 'soxe.mjs');
  fs.mkdirSync(path.dirname(brewCli), { recursive: true });
  fs.writeFileSync(brewCli, '// released soxe under a git-owned prefix\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('27850011 — stable CLI path for OS units', () => {
  it('isGitCheckoutPath: a path under a .git-bearing ancestor is a checkout; the prefix is not', () => {
    expect(isGitCheckoutPath(checkoutCli)).toBe(true);
    expect(isGitCheckoutPath(installedCli)).toBe(false);
  });

  it('invoked from a checkout with a released install available → the INSTALLED CLI is baked in', () => {
    const r = resolveUnitCliPath({ argv1: checkoutCli, nodePath });
    expect(r.source).toBe('installed');
    expect(r.cliPath).toBe(installedCli);
    expect(r.volatile).toBe(false);
    expect(isGitCheckoutPath(r.cliPath)).toBe(false);
  });

  it('invoked from a checkout with NO release installed → volatile; user scope refuses, project scope warns', () => {
    const r = resolveUnitCliPath({ argv1: checkoutCli, nodePath, candidates: [] });
    expect(r.source).toBe('checkout');
    expect(r.volatile).toBe(true);
    const out: string[] = [];
    expect(gateVolatileCli(r, 'user', {}, 'soxe service enable', (m) => out.push(m))).toBe(false);
    expect(out.join('')).toMatch(/Refusing to bake a git-checkout soxe/);
    expect(gateVolatileCli(r, 'user', { 'allow-checkout-cli': '' }, 'x', () => undefined)).toBe(true);
    expect(gateVolatileCli(r, 'project', {}, 'x', () => undefined)).toBe(true);
  });

  it('an explicit --cli-path always wins, even a checkout (explicitly requested)', () => {
    const r = resolveUnitCliPath({ argv1: installedCli, nodePath, explicit: checkoutCli });
    expect(r).toMatchObject({ source: 'flag', cliPath: checkoutCli, volatile: false });
  });

  it('invoked from an installed (non-checkout) CLI → that CLI, not volatile', () => {
    const r = resolveUnitCliPath({ argv1: installedCli, nodePath, candidates: [] });
    expect(r).toMatchObject({ source: 'invoking', cliPath: installedCli, volatile: false });
  });

  it('an npm-linked global that resolves back into the checkout is NOT accepted as installed', () => {
    const linked = path.join(root, 'linked', 'soxe.mjs');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(checkoutCli, linked);
    const r = resolveUnitCliPath({ argv1: checkoutCli, nodePath, candidates: [linked] });
    expect(r.source).toBe('checkout');
    expect(r.volatile).toBe(true);
  });

  // (27850011) BLOCKING finding: a released CLI under a git-owned prefix
  // (/opt/homebrew/.git, ~/.nvm/.git) must classify as INSTALLED, never a
  // checkout — the nearest `.git` only counts if it is found BEFORE the walk
  // crosses a `node_modules` segment.
  it('a released CLI whose ANCESTOR is a git repo (Homebrew/.nvm-shaped) is installed, not a checkout', () => {
    expect(isGitCheckoutPath(brewCli)).toBe(false);
    const r = resolveUnitCliPath({ argv1: brewCli, nodePath, candidates: [] });
    expect(r).toMatchObject({ source: 'invoking', cliPath: brewCli, volatile: false });
    const out: string[] = [];
    expect(gateVolatileCli(r, 'user', {}, 'soxe service enable', (m) => out.push(m))).toBe(true);
    expect(out.join('')).toBe('');
  });

  it('a symlink under node_modules whose REAL target is a checkout is still classified as a checkout', () => {
    const linked = path.join(brewRoot, 'lib', 'node_modules', 'linked-soxe.mjs');
    fs.symlinkSync(checkoutCli, linked);
    expect(isGitCheckoutPath(linked)).toBe(true);
  });

  it('an explicit --cli-path that is not absolute throws before any state is touched', () => {
    expect(() => resolveUnitCliPath({ argv1: installedCli, nodePath, explicit: 'relative/soxe' })).toThrow(
      /absolute/,
    );
  });

  it('an explicit --cli-path that does not exist throws', () => {
    expect(() =>
      resolveUnitCliPath({ argv1: installedCli, nodePath, explicit: path.join(root, 'does-not-exist') }),
    ).toThrow(/does not exist/);
  });

  it('installedCliCandidates resolves via an injected `npm root -g` seam, not the realpath heuristic', () => {
    const globalRootDir = path.join(root, 'npm-global-root');
    const seamInstalled = path.join(globalRootDir, '@adhd', 'sox-cli', 'bin', 'soxe.mjs');
    fs.mkdirSync(path.dirname(seamInstalled), { recursive: true });
    fs.writeFileSync(seamInstalled, '// released soxe via npm root -g\n');
    const candidates = installedCliCandidates(nodePath, { globalRoot: () => globalRootDir });
    expect(candidates).toEqual([seamInstalled]);
    const r = resolveUnitCliPath({ argv1: checkoutCli, nodePath, globalRoot: () => globalRootDir });
    expect(r).toMatchObject({ source: 'installed', cliPath: seamInstalled, volatile: false });
  });
});
