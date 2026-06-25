import { test, expect } from "vitest";

import {
  analyzeDiff,
  calculateImportanceScore,
  categorizeFile,
  detectBinaryFiles,
  extractHunkContexts,
  extractKeyChanges,
  extractNoteComments,
  formatCompressedDiff,
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

test("extractKeyChanges reserves slots so logic survives a declaration-heavy diff", () => {
  // P2-T3: a wide refactor re-adds many declarations; the changed logic line
  // must still surface instead of being crowded out of all 5 slots.
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+export const A = 1;",
    "+export const B = 2;",
    "+export const C = 3;",
    "+export const D = 4;",
    "+export const E = 5;",
    "+  if (balance < 0) throw new Error('overdrawn account');",
  ].join("\n");
  const changes = extractKeyChanges(fileDiff, 5, "src/x.ts");
  expect(changes).toHaveLength(5);
  expect(
    changes.some((c) => c.includes("balance < 0")),
    "the non-declaration logic line should occupy a reserved slot",
  ).toBe(true);
});

test("extractKeyChanges keeps comments and import members out of logic slots", () => {
  // Observed in a dogfood run: JSDoc/comment lines and multi-line import members
  // were surfaced as "logic", crowding out the one real changed line.
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+import {",
    "+  extractHunkContexts,",
    "+  formatCompressedDiff,",
    "+/** Picks the declaration set for a file, keyed by extension. */",
    "+ * enclosing function/class the hunk touches — one signal per region,",
    "+  hunkContexts: string[];",
    "+  return amount * taxRate + shippingFee;",
  ].join("\n");
  const changes = extractKeyChanges(fileDiff, 5, "src/x.ts");
  expect(changes).toContain("return amount * taxRate + shippingFee;");
  expect(changes).toContain("hunkContexts: string[];");
  expect(changes.some((c) => c.startsWith("*") || c.startsWith("/*"))).toBe(
    false,
  );
  expect(changes).not.toContain("extractHunkContexts,");
});

test("extractKeyChanges treats TODO/FIXME as intent only in annotation form", () => {
  const real = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+  // TODO: handle the retry path",
  ].join("\n");
  expect(extractKeyChanges(real, 5, "src/x.ts")).toContain(
    "// TODO: handle the retry path",
  );

  // Prose that merely mentions the words is not a real annotation and, being a
  // comment, must be dropped rather than surfaced as a high-signal change.
  const prose = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+ * TODO/FIXME comments are unaffected by this change.",
  ].join("\n");
  expect(extractKeyChanges(prose, 5, "src/x.ts")).toEqual([]);
});

test("extractKeyChanges recognizes declarations per language", () => {
  const cases: Array<[string, string, string]> = [
    ["src/m.py", "+def handler(req):", "def handler(req):"],
    ["src/m.py", "+class Widget:", "class Widget:"],
    ["src/m.go", "+func Serve(w http.ResponseWriter) {", "func Serve"],
    ["src/m.rs", "+pub fn parse(input: &str) -> Result<T> {", "pub fn parse"],
    ["src/M.java", "+public void process() {", "public void process"],
  ];
  for (const [path, added, needle] of cases) {
    const fileDiff = ["diff --git a b", "+++ b", added].join("\n");
    const changes = extractKeyChanges(fileDiff, 5, path);
    expect(changes.some((c) => c.includes(needle)), `${path}: ${added}`).toBe(
      true,
    );
  }
});

test("extractHunkContexts surfaces the enclosing region, deduped, imports dropped", () => {
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "@@ -47,6 +47,7 @@ import type { Foo } from './foo';",
    "+a();",
    "@@ -80,8 +81,9 @@ async function getStagedContext(config) {",
    "+b();",
    "@@ -90,2 +92,3 @@ async function getStagedContext(config) {",
    "+c();",
  ].join("\n");
  const contexts = extractHunkContexts(fileDiff);
  expect(contexts).toContain("async function getStagedContext(config) {");
  expect(contexts).toHaveLength(1); // import context dropped, duplicate collapsed
});

test("extractNoteComments surfaces added prose comments, not boilerplate", () => {
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "+  // preventing a race when two writes land together",
    "+  # making the retry idempotent",
    "+  /* so the spinner clears before we print */",
    "+  // eslint-disable-next-line no-console",
    "+   * @param input the raw diff", // JSDoc tag continuation → skipped
    "+  // x", // too short → skipped
    "+  // ============================================", // divider → skipped
    "+  const real = computeThing();", // not a comment
  ].join("\n");
  const notes = extractNoteComments(fileDiff);
  expect(notes).toContain("preventing a race when two writes land together");
  expect(notes).toContain("making the retry idempotent");
  expect(notes).toContain("so the spinner clears before we print");
  expect(notes.some((n) => n.includes("eslint"))).toBe(false);
  expect(notes.some((n) => n.includes("@param"))).toBe(false);
  expect(notes).not.toContain("x");
});

test("extractNoteComments ignores removed and context comment lines", () => {
  const fileDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "-  // preventing the old behavior we just removed",
    "   // an unchanged context comment here",
  ].join("\n");
  expect(extractNoteComments(fileDiff)).toEqual([]);
});

test("analyzeDiff surfaces developer notes in the compressed summary", () => {
  const diff = [
    "diff --git src/pay.ts src/pay.ts",
    "--- src/pay.ts",
    "+++ src/pay.ts",
    "@@ -10,2 +10,3 @@ export function charge(amount) {",
    "+  // refusing negative amounts to avoid accidental refunds",
    "+  if (amount < 0) throw new Error('negative');",
  ].join("\n");
  const out = formatCompressedDiff(analyzeDiff(diff, ["src/pay.ts"]));
  expect(out).toContain("notes: refusing negative amounts");
});

test("P2-T3 — a non-declaration logic change surfaces in the compressed summary", () => {
  // The acceptance: a large fix whose change is a logic line (not a declaration)
  // still leaves a trace — both the line itself and its hunk region.
  const fileDiff = [
    "diff --git src/pay.ts src/pay.ts",
    "--- src/pay.ts",
    "+++ src/pay.ts",
    "@@ -10,3 +10,4 @@ export function processPayment(amount) {",
    "   const fee = amount * 0.03;",
    "+  if (amount < 0) throw new RangeError('negative amount rejected');",
  ].join("\n");
  const summary = analyzeDiff(fileDiff, ["src/pay.ts"]);
  const out = formatCompressedDiff(summary);
  expect(out).toContain("amount < 0");
  expect(out).toContain("processPayment");
});

test("analyzeDiff — a formatting-only file carries no hunk regions", () => {
  const diff = [
    "diff --git src/a.ts src/a.ts",
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ -1,1 +1,1 @@ export function f() {",
    "+export const RATE = 5;",
  ].join("\n");
  const { files } = analyzeDiff(diff, ["src/a.ts"], new Set(["src/a.ts"]));
  expect(files[0].hunkContexts).toEqual([]);
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
