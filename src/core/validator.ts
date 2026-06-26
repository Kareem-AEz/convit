// =============================================================================
// Validation & Correction Engine
// =============================================================================
//
// Two complementary systems:
// 1. `validateCommitMessage` — answers "is this valid?" (boolean, for the UI)
// 2. `generateCorrectionHints` — answers "how do I fix it?" (instructions, for the AI)
//
// Pure functions — no I/O, no side effects.
// =============================================================================

import { MIN_BULLETS, RETRY_TEMPERATURES } from "../config/defaults";
import {
  effectiveMaxBullet,
  effectiveMaxSubject,
} from "../config/commitlint";
import {
  COMMIT_TYPES,
  HEADER_RE,
  type CommitType,
  type Config,
  type CorrectionHint,
  type ValidationResult,
} from "../types";

/**
 * Returns the temperature for a given retry attempt.
 *
 * On the first attempt we use a low temperature (0.2) for precise output.
 * On each retry, we increase it slightly to explore different phrasings.
 * Beyond 0.4, commit messages start becoming too creative and verbose.
 */
export function getRetryTemperature(
  attemptCount: number,
  _baseTemperature: number = 0.2,
): number {
  if (attemptCount >= RETRY_TEMPERATURES.length) {
    return RETRY_TEMPERATURES[RETRY_TEMPERATURES.length - 1];
  }
  return RETRY_TEMPERATURES[attemptCount];
}

/**
 * Analyzes a previously generated commit message and produces structured
 * correction hints for the next retry attempt.
 *
 * Each hint's `priority` mirrors what `validateCommitMessage` does with the same
 * check, so the two stay in agreement (P2-T5):
 * - `must_fix`: checks that fail validation (set `isValid: false`) — the format
 *   grammar and an empty message.
 * - `should_fix`: checks that only warn — subject length/casing/period, bullet
 *   count/length, and copied-example detection (all advisory, never blocking).
 */
export function generateCorrectionHints(
  message: string,
  config: Config,
): CorrectionHint[] {
  const corrections: CorrectionHint[] = [];
  const lines = message.split("\n").filter((l) => l.trim());

  const rules = config.userConfig.rules ?? {};
  const maxSubject = effectiveMaxSubject(config);
  const maxBullet = effectiveMaxBullet(config);
  const minBullets = rules.minBullets ?? MIN_BULLETS;

  if (lines.length === 0) return corrections;

  const firstLine = lines[0];
  const subjectMatch = firstLine.match(/:\s*(.+)$/);
  const subject = subjectMatch ? subjectMatch[1] : "";

  if (subject.length > maxSubject) {
    corrections.push({
      issue: "subject_too_long",
      description: `Subject is ${subject.length} characters (max: ${maxSubject})`,
      suggestion: `Shorten the subject to under ${maxSubject} characters. Current: "${subject.substring(0, 60)}..."`,
      priority: "should_fix",
    });
  }

  if (subject[0] && subject[0] !== subject[0].toLowerCase()) {
    corrections.push({
      issue: "subject_wrong_case",
      description: "Subject should start with lowercase",
      suggestion: `Change "${subject[0]}" to "${subject[0].toLowerCase()}" at the start of the subject.`,
      priority: "should_fix",
    });
  }

  if (subject.endsWith(".")) {
    corrections.push({
      issue: "subject_has_period",
      description: "Subject should not end with a period",
      suggestion: "Remove the period at the end of the subject line.",
      priority: "should_fix",
    });
  }

  const bullets = lines.filter((l) => l.trim().startsWith("-"));
  if (bullets.length < minBullets) {
    corrections.push({
      issue: "missing_bullets",
      description: `Only ${bullets.length} bullet point(s), need at least ${minBullets}`,
      suggestion: `Add ${minBullets - bullets.length} more bullet point(s) explaining the key changes.`,
      priority: "should_fix",
    });
  }

  bullets.forEach((bullet, idx) => {
    const bulletText = bullet.trim().substring(1).trim();
    if (bulletText.length > maxBullet) {
      corrections.push({
        issue: "bullet_too_long",
        description: `Bullet ${idx + 1} is ${bulletText.length} characters`,
        suggestion: `Shorten bullet ${idx + 1} to under ${maxBullet} chars: "${bulletText.substring(0, 50)}..."`,
        priority: "should_fix",
      });
    }
  });

  if (!HEADER_RE.test(firstLine)) {
    corrections.push({
      issue: "invalid_format",
      description: "First line doesn't match conventional commit format",
      suggestion: `Use format: type(scope): subject — scope is optional and type is one of ${COMMIT_TYPES.join("/")}.`,
      priority: "must_fix",
    });
  } else if (!isTypeAllowed(firstLine, config)) {
    // The format is valid but the type is outside the project's commitlint
    // `type-enum` (P3-T4) — must_fix, since the team's hook would reject it.
    const allowed = config.commitlint!.types!;
    corrections.push({
      issue: "invalid_type",
      description: `Type "${headerType(firstLine)}" is not in the commitlint type-enum`,
      suggestion: `Use one of the allowed types: ${allowed.join("/")}.`,
      priority: "must_fix",
    });
  }

  const examplePhrases = [
    "password reset functionality",
    "race condition in user cache",
  ];
  for (const phrase of examplePhrases) {
    if (message.toLowerCase().includes(phrase.toLowerCase())) {
      corrections.push({
        issue: "copied_example",
        description: "Message appears to contain example text from the prompt",
        suggestion:
          "Write about the actual changes in the diff, not the examples.",
        priority: "should_fix",
      });
      break;
    }
  }

  return corrections;
}

