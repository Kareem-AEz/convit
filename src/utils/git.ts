// =============================================================================
// Git Helpers
// =============================================================================
//
// Thin wrappers around git subprocesses and the LM Studio models API.
// These are the only functions in the package that perform I/O to external
// processes or network endpoints (aside from the LLM generator).
// =============================================================================

import { execFileSync } from "child_process";
import { DEFAULT_MODEL, GIT_MAX_BUFFER_BYTES } from "../config/defaults";
import { isLocalUrl } from "./url";
import type { Config } from "../types";

/**
 * Shared `execFileSync` options for every git call.
 *
 * The explicit `maxBuffer` is load-bearing: Node defaults it to 1 MiB, and git
 * blows past that on any sizeable staged change — surfacing as the opaque
 * `spawnSync git ENOBUFS`. See {@link GIT_MAX_BUFFER_BYTES}.
 */
const GIT_EXEC_OPTS = {
  encoding: "utf-8",
  maxBuffer: GIT_MAX_BUFFER_BYTES,
} as const;

/**
 * Converts an stdout-overflow failure into an actionable error.
 *
 * Deliberately fatal rather than degrading to a truncated diff: `summarizeDiff`
 * builds the model's context from the same string `detectSensitiveData` scans,
 * so a partial read would mean sending bytes that were never scanned for
 * secrets. Anything that is not an overflow is rethrown untouched.
 */
function rethrowOversizedGitOutput(err: unknown, what: string): never {
  if ((err as NodeJS.ErrnoException)?.code !== "ENOBUFS") throw err;

  const mb = Math.round(GIT_MAX_BUFFER_BYTES / (1024 * 1024));
  throw new Error(
    `The ${what} is too large for convit to read (over ${mb} MB).\n\n` +
      "Generated or vendored files are the usual cause. Add them to `exclude`\n" +
      "in .convitrc.json, or stage this change in smaller commits.",
  );
}

/**
 * Resolves the model ID to use for generation.
 *
 * Strategy (in order):
 * 1. If `config.model` is set (via CLI or env), use it directly — no network call.
 * 2. Only when the endpoint is local (LM Studio): hit `GET /v1/models` with a
 *    1-second hard timeout and take the first entry of `data[]`, which LM Studio
 *    reports as the currently loaded model. On a remote multi-model endpoint
 *    this is skipped — blindly taking `data[0]` there risks billing the wrong
 *    model, so an explicit `CONVIT_MODEL` is expected (DEFAULT_MODEL otherwise).
 * 3. On any failure (timeout, 404, parse error, LM Studio not running), fall
 *    through silently to DEFAULT_MODEL.
 *
 * The 1s timeout prevents the script from hanging when LM Studio isn't running.
 */
export async function getLoadedModel(config: Config): Promise<string> {
  if (config.model) return config.model;

  // Auto-detection from data[0] is only trustworthy for a local single-model
  // server; don't guess a model on a remote endpoint.
  if (!isLocalUrl(config.apiUrl)) return DEFAULT_MODEL;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${config.apiUrl}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error("Failed to fetch models");

    const data = (await response.json()) as { data: { id: string }[] };
    if (data.data && data.data.length > 0) return data.data[0].id;
  } catch {
    // silently fall through to default
  }

  return DEFAULT_MODEL;
}

/**
 * Checks if the current directory is a valid git repository.
 *
 * Branches on the actual failure so the message is honest: git missing from
 * PATH, dubious ownership (Windows), a genuine non-repo, or anything else
 * (e.g. permissions) — the last surfaces git's real stderr instead of masking
 * every failure as "Not a git repository".
 *
 * @throws Error with a message describing the specific failure.
 */
export function verifyGitRepo(): void {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as any).stderr?.toString() || "";
    const code = (err as any).code;

    if (code === "ENOENT") {
      throw new Error(
        "git was not found on your PATH. Install git, then try again.",
      );
    }

    if (stderr.includes("detected dubious ownership")) {
      throw new Error(
        "Git detected dubious ownership in this directory.\n" +
          "To fix this, run:\n\n" +
          `  git config --global --add safe.directory ${process.cwd().replace(/\\/g, "/")}\n`,
      );
    }

    if (/not a git repository/i.test(stderr)) {
      throw new Error(
        "Not a git repository (or any of the parent directories): .git",
      );
    }

    // Unknown failure (permissions, corrupt repo, …) — don't mask it.
    throw new Error(
      `git rev-parse failed: ${stderr.trim() || (err as Error).message}`,
    );
  }
}

/**
 * Returns true when the repo has no commits yet (initial commit).
 *
 * Used to inject special prompt guidance so the model describes the project
 * rather than inferring incremental changes from file patterns.
 */
export function isInitialCommit(): boolean {
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", "HEAD"],
      GIT_EXEC_OPTS,
    ).trim();
    return count === "" || count === "0";
  } catch {
    return true;
  }
}

