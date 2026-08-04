// =============================================================================
// Configuration Constants
// =============================================================================
//
// Every tuneable constant lives here. Configurable via .convitrc; this file
// provides the fallback defaults.
// =============================================================================

import type { CommitType, ScopePattern, SensitiveDataType } from "../types";

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

/**
 * Default footer trailers appended below the commit body at write time.
 *
 * A custom `Generated-with:` key (not `Co-authored-by:`) is deliberate: GitHub
 * parses `Co-authored-by:` and would render convit — a tool — as a human
 * co-author on the contributor graph. The repo URL makes convit discoverable
 * from any commit (GitHub auto-links bare URLs); the model id is omitted because
 * it varies run-to-run and lives in `.env.local` (treated as secret). Opt into
 * model provenance with the `{model}` placeholder (`"Generated-with: convit
 * ({model})"`). Override via `commit.trailers` in `.convitrc.json`; `[]`
 * disables trailers.
 */
export const DEFAULT_TRAILERS = [
  "Generated-with: convit (https://github.com/Kareem-AEz/convit)",
];

/**
 * Tie-break precedence for the type vote: when two commit types score equal, the
 * one earlier in this list wins. Made explicit (rather than relying on the
 * scores-object key order it used to depend on) so that reordering that object
 * can't silently change classification. `feat`/`fix` lead because they are the
 * most meaningful headlines when file signals are otherwise balanced.
 */
export const TYPE_TIE_BREAK_ORDER: CommitType[] = [
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
];

/**
 * A source `modify` changing this many lines or fewer is "trivial" — it won't
 * suppress the `test` vote when a `.test.ts` co-changes. Above it, the source
 * change is the point of the commit, not the accompanying test (see 2f).
 */
export const TRIVIAL_SOURCE_CHANGE_LINES = 3;

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

/**
 * Max bytes of stdout convit will read from a single `git` subprocess.
 *
 * Node's default `maxBuffer` for `execFileSync` is 1 MiB — small enough that an
 * ordinary large staged change (a lockfile-sized rewrite, a vendored directory,
 * a bulk refactor) makes git overflow it and `spawnSync git ENOBUFS` escapes as
 * an opaque crash. 64 MiB clears any realistic diff while staying finite:
 * `Infinity` would trade a clean error for an out-of-memory kill.
 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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

/** Upper bound on `--candidates <n>` — each candidate is a full generation. */
export const MAX_CANDIDATES = 5;

/** Candidate count for a bare `--candidates` (no number). */
export const DEFAULT_CANDIDATES = 3;

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

/**
 * Per-language declaration patterns for key-change extraction, keyed by file
 * extension. Matched against an added line's trimmed content to decide whether
 * it is a high-signal declaration worth surfacing in the compressed summary.
 *
 * Only JS/TS declarations were recognized before, so a Python/Go/Rust/Java/C#
 * diff surfaced nothing structural. Extensions in `SOURCE_EXTENSIONS` but absent
 * here fall back to `default` (the JS/TS set).
 */
const JS_TS_DECLARATIONS = [
  /^(export\s+)?(async\s+)?function\s+\w+/,
  /^(export\s+)?class\s+\w+/,
  /^(export\s+)?const\s+\w+/,
  /^(export\s+)?(type|interface)\s+\w+/,
];

export const LANGUAGE_DECLARATION_PATTERNS: Record<string, RegExp[]> = {
  default: JS_TS_DECLARATIONS,
  ".ts": JS_TS_DECLARATIONS,
  ".tsx": JS_TS_DECLARATIONS,
  ".js": JS_TS_DECLARATIONS,
  ".jsx": JS_TS_DECLARATIONS,
  ".mjs": JS_TS_DECLARATIONS,
  ".cjs": JS_TS_DECLARATIONS,
  ".py": [/^(async\s+)?def\s+\w+/, /^class\s+\w+/],
  ".go": [/^func\s+/, /^type\s+\w+/],
  ".rs": [
    /^(pub\s+)?(async\s+)?fn\s+\w+/,
    /^(pub\s+)?(unsafe\s+)?(struct|enum|trait|impl|mod)\b/,
  ],
  ".java": [/^(public|private|protected)\b/, /\b(class|interface|enum|record)\s+\w+/],
  ".cs": [
    /^(public|private|protected|internal)\b/,
    /\b(class|interface|enum|record|struct)\s+\w+/,
  ],
};

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
  // Fine-grained GitHub PAT (github_pat_…) — longer, allows underscores.
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/, label: "github_pat" },
  // OpenAI: classic `sk-…48` plus project/service-account prefixes (sk-proj-,
  // sk-svcacct-), which use a longer, `-`/`_`-bearing body.
  { pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, label: "openai_key" },
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/, label: "gitlab_pat" },
  // Google API key (AIza…), 39 chars total.
  { pattern: /AIza[A-Za-z0-9_-]{35}/, label: "gcp_key" },
  // AWS long-term (AKIA) and temporary (ASIA) access key IDs.
  { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/, label: "aws_key" },
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
