/**
 * Argv policy for the sox shell wrappers (spec §1.1, controls C1, losses L1-L6).
 *
 * The agent-mcp shell server matches only argv[0], so capability is expressed as
 * separate command NAMES: sox-git-ro, sox-git-impl, sox-git-merge, sox-rm. The
 * mode is derived solely from basename(argv[1]) of the wrapper script. Plain
 * `git` and `rm` are in no agent allowlist.
 *
 * Rule ids written to stderr as `sox-git: <rule-id> denied` (exit 2):
 *   L1 stash            L2 add -A/--all/-u/whole-tree   L3 reset (any)
 *   L4 push (any)       L5 clean, checkout, branch -D, tag -d
 *   L6 rm -rf / recursive delete outside <cwd>/tmp or <cwd>/.worktrees
 *   X-* extra denials for everything else the spec says to refuse
 *   (see RULE_IDS).
 *
 * Every check is an allowlist: anything not explicitly recognised is denied.
 * Git is invoked with an argv array via spawnSync, never through a shell.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Capability tier selected by the wrapper's command name. */
export type GitMode = 'ro' | 'impl' | 'merge';

/** Outcome of evaluating one invocation. */
export type Decision = { ok: true; argv: string[] } | { ok: false; rule: string };

/** Every rule id this module can emit, for docs and tests. */
export const RULE_IDS = [
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
  'L6',
  'X-MODE',
  'X-SUBCMD',
  'X-DASH-C',
  'X-DASH-C-PATH',
  'X-GLOBAL-OPT',
  'X-CONFIG',
  'X-REBASE',
  'X-OUTPUT',
  'X-FLAG',
  'X-PATHSPEC',
  'X-AMEND',
  'X-NOVERIFY',
  'X-COMMIT-ALL',
  'X-COMMIT-PATHSPEC',
  'X-RESTORE-TREE',
  'X-MV-FORCE',
  'X-RM-FORCE',
  'X-RM-TREE',
  'X-FETCH',
  'X-SWITCH-FORCE',
  'X-MERGE-FF',
  'X-WORKTREE',
  'X-WORKTREE-FLAG',
  'X-WORKTREE-PATH',
  'X-BRANCH',
  'X-REMOTE',
  'X-REFLOG',
  'X-SYMREF',
  'X-RM-OUTSIDE',
  'X-RM-FLAG',
  'X-RM-NOARGS',
] as const;

const TIER: Record<GitMode, number> = { ro: 0, impl: 1, merge: 2 };

const deny = (rule: string): { ok: false; rule: string } => ({ ok: false, rule });

/** Result of classifying a subcommand form: the minimum tier or a denial rule. */
type Classified = { tier: GitMode } | { rule: string };

const needs = (tier: GitMode): Classified => ({ tier });
const refuse = (rule: string): Classified => ({ rule });

/** Maps `sox-git-ro` | `sox-git-impl` | `sox-git-merge` to a mode; anything else is undefined. */
export function modeFromName(name: string): GitMode | undefined {
  switch (name) {
    case 'sox-git-ro':
      return 'ro';
    case 'sox-git-impl':
      return 'impl';
    case 'sox-git-merge':
      return 'merge';
    default:
      return undefined;
  }
}

const isShortCluster = (a: string): boolean => /^-[A-Za-z]+$/.test(a);
const clusterHas = (a: string, ch: string): boolean => isShortCluster(a) && a.slice(1).includes(ch);

/** True for pathspecs that select the whole tree (or magic/escaping forms we refuse to reason about). */
export function isWholeTreePathspec(p: string): boolean {
  if (p.startsWith(':')) return true;
  let n = path.posix.normalize(p.replace(/\\/g, '/'));
  while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n === '.' || n === '' || n === '/' || n === '*' || n === '**' || n === '..' || n.startsWith('../');
}

/** Splits args at the first `--`: [before, after, sawSeparator]. */
function splitSep(rest: readonly string[]): { before: string[]; after: string[]; sep: boolean } {
  const i = rest.indexOf('--');
  if (i < 0) return { before: [...rest], after: [], sep: false };
  return { before: rest.slice(0, i), after: rest.slice(i + 1), sep: true };
}

const SAFE_REF = /^[A-Za-z0-9._/@{}^~+-]+$/;
const SAFE_REMOTE = /^[A-Za-z0-9._-]+$/;

/** Abbreviation-proof check: git accepts unambiguous abbreviations of long options. */
function isAbbrevOf(arg: string, full: string): boolean {
  if (!arg.startsWith('--')) return false;
  const name = arg.split('=')[0] ?? arg;
  return name.length >= 3 && full.startsWith(name);
}

