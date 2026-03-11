// =============================================================================
// Entry Point
// =============================================================================
//
// Routes to `convit init` or the main interactive loop.
// =============================================================================

import dotenv from "dotenv";
import { runInteractiveLoop } from "../src/cli/index";
import { runInit } from "../src/cli/init";
import { cancel } from "../src/cli/ui";
import { getConfig } from "../src/config/loader";

dotenv.config();

const args = process.argv.slice(2);

if (args[0] === "init") {
  runInit().catch((err) => {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  const config = getConfig();
  runInteractiveLoop(config).catch((err) => {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
