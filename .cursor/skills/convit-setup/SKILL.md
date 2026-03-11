---
name: convit-setup
description: >
  Scans a codebase and generates a .convitrc.json configuration file for the
  convit AI commit CLI. Analyzes project structure from first principles to
  architect scope patterns, exclude paths, and rules. Use when setting up convit,
  configuring commit scopes, running convit init, or customizing how convit
  analyzes a project. Triggers on convit setup, .convitrc, commit scopes, or
  convit init.
argument-hint: "[path to project root, or empty for current directory]"
---

# convit Setup

Generates a `.convitrc.json` tailored to the actual structure of the codebase.
The config should capture Intent, not just file paths.

**Quick start:** (1) Apply the Mizan Principle to find the Primary Structural
Boundary. (2) Run Structural Analysis (Core, Depth, Noise). (3) Apply Weighting
Engine rules. (4) Synthesize patterns with user patterns first. (5) Ask user to
confirm. (6) Write config.

Never include a `provider` block. API credentials (`CONVIT_URL`, `CONVIT_KEY`,
`CONVIT_MODEL`) belong in `.env` only. The config file is safe to commit.

For the full semantics of every variable, see [config-reference.md](config-reference.md).

---

## The Mental Model (The Mizan Principle)

Before scanning folders, identify the **Primary Structural Boundary**. This is
the deepest semantic unit that defines how the codebase is organized. The agent
must reason from first principles, not from a lookup table.

**Domain-Driven (Weight 10).** A folder has many subdirectories. Each subdir
contains its own index, tests, or components. Examples: `src/features/auth/`,
`src/modules/payments/`, `lib/domains/orders/`. The subdirectory name is the
scope. This is the highest-weight boundary.

**Layered (Weight 8).** The root exposes functional layers: `controllers/`,
`models/`, `views/`, or `handlers/`, `services/`, `repositories/`. The first
segment under the core is the scope. Broad organizational folders.

**Monorepo (Weight 10).** `packages/` or `apps/` contains distinct projects.
Each subdirectory is a top-level scope. Same weight as domain-driven.

Apply the Mizan Principle to any codebase. A 10-year-old COBOL project with
`cobol/programs/`, `cobol/copybooks/`, `cobol/data/` is layered. A brand-new
Next.js app with `src/app/(auth)/`, `src/app/(dashboard)/` is domain-driven.
The reasoning engine adapts.

---

## Phase 1 — Structural Analysis (Principles, not Folders)

Run this protocol. Do not rely on hardcoded paths.

### Identify the Core

Locate where the marrow of the logic lives. Common candidates: `src/`, `lib/`,
`app/`, or the repo root. The core is the deepest shared ancestor of most
application code. If tests live in `tests/` at root, the core may be root. If
tests live in `src/foo/__tests__/`, the core is `src/`.

### Detect Depth

Walk paths. If they go 3+ levels deep (e.g. `src/features/auth/internal/`),
the middle segment is likely the scope. The pattern should capture that segment
with `([^/]+)`. Shallow structures (e.g. `src/auth.ts`, `src/user.ts`) suggest
a single `src/([^/]+)` pattern. Deep structures suggest domain-specific patterns
like `src/features/([^/]+)/.*` or `src/modules/([^/]+)/.*`.

### Identify Noise

Look for lockfiles, `.cache`, `dist`, `target`, `build`, `out`, `__pycache__`,
`.pytest_cache`, `*.egg-info`, generated output (e.g. `src/generated/`,
`.prisma/`). Add these to `exclude`. Do not add `node_modules` — it is
already excluded by default.

---

## Phase 2 — The Weighting Engine Rules

Apply these weights when architecting scope patterns. Higher weight wins ties.