/** Read-only subcommands that take free-form args; only output redirection/external programs are blocked. */
const RO_SIMPLE = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'rev-list',
  'ls-files',
  'cat-file',
  'check-ignore',
  'for-each-ref',
  'merge-base',
  'merge-tree',
]);

const BRANCH_RO_FLAGS = new Set([
  '--list',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '--show-current',
  '-v',
  '-vv',
  '--verbose',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
]);
const BRANCH_FILTER_FLAGS = new Set(['--list', '--merged', '--no-merged', '--contains', '--no-contains']);

function classifyBranch(rest: readonly string[]): Classified {
  const hasShortCluster = (ch: string): boolean => rest.some((a) => clusterHas(a, ch));
  const deleteFlag = rest.includes('--delete') || hasShortCluster('d');
  const forceFlag = rest.includes('--force') || hasShortCluster('f') || hasShortCluster('D');
  if (hasShortCluster('D') || (deleteFlag && forceFlag)) return refuse('L5');
  if (deleteFlag) {
    const names = rest.filter((a) => a !== '-d' && a !== '--delete');
    if (names.length === 0 || names.some((a) => a.startsWith('-') || !SAFE_REF.test(a))) return refuse('X-BRANCH');
    return needs('merge');
  }
  let filtering = false;
  const positionals: string[] = [];
  for (const a of rest) {
    if (a.startsWith('--format=') || a.startsWith('--sort=')) continue;
    if (BRANCH_RO_FLAGS.has(a)) {
      if (BRANCH_FILTER_FLAGS.has(a)) filtering = true;
      continue;
    }
    if (a.startsWith('-')) return refuse('X-BRANCH');
    positionals.push(a);
  }
  // A bare positional creates a branch; it is a filter only alongside --list/--merged/--contains.
  if (positionals.length > 0 && !filtering) return refuse('X-BRANCH');
  return needs('ro');
}

function classifyAdd(rest: readonly string[]): Classified {
  const { before, after } = splitSep(rest);
  const ADD_OK = new Set(['-N', '--intent-to-add', '-v', '--verbose', '-n', '--dry-run']);
  const paths = [...after];
  for (const a of before) {
    if (a.startsWith('-') && a !== '-') {
      if (a === '--all' || a === '--update' || a === '--no-ignore-removal' || clusterHas(a, 'A') || clusterHas(a, 'u')) {
        return refuse('L2');
      }
      if (!ADD_OK.has(a)) return refuse('X-FLAG');
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) return refuse('X-PATHSPEC');
  if (paths.some(isWholeTreePathspec)) return refuse('L2');
  return needs('impl');
}

function classifyCommit(rest: readonly string[]): Classified {
  const { before, after, sep } = splitSep(rest);
  const LONG_NOARG = new Set([
    '--allow-empty',
    '--allow-empty-message',
    '--signoff',
    '--no-signoff',
    '--quiet',
    '--no-edit',
  ]);
  const LONG_PREFIX = ['--message=', '--file=', '--author=', '--date=', '--cleanup='];
  for (let i = 0; i < before.length; i++) {
    const a = before[i] as string;
    if (LONG_NOARG.has(a) || LONG_PREFIX.some((p) => a.startsWith(p))) continue;
    if (a === '--message' || a === '--file') {
      if (i + 1 >= before.length) return refuse('X-FLAG');
      i += 1;
      continue;
    }
    if (isAbbrevOf(a, '--amend')) return refuse('X-AMEND');
    if (isAbbrevOf(a, '--no-verify')) return refuse('X-NOVERIFY');
    if (isAbbrevOf(a, '--all')) return refuse('X-COMMIT-ALL');
    if (isShortCluster(a)) {
      // Letters up to the first value-taking one (m, F) are flags; the rest is its glued value.
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k] as string;
        if (ch === 'a') return refuse('X-COMMIT-ALL');
        if (ch === 'n') return refuse('X-NOVERIFY');
        if (ch === 'm' || ch === 'F') {
          if (k === letters.length - 1) {
            if (i + 1 >= before.length) return refuse('X-FLAG');
            i += 1; // consume the value
          }
          break;
        }
        if (ch !== 's' && ch !== 'q') return refuse('X-FLAG');
      }
      continue;
    }
    if (a.startsWith('-')) return refuse('X-FLAG');
    return refuse('X-COMMIT-PATHSPEC'); // a pathspec given without the mandatory `--`
  }
  if (!sep || after.length === 0 || after.some(isWholeTreePathspec)) return refuse('X-COMMIT-PATHSPEC');
  return needs('impl');
}

