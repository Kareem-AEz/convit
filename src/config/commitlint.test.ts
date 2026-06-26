import { afterAll, afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  effectiveMaxBullet,
  effectiveMaxSubject,
  loadCommitlintConstraints,
  mapRules,
} from "./commitlint";
import { makeConfig } from "../test-helpers";

// --- mapRules (pure) -------------------------------------------------------

test("mapRules: maps type-enum, subject-max, and body-max-line", () => {
  expect(
    mapRules({
      "type-enum": [2, "always", ["feat", "fix", "chore"]],
      "subject-max-length": [2, "always", 50],
      "body-max-line-length": [1, "always", 80],
    }),
  ).toEqual({
    types: ["feat", "fix", "chore"],
    maxSubjectLength: 50,
    maxBulletLength: 80,
  });
});

test("mapRules: intersects type-enum with COMMIT_TYPES, dropping unknown types", () => {
  // "feature" and "wip" are not valid convit types — they must be filtered out.
  expect(
    mapRules({ "type-enum": [2, "always", ["feat", "feature", "wip", "fix"]] }),
  ).toEqual({ types: ["feat", "fix"] });
});

test("mapRules: an empty type-enum intersection is treated as no constraint", () => {
  // None of these map to COMMIT_TYPES → unsatisfiable → drop the rule entirely.
  expect(mapRules({ "type-enum": [2, "always", ["wip", "chunk"]] })).toBeNull();
});

test("mapRules: disabled (level 0) and 'never' rules are ignored", () => {
  expect(
    mapRules({
      "type-enum": [0, "always", ["feat"]],
      "subject-max-length": [2, "never", 50],
    }),
  ).toBeNull();
});

test("mapRules: warning-level rules still count (enabled is level >= 1)", () => {
  expect(mapRules({ "subject-max-length": [1, "always", 60] })).toEqual({
    maxSubjectLength: 60,
  });
});

test("mapRules: non-positive or non-numeric length values are ignored", () => {
  expect(
    mapRules({
      "subject-max-length": [2, "always", 0],
      "body-max-line-length": [2, "always", "nope" as unknown as number],
    }),
  ).toBeNull();
});

test("mapRules: empty rules → null", () => {
  expect(mapRules({})).toBeNull();
});

// --- effective length helpers (most-restrictive-wins) ----------------------

test("effectiveMaxSubject/Bullet: commitlint tightens, never loosens", () => {
  const base = makeConfig({
    userConfig: { rules: { maxSubjectLength: 50, maxBulletLength: 72 } },
  });
  // Tighter commitlint value wins.
  const tight = { ...base, commitlint: { maxSubjectLength: 40, maxBulletLength: 60 } };
  expect(effectiveMaxSubject(tight)).toBe(40);
  expect(effectiveMaxBullet(tight)).toBe(60);
  // Looser commitlint value loses (convit's own limit stays).
  const loose = { ...base, commitlint: { maxSubjectLength: 99, maxBulletLength: 99 } };
  expect(effectiveMaxSubject(loose)).toBe(50);
  expect(effectiveMaxBullet(loose)).toBe(72);
  // No commitlint → convit's resolved value.
  expect(effectiveMaxSubject(base)).toBe(50);
});

// --- loadCommitlintConstraints (real loader, repo-rooted fixtures) ----------
//
// The fixture dir MUST live inside the repo so the loader's cwd-rooted
// `createRequire` walks up to the repo's node_modules to resolve the real
// `@commitlint/load` and `@commitlint/config-conventional` (devDependencies).
// This is the only test that exercises `extends` resolution + cwd resolution —
// a unit test with hand-built rule objects would pass while both are broken.

const TMP_ROOT = path.join(process.cwd(), ".tmp-test");
const created: string[] = [];

function makeFixture(files: Record<string, string>): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, "cl-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("loadCommitlintConstraints: resolves an extends-based config and maps overrides", async () => {
  const dir = makeFixture({
    "package.json": JSON.stringify({ name: "fixture" }),
    ".commitlintrc.json": JSON.stringify({
      extends: ["@commitlint/config-conventional"],
      rules: {
        "type-enum": [2, "always", ["feat", "fix", "chore"]],
        "subject-max-length": [2, "always", 50],
        "body-max-line-length": [1, "always", 80],
      },
    }),
  });

  expect(await loadCommitlintConstraints(dir)).toEqual({
    types: ["feat", "fix", "chore"],
    maxSubjectLength: 50,
    maxBulletLength: 80,
  });
});

test("loadCommitlintConstraints: a project with no commitlint config → null", async () => {
  const dir = makeFixture({ "package.json": JSON.stringify({ name: "bare" }) });
  expect(await loadCommitlintConstraints(dir)).toBeNull();
});
