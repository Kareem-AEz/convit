import { test, expect } from "vitest";

import {
  appendTrailers,
  assembleCommitMessage,
  cleanCommitMessage,
  expandTrailers,
  formatApiError,
  shouldFallbackToFreeText,
} from "./generator";
import { validateCommitMessage } from "../core/validator";
import { makeConfig } from "../test-helpers";
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

// `jsonSchema<StructuredCommit>()` only types the result — it does not validate
// it, so a model that ignores the schema hands these shapes straight to
// assembly. Each must route to the free-text fallback, never a raw TypeError
// (which `shouldFallbackToFreeText` rejects, hard-failing the whole run).
test.each([
  ["a missing type", { ...baseStructured, type: undefined }],
  ["a missing subject", { ...baseStructured, subject: undefined }],
  ["a non-string type", { ...baseStructured, type: 42 }],
  ["an entirely empty object", {}],
  ["null", null],
])("unschema'd structured output (%s) falls back, not crashes", (_name, bad) => {
  let caught: unknown;
  try {
    assembleCommitMessage(bad as never);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).constructor.name).not.toBe("TypeError");
  expect(shouldFallbackToFreeText(caught)).toBe(true);
});

test("a non-array body and non-string bullets are tolerated", () => {
  expect(assembleCommitMessage({ ...baseStructured, body: "not an array" } as never)).toBe(
    "feat(core): add structured generation",
  );
  expect(
    assembleCommitMessage({ ...baseStructured, body: [null, 7, "real bullet"] } as never),
  ).toBe("feat(core): add structured generation\n\n- real bullet");
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

// --- P3-T6: configurable commit trailers --------------------------------------

const body = "feat(api): add login\n\n- adds POST /login";

test("appendTrailers adds the default trailer after a blank line", () => {
  expect(appendTrailers(body, ["Generated-with: convit"])).toBe(
    `${body}\n\nGenerated-with: convit`,
  );
});

test("appendTrailers expands the {model} placeholder", () => {
  expect(
    appendTrailers(body, ["Generated-with: convit ({model})"], "deepseek-v4"),
  ).toBe(`${body}\n\nGenerated-with: convit (deepseek-v4)`);
});

test("appendTrailers falls back to 'unknown' when {model} has no model", () => {
  expect(appendTrailers(body, ["Generated-with: convit ({model})"])).toBe(
    `${body}\n\nGenerated-with: convit (unknown)`,
  );
});

test("appendTrailers with an empty list is a no-op", () => {
  expect(appendTrailers(body, [])).toBe(body);
});

test("appendTrailers drops empty/whitespace-only entries (and joins multiple)", () => {
  expect(appendTrailers(body, ["  ", "Signed-off-by: Jane", ""])).toBe(
    `${body}\n\nSigned-off-by: Jane`,
  );
});

test("expandTrailers resolves {model}, drops empties, and mirrors appendTrailers", () => {
  expect(expandTrailers(["Generated-with: convit ({model})"], "deepseek")).toEqual(
    ["Generated-with: convit (deepseek)"],
  );
  expect(expandTrailers(["  ", "Signed-off-by: Jane", ""])).toEqual([
    "Signed-off-by: Jane",
  ]);
  expect(expandTrailers([])).toEqual([]);
  // The lines expandTrailers returns are exactly what appendTrailers appends.
  const lines = expandTrailers(["Generated-with: convit"]);
  expect(appendTrailers(body, ["Generated-with: convit"])).toBe(
    `${body}\n\n${lines.join("\n")}`,
  );
});

test("a configured trailer survives the clean → append → validate path", () => {
  // The acceptance guard: appending a footer trailer must not break validation,
  // and re-cleaning the assembled message must preserve it (P1-T2 footers).
  const cleaned = cleanCommitMessage(body);
  const withTrailer = appendTrailers(cleaned, ["Generated-with: convit"]);

  expect(withTrailer.endsWith("\nGenerated-with: convit")).toBe(true);
  expect(validateCommitMessage(withTrailer, makeConfig()).isValid).toBe(true);
  // Footer-shaped trailer is preserved if the message is re-cleaned.
  expect(cleanCommitMessage(withTrailer)).toBe(withTrailer);
});
