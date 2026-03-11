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
] as const;

/** Commit type for classification */
export type CommitType = (typeof COMMIT_TYPES)[number];

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
  };
  /** Globs or paths to exclude from analysis */
  exclude?: string[];
  /** Custom scope detection patterns */
  scopePatterns?: ScopePattern[];
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
  | "aws_key";

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
  timeoutMs: number;
  userConfig: UserConfig;
  exclude: string[];
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
}

/** A fully assembled prompt ready for the AI */
export interface BuiltPrompt {
  system: string;
  user: string;
  temperature: number;
  estimatedInputTokens: number;
}
