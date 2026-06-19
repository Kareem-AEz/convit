import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-function suites — no DOM, no globals needed.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
