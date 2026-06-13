# Hand-off prompt — `tokenguard` (type TBD: mcp-server | command | both)

| | |
|---|---|
| **Source** | `~/dev/security/wop/scripts/tokenguard/` |
| **Target type** | **DECISION POINT** — runs as a SERVER → `mcp-server` (the only long-running supervised type; protocol fork in STEP 0), possibly **+** a `command`, composed as a `bundle` |
| **Proposed id** | `tokenguard` (or `tokenguard-server` / `tokenguard-cli` if split) |
| **Status** | drafted — source not yet read by prompt author; known to run as a server, but its protocol (MCP vs non-MCP) and whether a CLI also ships are unresolved |

> The founder is unsure whether this is an MCP server, a CLI command, or both. This prompt makes
> the agent **investigate and recommend** the mapping from ground truth before building, and bias
> toward shared-core-lib + only the interface(s) actually needed (DoD C7: reuse without duplication).

---

```text
You are building one or more new extensions for the "sox-ecosystem" project — an LLM-extension
ecosystem monorepo (7 types: agent, skill, mcp-server, prompt, hook, command, bundle) with a
CLI (`bin/sox`) and an nx build, at:

    /Users/nix/dev/ai/sox-ecosystem        (work on branch: feat/nx-migration)

YOUR TASK
Bring this into the ecosystem, born-conformant. ITS TYPE IS UNDECIDED — resolve it first:

    SOURCE: ~/dev/security/wop/scripts/tokenguard/

STEP 0 — RESOLVE THE TYPE MAPPING (decision point — do this before any scaffolding)
KNOWN: tokenguard runs as a SERVER (a long-running process), and may ALSO have a one-shot CLI.
In this ecosystem the ONLY long-running, supervisor-spawned background type is `mcp-server` —
there is NO generic "daemon"/"service" type (the 7 types are agent, skill, mcp-server, prompt,
hook, command, bundle). So a server maps to `mcp-server` — but HOW it maps depends on its protocol.
Read every file under the source dir, identify its interfaces, and decide:

  A. THE SERVER (the long-running part) → `mcp-server`, with a protocol fork:
     - It already speaks MCP (stdio JSON-RPC: initialize + tools/list + tools/call) → port it
       directly as an `mcp-server`; the supervisor spawns + supervises it and `sox exec` calls its
       tools.
     - It is a server with a NON-MCP protocol (HTTP / socket / custom RPC) → it does not fit the
       agent-facing tool model as-is. Wrap it: keep the core server logic in a shared lib and add a
       thin MCP front (an `mcp-server` extension whose tools call the core) so agents can reach it
       through `sox exec`. The underlying socket/port it opens is declared in `permissions.socket`/
       `network`. Report this as a wrap, not a 1:1 port.
     - It is a pure-infrastructure server with NO agent-facing surface and NO sensible MCP tool
       mapping → STOP and report: sox-ecosystem has no generic long-running-daemon type; forcing it
       into `mcp-server` may be wrong. This is a contract-gap decision for the founder, not something
       to paper over.

  B. THE ONE-SHOT CLI (if present) → `command` (argv in, result/exit-code out, exits).

  C. IF BOTH the server and a genuinely-used CLI ship → shared core library (the tokenguard logic,
     once) + thin `mcp-server` and `command` wrappers that both import it, composed into a `bundle`.
     Do NOT duplicate the core across extensions (DoD C7 — shared internal code, no reach-in).

Decide using EVIDENCE from the source (entrypoints, how the server is started today, what protocol
it speaks on which port/socket, whether anything calls it programmatically, whether the CLI is
actually used). Bias toward the SMALLEST faithful mapping. Write a 3–5 line recommendation: the
type(s) chosen, the server's protocol and whether it's a direct port or an MCP wrap, and what
becomes a shared lib. If the choice has product implications (e.g. a non-MCP server, or a
contract-gap), STOP and report for founder confirmation BEFORE building; otherwise proceed and note it.

STEP 1 — GROUND TRUTH FIRST (read before writing anything; do not assume conventions)
  a. `/Users/nix/dev/ai/sox-ecosystem/DOD.md` — the bar.
  b. `/Users/nix/dev/ai/sox-ecosystem/docs/guidelines/` — read the guideline(s) for the type(s)
     you selected (`mcp-server` and/or `command`), in full.
  c. WORKING REFERENCES: for an mcp-server, study `memory-server`; for a command, study
     `memory-cli`; if you split into a shared lib + wrappers + bundle, also study how `libs/` are
     shared and how `sox-memory-bundle` composes members. Mirror these shapes.
  d. `/Users/nix/dev/ai/sox-ecosystem/libs/manifest` — manifest schema incl. `permissions`
     (this is a SECURITY tool — its fs/network/socket footprint must be declared precisely).
     Read-only.
  e. `node bin/sox --help` — real CLI surface. `nx` not on PATH; use `./node_modules/.bin/nx`.
  f. The SOURCE: catalog its runtime (node/shell/python), external deps, and EVERY resource it
     touches (files, network egress, sockets, secrets/env it reads) — tokenguard guards tokens, so
     be exhaustive about its access; this drives the permissions block.

STEP 2 — SCAFFOLD BORN-CONFORMANT (do not hand-roll the layout)
For each extension in your chosen mapping:
    node bin/sox init mcp-server <id>     # and/or
    node bin/sox init command <id>        # alias: `new`
(or the nx generator the guideline names). If you extracted a shared lib, place it where the repo
puts shared internal libs (mirror existing `libs/`). The scaffolder produces conformant skeletons;
you fill in logic.

STEP 3 — PORT THE LOGIC
Move tokenguard's behavior into the scaffolded entrypoint(s), with the core logic in the shared lib
if you split. Preserve exact behavior and outputs. Follow the repo's dependency conventions.

STEP 4 — DECLARE PERMISSIONS (this ecosystem enforces them at runtime — and this is a security tool)
In each `extension.json`, declare a `permissions` block covering EVERY fs/network/socket resource
the extension actually touches. Undeclared access is DENIED at runtime; for a security tool, an
incorrect block either breaks it or hides its true footprint — get it exactly right and minimal.

STEP 5 — PROVE THE LIFECYCLE AGAINST REALITY (per extension; not just unit tests)
  1. `./node_modules/.bin/nx run <project>:build`        → builds clean.
  2. `node bin/sox validate` (--strict if available)     → passes.
  3. Install into a sandboxed scope (temp dir + `-s project --config=... --lockfile=...`):
       - mcp-server: `node bin/sox start ...`, confirm it's RUNNING (pid in `sox list`/runtime
         record), then `node bin/sox exec --id=<id> --tool=<tool> --args='...'` returns a real
         result; prove an undeclared-resource access is DENIED at runtime.
       - command: invoke it and confirm it produces the same result as the source tokenguard.
  4. `node bin/sox stop ...` leaves zero orphan processes.
  5. If you shipped a bundle: `install` the bundle resolves+installs all members; `start` runs them;
     `uninstall` removes them.
Capture real command output as evidence.

CONSTRAINTS
- Only touch the new extension(s)/lib + required registry updates; regenerate the registry checksum
  after changing extension sources (find the build-index step). Run nx via `./node_modules/.bin/nx`,
  the CLI via `node bin/sox`. Conventional commits; do not merge to main.
- If reality contradicts the guideline, STOP and report rather than guessing.

DEFINITION OF DONE
- The type decision is recorded with its rationale.
- Each resulting extension is born-conformant, with accurate enforced `permissions`, and passes its
  full reality-verified lifecycle (mcp-server: install→start→exec→stop; command: install→invoke;
  bundle: install→start→uninstall) with captured output.
- Core logic is shared via a lib if more than one interface ships (no duplication, no reach-in).
- No regression (`./node_modules/.bin/nx run-many -t build,lint,test` green; e2e green).
- You report: the type decision + why, the permissions per extension + why, and evidence per stage.
```
