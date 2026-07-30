# Content-First Architecture — Implementation

> **The implementation that produced the experimental data.** Four scripts + one shared library, all tested against the DeepSeek API with real opencode agent prompts.

---

## Architecture

```
docs/research/content-first/
├── lib/deepseek-experiment.mjs        ← Shared library (API client + runners + session writer)
├── scripts/
│   ├── content-first-proof.mjs        ← Comprehensive experiment (6 scenarios)
│   ├── content-first-tests.mjs        ← Hypothesis test suite (H1-H10)
│   ├── content-first-verify.mjs       ← Quick smoke test
│   └── content-first-mcp.mjs          ← JSON output for CI
└── sessions/                          ← 22 session files with full I/O
```

All scripts import the shared library. No external dependencies beyond Node.js 18+ and `DEEPSEEK_API_KEY`.

---

## Shared Library: `lib/deepseek-experiment.mjs`

### API Client

```javascript
import { deepseekCall } from './lib/deepseek-experiment.mjs';

// Role-first (system prompt at position 0)
const rf = await deepseekCall({
    system: "You are an architect...",   // position 0 = cache anchor
    messages: [{ role: 'user', content: '<artifact>' }]
});

// Content-first (no system, artifact at position 0)
const cf = await deepseekCall({
    messages: [{ role: 'user', content: '<artifact>\n\nYou are an architect...' }]
});
//                                            artifact at pos 0 ^        ^ role at end
```

Two lines different. That's the entire pattern.

### Runners

Four runners, two modes:

| Runner | Mode | Behavior | Cache anchor |
|--------|------|----------|-------------|
| `runRF(scenario)` | Chain (sequential) | `system=[role]` + growing `user=[artifact+outputs]` | System prompt — changes per role |
| `runCF(scenario)` | Chain (sequential) | `user=[artifact+outputs+\n\nrole suffix]` | Artifact — same across rounds |
| `runForkRF(scenario)` | Fork (parallel) | `system=[role]` + `user=[artifact]` (identical seed) | System prompt — unique per role |
| `runForkCF(scenario)` | Fork (parallel) | `user=[artifact+\n\nrole suffix]` (identical prefix) | Artifact — shared across all agents |

Each runner returns `{ results: RoundResult[] }`. Each `RoundResult` captures:
- `inputTokens`, `cacheHit`, `uncachedInput` — from the API usage response
- `inputContent` — the exact string sent to the API
- `text` — the model's response

### Session Writer

```javascript
import { writeSession } from './lib/deepseek-experiment.mjs';

const filePath = writeSession(scenario, rfResults, cfResults, 'experiment-name');
// Writes to sessions/<timestamp>-<scenario>-<name>.json
```

Each session file contains the full input and output for every round of both paradigms — 22 session files in `sessions/`.

### Real System Prompts

```javascript
import { OPENCODE_AGENTS, makeRound } from './lib/deepseek-experiment.mjs';

// makeRound(agentKey, roleSuffix) produces:
//   { name, label, sysPrompt: OPENCODE_AGENTS[key], roleSuffix: suffix }

const scenario = {
    seed: '<artifact content>',
    rounds: [
        makeRound('architect', 'You are a spec-only architecture agent. Review the design.'),
        makeRound('review',    'You are a senior code reviewer. Review for security issues.'),
        makeRound('backend',   'You are a senior backend developer. Assess scalability.'),
        makeRound('product',   'You are a senior product manager. Evaluate market impact.'),
    ]
};
```

`OPENCODE_AGENTS` loads the real agent definitions from `~/.config/opencode/agents/*.md` — ~3,000-5,000 tokens each, with YAML frontmatter stripped.

---

## Scripts

### `content-first-proof.mjs` — Comprehensive Experiment

```bash
# Run the 6-round sequential scenario against DeepSeek
node scripts/content-first-proof.mjs --scenario 6 --mode deepseek

# Run simulation (arithmetic projection, no API calls)
node scripts/content-first-proof.mjs --scenario 1 --mode simulation

# List available scenarios
node scripts/content-first-proof.mjs --list
```

