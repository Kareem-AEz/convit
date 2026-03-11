// =============================================================================
// CLI & Terminal Utilities
// =============================================================================
//
// Re-exports from @clack/prompts for the interactive UI, picocolors for
// terminal styling, and cost calculation. No domain logic lives here.
// =============================================================================

export {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

import pc from "picocolors";
import type { Config } from "../types";

export { pc };

/**
 * Calculates the cost of a generation based on configured per-token rates.
 *
 * Pricing math: cost = (tokens / 1,000,000) * rate_per_million
 *
 * Display precision tiers:
 * - $0.00     → "Free (local model)" — avoids showing $0.0000 for LM Studio
 * - < $0.0001 → "< $0.0001"          — for extremely cheap sub-cent runs
 * - < $0.01   → 4 decimal places     — for small costs where cents matter
 * - ≥ $0.01   → 3 decimal places     — sufficient precision for larger amounts
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  config: Config,
): {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  formattedCost: string;
} {
  const inputCost = (promptTokens / 1_000_000) * config.inputCostPer1M;
  const outputCost = (completionTokens / 1_000_000) * config.outputCostPer1M;
  const totalCost = inputCost + outputCost;

  let formattedCost: string;
  if (totalCost === 0) {
    formattedCost = "Free (local model)";
  } else if (totalCost < 0.0001) {
    formattedCost = "< $0.0001";
  } else if (totalCost < 0.01) {
    formattedCost = `$${totalCost.toFixed(4)}`;
  } else {
    formattedCost = `$${totalCost.toFixed(3)}`;
  }

  return { inputCost, outputCost, totalCost, formattedCost };
}

/**
 * Formats token count for display: uses locale for thousands, or compact suffix for large numbers.
 */
export function formatTokenCount(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Braille-style spinner frames for a smooth, elegant loading indicator */
export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/**
 * Prints the convit banner with gradient ASCII block art.
 * Blue → cyan → magenta gradient, inspired by elegant CLI aesthetics.
 */
export function printBanner(): void {
  const art = [
    "   ___ ___  _ ____   _(_) |_ ",
    "  / __/ _ \\| '_ \\ \\ / / | __|",
    " | (_| (_) | | | \\ V /| | |_ ",
    "  \\___\\___/|_| |_|\\_/ |_|\\__|",
  ];

  console.log();
  for (let i = 0; i < art.length; i++) {
    console.log(pc.dim("  " + art[i]));
  }
  console.log(pc.dim("  ······························"));
  console.log(pc.dim("  conventional commits by AI"));
  console.log();
}
