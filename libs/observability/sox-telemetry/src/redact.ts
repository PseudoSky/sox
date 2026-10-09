/**
 * redact.ts — c536ce29 L1: secret redaction for log channels (rules R1-R4).
 *
 *  - R1 header values, by (case-insensitive) header name, inside a `headers` object.
 *  - R2 key-shaped values (provider keys, bearer tokens, JWTs, private keys...) anywhere in text.
 *  - R3 secret-named object keys, string values >= 8 chars only (so `max_tokens: 4096` survives).
 *  - R4 exact-value scrub of registered secrets (>= 8 chars).
 *
 * Nothing here reads an environment variable. Nothing throws into the caller:
 * on an internal failure `redactLine` fails CLOSED with a fixed error record.
 */
import { createHash } from 'node:crypto';

/** What a rule sees for one string. `key`/`inHeaders` are set when the string is an object member. */
export interface RedactInput {
  /** The string to redact. */
  text: string;
  /** Object key the string was found under, if any. */
  key?: string | undefined;
  /** True when the key sits directly inside a `headers` object. */
  inHeaders?: boolean | undefined;
  /** Currently registered known secrets (each >= 8 chars). */
  secrets: readonly string[];
}

/** A redaction rule: returns the replacement text, or `undefined` when it does not apply. */
export interface RedactionRule {
  id: string;
  apply(input: RedactInput): string | undefined;
}

/** Redacts serialized lines and structured values. */
export interface Redactor {
  redactLine(serialized: string): string;
  redactValue<T>(v: T): T;
  registerSecret(value: string): void;
}

const MIN_SECRET_LEN = 8;
const MAX_DEPTH = 64;
const REDACT_ERROR_LINE = '{"event":"log.redact_error"}';

function marker(value: string): string {
  const h = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `[REDACTED:${h}:len=${value.length}]`;
}

const R1_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'openai-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-amz-security-token',
]);
const R1_HEADER_ALLOW: ReadonlySet<string> = new Set([
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'content-length',
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-organization',
  'openai-processing-ms',
]);
const R1_HEADER_PATTERN = /(key|secret|token|password|credential|session)/i;
const R3_KEY_PATTERN =
  /^(api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|password|authorization|credential|client[_-]?secret)$/i;

/** R2 patterns; order matters (specific before generic). Fresh regexes per call avoid `lastIndex` state. */
const R2_SOURCES: readonly string[] = [
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
  'sk-ant-[A-Za-z0-9_-]{16,}',
  'sk-or-v1-[A-Za-z0-9]{16,}',
  'sk-proj-[A-Za-z0-9_-]{16,}',
  'sk-[A-Za-z0-9]{20,}',
  'Bearer\\s+[A-Za-z0-9._~+/=-]{16,}',
  'AIza[0-9A-Za-z_-]{35}',
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
];

/** Default rules R1-R4 (R5/R6 are caller-side). */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  {
    id: 'R1-header',
    apply({ text, key, inHeaders }) {
      if (!inHeaders || key === undefined) return undefined;
      const name = key.toLowerCase();
      if (R1_HEADER_ALLOW.has(name)) return undefined;
      return R1_HEADER_NAMES.has(name) || R1_HEADER_PATTERN.test(name) ? marker(text) : undefined;
    },
  },
  {
    id: 'R2-key-shaped',
    apply({ text }) {
      let out = text;
      for (const src of R2_SOURCES) out = out.replace(new RegExp(src, 'g'), (m) => marker(m));
      return out === text ? undefined : out;
    },
  },
  {
    id: 'R3-json-key',
    apply({ text, key }) {
      if (key === undefined || text.length < MIN_SECRET_LEN) return undefined;
      return R3_KEY_PATTERN.test(key) ? marker(text) : undefined;
    },
  },
  {
    id: 'R4-known-secret',
    apply({ text, secrets }) {
      let out = text;
      for (const s of secrets) if (out.includes(s)) out = out.split(s).join(marker(s));
      return out === text ? undefined : out;
    },
  },
]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build a redactor applying DEFAULT_REDACTION_RULES (+ `extraRules`) to every
 * string it sees. `knownSecrets` (and later `registerSecret`) feed R4.
 */
