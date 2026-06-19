import { test, expect, vi } from "vitest";

import {
  classifyChanges,
  detectCommitType,
  detectPrimaryScope,
  detectSecondaryScopes,
} from "./classifier";
import { makeConfig, makeFile } from "../test-helpers";

test("detectCommitType: a test file votes test", () => {
  const { type } = detectCommitType(
    [makeFile({ path: "src/x.test.ts", category: "test", keyChanges: ["a"] })],
    "",
  );
  expect(type).toBe("test");
});

test("detectCommitType: a docs file votes docs", () => {
  const { type } = detectCommitType(
    [makeFile({ path: "README.md", category: "docs", keyChanges: ["a"] })],
    "",
  );
  expect(type).toBe("docs");
});

test("detectCommitType: a new source file votes feat", () => {
  const { type } = detectCommitType(
    [
      makeFile({
        path: "src/feature.ts",
        category: "source",
        changeType: "add",
        keyChanges: ["export const x = 1;"],
      }),
    ],
    "+export const x = 1;",
  );
  expect(type).toBe("feat");
});

test("detectCommitType: votes are additive across signals", () => {
  const { scores } = detectCommitType(
    [makeFile({ path: "a.test.ts", category: "test", keyChanges: ["x"] })],
    "try { doThing() } catch (error) {}",
  );
  expect(scores.test).toBe(5);
  expect(scores.fix).toBe(2); // diff: error/catch
});

test("classifyChanges: confidence scales with the winning score", () => {
  const cfg = makeConfig();

  const oneTest = classifyChanges(
    [makeFile({ path: "a.test.ts", category: "test", keyChanges: ["x"] })],
    "",
    cfg,
  );
  expect(oneTest.type).toBe("test");
  expect(oneTest.confidence).toBe("medium"); // score 5

  const twoTests = classifyChanges(
    [
      makeFile({ path: "a.test.ts", category: "test", keyChanges: ["x"] }),
      makeFile({ path: "b.test.ts", category: "test", keyChanges: ["y"] }),
    ],
    "",
    cfg,
  );
  expect(twoTests.confidence).toBe("high"); // score 10
});

test("detectPrimaryScope: $1 capture group resolves the scope", () => {
  const { scope } = detectPrimaryScope(
    [makeFile({ path: "packages/api/src/index.ts", category: "source" })],
    makeConfig(),
  );
  expect(scope).toBe("api");
});

test("detectPrimaryScope: user scopePatterns win over defaults", () => {
  // Default "src/([^/]+)/.*" would resolve this path to "cli"; the user pattern
  // (evaluated first) must override it to "command" to prove precedence.
  const cfg = makeConfig({
    userConfig: {
      scopePatterns: [{ pattern: "src/cli/.*", scope: "command", weight: 1 }],
    },
  });
  const { scope } = detectPrimaryScope(
    [makeFile({ path: "src/cli/index.ts", category: "source" })],
    cfg,
  );
  expect(scope).toBe("command");
});

test("detectPrimaryScope: falls back to category for unmatched paths", () => {
  const { scope } = detectPrimaryScope(
    [makeFile({ path: "tsconfig.json", category: "config" })],
    makeConfig(),
  );
  expect(scope).toBe("config");
});

test("detectSecondaryScopes: requires ≥2 files and excludes the primary", () => {
  const files = [
    makeFile({ path: "packages/api/a.ts", category: "source" }),
    makeFile({ path: "packages/ui/a.ts", category: "source" }),
    makeFile({ path: "packages/ui/b.ts", category: "source" }),
  ];
  const { scopes } = detectSecondaryScopes(files, "api", makeConfig());
  expect(scopes).toEqual(["ui"]); // ui has 2 files; api is primary, excluded
});

test("detectPrimaryScope: an invalid user scopePattern warns and the run continues", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cfg = makeConfig({
    userConfig: {
      scopePatterns: [{ pattern: "src/(", scope: "broken", weight: 5 }],
    },
  });

  // A malformed regex must not throw — it is skipped, so the default pattern
  // still resolves the scope ("src/cli/.*" → "cli").
  const { scope } = detectPrimaryScope(
    [makeFile({ path: "src/cli/index.ts", category: "source" })],
    cfg,
  );

  expect(warn).toHaveBeenCalled();
  expect(scope).toBe("cli");
  warn.mockRestore();
});

test("classifyChanges: a single invalid pattern warns only once across both detectors", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const cfg = makeConfig({
    userConfig: {
      scopePatterns: [{ pattern: "src/(", scope: "broken", weight: 5 }],
    },
  });

  classifyChanges(
    [makeFile({ path: "src/cli/index.ts", category: "source" })],
    "",
    cfg,
  );

  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
