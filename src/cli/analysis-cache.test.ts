import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock only the three `git diff --cached` reads so the cache can be exercised
// with controlled diffs and no real git. Everything else in ../utils/git stays
// real (createAnalysisCache only reaches the three reads via fetchStagedRaw).
const h = vi.hoisted(() => ({ diff: "", files: "a.ts", calls: 0 }));
vi.mock("../utils/git", async (orig) => {
  const actual = await orig<typeof import("../utils/git")>();
  return {
    ...actual,
    getStagedFiles: () => h.files,
    getStagedDiff: () => {
      h.calls++;
      return h.diff;
    },
    getFormattingOnlyFiles: () => new Set<string>(),
  };
});

import { createAnalysisCache } from "./index";
import { makeConfig } from "../test-helpers";

const DIFF_A =
  "diff --git a.ts b.ts\n--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new\n";
const DIFF_B =
  "diff --git a.ts b.ts\n--- a.ts\n+++ b.ts\n@@ -1 +2 @@\n-old\n+new\n+more\n";

beforeEach(() => {
  h.diff = DIFF_A;
  h.files = "a.ts";
  h.calls = 0;
});

describe("createAnalysisCache (P3-T5)", () => {
  test("re-reads the diff on every call (honors a mid-session git add)", () => {
    const load = createAnalysisCache("", makeConfig());
    load();
    load();
    load();
    expect(h.calls).toBe(3); // the git read ran each time, not just once
  });

  test("reuses the analysis when the diff is unchanged (same object reference)", () => {
    const load = createAnalysisCache("", makeConfig());
    const first = load();
    const second = load();
    expect(second).toBe(first); // cache hit → identical context, no recompute
  });

  test("recomputes when the diff changes (cache miss → fresh analysis)", () => {
    const load = createAnalysisCache("", makeConfig());
    const first = load();
    h.diff = DIFF_B; // a mid-session `git add` changes the staged diff
    const second = load();
    expect(second).not.toBe(first);
    expect(second.rawDiff).toBe(DIFF_B);
  });

  test("a diff that reverts to an earlier value re-analyzes (only the last is cached)", () => {
    const load = createAnalysisCache("", makeConfig());
    const a1 = load();
    h.diff = DIFF_B;
    load();
    h.diff = DIFF_A; // back to the original content
    const a2 = load();
    expect(a2).not.toBe(a1); // single-slot cache, but still correct content
    expect(a2.rawDiff).toBe(DIFF_A);
  });
});
