# Hand-off prompt — `swarm-cost` hook

| | |
|---|---|
| **Source** | `~/dev/ai/claude-agents/tools/hooks/swarm-cost` |
| **Target type** | `hook` |
| **Proposed id** | `swarm-cost` |
| **Status** | drafted — source not yet read by prompt author; executing agent must read it |

> Design note: this prompt is written for a coding agent with filesystem access to **both**
> the source repo and `/Users/nix/dev/ai/sox-ecosystem`. It deliberately points the agent at
> in-repo ground truth instead of asserting contract details from memory, and requires
> reality-verification of the full lifecycle rather than trusting unit tests.

---

```text
You are building a new extension for the "sox-ecosystem" project — an LLM-extension
ecosystem monorepo that manages independently-versioned extensions of 7 types
(agent, skill, mcp-server, prompt, hook, command, bundle) via a CLI (`bin/sox`) and
an nx build. It lives at:

    /Users/nix/dev/ai/sox-ecosystem        (work on branch: feat/nx-migration)

YOUR TASK
Port this existing hook into a born-conformant sox-ecosystem extension of type `hook`:

    SOURCE: ~/dev/ai/claude-agents/tools/hooks/swarm-cost

The new extension must go init → build → validate → install → run with ZERO manual
conformance work, declare and obey its runtime permissions, and preserve the source
hook's behavior exactly.

STEP 1 — GROUND TRUTH FIRST (read before writing any code; do not assume conventions)
Do NOT infer the contract from memory or from other ecosystems — read the authoritative
sources in the repo and the source hook, and base everything on them:
  a. `/Users/nix/dev/ai/sox-ecosystem/DOD.md` — the project's definition of done (the bar
     every extension must clear).
  b. `/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/` — the per-type contract; read the
     `hook` guideline in full. This is the spec your extension must satisfy.
  c. A WORKING REFERENCE HOOK already in the repo: find the installed `hook`-type extension
     (e.g. `memory-flush`) under `extensions/` and study its layout, manifest
     (`extension.json`), entrypoint, event wiring, and how it declares `permissions`.
     Mirror its shape — it is the proven template.
  d. `/Users/nix/dev/ai/sox-ecosystem/libs/manifest` — the manifest schema, including the
     `permissions` block (fs/network/socket) and per-type fields. Treat this as read-only.
  e. `node bin/sox --help` (from the repo root) — the real CLI surface and flags. Note:
     `nx` is not on PATH; run it as `./node_modules/.bin/nx`.
  f. The SOURCE hook itself: read every file under `~/dev/ai/claude-agents/tools/hooks/
     swarm-cost` and write down, in your own notes, exactly what it does — which hook event(s)
     it fires on (e.g. PreToolUse/PostToolUse), its inputs, its side effects (files read/written,
     network, sockets, env it reads), and its output/exit behavior. You will preserve all of it.

STEP 2 — SCAFFOLD BORN-CONFORMANT (do not hand-roll the layout)
From the repo root, scaffold the extension with the generator so it is conformant by
construction:

    node bin/sox init hook <chosen-id> --content @~/dev/ai/claude-agents/tools/hooks/swarm-cost/<script>   # alias: `new`
    # --content @<path> pulls the hook body straight from the source (records source: provenance).
    # (Pending generator P5; until then scaffold plain, then port the body.)

(If the guideline points to an nx generator instead, use that — whichever the docs say is
the supported authoring path. The invariant: the scaffolder produces the conformant skeleton;
you fill in logic, you do not invent structure.)
Choose a clear kebab-case id (e.g. `swarm-cost`). Confirm the scaffold lands under the
correct `extensions/<...>/` location and matches the reference hook's shape.

STEP 3 — PORT THE LOGIC
Move swarm-cost's behavior into the scaffolded entrypoint, adapted to this ecosystem's hook
event/adapter contract (as shown by the reference hook and the guideline). Preserve its
exact behavior and outputs. Do not pull in dependencies that aren't already used in the repo
unless strictly necessary; if you must, follow the repo's dependency conventions.

STEP 4 — DECLARE PERMISSIONS (this ecosystem enforces them at runtime)
In `extension.json`, declare a `permissions` block covering EVERY resource the hook actually
touches (fs read/write paths, network outbound, socket paths), based on your Step 1f notes.
Undeclared access is DENIED at runtime — an over-narrow block will make the hook fail when it
runs, and an over-broad one is a security smell. Declare exactly what it needs (prefer
home-relative `~/` globs as the schema specifies). Verify against the manifest schema.

STEP 5 — PROVE THE FULL LIFECYCLE AGAINST REALITY (not just unit tests)
A passing unit test is NOT acceptance. Demonstrate each stage actually works:
  1. `./node_modules/.bin/nx run <project>:build`        → builds clean.
  2. `node bin/sox validate` (use --strict if available) → the manifest + entrypoint
     reachability pass; no errors.
  3. Install it into a sandboxed scope (use a temp dir + `-s project --config=... --lockfile=...`
     so you don't pollute real config), then `node bin/sox start ...` and confirm the hook is
     actually loaded/active in the runtime (check `sox list` / the runtime record / the loader
     output — a real RUNNING/loaded state, not a log line you wrote).
  4. Trigger the hook's event for real and observe it fires and behaves identically to the
     source swarm-cost hook.
  5. `node bin/sox stop ...` leaves zero orphan processes.
Capture the actual command output for each as evidence.

CONSTRAINTS
- Work only within the new extension's files plus whatever the generator/registry updates
  require; do not modify unrelated code. If you touch an extension's source, the registry
  checksum must be regenerated (find how the repo does this — there is a build-index step).
- Run nx via `./node_modules/.bin/nx`; the CLI via `node bin/sox`.
- Commit with conventional messages; do not merge to main.
- If reality contradicts the guideline (the docs say X but the reference hook does Y), STOP and
  report the discrepancy rather than guessing.

DEFINITION OF DONE
- A new `hook`-type extension exists, scaffolded by the generator, that reproduces swarm-cost's
  behavior.
- Its `extension.json` declares accurate `permissions`, and it runs without hitting a denial.
- It passes init → build → validate → install → start → (observed firing) → stop, each
  verified against reality with captured output.
- No regression to the rest of the repo (`./node_modules/.bin/nx run-many -t build,lint,test`
  stays green).
- You report: the chosen id + path, the permissions you declared and why, and the evidence for
  each lifecycle stage.
```
