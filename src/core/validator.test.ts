import { test, expect } from "vitest";

import {
  generateCorrectionHints,
  getCandidateTemperature,
  getRetryTemperature,
  validateCommitMessage,
} from "./validator";
import { RETRY_TEMPERATURES } from "../config/defaults";
import { makeConfig } from "../test-helpers";

test("getRetryTemperature steps up then clamps to the last value", () => {
  expect(getRetryTemperature(0)).toBe(RETRY_TEMPERATURES[0]);
  expect(getRetryTemperature(1)).toBe(RETRY_TEMPERATURES[1]);
  expect(getRetryTemperature(2)).toBe(RETRY_TEMPERATURES[2]);
  // beyond the table → clamp to the last entry
  expect(getRetryTemperature(99)).toBe(
    RETRY_TEMPERATURES[RETRY_TEMPERATURES.length - 1],
  );
});

test("getCandidateTemperature follows the ladder, then climbs past 0.4, capped at 0.7", () => {
  // First three follow RETRY_TEMPERATURES exactly.
  expect(getCandidateTemperature(0)).toBe(0.2);
  expect(getCandidateTemperature(1)).toBe(0.3);
  expect(getCandidateTemperature(2)).toBe(0.4);
  // Then +0.1 per step — intentionally past the 0.4 retry ceiling.
  expect(getCandidateTemperature(3)).toBeCloseTo(0.5);
  expect(getCandidateTemperature(4)).toBeCloseTo(0.6);
  // Cap holds for any larger index.
  expect(getCandidateTemperature(99)).toBe(0.7);
});

test("validateCommitMessage accepts a well-formed message", () => {
  const result = validateCommitMessage(
    "feat(api): add login route\n\n- adds POST /login",
    makeConfig(),
  );
  expect(result.isValid).toBe(true);
  expect(result.errors).toEqual([]);
});

test("validateCommitMessage rejects a non-conventional first line", () => {
  const result = validateCommitMessage("added some stuff", makeConfig());
  expect(result.isValid).toBe(false);
  expect(result.errors.some((e) => e.includes("type(scope): subject"))).toBe(
    true,
  );
});

test("validateCommitMessage: P3-T4 — a type outside commitlint type-enum is a hard error", () => {
  const config = makeConfig({ commitlint: { types: ["feat", "fix", "chore"] } });
  const result = validateCommitMessage(
    "perf(core): speed up the parser\n\n- memoize the tokenizer",
    config,
  );
  expect(result.isValid).toBe(false);
  expect(result.errors.some((e) => e.includes("not allowed by commitlint"))).toBe(
    true,
  );
});

test("validateCommitMessage: P3-T4 — an allowed type passes the enum gate", () => {
  const config = makeConfig({ commitlint: { types: ["feat", "fix", "chore"] } });
  const result = validateCommitMessage(
    "fix(core): guard against null input\n\n- return early",
    config,
  );
  expect(result.isValid).toBe(true);
});

test("generateCorrectionHints: P3-T4 — a disallowed type yields a must_fix invalid_type hint", () => {
  const config = makeConfig({ commitlint: { types: ["feat", "fix", "chore"] } });
  const hints = generateCorrectionHints(
    "perf(core): speed up the parser\n\n- memoize it",
    config,
  );
  const hint = hints.find((h) => h.issue === "invalid_type");
  expect(hint?.priority).toBe("must_fix");
});

test("validateCommitMessage flags a literal copied example", () => {
  // Asserts the example is *flagged* without binding to errors-vs-warnings:
  // the Phase-1 quick win moves this check from errors → warnings (so isValid
  // becomes true), and this test must survive that move rather than fight it.
  const result = validateCommitMessage(
    "feat(auth): implement password reset functionality",
    makeConfig(),
  );
  const flagged = [...result.errors, ...result.warnings].some((m) =>
    /copied|example/i.test(m),
  );
  expect(flagged).toBe(true);
});

test("validateCommitMessage: a copied example warns but does not block (isValid)", () => {
  // Phase-1 quick win: the copied-example check is advisory now, so a message
  // that trips it is still valid (the warning just nudges the user to verify).
  const result = validateCommitMessage(
    "feat(auth): implement password reset functionality",
    makeConfig(),
  );
  expect(result.isValid).toBe(true);
  expect(result.warnings.some((w) => /copied|example/i.test(w))).toBe(true);
  expect(result.errors.some((e) => /copied|example/i.test(e))).toBe(false);
});

test("validateCommitMessage treats an empty message as invalid", () => {
  const result = validateCommitMessage("   \n  ", makeConfig());
  expect(result.isValid).toBe(false);
  expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
});

test("validateCommitMessage: long subject is a warning, not an error", () => {
  const longSubject = "x".repeat(80);
  const result = validateCommitMessage(`feat(api): ${longSubject}`, makeConfig());
  expect(result.isValid).toBe(true); // length is advisory
  expect(result.warnings.some((w) => w.includes("chars"))).toBe(true);
});