function classifyPathCommand(
  rest: readonly string[],
  okFlags: ReadonlySet<string>,
  forceRule: string | undefined,
  treeRule: string,
  minPaths: number,
): Classified {
  const { before, after } = splitSep(rest);
  const paths = [...after];
  for (const a of before) {
    if (a.startsWith('-') && a !== '-') {
      if (forceRule !== undefined && (a === '--force' || clusterHas(a, 'f'))) return refuse(forceRule);
      if (!okFlags.has(a)) return refuse('X-FLAG');
    } else {
      paths.push(a);
    }
  }
  if (paths.length < minPaths) return refuse('X-PATHSPEC');
  if (paths.some(isWholeTreePathspec)) return refuse(treeRule);
  return needs('impl');
}

function classifyFetch(rest: readonly string[]): Classified {
  const FETCH_OK = new Set(['--all', '-p', '--prune', '-q', '--quiet', '-v', '--verbose', '--tags', '--no-tags']);
  const positionals: string[] = [];
  for (const a of rest) {
    if (a.startsWith('-')) {
      if (!FETCH_OK.has(a)) return refuse('X-FETCH');
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 2) return refuse('X-FETCH');
  const [remote, ref] = positionals;
  // Remote must be a plain name (blocks URLs and ext:: transport helpers); refspec has no ':'.
  if (remote !== undefined && !SAFE_REMOTE.test(remote)) return refuse('X-FETCH');
  if (ref !== undefined && !SAFE_REF.test(ref)) return refuse('X-FETCH');
  return needs('impl');
}

function classifySwitch(rest: readonly string[]): Classified {
  const SW_OK = new Set(['--detach', '-d', '-q', '--quiet', '--guess', '--no-guess']);
  const FORCE = new Set(['--force', '-f', '--discard-changes', '-C', '--force-create', '--orphan']);
  const positionals: string[] = [];
  let created = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (FORCE.has(a)) return refuse('X-SWITCH-FORCE');
    if (a === '--create') {
      created = true;
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('-') || !SAFE_REF.test(v)) return refuse('X-FLAG');
      i += 1;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      if (!SW_OK.has(a)) return refuse('X-FLAG');
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < (created ? 0 : 1) || positionals.length > 1) return refuse('X-PATHSPEC');
  if (positionals.some((p) => p !== '-' && !SAFE_REF.test(p))) return refuse('X-FLAG');
  return needs('impl');
}

function classifyMerge(rest: readonly string[]): Classified {
  let ff = false;
  const refs: string[] = [];
  for (const a of rest) {
    if (a === '--ff-only') ff = true;
    else if (a === '-q' || a === '--quiet' || a === '-v' || a === '--verbose') continue;
    else if (a.startsWith('-')) return refuse('X-MERGE-FF');
    else refs.push(a);
  }
  if (!ff || refs.length !== 1 || !SAFE_REF.test(refs[0] as string)) return refuse('X-MERGE-FF');
  return needs('merge');
}

/** Walks up to the deepest existing ancestor, realpaths it, and re-appends the rest. */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Strict containment: `child` is below `parent`, never equal to it. */
function strictlyInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Scrubbed environment: no config injection, no program-selection overrides, no editor/prompt hangs. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const BLOCKED =
    /^GIT_(CONFIG|EXTERNAL_DIFF|EXEC_PATH|SSH|PROXY_COMMAND|ASKPASS|EDITOR|SEQUENCE_EDITOR|PAGER|ALTERNATE|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$)/;
  for (const [k, v] of Object.entries(env)) {
    if (!BLOCKED.test(k)) out[k] = v;
  }
  out['GIT_EDITOR'] = 'true';
  out['GIT_TERMINAL_PROMPT'] = '0';
  return out;
}

/** Main-repo root (parent of the common .git dir), or undefined when it cannot be established. */
function mainRepoRoot(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    env: scrubbedEnv(process.env),
    encoding: 'utf8',
  });
  if (r.status !== 0) return undefined;
  const common = r.stdout.trim();
  if (path.basename(common) !== '.git') return undefined;
  return fs.realpathSync(path.dirname(common));
}

function underWorktrees(p: string, cwd: string): boolean {
  const root = mainRepoRoot(cwd);
  if (root === undefined) return false;
  const base = realResolve(path.join(root, '.worktrees'));
  return strictlyInside(realResolve(path.resolve(cwd, p)), base);
}

