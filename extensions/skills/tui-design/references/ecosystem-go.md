# Go ecosystem — Bubble Tea, tview, gocui, Cobra

The Go TUI landscape consolidated around two camps: the **Charm stack** (Bubble Tea + Lipgloss + Bubbles + Huh) for new projects, and **tcell + tview** for traditional widget-rich apps. **gocui** is a third lineage powering lazygit/lazydocker. CLI framing comes from **Cobra** (kubectl, gh, hugo, helm, docker) or `urfave/cli`.

## Quick recommendation

| If the user wants… | Use |
|---|---|
| Modern TUI with clean architecture and Charm aesthetic | **Bubble Tea + Lipgloss + Bubbles** |
| Multi-pane vim-keybinding "lazy*"-style app | **gocui** (`awesome-gocui/gocui` or `jesseduffield/gocui`) |
| Heavy data exploration with tables, trees, forms | **tview** (callback-style, retained-mode) |
| One-shot fancy CLI prompts only | **Huh** (Go form library) or **gum** (shell wrapper) |
| Markdown rendering in terminal | **Glamour** |
| Pretty CLI output, no full-screen | **pterm** |
| Subcommand framing for any of the above | **Cobra** or **urfave/cli** |
| TUI served over SSH | **Wish** (wraps Bubble Tea apps as SSH server) |

**Default choice for new projects: Bubble Tea + Lipgloss + Bubbles + Cobra.** This is what `charm.land` apps, `gh`, and most new Go TUIs use.

---

## Bubble Tea (charmbracelet/bubbletea)

The Elm Architecture in Go, and the most widely used Go TUI framework. Pure functional reactive — `Model → Update(Msg) → (Model, Cmd) → View() tea.View`.

**v2 is stable** (v2.0.0 shipped February 2026 after betas/RCs through 2025; current is v2.0.x). What changed and why it matters:
- **New "Cursed Renderer"** — rewritten from scratch on the ncurses diffing algorithm; faster and more accurate redraws. Bubble Tea now owns terminal I/O and Lipgloss became pure (no more I/O fights between the two).
- **Progressive keyboard enhancements** — with the Kitty protocol you can finally bind `shift+enter`, `ctrl+i` distinct from `tab`, `super+space`, etc. Always keep a legacy fallback.
- **Import path moved** to `charm.land/bubbletea/v2` (vanity domain over `github.com/charmbracelet/bubbletea/v2`). All Charm v2 libraries import from `charm.land/<name>/v2` — bubbletea, bubbles, lipgloss, huh, wish — keep them on the same major.

**Migrating v1 → v2:** the MVU shape survives, but every model gets touched: `View()` now returns `tea.View` instead of `string`, key handling moves to `tea.KeyPressMsg`, and the alt-screen/mouse program options moved onto the view. If you're on v1 and it works, there's no urgency; if you're starting fresh, start on v2.

**The mental model:**
- **Model**: a single struct holding all state.
- **Init**: returns the initial Cmd (or `nil`).
- **Update(msg)**: pure function returning `(newModel, Cmd)`. The only place state changes.
- **View()**: pure function returning the entire frame as a `tea.View` — content plus frame-level declarations (alt screen, mouse mode, cursor). Bubble Tea diffs against the previous frame and emits minimal ANSI.
- **Cmds and Msgs**: side effects live in `tea.Cmd` (a `func() tea.Msg`); messages flow back through Update.

**Canonical structure:**

```go
type model struct {
    count int
}

func (m model) Init() tea.Cmd { return nil }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    switch msg := msg.(type) {
    case tea.KeyPressMsg:
        switch msg.String() {
        case "q", "ctrl+c":
            return m, tea.Quit
        case "+", "right", "l":
            m.count++
        case "-", "left", "h":
            m.count--
        }
    }
    return m, nil
}

func (m model) View() tea.View {
    v := tea.NewView(fmt.Sprintf("Count: %d\n\nq quit · ←/→ change", m.count))
    v.AltScreen = true
    return v
}

func main() {
    p := tea.NewProgram(model{})
    if _, err := p.Run(); err != nil {
        log.Fatal(err)
    }
}
```

## Lipgloss (charmbracelet/lipgloss)

CSS-in-Go declarative styling — immutable `Style` values rendered to ANSI strings. The companion to Bubble Tea, but usable standalone.

**Canonical use:**

```go
var titleStyle = lipgloss.NewStyle().
    Bold(true).
    Foreground(lipgloss.Color("#FAFAFA")).
    Background(lipgloss.Color("#7D56F4")).
    Padding(0, 1).
    BorderStyle(lipgloss.RoundedBorder()).
    BorderForeground(lipgloss.Color("63"))

fmt.Println(titleStyle.Render("Hello, world"))
```

## Bubbles (charmbracelet/bubbles)

The component library for Bubble Tea. Each Bubble is itself a `tea.Model` you embed and forward messages to.

## Huh (charmbracelet/huh)

Forms library on top of Bubble Tea. Best for one-shot interactive prompts.

## Other Charm libraries worth knowing

- **Glamour** — render Markdown to ANSI.
- **Wish** — serve Bubble Tea apps over SSH.
- **gum** — shell-script wrapper around Bubble Tea components.
- **VHS** — record terminal sessions to GIFs.

## tview (rivo/tview)

Retained-mode, callback-based — the traditional ncurses style. Built on **tcell**. Powers **k9s**.

## gocui (awesome-gocui/gocui)

Minimalist views-as-buffers — each `View` implements `io.Writer`. The aesthetic of **lazygit** and **lazydocker**.

## CLI framing: Cobra and urfave/cli

**Cobra** (`spf13/cobra`) — the dominant subcommand framework for Go. Powers kubectl, gh, hugo, helm, docker.

## Testing

**Test in layers, bottom-heavy.** Unit tests on `Update` are pure functions — no harness needed. `teatest` for integration with in-memory buffers. Golden files for frame snapshots, always pinned to a specific color profile and term size.

## Debugging

`tea.LogToFile("debug.log", "debug")` — stdout is off-limits in raw mode.

---

For deeper patterns shared across Go apps, see `references/visual-patterns.md` and `references/interaction-patterns.md`.
