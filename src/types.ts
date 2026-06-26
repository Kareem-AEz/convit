// =============================================================================
// Type Definitions
// =============================================================================
//
// Every shared interface and type alias lives here. Modules import what they
// need from this single source of truth — no cross-module type coupling.
// =============================================================================

/** File category for prioritization and classification */
export type FileCategory =
  | "source" // .ts, .tsx, .js, .jsx, .py, etc.
  | "test" // .test.ts, .spec.ts, __tests__/
  | "config" // .json, .yaml, .rc files
  | "generated" // lock files, prisma client, etc.
  | "docs" // .md, README
  | "asset" // images, fonts, static files
  | "other"; // uncategorized

/** Per-file change analysis */
export interface FileSummary {
  path: string;
  changeType: "add" | "modify" | "delete" | "rename";
  additions: number;
  deletions: number;
  category: FileCategory;
  isBinary: boolean;
  importanceScore: number;
  keyChanges: string[];
  /**
   * Section context git emits on each hunk header (`@@ … @@ <here>`), naming the
   * enclosing function/class the hunk touches — one signal per changed region,
   * deduped. Presentation-only: surfaced in the compressed summary so a wide diff
   * keeps a trace of every concern, but never fed to the classifier's votes.
   */
  hunkContexts: string[];
  /**
   * Added *explanatory* comments — the developer's own "why" (`// preventing the
   * race`, `// making x idempotent`) that compression would otherwise strip.
   * Surfaced as rationale *hints* for the model (a comment can be stale), never
   * voted on. Detected structurally, not by keyword.
   */
  notes: string[];
  /**
   * True when the file's only changes are whitespace/formatting (a prettier/
   * eslint --fix run). Derived by comparing a normal numstat against one taken
   * with `-w --ignore-blank-lines`: real changes in the first but `0 0` in the
   * second means nothing semantic changed. Drives the `style` vote and tells the
   * model not to treat re-added declarations as new code.
   */
  formattingOnly: boolean;
  /** Original path when `changeType === "rename"` (from `rename from`). */
  oldPath?: string;
}

