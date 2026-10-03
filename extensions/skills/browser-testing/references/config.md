# Chrome DevTools MCP — Setup & Configuration

## What it is

`chrome-devtools-mcp` (Google, `ChromeDevTools/chrome-devtools-mcp`, v1.10.x, Apache-2.0) is an
MCP server that exposes live Chrome DevTools control to an agent: navigation, input automation,
emulation, performance tracing, network inspection, console access, accessibility-tree snapshots,
Lighthouse audits, and heap snapshots. It drives Google Chrome or Chrome for Testing.

If the `mcp__chrome-devtools__*` tools are not present in your session, the server is not
configured. Do not simulate a browser — report the gap and point the user here.

## Registering the server (opencode)

Add to `opencode.json` (repo or `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
      "enabled": true
    }
  }
}
```

Claude Code (`mcpServers` shape):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

## Recommended flags

| flag | why |
|---|---|
| `--isolated` | throwaway browser profile, auto-cleaned — **use this for all testing; never test production** |
| `--headless` | no visible window (CI and background runs) |
| `--slim` | minimal tool surface — reduces the schemas loaded into context |
| `--channel=stable` | pin the Chrome release channel |
| `--viewport=1280x720` | set the default viewport |
| `--browserUrl` | attach to an already-running Chrome instead of launching |
| `--executablePath` | use a specific Chrome binary |

Privacy / network:

| flag | why |
|---|---|
| `--no-usage-statistics` | usage telemetry is ON by default; opt out |
| `--no-performance-crux` | perf tools may otherwise send trace URLs to Google CrUX |
| `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS` (env) | disable update checks |

Feature gates (off by default; enable only what you need — each adds context cost):

| flag | unlocks |
|---|---|
| `--memoryDebugging=true` | the 14 heap-snapshot tools |
| `--experimentalVision=true` | `click_at` |
| `--experimentalScreencast=true` | `screencast_start` / `screencast_stop` |
| `--categoryExtensions` | extension management tools |
| `--categoryExperimentalThirdParty` | third-party developer tools |
| `--categoryExperimentalWebmcp` | WebMCP tools |
| `--categoryPwa` | PWA install/launch tools |

## Context-cost note

The server loads its tool schemas into the model context. If you only need the core interactive
set (navigation + input + snapshot + console + network + evaluate + screenshot), start with
`--slim` and add gates as needed. Turning on `--memoryDebugging` or the `--category*` flags adds
many more tools — enable them only for a session that needs them.

## Troubleshooting

- **No tools visible** → server not registered, or `npx` could not resolve the package; run
  `npx chrome-devtools-mcp@latest --help` to confirm the package installs.
- **Click/fill fails with an unknown uid** → the snapshot is stale; take a fresh `take_snapshot`.
- **Chrome fails to launch** → pass `--channel=stable` or `--executablePath`.
- **Want to drive an existing browser session** → `--browserUrl`.

## Provenance

- Upstream: `https://github.com/ChromeDevTools/chrome-devtools-mcp` (v1.10.x).
- A community skill exists (`justfinethanku/cc_chrome_devtools_mcp_skill`, MIT) but its tool list
  predates `emulate`, `get_css_styles`, `lighthouse_audit`, and the modern heap-snapshot stack.
  This skill is grounded on the upstream reference, not on that community skill.
