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

// --- P1-T5: unquoted .env / YAML / shell secrets ------------------------------

// Fixture values are built at runtime (not literal in source) so convit's own
// scanner doesn't flag this test file's diff — matching the `"ghp_" + …` style
// already used above. The string detectSensitiveData() sees is still complete.
test("detects an unquoted .env api_key value", () => {
  const val = "abcdefghij" + "1234567890" + "klmno"; // 25 generic chars
  // Concatenated (key + value separate in source) so this file's own diff
  // doesn't trip the scanner; the runtime string is the full `API_KEY=<val>`.
  const matches = detectSensitiveData(diffWith(["API_KEY=" + val], ".env"));
  expect(matches.some((m) => m.type === "api_key")).toBe(true);
});

test("detects an unquoted .env password value (14 chars, ≥8 floor)", () => {
  const val = "supersecret" + "123"; // 14 chars, above the 8-char floor
  // Keyword and `=` kept separate in source (the password quoted-branch allows
  // spaces, so an adjacent `=` "..." would span to the next quote on the line).
  const line = "DATABASE_PASSWORD" + "=" + val;
  const matches = detectSensitiveData(diffWith([line], ".env"));
  expect(matches.some((m) => m.type === "password")).toBe(true);
});

test("prefers the specific github_pat label over generic secret (unquoted)", () => {
  const ghp = "ghp_" + "a".repeat(36);
  const matches = detectSensitiveData(diffWith([`GITHUB_TOKEN=${ghp}`], ".env"));
  // Both github_pat and the generic secret match this line; specific wins [0].
  expect(matches[0].type).toBe("github_pat");
});

test("does not match innocuous unquoted short values", () => {
  // "short" (5) is below the 8-char floor; "dev" (3) below 20. Value split in
  // source so the literal doesn't trip the scanner on this file's own diff.
  const lines = ["token=dev", "password=" + "short"];
  expect(detectSensitiveData(diffWith(lines, ".env"))).toEqual([]);
});
