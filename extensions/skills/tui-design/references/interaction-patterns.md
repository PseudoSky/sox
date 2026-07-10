# Interaction patterns — keybindings, focus, navigation, modal vs modeless

A deep dive into how users interact with TUIs — keybinding philosophy, focus management, navigation patterns, mouse support, and discoverability.

**Contents:**
- [Keybinding philosophies](#keybinding-philosophies)
- [Cross-app keybinding conventions](#cross-app-keybinding-conventions)
- [Reserved keys — never bind these](#reserved-keys--never-bind-these)
- [Discoverability — the four-layer pattern](#discoverability--the-four-layer-pattern)
- [Modal vs modeless — the deeper trade-off](#modal-vs-modeless--the-deeper-trade-off)
- [Focus management](#focus-management)
- [Search and filter](#search-and-filter)
- [Multi-select](#multi-select)
- [Mouse support — the real trade-off](#mouse-support--the-real-trade-off)
- [Undo / redo](#undo--redo)
- [Confirmation patterns](#confirmation-patterns)
- [Talking to the terminal emulator — OSC 8, 52, 9](#talking-to-the-terminal-emulator--osc-8-52-9)

---

## Keybinding philosophies

Four major schools:

1. **Vim-style (modal)** — modes (NORMAL, INSERT, VISUAL), single-letter motions, leader keys. Dense, expressive, steep learning curve.
2. **Emacs-style (chord)** — modifier-prefixed (`C-x C-s`), no modes, rich modifier space.
3. **Arrow-key / GUI-like (modeless)** — arrows + Enter + Tab + Esc + single-letter shortcuts. Zero learning curve.
4. **Hybrid (modeless + vim motions)** — support arrows AND `hjkl`. Best of both worlds. **Default for new TUIs.**

## Cross-app keybinding conventions

| Key | Action |
|---|---|
| `q` | quit |
| `?` | help |
| `/` | search / filter |
| `n` / `N` | next / prev match |
| `Esc` | cancel / back / dismiss |
| `Enter` / `Return` | confirm / drill in |
| `Space` | toggle / mark for multi-select |
| `:` | command mode |
| `Tab` / `Shift+Tab` | switch focus |
| `1`–`9` | jump to panel / numbered tab |
| `hjkl` *and* arrows | move (support both) |
| `Ctrl+P` | command palette |

## Reserved keys — never bind these

- **Ctrl+C** (SIGINT — must always quit cleanly)
- **Ctrl+Z** (SIGTSTP — suspend; restore terminal state on resume)
- **Ctrl+\\** (SIGQUIT)
- **Ctrl+S** / **Ctrl+Q** (XON/XOFF flow control)

## Discoverability — the four-layer pattern

**Layer 1: Always-visible footer hints** — 3–5 most-useful shortcuts. The single most important discoverability tool. Auto-generate from keybinding map.

**Layer 2: `?` help screen** — all keybindings grouped by context.

**Layer 3: Leader-key / which-key** — after pressing a leader (Space, `,`), show available follow-ups.

**Layer 4: Command palette** — `Ctrl+P` fuzzy-matched action list. Every action with a binding should also be a palette command.

## Modal vs modeless — the deeper trade-off

**Modal** requires: persistent mode indicator, distinct cursor shapes per mode, a way to learn modes. Pro: dense keybindings, composable operators. Con: confusion if weakly indicated.

**Modeless** requires: clear focus indication, modifier-key bindings for less-common actions. Pro: zero learning curve. Con: less expressive.

**The third option: contextual** — bindings change based on which panel is focused (lazygit pattern). Works well with per-panel footer hints.

## Focus management

Focus indicators in order of strength: border color change > border weight > title color/weight > background tint > selection visibility.

Focus navigation: Tab/Shift+Tab for 2–3 panels; numeric keys (`1`–`9`) for 5+ panels.

## Search and filter

**Search** (`/`): find matches, `n`/`N` to cycle. Show count `(2/15)`.

**Filter** (`/`): narrow list. Sub-100ms, show count `123/45678`, highlight matched substring. Smart-case by default.

## Multi-select

Space toggles row marked state. Marked rows show `*` or accent background.

## Mouse support — the pragmatic compromise

**Mouse augments keyboard, never replaces required actions.** Click to focus panel, click tabs, scroll lists. Every mouse-reachable target needs a keyboard equivalent. Document Shift-bypass for text selection.

## Undo / redo

Hard for non-editor apps. Two strategies: action stack (reversible operations) or state snapshots. For destructive actions without undo, use modal confirmation.

## Confirmation patterns

- **Light**: `[y/N]` — default to No.
- **Medium**: typed name confirmation (Heroku's "type the database name to confirm").
- **Heavy**: dual confirmation. Match friction to consequence.

## Talking to the terminal emulator — OSC 8, 52, 9

OSC escapes travel through SSH/containers — the local emulator interprets them:

- **OSC 8** — hyperlinks. Graceful degradation (unknown terminals render the text normally).
- **OSC 52** — write system clipboard. Write-only design (reads are an exfiltration risk).
- **OSC 9 / 777** — desktop notifications. Use for long-running work completion, never routine events.

---

For deeper patterns on visual design, see `references/visual-patterns.md`.
