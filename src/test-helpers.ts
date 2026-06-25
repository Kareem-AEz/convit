// =============================================================================
// Test Helpers
// =============================================================================
//
// Tiny factories for the test suites. Not part of the shipped bundle — tsup
// only bundles what `bin/convit.ts` reaches, and nothing here is imported by
// the entry. Kept out of `*.test.ts` so the runner does not treat it as a suite.
// =============================================================================

import type { Config, FileSummary, UserConfig } from "./types";

/** Minimal Config for pure-function tests; override any field. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  const { userConfig, ...rest } = overrides;
  return {
    apiUrl: "http://localhost:1234/v1",
    apiKey: "",
    model: "test-model",
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    dryRun: false,
    noCompress: false,
    accept: false,
    debug: false,
    structured: true,
    timeoutMs: 60_000,
    exclude: [],
    trailers: [],
    userConfig: makeUserConfig(userConfig),
    ...rest,
  };
}

export function makeUserConfig(overrides: UserConfig = {}): UserConfig {
  return { ...overrides };
}

/** Minimal FileSummary; override any field. */
export function makeFile(overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    path: "src/index.ts",
    changeType: "modify",
    additions: 0,
    deletions: 0,
    category: "source",
    isBinary: false,
    importanceScore: 0,
    keyChanges: [],
    hunkContexts: [],
    notes: [],
    formattingOnly: false,
    ...overrides,
  };
}
