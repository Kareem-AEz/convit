import { test, expect } from "vitest";

import { parseCandidates, parseCost } from "./loader";
import { DEFAULT_CANDIDATES, MAX_CANDIDATES } from "./defaults";

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

test("parseCandidates: absent flag → 1 (feature off)", () => {
  expect(parseCandidates(["--accept"])).toBe(1);
});

test("parseCandidates: a given number passes through within bounds", () => {
  expect(parseCandidates(["--candidates", "3"])).toBe(3);
});

test("parseCandidates: bare --candidates (no number) → default", () => {
  expect(parseCandidates(["--candidates"])).toBe(DEFAULT_CANDIDATES);
  // a following flag, not a number, is also treated as bare
  expect(parseCandidates(["--candidates", "--accept"])).toBe(DEFAULT_CANDIDATES);
});

test("parseCandidates: a non-numeric value falls back to the default", () => {
  expect(parseCandidates(["--candidates", "lots"])).toBe(DEFAULT_CANDIDATES);
});

test("parseCandidates: clamps to [1, MAX_CANDIDATES]", () => {
  expect(parseCandidates(["--candidates", "0"])).toBe(1);
  expect(parseCandidates(["--candidates", "999"])).toBe(MAX_CANDIDATES);
});
