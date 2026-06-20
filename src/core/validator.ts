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

import {
  MAX_BULLET_LENGTH,
  MAX_SUBJECT_LENGTH,
  MIN_BULLETS,
  RETRY_TEMPERATURES,
} from "../config/defaults";
import {
  COMMIT_TYPES,
  HEADER_RE,
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
 * Each hint has a `priority`:
 * - `must_fix`: blocking issues the AI must address (format, length, examples)
 * - `should_fix`: style recommendations (casing, trailing period)
 */
export function generateCorrectionHints(
  message: string,
  config: Config,
): CorrectionHint[] {
  const corrections: CorrectionHint[] = [];
  const lines = message.split("\n").filter((l) => l.trim());

  const rules = config.userConfig.rules ?? {};
  const maxSubject = rules.maxSubjectLength ?? MAX_SUBJECT_LENGTH;
  const maxBullet = rules.maxBulletLength ?? MAX_BULLET_LENGTH;
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
      priority: "must_fix",
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
      priority: "must_fix",
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
        priority: "must_fix",
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
  const maxSubject = rules.maxSubjectLength ?? MAX_SUBJECT_LENGTH;
  const maxBullet = rules.maxBulletLength ?? MAX_BULLET_LENGTH;
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
