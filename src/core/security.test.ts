import { test, expect } from "vitest";

import { detectSensitiveData } from "./security";

function diffWith(addedLines: string[], file = "src/config.ts"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

test("detects a quoted api_key value", () => {
  const matches = detectSensitiveData(
    diffWith(['const c = { api_key: "abcdefghij1234567890klmno" };']),
  );
  expect(matches).toHaveLength(1);
  expect(matches[0].type).toBe("api_key");
});

test("detects a quoted password value", () => {
  const matches = detectSensitiveData(diffWith(['password: "hunter2hunter2"']));
  expect(matches).toHaveLength(1);
  expect(matches[0].type).toBe("password");
});

test("detects canonical token formats (github / openai / aws)", () => {
  const ghp = "ghp_" + "a".repeat(36);
  const sk = "sk-" + "a".repeat(48);
  const akia = "AKIA" + "ABCD1234EFGH5678";

  expect(detectSensitiveData(diffWith([`token = ${ghp}`]))[0]?.type).toBe(
    "github_pat",
  );
  expect(detectSensitiveData(diffWith([`key = ${sk}`]))[0]?.type).toBe(
    "openai_key",
  );
  expect(detectSensitiveData(diffWith([`id = ${akia}`]))[0]?.type).toBe(
    "aws_key",
  );
});

test("detects PEM private key headers", () => {
  const matches = detectSensitiveData(
    diffWith(["-----BEGIN RSA PRIVATE KEY-----"]),
  );
  expect(matches[0]?.type).toBe("private_key");
});

test("ignores secrets on removed lines (only added lines are scanned)", () => {
  const ghp = "ghp_" + "a".repeat(36);
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "+++ b/x.ts",
    `-const removed = "${ghp}";`,
    "+const safe = 1;",
  ].join("\n");
  expect(detectSensitiveData(diff)).toEqual([]);
});

test("masks the preview as first4****last4", () => {
  const ghp = "ghp_" + "b".repeat(36); // 40 chars, > 12
  const [match] = detectSensitiveData(diffWith([`token = ${ghp}`]));
  expect(match.preview.startsWith("ghp_")).toBe(true);
  expect(match.preview).toContain("****");
  expect(match.preview.endsWith("bbbb")).toBe(true);
});

test("does not match innocuous short values", () => {
  expect(detectSensitiveData(diffWith(['token: "local"']))).toEqual([]);
});

// --- Known gap, fixed by P1-T5 (unquoted .env / YAML secrets) -----------------
// The generic api_key/password/secret patterns currently REQUIRE quoted values,
// so `API_KEY=ghp_live_...` in a .env diff slips through. Recorded as a todo so
// CI stays green without locking in the buggy behavior; P1-T5 turns this into a
// real assertion that unquoted .env secrets are detected.
test.todo("P1-T5: detects unquoted .env secrets (value-quoting optional)");