/** Compressed view of all staged changes */
export interface DiffSummary {
  files: FileSummary[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
  originalLength: number;
}

/** Commit type values (runtime) — use for iteration, prompts, etc. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "chore",
  "build",
  "ci",
  "revert",
] as const;

/** Commit type for classification */
export type CommitType = (typeof COMMIT_TYPES)[number];

/**
 * Canonical conventional-commit header matcher — the single source of truth for
 * "does this line look like `type(scope)?!?: subject`".
 *
 * Anchored on the known `COMMIT_TYPES` (not a generic `[a-z]+`) so lowercase
 * chatter like `summary:` or prose like `useEffect(() => {` isn't mistaken for a
 * header. Scope is optional (recognizes scopeless `feat: x`) and `!` marks a
 * breaking change.
 *
 * Has no `g`/`m` flag by design: only test it against a single line at a time —
 * `g` would make `.test()` stateful, `m` would break the per-line contract.
 */
export const HEADER_RE = new RegExp(
  `^(${COMMIT_TYPES.join("|")})(\\([a-zA-Z0-9-]+\\))?!?:\\s*.+$`,
);

/**
 * A regex pattern to map a file path to a specific scope, with a weight for voting.
 */
export interface ScopePattern {
  /** The regex string pattern to match against file paths */
  pattern: string;
  /** The scope to assign if the pattern matches */
  scope: string;
  /** The vote weight to apply (higher means higher priority) */
  weight: number;
}

/**
 * User-provided configuration from .convitrc or package.json.
 *
 * Safe to commit. Provider credentials (URL, key, model) belong in .env only.
 */
export interface UserConfig {
  /** Commit message format rules */
  rules?: {
    maxSubjectLength?: number;
    maxBulletLength?: number;
    minBullets?: number;
    temperature?: number;
    timeout?: number;
    /**
     * Prompt persona / tone. `"conventional"` (default) keeps a neutral,
     * professional Conventional-Commits voice; `"expressive"` opts into the
     * builder/slang persona ("buttery", "band-aid"). An unrecognized value
     * falls back to `"conventional"`. The chosen style governs tone over the
     * repo's recent-commit history (recent commits are reference-only).
     */
    style?: "conventional" | "expressive";
  };
  /** Globs or paths to exclude from analysis */
  exclude?: string[];
  /** Custom scope detection patterns */
  scopePatterns?: ScopePattern[];
  /** Commit-write behavior (footers/trailers). Safe to commit. */
  commit?: {
    /**
     * Footer trailers appended below the commit body before `git commit`.
     * Each entry is a `Key: value` line; `{model}` expands to the resolved
     * model id. Unset → `["Generated-with: convit"]`; `[]` disables trailers.
     */
    trailers?: string[];
  };
}

/** Pre-analysis result for commit type/scope detection */
export interface ChangeClassification {
  type: CommitType;
  scope: string;
  confidence: "high" | "medium" | "low";
  secondaryScopes: string[];
  reasoning: string;
  typeScores: Record<CommitType, number>;
}

/** Validation issue types */
export type ValidationIssue =
  | "subject_too_long"
  | "subject_wrong_case"
  | "subject_has_period"
  | "missing_bullets"
  | "bullet_too_long"
  | "invalid_type"
  | "invalid_scope"
  | "invalid_format"
  | "copied_example";

/** Specific correction hint for retry */
export interface CorrectionHint {
  issue: ValidationIssue;
  description: string;
  suggestion: string;
  priority: "must_fix" | "should_fix";
}

/** Sensitive data types */
export type SensitiveDataType =
  | "api_key"
  | "password"
  | "secret"
  | "token"
  | "private_key"
  | "github_pat"
  | "openai_key"
  | "aws_key"
  | "gitlab_pat"
  | "gcp_key";

/** Result of sensitive data scanning */
export interface SensitiveDataMatch {
  type: SensitiveDataType;
  line: number;
  file: string;
  preview: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/** Runtime configuration parsed from env vars and CLI args */
/**
 * Constraints mapped from a project's commitlint config (P3-T4). Loaded lazily
 * at runtime when `@commitlint/load` resolves from the user's cwd and a config
 * is present; absent otherwise. Most-restrictive-wins against convit's own
 * config: `types` is intersected with `COMMIT_TYPES` (non-empty when set) and
 * the lengths combine with convit's via `Math.min` — so convit never emits a
 * message the team's commit-msg hook would then reject.
 */
export interface CommitlintConstraints {
  /** Allowed types from `type-enum`, intersected with `COMMIT_TYPES`. */
  types?: CommitType[];
  /** Subject char limit from `subject-max-length`. */
  maxSubjectLength?: number;
  /** Body-line char limit from `body-max-line-length`. */
  maxBulletLength?: number;
}

export interface Config {
  apiUrl: string;
  apiKey: string;
  model?: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  dryRun: boolean;
  noCompress: boolean;
  accept: boolean;
  debug: boolean;
  /**
   * Machine-output modes (non-interactive, like `accept`). `json` emits one JSON
   * object to stdout; `print` emits just the message. Both route all human chrome
   * to stderr and, on their own, do **not** commit — combine with `accept` to
   * also create the commit. Precedence when both set: `json` wins.
   */
  json: boolean;
  print: boolean;
  /**
   * Prefer schema-constrained generation (the model emits a validated
   * `{type, scope, subject, body}` object) over free-text parsing. Defaults to
   * true; `--no-structured` forces the free-text path. When the endpoint rejects
   * structured output, convit falls back to free-text automatically.
   */
  structured: boolean;
  timeoutMs: number;
  userConfig: UserConfig;
  exclude: string[];
  /**
   * Resolved footer trailers (from `userConfig.commit.trailers`, defaulting to
   * `DEFAULT_TRAILERS`). Appended below the commit body at write time; `[]`
   * means no trailers.
   */
  trailers: string[];
  /**
   * Constraints from the project's commitlint config, or `undefined` when none
   * applies. Populated asynchronously at the top of the run (after `getConfig`,
   * which is sync) — see `loadCommitlintConstraints`.
   */
  commitlint?: CommitlintConstraints;
}

/** Mutable state for the interactive retry loop */
export interface SessionState {
  attemptCount: number;
  mode: "normal" | "regenerate" | "edit";
  userDescription: string;
  previousOutput: string | null;
  previousValidation: ValidationResult | null;
}

/** Result of analyzing staged git changes */
export interface StagedContext {
  fileList: string[];
  rawDiff: string;
  processedDiff: string;
  wasCompressed: boolean;
  originalLength: number;
  compressedLength: number;
  diffSummary: DiffSummary;
  classification: ChangeClassification;
  sensitiveMatches: SensitiveDataMatch[];
}

/** AI generation result with stats */
export interface GenerateResult {
  message: string;
  validation: ValidationResult;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  tokensFromApi: boolean;
  /** True when the stream was interrupted mid-output and content was salvaged. */
  wasTruncated: boolean;
}

/** A fully assembled prompt ready for the AI */
export interface BuiltPrompt {
  system: string;
  user: string;
  temperature: number;
  estimatedInputTokens: number;
  /** True when the diff was sliced to MAX_DIFF_LENGTH before going into the prompt. */
  diffTruncated: boolean;
}
