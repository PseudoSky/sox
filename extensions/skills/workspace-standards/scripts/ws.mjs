#!/usr/bin/env node
// 9024e9ac T14.AC3
// usage: ws.mjs <review|run|apply> <target|all> [--mode <name>] [--root <skill root>]
// stdout: one JSON object. Exit 0 = resolved; non-zero = a named error (see ERR in lib.mjs).
import { ERR, resolveVerb, SKILL_ROOT, takeOption } from './lib.mjs';

const args = process.argv.slice(2);
const modeOpt = takeOption(args, '--mode');
const rootOpt = takeOption(args, '--root');
const mode = modeOpt.value;
const root = rootOpt.value ?? SKILL_ROOT;
const usageError = modeOpt.error ?? rootOpt.error;
const [verb, target, ...rest] = args;
let result;
try {
  result = usageError
    ? { ok: false, error: { ...ERR.USAGE, message: usageError } }
    : rest.length
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
