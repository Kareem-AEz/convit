# convit — usage reference

Flag-by-flag behavior for running convit. Read this when the task is to **make a
commit** with convit (interactively, in CI, amending, or via a hook), or to wire
convit into a pipeline. convit only ever analyzes the **staged** diff — stage
first, then run it.

---

## The everyday flow

```bash
git add <files>
convit
```

The interactive loop offers four actions on the generated message:

- **accept** — write the commit (`git commit -F-` via stdin, never `-m`, so
  multi-line messages survive shell escaping).
- **regenerate** — try again. After a _failed_ validation, the previous result
  is fed back as correction hints and the temperature steps up
  (`0.2 → 0.3 → 0.4`). After 3 attempts the regenerate option drops off.
- **edit** — hand-edit the message.
- **cancel** — abort without committing.

A `[SECURE]` badge and "Free (local & private)" cost line appear automatically
when the endpoint is `localhost`/`127.0.0.1`. That is the intended default, not
a fallback.

## Commands

```text
convit                  interactive commit workflow
convit init             setup wizard, writes .convitrc.json
convit hook install     install a prepare-commit-msg git hook
convit hook uninstall   remove the convit git hook
```

## Flags

| Flag               | Effect                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--accept`         | Non-interactive. Accept the first message that passes the auto-accept gate, then commit. For CI/automation. **Any sensitive-data match is a hard block.**                                                                                        |
| `--amend`          | Reword `HEAD` via `git commit --amend`. Diff context is `git diff --cached HEAD~1`, so a clean tree rewords HEAD as-is and anything staged is folded into the amended commit. Refuses on the root commit / empty repo.                           |
| `--candidates <n>` | Generate N messages at stepped temperatures and pick one. Bare `--candidates` → 3; clamped to `[1, 5]`; 1 disables. Non-interactive runs pick the first candidate that passes the auto-accept gate. Token/cost is summed across the whole batch. |
| `--json`           | Emit one JSON object to **stdout**; all human chrome goes to **stderr**. Object: `{ message, trailers, committed, type, scope, confidence, validation, truncated, tokens, cost, model }`.                                                        |
| `--print`          | Emit just the raw message to stdout (chrome → stderr).                                                                                                                                                                                           |
| `--debug`          | Dump the prompt, DiffSummary, classification scorecard, and compression stats. Blocks on the interactive prompt — pair with `--accept` for a non-blocking dump.                                                                                  |
| `--dry-run`        | Generate without committing.                                                                                                                                                                                                                     |
| `--model <id>`     | Override the model for this run (highest precedence).                                                                                                                                                                                            |
| `--no-compress`    | Send the raw diff, bypassing surgical summarization.                                                                                                                                                                                             |

## Non-interactive output (`--json` / `--print`)

For pipelines and tooling. Both run without prompts and keep **stdout** a clean
machine channel:

- `--print` → just the message: `git commit -m "$(convit --print)"`.
- `--json` → one object: `convit --json | jq -r .message`. `cost`/`tokens` are
  numeric; `message` is raw text; `trailers` lists what would be appended on
  commit.

On their own neither commits — they generate and report. **Combine with
`--accept` to also create the commit** (`convit --json --accept`). Exit code is
non-zero when the generated message fails format validation.

## Git hook

`convit hook install` adds a `prepare-commit-msg` hook so a plain `git commit`
(no `-m`) opens the editor pre-filled with a generated message — review, edit,
or abort as usual. It only generates for a bare commit (it respects `-m`/`-F`,
merges, squashes, amends, and any message already written) and **fails open**,
so a convit error never blocks the commit. Needs `convit` resolvable on `PATH`
(a global install is easiest). `convit hook uninstall` restores any hook it
backed up.

## Committing on the user's behalf

When you run convit to commit for the user, prefer the interactive flow, or show
the message before `--accept` writes it. The commit **type** matters most: it
drives semantic-version bumps in downstream tooling and in convit's own release
flow — `feat` → minor, `fix`/`perf` → patch, a `!` marker or `BREAKING CHANGE`
→ major. A wrong type silently mis-bumps a release, so it is the highest-value
thing to catch before accepting.