function classifyWorktree(rest: readonly string[], cwd: string): Classified {
  const [action, ...args] = rest;
  switch (action) {
    case 'list':
      return args.every((a) => a === '--porcelain' || a === '-v' || a === '--verbose' || a === '-z')
        ? needs('ro')
        : refuse('X-WORKTREE-FLAG');
    case 'prune':
      return args.every((a) => a === '-n' || a === '--dry-run' || a === '-v' || a === '--verbose')
        ? needs('merge')
        : refuse('X-WORKTREE-FLAG');
    case 'add': {
      const positionals: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (a === '-b') {
          const v = args[i + 1];
          if (v === undefined || v.startsWith('-') || !SAFE_REF.test(v)) return refuse('X-WORKTREE-FLAG');
          i += 1;
        } else if (a === '--detach' || a === '-q' || a === '--quiet') {
          continue;
        } else if (a.startsWith('-')) {
          return refuse('X-WORKTREE-FLAG');
        } else {
          positionals.push(a);
        }
      }
      if (positionals.length < 1 || positionals.length > 2) return refuse('X-WORKTREE-FLAG');
      if (positionals.slice(1).some((p) => !SAFE_REF.test(p))) return refuse('X-WORKTREE-FLAG');
      return underWorktrees(positionals[0] as string, cwd) ? needs('merge') : refuse('X-WORKTREE-PATH');
    }
    case 'remove': {
      if (args.length !== 1) return refuse('X-WORKTREE-FLAG');
      const target = args[0] as string;
      if (target.startsWith('-')) return refuse('X-WORKTREE-FLAG');
      return underWorktrees(target, cwd) ? needs('merge') : refuse('X-WORKTREE-PATH');
    }
    default:
      return refuse('X-WORKTREE');
  }
}

function classify(sub: string, rest: readonly string[], cwd: string): Classified {
  switch (sub) {
    case 'stash':
      return refuse('L1');
    case 'reset':
      return refuse('L3');
    case 'push':
      return refuse('L4');
    case 'clean':
    case 'checkout':
      return refuse('L5');
    case 'rebase':
      return refuse('X-REBASE');
    case 'tag':
      return rest.some((a) => a === '--delete' || clusterHas(a, 'd')) ? refuse('L5') : refuse('X-SUBCMD');
    case 'config':
      return rest.length === 2 && rest[0] === '--get' && !(rest[1] as string).startsWith('-')
        ? needs('ro')
        : refuse('X-CONFIG');
    case 'branch':
      return classifyBranch(rest);
    case 'worktree':
      return classifyWorktree(rest, cwd);
    case 'remote':
      return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose'))
        ? needs('ro')
        : refuse('X-REMOTE');
    case 'reflog':
      return rest[0] === 'expire' || rest[0] === 'delete' || rest[0] === 'exists' ? refuse('X-REFLOG') : needs('ro');
    case 'symbolic-ref': {
      const positionals = rest.filter((a) => !a.startsWith('-'));
      const bad = rest.some((a) => a === '-d' || a === '--delete' || a === '-m');
      return bad || positionals.length > 1 ? refuse('X-SYMREF') : needs('ro');
    }
    case 'add':
      return classifyAdd(rest);
    case 'commit':
      return classifyCommit(rest);
    case 'restore':
      return classifyPathCommand(
        rest,
        new Set(['--staged', '-S', '--worktree', '-W', '-q', '--quiet']),
        undefined,
        'X-RESTORE-TREE',
        1,
      );
    case 'mv':
      return classifyPathCommand(
        rest,
        new Set(['-k', '-n', '--dry-run', '-v', '--verbose']),
        'X-MV-FORCE',
        'X-PATHSPEC',
        2,
      );
    case 'rm':
      return classifyPathCommand(
        rest,
        new Set(['--cached', '-n', '--dry-run', '-q', '--quiet', '-r', '--ignore-unmatch']),
        'X-RM-FORCE',
        'X-RM-TREE',
        1,
      );
    case 'fetch':
      return classifyFetch(rest);
    case 'switch':
      return classifySwitch(rest);
    case 'merge':
      return classifyMerge(rest);
    default:
      break;
  }
  if (RO_SIMPLE.has(sub)) {
    for (const a of rest) {
      if (isAbbrevOf(a, '--output') || isAbbrevOf(a, '--ext-diff')) return refuse('X-OUTPUT');
    }
    return needs('ro');
  }
  return refuse('X-SUBCMD');
}

