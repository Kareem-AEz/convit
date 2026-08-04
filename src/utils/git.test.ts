import { beforeEach, describe, expect, test, vi } from "vitest";

// Spy on child_process so we can assert — deterministically, with no real git —
// that git is invoked via an argv array (execFileSync), never a shell string.
// This is the positive proof that the P1-T4 injection vector is dead: a
// malicious exclude entry arrives as a single literal argv element.
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "child_process";
import { GIT_MAX_BUFFER_BYTES } from "../config/defaults";
import {
  excludePathspecs,
  getFormattingOnlyFiles,
  getRecentCommits,
  getStagedDiff,
  getStagedFiles,
  hasParentCommit,
} from "./git";

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
      ["diff", "--cached", "--name-only", "-M", ":(exclude)foo; rm -rf ~"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("handles an exclude with a space as one argv element", () => {
    getStagedFiles(["drop me.txt"]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "-M", ":(exclude)drop me.txt"],
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
      ["diff", "--cached", "--name-only", "-M"],
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
        "-M",
        ":(exclude)dist",
        ":(exclude)weird; name",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

describe("stdout buffer ceiling", () => {
  // Node defaults execFileSync's maxBuffer to 1 MiB; git overflows that on any
  // sizeable staged change and spawnSync fails with ENOBUFS. Every git call
  // that can return unbounded output must raise the ceiling explicitly.
  const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

  test("GIT_MAX_BUFFER_BYTES is above Node's 1 MiB default and finite", () => {
    expect(GIT_MAX_BUFFER_BYTES).toBeGreaterThan(NODE_DEFAULT_MAX_BUFFER);
    expect(Number.isFinite(GIT_MAX_BUFFER_BYTES)).toBe(true);
  });

  test.each([
    ["getStagedDiff", () => getStagedDiff([])],
    ["getStagedFiles", () => getStagedFiles([])],
    ["getFormattingOnlyFiles", () => getFormattingOnlyFiles([])],
    ["getRecentCommits", () => getRecentCommits()],
  ])("%s raises maxBuffer past the default", (_name, call) => {
    call();
    expect(mockExec).toHaveBeenCalled();
    for (const [, , options] of mockExec.mock.calls) {
      expect((options as { maxBuffer?: number })?.maxBuffer).toBe(
        GIT_MAX_BUFFER_BYTES,
      );
    }
  });

  test.each([
    ["getStagedDiff", () => getStagedDiff([]), /staged diff is too large/],
    ["getStagedFiles", () => getStagedFiles([]), /staged file list is too large/],
  ])("%s turns ENOBUFS into an actionable error", (_name, call, message) => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync git ENOBUFS"), {
        code: "ENOBUFS",
      });
    });
    // Never a truncated diff: what the secret scanner reads must be exactly
    // what reaches the model, so an overflow has to be fatal.
    expect(call).toThrow(message);
    expect(call).toThrow(/\.convitrc\.json/);
  });

  test("a non-ENOBUFS git failure propagates unchanged", () => {
    mockExec.mockImplementation(() => {
      throw new Error("fatal: bad revision");
    });
    expect(() => getStagedDiff([])).toThrow("fatal: bad revision");
  });
});

describe("amend base (P3-T5)", () => {
  test("getStagedFiles inserts the base ref after -M, before pathspecs", () => {
    getStagedFiles(["dist"], undefined, "HEAD~1");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "-M", "HEAD~1", ":(exclude)dist"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("getStagedFiles omits the base ref when none is given (normal commit)", () => {
    getStagedFiles([]);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "-M"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("getStagedDiff inserts the base ref before pathspecs", () => {
    getStagedDiff(["dist"], undefined, "HEAD~1");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      [
        "diff",
        "--cached",
        "--unified=3",
        "--no-prefix",
        "--ignore-space-at-eol",
        "-M",
        "HEAD~1",
        ":(exclude)dist",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("getRecentCommits adds --skip when skipping HEAD (amend)", () => {
    getRecentCommits(3, 1);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log", "-3", "--skip=1", "--format=%B%n---"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("getRecentCommits omits --skip by default", () => {
    getRecentCommits();
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log", "-3", "--format=%B%n---"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("hasParentCommit is true when rev-parse resolves HEAD~1", () => {
    mockExec.mockReturnValue("");
    expect(hasParentCommit()).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD~1"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  test("hasParentCommit is false when rev-parse throws (root commit)", () => {
    mockExec.mockImplementation(() => {
      throw new Error("fatal: ambiguous argument 'HEAD~1'");
    });
    expect(hasParentCommit()).toBe(false);
  });
});
