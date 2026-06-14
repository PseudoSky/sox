/**
 * context-parse.js — shared Layer-1 parsing primitives for the
 * plan-state-machine skill.
 *
 * Factored out of gap-check.js / extract-training-record.js so the task
 * compiler (compile-task.js) parses contexts, references, and audit scripts
 * with EXACTLY the same conventions the validator and training extractor use.
 * If these agree, the compiler's work-order cannot drift from what gap-check
 * enforces or what the training record captured.
 *
 * Node-stdlib-free, pure, ESM. No I/O — callers pass already-read text.
 *
 * Conventions (must match gap-check.js):
 *   - Reservations block: a fenced block after `## Reservations`, with
 *     `read_only:` / `mutates:` keys holding quoted path literals.
 *   - Criterion IDs: `[<slug>.<token>]` tokens; an audit `check("slug.n", ...)`
 *     call (or a bare `[slug.n]`) is the matching audit ID.
 *   - Reference citations: `[ref:<slug>]` tokens select entries from
 *     references.json (a FLAT slug-keyed object).
 */

/** Strip a leading "./" so paths compare equal to declared ones. */
export function normPath(p) {
  return String(p).replace(/^\.\//, "").trim();
}

/**
 * Extract the quoted file list for a named key (`read_only` | `mutates`)
 * inside the `## Reservations` fenced block. Returns an array of paths, or []
 * when the block or key is absent/unparseable. Mirrors gap-check.js's
 * parseReservationKey but never returns null (compiler degrades to []).
 */
export function parseReservationKey(mdText, key) {
  if (!mdText) return [];
  const resHeading = mdText.search(/^##\s+Reservations\s*$/m);
  if (resHeading === -1) return [];
  const after = mdText.slice(resHeading);
  const fence = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) return [];
  const block = fence[1];
  const kRe = new RegExp(`(^|\\n)\\s*${key}\\s*:`);
  const kIdx = block.search(kRe);
  if (kIdx === -1) return [];
  let tail = block.slice(kIdx).replace(kRe, "");
  const stop = tail.search(/\n\s*(read_only\s*:|mutates\s*:|\*\*)/);
  if (stop !== -1) tail = tail.slice(0, stop);
  const files = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(tail)) !== null) files.push(normPath(m[1]));
  return files;
}

/**
 * Return the body text of a `## <heading>` section, cut at the next top-level
 * `## ` heading (or end of file). Returns "" when the heading is absent.
 * Heading match is case-insensitive on the words but anchored to a line.
 */
export function sectionBody(mdText, heading) {
  if (!mdText) return "";
  const re = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, "im");
  const idx = mdText.search(re);
  if (idx === -1) return "";
  let body = mdText.slice(idx).replace(re, "");
  const next = body.search(/\n##\s+/);
  if (next !== -1) body = body.slice(0, next);
  return body.trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull a single bullet's value out of a `## Semantic Distillation` block by
 * its bold label (e.g. "Delta Spec", "Invariants"). The work-state template
 * shapes these as `- **<Label>:** <text...>` possibly spanning wrapped lines
 * up to the next `- **` bullet. Returns the trimmed value or "" when absent.
 */
export function distillationField(mdText, label) {
  const body = sectionBody(mdText, "Semantic Distillation");
  if (!body) return "";
  const re = new RegExp(`-\\s*\\*\\*${escapeRe(label)}:?\\*\\*\\s*`, "i");
  const idx = body.search(re);
  if (idx === -1) return "";
  let tail = body.slice(idx).replace(re, "");
  // Cut at the next `- **` bullet (start of the next distillation field).
  const stop = tail.search(/\n\s*-\s*\*\*/);
  if (stop !== -1) tail = tail.slice(0, stop);
  return collapseWs(tail);
}

/** Collapse internal whitespace/newlines to single spaces; trim. */
export function collapseWs(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * Parse `## Acceptance criteria` into { id, text } entries. Same regex shape
 * gap-check.js (collectCriterionIds) and extract-training-record.js use, so
 * the three agree on what an acceptance criterion is. The text strips a
 * leading `**[id]**` / `[id]` and surrounding checkbox markup.
 */
export function parseAcceptanceCriteria(mdText) {
  const body = sectionBody(mdText, "Acceptance criteria");
  if (!body) return [];
  const out = [];
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]\s*\**\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({ id: m[1], text: collapseWs(m[2].replace(/^\**/, "")) });
  }
  return out;
}

