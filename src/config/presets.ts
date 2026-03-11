// =============================================================================
// Configuration Presets
// =============================================================================
//
// Framework-specific presets for `convit init`. Users can extend or override
// these via .convitrc after generation.
// =============================================================================

import type { UserConfig } from "../types";

export interface Preset {
  id: string;
  label: string;
  hint?: string;
  config: UserConfig;
}

export const PRESETS: Preset[] = [
  {
    id: "generic",
    label: "Generic / Language Agnostic",
    hint: "Minimal config, relies on built-in defaults",
    config: {},
  },
  {
    id: "nextjs-prisma",
    label: "Next.js + Prisma (FSD)",
    hint: "Feature-Sliced Design, prisma/, components/ui",
    config: {
      scopePatterns: [
        { pattern: "src/features/([^/]+)/.*", scope: "$1", weight: 10 },
        { pattern: "components/ui/.*", scope: "ui", weight: 5 },
        { pattern: "prisma/.*", scope: "db", weight: 5 },
        { pattern: "schema.*", scope: "db", weight: 5 },
      ],
      exclude: ["src/generated/prisma", ".prisma/client"],
    },
  },
  {
    id: "rust",
    label: "Rust",
    hint: "crates/, src/bin/, excludes target/",
    config: {
      scopePatterns: [
        { pattern: "crates/([^/]+)/.*", scope: "$1", weight: 10 },
        { pattern: "src/bin/.*", scope: "bin", weight: 5 },
        { pattern: "src/.*", scope: "lib", weight: 5 },
      ],
      exclude: ["target/"],
    },
  },
  {
    id: "go",
    label: "Go",
    hint: "cmd/, pkg/, internal/",
    config: {
      scopePatterns: [
        { pattern: "cmd/([^/]+)/.*", scope: "$1", weight: 10 },
        { pattern: "pkg/([^/]+)/.*", scope: "$1", weight: 8 },
        { pattern: "internal/([^/]+)/.*", scope: "$1", weight: 8 },
      ],
    },
  },
  {
    id: "python",
    label: "Python",
    hint: "tests/, excludes __pycache__, .pytest_cache",
    config: {
      scopePatterns: [
        { pattern: "tests?/([^/]+)/.*", scope: "$1", weight: 8 },
        { pattern: "([^/]+)/.*", scope: "$1", weight: 5 },
      ],
      exclude: ["__pycache__/", ".pytest_cache/"],
    },
  },
];
