# @adhd/sox-authoring

Pure scaffold core for soxe extensions: `scaffold(opts)` takes a type and an id and returns a
complete, ready-to-install file set — no filesystem access, no build tooling, no Nx dependency.
Call `writeFileSet` when you're ready to put the result on disk. This is the same engine the
`soxe init` CLI command uses, exposed as a library for anyone scaffolding extensions
programmatically.

```bash
pnpm add @adhd/sox-authoring
```

## Quick start

```typescript
import { scaffold, writeFileSet } from '@adhd/sox-authoring';

const fileSet = scaffold({
  type: 'skill',
  id: 'my-helper',
  title: 'My Helper',
  description: 'Use this when the user needs help with X',
});

console.log(Object.keys(fileSet));
// ['extension.json', 'package.json', 'SKILL.md', 'CHANGELOG.md', 'README.md']

writeFileSet(fileSet, './my-helper');
// writes every entry above to ./my-helper/<relative-path>, creating directories as needed
```

## API reference

### `scaffold(opts): FileSet`

Generates a complete, born-conformant file set for the given extension type. The returned
`extension.json` validates against the soxe manifest schema as-is — no post-processing required.

```typescript
type FileSet = Readonly<Record<string, string>>; // relative path → file content

type ActiveType = 'agent' | 'skill' | 'mcp-server' | 'hook' | 'command' | 'bundle' | 'service';

const ACTIVE_TYPES: ReadonlyArray<ActiveType>;

function scaffold(opts: ScaffoldOpts): FileSet; // throws if type/id is invalid
```

`scaffold` throws when `opts.id` fails validation — see `validateId` below — rather than emitting
a broken file set:

```typescript
scaffold({ type: 'skill', id: 'Bad_ID', description: 'x' });
// throws: 'scaffold: invalid id — id "Bad_ID" must match ^[a-z][a-z0-9-]*$'
```

### `ScaffoldOpts`

Only `type` and `id` are required; everything else has a sensible default or is omitted from the
output when absent.

```typescript
interface ScaffoldOpts {
  /** One of the 7 active types. 'prompt' is intentionally not accepted here — see below. */
  type: ActiveType;
  /** Extension id: must match ^[a-z][a-z0-9-]*$ and must NOT end with the type name. */
  id: string;
  /** Human-readable title. Defaults to id when omitted. */
  title?: string;
  /** One-line description. Defaults to "<id> extension" when omitted. */
  description?: string;
  /** Author string — written to extension.json and package.json. */
  author?: string;
  /** Keywords array — written to extension.json. */
  keywords?: string[];

  // Content / provenance
  content?: string;   // body text read from a source path at init time
  source?: string;    // origin path, stamped into install.source for later re-pull

  // Install descriptor
  hosts?: string[];               // chosen host targets, e.g. ['claude', 'codex']
  scope?: string;                 // install scope override: project | user | local
  permissions?: Record<string, unknown>;
  env?: Record<string, string>;

  // mcp-server specific
  transports?: string[];          // stdio | sse | http
  profile?: string;                // install-layer preset, e.g. standalone | shared
  trust?: string;                  // prompt | auto

  // command specific
  surface?: string;                // e.g. claude-commands | codex-commands

  // prompt specific (prompt type itself is parked — see below)
  inject?: string;                 // rules | claude-md

  // bundle specific
  /** "<type>:<member-id>" pairs — scaffolds member extensions under members/. */
  members?: Array<{ type: string; id: string }>;
}
```

Fields you omit are resolved with defaults (`title` → `id`, `description` → `"<id> extension"`)
before being handed to the type-specific template; every other Appendix-A field is forwarded
verbatim and shows up in the emitted `extension.json`'s install descriptor when present.

### `writeFileSet(fileSet, outDir): void`

```typescript
function writeFileSet(fileSet: FileSet, outDir: string): void;
```

Writes every entry to `outDir`, creating parent directories as needed and overwriting anything
already there. Pure Node `fs`, synchronous, no return value.

### `validateId(id, type): string | null`

```typescript
function validateId(id: string, type: ActiveType): string | null;
```

Returns `null` when `id` is valid, or a human-readable error string otherwise. This is the same
check `scaffold` runs internally — call it directly when you want to validate user input before
attempting to scaffold:

```typescript
import { validateId } from '@adhd/sox-authoring';

validateId('my-helper', 'skill');   // null — valid
validateId('my-skill', 'skill');    // "id \"my-skill\" must not end with the type name \"skill\""
validateId('My_Helper', 'skill');   // "id \"My_Helper\" must match ^[a-z][a-z0-9-]*$"
```

## The 7 active types

```typescript
ACTIVE_TYPES; // ['agent', 'skill', 'mcp-server', 'hook', 'command', 'bundle', 'service']
```

| Type | Runtime | Builds? |
|------|---------|---------|
| `agent` | declarative | no |
| `skill` | declarative | no |
| `mcp-server` | node | yes |
| `hook` | shell (or node) | no |
| `command` | node (or python) | yes |
| `bundle` | declarative | no |
| `service` | node | yes |

`prompt` is an eighth manifest type recognized by the wider soxe ecosystem, but it is **not** in
`ACTIVE_TYPES` — there is no active template for it (parked by design, not yet wired into the
authoring path). Passing `type: 'prompt'` to `scaffold` is unsupported: stick to the 7
`ACTIVE_TYPES` above.

## Bundle scaffolding

Passing `members` scaffolds a `bundle` extension whose member extensions are generated inline
under `members/<member-id>/`, each with `visibility: "internal"`:

```typescript
const fileSet = scaffold({
  type: 'bundle',
  id: 'my-toolkit',
  description: 'A toolkit bundling a skill and an mcp-server',
  members: [
    { type: 'skill', id: 'toolkit-helper' },
    { type: 'mcp-server', id: 'toolkit-server' },
  ],
});
```

## Design

- **Nx-free** — zero `@nx/devkit` or Nx-package imports anywhere in this package's dependency
  graph, so `scaffold`/`writeFileSet` run standalone outside an Nx workspace.
- **Host-agnostic output** — `scaffold` never writes a literal install path (no hardcoded
  `~/.claude/skills/<id>/`); it emits an `install` descriptor (type, hosts, scope) that a host
  registry resolves to a concrete target at install time.
- **Pure and synchronous** — `scaffold` does no I/O at all and is safe to call repeatedly with the
  same inputs; `writeFileSet` is the only function that touches disk.