export function createRedactor(opts?: {
  knownSecrets?: readonly string[];
  extraRules?: readonly RedactionRule[];
}): Redactor {
  const rules: readonly RedactionRule[] = [...DEFAULT_REDACTION_RULES, ...(opts?.extraRules ?? [])];
  const secrets = new Set<string>();
  /** Longest first so a secret containing another is scrubbed whole. */
  let ordered: readonly string[] = [];
  const reorder = (): void => {
    ordered = [...secrets].sort((a, b) => b.length - a.length);
  };
  const registerSecret = (value: string): void => {
    try {
      if (typeof value === 'string' && value.length >= MIN_SECRET_LEN && !secrets.has(value)) {
        secrets.add(value);
        reorder();
      }
    } catch {
      /* never throw */
    }
  };
  for (const s of opts?.knownSecrets ?? []) registerSecret(s);

  const scrubString = (text: string, key?: string, inHeaders?: boolean): string => {
    let cur = text;
    for (const rule of rules) {
      try {
        const out = rule.apply({ text: cur, key, inHeaders, secrets: ordered });
        if (typeof out === 'string') cur = out;
      } catch {
        /* a faulty rule is skipped; the remaining rules still run */
      }
    }
    return cur;
  };

  const walk = (v: unknown, key: string | undefined, inHeaders: boolean, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof v === 'string') return scrubString(v, key, inHeaders);
    if (typeof v !== 'object' || v === null) return v;
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (v instanceof Error) {
        return walk({ name: v.name, message: v.message, stack: v.stack }, key, false, depth + 1, seen);
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
      if (v instanceof Map) return walk([...v.entries()], key, false, depth + 1, seen);
      if (v instanceof Set) return walk([...v.values()], key, false, depth + 1, seen);
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        return walk((toJSON as () => unknown).call(v), key, inHeaders, depth + 1, seen);
      }
      if (Array.isArray(v)) {
        // Array members inherit the key (e.g. `set-cookie: [..]` under headers).
        return v.map((item) => walk(item, key, inHeaders, depth + 1, seen));
      }
      const out: Record<string, unknown> = {};
      const childInHeaders = key !== undefined && key.toLowerCase() === 'headers';
      for (const k of Object.keys(v)) {
        out[k] = walk((v as Record<string, unknown>)[k], k, childInHeaders, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(v); // only ancestors count as cycles; shared (DAG) references are fine
    }
  };

  const redactValue = <T>(v: T): T => {
    try {
      return walk(v, undefined, false, 0, new WeakSet()) as T;
    } catch {
      return '[REDACT_ERROR]' as unknown as T;
    }
  };

  const redactLine = (serialized: string): string => {
    try {
      if (typeof serialized !== 'string') return REDACT_ERROR_LINE;
      let line = serialized;
      try {
        const parsed: unknown = JSON.parse(serialized);
        if (isPlainRecord(parsed) || Array.isArray(parsed)) line = JSON.stringify(redactValue(parsed));
      } catch {
        /* not JSON: fall through to text scrubbing */
      }
      // Text pass catches anything the structural pass cannot see (non-JSON lines, escaped payloads).
      return scrubString(line);
    } catch {
      return REDACT_ERROR_LINE;
    }
  };

  return { redactLine, redactValue, registerSecret };
}

/** Test-only negative control: redacts nothing, proving canary scans have teeth. */
export const identityRedactor: Redactor = Object.freeze({
  redactLine: (serialized: string): string => serialized,
  redactValue: <T>(v: T): T => v,
  registerSecret: (): void => undefined,
});
