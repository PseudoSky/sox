// Test support (pure, no process, no network). Judges one `red:` record from an authoring unit
// (595965cc T22 AC4). Rule (test-author.md, Output): exit non-zero, and every failing test is an
// assertion or the stub's marker error. A structural failure (missing symbol, import error, compile or
// syntax error) anywhere in the run is not red.
// Judging is per failing test block: a block is classified by its first thrown-error header line
// (`<Class>[ [CODE]]: <message>` or node's `'test failed'`), never by free text in a message.
// Fixtures in ./fixtures are real `node --test` output (node v24.11.1).

/** The stub's marker: the error text the stub throws begins with this token (test-author.md, Output). */
export const STUB_MARKER_TOKEN = 'NOT_IMPLEMENTED';

const HEADER = /^\s*([A-Za-z]*Error)(?: \[([A-Z_]+)\])?: (.*)$/;
const TEST_FAILED = /^\s*'test failed'\s*$/;

/** @returns {'assertion' | 'marker' | 'structural' | null} verdict of one line; null when it is not an error header. */
export function classifyHeader(line) {
  if (TEST_FAILED.test(line)) return 'structural';
  const m = HEADER.exec(line);
  if (!m) return null;
  const [, cls, code, msg] = m;
  if (cls === 'AssertionError' || code === 'ERR_ASSERTION') return 'assertion';
  if (cls === 'Error' && msg.startsWith(STUB_MARKER_TOKEN)) return 'marker';
  if (code === 'ERR_MODULE_NOT_FOUND' || /^Cannot find module/.test(msg)) return 'structural';
  if (cls === 'SyntaxError' || cls === 'ReferenceError') return 'structural';
  if (cls === 'TypeError' && /is not a function$/.test(msg)) return 'structural';
  return null;
}

/** @returns {{ red: boolean, reason: string, verdicts: Array<string|null> }} verdicts: one per failing test block. */
export function judgeRedRecord({ exit, output }) {
  const code = Number(exit);
  if (!Number.isInteger(code) || code === 0) return { red: false, reason: 'exit is zero or not an integer', verdicts: [] };
  const text = String(output ?? '');
  const cut = text.search(/^test at /m);
  const preamble = cut < 0 ? text : text.slice(0, cut);
  const blocks = cut < 0 ? [] : text.slice(cut).split(/^(?=test at )/m);
  const verdicts = blocks.map((b) => b.split('\n').map(classifyHeader).find((v) => v !== null) ?? null);
  const preambleStructural = preamble.split('\n').some((l) => classifyHeader(l) === 'structural');
  if (preambleStructural || verdicts.includes('structural')) {
    return { red: false, reason: 'structural failure: missing symbol, import error, or compile/syntax error', verdicts };
  }
  if (blocks.length === 0 || verdicts.some((v) => v === null)) return { red: false, reason: 'no assertion or stub marker in a failing test block', verdicts };
  return { red: true, reason: 'assertion or stub marker error', verdicts };
}
