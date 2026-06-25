// =============================================================================
// Sensitive Data Detection
// =============================================================================
//
// Scans staged diffs for potential secrets before they are sent to an API.
// Only ADDED lines are scanned — removed lines are explicitly ignored so we
// don't block developers who are fixing leaks.
// =============================================================================

import { SENSITIVE_PATTERNS } from "../config/defaults";
import { confirm, isCancel, note } from "../cli/ui";
import type { SensitiveDataMatch } from "../types";

/**
 * Scans a single line against every sensitive pattern, returning a match per hit.
 *
 * The `pattern.lastIndex = 0` reset before each `exec()` call is required
 * because all patterns use the `g` flag (global). Without the reset, a regex
 * with the `g` flag maintains internal state (lastIndex) between calls on
 * different strings, causing every other call to miss matches.
 *
 * Preview masking: shows the first 4 and last 4 chars with `****` in the middle.
 */
function scanLine(
  line: string,
  lineNumber: number,
  file: string,
): SensitiveDataMatch[] {
  const found: SensitiveDataMatch[] = [];

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;

    const match = pattern.exec(line);
    if (match) {
      const fullMatch = match[0];
      const preview =
        fullMatch.length > 12
          ? fullMatch.substring(0, 4) +
            "****" +
            fullMatch.substring(fullMatch.length - 4)
          : "****";

      found.push({ type: label, line: lineNumber, file, preview });
    }
  }

  return found;
}

/**
 * Scans a git diff for sensitive data patterns.
 *
 * Critical design decision: only ADDED lines are scanned (lines starting with
 * `+`, excluding the `+++` file header). Removed lines (starting with `-`) are
 * explicitly ignored. The goal is to prevent secrets from being *sent to an API*,
 * not to police historical commits.
 */
export function detectSensitiveData(diff: string): SensitiveDataMatch[] {
  const matches: SensitiveDataMatch[] = [];
  const lines = diff.split("\n");

  let currentFile = "";
  let lineNumber = 1;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git (?:a\/)?(\S+)/);
      if (match) {
        currentFile = match[1];
        lineNumber = 1;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNumber++;
      matches.push(...scanLine(line, lineNumber, currentFile));
    }
  }

  return matches;
}

/**
 * Scans arbitrary (non-diff) text for the same sensitive patterns.
 *
 * Unlike {@link detectSensitiveData}, there is no diff grammar: every line is
 * scanned (no `+`/`+++` handling). This covers prose and lists that still reach
 * the model but aren't a diff — recent commit bodies, the staged file list, the
 * user's typed description. `source` becomes each match's `file` label so the
 * security gate can show where the secret came from.
 */
export function detectSensitiveInText(
  text: string,
  source: string,
): SensitiveDataMatch[] {
  if (!text) return [];

  const matches: SensitiveDataMatch[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    matches.push(...scanLine(lines[i], i + 1, source));
  }

  return matches;
}

/**
 * Collects sensitive-data matches across every repo-derived source that reaches
 * the model before the security gate: the staged diff, the staged file paths,
 * and recent commit bodies.
 *
 * The user's typed description is intentionally NOT scanned here — it can change
 * on each regenerate/edit, so it is gated separately in the interactive loop.
 */
export function collectPromptSecrets(
  rawDiff: string,
  fileList: string[],
  recentCommits: string,
): SensitiveDataMatch[] {
  return [
    ...detectSensitiveData(rawDiff),
    ...detectSensitiveInText(fileList.join("\n"), "staged file paths"),
    ...detectSensitiveInText(recentCommits, "recent commit history"),
  ];
}

/**
 * Displays a security warning and prompts for explicit confirmation before
 * sending a diff containing potential secrets to an external API.
 *
 * Matches are grouped by file for readability. The destination URL is shown
 * explicitly so the user knows exactly where their diff is going.
 */
export async function promptForSensitiveConfirmation(
  matches: SensitiveDataMatch[],
  apiUrl: string,
): Promise<boolean> {
  const byFile = new Map<string, SensitiveDataMatch[]>();
  for (const match of matches) {
    if (!byFile.has(match.file)) byFile.set(match.file, []);
    byFile.get(match.file)!.push(match);
  }

  const lines: string[] = [];
  for (const [file, fileMatches] of byFile.entries()) {
    lines.push(`📄 ${file}`);
    for (const match of fileMatches) {
      lines.push(`   • Line ${match.line}: ${match.type} - ${match.preview}`);
    }
  }
  lines.push("");
  lines.push(`This diff will be sent to: ${apiUrl}`);
  lines.push(
    "If this contains real secrets, they will be exposed to the API provider.",
  );

  note(lines.join("\n"), "SECURITY: Potential sensitive data detected");

  const response = await confirm({
    message: "Continue anyway?",
    initialValue: false,
  });

  if (isCancel(response)) return false;
  return response === true;
}
