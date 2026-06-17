# @sox/tokenguard-core

**Bijective pseudonymization engine** — pure TypeScript, zero network, provider-agnostic.

## What It Does

TokenGuard Core implements bijective (1:1, reversible) pseudonymization of sensitive identifiers in LLM request/response pairs. It:

- **Tokenizes** real values (hostnames, emails, IPs, etc.) into stable pseudo-tokens like `<HOST_1>`, `<EMAIL_2>`
- **Detokenizes** responses to restore the original values
- **Maps** bidirectionally: any real always maps to the same token; any token always maps back to the same real
- **Persists** the mapping as JSON (reload-stable — the same real always gets the same token across process restarts)
- **Detects** sensitive patterns (hostnames, FQDNs, IPv4/IPv6, MACs, emails, phone numbers via regex)
- **Handles SSE streams** where tokens split across delta boundaries in Anthropic-style streaming

## Public API

### Types

```typescript
export type MapEntry = { 
  token: string; 
  real: string; 
  type: string; 
  source: 'seed' | 'proxy' | 'tooling' | 'custom'; 
  created_ts: string 
};
export type TokenMap = { version: number; entries: MapEntry[] };
export type Source = 'seed' | 'proxy' | 'tooling' | 'custom';
export type IdType = string;
export interface DetectorConfig { detectPhone?: boolean; detectIpv6?: boolean };
```

### Mapper — Bijective Store

```typescript
export class Mapper {
  constructor(persistPath?: string);
  
  // Insert/read
  getOrCreate(real: string, type: string, source: Source): string;
  registerExplicit(real: string, type: string, token: string, source: Source): string;
  seed(items: Array<{ real?: string; type?: string; token?: string }>, source?: Source): void;
  
  // Access
  entries(): MapEntry[];
  tokenOf(real: string): string | undefined;
  realOf(token: string): string | undefined;
  typeFor(real: string): string;
  realsLongestFirst(): Array<[string, string]>;
  tokensLongestFirst(): Array<[string, string]>;
  
  // Persistence
  load(filePath: string): void;
  serialize(): TokenMap;
}
```

### Detectors — Pattern Recognition

```typescript
export function detectKnown(s: string, config?: DetectorConfig): HitMap;
export function detectEmail(s: string): HitMap;
export function detectFqdn(s: string): HitMap;
export function detectIpv4(s: string): HitMap;
export function detectIpv6(s: string): HitMap;
export function detectMac(s: string): HitMap;
export function detectPhone(s: string): HitMap;

export function tokenizeStr(
  s: string, 
  mapper: Mapper, 
  detectors?: (s: string) => HitMap
): string;
```

### Request/Response Tokenization

```typescript
export function tokenizeRequest(
  body: unknown, 
  mapper: Mapper, 
  config?: DetectorConfig
): unknown;

export function detokenizeText(
  text: string, 
  mapper: Mapper
): string;

export function detokenizeSse(
  raw: string, 
  reverse: (s: string) => string
): string;

export function wireLeaks(
  real: string[], 
  body: unknown, 
  config?: DetectorConfig
): { count: number; body: unknown };

export function identifierGroupVariants(
  label: string, 
  members: string[]
): string[];
```

## Usage Example

```typescript
import { Mapper, tokenizeRequest, detokenizeText, detectKnown } from '@sox/tokenguard-core';

// Create a mapper (optional persist path for reload-stable tokens)
const mapper = new Mapper('/tmp/tokens.json');

// Pre-seed some identifiers
mapper.seed([
  { real: 'prod.internal', type: 'host' },
  { real: 'alice@example.com', type: 'email' },
]);

// Tokenize a request body (auto-detects patterns + applies seeds)
const request = {
  system: 'Contact alice@example.com for help',
  messages: [{ role: 'user', content: 'Server is prod.internal' }],
};
const tokenized = tokenizeRequest(request, mapper);
// Result: system/messages have tokens; "alice@example.com" → "<EMAIL_1>", "prod.internal" → "<HOST_1>"

// Tokenize a plain string
const text = 'Error on 192.168.1.1';
const tokenizedText = tokenizeStr(text, mapper, detectKnown);
// Result: "Error on <IPV4_1>"

// Detokenize a response (restore the originals)
const response = 'Contact <EMAIL_1> or check <HOST_1>';
const restored = detokenizeText(response, mapper);
// Result: "Contact alice@example.com or check prod.internal"

// Check for leaked reals in a body (audit)
const { count, body: auditBody } = wireLeaks(
  ['alice@example.com', 'prod.internal'],
  response
);
// Returns leak count and the body for logging
```

## Design

- **No I/O**: All operations are synchronous; persistence is opt-in via constructor.
- **Idempotent**: The same `real` always returns the same token, even across process boundaries (if using `persistPath`).
- **Bijective**: Every real has exactly one token; every token maps back to exactly one real.
- **Type-tagged**: Tokens record their origin (e.g., `<EMAIL_2>` vs `<HOST_2>`), aiding audit and recall.
- **Provider-agnostic**: No HTTP, no API keys, no provider-specific logic — just pattern detection and string manipulation.

## Integration

Use with a **proxy service** (e.g., `tokenguard` sox extension) to transparently tokenize requests sent to any LLM provider and detokenize responses on the return path. The proxy selects the provider adapter (Anthropic vs. generic) and coordinates I/O; the core engine handles all string transformation.
