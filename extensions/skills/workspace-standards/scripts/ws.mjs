#!/usr/bin/env node
// 9024e9ac T14.AC3
// usage: ws.mjs <review|run|apply> <target|all> [--mode <name>] [--root <skill root>]
// stdout: one JSON object. Exit 0 = resolved; non-zero = a named error (see ERR in lib.mjs).
import { ERR, resolveVerb, SKILL_ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
};
const mode = opt('--mode');
const root = opt('--root') ?? SKILL_ROOT;
const [verb, target, ...rest] = args;
let result;
try {
  result = rest.length
    ? { ok: false, error: { ...ERR.USAGE, message: `unexpected argument "${rest[0]}"` } }
    : resolveVerb({ root, verb, target, mode });
} catch (err) {
  result = { ok: false, error: { code: 'E_INTERNAL', exit: 1, message: err.message } };
}
if (result.ok) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}
process.stderr.write(JSON.stringify(result) + '\n');
process.exit(result.error.exit);
