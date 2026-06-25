import { DEFAULT_TIMEOUT_MS, EXCLUDED_FILES } from "./defaults";
import { cosmiconfigSync } from "cosmiconfig";
import { pc } from "../cli/ui";
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
  const debug = args.includes("--debug");
  const structured = !args.includes("--no-structured");

  const modelIdx = args.indexOf("--model");
  const cliModelOverride =
    modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;

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
    debug,
    structured,
    timeoutMs:
      parseInt(process.env.CONVIT_TIMEOUT ?? "", 10) ||
      userConfig.rules?.timeout ||
      DEFAULT_TIMEOUT_MS,
    userConfig, // Pass the merged config down to the domain layers
    exclude: [...EXCLUDED_FILES, ...(userConfig.exclude ?? [])],
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

  if (!config.apiUrl.includes("localhost")) {
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

  if (config.apiKey !== "lm-studio" && config.apiUrl.includes("localhost")) {
    console.log(pc.yellow("API Key is set but using default localhost URL."));
    console.log(
      pc.dim("  If using an external provider, configure the base URL.\n"),
    );
  }

  return config;
}
