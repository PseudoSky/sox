# Exemplar apps — what makes specific TUIs great

Concrete case studies. When the user asks "how should I lay out my dashboard" or "how do I handle drilling into resources" or "what makes lazygit feel so good," point at one of these.

## How to use this file

When the user asks about a design choice and you're unsure of the answer, find the analogous case here:

- "How should I lay out a dashboard?" → btop, bottom, htop.
- "How should drilling-down work?" → k9s, lazydocker.
- "How should I make searching fast?" → fzf, atuin.
- "How do I handle a million-row table?" → Harlequin, Toolong.
- "How should help/discovery work?" → htop's F-keys, helix's which-key, lazygit's footer.
- "How do I keep my AI chat smooth at high token rates?" → Claude Code, Copilot CLI.
- "What's the spec for my undo system?" → lazygit's git-action stack.
- "How should mouse work in my TUI?" → btop (full mouse), helix (none), lazygit (augmentation).
- "How fast does my prompt picker need to be?" → fzf (<100ms), starship (<50ms).
- "What does a polished setup wizard look like?" → @clack/prompts (create-vite, create-astro).
- "How do I theme well?" → btop, bottom, helix, Posting (community palette support).

**Entries, grouped:**
- Git: [lazygit](#lazygit-go-gocui) · [gitui](#gitui-rust-ratatui)
- Kubernetes / Docker: [k9s](#k9s-go-tview) · [lazydocker](#lazydocker-go-gocui)
- Monitors: [btop / btop++](#btop--btop-c-rust-clone-as-bottom) · [bottom / btm](#bottom--btm-rust-ratatui) · [htop](#htop-c-ncurses)
- Pickers and search: [fzf](#fzf-go) · [atuin](#atuin-rust-ratatui)
- Editors: [helix](#helix-rust-custom-renderer) · [neovim](#neovim-c--lua)
- File managers: [yazi](#yazi-rust-ratatui) · [ranger / lf / nnn / broot](#ranger--lf--nnn--broot)
- IDE-style apps: [Posting](#posting-python-textual) · [Harlequin](#harlequin-python-textual)
- Viewers: [Toolong](#toolong-python-textual) · [Glow](#glow-go-bubble-tea)
- Chat-style AI tools: [Claude Code / Copilot CLI / Gemini CLI](#claude-code-github-copilot-cli-gemini-cli-typescript-ink)
- CLI output discipline: [starship](#starship-rust-no-ui-framework) · [yt-dlp / aria2](#yt-dlp--aria2)

---

## lazygit (Go, gocui)
Multi-pane git client. Numeric panel jumps (`1`–`5`), context-sensitive single letters, per-pane footer hints, undo/redo for git operations.

## k9s (Go, tview)
Kubernetes TUI. Command mode (`:pods`) with tab-completion, drill-down stack, status-header showing current "address."

## btop / btop++ (C++; Rust clone as bottom)
System monitor. Widget dashboard with independent update loops, truecolor gradient meters, TOML theme system, full mouse support.

## fzf (Go)
The fuzzy finder. Sub-100ms response, `--preview` for inline context, composable via stdin/stdout, smart-case filtering.

## helix (Rust, custom renderer)
Modal editor. Selection-first (`wd` selects-word-then-deletes), multi-cursor as primary, which-key popup on `Space`, Tree-sitter integration.

## yazi (Rust, Ratatui)
File manager. Miller columns, async I/O everywhere, image preview via Sixel/kitty/iTerm2, Vim-style keybindings, Lua plugins.

## atuin (Rust, Ratatui)
Shell history replacing Ctrl+R. Fuzzy filter with metadata (when, where, exit code), encrypted sync, dual CLI + TUI from same core.

## htop (C, ncurses)
Process viewer. F1–F10 strip always visible — the best discoverability pattern for 10 actions. Tree mode, sortable columns, mouse augmentation.

## Posting (Python, Textual)
HTTP client. Empty states explain next action ("No requests. Press `n` to create one."), theme switching at runtime, both vim and emacs bindings.

## Harlequin (Python, Textual)
SQL IDE. Multi-adapter (DuckDB, Postgres, MySQL, SQLite, Snowflake, BigQuery), Tree-sitter SQL highlighting, virtualized million-row results.

## Toolong (Python, Textual)
Log viewer for multi-GB files. Virtualization for huge files, real-time tailing, regex filter, multi-file merge by timestamp.

## starship (Rust)
Cross-shell prompt. Sub-50ms cold start, async git status, single TOML config, cross-shell. The performance discipline to study.

## Claude Code / GitHub Copilot CLI / Gemini CLI (TypeScript, Ink)
AI coding assistants. Streaming text via `<Static>` for finalized history, slash commands, inline diff rendering, status indicators.

---

For abstract principles, see `visual-patterns.md` and `interaction-patterns.md`. This file is the case-study companion — concrete examples beat abstract principles for design questions.
