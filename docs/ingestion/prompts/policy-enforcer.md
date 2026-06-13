# Hand-off prompt — `policy-enforcer` (hook primary; optional command)

| | |
|---|---|
| **Source** | `~/dev/ai/claude-agents/tools/policy-enforcer/` |
| **Target type** | `hook` (the main thing) **+ DECISION POINT**: keep/drop the bundled CLI as a `command` |
| **Proposed id** | `policy-enforcer` (hook); `policy-enforcer-cli` (command, only if kept); `policy-enforcer-bundle` (only if both ship) |
| **Status** | drafted — source not yet read by prompt author; CLI necessity unresolved |

> The founder says the **hook is the main thing**; the source also has a CLI that may not be
> needed. This prompt builds the hook unconditionally and makes the agent **decide whether the CLI
> earns its place** — defaulting to hook-only unless the CLI provides genuine user-facing value.

---

```text
You are building one or more new extensions for the "sox-ecosystem" project — an LLM-extension
ecosystem monorepo (7 types: agent, skill, mcp-server, prompt, hook, command, bundle) with a
CLI (`bin/sox`) and an nx build, at:

    /Users/nix/dev/ai/sox-ecosystem        (work on branch: feat/nx-migration)

YOUR TASK
Bring this into the ecosystem, born-conformant. The HOOK is the primary deliverable; the bundled
CLI's fate is a decision:

    SOURCE: ~/dev/ai/claude-agents/tools/policy-enforcer/   (contains a hook AND a cli)

STEP 0 — INVESTIGATE + DECIDE THE CLI (decision point — the hook ships regardless)
Read every file under the source dir. Separate the hook from the cli. Determine what the cli is FOR:
  - If the cli is only dev tooling / tests / a way to run the hook logic during development, and the
    hook is self-contained → ship the HOOK ONLY; drop the cli (note why).
  - If the cli provides genuine user-facing value (e.g. managing policy config, inspecting/auditing
    decisions) that users would invoke independently of the hook → ship the hook AND a separate
    `command` extension, with any logic shared between them extracted into a lib (DoD C7: no
    duplication, no reach-in), composed into a `bundle`.
Bias toward HOOK-ONLY. Write a 3–5 line recommendation (keep or drop the cli, and why). If keeping
it is a real product call, STOP and report for founder confirmation before building the command;
the hook can proceed either way.

STEP 1 — GROUND TRUTH FIRST (read before writing anything; do not assume conventions)
  a. `/Users/nix/dev/ai/sox-ecosystem/DOD.md` — the bar.
  b. `/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/` — read the `hook` guideline in full (and
     the `command` + `bundle` guidelines IF you keep the cli).
  c. WORKING REFERENCES: study the `hook`-type extension `memory-flush` (layout, manifest, event
     wiring, permissions) and mirror it; if you keep the cli, also study `memory-cli` (command) and
     `sox-memory-bundle` (composition) + how `libs/` are shared.
  d. `/Users/nix/dev/ai/sox-ecosystem/libs/manifest` — manifest schema incl. `permissions`.
     A policy enforcer's footprint (files/network/sockets/env it reads to make decisions) must be
     declared precisely. Read-only.
  e. `node bin/sox --help` — real CLI surface. `nx` not on PATH; use `./node_modules/.bin/nx`.
  f. The SOURCE hook: note which hook event(s) it fires on, its inputs, side effects, and output/
     exit behavior (e.g. does it block/deny an action? mutate something? warn?). You will preserve
     this exactly — it is the main thing.

STEP 2 — SCAFFOLD BORN-CONFORMANT (do not hand-roll the layout)
    node bin/sox init hook policy-enforcer            # always
    node bin/sox init command policy-enforcer-cli     # only if STEP 0 kept the cli
(or the nx generator the guideline names). Put shared logic in a `libs/` lib if both ship.

STEP 3 — PORT THE LOGIC
Port the hook's behavior into the scaffolded hook entrypoint, adapted to this ecosystem's hook
event/adapter contract (per the guideline + memory-flush). Preserve its exact behavior and outputs
— if it denies/blocks an action, it must still deny/block identically. If you kept the cli, port it
too, sharing the core via the lib.

STEP 4 — DECLARE PERMISSIONS (enforced at runtime)
In each `extension.json`, declare a `permissions` block covering EVERY resource actually touched.
Undeclared access is DENIED at runtime; under-declaring will make the enforcer fail when it runs.
Declare exactly what's needed, minimally.

STEP 5 — PROVE THE LIFECYCLE AGAINST REALITY (not just unit tests)
  Hook (mandatory):
    1. `./node_modules/.bin/nx run <project>:build`     → builds clean.
    2. `node bin/sox validate` (--strict if available)  → passes.
    3. Install into a sandboxed scope (temp dir + `-s project --config=... --lockfile=...`),
       `node bin/sox start ...`, confirm the hook is actually loaded/active in the runtime (real
       state, not a self-written log).
    4. Trigger its event for real and observe it behaves identically to the source (incl. any
       block/deny behavior).
    5. `node bin/sox stop ...` leaves zero orphans.
  Command (only if kept): install + invoke it; confirm output matches the source cli.
  Bundle (only if both ship): install resolves+installs members; start runs them; uninstall removes.
Capture real command output as evidence.

CONSTRAINTS
- Only touch the new extension(s)/lib + required registry updates; regenerate the registry checksum
  after changing extension sources (find the build-index step). Run nx via `./node_modules/.bin/nx`,
  the CLI via `node bin/sox`. Conventional commits; do not merge to main.
- If reality contradicts the guideline, STOP and report rather than guessing.

DEFINITION OF DONE
- The cli decision is recorded with its rationale.
- The `hook` extension reproduces policy-enforcer's behavior, declares accurate enforced
  `permissions`, and passes init → build → validate → install → (observed firing, incl. deny
  behavior) → stop, reality-verified with captured output.
- If kept: the `command` extension + shared lib + `bundle` are likewise born-conformant and
  reality-verified; no logic duplicated between hook and cli.
- No regression (`./node_modules/.bin/nx run-many -t build,lint,test` green; e2e green).
- You report: the cli decision + why, permissions per extension + why, and evidence per stage.
```
