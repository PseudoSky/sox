# Skill: di-skill

## Invocation guidance

**When to invoke:** di-skill extension

**Do NOT invoke when:**

<!-- Describe situations where this skill should NOT be used.
     Example: "Do not invoke this skill for tasks that require real-time data." -->

## Input contract

```typescript
interface SkillInput {
  input: string; // The text or data to process
}
```

## Output contract

```typescript
interface SkillOutput {
  result: string; // The processed output
}
```

## Examples

```json
{ "input": "example input" }
// → { "result": "Processed: example input" }
```

## Failure modes

<!-- Describe what the skill returns or throws when it cannot complete the task. -->

## Performance characteristics

<!-- Describe expected latency, token usage, or resource requirements. -->

## Skill id

`di-skill`