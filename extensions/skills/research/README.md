# research

A research skill that carries the core process of the `researcher` agent — but **domain-neutral and
expansion-first** — and adds four things:

1. **A playbook router** — seven playbooks that together cover every research domain observed in
   the 553-question corpus, each with a routing trigger and an answer-category output contract.
2. **A structured sub-researcher prompt** — the parent fills one template per playbook and
   dispatches it, so many domains are covered in parallel with the *minimum* number of
   sub-researchers (one per playbook actually needed; single-playbook questions run inline).
3. **A memory resolution loop** — before any external search, each generated question is checked
   against memory; if memory already resolves it, the question is *revised deeper* and checked
   again, at most twice, so prior knowledge is extended instead of re-researched.
4. **Hardened verification** — `scripts/verify-research-run.mjs` proves the process ran from
   disk artifacts, a memory read-back, and a recorded tool manifest — never from a self-report.

## Layout

```
SKILL.md                              # the process (phases 0-7)
references/routing-table.md           # domain x specialty -> playbook
references/sub-researcher-prompt.md   # the structured prompt the parent fills
references/verification.md            # evidence contract the verifier enforces
references/corpus-evidence.md         # why these 7 playbooks (corpus + agent aggregation)
references/playbooks/*.md             # 7 playbooks
scripts/verify-research-run.mjs       # the hardened verifier (exit 1 on any gap)
```

## Capability-referenced (ADR-0026)

No body here names a tool. Each phase states the *need* (`search`, `memory`, `code-intel`,
`backlog`); the project's `## Capabilities` section binds each need to the tool that serves it.
