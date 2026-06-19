import { test, expect } from "vitest";

import {
  generateCorrectionHints,
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

test("generateCorrectionHints flags an over-long subject as must_fix", () => {
  const longSubject = "x".repeat(80);
  const hints = generateCorrectionHints(`feat(api): ${longSubject}`, makeConfig());
  const hint = hints.find((h) => h.issue === "subject_too_long");
  expect(hint).toBeTruthy();
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

// P2-T1: the grammar hardcodes a mandatory scope, so spec-valid scopeless
// `fix: x` is wrongly rejected.
test.todo("P2-T1: accepts spec-valid scopeless messages like `fix: x`");

// Phase 1 quick win: "update project dependencies" is a real, common chore
// subject but is currently treated as a copied example and marked invalid.
test.todo(
  "Phase 1 quick win: does not reject a genuine dependency-bump subject",
);
