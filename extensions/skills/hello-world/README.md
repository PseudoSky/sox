# Hello World

> Use this when you need a minimal working skill to verify the extension scaffold or test a new host integration.

## Overview

`hello-world` is the canonical reference skill in the sox-ecosystem. It takes a text string as input and returns it prefixed with `"Processed: "`. It does nothing clever — that is the point. It serves as a known-good baseline when you are standing up a new host, writing integration tests, or verifying that the skill extension type wires correctly through the runtime.

## When to use

- When you need the simplest possible skill to smoke-test a host integration.
- When you are writing a test that needs a real skill extension installed but does not care what the skill computes.
- When you want a scaffold template to copy-paste and adapt for a new skill.

Do NOT use this skill in production flows — it applies no meaningful transformation to its input.

## Inputs

| Field   | Type   | Required | Description                   |
| ------- | ------ | -------- | ----------------------------- |
| `input` | string | yes      | The text string to process    |

## Outputs

| Field    | Type   | Description                                    |
| -------- | ------ | ---------------------------------------------- |
| `result` | string | The input prefixed with `"Processed: "`        |

## Example

```typescript
import { run } from './dist/index.js';
const out = await run({ input: 'hello' });
// out.result === "Processed: hello"
```

## Usage

```bash
sox install hello-world
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

The evaluation golden test lives in `eval/golden.test.ts`.

## License

MIT
