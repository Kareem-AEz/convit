// =============================================================================
// Change Classification Engine
// =============================================================================
//
// The voting system that determines commit type and scope from file-level
// signals. Uses additive scoring rather than a decision tree, so multiple
// weak signals can combine into a confident classification.
//
// Pure functions — no I/O, no side effects.
// =============================================================================

import type {
  ChangeClassification,
  CommitType,
  FileCategory,
  FileSummary,
  Config,
} from "../types";
import { DEFAULT_SCOPE_PATTERNS } from "../config/defaults";

/**
 * Determines the most likely commit type using an additive voting system.
 *
 * Each signal independently casts votes for one or more commit types,
 * and the highest total wins. This means multiple weak signals can combine
 * to confidently identify a type.
 *
 * Voting rules (file-level):
 * - Any new source file → +2 feat
 * - Modified source file → +2 fix
 * - Test file → +5 test
 * - Docs file → +5 docs
 * - Config file → +4 chore
 * - Generated file → +3 chore
 * - File in `scripts/` → +3 chore
 * - Renamed file → +3 refactor
 *
 * Voting rules (diff content):
 * - Contains `catch`/`error`/`try {` → +2 fix
 * - Contains perf keywords → +3 perf
 * - No meaningful changes → +2 style
 *
 * Default if all scores are 0: "chore"
 */
/** Tracks per-rule contributions with file paths for audit trail */
type TypeBreakdown = Map<
  string,
  { pointsEach: number; count: number; files: string[] }
>;

function addToBreakdown(
  breakdown: TypeBreakdown,
  rule: string,
  pointsEach: number,
  filePath?: string,
): void {
  const entry = breakdown.get(rule);
  if (entry) {
    entry.count += 1;
    if (filePath) entry.files.push(filePath);
  } else {
    breakdown.set(rule, {
      pointsEach,
      count: 1,
      files: filePath ? [filePath] : [],
    });
  }
}

/** Human-readable rule labels for the audit trail */
const RULE_LABELS: Record<string, string> = {
  "source add": "new source files",
  "source modify": "modified source files",
  test: "test files",
  docs: "docs files",
  config: "config files",
  generated: "generated files",
  scripts: "scripts",
  rename: "renamed files",
  "diff: error/catch": "diff: error/catch/try",
  "diff: perf keywords": "diff: perf keywords",
  "minimal/whitespace": "minimal/whitespace changes",
};

function formatRuleContribution(
  rule: string,
  pointsEach: number,
  count: number,
  files: string[],
): string {
  const label = RULE_LABELS[rule] ?? rule;
  const total = pointsEach * count;
  if (files.length > 0) {
    if (files.length <= 3) {
      return `+${total} from ${files.join(", ")}`;
    }
    return `+${total} from ${count} ${label}`;
  }
  return `+${total} from ${label}`;
}

export function detectCommitType(
  files: FileSummary[],
  diff: string,
): {
  type: CommitType;
  scores: Record<CommitType, number>;
  breakdowns: Record<CommitType, TypeBreakdown>;
} {
  const scores: Record<CommitType, number> = {
    feat: 0,
    fix: 0,
    docs: 0,
    style: 0,
    refactor: 0,
    perf: 0,
    test: 0,
    chore: 0,
  };

  const breakdowns: Record<CommitType, TypeBreakdown> = {
    feat: new Map(),
    fix: new Map(),
    docs: new Map(),
    style: new Map(),
    refactor: new Map(),
    perf: new Map(),
    test: new Map(),
    chore: new Map(),
  };

  for (const file of files) {
    if (file.changeType === "add" && file.category === "source") {
      scores.feat += 2;
      addToBreakdown(breakdowns.feat, "source add", 2, file.path);
    }
    if (file.changeType === "modify" && file.category === "source") {
      scores.fix += 2;
      addToBreakdown(breakdowns.fix, "source modify", 2, file.path);
    }
    if (file.category === "test") {
      scores.test += 5;
      addToBreakdown(breakdowns.test, "test", 5, file.path);
    }
    if (file.category === "docs") {
      scores.docs += 5;
      addToBreakdown(breakdowns.docs, "docs", 5, file.path);
    }
    if (file.category === "config") {
      scores.chore += 4;
      addToBreakdown(breakdowns.chore, "config", 4, file.path);
    }
    if (file.category === "generated") {
      scores.chore += 3;
      addToBreakdown(breakdowns.chore, "generated", 3, file.path);
    }
    if (file.path.startsWith("scripts/")) {
      scores.chore += 3;
      addToBreakdown(breakdowns.chore, "scripts", 3, file.path);
    }
    if (file.changeType === "rename") {
      scores.refactor += 3;
      addToBreakdown(breakdowns.refactor, "rename", 3, file.path);
    }
  }

  const diffLower = diff.toLowerCase();

  if (
    diffLower.includes("catch") ||
    diffLower.includes("error") ||
    diffLower.includes("try {")
  ) {
    scores.fix += 2;
    addToBreakdown(breakdowns.fix, "diff: error/catch", 2);
  }

  if (
    diffLower.includes("usememo") ||
    diffLower.includes("usecallback") ||
    diffLower.includes("react.memo") ||
    diffLower.includes("cache") ||
    diffLower.includes("optimize")
  ) {
    scores.perf += 3;
    addToBreakdown(breakdowns.perf, "diff: perf keywords", 3);
  }

  const meaningfulChanges = files.filter(
    (f) => !f.isBinary && f.keyChanges.length > 0,
  );
  if (
    meaningfulChanges.length === 0 ||
    files.every((f) => f.category === "other")
  ) {
    scores.style += 2;
    addToBreakdown(breakdowns.style, "minimal/whitespace", 2);
  }

  let maxScore = 0;
  let detectedType: CommitType = "chore";

  for (const [type, score] of Object.entries(scores) as [
    CommitType,
    number,
  ][]) {
    if (score > maxScore) {
      maxScore = score;
      detectedType = type;
    }
  }

  return { type: detectedType, scores, breakdowns };
}