/**
 * Builds a targeted correction prompt to send on a validation-failed retry.
 *
 * Escalation strategy:
 * - `must_fix` items are always included
 * - `should_fix` items are only added after the first attempt (`attemptCount > 0`)
 *
 * The previous output is included verbatim so the model can see exactly what
 * needs changing — it shouldn't start from scratch, just fix the flagged issues.
 */
export function buildRefinementPrompt(
  previousOutput: string,
  corrections: CorrectionHint[],
  attemptCount: number,
): string {
  const mustFix = corrections.filter((c) => c.priority === "must_fix");
  const shouldFix = corrections.filter((c) => c.priority === "should_fix");

  let prompt = `The previous output had validation issues. Please fix the following:\n\n`;

  if (mustFix.length > 0) {
    prompt += `REQUIRED FIXES:\n`;
    mustFix.forEach((correction, idx) => {
      prompt += `${idx + 1}. ${correction.suggestion}\n`;
    });
    prompt += `\n`;
  }

  if (shouldFix.length > 0 && attemptCount > 0) {
    prompt += `RECOMMENDED FIXES:\n`;
    shouldFix.forEach((correction, idx) => {
      prompt += `${idx + 1}. ${correction.suggestion}\n`;
    });
    prompt += `\n`;
  }

  prompt += `Previous output:\n${previousOutput}\n\nGenerate a corrected version that addresses the issues above. Keep other parts unchanged if they were correct.`;

  return prompt;
}

/**
 * Validates a commit message against the conventional commit format and project
 * style rules.
 *
 * Two-tier result system:
 * - `errors` → hard failures that set `isValid: false`
 * - `warnings` → soft recommendations that don't block the commit
 *
 * Example phrase detection guards against models that literally copy the
 * examples from the system prompt instead of analyzing the actual diff.
 */
export function validateCommitMessage(
  message: string,
  config: Config,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = message.split("\n").filter((l) => l.trim());

  const rules = config.userConfig.rules ?? {};
  const maxSubject = effectiveMaxSubject(config);
  const maxBullet = effectiveMaxBullet(config);
  const minBullets = rules.minBullets ?? MIN_BULLETS;

  if (lines.length === 0) {
    errors.push("Commit message is empty");
    return { isValid: false, errors, warnings };
  }

  const examplePhrases = [
    "password reset functionality",
    "race condition in user cache",
    "Implement password reset API",
    "Add mutex lock to cache",
  ];

  const messageText = message.toLowerCase();
  const copiedExamples = examplePhrases.filter((phrase) =>
    messageText.includes(phrase.toLowerCase()),
  );

  // Advisory, not a hard error: a real subject can legitimately echo a phrase
  // (e.g. a genuine dependency bump). Flag it so the user can verify, but don't
  // block --accept on it.
  if (copiedExamples.length > 0) {
    warnings.push(
      "Possible copied example text — verify the message describes your actual changes, not the prompt's examples.",
    );
  }

  const firstLine = lines[0];
  if (!HEADER_RE.test(firstLine)) {
    errors.push("First line must match: type(scope): subject (scope optional)");
  } else if (!isTypeAllowed(firstLine, config)) {
    // Format is valid but the type violates the project's commitlint type-enum
    // (P3-T4) — a hard error, since the team's commit-msg hook would reject it.
    errors.push(
      `Type "${headerType(firstLine)}" is not allowed by commitlint (allowed: ${config.commitlint!.types!.join(
        ", ",
      )})`,
    );
  }

  const subjectMatch = firstLine.match(/:\s*(.+)$/);
  if (subjectMatch) {
    const subject = subjectMatch[1];
    if (subject.length > maxSubject) {
      warnings.push(
        `Subject is ${subject.length} chars (recommended max: ${maxSubject})`,
      );
    }
    if (subject.endsWith("."))
      warnings.push("Subject should not end with a period");
    if (subject[0] !== subject[0].toLowerCase())
      warnings.push("Subject should start with lowercase");
  }

  const bullets = lines.filter((l) => l.trim().startsWith("-"));
  if (bullets.length < minBullets) {
    warnings.push(
      `Only ${bullets.length} bullet point(s) (recommended: at least ${minBullets})`,
    );
  }

  bullets.forEach((bullet, idx) => {
    const bulletText = bullet.trim().substring(1).trim();
    if (bulletText.length > maxBullet) {
      warnings.push(
        `Bullet ${idx + 1} is ${bulletText.length} chars (max: ${maxBullet})`,
      );
    }
  });

  return { isValid: errors.length === 0, errors, warnings };
}

/** Extracts the commit type from a header line, or `null` if it doesn't match. */
function headerType(firstLine: string): string | null {
  const m = firstLine.match(HEADER_RE);
  return m ? m[1] : null;
}

/**
 * True unless the project's commitlint `type-enum` (P3-T4) is set AND the
 * header's type is outside it. Unconstrained (no commitlint, no type-enum) is
 * always allowed; a header that doesn't parse is left to the format check.
 */
function isTypeAllowed(firstLine: string, config: Config): boolean {
  const allowed = config.commitlint?.types;
  if (!allowed) return true;
  const type = headerType(firstLine);
  return type === null || allowed.includes(type as CommitType);
}
