import { test, expect } from "vitest";

import { evaluateAutoAcceptGate, evaluateSensitiveAcceptGate } from "./gates";
import type { SensitiveDataMatch } from "../types";

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
