// =============================================================================
// Configuration Constants
// =============================================================================
//
// Every tuneable constant lives here. Configurable via .convitrc; this file
// provides the fallback defaults.
// =============================================================================

import type { ScopePattern, SensitiveDataType } from "../types";

export const DEFAULT_MODEL = "openai/gpt-oss-20b";

/**
 * Maximum characters of diff to include in prompt.
 * Compressed diffs rarely approach this limit — it's a final safety cap.
 */
export const MAX_DIFF_LENGTH = 100_000;

/** 0.2–0.3 is ideal for commit messages: focused, well-formatted, not robotic */
export const TEMPERATURE = 0.2;

export const MIN_BULLETS = 1;
export const MAX_SUBJECT_LENGTH = 50;
export const MAX_BULLET_LENGTH = 72;

/** Files excluded from diff context (noise, auto-generated, or oversized) */
export const EXCLUDED_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  ".turbo",
  "target/",
  "__pycache__/",
  ".pytest_cache/",
];

/** Characters threshold before diff compression activates */
export const COMPRESSION_THRESHOLD = 10_000;

/** File count before a degradation warning is shown */
export const MAX_FILES_FULL_QUALITY = 100;

/** Total retry attempts before forcing y/n/e choice */
export const MAX_RETRY_ATTEMPTS = 3;

/** Default API request timeout in milliseconds (LLM generation) */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Temperature steps per retry — increases variety on each attempt */
export const RETRY_TEMPERATURES = [0.2, 0.3, 0.4];

export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
];

export const GENERATED_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /Gemfile\.lock$/,
  /generated\//,
  /\.min\.(js|css)$/,
  /dist\//,
  /build\//,
  /target\//,
  /__pycache__\//,
  /\.pytest_cache\//,
];

// =============================================================================
// Sensitive Data Patterns
// =============================================================================

/**
 * Regex patterns for common sensitive data formats.
 *
 * Design choices:
 * - Conservative matching (low false positives). A key must look like an
 *   assignment (`key = value`) with a minimum length to filter noise.
 * - Known token formats (GitHub PAT `ghp_`, OpenAI `sk-`, AWS `AKIA`) use
 *   exact prefix+length patterns — these are canonical and nearly zero false-positive.
 * - The generic "api_key/secret/token" patterns require ≥20 char values to
 *   avoid matching innocuous config values like `token: "local"`.
 * - Value-quoting is **optional**: bare `KEY=value` assignments (no surrounding
 *   quotes) in `.env` / YAML / shell diffs are caught, not just quoted source
 *   literals. `.env` is not in EXCLUDED_FILES, so it reaches the scanner.
 *
 * Ordering matters: specific token formats are listed **before** the generic
 * key=value patterns. The detect loop reports matches in array order, so when a
 * line matches both (e.g. `GITHUB_TOKEN=ghp_...` hits both `github_pat` and the
 * generic `secret`), the precise label wins `matches[0]`.
 */
export const SENSITIVE_PATTERNS: Array<{
  pattern: RegExp;
  label: SensitiveDataType;
}> = [
  // Specific, canonical formats first (precise label wins on collisions).
  {
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/,
    label: "private_key",
  },
  { pattern: /ghp_[A-Za-z0-9]{36}/, label: "github_pat" },
  { pattern: /sk-[A-Za-z0-9]{48}/, label: "openai_key" },
  { pattern: /AKIA[0-9A-Z]{16}/, label: "aws_key" },
  // Generic key=value patterns (quoted OR unquoted value).
  {
    pattern:
      /['"]?(?:api[_-]?key|apikey)['"]?\s*[:=]\s*(?:['"]\S{20,}['"]|\S{20,})/gi,
    label: "api_key",
  },
  {
    pattern:
      /['"]?(?:password|passwd|pwd)['"]?\s*[:=]\s*(?:['"][^'"]{8,}['"]|\S{8,})/gi,
    label: "password",
  },
  {
    pattern: /['"]?(?:secret|token)['"]?\s*[:=]\s*(?:['"]\S{20,}['"]|\S{20,})/gi,
    label: "secret",
  },
];

// =============================================================================
// Default Scope Patterns
// =============================================================================
// Language-agnostic defaults. Use `convit init` or scopePatterns in .convitrc
// to add framework-specific patterns (Next.js, Rust, Go, etc.).
// =============================================================================

export const DEFAULT_SCOPE_PATTERNS: ScopePattern[] = [
  // Monorepos
  { pattern: "packages/([^/]+)/.*", scope: "$1", weight: 10 },
  // Generic source directories
  { pattern: "src/([^/]+)/.*", scope: "$1", weight: 8 },
  // Common UI/Frontend
  { pattern: "components/.*", scope: "ui", weight: 5 },
  // Schema / DB (generic)
  { pattern: "schema.*", scope: "db", weight: 5 },
];
