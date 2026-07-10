# Visual patterns — borders, color, density, layout

A deep dive into the visual design choices that make TUIs feel professional.

**Contents:**
- [The seven canonical layouts in detail](#the-seven-canonical-layouts-in-detail)
- [Inline, alt-screen, or overlay — where the UI lives](#inline-alt-screen-or-overlay--where-the-ui-lives)
- [Borders — when, what, and why](#borders--when-what-and-why)
- [Color in depth](#color-in-depth)
- [Typography in monospace](#typography-in-monospace)
- [Density: pack vs pad](#density-pack-vs-pad) (includes the clutter audit)
- [Responsive design — breakpoints and the floor](#responsive-design--breakpoints-and-the-floor)
- [Tables and lists](#tables-and-lists)
- [Status bars, headers, footers](#status-bars-headers-footers)
- [Progress indicators](#progress-indicators)
- [Theming systems](#theming-systems)
- [Common visual pitfalls](#common-visual-pitfalls)

---

## The seven canonical layouts in detail

1. **Persistent multi-panel** — all panels visible, focus shifts via Tab or numeric keys. Best for at-a-glance observation. Examples: lazygit, btop, htop.
2. **Miller columns** — parent → current → preview, `h`/`l` ascend/descend. Best for hierarchies. Examples: yazi, ranger, broot.
3. **Drill-down stack** — browser-style with back-stack, `Esc` returns. Best for many resource types. Examples: k9s, lazydocker.
4. **Widget dashboard** — independent widgets in grid, configurable layout. Best for monitoring. Examples: bottom, btop, glances.
5. **IDE three-panel** — sidebar → main → detail/output. Best for editor-like workflows. Examples: Posting, Harlequin, helix.
6. **Overlay / popup** — appears over shell, does one thing, exits. Examples: fzf, atuin.
7. **Tabbed within panel** — tab bars cycled with `[`/`]`. Best for one panel with multiple personalities.

## Inline, alt-screen, or overlay — where the UI lives

**Alt screen for apps you *live in*; inline for tools you *summon*.** Editors, file managers, dashboards belong on the alt screen. One-shot pickers, prompts, confirmations belong inline.

The fzf model: `--height 40%` renders inline, bounded, scrollback intact above. Chrome to stderr/TTY, answer to stdout.

## Borders — when, what, and why

Use single-line by default; rounded for Charm aesthetic; heavy sparingly for emphasis; **avoid double-line** (reads as DOS). Always provide ASCII fallback.

When to use borders: dynamic content boundary, focus state, adjacent panels needing separation. When to skip: static content, density matters, implicitly bounded.

**The background-leak problem**: border cells inherit the panel background. Solutions: same background for panel and borders, or one-eighth block characters.

## Color in depth

Design in three tiers: monochrome → 16 ANSI → 256/truecolor. Use semantic tokens (`status.error`, `text.muted`), not hex codes. Honor `NO_COLOR`. Pair color with letters or symbols for CVD safety (~8% of males).

**Conventional meanings:** green=success, red=error, yellow=warning, cyan/blue=info, magenta=special, dim/gray=secondary.

## Density: pack vs pad

**Pack** (htop, btop, k9s): tight rows, compact headers, abbreviations. Used when data is scanned at a glance.

**Pad** (gum, glow, Posting): generous spacing, one field per line. Used when reading prose or filling forms.

### The clutter audit

"It feels noisy" → make it countable:
1. **Border-nesting depth** — more than one border between edge and content is too many.
2. **Signals per piece of state** — count how many things encode the same fact. Keep one.
3. **Always-on markers** — a glyph on 100% of rows marks nothing. Reserve for exceptions.
4. **Chrome-to-data ratio** — cells spent on borders/labels vs actual data.
5. **The removal test** — "if I delete this, do I lose information?" If no, delete it.

## Responsive design — breakpoints and the floor

Pressure-test every layout at 80×24 and a 60-column tmux split.

**Wide (>120)**: full multi-panel.
**Standard (80–120)**: primary view full-width, details on drill-in.
**Narrow (60–80)**: single column. Multi-column layouts must fold to one pane.
**Too small (<60 or <24)**: clear "terminal too small" message.

Drill-down degrades better than a fixed grid.

## Tables and lists

- Numerics right, text left, dates fixed-width ISO-8601.
- Truncate don't wrap in cells. Tail-truncate paths (basename matters).
- Show count when filtering (`123/45678`).
- Sort indicators (`▲`/`▼`) on active column.
- Detail-on-Enter as the universal escape hatch.
- **Always virtualize** lists beyond a few hundred items.

## Status bars, headers, footers

**Header** (top): persistent context (app, dataset, mode).
**Status / mode line**: ephemeral feedback with auto-fade.
**Footer hint bar** (bottom): 3–5 most-useful shortcuts, updated per context. Auto-generate from keymap.

## Progress indicators

Spinners after ~150–200ms (Braille spinners are the default). Determinate progress bars with sub-cell precision (`▏▎▍▌▋▊▉█`). Multi-progress for parallel tasks. Pulse for background work. Empty/loading/error states with actionable messages.

## Theming systems

Semantic tokens → palette mappings as TOML/YAML/TCSS. Support community palettes: Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, Rose Pine, Solarized, base16. Light/dark auto-detection via OSC `]11;?` or `$COLORFGBG`.

## Common visual pitfalls

1. Hardcoded colors clashing with themes.
2. Decorative borders that don't earn their keep.
3. Color-only signaling.
4. Misaligned tables with CJK/emoji.
5. Over-bolding.
6. No visual focus indication.
