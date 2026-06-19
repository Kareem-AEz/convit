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

// --- P1-T2: cleanCommitMessage keeps body + footers, recognizes scopeless -----

test("preserves a prose body and footers (Co-authored-by, etc.)", () => {
  const raw = [
    "feat(api): add login",
    "",
    "This reworks the auth flow.",
    "",
    "- adds POST /login",
    "",
    "BREAKING CHANGE: tokens are now required",
    "Co-authored-by: Jane <jane@example.com>",
  ].join("\n");
  expect(cleanCommitMessage(raw)).toBe(raw);
});

test("recognizes a scopeless conventional header `feat: x`", () => {
  // Note: a scopeless header is still rejected by the validator (until P2-T1);
  // here we only assert that cleanCommitMessage extracts it cleanly.
  const raw = ["Here is your commit:", "feat: add login", "- adds POST /login"].join(
    "\n",
  );
  expect(cleanCommitMessage(raw)).toBe("feat: add login\n\n- adds POST /login");
});

test("does not treat a leading `useEffect(() => {` line as the header", () => {
  const raw = [
    "useEffect(() => {",
    "fix(ui): clear timer on unmount",
    "- prevents a memory leak",
  ].join("\n");
  expect(cleanCommitMessage(raw)).toBe(
    "fix(ui): clear timer on unmount\n\n- prevents a memory leak",
  );
});

test("preserves a breaking-change marker in the header", () => {
  const raw = [
    "refactor(core)!: drop the legacy config loader",
    "",
    "- removes .convitrc v1 support",
  ].join("\n");
  expect(cleanCommitMessage(raw)).toBe(raw);
});