/**
 * Identifies the primary scope (the "what area changed") from file paths.
 *
 * Scope candidates are scored by path pattern (user scopePatterns first, then
 * DEFAULT_SCOPE_PATTERNS). The highest-scoring candidate wins.
 *
 * Fallbacks when no pattern matches: config → "config", docs → "docs",
 * scripts/ → "scripts", test files → "test".
 *
 * Default: "core"
 */
export function detectPrimaryScope(
  files: FileSummary[],
  config: Config,
): { scope: string; scopeSources: Map<string, string[]> } {
  const scopeCandidates = new Map<string, number>();
  const scopeSources = new Map<string, string[]>();

  const patterns = [
    ...(config.userConfig.scopePatterns ?? []),
    ...DEFAULT_SCOPE_PATTERNS,
  ];

  for (const file of files) {
    let matchedPattern = false;

    for (const { pattern, scope, weight } of patterns) {
      const regex = new RegExp(`^${pattern}`);
      const match = file.path.match(regex);

      if (match) {
        const resolvedScope =
          scope.startsWith("$") && match[1]
            ? scope.replace("$1", match[1])
            : scope;

        scopeCandidates.set(
          resolvedScope,
          (scopeCandidates.get(resolvedScope) ?? 0) + weight,
        );
        const paths = scopeSources.get(resolvedScope) ?? [];
        paths.push(file.path);
        scopeSources.set(resolvedScope, paths);
        matchedPattern = true;
        break;
      }
    }

    if (!matchedPattern) {
      if (file.category === "config") {
        scopeCandidates.set("config", (scopeCandidates.get("config") ?? 0) + 3);
        const paths = scopeSources.get("config") ?? [];
        paths.push(file.path);
        scopeSources.set("config", paths);
      }
      if (file.category === "docs") {
        scopeCandidates.set("docs", (scopeCandidates.get("docs") ?? 0) + 3);
        const paths = scopeSources.get("docs") ?? [];
        paths.push(file.path);
        scopeSources.set("docs", paths);
      }
      if (file.path.startsWith("scripts/")) {
        scopeCandidates.set(
          "scripts",
          (scopeCandidates.get("scripts") ?? 0) + 3,
        );
        const paths = scopeSources.get("scripts") ?? [];
        paths.push(file.path);
        scopeSources.set("scripts", paths);
      }
      if (file.category === "test") {
        scopeCandidates.set("test", (scopeCandidates.get("test") ?? 0) + 2);
        const paths = scopeSources.get("test") ?? [];
        paths.push(file.path);
        scopeSources.set("test", paths);
      }
    }
  }

  let maxScore = 0;
  let primaryScope = "core";

  for (const [scope, score] of scopeCandidates.entries()) {
    if (score > maxScore) {
      maxScore = score;
      primaryScope = scope;
    }
  }

  return { scope: primaryScope, scopeSources };
}

/**
 * Finds secondary scopes for cross-cutting commits.
 *
 * Files matching scope patterns (excluding the primary scope) are counted.
 * Minimum threshold of 2 files per scope prevents noise. Capped at 2 secondary scopes.
 */
