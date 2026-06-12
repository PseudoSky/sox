# Skill: Hello World

## Invocation guidance

**When to invoke:** Use this skill when you need the simplest possible working skill to verify that the extension scaffold wires correctly — it processes a text input and returns it prefixed with `"Processed: "`.

**Do NOT invoke when:**
- You need any actual computation, transformation, or analysis — this skill is a scaffold reference, not a functional processor.
- You want a production-ready text transformation — copy and adapt this scaffold for your real use case instead.

## Input contract

```typescript
interface SkillInput {
  input: string; // Any text string to process
}
```

## Output contract

```typescript
interface SkillOutput {
  result: string; // Always "Processed: " + input
}
```

## Examples

```json
{ "input": "hello" }
// → { "result": "Processed: hello" }
```

```json
{ "input": "test payload 123" }
// → { "result": "Processed: test payload 123" }
```

## Failure modes

This skill does not throw — it always returns successfully. If `input` is an empty string the result is `"Processed: "`.

## Performance characteristics

- Latency: synchronous, sub-millisecond (no I/O, no LLM calls).
- Token usage: zero (deterministic).
- Memory: negligible.

## Skill id

`hello-world`
