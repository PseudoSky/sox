# review — design notes

## Decision: blind diff by reference (0.2.0)

Need: blind review of a diff too large to paste through a dispatcher's context.

| Option | Tools | Verdict |
|---|---|---|
| Inline diff only (0.1.1) | none in blind | Fails for diffs over the dispatcher's context |
| Absolute path to a diff file, Read in chunks | Read (already granted) | Chosen. Satisfies the need, adds no capability |
| Git range, agent runs `git diff` | Bash | Rejected |

Why Bash is rejected:
- The manifest, `check-readonly.mjs` (`MUST_DENY` includes bash) and the claude `disallowedTools` guarantee make "cannot run commands" a harness property. Granting Bash converts it into a prose promise.
- A prompt restriction to `git diff` is not enforceable on claude (tool whitelist has no argument patterns). `git diff --output=<file>` writes; a configured textconv or external diff driver executes arbitrary programs.
- A dispatcher gets the same result at zero context cost: `git diff <range> > <file>` and pass the file path.

Residual risk of the chosen design: the path is unverified, so a blind agent can be pointed at any readable file. Accepted: the brief comes from the dispatcher, the agent only reads and reports, and `Never open a path the diff names` keeps the diff's own paths out of reach.

A git range gets `REFUSED: blind brief carries a git range (no shell; pass a diff file path)`.
