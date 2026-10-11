// Test support (pure, no process, no network): judges one `red:` record from an authoring unit.
// The rule is the agent's own output contract (test-author.md, Output): exit non-zero, and the
// failure is an assertion or the stub's marker error. A missing symbol, import error, or
// compile/syntax error is not red. Fixtures in ./fixtures are real `node --test` output (node v24.11.1).

export const STUB_MARKER = /\bNOT_IMPLEMENTED\b/;
export const ASSERTION = /AssertionError|ERR_ASSERTION/;
export const STRUCTURAL = /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export|is not defined|is not a function|Cannot find module|'test failed'/;

/** @returns {{ red: boolean, reason: string }} */
export function judgeRedRecord({ exit, output }) {
  const code = Number(exit);
  if (!Number.isInteger(code) || code === 0) return { red: false, reason: 'exit is zero or not an integer' };
  if (STRUCTURAL.test(output)) return { red: false, reason: 'structural failure: missing symbol, import error, or compile/syntax error' };
  if (STUB_MARKER.test(output) || ASSERTION.test(output)) return { red: true, reason: 'assertion or stub marker error' };
  return { red: false, reason: 'no assertion or stub marker in output' };
}
