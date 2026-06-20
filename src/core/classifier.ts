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

import {
  COMMIT_TYPES,
  type ChangeClassification,
  type CommitType,
  type FileCategory,
  type FileSummary,
  type Config,
} from "../types";
import {
  DEFAULT_SCOPE_PATTERNS,
  TRIVIAL_SOURCE_CHANGE_LINES,
} from "../config/defaults";

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
  build: "build/tooling configs",
  ci: "CI pipeline files",
  formatting: "formatting-only changes",
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
    build: 0,
    ci: 0,
    revert: 0,
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
    build: new Map(),
    ci: new Map(),
    revert: new Map(),
  };

  // 2f: when a non-test source file changed materially, accompanying test edits
  // shouldn't make this a `test` commit — down-weight the test vote so the
  // source change drives the type. "Material" = a new source file or a
  // non-formatting modify beyond a trivial line count.
  const hasMaterialSourceChange = files.some(
    (f) =>
      f.category === "source" &&
      !f.formattingOnly &&
      (f.changeType === "add" ||
        (f.changeType === "modify" &&
          f.additions + f.deletions > TRIVIAL_SOURCE_CHANGE_LINES)),
  );

  for (const file of files) {
    // 2a: a reformatted file casts no feat/fix vote — its added lines are
    // re-emitted existing code, not new behavior.
    if (
      file.changeType === "add" &&
      file.category === "source" &&
      !file.formattingOnly
    ) {
      scores.feat += 2;
      addToBreakdown(breakdowns.feat, "source add", 2, file.path);
    }
    if (
      file.changeType === "modify" &&
      file.category === "source" &&
      !file.formattingOnly
    ) {
      scores.fix += 2;
      addToBreakdown(breakdowns.fix, "source modify", 2, file.path);
    }
    if (file.category === "test") {
      const weight = hasMaterialSourceChange ? 1 : 5;
      scores.test += weight;
      addToBreakdown(breakdowns.test, "test", weight, file.path);
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
    // Build tooling: bundler/build configs (*.config.{ts,js,…}) and Docker.
    // Weight 5 so a tooling-only change outscores the +2/+4 source/config votes
    // these same files also cast.
    if (
      /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/.test(file.path) ||
      /(?:^|\/)\.dockerignore$/.test(file.path) ||
      /\.config\.(?:ts|js|mjs|cjs)$/.test(file.path)
    ) {
      scores.build += 5;
      addToBreakdown(breakdowns.build, "build", 5, file.path);
    }
    // CI pipelines: GitHub Actions workflows and common CI configs.
    if (
      file.path.startsWith(".github/workflows/") ||
      /(?:^|\/)\.gitlab-ci\.yml$/.test(file.path) ||
      /(?:^|\/)\.travis\.yml$/.test(file.path) ||
      /(?:^|\/)azure-pipelines\.yml$/.test(file.path) ||
      file.path.includes(".circleci/")
    ) {
      scores.ci += 5;
      addToBreakdown(breakdowns.ci, "ci", 5, file.path);
    }
    // 2a: a pure reformat votes style — and outscores the (now suppressed)
    // source vote so a prettier run is classified as `style`, not `fix`.
    if (file.formattingOnly) {
      scores.style += 5;
      addToBreakdown(breakdowns.style, "formatting", 5, file.path);
    }
  }

  // 2b: scan only added (`+`) lines, with word boundaries — so context lines,
  // removed code, and identifiers like `cachedEncoder` don't cast spurious
  // votes (substring `cache` over the whole diff used to fake a perf signal).
  const addedText = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n")
    .toLowerCase();

  if (/\b(?:error|catch)\b/.test(addedText) || /\btry\s*\{/.test(addedText)) {
    scores.fix += 2;
    addToBreakdown(breakdowns.fix, "diff: error/catch", 2);
  }

  if (
    /\buse(?:memo|callback)\b/.test(addedText) ||
    /react\.memo\b/.test(addedText) ||
    /\bcache\b/.test(addedText) ||
    /\boptimi[sz]e\b/.test(addedText)
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
/** A scope pattern with its anchored regex precompiled. */
interface CompiledScopePattern {
  regex: RegExp;
  scope: string;
  weight: number;
}

/**
 * Compiles user + default scope patterns once, anchored at the start of the
 * path. User patterns come from `.convitrc.json`, so a single typo (e.g. `src/(`)
 * must not crash the CLI: invalid regexes are warned about and skipped.
 */
export function compileScopePatterns(config: Config): CompiledScopePattern[] {
  const patterns = [
    ...(config.userConfig.scopePatterns ?? []),
    ...DEFAULT_SCOPE_PATTERNS,
  ];

  const compiled: CompiledScopePattern[] = [];
  for (const { pattern, scope, weight } of patterns) {
    try {
      compiled.push({ regex: new RegExp(`^${pattern}`), scope, weight });
    } catch (err) {
      console.warn(
        `convit: skipping invalid scopePattern ${JSON.stringify(pattern)} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return compiled;
}

/**
 * Resolves the scope(s) a single file contributes to — the one shared rule used
 * by both primary and secondary detection (2e). A pattern match wins outright
 * (first match, user patterns first); otherwise the category/path fallbacks
 * apply. Returning the fallbacks here (not just to primary) is what lets
 * docs/config/test/scripts appear as *secondary* scopes too.
 */
function resolveFileScopes(
  file: FileSummary,
  patterns: CompiledScopePattern[],
): { scope: string; weight: number }[] {
  for (const { regex, scope, weight } of patterns) {
    const match = file.path.match(regex);
    if (match) {
      const resolvedScope =
        scope.startsWith("$") && match[1]
          ? scope.replace("$1", match[1])
          : scope;
      return [{ scope: resolvedScope, weight }];
    }
  }

  const fallbacks: { scope: string; weight: number }[] = [];
  if (file.category === "config") fallbacks.push({ scope: "config", weight: 3 });
  if (file.category === "docs") fallbacks.push({ scope: "docs", weight: 3 });
  if (file.path.startsWith("scripts/"))
    fallbacks.push({ scope: "scripts", weight: 3 });
  if (file.category === "test") fallbacks.push({ scope: "test", weight: 2 });
  return fallbacks;
}

export function detectPrimaryScope(
  files: FileSummary[],
  config: Config,
  compiledPatterns?: CompiledScopePattern[],
): { scope: string; scopeSources: Map<string, string[]> } {
  const scopeCandidates = new Map<string, number>();
  const scopeSources = new Map<string, string[]>();

  const patterns = compiledPatterns ?? compileScopePatterns(config);

  for (const file of files) {
    for (const { scope, weight } of resolveFileScopes(file, patterns)) {
      scopeCandidates.set(scope, (scopeCandidates.get(scope) ?? 0) + weight);
      const paths = scopeSources.get(scope) ?? [];
      paths.push(file.path);
      scopeSources.set(scope, paths);
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
  compiledPatterns?: CompiledScopePattern[],
): { scopes: string[]; scopeSources: Map<string, string[]> } {
  const scopeCounts = new Map<string, number>();
  const scopeSources = new Map<string, string[]>();

  const patterns = compiledPatterns ?? compileScopePatterns(config);

  for (const file of files) {
    for (const { scope } of resolveFileScopes(file, patterns)) {
      if (scope === primaryScope) continue;
      scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      const paths = scopeSources.get(scope) ?? [];
      paths.push(file.path);
      scopeSources.set(scope, paths);
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
  // Compile once so an invalid user pattern warns a single time, not per detector.
  const compiledPatterns = compileScopePatterns(config);
  const { scope, scopeSources } = detectPrimaryScope(
    files,
    config,
    compiledPatterns,
  );
  const { scopes: secondaryScopes, scopeSources: secondaryScopeSources } =
    detectSecondaryScopes(files, scope, config, compiledPatterns);

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
