---
id: greeting-prompt
version: 0.1.0
description: A parameterized greeting prompt that addresses users by name and context
parameters:
  - name: name
    type: string
    required: true
    description: The name of the person to greet
  - name: context
    type: string
    required: false
    description: Optional context about the greeting situation (e.g. morning standup, onboarding)
---

# Greeting Prompt

Welcome {{name}}! This prompt generates a warm, context-aware greeting tailored to the situation.

## Instructions

Please compose a friendly and professional greeting for **{{name}}**.

{{#if context}}
Take the following context into account when crafting the greeting: {{context}}
{{/if}}

The greeting should:
- Be warm and welcoming
- Address {{name}} directly by name
- Be concise (2–4 sentences)
- Match the tone implied by the context (formal for business settings, casual for informal ones)
