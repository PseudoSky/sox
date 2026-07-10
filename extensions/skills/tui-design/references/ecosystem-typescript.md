# TypeScript / JavaScript ecosystem — Ink, Clack, Inquirer

The Node.js ecosystem splits along two axes:
- **Pretty CLI** (argparse + color + prompts/spinners) vs **full TUI**.
- **Imperative/retained-mode** vs **declarative/React-style**.

**Ink has effectively won the high-end TUI space.** It powers Claude Code, GitHub Copilot CLI, Gemini CLI, Cloudflare Wrangler, Gatsby CLI, Prisma, Shopify CLI, Linear's internal CLI, Canva CLI, and tap. Anthropic's Claude Code is publicly TypeScript + React + Ink + Yoga + Bun.

## Quick recommendation

| If the user wants… | Use |
|---|---|
| Full-screen TUI app | **Ink** (React-flexbox) |
| Modern Clack-style wizard prompts | **@clack/prompts** |
| Prompt-heavy CLI (many questions) | **@inquirer/prompts** |
| Single elegant spinner | **ora** |
| Hierarchical task runner | **listr2** |
| Argparse, simple | **commander** |
| Terminal colors, performance-critical | **picocolors** |
| Terminal colors, classic API | **chalk** |
| Beyond Ink's perf ceiling | **OpenTUI** (Zig-backed, v0.x) |

**Default full-TUI stack: Ink + @inkjs/ui + zustand + commander + ink-testing-library.**

---

## Ink (vadimdemedes/ink)

**Architectural model: React for the terminal.** A custom `react-reconciler` renderer that commits to terminal-native host nodes, runs Yoga layout, paints into a screen buffer, diffs against the previous frame, and emits ANSI patches in a single buffered terminal write.

Current major: **Ink 7** (7.1.x as of mid-2026), which requires **Node ≥ 22 and React 19**.

**Hello world:**

```tsx
import React, {useState} from 'react';
import {render, Text, Box, useInput, useApp} from 'ink';

const App = () => {
  const [n, setN] = useState(0);
  const {exit} = useApp();

  useInput((input, key) => {
    if (key.upArrow) setN(c => c + 1);
    if (key.downArrow) setN(c => c - 1);
    if (input === 'q') exit();
  });

  return (
    <Box borderStyle="round" padding={1}>
      <Text color="green">Counter: {n}</Text>
    </Box>
  );
};

render(<App />);
```

### Primitives

- **`<Text>`** — only place strings can live.
- **`<Box>`** — flexbox container with full Yoga props.
- **`<Static>`** — renders items permanently above the live UI.
- **`<Transform>`** — wraps children and transforms rendered string.

### Hooks

`useInput`, `useApp`, `useStdin`, `useStdout`, `useStderr`, `useFocus`, `useFocusManager`, `useWindowSize`, `usePaste`, `useCursor`, `useAnimation`, `useBoxMetrics`.

### ink-ui

Companion component library: `<TextInput>`, `<Select>`, `<MultiSelect>`, `<Spinner>`, `<ProgressBar>`, `<Badge>`, `<StatusMessage>`, `<Alert>`.

### Testing — ink-testing-library

```tsx
import {render} from 'ink-testing-library';

const {lastFrame, stdin} = render(<App />);
expect(lastFrame()).toBe('Counter: 0');
```

### Pitfalls

1. **Strings as direct children of `<Box>` throw.** Wrap in `<Text>`.
2. **Ink 7 requires Node 22 and React 19.**
3. **Cell width**: use `string-width`, never `.length`.

---

## Modern prompts: @clack/prompts

Stable at 1.x under bombshell-dev org. Used by **create-vite, create-astro, create-svelte, create-t3-app**.

```ts
import {intro, outro, text, select, spinner, isCancel, cancel} from '@clack/prompts';

intro('create-my-app');
const name = await text({
  message: 'Project name',
  validate: v => v.length === 0 ? 'Required' : undefined,
});
const s = spinner();
s.start('Installing dependencies');
s.stop('Dependencies installed');
outro(`You're all set!`);
```

## @inquirer/prompts

Modular rewrite of Inquirer — TypeScript-first.

## Argument parsers

| Parser | Best for |
|---|---|
| **commander** | The default (~400M+ weekly) |
| **yargs** | Best validation |
| **citty** | TS-first, UnJS ecosystem |
| **oclif** | Plugin marketplace (Heroku, Salesforce) |

## OpenTUI (anomalyco/opentui)

TypeScript bindings over a Zig native core. Double-buffered rendering, Three.js WebGPU → terminal. Powers **opencode**. Choose for pushing past Ink's performance ceiling.

---

## Notable JS/TS TUI apps to study

- **Claude Code** (Anthropic) — Ink + React.
- **GitHub Copilot CLI** — Ink.
- **opencode** (Anomaly) — OpenTUI.

## Stack recommendations by project shape

- **Simple non-interactive CLI**: `commander + picocolors + ora`
- **Interactive setup wizard**: `@clack/prompts + picocolors + commander`
- **Full TUI app**: `ink + @inkjs/ui + zustand + commander`
- **Performance-critical TUI**: `@opentui/react`

---

For deeper patterns shared across apps, see `references/visual-patterns.md` and `references/interaction-patterns.md`.
