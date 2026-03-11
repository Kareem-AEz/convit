// =============================================================================
// convit init — Setup Wizard
// =============================================================================
//
// Interactive preset selection to generate .convitrc.json.
// =============================================================================

import { intro, isCancel, outro, select } from "@clack/prompts";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { PRESETS } from "../config/presets";
import { pc } from "./ui";

const CONFIG_FILENAME = ".convitrc.json";

export async function runInit(): Promise<void> {
  intro(pc.dim("convit init"));

  const choice = await select({
    message: "What type of project is this?",
    options: PRESETS.map((p) => ({
      value: p.id,
      label: p.label,
      hint: p.hint,
    })),
  });

  if (isCancel(choice)) {
    outro(pc.yellow("Cancelled."));
    process.exit(0);
  }

  const preset = PRESETS.find((p) => p.id === choice);
  if (!preset) {
    outro(pc.red("Invalid preset selected."));
    process.exit(1);
  }

  const configPath = resolve(process.cwd(), CONFIG_FILENAME);
  const isEmpty = Object.keys(preset.config).length === 0;
  const content = isEmpty ? "{}" : JSON.stringify(preset.config, null, 2);

  try {
    writeFileSync(configPath, content + "\n", "utf-8");
  } catch (err) {
    outro(pc.red(`Failed to write ${CONFIG_FILENAME}: ${err}`));
    process.exit(1);
  }

  outro(
    pc.green(`Created ${CONFIG_FILENAME}`) +
      pc.dim("\n  Edit it to add rules or scope patterns. Use .env for API keys."),
  );
}
