import { test, expect } from "vitest";

import { buildPrompt } from "./prompts";
import { MAX_DIFF_LENGTH } from "../config/defaults";
import { makeConfig } from "../test-helpers";
import type {
  ChangeClassification,
  SessionState,
  StagedContext,
} from "../types";

function makeClassification(): ChangeClassification {
  return {
    type: "feat",
    scope: "core",
    confidence: "high",
    secondaryScopes: [],
    reasoning: "",
    typeScores: {
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
    },
  };
}

function makeContext(diff: string): StagedContext {
  return {
    fileList: ["src/x.ts"],
    rawDiff: diff,
    processedDiff: diff,
    wasCompressed: false,
    originalLength: diff.length,
    compressedLength: diff.length,
    diffSummary: {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFiles: 1,
      originalLength: diff.length,
    },
    classification: makeClassification(),
    sensitiveMatches: [],
  };
}

const normalState: SessionState = {
  attemptCount: 0,
  mode: "normal",
  userDescription: "",
  previousOutput: null,
  previousValidation: null,
};

function contextWithConfidence(
  confidence: ChangeClassification["confidence"],
): StagedContext {
  const ctx = makeContext("+small change");
  ctx.classification = { ...makeClassification(), confidence, type: "fix" };
  return ctx;
}

test("buildPrompt: P2-T4 — a high-confidence type hint is asserted firmly", () => {
  const prompt = buildPrompt(
    contextWithConfidence("high"),
    normalState,
    "",
    makeConfig(),
    false,
  );
  expect(prompt.user).toContain("this appears to be a 'fix' commit");
});

test("buildPrompt: P2-T4 — a weak type hint is hedged toward the diff", () => {
  for (const confidence of ["medium", "low"] as const) {
    const prompt = buildPrompt(
      contextWithConfidence(confidence),
      normalState,
      "",
      makeConfig(),
      false,
    );
    expect(prompt.user, confidence).not.toContain(
      "this appears to be a 'fix' commit",
    );
    expect(prompt.user, confidence).toContain(
      "decide the type primarily from the diff",
    );
    expect(prompt.user, confidence).toContain(confidence);
  }
});

test("buildPrompt: a diff under the limit is not marked truncated", () => {
  const prompt = buildPrompt(
    makeContext("+small change"),
    normalState,
    "",
    makeConfig(),
    false,
  );
  expect(prompt.diffTruncated).toBe(false);
  expect(prompt.user).not.toContain("[... diff truncated ...]");
});

test("buildPrompt: an over-limit diff is sliced and marked truncated", () => {
  // Build from realistic short lines, not one giant character run: token
  // estimation runs tiktoken over the whole prompt, and a single multi-KB
  // "word" is a pathological (near-quadratic) BPE input.
  const line = "+  const value = computeSomething(input, options);\n";
  const big = line.repeat(Math.ceil((MAX_DIFF_LENGTH + 2000) / line.length));
  expect(big.length).toBeGreaterThan(MAX_DIFF_LENGTH);

  const prompt = buildPrompt(
    makeContext(big),
    normalState,
    "",
    makeConfig(),
    false,
  );
  expect(prompt.diffTruncated).toBe(true);
  expect(prompt.user).toContain("[... diff truncated ...]");
});
