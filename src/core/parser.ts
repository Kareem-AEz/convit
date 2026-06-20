// =============================================================================
// Diff Analysis Engine
// =============================================================================
//
// The parser is the intelligence layer between raw git output and the LLM.
// It transforms a wall of unified diff text into a structured, prioritized
// summary that maximizes the signal-to-noise ratio in the AI's context window.
//
// Every function here is pure — no I/O, no side effects, no network calls.
// =============================================================================

import {
  COMPRESSION_THRESHOLD,
  GENERATED_PATTERNS,
  SOURCE_EXTENSIONS,
} from "../config/defaults";
import type {
  DiffSummary,
  FileCategory,
  FileSummary,
  UserConfig,
} from "../types";

/**
 * Classifies a file path into a semantic category using a priority-ordered
 * rule set. Rules are applied top-to-bottom and return early on first match.
 *
 * Priority order (most specific → most general):
 *   test → generated → docs → config → source → asset → other
 *
 * Why this order matters:
 * - A file like `src/features/auth/__tests__/auth.test.ts` should be "test",
 *   not "source" — so test detection runs before source extension matching.
 * - Generated files (lock files, dist/) should never be analyzed as source,
 *   so the generated patterns run before the extension check.
 */
export function categorizeFile(filePath: string): FileCategory {
  const lowerPath = filePath.toLowerCase();

  if (
    lowerPath.includes(".test.") ||
    lowerPath.includes(".spec.") ||
    lowerPath.includes("__tests__/")
  ) {
    return "test";
  }

  for (const pattern of GENERATED_PATTERNS) {
    if (pattern.test(filePath)) return "generated";
  }

  if (lowerPath.endsWith(".md") || lowerPath.includes("readme")) return "docs";

  if (
    lowerPath.endsWith(".json") ||
    lowerPath.endsWith(".yaml") ||
    lowerPath.endsWith(".yml") ||
    lowerPath.endsWith(".toml") ||
    lowerPath.endsWith(".rc") ||
    lowerPath.includes("config") ||
    lowerPath.endsWith(".env") ||
    lowerPath.endsWith(".env.example")
  ) {
    return "config";
  }

  const ext = filePath.substring(filePath.lastIndexOf("."));
  if (SOURCE_EXTENSIONS.includes(ext)) return "source";

  const assetExts = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
  ];
  if (assetExts.includes(ext)) return "asset";

  return "other";
}

/**
 * Computes a 0–100 importance score for a file, used to rank which files
 * should appear first in the compressed diff summary.
 *
 * Scoring algorithm (additive weighted):
 * - Base score: 50
 * - Category bonus: source=+40, test=+30, config=+20, docs=+15, other=+10, asset=+5, generated=+0
 * - Feature file bonus: +15 if inside `src/features/` (feature-sliced architecture)
 * - Change type bonus: add=+10, delete=+5, modify=+0
 * - Change size bonus: >100 lines=+15, >50=+10, >10=+5
 * - Binary penalty: -20 (binary diffs carry no semantic information)
 *
 * The result is clamped to [0, 100].
 */
export function calculateImportanceScore(file: FileSummary): number {
  let score = 50;

  const categoryScores: Record<FileCategory, number> = {
    source: 40,
    test: 30,
    config: 20,
    docs: 15,
    other: 10,
    asset: 5,
    generated: 0,
  };
  score += categoryScores[file.category];

  // User configured scopes get bumped importance
  // (We don't need to bump src/features/ explicitly here anymore, let the general algorithm handle it
  // based on additions/deletions/category, but we'll leave a small bump for deep paths)
  if (file.path.split("/").length > 2) score += 10;

  if (file.changeType === "add") score += 10;
  else if (file.changeType === "delete") score += 5;

  const totalChanges = file.additions + file.deletions;
  if (totalChanges > 100) score += 15;
  else if (totalChanges > 50) score += 10;
  else if (totalChanges > 10) score += 5;

  if (file.isBinary) score -= 20;

  return Math.max(0, Math.min(100, score));
}

/**
 * Single-pass streaming parser for git unified diff output.
 *
 * Algorithm:
 * - Walk each line of the diff
 * - When a `diff --git a/path b/path` header is encountered, save the stats
 *   for the previous file and start tracking a new file
 * - Lines starting with `+` (but not `+++`) are additions
 * - Lines starting with `-` (but not `---`) are deletions
 *
 * This is O(N) in the number of diff lines, which is optimal.
 */
export function parseDiffStats(
  diff: string,
): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const lines = diff.split("\n");

  let currentFile = "";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) stats.set(currentFile, { additions, deletions });

      const match = line.match(/diff --git (?:a\/)?(\S+)/);
      if (match) {
        currentFile = match[1];
        additions = 0;
        deletions = 0;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  if (currentFile) stats.set(currentFile, { additions, deletions });

  return stats;
}