export function detectSecondaryScopes(
  files: FileSummary[],
  primaryScope: string,
  config: Config,
): { scopes: string[]; scopeSources: Map<string, string[]> } {
  const scopeCounts = new Map<string, number>();
  const scopeSources = new Map<string, string[]>();

  const patterns = [
    ...(config.userConfig.scopePatterns ?? []),
    ...DEFAULT_SCOPE_PATTERNS,
  ];

  for (const file of files) {
    for (const { pattern, scope } of patterns) {
      const regex = new RegExp(`^${pattern}`);
      const match = file.path.match(regex);

      if (match) {
        const resolvedScope =
          scope.startsWith("$") && match[1]
            ? scope.replace("$1", match[1])
            : scope;

        if (resolvedScope !== primaryScope) {
          scopeCounts.set(
            resolvedScope,
            (scopeCounts.get(resolvedScope) ?? 0) + 1,
          );
          const paths = scopeSources.get(resolvedScope) ?? [];
          paths.push(file.path);
          scopeSources.set(resolvedScope, paths);
        }
        break;
      }
    }
  }

  const scopes = Array.from(scopeCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([scope]) => scope)
    .slice(0, 2);

  return { scopes, scopeSources };
}

/**
 * Builds the audit-trail scorecard for classification transparency.
 *
 * Shows the math: each type's score, how it was derived, winner, and scope sources.
 */
function formatScorecard(
  type: CommitType,
  scores: Record<CommitType, number>,
  breakdowns: Record<CommitType, TypeBreakdown>,
  scope: string,
  scopeSources: Map<string, string[]>,
  secondaryScopes: string[],
  secondaryScopeSources: Map<string, string[]>,
  totalScore: number,
): string {
  const COMMIT_TYPES: CommitType[] = [
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "perf",
    "test",
    "chore",
  ];

  const lines: string[] = [];

  // Type scores (only types with score > 0), sorted by score descending
  const scoredTypes = COMMIT_TYPES.filter((t) => scores[t] > 0).sort(
    (a, b) => scores[b] - scores[a],
  );

  for (const t of scoredTypes) {
    const breakdown = breakdowns[t];
    const contributions = Array.from(breakdown.entries())
      .map(([rule, { pointsEach, count, files }]) =>
        formatRuleContribution(rule, pointsEach, count, files),
      )
      .join(", ");
    const marker = t === type ? " ←" : "";
    lines.push(`  • ${t.padEnd(8)} (${scores[t]}): ${contributions}${marker}`);
  }

  lines.push(`  Winner: ${type} (${scores[type]}/${totalScore} total votes)`);

  // Primary scope with source paths
  const primaryPaths = scopeSources.get(scope) ?? [];
  const scopeHint =
    primaryPaths.length === 0
      ? "default (no pattern match)"
      : primaryPaths.length <= 3
        ? primaryPaths.join(", ")
        : `${primaryPaths.length} files (e.g. ${primaryPaths[0]})`;
  lines.push(`  Primary scope: ${scope} (via ${scopeHint})`);

  if (secondaryScopes.length > 0) {
    const secParts = secondaryScopes.map((s) => {
      const paths = secondaryScopeSources.get(s) ?? [];
      const hint =
        paths.length <= 2
          ? paths.join(", ")
          : `${paths.length} files (e.g. ${paths[0]})`;
      return `${s} (via ${hint})`;
    });
    lines.push(`  Secondary: ${secParts.join("; ")}`);
  }

  return lines.join("\n");
}

/**
 * Combines type detection and scope detection into a single classification result.
 *
 * Confidence is derived from the winning type's score relative to total votes:
 * - high:   winning score ≥ 10
 * - medium: winning score ≥ 5
 * - low:    winning score < 5
 */
export function classifyChanges(
  files: FileSummary[],
  diff: string,
  config: Config,
): ChangeClassification {
  const { type, scores, breakdowns } = detectCommitType(files, diff);
  const { scope, scopeSources } = detectPrimaryScope(files, config);
  const { scopes: secondaryScopes, scopeSources: secondaryScopeSources } =
    detectSecondaryScopes(files, scope, config);

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const topScore = scores[type];
  const confidence: "high" | "medium" | "low" =
    topScore >= 10 ? "high" : topScore >= 5 ? "medium" : "low";

  const reasoning = formatScorecard(
    type,
    scores,
    breakdowns,
    scope,
    scopeSources,
    secondaryScopes,
    secondaryScopeSources,
    totalScore,
  );

  return {
    type,
    scope,
    confidence,
    secondaryScopes,
    reasoning,
    typeScores: scores,
  };
}