| Weight | Boundary Type | Example Pattern |
|--------|---------------|-----------------|
| **10** | Deepest semantic boundary | `src/modules/([^/]+)/.*`, `packages/([^/]+)/.*`, `crates/([^/]+)/.*` |
| **8** | Broad organizational folders | `src/([^/]+)/.*`, `lib/([^/]+)/.*` |
| **5** | Transversal layers | `ui/.*` → `ui`, `db/.*` → `db`, `prisma/.*` → `db` |
| **3** | Infrastructure / tooling | `scripts/([^/]+)/.*`, `config/.*` → `config` |

The primary boundary gets 10. Fallback patterns (catch-all under core) get 6–8.
Cross-cutting concerns (UI, DB, API) get 5. Scripts and config get 3.

Transversal layers stay at 5 so the primary boundary (10) overrides when a file
lives in both. Example: `src/features/auth/ui/button.tsx` should scope to `auth`,
not `ui`. The domain wins.

---

## Phase 3 — Synthesis Logic

Generate regex patterns using `([^/]+)` to dynamically capture directory names
as scopes. The `scope` field is `"$1"` when the pattern captures a segment, or
a literal string (e.g. `"db"`, `"ui"`) when the layer is fixed.

**User-specific patterns go at the top** of the `scopePatterns` array. They
override built-in defaults. If the user has custom domains or conventions,
place those first.

Always include a fallback pattern at the end unless the user opts out:

```json
{ "pattern": "src/([^/]+)/.*", "scope": "$1", "weight": 6 }
```

Adjust the fallback to match the core (e.g. `lib/([^/]+)/.*` if the core is
`lib/`).

---

## Phase 4 — Ask

Present findings and ask the user to confirm or adjust. Only ask about signals
that actually fired.

### Scope pattern prompts

For each proposed scope pattern, show:

> "Proposed scope pattern:
> `{ "pattern": "src/features/([^/]+)/.*", "scope": "$1", "weight": 10 }`
> Use this? (yes / adjust / skip)"

If the user wants to adjust, ask for the corrected `pattern`, `scope`, or
`weight`.

### Exclude path prompts

For each detected build/generated output:

> "Found `dist/`. Add to exclude list? (yes / skip)"

### Rules prompts

Ask these three regardless of signals:

1. "Max subject line length? (default: 50, range: 40–72)"
2. "Min bullet points in commit body? (default: 1, range: 0–5)"
3. "Max bullet line length? (default: 72, range: 60–100)"

If the user accepts the default, omit that key from `rules`. convit uses
defaults automatically — only write keys the user explicitly customized.

---

## Phase 5 — Write

Produce `.convitrc.json` at the project root with only the keys that have
non-default or user-confirmed values. Shape must match exactly:

```json
{
  "rules": {
    "maxSubjectLength": 50,
    "maxBulletLength": 72,
    "minBullets": 1
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
- `temperature` is always omitted unless the user explicitly requests it (0.2 is
  the default and rarely needs changing)
- Empty arrays (`[]`) should be omitted entirely
- `rules` should be omitted entirely if no rule was customized
- Never add a `provider`, `apiKey`, `baseUrl`, or `model` key

After writing, print a summary of what was configured and remind the user to
add `CONVIT_URL`, `CONVIT_KEY`, and `CONVIT_MODEL` to `.env` if not already set.

---

## Example

**Input:** Next.js app with `src/features/auth/`, `src/features/dashboard/`,
`src/components/ui/`. Core is `src/`. Depth is 3 levels. Noise: `.next/`.

**Output:**

```json
{
  "scopePatterns": [
    { "pattern": "src/features/([^/]+)/.*", "scope": "$1", "weight": 10 },
    { "pattern": "components/ui/.*", "scope": "ui", "weight": 5 },
    { "pattern": "src/([^/]+)/.*", "scope": "$1", "weight": 6 }
  ],
  "exclude": [".next/"]
}
```

Primary boundary is `src/features/([^/]+)`. Transversal layer `components/ui/`
gets fixed scope `ui`. Fallback `src/([^/]+)` catches files outside features.
Noise excluded.
