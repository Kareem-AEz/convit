import {
  DEFAULT_CANDIDATES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRAILERS,
  EXCLUDED_FILES,
  MAX_CANDIDATES,
} from "./defaults";
import { cosmiconfigSync } from "cosmiconfig";
import { pc } from "../cli/ui";
import { isLocalUrl } from "../utils/url";
import type { Config, UserConfig } from "../types";

/**
 * Parses a per-1M cost env value, falling back to 0 for missing or malformed
 * input. `parseFloat` returns NaN for non-numeric strings, which would render
 * as "$NaN" in the cost readout — guard against it here.
 */
export function parseCost(raw: string | undefined): number {
  const n = parseFloat(raw ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolves `--candidates <n>` to a candidate count. Absent → 1 (feature off).
 * Bare `--candidates` (no following number) → `DEFAULT_CANDIDATES`. A given
 * number clamps to `[1, MAX_CANDIDATES]`; a non-numeric value falls back to the
 * default. Exposed for unit testing the parse/clamp boundaries.
 */
export function parseCandidates(args: string[]): number {
  const idx = args.indexOf("--candidates");
  if (idx === -1) return 1;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith("--")) return DEFAULT_CANDIDATES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CANDIDATES;
  return Math.min(MAX_CANDIDATES, Math.max(1, parsed));
}

/**
 * Parses runtime configuration from environment variables, CLI arguments,
 * and user configuration files (e.g., .convitrc.js).
 *
 * Precedence (highest to lowest):
 *   CLI `--model <id>`  >  `.env.local`  >  `.env`  >  `.convitrc`  >  Defaults
 */
export function getConfig(): Config {
  const args = process.argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const noCompress = args.includes("--no-compress");
  const accept = args.includes("--accept");
  const amend = args.includes("--amend");
  const debug = args.includes("--debug");
  const structured = !args.includes("--no-structured");
  const json = args.includes("--json");
  const print = args.includes("--print");

  const modelIdx = args.indexOf("--model");
  const cliModelOverride =
    modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;

  // `--candidates <n>` → generate N messages and pick. Bare `--candidates`
  // (no number) uses DEFAULT_CANDIDATES; values clamp to [1, MAX_CANDIDATES].
  // 1 disables the feature.
  const candidates = parseCandidates(args);

  // 1. Load User Configuration via cosmiconfig
  const explorer = cosmiconfigSync("convit");
  const searchResult = explorer.search();
  const userConfig: UserConfig = searchResult ? searchResult.config : {};

  // 2. Merge Configuration
  // All provider settings come from env only — config files are safe to commit.
  const apiUrl = process.env.CONVIT_URL ?? "http://localhost:1234/v1";

  const apiKey = process.env.CONVIT_KEY ?? "lm-studio";

  const model = cliModelOverride ?? process.env.CONVIT_MODEL;

  const config: Config = {
    apiUrl,
    apiKey,
    model: model as string, // Cast because it might be undefined (auto-detect)
    inputCostPer1M: parseCost(process.env.CONVIT_INPUT_COST),
    outputCostPer1M: parseCost(process.env.CONVIT_OUTPUT_COST),
    dryRun,
    noCompress,
    accept,
    amend,
    candidates,
    debug,
    structured,
    json,
    print,
    timeoutMs:
      parseInt(process.env.CONVIT_TIMEOUT ?? "", 10) ||
      userConfig.rules?.timeout ||
      DEFAULT_TIMEOUT_MS,
    userConfig, // Pass the merged config down to the domain layers
    exclude: [...EXCLUDED_FILES, ...(userConfig.exclude ?? [])],
    // `?? ` (not `||`) so an explicit `[]` disables trailers; unset → default.
    trailers: userConfig.commit?.trailers ?? DEFAULT_TRAILERS,
  };

  if (debug) {
    const rule = "━".repeat(60);
    const title = "DEBUG MODE";
    const padLeft = Math.floor((60 - title.length) / 2);
    const padRight = 60 - title.length - padLeft;
    console.log(pc.yellow(rule));
    console.log(
      pc.yellow(pc.bold(" ".repeat(padLeft) + title + " ".repeat(padRight))),
    );
    console.log(pc.yellow(rule));
    console.log();
  }

  if (dryRun) {
    console.log(pc.yellow("Dry-run mode: commit will not be created\n"));
  }

  const isNonDefault =
    config.apiUrl !== "http://localhost:1234/v1" ||
    config.model !== undefined ||
    config.inputCostPer1M > 0 ||
    config.outputCostPer1M > 0 ||
    searchResult !== null;

  if (isNonDefault) {
    console.log(pc.dim("Config"));
    if (searchResult) {
      console.log(
        pc.dim(`  File:  ${searchResult.filepath.split(/[\\/]/).pop()}`),
      );
    }
    console.log(pc.dim(`  URL:   ${config.apiUrl}`));
    console.log(pc.dim(`  Model: ${config.model ?? "(auto-detect)"}`));
    if (config.apiKey !== "lm-studio") {
      console.log(
        pc.dim(`  Key:   ${"*".repeat(6) + config.apiKey.slice(-4)}`),
      );
    }
    if (config.inputCostPer1M > 0 || config.outputCostPer1M > 0) {
      console.log(
        pc.dim(
          `  Costs: $${config.inputCostPer1M}/1M in, $${config.outputCostPer1M}/1M out`,
        ),
      );
    }
    console.log();
  }

  if (!isLocalUrl(config.apiUrl)) {
    const missing: string[] = [];
    if (config.apiKey === "lm-studio") missing.push("API Key");
    if (!config.model) missing.push("Model ID");
    if (missing.length > 0) {
      console.log(
        pc.yellow(`External API detected but missing: ${missing.join(", ")}`),
      );
      console.log(
        pc.dim(
          "  External providers require CONVIT_KEY and CONVIT_MODEL in .env.\n",
        ),
      );
    }
  }

  if (config.apiKey !== "lm-studio" && isLocalUrl(config.apiUrl)) {
    console.log(pc.yellow("API Key is set but using default localhost URL."));
    console.log(
      pc.dim("  If using an external provider, configure the base URL.\n"),
    );
  }

  return config;
}