/**
 * Identifies binary files in a git diff by scanning for git's binary marker lines.
 *
 * When a binary file changes, git outputs a line like:
 *   `Binary files a/path/to/image.png and b/path/to/image.png differ`
 */
export function detectBinaryFiles(diff: string): Set<string> {
  const binaryFiles = new Set<string>();

  for (const line of diff.split("\n")) {
    const match = line.match(
      /^Binary files (?:a\/)?(\S+) and (?:b\/)?(\S+) differ/,
    );
    if (match) binaryFiles.add(match[1]);
  }

  return binaryFiles;
}

/**
 * Extracts the most semantically meaningful added lines from a file's diff.
 *
 * Two-phase strategy:
 *
 * Phase 1 — AST-lite pattern matching:
 *   Scans added lines for high-signal declarations using lightweight regexes:
 *   - Function declarations, class declarations, constants, types/interfaces
 *   - TODO/FIXME annotations (explicit developer intent)
 *   Import statements are explicitly skipped — they carry minimal semantic signal.
 *
 * Phase 2 — Fallback:
 *   If Phase 1 yields nothing, fall back to the first N non-trivial added lines
 *   (≥20 chars) as a best-effort summary.
 */
export function extractKeyChanges(
  fileDiff: string,
  maxChanges: number = 5,
): string[] {
  const keyChanges: string[] = [];
  const lines = fileDiff.split("\n");

  for (const line of lines) {
    if (keyChanges.length >= maxChanges) break;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    const content = line.substring(1).trim();
    if (!content || content.length < 10) continue;
    if (content.startsWith("import ") || content.startsWith("from ")) continue;

    const isFunctionDeclaration = /^(export\s+)?(async\s+)?function\s+\w+/.test(
      content,
    );
    const isClassDeclaration = /^(export\s+)?class\s+\w+/.test(content);
    const isConstantDeclaration = /^(export\s+)?const\s+\w+/.test(content);
    const isTypeDeclaration = /^(export\s+)?(type|interface)\s+\w+/.test(
      content,
    );

    if (
      isFunctionDeclaration ||
      isClassDeclaration ||
      isConstantDeclaration ||
      isTypeDeclaration
    ) {
      keyChanges.push(content.substring(0, 100));
    } else if (content.includes("TODO") || content.includes("FIXME")) {
      keyChanges.push(content.substring(0, 100));
    }
  }

  if (keyChanges.length === 0) {
    for (const line of lines) {
      if (keyChanges.length >= 3) break;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const content = line.substring(1).trim();
        if (content && content.length >= 20)
          keyChanges.push(content.substring(0, 80));
      }
    }
  }

  return keyChanges;
}

/** Per-file diff section with the change type read from git's header markers. */
interface FileSection {
  text: string;
  changeType: "add" | "modify" | "delete" | "rename";
  oldPath?: string;
}

/**
 * Splits a unified diff into per-file sections and reads each file's change type
 * from git's header markers — `new file mode`, `deleted file mode`, and
 * `rename from`/`rename to` — rather than guessing from add/delete line balance
 * (which mislabels an append to an existing file as `add`).
 *
 * Sections are keyed by the path that `git diff --name-only` reports: for a
 * rename (with `-M`) that is the *new* path, taken from the unambiguous
 * `rename to` line — not the `diff --git old new` header, which can't be split
 * reliably when a path contains spaces under `--no-prefix`.
 */
export function parseFileSections(diff: string): Map<string, FileSection> {
  const sections = new Map<string, FileSection>();

  for (const section of diff.split(/(?=diff --git)/)) {
    if (!section.startsWith("diff --git")) continue;

    const renameTo = section.match(/^rename to (.+)$/m);
    if (renameTo) {
      const newPath = renameTo[1].trim();
      const renameFrom = section.match(/^rename from (.+)$/m);
      sections.set(newPath, {
        text: section,
        changeType: "rename",
        ...(renameFrom ? { oldPath: renameFrom[1].trim() } : {}),
      });
      continue;
    }

    const header = section.match(/diff --git (?:a\/)?(\S+)/);
    if (!header) continue;
    const path = header[1];

    const changeType: FileSection["changeType"] = /^new file mode/m.test(section)
      ? "add"
      : /^deleted file mode/m.test(section)
        ? "delete"
        : "modify";

    sections.set(path, { text: section, changeType });
  }

  return sections;
}

