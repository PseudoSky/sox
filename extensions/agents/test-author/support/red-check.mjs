#!/usr/bin/env node
// 595965cc T23.AC8: the red-record check the dispatcher runs before it accepts a `red:` record.
// usage: red-check.mjs --exit <n> --output <file>
// Exit 0 when the record is red (every failing test is an assertion or a stub marker error); exit 1 with the
// reason otherwise; exit 64 on usage. Judging is judgeRedRecord (support/red-record.mjs); this file only reads args.
import fs from 'node:fs';
import { judgeRedRecord } from './red-record.mjs';

const args = process.argv.slice(2);
const at = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const exit = at('--exit');
const outputFile = at('--output');
if (exit === undefined || outputFile === undefined) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_USAGE', exit: 64, message: 'usage: red-check.mjs --exit <n> --output <file>' } }) + '\n');
  process.exit(64);
}
let output;
try {
  output = fs.readFileSync(outputFile, 'utf8');
} catch (err) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'E_IO', exit: 65, message: `cannot read --output ${outputFile}: ${err.code ?? err.message}` } }) + '\n');
  process.exit(65);
}
const verdict = judgeRedRecord({ exit, output });
process.stdout.write(JSON.stringify({ ok: verdict.red, ...verdict }, null, 2) + '\n');
process.exit(verdict.red ? 0 : 1);
