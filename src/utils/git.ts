// =============================================================================
// Git Helpers
// =============================================================================
//
// Thin wrappers around git subprocesses and the LM Studio models API.
// These are the only functions in the package that perform I/O to external
// processes or network endpoints (aside from the LLM generator).
// =============================================================================

import { execFileSync } from "child_process";
import { DEFAULT_MODEL } from "../config/defaults";
import type { Config } from "../types";

/**
 * Resolves the model ID to use for generation.
 *
 * Strategy (in order):
 * 1. If `config.model` is set (via CLI or env), use it directly — no network call.
 * 2. Hit `GET /v1/models` with a 1-second hard timeout. LM Studio returns the
 *    currently loaded model as the first entry in `data[]`. This is the model
 *    that will actually respond to requests, so we use it without the user
 *    needing to configure anything.
 * 3. On any failure (timeout, 404, parse error, LM Studio not running), fall
 *    through silently to DEFAULT_MODEL.
 *
 * The 1s timeout prevents the script from hanging when LM Studio isn't running.
 */
export async function getLoadedModel(config: Config): Promise<string> {
  if (config.model) return config.model;

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
 * This handles the "dubious ownership" error on Windows by checking
 * the exit code and stderr of `git rev-parse`.
 *
 * @throws Error with a descriptive message if not a repo or ownership is dubious.
 */
export function verifyGitRepo(): void {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as any).stderr?.toString() || "";

    if (stderr.includes("detected dubious ownership")) {
      throw new Error(
        "Git detected dubious ownership in this directory.\n" +
          "To fix this, run:\n\n" +
          `  git config --global --add safe.directory ${process.cwd().replace(/\\/g, "/")}\n`,
      );
    }

    throw new Error(
      "Not a git repository (or any of the parent directories): .git",
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
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      encoding: "utf-8",
    }).trim();
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
export function getStagedFiles(exclude: string[], cwd?: string): string {
  return execFileSync(
    "git",
    ["diff", "--cached", "--name-only", ...excludePathspecs(exclude)],
    { encoding: "utf-8", cwd },
  ).trim();
}

/**
 * Returns the raw staged diff (honoring excludes).
 *
 * Uses `execFileSync` with an argv array — no shell is spawned, so the exclude
 * pathspecs are passed literally (see {@link excludePathspecs}).
 */
export function getStagedDiff(exclude: string[], cwd?: string): string {
  return execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--unified=3",
      "--no-prefix",
      "--ignore-space-at-eol",
      ...excludePathspecs(exclude),
    ],
    { encoding: "utf-8", cwd },
  );
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
export function getRecentCommits(n: number = 3): string {
  try {
    const out = execFileSync("git", ["log", `-${n}`, "--format=%B%n---"], {
      encoding: "utf-8",
    }).trim();
    return out.endsWith("---") ? out.slice(0, -3).trim() : out;
  } catch {
    return "";
  }
}
