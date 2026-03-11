---
name: convit-setup
description: >
  Scans a codebase and generates a .convitrc.json configuration file for the
  convit AI commit CLI. Use when a user asks to set up convit, configure commit
  scopes, initialize convit, run convit init, or customize how convit analyzes
  their project.
argument-hint: "[path to project root, or empty for current directory]"
---

# convit Setup

Generates a `.convitrc.json` tailored to the actual structure of the codebase.
Works in three phases: scan the filesystem for structure signals, ask the user
to confirm or adjust what was found, then write the config.

Never include a `provider` block. API credentials (`CONVIT_URL`, `CONVIT_KEY`,
`CONVIT_MODEL`) belong in `.env` only. The config file is safe to commit.

For the full semantics of every variable, see [config-reference.md](config-reference.md).

---

## Phase 1 — Scan

Check whether each of the following paths or files exists in the project root.
Record every signal that fires — a project can match multiple.

| Signal | Implication |
|--------|-------------|
| `src/features/` exists | Next.js FSD — primary scope pattern, weight 10 |
| `packages/` with 2+ subdirectories | Monorepo — workspace scope pattern, weight 10 |
| `apps/` with 2+ subdirectories | Monorepo (apps convention) — workspace scope pattern, weight 10 |
| `Cargo.toml` or `crates/` exists | Rust — crate scope pattern, weight 10; exclude `target/` |
| `go.mod` or `cmd/` exists | Go — command scope pattern, weight 10 |
| `pyproject.toml`, `setup.py`, or `requirements.txt` exists | Python — exclude `__pycache__/`, `.pytest_cache/`, `*.egg-info/` |
| `prisma/` exists | DB layer — scope `db`, weight 5 |
| `components/ui/` exists | shadcn/ui layer — scope `ui`, weight 5 |
| `src/generated/` or `.prisma/` exists | Generated output — add to `exclude` |
| `dist/`, `.next/`, `build/`, `target/`, `out/` exists | Build output — add to `exclude` |
| `node_modules/` exists | Always excluded by default, no action needed |

---

## Phase 2 — Ask

Present findings and ask the user to confirm or adjust each one. Only ask
about signals that actually fired in Phase 1.

### Scope pattern prompts

For each detected scope signal, show the proposed pattern and ask:

> "Found `src/features/`. Proposed scope pattern:
> `{ "pattern": "src/features/([^/]+)/.*", "scope": "$1", "weight": 10 }`
> Use this? (yes / adjust / skip)"

If the user wants to adjust, ask for the corrected `pattern`, `scope`, or `weight`.

Standard scope patterns by signal:

| Signal | Pattern | Scope | Weight |
|--------|---------|-------|--------|
| `src/features/` | `src/features/([^/]+)/.*` | `$1` | 10 |
| `packages/` monorepo | `packages/([^/]+)/.*` | `$1` | 10 |
| `apps/` monorepo | `apps/([^/]+)/.*` | `$1` | 10 |
| `crates/` (Rust) | `crates/([^/]+)/.*` | `$1` | 10 |
| `cmd/` (Go) | `cmd/([^/]+)/.*` | `$1` | 10 |
| `prisma/` | `prisma/.*` | `db` | 5 |
| `components/ui/` | `components/ui/.*` | `ui` | 5 |

Always include a fallback pattern at the end unless the user opts out:

```json
{ "pattern": "src/([^/]+)/.*", "scope": "$1", "weight": 6 }
```

### Exclude path prompts

For each detected build/generated output, ask:

> "Found `dist/`. Add to exclude list? (yes / skip)"

### Rules prompts

Ask these three regardless of signals:

1. "Max subject line length? (default: 50, range: 40–72)"
2. "Min bullet points in commit body? (default: 1, range: 0–5)"
3. "Max bullet line length? (default: 72, range: 60–100)"

If the user accepts the default, omit that key from `rules` (convit uses defaults
automatically — only write keys the user explicitly customized).

---

## Phase 3 — Write

Produce `.convitrc.json` at the project root with only the keys that have
non-default or user-confirmed values. Shape must match exactly:

```json
{
  "rules": {
    "maxSubjectLength": 50,
    "maxBulletLength": 72,
    "minBullets": 1,
    "temperature": 0.2
  },
  "scopePatterns": [
    { "pattern": "src/features/([^/]+)/.*", "scope": "$1", "weight": 10 },
    { "pattern": "src/([^/]+)/.*",          "scope": "$1", "weight": 6  }
  ],
  "exclude": [
    "src/generated/prisma"
  ]
}
```

Rules:
- `temperature` is always omitted unless the user explicitly requests it (0.2 is the default and rarely needs changing)
- Empty arrays (`[]`) should be omitted entirely
- `rules` should be omitted entirely if no rule was customized
- Never add a `provider`, `apiKey`, `baseUrl`, or `model` key

After writing, print a summary of what was configured and remind the user to
add `CONVIT_URL`, `CONVIT_KEY`, and `CONVIT_MODEL` to `.env` if not already set.
