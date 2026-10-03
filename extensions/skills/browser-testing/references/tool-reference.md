# Chrome DevTools MCP — Tool Reference (v1.10.x)

Curated catalog of the tool surface the `browser-testing` skill uses. Names are as exposed to an
agent (`mcp__<server>__<tool>`); parameters are the ones that change the call. Source of truth:
`ChromeDevTools/chrome-devtools-mcp` `docs/tool-reference.md`.

## Navigation

| tool | params | notes |
|---|---|---|
| `new_page` | `url`, `background`, `isolatedContext` | isolated contexts share no cookies/storage |
| `navigate_page` | `type` url\|back\|forward\|reload, `url`, `timeout`, `ignoreCache`, `initScript`, `handleBeforeUnload` | |
| `select_page` | `pageId` | switch active tab |
| `list_pages` | — | enumerate open tabs |
| `close_page` | `pageId` | clean up |
| `wait_for` | `text[]` | resolves when any listed text appears |

## Input automation

| tool | params | notes |
|---|---|---|
| `click` | `pageId`, `uid`, `dblClick`, `includeSnapshot` | needs a uid from the latest snapshot |
| `hover` | `uid` | |
| `fill` | `uid`, `value` | single field |
| `fill_form` | `elements[]` | **prefer for forms** — faster, fewer turns |
| `type_text` | `text`, `submitKey` | free text entry |
| `press_key` | `key` e.g. `"Enter"`, `"Control+A"`, `"Control+Shift+R"` | keyboard path testing |
| `drag` | `from_uid`, `to_uid` | |
| `upload_file` | `filePaths[]` | local paths, seen by the browser |
| `handle_dialog` | `action` accept\|dismiss, `promptText` | native dialogs |
| `click_at` | `x`, `y` | requires `--experimentalVision=true` |

## Emulation

| tool | params | notes |
|---|---|---|
| `emulate` | `pageId`; `colorScheme` dark\|light\|auto; `cpuThrottlingRate`; `networkConditions` Offline\|Slow 3G\|Fast 3G\|Slow 4G\|Fast 4G; `viewport` `"WxHxDPR[,mobile][,touch][,landscape]"`; `geolocation` `"lat,lon"`; `userAgent`; `extraHttpHeaders` JSON | the device/conditions switch |
| `resize_page` | `width`, `height` | quick viewport change |

## Performance

| tool | params | notes |
|---|---|---|
| `performance_start_trace` | `reload`, `autoStop`, `filePath` | navigate to the URL first if reload/autoStop |
| `performance_stop_trace` | `filePath` | |
| `performance_analyze_insight` | `insightSetId`, `insightName` e.g. `DocumentLatency`, `LCPBreakdown` | the session exposes CWV + named insight sets |

## Network

| tool | params | notes |
|---|---|---|
| `list_network_requests` | `resourceTypes[]`, `pageIdx`, `pageSize`, `includePreservedRequests` | preserved = last 3 navigations |
| `get_network_request` | `reqid`\|`selected`; `requestFilePath`/`responseFilePath` | dump bodies to disk |

## Debugging & inspection

| tool | params | notes |
|---|---|---|
| `take_snapshot` | `verbose` | a11y-tree text snapshot with uids; **always use the latest; prefer over a screenshot** |
| `take_screenshot` | `uid`\|`fullPage`; `format` png\|jpeg\|webp; `quality`; `filePath` | human-facing evidence |
| `evaluate_script` | `function`\|`sourcePath`; `format`; `args`; `filePath`; `dialogAction`; `waitForStableDom` | returns JSON — assertions and probes |
| `get_css_styles` | `uid` | matched + inherited rules, custom props, @layer/@media/@container/@scope; winning declarations unprefixed, overridden `[overloaded]`; source lines; paginated 10/page. Authoritative |
| `list_console_messages` | `types[]`, `includeStackTraces`, `includePreservedMessages`, paging | |
| `get_console_message` | `msgid` | source-mapped stack |
| `lighthouse_audit` | `device` desktop\|mobile; `mode` navigation\|snapshot; `outputDirPath` | accessibility, SEO, best-practices — **not performance** |
| `screencast_start` / `screencast_stop` | webm/mp4 | requires `--experimentalScreencast=true` |

## Memory (gated by `--memoryDebugging=true`)

`take_heapsnapshot`, `close_heapsnapshot`, `compare_heapsnapshots`, `get_heapsnapshot_summary`,
`get_heapsnapshot_details`, `get_heapsnapshot_class_nodes` (filters: `detached-DOM`, `console`,
`event-handlers`, `contexts`, …), `get_heapsnapshot_dominators`, `get_heapsnapshot_edges`,
`get_heapsnapshot_retainers`, `get_heapsnapshot_retaining_paths`, `get_heapsnapshot_duplicate_strings`,
`get_heapsnapshot_object_details`, `analyze_heapsnapshot_contexts`, `query_heapsnapshot_objects`
(`className`, `propertyName`, `nodeType`, `retainedSize`, `isDetached`, `sortBy`). Use for memory-leak
and detached-DOM hunting.

## Optional categories (off by default)

- Extensions (`--categoryExtensions`): install / list / reload / trigger_action / uninstall.
- Third-party (`--categoryExperimentalThirdParty`): list / execute_3p_developer_tool.
- WebMCP (`--categoryExperimentalWebmcp`): list / execute_webmcp_tool.
- PWA (`--categoryPwa`): install / launch / uninstall / get_os_app_state.

## Core Web Vitals thresholds

| metric | good | needs work | poor |
|---|---|---|---|
| LCP | ≤ 2.5s | 2.5–4s | > 4s |
| INP | ≤ 200ms | 200–500ms | > 500ms |
| CLS | ≤ 0.1 | 0.1–0.25 | > 0.25 |

INP replaced FID on 2024-03-12.
