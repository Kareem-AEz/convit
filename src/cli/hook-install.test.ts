import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CONVIT_HOOK_MARKER,
  hookScriptContent,
  isConvitHook,
} from "./hook-install";

test("hookScriptContent is a POSIX-sh script with a LF-terminated shebang", () => {
  const script = hookScriptContent();
  expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  // No CR anywhere — a CRLF shebang (`#!/bin/sh\r`) breaks hook execution.
  expect(script.includes("\r")).toBe(false);
});

test("hookScriptContent carries the convit marker for idempotent install/uninstall", () => {
  expect(hookScriptContent()).toContain(CONVIT_HOOK_MARKER);
});

test("hookScriptContent forwards git's three args and fails open", () => {
  const script = hookScriptContent();
  expect(script).toContain('convit hook run "$1" "$2" "$3"');
  expect(script).toContain("|| true"); // never block the commit on convit failure
  expect(script).toContain("npx --no-install convit"); // PATH fallback
});

test("isConvitHook detects the marker, rejects foreign and missing hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "convit-hook-"));
  const ours = join(dir, "prepare-commit-msg");
  const foreign = join(dir, "foreign");
  writeFileSync(ours, hookScriptContent(), "utf-8");
  writeFileSync(foreign, "#!/bin/sh\nexit 0\n", "utf-8");

  expect(isConvitHook(ours)).toBe(true);
  expect(isConvitHook(foreign)).toBe(false);
  expect(isConvitHook(join(dir, "does-not-exist"))).toBe(false);
});
