import { test, expect } from "vitest";
import { buildMachinePayload } from "./index";
import { makeConfig } from "../test-helpers";
import type { GenerateResult, StagedContext } from "../types";

const result = {
  message: "feat(cli): add json output",
  validation: { isValid: true, errors: [], warnings: [] },
  inputTokens: 1700,
  outputTokens: 2300,
  durationMs: 9000,
  tokensFromApi: true,
  wasTruncated: false,
  temperature: 0.2,
} satisfies GenerateResult;

const context = {
  classification: {
    type: "feat",
    scope: "cli",
    confidence: "high",
    secondaryScopes: [],
    reasoning: "",
    typeScores: {},
  },
} as unknown as StagedContext;

const cost = { inputCost: 0, outputCost: 0, totalCost: 0 };

test("buildMachinePayload reports numeric cost, never the formatted string", () => {
  const config = makeConfig({ trailers: ["Generated-with: convit"] });
  const p = buildMachinePayload(result, context, cost, config, "deepseek", false);

  // The bug to guard: cost must be a number (0), not "Free (local model)".
  expect(typeof p.cost.total).toBe("number");
  expect(p.cost.total).toBe(0);
  expect(p.cost.currency).toBe("USD");
  expect(p.tokens).toEqual({
    input: 1700,
    output: 2300,
    total: 4000,
    fromApi: true,
  });
});

test("buildMachinePayload carries raw message + reconstructable trailers", () => {
  const config = makeConfig({ trailers: ["Generated-with: convit ({model})"] });
  const p = buildMachinePayload(result, context, cost, config, "deepseek", true);

  // message is the raw generated text — trailers live in their own field so the
  // committed form (message + "\n\n" + trailers) is reconstructable.
  expect(p.message).toBe(result.message);
  expect(p.message).not.toContain("Generated-with");
  expect(p.trailers).toEqual(["Generated-with: convit (deepseek)"]);
  expect(p.committed).toBe(true);
  expect(p.type).toBe("feat");
  expect(p.scope).toBe("cli");
});