test("generateCorrectionHints flags an over-long subject as should_fix", () => {
  const longSubject = "x".repeat(80);
  const hints = generateCorrectionHints(`feat(api): ${longSubject}`, makeConfig());
  const hint = hints.find((h) => h.issue === "subject_too_long");
  expect(hint).toBeTruthy();
  expect(hint?.priority).toBe("should_fix");
});

// P2-T5: validateCommitMessage and generateCorrectionHints must agree on what
// blocks vs warns. Contract: a check that fails validation (error → isValid
// false) emits a `must_fix` hint; a check that only warns emits `should_fix`.
// These assert *agreement* — both sides for the same triggering message — so
// the test stays meaningful even if one side is later flipped in isolation.
test("P2-T5: soft checks warn in validation and map to should_fix hints", () => {
  const softCases: Array<{ name: string; message: string; issue: string }> = [
    { name: "subject_too_long", message: `feat(api): ${"x".repeat(60)}`, issue: "subject_too_long" },
    { name: "missing_bullets", message: "feat(api): add a thing", issue: "missing_bullets" },
    { name: "subject_wrong_case", message: "feat(api): Add a thing", issue: "subject_wrong_case" },
    { name: "subject_has_period", message: "feat(api): add a thing.", issue: "subject_has_period" },
    { name: "bullet_too_long", message: `feat(api): add x\n\n- ${"y".repeat(80)}`, issue: "bullet_too_long" },
    { name: "copied_example", message: "feat(auth): implement password reset functionality", issue: "copied_example" },
  ];

  for (const { name, message, issue } of softCases) {
    // Validation side: soft → never blocks.
    const result = validateCommitMessage(message, makeConfig());
    expect(result.isValid, `${name} should not block`).toBe(true);

    // Hint side: soft → should_fix, not must_fix.
    const hint = generateCorrectionHints(message, makeConfig()).find(
      (h) => h.issue === issue,
    );
    expect(hint, `${name} should produce a hint`).toBeTruthy();
    expect(hint?.priority, `${name} should be should_fix`).toBe("should_fix");
  }
});

test("P2-T5: the format check blocks in validation and maps to a must_fix hint", () => {
  const message = "not a commit";

  const result = validateCommitMessage(message, makeConfig());
  expect(result.isValid).toBe(false); // blocks

  const hint = generateCorrectionHints(message, makeConfig()).find(
    (h) => h.issue === "invalid_format",
  );
  expect(hint?.priority).toBe("must_fix");
});

test("generateCorrectionHints flags an invalid format", () => {
  const hints = generateCorrectionHints("not a commit", makeConfig());
  expect(hints.some((h) => h.issue === "invalid_format")).toBe(true);
});

test("generateCorrectionHints flags missing bullets against minBullets", () => {
  const cfg = makeConfig({ userConfig: { rules: { minBullets: 2 } } });
  const hints = generateCorrectionHints("feat(api): add x", cfg);
  expect(hints.some((h) => h.issue === "missing_bullets")).toBe(true);
});

// --- Known gaps, fixed by later tasks ----------------------------------------
// Recorded as todos (intended spec-correct behavior in the name) so they go
// red→green with their fix PRs rather than locking in today's wrong behavior.

// P2-T1: one grammar, one source of truth (HEADER_RE). Scope is now optional,
// `!` marks breaking changes, and the standard types build/ci/revert are valid.
test("P2-T1: accepts spec-valid scopeless messages like `fix: x`", () => {
  const result = validateCommitMessage("fix: handle null user", makeConfig());
  expect(result.isValid).toBe(true);
  expect(result.errors).toEqual([]);
});

test("P2-T1: accepts the `!` breaking-change marker", () => {
  const result = validateCommitMessage("feat(api)!: drop v1 endpoints", makeConfig());
  expect(result.isValid).toBe(true);
  expect(result.errors).toEqual([]);
});

test("P2-T1: accepts the standard build/ci/revert types", () => {
  for (const header of ["build: bump tsup", "ci: cache npm", "revert: undo a1b2c3"]) {
    const result = validateCommitMessage(header, makeConfig());
    expect(result.isValid, header).toBe(true);
  }
});

test("P2-T1: a BREAKING CHANGE footer in the body does not fail validation", () => {
  const result = validateCommitMessage(
    "feat(api): add v2\n\n- new route\n\nBREAKING CHANGE: v1 removed",
    makeConfig(),
  );
  expect(result.isValid).toBe(true);
  expect(result.errors).toEqual([]);
});

test("P2-T1: generateCorrectionHints accepts a scopeless header (no invalid_format)", () => {
  const hints = generateCorrectionHints("fix: handle null user", makeConfig());
  expect(hints.some((h) => h.issue === "invalid_format")).toBe(false);
});

// Phase 1 quick win (DONE): "update project dependencies" is a real, common
// chore subject — it must no longer be treated as a copied example.
test("Phase 1 quick win: does not reject a genuine dependency-bump subject", () => {
  const result = validateCommitMessage(
    "chore(deps): update project dependencies\n\n- bump vitest to latest",
    makeConfig(),
  );
  expect(result.isValid).toBe(true);
  const flagged = [...result.errors, ...result.warnings].some((m) =>
    /copied|example/i.test(m),
  );
  expect(flagged).toBe(false);
});