/** Collect [ref:<slug>] citations from a context file. */
export function parseRefCitations(mdText) {
  const refs = new Set();
  if (!mdText) return [];
  const re = /\[ref:([a-z0-9-]+)\]/g;
  let m;
  while ((m = re.exec(mdText)) !== null) refs.add(m[1]);
  return [...refs];
}

/** Collect criterion IDs [<slug>.<token>] from arbitrary text. */
export function collectCriterionIds(text) {
  const ids = new Set();
  if (!text) return ids;
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/**
 * Extract the audit check whose ID matches `criterionId` from an audit script,
 * returning the command string passed as the third argument of the matching
 * `check("<id>", "<desc>", "<cmd>", ...)` call — or null if not found.
 *
 * Python `check()` calls span multiple lines and use triple-quoted strings, so
 * a naive single-line regex is insufficient. We locate the call by ID, then
 * scan the balanced argument list and pull the third string literal (the cmd).
 * Best-effort: when the third arg is a complex expression we return the raw
 * source slice so the executor still sees the verbatim check.
 */
export function extractAuditCommand(scriptText, criterionId) {
  if (!scriptText) return null;
  const idEsc = escapeRe(criterionId);
  // Find `check( "<id>"` or `check( '<id>'` allowing whitespace/newlines.
  const callRe = new RegExp(`check\\(\\s*["']${idEsc}["']`, "g");
  const m = callRe.exec(scriptText);
  if (!m) return null;
  // Slice from the opening paren and walk to the matching close paren,
  // tracking string state so parens inside strings don't fool the balance.
  const open = scriptText.indexOf("(", m.index);
  if (open === -1) return null;
  const argsRaw = balancedSlice(scriptText, open);
  if (argsRaw === null) return null;
  const args = splitTopLevelArgs(argsRaw);
  // args[0] = id, args[1] = description, args[2] = command.
  if (args.length < 3) return null;
  const cmd = stringLiteralValue(args[2]);
  return cmd !== null ? cmd : args[2].trim();
}

/**
 * Given source and the index of an opening "(", return the inner substring up
 * to (excluding) the matching ")". Respects single/double/triple quotes so
 * parens inside string literals are ignored. Returns null if unbalanced.
 */
function balancedSlice(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null; // active quote delimiter: ', ", ''' or """
  const start = openIdx + 1;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (src.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
        continue;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Not inside a string: detect a quote opening (prefer triple quotes).
    if (src.startsWith('"""', i)) {
      quote = '"""';
      i += 3;
      continue;
    }
    if (src.startsWith("'''", i)) {
      quote = "'''";
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i);
    }
    i += 1;
  }
  return null;
}

/** Split a Python-ish argument list on top-level commas (string-aware). */
function splitTopLevelArgs(argsRaw) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  let i = 0;
  while (i < argsRaw.length) {
    const ch = argsRaw[i];
    if (quote) {
      cur += ch;
      if (argsRaw.startsWith(quote, i) && ch === quote[0]) {
        // Confirm full delimiter (handles triple quotes).
        if (argsRaw.startsWith(quote, i)) {
          cur += quote.slice(1);
          i += quote.length;
          quote = null;
          continue;
        }
      }
      if (ch === "\\") {
        cur += argsRaw[i + 1] ?? "";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (argsRaw.startsWith('"""', i) || argsRaw.startsWith("'''", i)) {
      quote = argsRaw.slice(i, i + 3);
      cur += quote;
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") args.push(cur);
  return args;
}

/**
 * If `expr` is a single string literal (single, double, or triple quoted),
 * return its decoded value; otherwise null (it is an expression / concat).
 */
function stringLiteralValue(expr) {
  const s = expr.trim();
  for (const q of ['"""', "'''"]) {
    if (s.startsWith(q) && s.endsWith(q) && s.length >= q.length * 2) {
      return s.slice(q.length, s.length - q.length);
    }
  }
  for (const q of ['"', "'"]) {
    if (s.startsWith(q) && s.endsWith(q) && s.length >= 2) {
      return s.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }
  }
  return null;
}