/**
 * Orchestrates full diff analysis into a structured `DiffSummary`.
 *
 * Pipeline:
 * 1. `parseDiffStats` → per-file addition/deletion counts (one pass over the diff)
 * 2. `detectBinaryFiles` → set of binary file paths
 * 3. `parseFileSections` → per-file diff text + changeType, keyed by the path
 *    that appears in `--name-only` (the *new* path for renames)
 * 4. For each file: extract key changes, build FileSummary
 * 5. Calculate importance scores and sort by importance descending
 *
 * `formattingOnlyFiles` (from the whitespace-ignoring numstat pass in
 * `getFormattingOnlyFiles`) marks files whose only changes are reformatting —
 * those skip key-change extraction so re-added declarations aren't surfaced as
 * new code.
 */
export function analyzeDiff(
  diff: string,
  fileList: string[],
  formattingOnlyFiles: Set<string> = new Set(),
): DiffSummary {
  const diffStats = parseDiffStats(diff);
  const binaryFiles = detectBinaryFiles(diff);
  const sections = parseFileSections(diff);
  const fileSummaries: FileSummary[] = [];

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of fileList) {
    const stats = diffStats.get(file) ?? { additions: 0, deletions: 0 };
    const isBinary = binaryFiles.has(file);
    const category = categorizeFile(file);
    const section = sections.get(file);

    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;

    const changeType = section?.changeType ?? "modify";
    // A rename or delete is never "formatting-only"; only mark add/modify so a
    // reformatted-and-renamed file doesn't lose its rename signal.
    const formattingOnly =
      formattingOnlyFiles.has(file) &&
      (changeType === "add" || changeType === "modify");

    const fileDiff = section?.text ?? "";
    const keyChanges =
      isBinary || formattingOnly ? [] : extractKeyChanges(fileDiff);

    fileSummaries.push({
      path: file,
      changeType,
      additions: stats.additions,
      deletions: stats.deletions,
      category,
      isBinary,
      importanceScore: 0,
      keyChanges,
      formattingOnly,
      ...(section?.oldPath ? { oldPath: section.oldPath } : {}),
    });
  }

  for (const summary of fileSummaries) {
    summary.importanceScore = calculateImportanceScore(summary);
  }

  fileSummaries.sort((a, b) => b.importanceScore - a.importanceScore);

  return {
    files: fileSummaries,
    totalAdditions,
    totalDeletions,
    totalFiles: fileList.length,
    originalLength: diff.length,
  };
}

/**
 * Serializes a DiffSummary into a compact, LLM-readable text format.
 *
 * The output is structured with category headers (SOURCE, TEST, CONFIG, etc.)
 * in priority order. This means the most semantically important files appear
 * at the top of the prompt, maximizing the signal in the model's attention window.
 */
export function formatCompressedDiff(summary: DiffSummary): string {
  let output = `=== CHANGE SUMMARY ===\n`;
  output += `Files: ${summary.totalFiles} | +${summary.totalAdditions} -${summary.totalDeletions}\n\n`;

  const byCategory = new Map<FileCategory, FileSummary[]>();
  for (const file of summary.files) {
    if (!byCategory.has(file.category)) byCategory.set(file.category, []);
    byCategory.get(file.category)!.push(file);
  }

  const categoryOrder: FileCategory[] = [
    "source",
    "test",
    "config",
    "docs",
    "asset",
    "generated",
    "other",
  ];

  for (const category of categoryOrder) {
    const files = byCategory.get(category);
    if (!files || files.length === 0) continue;

    output += `--- ${category.toUpperCase()} FILES ---\n`;

    for (const file of files) {
      if (file.isBinary) {
        output += `${file.changeType.toUpperCase()}: ${file.path} (binary)\n`;
      } else {
        output += `${file.changeType.toUpperCase()}: ${file.path} (+${file.additions} -${file.deletions})\n`;
        file.keyChanges.forEach((change) => {
          output += `  • ${change}\n`;
        });
      }
      output += "\n";
    }
  }

  return output;
}

/**
 * Decides whether to compress the diff and returns the appropriate form.
 *
 * Compression activates when the raw diff exceeds COMPRESSION_THRESHOLD (10,000
 * characters). Below the threshold, the raw diff is passed directly — this
 * gives the AI the full context for small-to-medium changesets.
 *
 * The `--no-compress` flag bypasses this entirely for debugging.
 */
export function summarizeDiff(
  rawDiff: string,
  summary: DiffSummary,
  noCompress: boolean,
): { processedDiff: string; wasCompressed: boolean } {
  if (noCompress || rawDiff.length <= COMPRESSION_THRESHOLD) {
    return { processedDiff: rawDiff, wasCompressed: false };
  }
  return { processedDiff: formatCompressedDiff(summary), wasCompressed: true };
}
