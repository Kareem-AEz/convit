// =============================================================================
// Git Helpers
// =============================================================================
//
// Thin wrappers around git subprocesses and the LM Studio models API.
// These are the only functions in the package that perform I/O to external
// processes or network endpoints (aside from the LLM generator).
// =============================================================================

import { execSync } from "child_process";
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
 * Returns true when the repo has no commits yet (initial commit).
 *
 * Used to inject special prompt guidance so the model describes the project
 * rather than inferring incremental changes from file patterns.
 */
export function isInitialCommit(): boolean {
  try {
    const count = execSync("git rev-list --count HEAD", {
      encoding: "utf-8",
    }).trim();
    return count === "" || count === "0";
  } catch {
    return true;
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
export function getRecentCommits(n: number = 3): string {
  try {
    const out = execSync(
      `git log -${n} --format="%B%n---"`,
      { encoding: "utf-8" },
    ).trim();
    return out.endsWith("---") ? out.slice(0, -3).trim() : out;
  } catch {
    return "";
  }
}
