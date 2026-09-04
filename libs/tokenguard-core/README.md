# @adhd/sox-tokenguard-core

Bijective (1:1, reversible) pseudonymization for text and LLM request/response bodies — pure
TypeScript, synchronous, zero network calls, zero provider-specific logic. It detects sensitive
identifiers (hostnames, FQDNs, IPv4/IPv6, MAC addresses, emails, phone numbers), replaces each with
a stable pseudo-token like `<HOST_1>` or `<EMAIL_2>`, and reverses the substitution later — the
same real value always maps to the same token, and the same token always maps back to the same
real value, including across process restarts if you give it a persist path.

```bash
pnpm add @adhd/sox-tokenguard-core
```

## Quick start

```typescript
import { Mapper, tokenizeStr, detokenizeText } from '@adhd/sox-tokenguard-core';

// persistPath is optional — pass one to make tokens reload-stable across restarts
const mapper = new Mapper('/tmp/tokens.json');

const text = 'Contact admin@prod.internal about 10.0.0.5';
const tokenized = tokenizeStr(text, mapper, null);
console.log(tokenized);
// "Contact <EMAIL_1> about <IP_1>"

const restored = detokenizeText(tokenized, mapper, null);
console.log(restored);
// "Contact admin@prod.internal about 10.0.0.5" — exact round-trip
```

## API reference

### `Mapper` — the bijective store

```typescript
class Mapper {
  constructor(persistPath?: string);

  // Insert / read
  getOrCreate(real: string, type: string, source: Source): string;
  registerExplicit(real: string, type: string, token: string, source: Source): string;
  seed(items: ReadonlyArray<{ real?: string; type?: string; token?: string }>, source?: Source): void;

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

  // Per-instance do-not-tokenize set (lower-cased)
  readonly never: Set<string>;
}
```

`getOrCreate` is idempotent: calling it again with the same `real` returns the existing token
unchanged, and the original `source`/`type` are never overwritten by a later call. Passing a
`persistPath` to the constructor makes every mutation durable — reopen the same path later and
the same reals still map to the same tokens, with per-type token counters continuing from where
they left off (IDs are never reassigned).

### Types

```typescript
type Source = 'seed' | 'proxy' | 'tooling' | 'custom';
type IdType = 'host' | 'fqdn' | 'ip' | 'ip6' | 'mac' | 'email' | 'phone' | 'id' | string;

interface MapEntry {
  token: string;
  real: string;
  type: IdType;
  source: Source;
  created_ts: string;
}

interface TokenMap {
  version: 2;
  entries: MapEntry[];
}

interface DetectorConfig {
  detectPhone?: boolean;
  detectIpv6?: boolean;
}
```

### Detectors — pattern recognition

