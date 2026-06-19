import { beforeEach, describe, expect, test, vi } from "vitest";

// Spy on child_process so we can assert — deterministically, with no real git —
// that git is invoked via an argv array (execFileSync), never a shell string.
// This is the positive proof that the P1-T4 injection vector is dead: a
// malicious exclude entry arrives as a single literal argv element.
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "child_process";
import { excludePathspecs, getStagedDiff, getStagedFiles } from "./git";

const mockExec = vi.mocked(execFileSync);

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockReturnValue("");
});

describe("excludePathspecs", () => {
  test("maps each entry to one literal :(exclude) pathspec element", () => {
    expect(excludePathspecs(["dist", "a b.txt"])).toEqual([
      ":(exclude)dist",
      ":(exclude)a b.txt",
    ]);
  });

  test("preserves shell metacharacters literally (no escaping, no splitting)", () => {
    expect(excludePathspecs(["foo; rm -rf ~", "$(whoami)", "a && b"])).toEqual([
      ":(exclude)foo; rm -rf ~",
      ":(exclude)$(whoami)",
      ":(exclude)a && b",
    ]);
  });

  test("returns an empty array when there are no excludes", () => {
    expect(excludePathspecs([])).toEqual([]);
  });
});

describe("getStagedFiles", () => {
  test("passes a malicious exclude as a single literal argv element (no shell)", () => {
    getStagedFiles(["foo; rm -rf ~"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", ":(exclude)foo; rm -rf ~"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("handles an exclude with a space as one argv element", () => {
    getStagedFiles(["drop me.txt"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", ":(exclude)drop me.txt"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("trims the command output", () => {
    mockExec.mockReturnValue("a.ts\nb.ts\n");
    expect(getStagedFiles([])).toBe("a.ts\nb.ts");
  });

  test("threads an explicit cwd through to execFileSync", () => {
    getStagedFiles([], "/tmp/repo");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only"],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
  });
});

describe("getStagedDiff", () => {
  test("builds the diff argv with excludes appended literally (no shell)", () => {
    getStagedDiff(["dist", "weird; name"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      [
        "diff",
        "--cached",
        "--unified=3",
        "--no-prefix",
        "--ignore-space-at-eol",
        ":(exclude)dist",
        ":(exclude)weird; name",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});