/**
 * Decides whether `args` (everything after the wrapper name) is permitted in `mode`.
 * Pure apart from read-only git probes used to locate the main repo for worktree paths.
 */
export function evaluateGit(mode: GitMode, args: readonly string[], ctx: { cwd: string }): Decision {
  for (const a of args) {
    if (a === '-c' || a.startsWith('--config-env')) return deny('X-DASH-C');
  }
  let i = 0;
  let dashC: string | undefined;
  if (args[0] === '-C') {
    dashC = args[1];
    if (dashC === undefined || dashC.startsWith('-')) return deny('X-DASH-C-PATH');
    i = 2;
  }
  const sub = args[i];
  if (sub === undefined) return deny('X-SUBCMD');
  if (sub.startsWith('-')) return deny(sub.startsWith('-c') ? 'X-DASH-C' : 'X-GLOBAL-OPT');
  const rest = args.slice(i + 1);

  const c = classify(sub, rest, ctx.cwd);
  if ('rule' in c) return deny(c.rule);
  if (TIER[c.tier] > TIER[mode]) return deny('X-MODE');
  // -C <path> is a prefix for read-only subcommands only.
  if (dashC !== undefined && c.tier !== 'ro') return deny('X-DASH-C-PATH');
  return { ok: true, argv: [...args] };
}

/** Runs the git wrapper CLI; returns the process exit code (2 = policy denial). */
export function runGitCli(argv1: string, args: readonly string[]): number {
  const mode = modeFromName(path.basename(argv1));
  if (mode === undefined) {
    process.stderr.write('sox-git: X-MODE denied\n');
    return 2;
  }
  const d = evaluateGit(mode, args, { cwd: process.cwd() });
  if (!d.ok) {
    process.stderr.write(`sox-git: ${d.rule} denied\n`);
    return 2;
  }
  const r = spawnSync('git', d.argv, { stdio: 'inherit', env: scrubbedEnv(process.env) });
  if (r.error) {
    process.stderr.write(`sox-git: failed to run git: ${r.error.message}\n`);
    return 127;
  }
  return r.status ?? 1;
}

/** One validated sox-rm target. */
export interface IRmTarget {
  path: string;
  recursive: boolean;
}

export type RmDecision = { ok: true; targets: IRmTarget[] } | { ok: false; rule: string };

/**
 * Validates sox-rm args: only paths inside `cwd`; recursion only strictly below
 * `<cwd>/tmp/` or `<cwd>/.worktrees/`; any force flag is refused (L6).
 */
export function evaluateRm(args: readonly string[], ctx: { cwd: string }): RmDecision {
  const { before, after } = splitSep(args);
  let recursive = false;
  const paths = [...after];
  for (const a of before) {
    if (a.startsWith('-') && a !== '-') {
      if (a === '--force' || clusterHas(a, 'f')) return deny('L6');
      if (a === '--recursive' || a === '-r' || a === '-R') recursive = true;
      else return deny('X-RM-FLAG');
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) return deny('X-RM-NOARGS');
  const cwdReal = fs.realpathSync(ctx.cwd);
  const recursiveRoots = [path.join(cwdReal, 'tmp'), path.join(cwdReal, '.worktrees')];
  const targets: IRmTarget[] = [];
  for (const p of paths) {
    const abs = path.resolve(cwdReal, p);
    const base = path.basename(abs);
    // Resolve the parent (follows symlinked directories) but keep the leaf, so a leaf symlink is unlinked, not followed.
    const target = path.join(realResolve(path.dirname(abs)), base);
    if (!strictlyInside(target, cwdReal)) return deny('X-RM-OUTSIDE');
    if (recursive && !recursiveRoots.some((root) => strictlyInside(target, root))) return deny('L6');
    targets.push({ path: target, recursive });
  }
  return { ok: true, targets };
}

/** Runs the sox-rm CLI; returns the process exit code (2 = policy denial). */
export function runRmCli(args: readonly string[]): number {
  const d = evaluateRm(args, { cwd: process.cwd() });
  if (!d.ok) {
    process.stderr.write(`sox-rm: ${d.rule} denied\n`);
    return 2;
  }
  for (const t of d.targets) {
    try {
      // lstat, not stat: a symlink (even to a directory) is unlinked, never followed.
      if (!fs.lstatSync(t.path).isDirectory()) fs.unlinkSync(t.path);
      else fs.rmSync(t.path, { recursive: t.recursive, force: false });
    } catch (err) {
      process.stderr.write(`sox-rm: ${(err as Error).message}\n`);
      return 1;
    }
  }
  return 0;
}