/**
 * Maps user-configured exclude globs to literal `:(exclude)<path>` git pathspec
 * argv elements.
 *
 * Each entry becomes exactly one argv element — no joining, no quoting, no shell.
 * Because these are passed as discrete arguments to `execFileSync` (never
 * interpolated into a command string), paths with spaces and shell
 * metacharacters are handled literally and cannot inject shell commands, even
 * though `exclude` comes from the "safe to commit" `.convitrc.json`.
 */
export function excludePathspecs(exclude: string[]): string[] {
  return exclude.map((f) => `:(exclude)${f}`);
}

/**
 * Returns the newline-separated list of staged file paths (honoring excludes).
 *
 * Uses `execFileSync` with an argv array — no shell is spawned, so the exclude
 * pathspecs are passed literally (see {@link excludePathspecs}).
 */
export function getStagedFiles(
  exclude: string[],
  cwd?: string,
  base?: string,
): string {
  try {
    return execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--name-only",
        "-M",
        ...(base ? [base] : []),
        ...excludePathspecs(exclude),
      ],
      { ...GIT_EXEC_OPTS, cwd },
    ).trim();
  } catch (err) {
    rethrowOversizedGitOutput(err, "staged file list");
  }
}

/**
 * Returns the raw staged diff (honoring excludes).
 *
 * Uses `execFileSync` with an argv array — no shell is spawned, so the exclude
 * pathspecs are passed literally (see {@link excludePathspecs}).
 */
export function getStagedDiff(
  exclude: string[],
  cwd?: string,
  base?: string,
): string {
  try {
    return execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--unified=3",
        "--no-prefix",
        "--ignore-space-at-eol",
        "-M",
        ...(base ? [base] : []),
        ...excludePathspecs(exclude),
      ],
      { ...GIT_EXEC_OPTS, cwd },
    );
  } catch (err) {
    rethrowOversizedGitOutput(err, "staged diff");
  }
}

/**
 * Parses `git diff --numstat` output into per-file add/delete counts.
 * Binary rows (`-\t-\tpath`) are skipped — they carry no line counts.
 */
function parseNumstat(
  output: string,
): Map<string, { adds: number; dels: number }> {
  const stats = new Map<string, { adds: number; dels: number }>();
  for (const line of output.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || m[1] === "-" || m[2] === "-") continue;
    stats.set(m[3].trim(), { adds: Number(m[1]), dels: Number(m[2]) });
  }
  return stats;
}

/**
 * Identifies files whose staged changes are purely whitespace/formatting (a
 * prettier / eslint --fix run) by letting git decide: a file with real changes
 * in a normal `--numstat` but `0 0` once `-w --ignore-blank-lines` is applied
 * has no semantic change.
 *
 * Both passes omit `-M` so paths stay plain (a pure rename has no content delta
 * to misread as formatting anyway). Returns an empty set on any git failure —
 * formatting detection is an enhancement, never a hard dependency.
 */
export function getFormattingOnlyFiles(
  exclude: string[],
  cwd?: string,
  base?: string,
): Set<string> {
  const numstat = (extra: string[]) =>
    execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--numstat",
        ...extra,
        ...(base ? [base] : []),
        ...excludePathspecs(exclude),
      ],
      { ...GIT_EXEC_OPTS, cwd },
    );

  try {
    const real = parseNumstat(numstat([]));
    const ignoringWhitespace = parseNumstat(numstat(["-w", "--ignore-blank-lines"]));

    const formattingOnly = new Set<string>();
    for (const [path, { adds, dels }] of real) {
      if (adds + dels === 0) continue; // nothing actually changed
      const ws = ignoringWhitespace.get(path);
      if (!ws || ws.adds + ws.dels === 0) formattingOnly.add(path);
    }
    return formattingOnly;
  } catch {
    return new Set();
  }
}

/**
 * Fetches the last N full commit messages (subject + body, no hash) for style context.
 *
 * Why N=3: One commit is not enough to establish a pattern; five is too much
 * context that dilutes the signal. Three captures the author's recent style
 * without overwhelming the prompt.
 *
 * Full messages (not --oneline) give the model better style context: subject
 * tone, body structure, and bullet phrasing. Hashes are omitted — they add
 * noise and no signal.
 *
 * These are injected into the AI's system prompt (not user message) so the model
 * adopts the repo's existing commit tone globally rather than treating it as
 * example data to copy literally.
 */
export function getRecentCommits(n: number = 3, skip: number = 0): string {
  try {
    const out = execFileSync(
      "git",
      ["log", `-${n}`, ...(skip > 0 ? [`--skip=${skip}`] : []), "--format=%B%n---"],
      GIT_EXEC_OPTS,
    ).trim();
    return out.endsWith("---") ? out.slice(0, -3).trim() : out;
  } catch {
    return "";
  }
}

/**
 * Whether HEAD has a parent — i.e. there is a commit to diff against and amend
 * onto. False for the root commit (which has no `HEAD~1`) and for an empty repo.
 * Used to refuse `--amend` where `git diff --cached HEAD~1` would have no base.
 */
export function hasParentCommit(): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD~1"],
      GIT_EXEC_OPTS,
    );
    return true;
  } catch {
    return false;
  }
}
