import { test, expect } from "vitest";

import { parseCost } from "./loader";

test("parseCost: a numeric string parses", () => {
  expect(parseCost("1.5")).toBe(1.5);
});

test("parseCost: undefined falls back to 0", () => {
  expect(parseCost(undefined)).toBe(0);
});

test("parseCost: a non-numeric string falls back to 0 (no NaN)", () => {
  expect(parseCost("not-a-number")).toBe(0);
  expect(Number.isNaN(parseCost("not-a-number"))).toBe(false);
});
