# Design System & Visual Language

The concern that spans every stack: how the product's visual language is defined once,
themed, consumed, and handed off. Load this for token, theming, component-library, or
visual-design work — and when translating a design document into implementation.

## Tokens — the single source of truth

- **One definition, many consumers.** Every design value (color, typography, spacing,
  radius, elevation, motion, breakpoints) is a named token defined once. Components and
  styles consume tokens; a literal design value in a component is a defect.
- **Layer the tokens.** Primitive tokens (raw palette and scales) → semantic tokens
  (role names: `surface`, `on-surface`, `danger`, `focus-ring`) → component tokens where a
  component needs a local knob. Components bind to semantic tokens, never to primitives.
- **Naming is a contract.** A stable, readable name per role; renaming a token is a
  breaking change. Ship the token set in the format each stack consumes (CSS custom
  properties, TS object, platform theme) generated from the one source — never hand-edited
  per platform.
- **Theme by swapping the semantic layer.** Light, dark, and system themes redefine the
  semantic tokens; component code does not change. Support the system preference and an
  explicit override.

## Visual language

- **Hierarchy and rhythm.** Establish a type scale and a spacing scale; use them, not
  ad-hoc values. One primary action per view.
- **Depth and elevation.** Define an elevation scale (shadow/border/surface) rather than
  per-component shadows.
- **Motion.** A small set of purposeful durations and easings as tokens; motion clarifies
  state change, never decorates. Honor `prefers-reduced-motion` (and the native
  equivalent).
- **Color and contrast.** Every foreground/background pair meets WCAG 2.2 AA contrast;
  never signal meaning by color alone.
- **Responsive.** Mobile-first breakpoints as tokens; layouts reflow, not just shrink.
- **The forgotten states.** Loading, empty, error, and disabled are designed for every
  data-bearing component — not discovered in review.

## Component library

- Primitives → composed components → patterns/recipes, one level of reuse.
- Every component: typed props, documented variants, the states above, tokens only,
  accessible by default (roles, labels, focus, keyboard).
- Ship the library as a package so apps consume one build; version it; keep a changelog.

## DESIGN.md → implementation (design handoff)

When the product has a design document (or a reference site), translate it — do not
improvise a visual language:

1. **Extract** the real values: color palette with roles (name → hex → role), type scale,
   spacing, radii, shadows, motion. Capture numbers, not adjectives.
2. **Synthesize** a quick reference: colors, typography, component stylings, layout
   principles, depth, responsiveness — the sections a developer needs.
3. **Emit** implementation instructions: a color reference (name → token → role), example
   component prompts, and the token export for the stack.
4. **Do not invent** brand intent. If a value or intent is genuinely ambiguous, ask;
   otherwise decide and proceed, and record the decision.

## Design QA

Before handoff: verify the built UI against the intended language — tokens used (no
literals), contrast and keyboard paths pass a real engine, responsive at the target
breakpoints, dark/system themes render, and the states exist. Report what you checked and
with which tool.
