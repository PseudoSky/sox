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
  installedCli = installedCliCandidates(nodePath, path.join(root, 'home'))[0]!;
  fs.mkdirSync(path.dirname(installedCli), { recursive: true });
  fs.writeFileSync(installedCli, '// released soxe\n');
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
});
