# Rust ecosystem — Ratatui, crossterm, Cursive, clap

Ratatui dominates Rust TUI development — thousands of crates build on it. Forked from `tui-rs` in February 2023. Notable production users: **gitui, bottom, yazi, atuin, bandwhich, oha, tokio-console, csvlens, gpg-tui, systemctl-tui, tenere, kdash**. Helix uses its own custom renderer but follows similar patterns.

## Quick recommendation

| If the user wants… | Use |
|---|---|
| Modern TUI in Rust | **Ratatui + Crossterm** |
| Form-heavy app with dialogs/menus | **Cursive** (callback-driven, retained-mode) |
| React-like declarative TUI | **iocraft** (newer, hooks + JSX-style + taffy flexbox) |
| Argparse for CLI | **clap** (derive API) |
| Pretty terminal colors | **owo-colors** (zero-allocation, recommended) |
| Non-TUI progress bars | **indicatif** |
| Interactive prompts (one-shot) | **inquire** (modern) or **dialoguer** (stable) |
| Rich panic/error reports | **color-eyre** |

**Default: Ratatui + Crossterm + clap + color-eyre.**

---

## Ratatui (ratatui/ratatui)

**Architectural model: immediate-mode rendering.** Every frame, the application redraws the entire UI from current state. The library handles diffing between intermediate buffers and emits only changed cells — "a video codec for text."

**Canonical app structure:**

```rust
use ratatui::{prelude::*, widgets::*};
use color_eyre::Result;

fn main() -> Result<()> {
    color_eyre::install()?;
    let mut terminal = ratatui::init();
    let result = App::default().run(&mut terminal);
    ratatui::restore();
    result
}

#[derive(Default)]
struct App {
    counter: i32,
    should_quit: bool,
}

impl App {
    fn run(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        while !self.should_quit {
            terminal.draw(|frame| self.draw(frame))?;
            self.handle_events()?;
        }
        Ok(())
    }

    fn draw(&self, frame: &mut Frame) {
        frame.render_widget(
            Paragraph::new(format!("Counter: {}", self.counter))
                .block(Block::bordered().title("Demo")),
            frame.area(),
        );
    }

    fn handle_events(&mut self) -> Result<()> {
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                match key.code {
                    KeyCode::Char('q') => self.should_quit = true,
                    KeyCode::Char('+') | KeyCode::Right => self.counter += 1,
                    KeyCode::Char('-') | KeyCode::Left => self.counter -= 1,
                    _ => {}
                }
            }
        }
        Ok(())
    }
}
```

### Layout

Constraint-based using Cassowary:

```rust
let [header, body, status] = Layout::vertical([
    Constraint::Length(3),
    Constraint::Min(0),
    Constraint::Length(1),
]).areas(frame.area());
```

### Testing

`TestBackend` lets you assert against rendered output:

```rust
let backend = TestBackend::new(20, 5);
let mut terminal = Terminal::new(backend)?;
terminal.draw(|f| app.draw(f))?;
terminal.backend().assert_buffer_lines([
    "┌─ Demo ───────────┐",
    "│Counter: 0        │",
    "└──────────────────┘",
]);
```

### Panic safety — the critical pattern

```rust
let panic_hook = std::panic::take_hook();
std::panic::set_hook(Box::new(move |info| {
    let _ = ratatui::restore();
    panic_hook(info);
}));
```

### Pitfalls

1. **Panic without terminal restore.** Use the panic hook pattern.
2. **Crossterm version skew.** Run `cargo tree -p crossterm`.
3. **On Windows, filter `KeyEventKind::Press`** to avoid double-fire.
4. **`String::len()` is bytes, not cells.** Use `unicode_width` for display width.

---

## Notable Rust TUI apps to study

- **gitui** — git client.
- **bottom** (btm) — system monitor; widget dashboard.
- **yazi** — file manager; miller columns.
- **atuin** — shell history; fzf pattern.
- **zellij** — terminal multiplexer.

For deeper patterns shared across apps, see `references/visual-patterns.md` and `references/interaction-patterns.md`.