Each detector runs a single regex family over a string, tokenizing every match it finds via the
supplied `Mapper`, and returns the resulting string. `hits` is an optional counter map (pass `null`
if you don't need it) that detectors increment per match — useful for auditing how many
substitutions a call made.

```typescript
type HitMap = Map<string, number>;

function detectEmail(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectFqdn(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectIpv4(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectIpv6(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectMac(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectPhone(s: string, mapper: Mapper, hits?: HitMap | null): string;
function detectKnown(s: string, mapper: Mapper, hits?: HitMap | null): string;

// Runs the full ordered pipeline: known reals → email → fqdn → ipv6 → ipv4 → mac → phone.
// dynamicIp (default true) gates the auto-detectors; known reals are always applied regardless.
function tokenizeStr(
  s: string,
  mapper: Mapper,
  hits?: HitMap | null,
  dynamicIp?: boolean,
  config?: DetectorConfig,
): string;
```

```typescript
import { Mapper, detectEmail, detectFqdn } from '@adhd/sox-tokenguard-core';

const mapper = new Mapper();
detectEmail('Contact admin@target.internal', mapper, null);
// "Contact <EMAIL_1>"
detectFqdn('Server is webapp.internal.corp', mapper, null);
// "Server is <HOST_1>" — FQDNs are tokenized under the "host" type, not a separate "FQDN_n" series
```

`detectPhone` and `detectIpv6` run as part of the full pipeline by default — pass
`{ detectPhone: false }` / `{ detectIpv6: false }` as the `config` argument to `tokenizeStr` to
turn either one off (e.g. if plain integers or version-like strings in your text are getting
matched as phone numbers).

### Request / response tokenization

```typescript
function walkTokenize(obj: unknown, mapper: Mapper, hits?: HitMap | null, dynamicIp?: boolean, config?: DetectorConfig): unknown;

function tokenizeRequest(req: unknown, mapper: Mapper, hits?: HitMap | null, config?: DetectorConfig): unknown;

function wireLeaks(req: unknown, mapper: Mapper): string[];

function detokenizeText(text: string, mapper: Mapper, hits?: HitMap | null): string;
```

`tokenizeRequest` is shaped for an Anthropic Messages-style request body: it tokenizes `system`,
`messages`, and other data-bearing fields in two passes (a full detector pass, then a known-reals-only
pass to catch anything the first pass's dynamic detection newly added), while leaving `tools` — a
JSON-Schema block — completely verbatim, so the API still receives a valid schema.

`wireLeaks` scans the same scoped regions (`system`/`messages`/`metadata`, never `tools`) for any
`real` already known to the `Mapper` that still appears un-tokenized, and returns the list of
leaked reals — an empty array means the tokenization pass caught everything mapped.

```typescript
import { Mapper, tokenizeRequest, wireLeaks, detokenizeText } from '@adhd/sox-tokenguard-core';

const mapper = new Mapper();
const request = {
  system: 'You are assessing prod.internal.',
  messages: [{ role: 'user', content: 'Contact admin@prod.internal for access.' }],
  metadata: {},
  tools: [{ name: 'bash', description: 'run a shell command', input_schema: { type: 'object', properties: {} } }],
};

const tokenized = tokenizeRequest(request, mapper, null) as typeof request;
console.log(tokenized.system);
// "You are assessing <HOST_1>."

const leaks = wireLeaks(tokenized, mapper);
console.log(leaks);
// [] — nothing mapped survived in system/messages/metadata

const restoredSystem = detokenizeText(tokenized.system, mapper, null);
console.log(restoredSystem);
// "You are assessing prod.internal."
```

### SSE stream detokenization

A token like `<HOST_1>` can be split across two consecutive `content_block_delta` events in an
Anthropic-style stream (e.g. `<HOS` in one delta, `T_1>` in the next), so flat replacement on the
raw bytes misses it. This module reassembles each content block's full value across its deltas
before detokenizing, then re-emits it as a single delta — everything else (including `thinking`
blocks, which are signed and must never be mutated) passes through byte-identical.

```typescript
function detokenizeSse(raw: string, reverse: (s: string) => string): string;
function detokenizeSseWithMapper(raw: string, mapper: Mapper, hits?: HitMap | null): string;
```

```typescript
import { Mapper, detokenizeSseWithMapper } from '@adhd/sox-tokenguard-core';

const mapper = new Mapper();
mapper.getOrCreate('vulntarget.internal', 'host', 'seed'); // → <HOST_1>

// The token is split across two content_block_delta events for the same block
// index ("<HOS" then "T_1>"); reassembly + detokenization happens once the
// matching content_block_stop event is seen.
const rawSseBody =
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Target is <HOS"}}\n\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"T_1>"}}\n\n' +
  'event: content_block_stop\n' +
  'data: {"type":"content_block_stop","index":0}\n\n';

const restored = detokenizeSseWithMapper(rawSseBody, mapper, null);
console.log(restored);
// event: content_block_delta
// data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Target is vulntarget.internal"}}
//
// event: content_block_stop
// data: {"type":"content_block_stop","index":0}
```

`detokenizeSse` is the same operation with the reversal function supplied directly, decoupling the
module from a concrete `Mapper` — pass `(s) => detokenizeText(s, mapper, null)` if you don't want
to construct `detokenizeSseWithMapper`'s dependency directly.

### Identifier group variants

```typescript
function identifierGroupVariants(label: string, members: string[]): string[];
```

Given a label and a set of associated hostnames/names, derives the specific (length ≥ 4,
non-generic) DNS components worth treating as related identifiers — dropping generic components
like `www`, `api`, or bare TLDs:

```typescript
import { identifierGroupVariants } from '@adhd/sox-tokenguard-core';

identifierGroupVariants('webapp', ['webapp-prod.internal.corp', 'www.internal.corp']);
// ["webapp", "webapp-prod"]
```

## Seeding known identifiers

`Mapper.seed` pre-registers a batch of reals (optionally with explicit tokens) before any
detection runs — useful for guaranteeing a fixed identifier always gets the same token from the
first request, rather than whichever one happens to be seen first:

```typescript
const mapper = new Mapper();
mapper.seed([
  { real: 'prod.internal', type: 'host' },
  { real: 'alice@example.com', type: 'email' },
]);

mapper.tokenOf('prod.internal'); // "<HOST_1>"
```

An explicit `token` in a seed item is only honored when `source: 'custom'`; otherwise the token is
allocated the normal way. After explicit items are seeded, `seed` also derives and seeds
identifier-group variants (via `identifierGroupVariants`) from any label-typed entries.

## Design

- **No I/O in the hot path** — every function above is synchronous; the only I/O is the optional
  `Mapper` persist file, written on each mutation and read via `load()`.
- **Bijective** — every real has exactly one token; every token maps back to exactly one real. A
  `Mapper` that never saw a given token cannot reverse it (there's no global registry).
- **Reload-stable** — construct a `Mapper` with the same `persistPath` in a later process and the
  same reals still resolve to the same tokens; token counters resume rather than restart.
- **Type-tagged** — every entry records its `type` (`host`, `email`, `ip`, …) and `source`
  (`seed`/`proxy`/`tooling`/`custom`), so a persisted map is self-describing for audit.
- **Provider-agnostic core** — this package has no HTTP client, no API keys, and no
  provider-specific parsing; `tokenizeRequest`'s field scoping matches the Anthropic Messages API
  shape, but every function operates on plain strings and parsed JSON values you hand it.
