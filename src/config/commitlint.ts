// =============================================================================
// commitlint interop (P3-T4)
// =============================================================================
//
// Teams with an existing commit-msg/commitlint hook get contradictory rules
// unless convit honors their config. This module loads the project's commitlint
// config (if any) and maps the subset convit can act on into a
// `CommitlintConstraints` — most-restrictive-wins so convit never emits a
// message the team's hook would then reject.
//
// v1 maps `type-enum`, `subject-max-length`, and `body-max-line-length`.
// `scope-enum` and `header-max-length` are deliberately NOT mapped: convit's
// scope is path-derived (enforcing an enum is invasive and low-value), and
// `header-max-length` covers the whole `type(scope): subject` line, not just the
// subject — a different quantity than convit's `maxSubjectLength`.
// =============================================================================

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_BULLET_LENGTH, MAX_SUBJECT_LENGTH } from "./defaults";
import { COMMIT_TYPES } from "../types";
import type { CommitlintConstraints, CommitType, Config } from "../types";

// A commitlint rule is a tuple `[level, applicable, value?]`:
//   level:      0 disabled | 1 warning | 2 error
//   applicable: "always" | "never"
type RuleTuple = [number, "always" | "never", unknown?];

/**
 * Loads the project's commitlint config and maps it to convit constraints, or
 * returns `null` when none applies. Fail-open by design: any error — no config,
 * `@commitlint/load` not installed, malformed rules — yields `null`. commitlint
 * interop is a convenience and must never block a commit.
 *
 * Resolution is rooted at `cwd` (the project being committed), NOT convit's own
 * install location. A globally-installed convit must find the *project's*
 * `@commitlint/load` and the *project's* config — including
 * `extends: ['@commitlint/config-conventional']`, whose rules live in the
 * extended package that only `@commitlint/load` can resolve. A bare
 * `import("@commitlint/load")` would resolve against convit's global tree and
 * miss both.
 */
export async function loadCommitlintConstraints(
  cwd: string,
): Promise<CommitlintConstraints | null> {
  try {
    // Resolve the package from the project root, then import the resolved path.
    const projectRequire = createRequire(
      pathToFileURL(path.join(cwd, "package.json")),
    );
    const loadPath = projectRequire.resolve("@commitlint/load");
    const mod = await import(pathToFileURL(loadPath).href);

    // CJS/ESM interop: the default export is the `load` function; some bundlers
    // nest it one level deeper as `default.default`.
    const candidate = mod.default ?? mod;
    const load: unknown =
      typeof candidate === "function" ? candidate : candidate?.default;
    if (typeof load !== "function") return null;

    // Pass `cwd` so commitlint discovers the *project's* config, not convit's.
    const result = await (load as (s: object, o: object) => Promise<unknown>)(
      {},
      { cwd },
    );
    const rules = (result as { rules?: unknown })?.rules;
    if (!rules || typeof rules !== "object") return null;

    return mapRules(rules as Record<string, RuleTuple>);
  } catch {
    return null;
  }
}

/**
 * Pure mapping from commitlint `rules` to convit constraints. Returns `null`
 * when nothing maps. Exported for unit tests.
 */
export function mapRules(
  rules: Record<string, RuleTuple>,
): CommitlintConstraints | null {
  const out: CommitlintConstraints = {};

  // type-enum is the only mapped rule that becomes a HARD block in convit (the
  // validator errors and `--accept` fails). Honor it only at error level (2): a
  // warning-level enum does not *reject* the commit in the team's hook, and the
  // feature's guarantee is "never emit what the hook rejects" — convit must not
  // be stricter than commitlint itself. (Lengths stay level >= 1 below: they are
  // advisory in convit, so mapping a warning never hard-blocks.)
  const typeEnum = rules["type-enum"];
  if (
    Array.isArray(typeEnum) &&
    typeEnum[0] === 2 &&
    typeEnum[1] === "always" &&
    Array.isArray(typeEnum[2])
  ) {
    const allowed = (typeEnum[2] as unknown[])
      .filter((t): t is string => typeof t === "string")
      .filter((t): t is CommitType =>
        (COMMIT_TYPES as readonly string[]).includes(t),
      );
    // Only constrain when the intersection is non-empty: an empty allowed set is
    // unsatisfiable and would break the grammar, so treat it as "no constraint".
    if (allowed.length > 0) out.types = allowed;
  }

  const subjectMax = lengthValue(rules["subject-max-length"]);
  if (subjectMax !== null) out.maxSubjectLength = subjectMax;

  const bodyMax = lengthValue(rules["body-max-line-length"]);
  if (bodyMax !== null) out.maxBulletLength = bodyMax;

  return Object.keys(out).length > 0 ? out : null;
}

/** A rule counts when it exists and is enabled (warning or error, not 0). */
function isEnabled(rule: RuleTuple | undefined): rule is RuleTuple {
  return Array.isArray(rule) && typeof rule[0] === "number" && rule[0] >= 1;
}

/** Extracts a positive numeric length from an enabled `always` length rule. */
function lengthValue(rule: RuleTuple | undefined): number | null {
  if (!isEnabled(rule) || rule[1] !== "always") return null;
  const v = rule[2];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The effective subject limit: most-restrictive-wins between convit's own
 * resolved limit (user config or default) and any commitlint `subject-max-length`.
 */
export function effectiveMaxSubject(config: Config): number {
  const base = config.userConfig.rules?.maxSubjectLength ?? MAX_SUBJECT_LENGTH;
  const cl = config.commitlint?.maxSubjectLength;
  return cl != null ? Math.min(base, cl) : base;
}

/** The effective bullet/body-line limit: most-restrictive-wins (see above). */
export function effectiveMaxBullet(config: Config): number {
  const base = config.userConfig.rules?.maxBulletLength ?? MAX_BULLET_LENGTH;
  const cl = config.commitlint?.maxBulletLength;
  return cl != null ? Math.min(base, cl) : base;
}
