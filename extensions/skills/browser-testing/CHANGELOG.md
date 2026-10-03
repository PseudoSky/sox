# Changelog

## 0.1.0

- **Initial release.** Browser-testing/debugging playbook for front-end UI work driven by Google's
  `chrome-devtools-mcp` (v1.10.x). Six playbooks — interaction/smoke, debugging, performance,
  accessibility, responsive/themes, visual regression — over the live tool surface
  (`take_snapshot` uid workflow, `emulate`, `performance_start_trace`/`analyze_insight`,
  `list_console_messages`/`list_network_requests`, `get_css_styles`, `lighthouse_audit`).
- Ships `references/tool-reference.md` (full catalog + Core Web Vitals thresholds) and
  `references/config.md` (server registration, `--isolated`/`--slim` flags, privacy toggles, gates).
- Grounded on the upstream reference, not the stale community skill (which predates `emulate`,
  `get_css_styles`, `lighthouse_audit`, and the modern heap-snapshot stack).
