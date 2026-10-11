#!/usr/bin/env node
// 891dbac0 T62.AC1 T62.AC2 T62.AC3 T62.AC4
// gate-engine CLI. `run` executes the gate set for a lifecycle step; `check` runs the generic check
// entry points. Exits with the worst gate's status. Releases nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EngineError, EXIT, CHECKS, loadTable, runGates, validateSelection, collectFindings, reportFromFindings, readBaseline, shrinkBaseline, initBaseline, shellRunner } from './lib.mjs';

const USAGE = `usage:
  cli.mjs run   --step <A-H> [--class <c>] [--rigor <r>] [--changed <path>]... [--base <ref> --head <ref>]
                [--root <dir>] [--table <file>] [--report <file>|-] [--fail-on-obligation]
  cli.mjs check <completeness|liveness|reachability|teeth|all> [--root <dir>] [--table <file>]
                [--clauses <a,b>] [--baseline <file> [--update-baseline | --init-baseline]] [--checks-module <file>] [--report <file>|-]
  --root defaults to the current directory; the table defaults to <root>/gates.table.json.`;

const VALUE_FLAGS = ['--step', '--class', '--rigor', '--changed', '--base', '--head', '--root', '--table', '--report', '--clauses', '--baseline', '--checks-module'];
const BOOL_FLAGS = ['--fail-on-obligation', '--update-baseline', '--init-baseline'];

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

function writeReport(report, dest, root, fallback) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (dest === '-') { process.stdout.write(json); return null; }
  const file = path.resolve(root, dest ?? fallback ?? (report.kind === 'check-report' ? 'check-report.json' : 'gate-report.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
  return file;
}

function changedPaths(a, root) {
  const { flags } = a;
  if (flags['--base'] || flags['--head']) {
    if (!flags['--base'] || !flags['--head']) throw new EngineError('E_USAGE', EXIT.USAGE, '--base and --head go together');
    for (const f of ['--base', '--head']) {
      if (flags[f].startsWith('-')) throw new EngineError('E_USAGE', EXIT.USAGE, `${f} must be a ref, not an option (got ${JSON.stringify(flags[f])})`);
    }
    return execFileSync('git', ['diff', '--name-only', flags['--base'], flags['--head'], '--'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  return a.changed.length ? a.changed : undefined;
}

/**
 * Engine errors share exit codes 64/65 with gate statuses, so each is also written as an
 * `engine-error` report to the report destination (never left as a stale earlier gate-report).
 */
export async function main(argv) {
  let a;
  try {
    a = parseArgs(argv);
    return await dispatch(a);
  } catch (err) {
    if (err instanceof EngineError) {
      // A usage error is thrown by parseArgs itself, before any flag map exists: recover the report destination
      // (--root, --report, the verb) leniently from argv so the stale-report guarantee covers it too (891dbac0 AC1).
      const { flags, positional } = a ?? scanDestination(argv);
      const root = path.resolve(flags['--root'] ?? process.cwd());
      const rep = { schema: 1, kind: 'engine-error', code: err.code, message: err.message, exit: err.exit, engineError: true, released: false };
      try {
        writeReport(rep, flags['--report'], root, positional[0] === 'check' ? 'check-report.json' : 'gate-report.json');
      } catch (werr) {
        process.stderr.write(`gate-engine: could not write the engine-error report (${werr.message})\n`);
      }
    }
    throw err;
  }
}

/**
 * Non-throwing scan of argv for the three things the engine-error report needs: --root, --report and the verb.
 * A destination always exists (the default is `<root>/gate-report.json` or `check-report.json`), so a usage error
 * with no `--report` still overwrites a stale default report. A value flag with a missing value is ignored.
 */
export function scanDestination(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (VALUE_FLAGS.includes(t)) {
      const v = argv[i + 1];
      if (v !== undefined && !(v.startsWith('--') && v !== '-')) { i++; if (t === '--root' || t === '--report') flags[t] = v; }
    } else if (!t.startsWith('--')) positional.push(t);
  }
  return { flags, positional };
}

async function dispatch(a) {
  const [verb, ...rest] = a.positional;
  const root = path.resolve(a.flags['--root'] ?? process.cwd());
  const tableFile = path.resolve(root, a.flags['--table'] ?? 'gates.table.json');
  if (verb === 'run') {
    const step = a.flags['--step'];
    if (!step) throw new EngineError('E_USAGE', EXIT.USAGE, `run requires --step\n${USAGE}`);
    const table = loadTable(tableFile);
    validateSelection(table, { step, changeClass: a.flags['--class'], rigor: a.flags['--rigor'] });
    const report = runGates(table, {
      step, changeClass: a.flags['--class'], rigor: a.flags['--rigor'], changed: changedPaths(a, root), root,
      failOnObligation: a.flags['--fail-on-obligation'] === true,
    }, {
      evidenceDir: a.flags['--report'] === '-' ? undefined : path.join(path.resolve(root, a.flags['--report'] ?? 'gate-report.json') + '.evidence'),
    });
    const file = writeReport(report, a.flags['--report'], root);
    for (const w of report.warnings) process.stderr.write(`gate-engine: warning: ${w}\n`);
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
    if (a.flags['--update-baseline'] && a.flags['--init-baseline']) throw new EngineError('E_USAGE', EXIT.USAGE, '--update-baseline and --init-baseline are mutually exclusive');
    if ((a.flags['--update-baseline'] || a.flags['--init-baseline']) && !baselineFile) throw new EngineError('E_USAGE', EXIT.USAGE, '--update-baseline and --init-baseline require --baseline');
    const findings = collectFindings(names, ctx);
    const report = reportFromFindings(names, findings, readBaseline(baselineFile));
    if (a.flags['--update-baseline']) {
      shrinkBaseline(baselineFile, findings);
      report.exit = 0;
    } else if (a.flags['--init-baseline']) {
      initBaseline(baselineFile, findings);
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
