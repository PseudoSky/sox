// 39a21823 T48.AC1 T48.AC3 T48.AC4 T48.AC6
// Dependency-free managed-block engine (decisions/reuse-decision.md: build, do not add markdown-magic).
// A block is the text between `<!-- workspace-standards:<target>:begin -->` and `...:end -->`.
// Parameterized by target name so every apply verb (testing now, routing and gates next) shares it.
// Pure functions over strings; nothing here reads or writes a file.

const TARGET = /^[a-z][a-z0-9-]*$/;

export class MarkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkerError';
    this.code = code;
  }
}

function checkTarget(target) {
  if (typeof target !== 'string' || !TARGET.test(target)) {
    throw new MarkerError('E_TARGET', `marker target must match ${TARGET}; got ${JSON.stringify(target)}`);
  }
}

export const beginMarker = (target) => (checkTarget(target), `<!-- workspace-standards:${target}:begin -->`);
export const endMarker = (target) => (checkTarget(target), `<!-- workspace-standards:${target}:end -->`);

const countOf = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/**
 * Locate the one marker pair for `target`.
 * Returns { found:false } when neither marker exists; { found:true, start, end, body } otherwise, where
 * start/end delimit the whole block (markers included) and body is the text between the marker lines.
 * An unpaired, duplicated, or reversed marker is a MarkerError: the engine refuses to guess.
 */
export function inspectBlock(text, target) {
  const b = beginMarker(target);
  const e = endMarker(target);
  const nb = countOf(text, b);
  const ne = countOf(text, e);
  if (nb === 0 && ne === 0) return { found: false };
  if (nb !== 1 || ne !== 1) {
    throw new MarkerError('E_MARKERS', `expected exactly one ${b} and one ${e}; found ${nb} begin and ${ne} end`);
  }
  const start = text.indexOf(b);
  const endAt = text.indexOf(e);
  if (endAt < start) throw new MarkerError('E_MARKERS', `${e} appears before ${b}`);
  const end = endAt + e.length;
  const inner = text.slice(start + b.length, endAt);
  return { found: true, start, end, body: inner.replace(/^\n/, '').replace(/\n$/, '') };
}

/** The full block text for a body. */
export const renderBlock = (target, body) => `${beginMarker(target)}\n${body.replace(/\n+$/, '')}\n${endMarker(target)}`;

/**
 * Bring the block for `target` to `body`.
 *   action 'unchanged'  block present and equal; text returned byte-identical
 *   action 'replaced'   block present; between-marker text replaced (only the block moves)
 *   action 'created'    pair absent; appended after a blank line (or the whole text, when empty)
 *   action 'drift'      block present and different, and force is false: text returned unchanged,
 *                       `current` and `rendered` carry both sides so the caller can show the diff
 * Nothing outside the markers is ever modified.
 */
export function upsertBlock(text, target, body, { force = false } = {}) {
  const rendered = renderBlock(target, body);
  const at = inspectBlock(text, target);
  if (!at.found) {
    const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { action: 'created', text: `${text}${sep}${rendered}\n`, current: null, rendered };
  }
  const current = text.slice(at.start, at.end);
  if (current === rendered) return { action: 'unchanged', text, current, rendered };
  if (!force) return { action: 'drift', text, current, rendered };
  return { action: 'replaced', text: text.slice(0, at.start) + rendered + text.slice(at.end), current, rendered };
}

/** Line diff (LCS) of two texts as `-`/`+`/` ` prefixed lines under ---/+++ headers; '' when equal. */
export function unifiedDiff(label, before, after) {
  if (before === after) return '';
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push(`+${b[j]}`); j++; }
    else { out.push(`-${a[i]}`); i++; }
  }
  return `${out.join('\n')}\n`;
}
