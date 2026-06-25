import { test, expect } from "vitest";

import { isLocalUrl } from "./url";

test("isLocalUrl accepts loopback hosts (localhost, 127.0.0.1, ::1, 0.0.0.0)", () => {
  expect(isLocalUrl("http://localhost:1234/v1")).toBe(true);
  expect(isLocalUrl("http://127.0.0.1:1234/v1")).toBe(true);
  expect(isLocalUrl("http://[::1]:1234/v1")).toBe(true);
  expect(isLocalUrl("http://0.0.0.0:8080")).toBe(true);
});

test("isLocalUrl rejects a remote host that merely contains 'localhost'", () => {
  // The bug a substring check has: this is a remote attacker domain.
  expect(isLocalUrl("https://localhost.attacker.com/v1")).toBe(false);
  expect(isLocalUrl("https://api.openai.com/v1")).toBe(false);
});

test("isLocalUrl treats a malformed URL as non-local (fail safe)", () => {
  expect(isLocalUrl("not a url")).toBe(false);
  expect(isLocalUrl("")).toBe(false);
});