6 scenarios, each with 4-6 roles. Scenarios use real artifacts from the codebase (namespace isolation spec, supervisor state machine, protocol decisions) and real opencode agent system prompts.

### `content-first-tests.mjs` — Hypothesis Test Suite

```bash
# Run all 10 hypotheses
node scripts/content-first-tests.mjs

# Run one hypothesis
node scripts/content-first-tests.mjs --test H1

# List hypotheses
node scripts/content-first-tests.mjs --list
```

10 hypotheses, each asserting a specific claim about cache behavior:

| H# | Claim | Expected |
|----|-------|----------|
| H1 | RF zero cache across role switches | 0/3 role switches had cache |
| H2 | CF non-zero cache for subsequent rounds | ≥2/3 had cache |
| H3 | CF fewer uncached tokens overall | CF uncached < RF uncached |
| H4 | RF same-role repeats get cache hits | ≥1/2 architect repeats cached |
| H5 | CF cache grows monotonically | Each round caches ≥ prior |
| H6 | CF subsequent-round hit rate >50% | >50% of input cached |
| H7 | RF uncached tokens grow per round | Monotonically increasing |
| H8 | CF uncached tokens stable after R1 | Variance < 400t |
| H9 | First-round costs comparable | Ratio < 2× |
| H10 | No refusals in either paradigm | 0 refusals |

### `content-first-verify.mjs` — Quick Smoke Test

```bash
node scripts/content-first-verify.mjs
```

Runs 1 scenario (4 rounds), prints cache comparison and verification checks. Fastest feedback loop.

### `content-first-mcp.mjs` — JSON Output

```bash
# Pretty-print JSON
node scripts/content-first-mcp.mjs --pretty

# Write to file
node scripts/content-first-mcp.mjs --output results.json
```

Structured JSON output for programmatic consumption. Same data as the other scripts but in parseable format.

---

## Scenario Definition Format

All scripts share the same scenario interface:

```javascript
{
    name: 'Scenario Name',
    seed: 'The shared artifact content that every agent receives.',
    rounds: [
        {
            name: 'AgentName',          // Used for repeat detection
            label: 'Display Label',     // Used in output
            sysPrompt: 'Real agent definition...',  // Role-first: at position 0
            roleSuffix: 'You are...',   // Content-first: at end of user message
        }
    ]
}
```

The `seed` is the shared content. The `rounds` define each agent. Each agent gets the same seed (fork mode) or seed + accumulated outputs (chain mode).

---

## Running Your Own Experiments

```bash
export DEEPSEEK_API_KEY="sk-..."

# Quick test
cd docs/research/content-first
node scripts/content-first-verify.mjs

# Full experiment with a custom scenario
node --input-type=module -e "
import { runForkRF, runForkCF, writeSession, OPENCODE_AGENTS } from './lib/deepseek-experiment.mjs';
const s = {
    name: 'My Test',
    seed: 'Some shared artifact content.',
    rounds: [
        { name: 'A', label: 'Agent A', sysPrompt: OPENCODE_AGENTS.architect, roleSuffix: 'You are an architect. Review. Output 1 sentence.' },
        { name: 'B', label: 'Agent B', sysPrompt: OPENCODE_AGENTS.review, roleSuffix: 'You are a reviewer. Review. Output 1 sentence.' },
    ],
};
const { results: rf } = await runForkRF(s);
const { results: cf } = await runForkCF(s);
rf.forEach(r => console.log(r.summary('RF')));
cf.forEach(r => console.log(r.summary('CF')));
"
```

---

## Key Metrics

From the definitive fork experiment (fresh UUID seed, 4 real opencode agents, no prefix):

| Metric | RF | CF |
|--------|----|----|
| Total input | 16,338t | 4,417t |
| Uncached | 4,562t (4× seed) | 1,345t (seed + 3× suffix) |
| Cached | 11,776t (system prompts) | 3,072t (seed content) |
| Cost | $0.0029 | $0.0012 |
| Savings | — | **60.3%** |

See `RESUME.md` for complete methodology and `sessions/` for raw session data.
