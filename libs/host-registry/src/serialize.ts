/**
 * libs/host-registry/src/serialize.ts
 *
 * Minimal-but-correct YAML emitter for agent frontmatter, plus a frontmatter
 * stripper. [def:agent-renderer] support — see the spec
 * docs/spec/cross-platform-install-rendering.md §5.2 "Serialization mandate":
 * header assembly must not hand-concatenate strings that corrupt on `:` /
 * newline / leading-special chars. This is a real serializer for the constrained
 * shapes agents emit (scalars, string arrays, nested string maps) — NOT a general
 * YAML implementation, and it is not intended for arbitrary documents.
 *
 * No external dependency (js-yaml / yaml are not workspace deps) — this is the
 * equivalent minimal emitter, unit-tested against adversarial strings.
 */

/** Quote a YAML scalar string iff it is not a safe plain scalar. */
export function yamlScalar(v: string): string {
  const needsQuote =
    /[\n\r\t]/.test(v) || // embedded control/newline — invalid in a plain scalar
    /^[\s\-?:,!&*#|>%@`"'[\]{}]/.test(v) || // leading structural char
    /[\s]$/.test(v) || // trailing whitespace
    /:\s|\s#/.test(v) || // ": " or " #" — would terminate a plain scalar
    /^(true|false|null|~|yes|no|on|off)$/i.test(v) || // ambiguous literal
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) || // number lookalike
    /^0x[0-9a-fA-F]+$/.test(v);
  if (needsQuote) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
}

/** Quote a YAML map key iff it is not a plain identifier. */
export function yamlKey(k: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return k;
  return `'${k.replace(/'/g, "''")}'`;
}

/** Stringify a scalar / array / nested-string-map to YAML (block, 2-space indent). */
export function yamlStringify(obj: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  if (Array.isArray(obj)) {
    // Flow-style array of scalars (e.g. tools).
    return '[' + obj.map((v) => yamlScalar(String(v))).join(', ') + ']';
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = yamlKey(k);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        lines.push(`${pad}${key}:`);
        lines.push(yamlStringify(v, indent + 2));
      } else if (Array.isArray(v)) {
        lines.push(
          `${pad}${key}: [${(v as unknown[]).map((x) => yamlScalar(String(x))).join(', ')}]`,
        );
      } else if (typeof v === 'string') {
        lines.push(`${pad}${key}: ${yamlScalar(v)}`);
      } else {
        // number | boolean | null | undefined — emit literal, never quoted
        lines.push(`${pad}${key}: ${v === null ? 'null' : String(v)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Strip a leading YAML frontmatter fence (`---\n…\n---\n`) from a markdown body.
 * Returns the prose body. If there is no frontmatter, returns the input unchanged.
 */
export function stripFrontmatter(md: string): string {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(md);
  if (m && m.index === 0) return md.slice(m[0].length);
  return md;
}
