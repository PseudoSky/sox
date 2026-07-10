# Python ecosystem — Textual, Rich, prompt_toolkit

Three tools occupy distinct niches: **Textual** (the modern reactive TUI framework — async-first, CSS-styled, web-deployable), **Rich** (output formatting — the rendering engine inside Textual, excellent standalone), and **prompt_toolkit** (input-focused REPLs and shells — powers IPython, ptpython, mycli/pgcli/litecli).

## Quick recommendation

| If the user wants… | Use |
|---|---|
| Full-screen TUI app | **Textual** |
| CLI tool with pretty output (tables, panels, syntax) | **Rich** |
| Interactive REPL or shell-like tool | **prompt_toolkit** |
| One or two prompts inside a CLI | **questionary** or **InquirerPy** |
| Argparse with type hints | **Typer** (decorator API on Click) |
| Simple progress bar | **tqdm** or **alive-progress** |

**Default for full TUI: Textual. Default for fancy CLI output: Rich.**

---

## Textual (Textualize/textual)

**Architectural model: reactive, async-first, message-passing.** Strongly inspired by web frameworks. App subclass + Widgets in a DOM-like tree + TCSS for layout/style + reactive attributes for state + Messages/Events for communication, all on asyncio.

**Status:** Textualize the company wound down in mid-2025; Will McGugan maintains Textual and Rich as open source. Release cadence continues (8.x current as of mid-2026).

**Canonical structure:**

```python
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Button, Label

class HelloApp(App):
    CSS_PATH = "hello.tcss"
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("d", "toggle_dark", "Toggle dark mode"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Label("Hello, world!", id="greeting")
        yield Button("Click me", id="go", variant="success")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.query_one("#greeting", Label).update("Button pressed!")

if __name__ == "__main__":
    HelloApp().run()
```

### Widgets

**Data:** `DataTable` (cell/row/column cursors, sortable, virtualized — handles thousands of rows), `Tree`, `DirectoryTree`, `ListView` + `ListItem`.

### Layout — TCSS

CSS-based layout with vertical/horizontal/grid containers, fractional units (`1fr`), and docking.

### Events and messages

Two ways: name convention (`on_button_pressed`) or `@on` decorator with CSS selector.

### Reactive state

`reactive` attributes with automatic `watch_*`, `validate_*`, `compute_*` methods.

### Testing — Pilot + pytest-textual-snapshot

```python
async def test_button_click():
    app = HelloApp()
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.press("tab", "enter")
        await pilot.pause()
        assert app.query_one("#result", Static).content == "Done"
```

### Dev tools

`textual run --dev` for hot-reload; `textual console` for logging; `textual serve` for browser access.

### Notable Textual apps

- **Toad** — universal terminal UI for agentic coding.
- **Posting** — HTTP client (Postman alternative).
- **Harlequin** — SQL IDE.
- **Toolong** — log viewer for multi-GB files.

---

## Rich (Textualize/rich)

Immediate-mode output formatting — no input handling, no event loop. The de facto Python library for pretty CLI output.

```python
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

console = Console()
console.print("[bold red]Error:[/] file not found")
```

**Use Rich vs Textual:** Rich is for tools that *print and exit*. Textual is for apps the user *lives inside*.

## prompt_toolkit

For REPLs and shells where typing commands with completion/history/syntax highlighting is the central interaction.

## Other libraries

- **Urwid** — pre-Textual TUI framework; v4.0 in 2026 but new projects should still use Textual.
- **Blessed** — modernized curses wrapper.
- **click** / **typer** — CLI arg parsing (use Typer for new projects).
- **questionary** / **InquirerPy** — one-shot prompts.

---

For deeper patterns shared across apps, see `references/visual-patterns.md` and `references/interaction-patterns.md`.
