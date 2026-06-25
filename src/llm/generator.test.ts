import { test, expect } from "vitest";

import {
  assembleCommitMessage,
  cleanCommitMessage,
  formatApiError,
  shouldFallbackToFreeText,
} from "./generator";
import { HEADER_RE } from "../types";

const baseStructured = {
  type: "feat",
  scope: "core",
  breaking: false,
  subject: "add structured generation",
  body: ["emit a validated commit object", "fall back to free-text"],
};

test("assembleCommitMessage builds a HEADER_RE-valid header and bullets", () => {
  const msg = assembleCommitMessage(baseStructured);
  const lines = msg.split("\n");
  expect(lines[0]).toBe("feat(core): add structured generation");
  expect(HEADER_RE.test(lines[0])).toBe(true);
  expect(lines[1]).toBe(""); // blank line between subject and body
  expect(lines[2]).toBe("- emit a validated commit object");
  expect(lines[3]).toBe("- fall back to free-text");
});

test("assembleCommitMessage drops a null/invalid scope and keeps the header valid", () => {
  const noScope = assembleCommitMessage({ ...baseStructured, scope: null });
  expect(noScope.split("\n")[0]).toBe("feat: add structured generation");
  expect(HEADER_RE.test(noScope.split("\n")[0])).toBe(true);

  // A scope outside the header grammar (spaces/slashes) is dropped, not emitted
  // into an invalid `feat(a b): …` header.
  const bad = assembleCommitMessage({ ...baseStructured, scope: "a b/c" });
  expect(bad.split("\n")[0]).toBe("feat: add structured generation");
});

test("assembleCommitMessage lowercases the scope and marks breaking changes", () => {
  const msg = assembleCommitMessage({
    ...baseStructured,
    scope: "CLI",
    breaking: true,
  });
  expect(msg.split("\n")[0]).toBe("feat(cli)!: add structured generation");
  expect(HEADER_RE.test(msg.split("\n")[0])).toBe(true);
});

test("assembleCommitMessage strips stray bullet markers and empty bullets", () => {
  const msg = assembleCommitMessage({
    ...baseStructured,
    body: ["- already dashed", "* star marker", "   ", "clean"],
  });
  expect(msg.split("\n").slice(2)).toEqual([
    "- already dashed",
    "- star marker",
    "- clean",
  ]);
});

test("assembleCommitMessage emits a header-only message when body is empty", () => {
  const msg = assembleCommitMessage({ ...baseStructured, body: [] });
  expect(msg).toBe("feat(core): add structured generation");
});

test("assembleCommitMessage throws when type or subject is empty", () => {
  expect(() => assembleCommitMessage({ ...baseStructured, subject: "  " })).toThrow();
  expect(() => assembleCommitMessage({ ...baseStructured, type: "" })).toThrow();
});

test("an unusable structured result routes to the free-text fallback", () => {
  // The assembly error (empty subject) must signal fallback, not a hard fail —
  // the endpoint works, the model just returned junk.
  let caught: unknown;
  try {
    assembleCommitMessage({ ...baseStructured, subject: "" });
  } catch (e) {
    caught = e;
  }
  expect(shouldFallbackToFreeText(caught)).toBe(true);
});

test("an unrelated error does not trigger the free-text fallback", () => {
  expect(shouldFallbackToFreeText(new Error("connection reset"))).toBe(false);
});

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

test("formatApiError maps a TimeoutError (AbortSignal.timeout) to the timeout message", () => {
  // AbortSignal.timeout() rejects with name "TimeoutError", not "AbortError".
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const msg = formatApiError(timeout, "my-model", 45);
  expect(msg).toMatch(/timed out after 45 seconds/);
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
