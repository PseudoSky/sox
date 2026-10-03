# Browser Testing with Chrome DevTools MCP

A live-browser testing and debugging playbook for front-end UI work, driven by the
`chrome-devtools` MCP server (Google's `chrome-devtools-mcp`, v1.10.x). It turns a running
browser into the verification instrument: navigate, interact, read the console and network,
measure performance, audit accessibility, and capture evidence — all from tools you actually ran.

Everything here assumes the server is configured; its tools are namespaced
`mcp__chrome-devtools__*`. If they are absent, the server is not enabled — see
`references/config.md`, and say so rather than simulating a browser.

## Core discipline

- **Snapshot before you touch.** `take_snapshot` returns a text rendering of the accessibility
  tree with a `uid` per element. Every `click`/`fill`/`hover`/`get_css_styles` needs a uid from
  the *latest* snapshot. Prefer a snapshot over a screenshot, and re-snapshot after any
  navigation or DOM change.
- **Report the tool and its result.** Every claim — it renders, it passes, it is accessible, it
  is fast — comes from a tool you ran this session; quote it. Never narrate a state you did not
  observe.
- **Isolate.** Run the server with `--isolated` (throwaway profile). Never point automated tests
  at production.
- **One page at a time.** Use `list_pages` / `select_page` when more than one tab exists.

## Playbook A — Interaction / smoke test

1. `new_page` (or `navigate_page`) to the URL.
2. `take_snapshot` → collect the uids you need.
3. Interact: `click`, `hover`, `type_text`, `press_key`; for a multi-field form use `fill_form`
   (one call, fewer turns than repeated fill/click).
4. `wait_for` the expected text after any async action.
5. Assert with `evaluate_script` (return JSON) or a fresh `take_snapshot`.
6. `take_screenshot` only to capture human-facing evidence.
7. **Report:** each step, the tool result that proves each assertion, and the final state.

## Playbook B — Debugging

1. `list_console_messages` (filter `types: ["error","warn"]`) — read this first; use
   `get_console_message` for the source-mapped stack.
2. `list_network_requests` (add `includePreservedRequests` to see the last three navigations);
   `get_network_request` with `responseFilePath` to inspect a failing payload.
3. `evaluate_script` to probe live DOM/state — read, never guess.
4. `get_css_styles` on a uid for a cascade/specificity bug: it returns matched rules with the
   *winning* declarations unprefixed and overridden ones marked `[overloaded]`, plus source line
   numbers — treat it as authoritative.
5. Fix, then re-run the failing path and show the console and network are clean.

## Playbook C — Performance

1. `emulate` degradation first when relevant (`networkConditions` Slow 4G / Slow 3G,
   `cpuThrottlingRate`).
2. Navigate to the URL, then `performance_start_trace` with `reload: true, autoStop: true`.
3. `performance_analyze_insight` on the reported insight set (e.g. `LCPBreakdown`,
   `DocumentLatency`).
4. Judge against Core Web Vitals: **LCP** good ≤2.5s, **INP** good ≤200ms, **CLS** good ≤0.1.
   Report the measured values, not adjectives.
5. Note: `lighthouse_audit` does **not** include performance — performance is the trace tools.

## Playbook D — Accessibility

1. `take_snapshot` (verbose) — inspect the accessibility tree: roles, accessible names, order.
2. Keyboard path: `press_key` through Tab / Shift+Tab / Enter / Space / Escape; confirm focus
   order is logical and focus is neither trapped nor lost.
3. `lighthouse_audit` (device `desktop` or `mobile`) for accessibility, SEO, and best-practices
   findings.
4. Fix violations, re-run, and quote the new result.

## Playbook E — Responsive, themes, devices

- `emulate` `viewport: "390x844x3,mobile,touch"` for mobile; `resize_page` for a quick desktop size.
- `emulate` `colorScheme: dark` / `auto` to exercise dark mode and `prefers-color-scheme`.
- Re-run snapshot + screenshot at each breakpoint; assert no horizontal scroll, adequate
  tap-target size, and layout integrity via `evaluate_script`.

## Playbook F — Visual regression

- `take_screenshot` (`fullPage`, per viewport) before and after a change; compare.
- `screencast_start` / `screencast_stop` capture a flow when a static frame is insufficient.
  These require the experimental flags in `references/config.md`.

## Hard rules

- **No snapshot, no click** — a stale uid fails.
- Never claim an a11y, performance, or console result you did not run.
- Never test production without `--isolated`.
- Clean up: `close_page`, and stop any trace or screencast you started.
- A missing tool means the server is not enabled — report that; do not simulate.

## References

- `references/tool-reference.md` — the full tool catalog with parameters.
- `references/config.md` — server setup, flags, isolation, and troubleshooting.
