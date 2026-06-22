/**
 * caller-oracle.js — tiered caller-discovery oracle for `gap-check --discover`.
 *
 * docs/catalog/skills/plan-state-machine — field-triage fix #3 (v1.4.0).
 *
 * The Step-0 caller-completeness check asks: "for every symbol this plan
 * changes (deletes/resigns/renames), is every file that references it accounted
 * for in some state's mutates/read_only?" Answering it needs a *caller oracle* —
 * a way to enumerate the files that reference a symbol.
 *
 * The v1.1.0 oracle grepped a bare token (`grep -rlw`) against a directory list
 * that INCLUDED docs/, so prose mentions of a symbol name produced cascade false
 * positives, and it trusted GitNexus whenever `status` didn't literally say
 * "stale" — even though the GitNexus index lags the *working tree* (it indexes
 * commits, not uncommitted edits), so under a worktree it was confidently wrong.
 *
 * This module replaces that with a strict tiered resolver:
 *
 *   1. gitnexus — used ONLY when the index is provably == working-tree HEAD:
 *      indexed commit === current commit AND the working tree is clean. A dirty
 *      tree or a commit mismatch disqualifies gitnexus (it cannot see un-indexed
 *      edits), so it never silently answers from a stale graph.
 *   2. LSP — a live, construct-aware tier. The skill's calling AGENT has an LSP
 *      tool that reads the live working tree (real find-references/definition),
 *      so it is worktree-accurate where gitnexus is not. A standalone Node script
 *      cannot call that agent tool, so this tier shells to an LSP CLI named by
 *      $PSM_LSP_CMD when one is configured (mirrors the configurable-sink
 *      pattern); when it is not, LSP is marked unavailable and we fall through.
 *      SKILL.md instructs the agent to run the LSP tool itself for the symbols
 *      this script lists when neither gitnexus nor an LSP CLI is available.
 *   3. grep — last resort. Scoped to REAL source roots (incl. nx
 *      libs/apps/extensions), EXCLUDING docs/prose, matching the construct with
 *      word boundaries — not a bare substring across the whole tree.
 *
 * Node stdlib only. Pure, testable units: selectOracle() decides the tier from
 * injected probes (so tests don't need a real gitnexus); resolveCallers() runs
 * the chosen tier.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

/** Strip a leading "./" so oracle paths compare equal to declared reservations. */
export function normPath(p) {
  return String(p).replace(/^\.\//, "").trim();
}

/**
 * Real source roots to grep. Includes the conventional layout AND nx monorepo
 * roots (libs/apps/extensions). Deliberately EXCLUDES docs/ and other prose
 * directories — a symbol named in documentation is not a caller.
 */
export const SOURCE_ROOTS = [
  "src",
  "lib",
  "libs",
  "app",
  "apps",
  "extensions",
  "packages",
  "tests",
  "test",
  "scripts",
  "tools",
];

/** Directory names that are prose/build/vendor, never caller source. */
export const EXCLUDED_DIRS = ["docs", "doc", "node_modules", "dist", "build", "coverage", ".git"];

/**
 * Probe GitNexus availability AND working-tree freshness.
 *
 * Returns `{ available, indexedCommit, currentCommit, dirty, fresh }`.
 * `fresh` is true ONLY when the index commit equals the current commit AND the
 * working tree has no uncommitted changes — the only state in which gitnexus's
 * answer matches the bytes on disk. `cwd` lets tests target a fixture repo.
 */
export function gitnexusStatus(cwd = process.cwd()) {
  let indexedCommit = null;
  let currentCommit = null;
  let available = false;
  try {
    const out = execSync("npx gitnexus status 2>&1", {
      cwd,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    available = !/not\s+indexed|no\s+index|command not found/i.test(out);
    const im = out.match(/Indexed commit:\s*([0-9a-f]+)/i);
    const cm = out.match(/Current commit:\s*([0-9a-f]+)/i);
    if (im) indexedCommit = im[1];
    if (cm) currentCommit = cm[1];
    // If status never named commits we cannot prove equality → not fresh.
  } catch {
    return { available: false, indexedCommit: null, currentCommit: null, dirty: true, fresh: false };
  }

  // Resolve the real current HEAD ourselves (don't trust status alone), and
  // detect a dirty working tree — gitnexus indexes commits, not uncommitted edits.
  let head = currentCommit;
  let dirty = true;
  try {
    head = execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const porcelain = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    dirty = porcelain.trim().length > 0;
  } catch {
    /* not a git repo (or git missing) → treat as dirty/unprovable */
  }

  const commitsMatch =
    !!indexedCommit && !!head && (indexedCommit === head || head.startsWith(indexedCommit) || indexedCommit.startsWith(head));
  const fresh = available && commitsMatch && !dirty;
  return { available, indexedCommit, currentCommit: head, dirty, fresh };
}

/**
 * Decide which oracle tier to use, given injectable capability probes. Pure —
 * no I/O — so tests exercise every branch directly.
 *
 * @param {{gitnexus?: {available:boolean,fresh:boolean}, lspCmd?: string|null}} probes
 * @returns {{ tier: "gitnexus"|"lsp"|"grep", reason: string }}
 */
export function selectOracle(probes = {}) {
  const gx = probes.gitnexus || { available: false, fresh: false };
  const lspCmd = probes.lspCmd || null;
  if (gx.available && gx.fresh) {
    return { tier: "gitnexus", reason: "index == working-tree HEAD (clean, commit match)" };
  }
  if (lspCmd) {
    return { tier: "lsp", reason: `$PSM_LSP_CMD configured (${lspCmd})` };
  }
  const why = !gx.available
    ? "gitnexus unavailable"
    : gx.fresh === false
      ? "gitnexus index stale vs working tree"
      : "gitnexus not fresh";
  return { tier: "grep", reason: `${why}; no LSP CLI configured` };
}

/**
 * The grep tier: word-boundary match of the CONSTRUCT, scoped to source roots.
 *
 * @param {string} symbol
 * @param {string} [cwd]
 * @param {{ excludeDirs?: string[] }} [opts] extra dir names to exclude (e.g. the
 *   plan directory itself, whose dag.json/contexts mention the symbol by design).
 */
export function grepCallers(symbol, cwd = process.cwd(), opts = {}) {
  const extra = Array.isArray(opts.excludeDirs) ? opts.excludeDirs : [];
  const allExcluded = [...EXCLUDED_DIRS, ...extra];
  const dirs = SOURCE_ROOTS.filter((d) => {
    if (allExcluded.includes(d)) return false;
    try {
      return fs.existsSync(path.join(cwd, d));
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) dirs.push(".");
  const files = new Set();
  // -w = whole-word (construct, not substring); --exclude-dir keeps prose/vendor
  // and the plan dir out even when "." is the only root. Symbol is passed as a
  // fixed string (-F) so regex metacharacters in identifiers can't break the match.
  const excludes = allExcluded.map((d) => `--exclude-dir=${JSON.stringify(d)}`).join(" ");
  try {
    const out = execSync(
      `grep -rlwF ${excludes} -- ${JSON.stringify(symbol)} ${dirs
        .map((d) => JSON.stringify(d))
        .join(" ")} 2>/dev/null || true`,
      { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    for (const line of out.split("\n")) {
      const f = normPath(line);
      if (f) files.add(f);
    }
  } catch {
    /* grep exits 1 on no match; neutralised by `|| true` */
  }
  return files;
}

/**
 * The gitnexus tier: parse path-like tokens from `gitnexus context <symbol>`,
 * keeping only those that exist on disk (the output format is not contractually
 * stable, so we are defensive). Only call this when gitnexusStatus().fresh.
 */
export function gitnexusCallers(symbol, cwd = process.cwd()) {
  const files = new Set();
  try {
    const out = execSync(`npx gitnexus context ${JSON.stringify(symbol)} 2>/dev/null || true`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const p = normPath(m[1]);
      if (p.includes("/") && fs.existsSync(path.join(cwd, p))) files.add(p);
    }
  } catch {
    /* fall back to nothing — caller decides whether to degrade */
  }
  return files;
}

/**
 * The LSP tier: shell to a configured LSP CLI ($PSM_LSP_CMD) that takes a symbol
 * and prints `file:line` references (one per line). Returns the set of files, or
 * null when no CLI is configured (so the resolver knows to fall through to grep).
 *
 * The agent-tool LSP path is NOT invoked here (a Node script can't call the
 * agent's tool); SKILL.md instructs the agent to run its LSP tool for the listed
 * symbols when this tier is unavailable.
 */
export function lspCallers(symbol, cwd = process.cwd(), lspCmd = process.env.PSM_LSP_CMD) {
  if (!lspCmd || !lspCmd.trim()) return null;
  const files = new Set();
  try {
    const out = execSync(`${lspCmd} ${JSON.stringify(symbol)} 2>/dev/null || true`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const tok = line.trim().split(/[:\s]/)[0];
      const f = normPath(tok);
      if (f && f.includes("/") && fs.existsSync(path.join(cwd, f))) files.add(f);
    }
  } catch {
    /* degrade — return what we have */
  }
  return files;
}

/**
 * Resolve the caller files for a symbol using the selected tier, with fallthrough
 * to grep on an unavailable/empty higher tier.
 *
 * @param {string} symbol
 * @param {{ cwd?: string, oracle?: {tier:string}, lspCmd?: string|null, excludeDirs?: string[] }} [opts]
 * @returns {{ files: Set<string>, tier: string }}
 */
export function resolveCallers(symbol, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const tier = (opts.oracle && opts.oracle.tier) || "grep";
  const grepOpts = { excludeDirs: opts.excludeDirs };
  if (tier === "gitnexus") {
    const f = gitnexusCallers(symbol, cwd);
    if (f.size > 0) return { files: f, tier: "gitnexus" };
    // gitnexus returned nothing — corroborate with a scoped grep rather than
    // assume "no callers" (the parse is best-effort).
    return { files: grepCallers(symbol, cwd, grepOpts), tier: "gitnexus+grep" };
  }
  if (tier === "lsp") {
    const f = lspCallers(symbol, cwd, opts.lspCmd);
    if (f && f.size >= 0) return { files: f, tier: "lsp" };
    return { files: grepCallers(symbol, cwd, grepOpts), tier: "grep" };
  }
  return { files: grepCallers(symbol, cwd, grepOpts), tier: "grep" };
}
