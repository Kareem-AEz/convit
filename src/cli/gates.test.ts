import { test, expect } from "vitest";

import {
  buildCandidateOptions,
  evaluateAutoAcceptGate,
  evaluateSensitiveAcceptGate,
  pickAcceptableCandidate,
} from "./gates";
import type { GenerateResult, SensitiveDataMatch } from "../types";

/** Minimal candidate; override message/validity/truncation/temperature. */
function makeResult(over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    message: "feat(cli): do a thing",
    validation: { isValid: true, errors: [], warnings: [] },
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1000,
    tokensFromApi: true,
    wasTruncated: false,
    temperature: 0.2,
    ...over,
  };
}

const aMatch: SensitiveDataMatch = {
  type: "api_key",
  line: 1,
  file: ".env",
  preview: "ghp_****",
};

test("evaluateSensitiveAcceptGate: --accept + a sensitive match is a hard block", () => {
  const gate = evaluateSensitiveAcceptGate(true, [aMatch]);
  expect(gate.ok).toBe(false);
  if (!gate.ok) expect(gate.code).toBe(1);
});

test("evaluateSensitiveAcceptGate: --accept with no matches proceeds", () => {
  expect(evaluateSensitiveAcceptGate(true, []).ok).toBe(true);
});

test("evaluateSensitiveAcceptGate: interactive mode defers to the confirm prompt", () => {
  // Not --accept → the interactive gate owns the decision; helper proceeds.
  expect(evaluateSensitiveAcceptGate(false, [aMatch]).ok).toBe(true);
});

test("evaluateAutoAcceptGate: an invalid message is blocked", () => {
  const gate = evaluateAutoAcceptGate({
    validation: { isValid: false, errors: ["bad"], warnings: [] },
    wasTruncated: false,
  });
  expect(gate.ok).toBe(false);
  if (!gate.ok) expect(gate.reason).toMatch(/validation/i);
});

test("evaluateAutoAcceptGate: a truncated stream is blocked, and reports truncation", () => {
  // Even when validation passes, an incomplete stream must not auto-commit;
  // truncation is checked first so the more specific reason wins.
  const gate = evaluateAutoAcceptGate({
    validation: { isValid: true, errors: [], warnings: [] },
    wasTruncated: true,
  });
  expect(gate.ok).toBe(false);
  if (!gate.ok) expect(gate.reason).toMatch(/truncat/i);
});

test("evaluateAutoAcceptGate: a valid, complete message proceeds", () => {
  const gate = evaluateAutoAcceptGate({
    validation: { isValid: true, errors: [], warnings: [] },
    wasTruncated: false,
  });
  expect(gate.ok).toBe(true);
});

// -- candidate picker (P3-T5 --candidates) --

test("pickAcceptableCandidate: picks the first candidate that passes the gate", () => {
  const batch = [
    makeResult({ wasTruncated: true }), // gate-fail (truncated)
    makeResult({ validation: { isValid: false, errors: ["x"], warnings: [] } }), // gate-fail (invalid)
    makeResult({ message: "feat(cli): the winner" }), // first gate-pass
    makeResult({ message: "feat(cli): also fine" }),
  ];
  expect(pickAcceptableCandidate(batch)).toBe(2);
});

test("pickAcceptableCandidate: selects on the gate, not bare validity (truncated-but-valid is skipped)", () => {
  // A truncated message can still be format-valid; the gate rejects it, so a
  // later clean candidate must win — proving selection uses the gate criterion.
  const batch = [
    makeResult({ wasTruncated: true }), // valid format but truncated → gate-fail
    makeResult({ message: "feat(cli): clean one" }), // gate-pass
  ];
  expect(pickAcceptableCandidate(batch)).toBe(1);
});

test("pickAcceptableCandidate: falls back to index 0 when none pass the gate", () => {
  const batch = [
    makeResult({ wasTruncated: true }),
    makeResult({ validation: { isValid: false, errors: ["x"], warnings: [] } }),
  ];
  expect(pickAcceptableCandidate(batch)).toBe(0);
});

test("buildCandidateOptions: maps each candidate to its index, subject, and temp hint", () => {
  const opts = buildCandidateOptions([
    makeResult({ message: "feat(cli): a\n\n- body", temperature: 0.2 }),
    makeResult({ message: "fix(core): b", temperature: 0.3 }),
  ]);
  expect(opts).toEqual([
    { value: 0, label: "feat(cli): a", hint: "temp 0.2" },
    { value: 1, label: "fix(core): b", hint: "temp 0.3" },
  ]);
});

test("buildCandidateOptions: surfaces invalid/truncated caveats in the hint", () => {
  const opts = buildCandidateOptions([
    makeResult({
      validation: { isValid: false, errors: ["x"], warnings: [] },
      temperature: 0.4,
    }),
    makeResult({ wasTruncated: true, temperature: 0.5 }),
  ]);
  expect(opts[0].hint).toBe("temp 0.4 · invalid format");
  expect(opts[1].hint).toBe("temp 0.5 · truncated");
});
