import { test, expect } from "vitest";

import {
  collectPromptSecrets,
  detectSensitiveData,
  detectSensitiveInText,
} from "./security";

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

// --- Phase-2 bundle: broadened token formats ---------------------------------

test("detects newer token formats (fine-grained PAT, sk-proj, glpat, AIza, ASIA)", () => {
  const ghpat = "github_pat_" + "A".repeat(22) + "_" + "b".repeat(10);
  const skProj = "sk-proj-" + "a".repeat(40);
  const glpat = "glpat-" + "x".repeat(20);
  const aiza = "AIza" + "A".repeat(35);
  const asia = "ASIA" + "ABCD1234EFGH5678";

  expect(detectSensitiveData(diffWith([`t = ${ghpat}`]))[0]?.type).toBe(
    "github_pat",
  );
  expect(detectSensitiveData(diffWith([`k = ${skProj}`]))[0]?.type).toBe(
    "openai_key",
  );
  expect(detectSensitiveData(diffWith([`t = ${glpat}`]))[0]?.type).toBe(
    "gitlab_pat",
  );
  expect(detectSensitiveData(diffWith([`k = ${aiza}`]))[0]?.type).toBe(
    "gcp_key",
  );
  expect(detectSensitiveData(diffWith([`id = ${asia}`]))[0]?.type).toBe(
    "aws_key",
  );
});

// --- Phase-2 bundle: real line numbers from hunk headers ---------------------

test("reports the new-file line number parsed from the @@ hunk header", () => {
  const ghp = "ghp_" + "a".repeat(36);
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -40,3 +40,4 @@ function f() {",
    " context line", // line 40
    " another context", // line 41
    `+const leak = "${ghp}";`, // line 42
    " trailing context", // line 43
  ].join("\n");
  const [match] = detectSensitiveData(diff);
  expect(match.line).toBe(42);
});

// --- Phase-2 bundle: tighter masking -----------------------------------------

test("masks mid-length matches entirely (≥16 rule), still reveals long ones", () => {
  // A 13-char keyword=value secret used to leak 8 of its chars under the old
  // `> 12` rule; now anything under 16 chars masks fully. Keyword and value are
  // kept separate in source so the literal doesn't trip the scanner here.
  const short = detectSensitiveData(diffWith(["pwd=" + "123456789"], ".env"));
  expect(short[0]?.preview).toBe("****");

  // A 40-char token still reveals first4/last4.
  const ghp = "ghp_" + "c".repeat(36);
  const long = detectSensitiveData(diffWith([`t = ${ghp}`]));
  expect(long[0]?.preview).toBe("ghp_****cccc");
});

// --- P2-T6: scan all prompt-bound text, not just the diff --------------------

test("detectSensitiveInText finds a secret in plain (non-diff) text", () => {
  const ghp = "ghp_" + "a".repeat(36);
  const matches = detectSensitiveInText(`token = ${ghp}`, "your description");
  // `token = <ghp>` trips both the specific github_pat and the generic secret
  // pattern (same as the diff scanner); the specific label wins position [0].
  expect(matches[0]?.type).toBe("github_pat");
});

test("detectSensitiveInText labels the source via `file` and numbers lines 1-based", () => {
  const ghp = "ghp_" + "b".repeat(36);
  const text = ["first line", "second line", `leak: ${ghp}`].join("\n");
  const [match] = detectSensitiveInText(text, "recent commit history");
  expect(match.file).toBe("recent commit history");
  expect(match.line).toBe(3);
});

test("detectSensitiveInText scans every line (no diff `+` prefix needed)", () => {
  // The diff scanner only reads `+` lines; plain text has none, so this proves
  // the non-diff path actually scans bare prose.
  const akia = "AKIA" + "ABCD1234EFGH5678";
  expect(detectSensitiveInText(`id = ${akia}`, "src").length).toBe(1);
});

test("detectSensitiveInText returns nothing for empty text", () => {
  expect(detectSensitiveInText("", "src")).toEqual([]);
  expect(detectSensitiveInText("just normal prose here", "src")).toEqual([]);
});

// Acceptance (P2-T6): a secret present ONLY in a recent commit body must reach
// the match set the security gate checks — proving recentCommits is wired in,
// not just that the primitive can detect a secret in isolation.
test("collectPromptSecrets catches a secret that exists only in recent commits", () => {
  const ghp = "ghp_" + "c".repeat(36);
  const matches = collectPromptSecrets(
    "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+const safe = 1;", // clean diff
    ["src/x.ts"], // clean file list
    `chore: rotate token\n\nold token was ${ghp}`, // secret only here
  );
  expect(matches.some((m) => m.type === "github_pat")).toBe(true);
  expect(matches.some((m) => m.file === "recent commit history")).toBe(true);
});

test("collectPromptSecrets catches a secret hidden in a staged file path", () => {
  const akia = "AKIA" + "ABCD1234EFGH5678";
  const matches = collectPromptSecrets(
    "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+const safe = 1;",
    [`config/${akia}.env`],
    "chore: routine commit",
  );
  expect(matches.some((m) => m.file === "staged file paths")).toBe(true);
});

test("collectPromptSecrets still surfaces diff secrets and stays clean when all sources are clean", () => {
  const ghp = "ghp_" + "d".repeat(36);
  const fromDiff = collectPromptSecrets(
    diffWith([`token = ${ghp}`]),
    ["src/config.ts"],
    "chore: routine",
  );
  expect(fromDiff.some((m) => m.type === "github_pat")).toBe(true);

  const allClean = collectPromptSecrets(
    "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+const safe = 1;",
    ["src/x.ts"],
    "chore: routine commit",
  );
  expect(allClean).toEqual([]);
});
