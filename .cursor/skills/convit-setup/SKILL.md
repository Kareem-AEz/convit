---
name: convit-setup
description: >
  Everything an AI agent needs to adopt convit — the local-first CLI that turns
  staged git changes into Conventional Commit messages. Covers what convit is,
  installing it, connecting a model (local LM Studio/Ollama or any
  OpenAI-compatible cloud endpoint), architecting a `.convitrc.json` from the
  project's structure, and running it to create commits. Use this whenever the
  user mentions convit, asks to set it up or configure it, wants a `.convitrc`
  or commit scopes, runs `convit init`, or asks you to generate or make a commit
  with convit (including `--accept`, `--json`, `--amend`, `--candidates`, or the
  git hook). Reach for it even when the user just says "commit with convit" or
  "set up conventional commits for this repo."
argument-hint: "[path to project root, or empty for current directory]"
disable-model-invocation: true
---

# convit

convit is a CLI that writes Conventional Commit messages from your **staged**
git changes. What sets it apart is a **Pre-Analysis Intelligence Layer** that
runs entirely on the local machine _before_ any model call: it classifies each
changed file, casts weighted votes on the commit type and scope, scans the diff
for secrets, and compresses large diffs — so the model receives half-analyzed
context instead of a raw dump. It is **local-first**: it talks to LM Studio at
`http://localhost:1234/v1` by default, but works with any OpenAI-compatible
endpoint (Ollama, OpenAI, Gemini, Anthropic, OpenRouter, Groq, AI Gateway).

Pick the path that matches the request:

- **Setting up / configuring** convit (install, connect a model, write
  `.convitrc.json`) → start at **Install & connect a model** below.
- **Using** convit to make a commit (interactive, CI, amend, candidates, hooks)
  → jump to **Use convit** and read
  [references/usage.md](references/usage.md) for flag-by-flag detail.

## 🚨 Security mandate (read first)

convit operates on repos that may contain secrets, and its config lives next to
`.env` files. Hold these invariants no matter what the task is:

- **Never read secret files.** Do not open, `grep`, or print `.env`,
  `.env.local`, or anything holding credentials. To check which `CONVIT_*`
  variables exist, use **only** `scripts/ensure-convit-env.mjs` in this skill —
  it inspects variable _names_, never values.
- **Credentials live in `.env` only.** `CONVIT_URL`, `CONVIT_KEY`,
  `CONVIT_MODEL` belong in `.env`/`.env.local`, never in `.convitrc.json`. The
  config file is meant to be committed; a secret in it is a leak.
- **Never write a `provider`, `apiKey`, `baseUrl`, or `model` key** into
  `.convitrc.json`.

## Install & connect a model

Install convit (project-local is recommended so the version is pinned):

```bash
npm install -D @kareem-aez/convit
# or run once with no install:
npx @kareem-aez/convit
```

Wire a `commit` script so the team has one command:

```json
{ "scripts": { "commit": "convit" } }
```

Then connect a model — convit needs an OpenAI-compatible endpoint:

- **Local (default, private, free).** Start LM Studio, load a model, run
  `convit`. It auto-detects the loaded model from `/v1/models` (1s timeout);
  code never leaves the machine and a `[SECURE]` badge shows. Ollama is the same
  with `CONVIT_URL="http://localhost:11434/v1"`.
- **Cloud.** Set three env vars in `.env` (or `.env.local`, which loads first):

  ```env
  CONVIT_URL="https://api.openai.com/v1"
  CONVIT_KEY="sk-..."
  CONVIT_MODEL="gpt-4o"
  ```

  Only the URL, key, and model change between providers. For Gemini the URL
  must end with `/openai`.

To check for or scaffold the env vars **without exposing any values**, offer to
run the env script (tell the user what it does first — it reads names only,
appends placeholders for anything missing, prints nothing secret):

```bash
node scripts/ensure-convit-env.mjs [path-to-project-root]
```

Config precedence, highest → lowest: `--model` flag > `.env.local` > `.env` >
`.convitrc.json` > built-in defaults.

## Generate `.convitrc.json`

`.convitrc.json` is optional — convit works with zero config — but a tuned
config makes scope detection accurate. The file captures **intent**: which
directories are real scopes, what to exclude, and the formatting rules.

`convit init` ships a basic wizard. This skill does better: it reasons about the
codebase from first principles (a **Hierarchy Principle** plus a weighting
engine) to architect scope patterns, then confirms each with the user before
writing. That logic is detailed — when the task is to generate or refine a
config, **read [references/config-architecture.md](references/config-architecture.md)**
and follow its five phases (Structural Analysis → Weighting → Synthesis → Ask →
Write). For the exact meaning of every field, see
[references/config-reference.md](references/config-reference.md).

A minimal example:

```json
{
  "scopePatterns": [
    { "pattern": "src/features/([^/]+)/.*", "scope": "$1", "weight": 10 },
    { "pattern": "src/([^/]+)/.*", "scope": "$1", "weight": 6 }
  ],
  "exclude": ["src/generated/prisma"]
}
```

Write only keys the user customized — omit defaults, omit empty arrays, and omit
`rules` entirely if no rule changed.

## Use convit

Once a model is connected, the everyday flow is: **stage changes, then run
convit.** It only ever looks at the staged diff.

```bash
git add <files>
convit            # interactive: accept / regenerate / edit / cancel
```

Common flags (full behavior in [references/usage.md](references/usage.md)):

- `convit --accept` — non-interactive; accept the first message that passes the
  auto-accept gate, then commit. For CI / automation. Any secret match is a hard
  block.
- `convit --amend` — reword the previous commit (`git commit --amend`); folds in
  anything currently staged.
- `convit --candidates <n>` — generate N messages (default 3, max 5) and pick.
- `convit --json` / `convit --print` — machine output on stdout (human chrome to
  stderr); neither commits unless combined with `--accept`.
- `convit --dry-run` / `--debug` / `--model <id>` / `--no-compress` — generate
  without committing / dump the analysis / override the model / skip compression.
- `convit init` — config wizard. `convit hook install` — a `prepare-commit-msg`
  hook so a bare `git commit` opens pre-filled; it fails open and never blocks.

When committing **on the user's behalf**, prefer the interactive flow or show
the message before `--accept` commits it. The commit **type** matters most — it
drives semantic-version bumps downstream (`feat` → minor, `fix`/`perf` → patch,
a `!` marker → breaking), so a wrong type silently mis-bumps a release.

## Where things live

| File                                | When to read it                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `references/config-architecture.md` | Generating or refining `.convitrc.json` — the Hierarchy Principle + 5-phase weighting engine |
| `references/config-reference.md`    | The exact semantics of any `.convitrc.json` field                                            |
| `references/usage.md`               | Flag-by-flag behavior, non-interactive output, the git hook                                  |
| `scripts/ensure-convit-env.mjs`     | Safely check/scaffold `CONVIT_*` env-var names (never values)                                |
