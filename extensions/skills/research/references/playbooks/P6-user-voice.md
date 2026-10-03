# P6 — user-voice

**Decision class.** Synthesize user/design/product feedback and UX research into themes and
recommendations.

**Scope domains:** `user-voice` (UX, design, product feedback).
**Answer category:** `trend-synthesis`, `pattern-recommendation`.

## Output contract

1. **Theme → evidence → frequency → recommendation.** One block per theme.
2. **Verbatim quotes only** — each theme's evidence is a literal quote with its source; a paraphrase
   is labelled a paraphrase, never presented as a quote.
3. **Sample description** — who was asked, how many, and what question, so the reader can judge
   representativeness.
4. **Recommendation** tied to the theme, not to a single data point.

## Verification rules (hard gate)

- Every theme stands on ≥2 independent signals; a single quote is an anecdote, not a theme.
- Quotes are literal and tool-grounded — never invented or lightly reworded.
- Frequency is counted, not estimated; the count is stated.
- The synthesis distinguishes what users *said* from what the researcher *infers*.

## Agent merge (process borrowed)

- `ux-researcher` — literal tool-grounded, no-fabrication rule.
- `design-ux-researcher` — design/UX evidence.
- `product-feedback-synthesizer` — feedback clustering into themes.

## Fail conditions

- An invented or reworded "quote".
- A theme resting on one signal.
- An estimated frequency presented as measured.
