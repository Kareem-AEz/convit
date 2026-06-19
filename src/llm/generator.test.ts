import { test, expect } from "vitest";

import { cleanCommitMessage, formatApiError } from "./generator";

test("strips a fenced code block wrapper", () => {
  const raw = "```\nfeat(api): add login\n```";
  expect(cleanCommitMessage(raw)).toBe("feat(api): add login");
});

test("strips surrounding quotes", () => {
  expect(cleanCommitMessage('"feat(api): add login"')).toBe(
    "feat(api): add login",
  );
});

test("strips preamble before the conventional header", () => {
  const raw = [
    "Here is your commit message:",
    "feat(api): add login",
    "- adds POST /login",
  ].join("\n");
  expect(cleanCommitMessage(raw)).toBe(
    "feat(api): add login\n\n- adds POST /login",
  );
});

test("enforces a blank line between subject and body", () => {
  const raw = "feat(api): add login\n- adds POST /login";
  expect(cleanCommitMessage(raw)).toBe(
    "feat(api): add login\n\n- adds POST /login",
  );
});

test("formatApiError maps connection refusals to LM Studio guidance", () => {
  const msg = formatApiError(new Error("connect ECONNREFUSED"), "m");
  expect(msg).toMatch(/Cannot connect to API/);
});

test("formatApiError maps timeouts/aborts to a timeout message", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const msg = formatApiError(abort, "my-model", 60);
  expect(msg).toMatch(/timed out after 60 seconds/);
  expect(msg).toMatch(/my-model/);
});

// --- Known gaps, fixed by P1-T2 (rewrite cleanCommitMessage) ------------------
// The header-extraction loop drops prose bodies and every footer, and the
// header matcher requires a parenthesis so scopeless headers aren't recognized.
// Recorded as todos describing the intended post-fix behavior.
test.todo("P1-T2: preserves a prose body and footers (Co-authored-by, etc.)");
test.todo("P1-T2: recognizes a scopeless conventional header `feat: x`");
