// =============================================================================
// Entry Point
// =============================================================================
//
// Routes to `convit init` or the main interactive loop.
// =============================================================================

import dotenv from "dotenv";
import { runHook, runInteractiveLoop } from "../src/cli/index";
import { installHook, uninstallHook } from "../src/cli/hook-install";
import { runInit } from "../src/cli/init";
import { cancel, pc } from "../src/cli/ui";
import { getConfig } from "../src/config/loader";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ path: ".env", quiet: true });

const args = process.argv.slice(2);

if (args[0] === "init") {
  runInit().catch((err) => {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (args[0] === "hook") {
  // `hook run <msgFile> <source> <sha>` is invoked by the installed
  // prepare-commit-msg hook; `install`/`uninstall` are user commands.
  const sub = args[1];
  if (sub === "install") {
    installHook();
  } else if (sub === "uninstall") {
    uninstallHook();
  } else if (sub === "run") {
    // Fail open: a hook must never block a commit, even on a config error.
    try {
      const config = getConfig();
      runHook(config, args[2], args[3] ?? "", args[4] ?? "").catch(() =>
        process.exit(0),
      );
    } catch {
      process.exit(0);
    }
  } else {
    console.error(
      pc.yellow("Usage: convit hook <install|uninstall>") +
        pc.dim(
          "\n  install    add a prepare-commit-msg hook that generates messages on `git commit`" +
            "\n  uninstall  remove the convit hook (restores any backed-up hook)",
        ),
    );
    process.exit(1);
  }
} else {
  const config = getConfig();
  runInteractiveLoop(config).catch((err) => {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
