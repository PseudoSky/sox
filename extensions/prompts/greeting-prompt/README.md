# Greeting Prompt

> Use this when you need to generate a warm, context-aware greeting addressed to a named person.

## Overview

`greeting-prompt` is a parameterized prompt template that composes a short, professional greeting. It requires a `name` parameter and accepts an optional `context` parameter to adjust tone — for example, distinguishing a formal onboarding email from a casual morning standup message.

The template instructs the LLM to produce a 2–4 sentence greeting that addresses `{{name}}` directly, is warm and welcoming, and matches the formality implied by `{{context}}` (formal when context suggests a business setting, casual when informal).

## When to use

- When the host needs to open a conversation with a user-specific greeting without hardcoding the text.
- When different deployment contexts (onboarding, daily standups, support introductions) each require a different tone but share the same greeting shape.
- When you want a prompt scaffold to copy-paste for a new parameterized template.

Do NOT use this prompt for scenarios that require factual recall or dynamic data beyond a name and optional context string — it is a composition template, not a retrieval prompt.

## Parameters

| Parameter  | Type   | Required | Description                                                             |
| ---------- | ------ | -------- | ----------------------------------------------------------------------- |
| `name`     | string | yes      | The name of the person to greet                                         |
| `context`  | string | no       | Context for tone adjustment (e.g. "morning standup", "new user signup") |

## Example

```
name: Alex
context: first day of onboarding
```

Produces something like: "Welcome, Alex! We're thrilled to have you joining us for your first day — today we'll walk you through the essentials so you feel right at home. If you have any questions along the way, don't hesitate to ask."

## Usage

```bash
sox install greeting
```

## License

MIT
