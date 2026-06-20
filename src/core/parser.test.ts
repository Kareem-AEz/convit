import { test, expect } from "vitest";

import {
  analyzeDiff,
  calculateImportanceScore,
  categorizeFile,
  detectBinaryFiles,
  extractKeyChanges,
  parseDiffStats,
  summarizeDiff,
} from "./parser";
import { COMPRESSION_THRESHOLD } from "../config/defaults";
import { makeFile } from "../test-helpers";

test("categorizeFile classifies by priority order", () => {
  const cases: Array<[string, string]> = [
    ["src/auth/login.test.ts", "test"],
    ["src/__tests__/auth.ts", "test"],
    ["src/feature/auth.spec.ts", "test"],
    ["package-lock.json", "generated"], // generated wins over config (.json)
    ["dist/convit.js", "generated"],
    ["README.md", "docs"],
    ["docs/guide.md", "docs"],
    ["tsconfig.json", "config"],
    [".env", "config"],
    ["src/index.ts", "source"],
    ["assets/logo.png", "asset"],
    ["data.csv", "other"],
  ];
  for (const [path, expected] of cases) {
    expect(categorizeFile(path), path).toBe(expected);
  }
});

test("calculateImportanceScore is additive and clamped to [0,100]", () => {
  // 50 base + 40 source + 10 deep-path + 10 add + 0 (≤10 changes) = 110 → clamp 100
  const source = makeFile({
    path: "src/a/b.ts",
    category: "source",
    changeType: "add",
    additions: 5,
    deletions: 0,
  });
  expect(calculateImportanceScore(source)).toBe(100);

  // 50 base + 15 docs + 0 (shallow path) + 0 modify + 0 = 65
  const docs = makeFile({
    path: "README.md",
    category: "docs",
    changeType: "modify",
    additions: 2,
    deletions: 1,
  });
  expect(calculateImportanceScore(docs)).toBe(65);

  // binary penalty applies: 50 + 5 asset + 0 shallow + 10 add - 20 binary = 45
  const binary = makeFile({
    path: "logo.png",
    category: "asset",
    changeType: "add",
    isBinary: true,
  });
  expect(calculateImportanceScore(binary)).toBe(45);
});

test("parseDiffStats counts additions and deletions per file", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "+added one",
    "+added two",
    "-removed one",
    "diff --git a/src/b.ts b/src/b.ts",
    "+++ b/src/b.ts",
    "+only addition",
  ].join("\n");

  const stats = parseDiffStats(diff);
  expect(stats.get("src/a.ts")).toEqual({ additions: 2, deletions: 1 });
  expect(stats.get("src/b.ts")).toEqual({ additions: 1, deletions: 0 });
});

test("parseDiffStats ignores the +++/--- file headers", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "+real addition",
  ].join("\n");
  expect(parseDiffStats(diff).get("x.ts")).toEqual({
    additions: 1,
    deletions: 0,
  });
});

test("detectBinaryFiles finds git's binary marker", () => {
  const diff = [
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");
  const binaries = detectBinaryFiles(diff);
  expect(binaries.has("logo.png")).toBe(true);
  expect(binaries.size).toBe(1);
});

test("extractKeyChanges surfaces declarations and skips imports", () => {
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    '+import { foo } from "./foo";',
    "+export function doThing() {",
    "+export const RATE = 5;",
    "+  const local = 1;",
  ].join("\n");

  const changes = extractKeyChanges(fileDiff);
  expect(changes).toContain("export function doThing() {");
  expect(changes).toContain("export const RATE = 5;");
  expect(changes.some((c) => c.startsWith("import "))).toBe(false);
});

test("extractKeyChanges falls back to substantial added lines", () => {
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+this is a sufficiently long added line of prose",
  ].join("\n");
  expect(extractKeyChanges(fileDiff)).toHaveLength(1);
});

test("analyzeDiff: 2c — an addition-only hunk in an existing file is `modify`", () => {
  // No `new file mode` marker → appending to an existing file must not be `add`.
  const diff = [
    "diff --git src/a.ts src/a.ts",
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ -1,1 +1,3 @@",
    " existing();",
    "+added();",
    "+more();",
  ].join("\n");
  const { files } = analyzeDiff(diff, ["src/a.ts"]);
  expect(files[0].changeType).toBe("modify");
});

test("analyzeDiff: 2c — `new file mode` is `add`, `deleted file mode` is `delete`", () => {
  const added = analyzeDiff(
    [
      "diff --git src/new.ts src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ src/new.ts",
      "+a();",
    ].join("\n"),
    ["src/new.ts"],
  );
  expect(added.files[0].changeType).toBe("add");

  const deleted = analyzeDiff(
    [
      "diff --git src/old.ts src/old.ts",
      "deleted file mode 100644",
      "--- src/old.ts",
      "+++ /dev/null",
      "-a();",
    ].join("\n"),
    ["src/old.ts"],
  );
  expect(deleted.files[0].changeType).toBe("delete");
});

test("analyzeDiff: 2d — a rename is detected and keyed by the new path", () => {
  const diff = [
    "diff --git src/old.ts src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ].join("\n");
  // `--name-only -M` reports only the new path.
  const { files } = analyzeDiff(diff, ["src/new.ts"]);
  expect(files[0].changeType).toBe("rename");
  expect(files[0].path).toBe("src/new.ts");
  expect(files[0].oldPath).toBe("src/old.ts");
});

test("analyzeDiff: 2a — a formatting-only file skips key-change extraction", () => {
  const diff = [
    "diff --git src/a.ts src/a.ts",
    "--- src/a.ts",
    "+++ src/a.ts",
    "+export const RATE = 5;",
  ].join("\n");
  const { files } = analyzeDiff(diff, ["src/a.ts"], new Set(["src/a.ts"]));
  expect(files[0].formattingOnly).toBe(true);
  expect(files[0].keyChanges).toEqual([]); // re-added declaration not surfaced
});

test("summarizeDiff passes small diffs through uncompressed", () => {
  const small = "diff --git a/x.ts b/x.ts\n+a\n";
  const summary = analyzeDiff(small, ["x.ts"]);
  const result = summarizeDiff(small, summary, false);
  expect(result.wasCompressed).toBe(false);
  expect(result.processedDiff).toBe(small);
});

test("summarizeDiff compresses diffs above the threshold", () => {
  const big =
    "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n" +
    "+x".repeat(COMPRESSION_THRESHOLD + 1);
  const summary = analyzeDiff(big, ["x.ts"]);
  const result = summarizeDiff(big, summary, false);
  expect(result.wasCompressed).toBe(true);
  expect(result.processedDiff).toMatch(/CHANGE SUMMARY/);
});

test("summarizeDiff respects noCompress even above threshold", () => {
  const big = "diff --git a/x.ts b/x.ts\n" + "+x".repeat(COMPRESSION_THRESHOLD);
  const summary = analyzeDiff(big, ["x.ts"]);
  const result = summarizeDiff(big, summary, true);
  expect(result.wasCompressed).toBe(false);
  expect(result.processedDiff).toBe(big);
});
