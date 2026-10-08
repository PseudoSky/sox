/**
 * faa8064b SHELL-AC5 - wrapper unit table (spec section 4, AC5).
 *
 * Drives the REAL wrapper executables (bin/sox-git via sox-git-ro|impl|merge
 * symlinks, and bin/sox-rm) against a temp git repo under the OS tmpdir, the way
 * the agent-mcp shell server does: exec by name, argv array, no shell.
 * Denied forms must exit 2 with `sox-git: <rule-id> denied` (or `sox-rm:`) on
 * stderr and leave the repo untouched; permitted forms must exit 0.
 * Requires the package to be built (the nx `test` target depends on `build`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RULE_IDS } from './policy';

const BIN_DIR = path.resolve(__dirname, '..', 'bin');
let sandbox: string;
let links: string;
let repo: string;
let remote: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function run(name: string, args: string[], cwd: string = repo) {
  const r = spawnSync(path.join(links, name), args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-wrappers-')));
  links = path.join(sandbox, 'links');
  fs.mkdirSync(links);
  for (const name of ['sox-git-ro', 'sox-git-impl', 'sox-git-merge', 'sox-git']) {
    fs.symlinkSync(path.join(BIN_DIR, 'sox-git'), path.join(links, name));
  }
  fs.symlinkSync(path.join(BIN_DIR, 'sox-rm'), path.join(links, 'sox-rm'));
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  n += 1;
  repo = path.join(sandbox, `repo${n}`);
  remote = path.join(sandbox, `remote${n}.git`);
  const featWt = path.join(sandbox, `feat-wt${n}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  fs.mkdirSync(path.join(repo, 'tmp'));
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'tmp/\n.worktrees/\n');
  git(repo, 'add', 'a.txt', 'b.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  git(sandbox, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  // a branch one commit ahead of main for merge --ff-only / branch -d
  git(repo, 'branch', 'feat');
  git(repo, 'worktree', 'add', '-q', featWt, 'feat');
  fs.writeFileSync(path.join(featWt, 'f.txt'), 'f\n');
  git(featWt, 'add', 'f.txt');
  git(featWt, 'commit', '-q', '-m', 'feat');
  git(repo, 'worktree', 'remove', featWt);
});

const dirty = (): void => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a changed\n');
};
const snapshot = (): string =>
  [git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'stash', 'list')].join('|');

// ---------------------------------------------------------------------------
// Denied forms: [label, wrapper, args, rule id]
// ---------------------------------------------------------------------------
type DeniedRow = [string, string, string[], string];
const DENIED: DeniedRow[] = [
  ['L1 stash', 'sox-git-merge', ['stash'], 'L1'],
  ['L1 stash pop', 'sox-git-impl', ['stash', 'pop'], 'L1'],
  ['L1 stash push -u', 'sox-git-ro', ['stash', 'push', '-u'], 'L1'],
  ['L2 add -A', 'sox-git-impl', ['add', '-A'], 'L2'],
  ['L2 add --all', 'sox-git-impl', ['add', '--all'], 'L2'],
  ['L2 add .', 'sox-git-impl', ['add', '.'], 'L2'],
  ['L2 add ./', 'sox-git-impl', ['add', './'], 'L2'],
  ['L2 add -- .', 'sox-git-impl', ['add', '--', '.'], 'L2'],
  ['L2 add *', 'sox-git-impl', ['add', '*'], 'L2'],
  ['L2 add -u', 'sox-git-impl', ['add', '-u'], 'L2'],
  ['L2 add -Av cluster', 'sox-git-merge', ['add', '-Av', 'a.txt'], 'L2'],
  ['L2 add :/ magic', 'sox-git-impl', ['add', ':/'], 'L2'],
  ['L3 reset --hard', 'sox-git-merge', ['reset', '--hard'], 'L3'],
  ['L3 reset --hard HEAD~1', 'sox-git-impl', ['reset', '--hard', 'HEAD~1'], 'L3'],
  ['L3 reset --soft', 'sox-git-merge', ['reset', '--soft', 'HEAD~1'], 'L3'],
  ['L3 reset (bare)', 'sox-git-ro', ['reset'], 'L3'],
  ['L4 push', 'sox-git-merge', ['push'], 'L4'],
  ['L4 push --force', 'sox-git-merge', ['push', '--force', 'origin', 'main'], 'L4'],
  ['L4 push --no-verify', 'sox-git-impl', ['push', '--no-verify'], 'L4'],
  ['L5 clean -fd', 'sox-git-merge', ['clean', '-fd'], 'L5'],
  ['L5 checkout -- .', 'sox-git-merge', ['checkout', '--', '.'], 'L5'],
  ['L5 checkout branch', 'sox-git-impl', ['checkout', 'feat'], 'L5'],
  ['L5 branch -D', 'sox-git-merge', ['branch', '-D', 'feat'], 'L5'],
  ['L5 branch -d -f', 'sox-git-merge', ['branch', '-d', '-f', 'feat'], 'L5'],
  ['L5 branch --delete --force', 'sox-git-merge', ['branch', '--delete', '--force', 'feat'], 'L5'],
  ['L5 tag -d', 'sox-git-merge', ['tag', '-d', 'v1'], 'L5'],
  ['L5 tag --delete', 'sox-git-impl', ['tag', '--delete', 'v1'], 'L5'],
  ['L6 rm -rf', 'sox-rm', ['-rf', 'tmp/x'], 'L6'],
  ['L6 rm -fr', 'sox-rm', ['-fr', 'tmp/x'], 'L6'],
  ['L6 rm -r -f', 'sox-rm', ['-r', '-f', 'tmp/x'], 'L6'],
  ['L6 rm -r --force', 'sox-rm', ['-r', '--force', 'tmp/x'], 'L6'],
  ['L6 rm -f (no recursion)', 'sox-rm', ['-f', 'a.txt'], 'L6'],
  ['L6 rm -r outside tmp', 'sox-rm', ['-r', 'src'], 'L6'],
  ['L6 rm -r tmp itself', 'sox-rm', ['-r', 'tmp'], 'L6'],
  ['L6 rm -r .git', 'sox-rm', ['-r', '.git'], 'L6'],
  ['X-DASH-C -c config', 'sox-git-ro', ['-c', 'core.pager=sh', 'status'], 'X-DASH-C'],
  ['X-DASH-C glued -ccfg', 'sox-git-ro', ['-ccore.pager=sh', 'status'], 'X-DASH-C'],
  ['X-DASH-C -c after subcommand', 'sox-git-ro', ['log', '-c'], 'X-DASH-C'],
  ['X-DASH-C --config-env', 'sox-git-ro', ['--config-env=a=B', 'status'], 'X-DASH-C'],
  ['X-GLOBAL-OPT --git-dir', 'sox-git-ro', ['--git-dir=/x', 'status'], 'X-GLOBAL-OPT'],
  ['X-CONFIG write', 'sox-git-merge', ['config', 'user.name', 'x'], 'X-CONFIG'],
  ['X-CONFIG --global --get', 'sox-git-ro', ['config', '--global', '--get', 'x'], 'X-CONFIG'],
  ['X-CONFIG --unset', 'sox-git-merge', ['config', '--unset', 'user.name'], 'X-CONFIG'],
  ['X-REBASE', 'sox-git-merge', ['rebase', 'main'], 'X-REBASE'],
  ['X-SUBCMD update-ref', 'sox-git-merge', ['update-ref', '-d', 'refs/heads/feat'], 'X-SUBCMD'],
  ['X-SUBCMD gc', 'sox-git-merge', ['gc'], 'X-SUBCMD'],
  ['X-SUBCMD tag create', 'sox-git-merge', ['tag', 'v1'], 'X-SUBCMD'],
  ['X-SUBCMD (none)', 'sox-git-ro', [], 'X-SUBCMD'],
  ['X-MODE bare sox-git name', 'sox-git', ['status'], 'X-MODE'],
  ['X-MODE ro cannot add', 'sox-git-ro', ['add', 'a.txt'], 'X-MODE'],
  ['X-MODE ro cannot commit', 'sox-git-ro', ['commit', '-m', 'x', '--', 'a.txt'], 'X-MODE'],
  ['X-MODE impl cannot merge', 'sox-git-impl', ['merge', '--ff-only', 'feat'], 'X-MODE'],
  ['X-MODE impl cannot branch -d', 'sox-git-impl', ['branch', '-d', 'feat'], 'X-MODE'],
  ['X-MODE impl cannot worktree add', 'sox-git-impl', ['worktree', 'add', '.worktrees/w'], 'X-MODE'],
  ['X-DASH-C-PATH -C with write form', 'sox-git-merge', ['-C', '.', 'commit', '-m', 'x', '--', 'a.txt'], 'X-DASH-C-PATH'],
  ['X-DASH-C-PATH -C without path', 'sox-git-ro', ['-C'], 'X-DASH-C-PATH'],
  ['X-OUTPUT diff --output', 'sox-git-ro', ['diff', '--output=out.txt'], 'X-OUTPUT'],
  ['X-OUTPUT abbreviated --outp', 'sox-git-ro', ['log', '--outp=out.txt'], 'X-OUTPUT'],
  ['X-OUTPUT --ext-diff', 'sox-git-ro', ['diff', '--ext-diff'], 'X-OUTPUT'],
  ['X-AMEND commit --amend', 'sox-git-impl', ['commit', '--amend', '-m', 'x', '--', 'a.txt'], 'X-AMEND'],
  ['X-AMEND abbreviated --amen', 'sox-git-impl', ['commit', '--amen', '-m', 'x', '--', 'a.txt'], 'X-AMEND'],
  ['X-NOVERIFY --no-verify', 'sox-git-impl', ['commit', '--no-verify', '-m', 'x', '--', 'a.txt'], 'X-NOVERIFY'],
  ['X-NOVERIFY -n', 'sox-git-impl', ['commit', '-n', '-m', 'x', '--', 'a.txt'], 'X-NOVERIFY'],
  ['X-COMMIT-ALL -a', 'sox-git-impl', ['commit', '-a', '-m', 'x', '--', 'a.txt'], 'X-COMMIT-ALL'],
  ['X-COMMIT-ALL -am', 'sox-git-impl', ['commit', '-am', 'x', '--', 'a.txt'], 'X-COMMIT-ALL'],
  ['X-COMMIT-ALL --all', 'sox-git-impl', ['commit', '--all', '-m', 'x', '--', 'a.txt'], 'X-COMMIT-ALL'],
  ['X-COMMIT-PATHSPEC none', 'sox-git-impl', ['commit', '-m', 'x'], 'X-COMMIT-PATHSPEC'],
  ['X-COMMIT-PATHSPEC empty after --', 'sox-git-impl', ['commit', '-m', 'x', '--'], 'X-COMMIT-PATHSPEC'],
  ['X-COMMIT-PATHSPEC no separator', 'sox-git-impl', ['commit', '-m', 'x', 'a.txt'], 'X-COMMIT-PATHSPEC'],
  ['X-COMMIT-PATHSPEC whole tree', 'sox-git-impl', ['commit', '-m', 'x', '--', '.'], 'X-COMMIT-PATHSPEC'],
  ['X-FLAG commit --reset-author', 'sox-git-impl', ['commit', '--reset-author', '-m', 'x', '--', 'a.txt'], 'X-FLAG'],
  ['X-RESTORE-TREE restore .', 'sox-git-impl', ['restore', '.'], 'X-RESTORE-TREE'],
  ['X-RESTORE-TREE restore --staged .', 'sox-git-impl', ['restore', '--staged', '.'], 'X-RESTORE-TREE'],
  ['X-MV-FORCE mv -f', 'sox-git-impl', ['mv', '-f', 'a.txt', 'b.txt'], 'X-MV-FORCE'],
  ['X-RM-FORCE git rm -f', 'sox-git-impl', ['rm', '-f', 'a.txt'], 'X-RM-FORCE'],
  ['X-RM-TREE git rm -r .', 'sox-git-impl', ['rm', '-r', '.'], 'X-RM-TREE'],
  ['X-FETCH url remote', 'sox-git-impl', ['fetch', 'https://example.com/x.git'], 'X-FETCH'],
  ['X-FETCH ext:: transport', 'sox-git-impl', ['fetch', 'ext::sh -c id'], 'X-FETCH'],
  ['X-FETCH --upload-pack', 'sox-git-impl', ['fetch', '--upload-pack=sh', 'origin'], 'X-FETCH'],
  ['X-SWITCH-FORCE switch -f', 'sox-git-impl', ['switch', '-f', 'feat'], 'X-SWITCH-FORCE'],
  ['X-SWITCH-FORCE --discard-changes', 'sox-git-impl', ['switch', '--discard-changes', 'feat'], 'X-SWITCH-FORCE'],
  ['X-MERGE-FF merge without --ff-only', 'sox-git-merge', ['merge', 'feat'], 'X-MERGE-FF'],
  ['X-MERGE-FF --no-ff', 'sox-git-merge', ['merge', '--no-ff', 'feat'], 'X-MERGE-FF'],
  ['X-MERGE-FF --abort', 'sox-git-merge', ['merge', '--abort'], 'X-MERGE-FF'],
  ['X-MERGE-FF --squash', 'sox-git-merge', ['merge', '--squash', '--ff-only', 'feat'], 'X-MERGE-FF'],
  ['X-WORKTREE-PATH outside', 'sox-git-merge', ['worktree', 'add', '../escape', '-b', 'esc'], 'X-WORKTREE-PATH'],
  ['X-WORKTREE-PATH traversal', 'sox-git-merge', ['worktree', 'add', '.worktrees/../escape', '-b', 'esc'], 'X-WORKTREE-PATH'],
  ['X-WORKTREE-PATH .worktrees itself', 'sox-git-merge', ['worktree', 'add', '.worktrees', '-b', 'esc'], 'X-WORKTREE-PATH'],
  ['X-WORKTREE-PATH remove outside', 'sox-git-merge', ['worktree', 'remove', '/tmp/x'], 'X-WORKTREE-PATH'],
  ['X-WORKTREE-FLAG add -B', 'sox-git-merge', ['worktree', 'add', '.worktrees/w', '-B', 'x'], 'X-WORKTREE-FLAG'],
  ['X-WORKTREE-FLAG remove --force', 'sox-git-merge', ['worktree', 'remove', '--force', '.worktrees/w'], 'X-WORKTREE-FLAG'],
  ['X-WORKTREE move', 'sox-git-merge', ['worktree', 'move', 'a', 'b'], 'X-WORKTREE'],
  ['X-BRANCH create', 'sox-git-merge', ['branch', 'newbranch'], 'X-BRANCH'],
  ['X-BRANCH rename -m', 'sox-git-merge', ['branch', '-m', 'feat', 'x'], 'X-BRANCH'],
  ['X-REMOTE add', 'sox-git-merge', ['remote', 'add', 'x', 'https://example.com/x.git'], 'X-REMOTE'],
  ['X-REFLOG expire', 'sox-git-merge', ['reflog', 'expire', '--all'], 'X-REFLOG'],
  ['X-SYMREF write', 'sox-git-merge', ['symbolic-ref', 'HEAD', 'refs/heads/feat'], 'X-SYMREF'],
  ['X-RM-OUTSIDE parent dir', 'sox-rm', ['../other'], 'X-RM-OUTSIDE'],
  ['X-RM-OUTSIDE absolute', 'sox-rm', ['/etc/hosts'], 'X-RM-OUTSIDE'],
  ['X-RM-OUTSIDE cwd itself', 'sox-rm', ['.'], 'X-RM-OUTSIDE'],
  ['X-RM-FLAG -i', 'sox-rm', ['-i', 'a.txt'], 'X-RM-FLAG'],
  ['X-RM-NOARGS', 'sox-rm', [], 'X-RM-NOARGS'],
];

describe('faa8064b SHELL-AC5: denied forms exit 2 with the rule id on stderr', () => {
  it.each(DENIED)('faa8064b SHELL-AC5: %s', (_label, wrapper, args, rule) => {
    dirty();
    const before = snapshot();
    const r = run(wrapper, args);
    expect(r.status).toBe(2);
    const prefix = wrapper === 'sox-rm' ? 'sox-rm' : 'sox-git';
    expect(r.stderr).toContain(`${prefix}: ${rule} denied`);
    expect(snapshot()).toBe(before);
  });

  it('faa8064b SHELL-AC5: a denied stash never reaches git (dirty file stays, stash list empty)', () => {
    dirty();
    run('sox-git-merge', ['stash']);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a changed\n');
    expect(git(repo, 'stash', 'list')).toBe('');
  });

  it('faa8064b SHELL-AC5: L2 add -A stages nothing; L3 reset --hard keeps local edits; L6 rm -rf keeps the directory', () => {
    dirty();
    fs.mkdirSync(path.join(repo, 'tmp', 'x'));
    fs.writeFileSync(path.join(repo, 'tmp', 'x', 'k'), 'k');
    expect(run('sox-git-impl', ['add', '-A']).status).toBe(2);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(run('sox-git-merge', ['reset', '--hard']).status).toBe(2);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a changed\n');
    expect(run('sox-rm', ['-rf', 'tmp/x']).status).toBe(2);
    expect(fs.existsSync(path.join(repo, 'tmp', 'x', 'k'))).toBe(true);
  });

  it('faa8064b SHELL-AC5: every denied row id is a declared rule id', () => {
    for (const [, , , rule] of DENIED) expect(RULE_IDS).toContain(rule);
  });

  it('faa8064b SHELL-AC5: sox-rm refuses a symlinked directory that escapes cwd', () => {
    const outside = path.join(sandbox, `outside${n}`);
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'victim', 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(repo, 'tmp', 'link'));
    const r = run('sox-rm', ['-r', 'tmp/link/victim']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('sox-rm: X-RM-OUTSIDE denied');
    expect(fs.existsSync(path.join(outside, 'victim', 'keep'))).toBe(true);
  });

  it('faa8064b SHELL-AC5: GIT_CONFIG_* env injection is scrubbed before git runs', () => {
    const r = spawnSync(path.join(links, 'sox-git-ro'), ['config', '--get', 'injected.key'], {
      cwd: repo,
      env: { ...GIT_ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'injected.key', GIT_CONFIG_VALUE_0: 'pwned' },
      encoding: 'utf8',
    });
    expect(r.stdout).not.toContain('pwned');
    expect(r.status).toBe(1); // key unset
  });
});

// ---------------------------------------------------------------------------
// Permitted forms: [label, wrapper, args builder (may set up state), verify]
// ---------------------------------------------------------------------------
type AllowedRow = [string, string, () => string[], (() => void) | undefined];
const wt = (name: string): string => path.join(repo, '.worktrees', name);
const ALLOWED: AllowedRow[] = [
  ['ro status', 'sox-git-ro', () => ['status'], undefined],
  ['ro status --porcelain', 'sox-git-ro', () => ['status', '--porcelain'], undefined],
  ['ro diff', 'sox-git-ro', () => ['diff'], undefined],
  ['ro log --oneline', 'sox-git-ro', () => ['log', '--oneline'], undefined],
  ['ro show HEAD', 'sox-git-ro', () => ['show', 'HEAD'], undefined],
  ['ro rev-parse HEAD', 'sox-git-ro', () => ['rev-parse', 'HEAD'], undefined],
  ['ro rev-list HEAD', 'sox-git-ro', () => ['rev-list', 'HEAD'], undefined],
  ['ro reflog', 'sox-git-ro', () => ['reflog'], undefined],
  ['ro ls-files', 'sox-git-ro', () => ['ls-files'], undefined],
  ['ro cat-file -t HEAD', 'sox-git-ro', () => ['cat-file', '-t', 'HEAD'], undefined],
  ['ro check-ignore tmp', 'sox-git-ro', () => ['check-ignore', 'tmp'], undefined],
  ['ro for-each-ref', 'sox-git-ro', () => ['for-each-ref'], undefined],
  ['ro merge-base main feat', 'sox-git-ro', () => ['merge-base', 'main', 'feat'], undefined],
  ['ro merge-tree --write-tree', 'sox-git-ro', () => ['merge-tree', '--write-tree', 'main', 'feat'], undefined],
  ['ro symbolic-ref HEAD', 'sox-git-ro', () => ['symbolic-ref', 'HEAD'], undefined],
  ['ro remote -v', 'sox-git-ro', () => ['remote', '-v'], undefined],
  ['ro branch --list', 'sox-git-ro', () => ['branch', '--list'], undefined],
  ['ro branch -a', 'sox-git-ro', () => ['branch', '-a'], undefined],
  ['ro branch --show-current', 'sox-git-ro', () => ['branch', '--show-current'], undefined],
  ['ro branch --list pattern', 'sox-git-ro', () => ['branch', '--list', 'f*'], undefined],
  ['ro worktree list', 'sox-git-ro', () => ['worktree', 'list'], undefined],
  ['ro config --get', 'sox-git-ro', () => ['config', '--get', 'user.name'], undefined],
  ['ro -C <path> status', 'sox-git-ro', () => ['-C', repo, 'status'], undefined],
  ['impl status (ro subset)', 'sox-git-impl', () => ['status'], undefined],
  [
    'impl add <pathspec>',
    'sox-git-impl',
    () => {
      dirty();
      return ['add', 'a.txt'];
    },
    () => expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt'),
  ],
  [
    'impl add -- <pathspec>',
    'sox-git-impl',
    () => {
      dirty();
      return ['add', '--', 'a.txt'];
    },
    () => expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt'),
  ],
  [
    'impl commit -m ... -- <pathspec>',
    'sox-git-impl',
    () => {
      dirty();
      return ['commit', '-q', '-m', 'wrapped commit', '--', 'a.txt'];
    },
    () => expect(git(repo, 'log', '-1', '--format=%s')).toBe('wrapped commit'),
  ],
  [
    'impl commit only commits the named pathspec',
    'sox-git-impl',
    () => {
      dirty();
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b changed\n');
      git(repo, 'add', 'b.txt'); // another agent staged b.txt in the shared index
      return ['commit', '-q', '-m', 'only a', '--', 'a.txt'];
    },
    () => {
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('b.txt');
    },
  ],
  [
    'impl restore <path>',
    'sox-git-impl',
    () => {
      dirty();
      return ['restore', 'a.txt'];
    },
    () => expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n'),
  ],
  [
    'impl restore --staged <path>',
    'sox-git-impl',
    () => {
      dirty();
      git(repo, 'add', 'a.txt');
      return ['restore', '--staged', 'a.txt'];
    },
    () => expect(git(repo, 'diff', '--cached', '--name-only')).toBe(''),
  ],
  [
    'impl mv',
    'sox-git-impl',
    () => ['mv', 'a.txt', 'c.txt'],
    () => expect(fs.existsSync(path.join(repo, 'c.txt'))).toBe(true),
  ],
  [
    'impl rm <path>',
    'sox-git-impl',
    () => ['rm', 'b.txt'],
    () => expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false),
  ],
  ['impl fetch origin', 'sox-git-impl', () => ['fetch', 'origin'], undefined],
  ['impl fetch --prune', 'sox-git-impl', () => ['fetch', '--prune'], undefined],
  [
    'impl switch --create',
    'sox-git-impl',
    () => ['switch', '--create', 'topic'],
    () => expect(git(repo, 'branch', '--show-current')).toBe('topic'),
  ],
  [
    'impl switch <branch>',
    'sox-git-impl',
    () => ['switch', 'feat'],
    () => expect(git(repo, 'branch', '--show-current')).toBe('feat'),
  ],
  [
    'merge merge --ff-only',
    'sox-git-merge',
    () => ['merge', '--ff-only', 'feat'],
    () => expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat'),
  ],
  [
    'merge worktree add -b under .worktrees',
    'sox-git-merge',
    () => ['worktree', 'add', '.worktrees/w1', '-b', 'w1branch'],
    () => expect(fs.existsSync(path.join(wt('w1'), 'a.txt'))).toBe(true),
  ],
  [
    'merge worktree add with start point',
    'sox-git-merge',
    () => ['worktree', 'add', '-q', '.worktrees/w2', 'feat'],
    () => expect(fs.existsSync(path.join(wt('w2'), 'f.txt'))).toBe(true),
  ],
  [
    'merge worktree remove under .worktrees',
    'sox-git-merge',
    () => {
      git(repo, 'worktree', 'add', '-q', '.worktrees/w3', '-b', 'w3branch');
      return ['worktree', 'remove', '.worktrees/w3'];
    },
    () => expect(fs.existsSync(wt('w3'))).toBe(false),
  ],
  ['merge worktree prune', 'sox-git-merge', () => ['worktree', 'prune'], undefined],
  [
    'merge branch -d (merged branch)',
    'sox-git-merge',
    () => {
      git(repo, 'merge', '-q', '--ff-only', 'feat');
      return ['branch', '-d', 'feat'];
    },
    () => expect(git(repo, 'branch', '--list', 'feat')).toBe(''),
  ],
  ['merge status (ro subset)', 'sox-git-merge', () => ['status'], undefined],
];

describe('faa8064b SHELL-AC5: permitted forms exit 0 against a temp git repo', () => {
  it.each(ALLOWED.map((row) => [row[0], row] as const))('faa8064b SHELL-AC5: %s', (_label, row) => {
    const [, wrapper, mkArgs, verify] = row;
    const args = mkArgs();
    const r = run(wrapper, args);
    expect(r.stderr).not.toContain('denied');
    expect(r.status).toBe(0);
    verify?.();
  });

  it('faa8064b SHELL-AC5: sox-git-ro -C <path> reads another repo from a different cwd', () => {
    const r = run('sox-git-ro', ['-C', repo, 'rev-parse', '--show-toplevel'], sandbox);
    expect(r.status).toBe(0);
    expect(fs.realpathSync(r.stdout.trim())).toBe(repo);
  });

  it('faa8064b SHELL-AC5: worktree add from inside a linked worktree resolves the MAIN repo .worktrees', () => {
    git(repo, 'worktree', 'add', '-q', '.worktrees/outer', '-b', 'outerbranch');
    const ok = run('sox-git-merge', ['worktree', 'add', '-q', path.join(repo, '.worktrees', 'inner'), '-b', 'innerbranch'], wt('outer'));
    expect(ok.status).toBe(0);
    expect(fs.existsSync(wt('inner'))).toBe(true);
    const bad = run('sox-git-merge', ['worktree', 'add', '-q', path.join(repo, 'escape-from-outer'), '-b', 'nestedbranch'], wt('outer'));
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('sox-git: X-WORKTREE-PATH denied');
  });
});

describe('faa8064b SHELL-AC5: sox-rm permitted forms', () => {
  it('faa8064b SHELL-AC5: plain file removal inside cwd exits 0', () => {
    expect(run('sox-rm', ['a.txt']).status).toBe(0);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
  });

  it('faa8064b SHELL-AC5: -r under <cwd>/tmp/ exits 0 and removes the tree', () => {
    fs.mkdirSync(path.join(repo, 'tmp', 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tmp', 'deep', 'er', 'f'), 'x');
    expect(run('sox-rm', ['-r', 'tmp/deep']).status).toBe(0);
    expect(fs.existsSync(path.join(repo, 'tmp', 'deep'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'tmp'))).toBe(true);
  });

  it('faa8064b SHELL-AC5: --recursive under <cwd>/.worktrees/ exits 0', () => {
    fs.mkdirSync(path.join(repo, '.worktrees', 'old'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.worktrees', 'old', 'f'), 'x');
    expect(run('sox-rm', ['--recursive', '.worktrees/old']).status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.worktrees', 'old'))).toBe(false);
  });

  it('faa8064b SHELL-AC5: a symlink leaf is unlinked, its target survives', () => {
    const outside = path.join(sandbox, `target${n}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(repo, 'tmp', 'lnk'));
    expect(run('sox-rm', ['tmp/lnk']).status).toBe(0);
    expect(fs.existsSync(path.join(outside, 'keep'))).toBe(true);
  });

  it('faa8064b SHELL-AC5: removing a missing file is a runtime failure (exit 1), not a policy denial', () => {
    const r = run('sox-rm', ['nope.txt']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('denied');
  });

  it('faa8064b SHELL-AC5: non-recursive rm of a directory fails and leaves it', () => {
    fs.mkdirSync(path.join(repo, 'tmp', 'dir'));
    const r = run('sox-rm', ['tmp/dir']);
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(repo, 'tmp', 'dir'))).toBe(true);
  });
});
