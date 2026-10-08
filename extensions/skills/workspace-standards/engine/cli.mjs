#!/usr/bin/env node
// 891dbac0 T62.AC1 T62.AC2 T62.AC3 T62.AC4
// gate-engine CLI. `run` executes the gate set for a lifecycle step; `check` runs the generic check
// entry points. Exits with the worst gate's status. Releases nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EngineError, EXIT, CHECKS, loadTable, runGates, runChecks, readBaseline, shrinkBaseline, shellRunner } from './lib.mjs';

const USAGE = `usage:
  cli.mjs run   --step <A-H> [--class <c>] [--rigor <r>] [--changed <path>]... [--base <ref> --head <ref>]
                [--root <dir>] [--table <file>] [--report <file>|-] [--fail-on-obligation]
  cli.mjs check <completeness|liveness|reachability|teeth|all> [--root <dir>] [--table <file>]
                [--clauses <a,b>] [--baseline <file> [--update-baseline]] [--checks-module <file>] [--report <file>|-]
  --root defaults to the current directory; the table defaults to <root>/gates.table.json.`;

const VALUE_FLAGS = ['--step', '--class', '--rigor', '--changed', '--base', '--head', '--root', '--table', '--report', '--clauses', '--baseline', '--checks-module'];
const BOOL_FLAGS = ['--fail-on-obligation', '--update-baseline'];

export function parseArgs(argv) {
  const out = { positional: [], flags: {}, changed: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v !== '-')) throw new EngineError('E_USAGE', EXIT.USAGE, `${a} requires a value\n${USAGE}`);
      i++;
      if (a === '--changed') out.changed.push(v); else out.flags[a] = v;
    } else if (BOOL_FLAGS.includes(a)) out.flags[a] = true;
    else if (a.startsWith('--')) throw new EngineError('E_USAGE', EXIT.USAGE, `unknown flag ${a}\n${USAGE}`);
    else out.positional.push(a);
  }
  return out;
}

function writeReport(report, dest, root) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (dest === '-') { process.stdout.write(json); return null; }
  const file = path.resolve(root, dest ?? (report.kind === 'gate-report' ? 'gate-report.json' : 'check-report.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
  return file;
}

function changedPaths(a, root) {
  const { flags } = a;
  if (flags['--base'] || flags['--head']) {
    if (!flags['--base'] || !flags['--head']) throw new EngineError('E_USAGE', EXIT.USAGE, '--base and --head go together');
    return execFileSync('git', ['diff', '--name-only', flags['--base'], flags['--head']], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  return a.changed.length ? a.changed : undefined;
}

export async function main(argv) {
  const a = parseArgs(argv);
  const [verb, ...rest] = a.positional;
  const root = path.resolve(a.flags['--root'] ?? process.cwd());
  const tableFile = path.resolve(root, a.flags['--table'] ?? 'gates.table.json');
  if (verb === 'run') {
    const step = a.flags['--step'];
    if (!step) throw new EngineError('E_USAGE', EXIT.USAGE, `run requires --step\n${USAGE}`);
    const table = loadTable(tableFile);
    const report = runGates(table, {
      step, changeClass: a.flags['--class'], rigor: a.flags['--rigor'], changed: changedPaths(a, root), root,
      failOnObligation: a.flags['--fail-on-obligation'] === true,
    }, {
      evidenceDir: a.flags['--report'] === '-' ? undefined : path.join(path.resolve(root, a.flags['--report'] ?? 'gate-report.json') + '.evidence'),
    });
    const file = writeReport(report, a.flags['--report'], root);
    if (file) process.stderr.write(`gate-engine: ${report.summary.passed}/${report.summary.selected} passed, failed=[${report.summary.failed}] obligations=[${report.summary.obligations}] -> ${file}\n`);
    return report.exit;
  }
  if (verb === 'check') {
    if (a.flags['--checks-module']) await import(pathToFileURL(path.resolve(root, a.flags['--checks-module'])).href);
    const which = rest[0];
    if (!which) throw new EngineError('E_USAGE', EXIT.USAGE, `check requires a name\n${USAGE}`);
    const names = which === 'all' ? Object.keys(CHECKS) : [which];
    const table = loadTable(tableFile);
    const baselineFile = a.flags['--baseline'] ? path.resolve(root, a.flags['--baseline']) : undefined;
    const ctx = { table, root, run: shellRunner, clauses: a.flags['--clauses']?.split(',').filter(Boolean) };
    const report = runChecks(names, ctx, readBaseline(baselineFile));
    if (a.flags['--update-baseline']) {
      if (!baselineFile) throw new EngineError('E_USAGE', EXIT.USAGE, '--update-baseline requires --baseline');
      const all = names.flatMap((n) => CHECKS[n](ctx));
      shrinkBaseline(baselineFile, all);
      report.exit = 0;
    }
    const file = writeReport(report, a.flags['--report'], root);
    if (file) process.stderr.write(`gate-engine: ${report.findings.length} new finding(s), ${report.stale.length} stale baseline entr(ies) -> ${file}\n`);
    return report.exit;
  }
  throw new EngineError('E_USAGE', EXIT.USAGE, `unknown or missing verb\n${USAGE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`gate-engine: ${err.code ?? 'E_INTERNAL'}: ${err.message}\n`);
      process.exitCode = err instanceof EngineError ? err.exit : 70;
    },
  );
}
