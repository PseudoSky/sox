# org-agent

> Use this when you need an agent that organises or retrieves memories scoped to a project or organisation.

## Overview

The librarian of the memory store. It files durable findings under the right provenance, keeps
the topic and tag vocabulary coherent, merges duplicates by invalidation, and retrieves what is
already known — with the episode each claim came from attached. It is a librarian, not a gate,
and not a repair crew: it never deletes a memory and never doctors the store.

## When to use

Delegate to `org-agent` when knowledge has to move in or out of the memory store rather than be
reasoned about:

- a durable, generalized finding must be recorded so it is recallable later
- a question is likely already answered by prior episodes and must be recalled first
- a topic or tag vocabulary has drifted and the store needs curation

## Capabilities

- Recalls before writing (`memory_recall`, `memory_search_entities`) and files one episode per
  finding with `project_path` set explicitly to the calling workspace.
- Curates via invalidation only (`memory_invalidate`, `memory_curate`), preserving the
  supersession trail.
- Reads files, globs, greps, and runs commands via Bash.
- No external network calls.

## Inputs

A task description naming the project or topic, the finding to record (or the question to
recall), and the evidence the finding rests on.

## Outputs

Filed episode uids, or recalled claims each carrying its source episode. A finding with no
citation — no file, line, or episode it can point at — is not filed.

## Formatter

Source authored for the **cross-platform IR**. Agent config lives in `extension.json`
(`agent` + `render`); the entrypoint `org-agent.md` is prose only and carries no frontmatter —
the host header is generated at install time.

The extension **id** is `memory-org`, not `org-agent`: a manifest id may not end in its type
name (`libs/manifest/src/index.ts`), and `agent` is this extension's type. The agent's **name**
(`org-agent`) is what the directory and the entrypoint basename carry, and the deployed
artifact is therefore `<id>.md` — `memory-org.md` — declaring `name: org-agent`.

## Usage

```bash
soxe install memory-org --host claude --scope user
soxe install memory-org --host opencode --scope user
```

## License

MIT
