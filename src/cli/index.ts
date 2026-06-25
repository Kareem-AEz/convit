// =============================================================================
// Interactive CLI Orchestrator
// =============================================================================
//
// The state machine that drives the entire commit workflow. This is the only
// module that coordinates all other modules — it is the "main" function.
//
// State machine transitions:
//   normal → (user picks "r", valid)    → regenerate (variety mode)
//   normal → (user picks "r", invalid)  → regenerate (correction mode)
//   normal → (user picks "e")           → edit (feedback mode)
//   any    → (user picks "y")           → commitOrDryRun → exit
//   any    → (user picks "n")           → exit
// =============================================================================

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import {
  calculateCost,
  cancel,
  confirm,
  emitMachine,
  formatTokenCount,
  isCancel,
  note,
  outro,
  pc,
  printBanner,
  select,
  text,
} from "../cli/ui";
import { MAX_FILES_FULL_QUALITY, MAX_RETRY_ATTEMPTS } from "../config/defaults";
import { evaluateAutoAcceptGate, evaluateSensitiveAcceptGate } from "./gates";
import { classifyChanges } from "../core/classifier";
import { analyzeDiff, summarizeDiff } from "../core/parser";
import {
  collectPromptSecrets,
  detectSensitiveInText,
  promptForSensitiveConfirmation,
} from "../core/security";
import {
  appendTrailers,
  expandTrailers,
  generateCommit,
} from "../llm/generator";
import { buildPrompt } from "../llm/prompts";
import type {
  BuiltPrompt,
  Config,
  GenerateResult,
  SessionState,
  StagedContext,
} from "../types";
import {
  getFormattingOnlyFiles,
  getLoadedModel,
  getRecentCommits,
  getStagedDiff,
  getStagedFiles,
  isInitialCommit,
  verifyGitRepo,
} from "../utils/git";
import { isLocalUrl } from "../utils/url";

/**
 * Fetches and fully enriches all staged git changes into a ready-to-use context.
 *
 * Pipeline:
 * 1. `git diff --cached --name-only` — fast file listing, excludes noisy files
 * 2. `git diff --cached --unified=3` — full diff with 3 lines of context
 * 3. `analyzeDiff` → per-file summaries with importance scoring
 * 4. `classifyChanges` → commit type + scope hints for the AI
 * 5. `collectPromptSecrets` → scan every static prompt source (diff, file paths,
 *    recent commits) before any API call
 * 6. `summarizeDiff` → compress if large, pass through if small
 *
 * @throws Error if no files are staged
 */
async function getStagedContext(
  config: Config,
  recentCommits: string,
): Promise<StagedContext> {
  const stagedFiles = getStagedFiles(config.exclude);

  if (!stagedFiles) {
    throw new Error(
      "No staged changes found. Stage files with: git add <files>",
    );
  }

  const fileList = stagedFiles.split("\n");

  const rawDiff = getStagedDiff(config.exclude);
  const formattingOnlyFiles = getFormattingOnlyFiles(config.exclude);

  const diffSummary = analyzeDiff(rawDiff, fileList, formattingOnlyFiles);
  const classification = classifyChanges(diffSummary.files, rawDiff, config);
  // Scan the diff plus the other repo-derived text that reaches the model: file
  // paths and recent commit bodies. The typed description is gated in-loop.
  const sensitiveMatches = collectPromptSecrets(rawDiff, fileList, recentCommits);
  const { processedDiff, wasCompressed } = summarizeDiff(
    rawDiff,
    diffSummary,
    config.noCompress,
  );

  return {
    fileList,
    rawDiff,
    processedDiff,
    wasCompressed,
    originalLength: rawDiff.length,
    compressedLength: processedDiff.length,
    diffSummary,
    classification,
    sensitiveMatches,
  };
}

/**
 * Where a finalized commit message is written.
 * - `commit`: run `git commit` (the interactive default).
 * - `file`: write to a path (the git-hook path) — convit's message is prepended
 *   above `existing` (git's comment/diff block) so the user still sees it.
 */
type WriteTarget =
  | { kind: "commit" }
  | { kind: "file"; path: string; existing: string };

/**
 * Writes a finalized commit message to its target, or simulates it in dry-run.
 *
 * Trailers are appended here — the single terminal write step, after the
 * edit/regenerate loop — so they're never fed back to the model or stacked on a
 * regenerate, and so they apply uniformly whether convit commits directly or
 * populates a hook's commit-msg file.
 *
 * Why `git commit -F-` (commit target) instead of `git commit -m "..."`?
 * The `-m` flag passes the message as a shell argument; multi-line messages with
 * special characters would require complex escaping. `-F-` reads from stdin,
 * bypassing the shell entirely.
 */
async function commitOrDryRun(
  message: string,
  config: Config,
  model?: string,
  target: WriteTarget = { kind: "commit" },
): Promise<void> {
  const finalMessage = appendTrailers(message, config.trailers, model);

  if (target.kind === "file") {
    // Prepend convit's message above git's existing comment/diff block so the
    // editor opens pre-filled and the user keeps the usual context below.
    const body = target.existing
      ? `${finalMessage}\n${target.existing}`
      : `${finalMessage}\n`;
    writeFileSync(target.path, body, "utf-8");
    return;
  }

  if (config.dryRun) {
    note(`Would commit: ${finalMessage.split("\n")[0]}`, "Dry-run");
    return;
  }

  try {
    // git's "[branch hash] subject" summary is chrome. `inherit` writes it to the
    // real stdout fd, which the process.stdout.write redirect can't intercept — so
    // in machine-output mode route git's stdout to the real stderr fd (2) to keep
    // stdout a clean JSON/message channel.
    const machineOutput = config.json || config.print;
    execFileSync("git", ["commit", "-F-"], {
      input: finalMessage,
      stdio: ["pipe", machineOutput ? 2 : "inherit", "inherit"],
    });
    outro("Committed successfully");
  } catch (err) {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const SEP = "═".repeat(60);
const SUB = "─".repeat(60);

/** Local Mode: URL host is a loopback address — data never leaves the machine. */
function isLocalMode(config: Config): boolean {
  return isLocalUrl(config.apiUrl);
}

function printDebugOutput(
  context: StagedContext,
  prompt: BuiltPrompt,
  config: Config,
): void {
  const dim = (s: string) => pc.dim(s);
  // Bold white for section labels — clearly above dim content, below yellow header
  const section = (label: string) => pc.bold(`▸ ${label}`);
  // Strip internal ═ dividers from prompt strings so they don't clash with the debug border
  const cleanPromptLines = (text: string) =>
    text.split("\n").filter((l) => !/^[═─]{4,}$/.test(l.trim()));

  console.log();
  console.log(pc.yellow(SEP));
  console.log(pc.yellow(pc.bold(" DEBUG")));
  console.log(pc.yellow(SEP));
  console.log();

  console.log(section("PROMPT (system)"));
  console.log(dim(SUB));
  for (const line of cleanPromptLines(prompt.system)) {
    console.log(dim("  " + line));
  }
  console.log();

  console.log(section("PROMPT (user)"));
  console.log(dim(SUB));
  for (const line of cleanPromptLines(prompt.user)) {
    console.log(dim("  " + line));
  }
  console.log();

  const { diffSummary, classification } = context;
  console.log(section("DIFF SUMMARY"));
  console.log(dim(SUB));
  console.log(
    dim(
      `  totalFiles: ${diffSummary.totalFiles}  additions: ${diffSummary.totalAdditions}  deletions: ${diffSummary.totalDeletions}  originalLength: ${diffSummary.originalLength}`,
    ),
  );
  console.log(dim("  files:"));
  for (const f of diffSummary.files) {
    console.log(
      dim(
        `    • ${f.path.padEnd(36)} ${f.category.padEnd(10)} +${f.additions} -${f.deletions}`,
      ),
    );
  }
  console.log();

  console.log(section("CLASSIFICATION"));
  console.log(dim(SUB));
  console.log(
    dim(
      `  type: ${classification.type}  scope: ${classification.scope}  confidence: ${classification.confidence}`,
    ),
  );
  console.log(dim("  reasoning:"));
  console.log(dim(classification.reasoning));
  console.log();

  console.log(section("COMPRESSION"));
  console.log(dim(SUB));
  console.log(
    dim(
      `  wasCompressed: ${context.wasCompressed}  ${context.originalLength} → ${context.compressedLength} chars`,
    ),
  );
  console.log(dim(`  diffTruncatedForPrompt: ${prompt.diffTruncated}`));
  console.log();

  console.log(section("DATA AFTER COMPRESSION"));
  console.log(dim(SUB));
  if (context.wasCompressed) {
    for (const line of context.processedDiff.split("\n")) {
      console.log(dim("  " + line));
    }
  } else {
    console.log(dim("  Raw diff passed through (no compression applied)"));
    for (const line of context.processedDiff.split("\n").slice(0, 20)) {
      console.log(dim("  " + line));
    }
    if (context.processedDiff.split("\n").length > 20) {
      console.log(
        dim(
          `  ... (${context.processedDiff.split("\n").length - 20} more lines)`,
        ),
      );
    }
  }
  console.log();

  if (context.sensitiveMatches.length > 0) {
    console.log(section("SENSITIVE MATCHES"));
    console.log(dim(SUB));
    for (const m of context.sensitiveMatches) {
      console.log(dim(`  ${m.file}:${m.line} (${m.type})`));
    }
    console.log();
  }

  console.log(section("CONFIG"));
  console.log(dim(SUB));
  const urlNote = isLocalMode(config) ? dim(" (secure/offline)") : "";
  console.log(dim(`  URL: ${config.apiUrl}`) + urlNote);
  console.log(dim(`  Model: ${config.model ?? "(auto-detect)"}`));
  console.log(
    dim(`  dryRun: ${config.dryRun}  noCompress: ${config.noCompress}`),
  );
  console.log(dim(`  estimatedInputTokens: ~${prompt.estimatedInputTokens}`));
  console.log();

  console.log(pc.yellow(SEP));
  console.log();
}

/**
 * The main interactive state machine that drives the entire commit workflow.
 *
 * Error recovery:
 *   If `generateCommit` throws (API error), the loop doesn't crash. It displays
 *   the error, prompts "Retry? [y/n]", and either refreshes context + continues
 *   or breaks the loop.
 *
 * Max retries gate:
 *   After MAX_RETRY_ATTEMPTS, the "regenerate" option is removed from the prompt.
 */
/**
 * Builds the AI-SDK language model and resolves its id. Shared by the
 * interactive loop and the git-hook runtime so provider setup lives in one place.
 */
async function createModel(
  config: Config,
): Promise<{ model: LanguageModel; modelName: string }> {
  // Provider is built after config is resolved so CLI flags take effect.
  const provider = createOpenAICompatible({
    name: "lmstudio",
    baseURL: config.apiUrl,
    apiKey: config.apiKey,
    includeUsage: true,
    // Send strict `response_format: json_schema` (not loose `json_object`) when a
    // schema is attached, so structured generation works on endpoints that only
    // accept the strict form. Only affects schema-bearing calls; the free-text
    // path is untouched, and unsupported endpoints fall back to it.
    supportsStructuredOutputs: true,
  });
  const modelName = await getLoadedModel(config);
  return { model: provider(modelName) as LanguageModel, modelName };
}

/**
 * Git-hook runtime (`convit hook run <msgFile> <source> <sha>`), invoked by the
 * installed `prepare-commit-msg` hook. Generates one message non-interactively
 * and writes it into the commit-msg file, then lets git's editor flow take over.
 *
 * Fails open: any error (bad repo, no model, API failure) leaves the message
 * file untouched and returns, so convit never blocks a commit.
 *
 * Respects an existing message: git passes a non-empty `source` for `-m`/`-F`
 * (`message`), merges, squashes, amends (`commit`), and templates — convit only
 * generates for a bare `git commit` (empty source). A message file that already
 * holds a real (non-comment) line is also left untouched. This is also why
 * convit's own `git commit -F-` (source `message`) is a safe no-op once the hook
 * is installed.
 */
export async function runHook(
  config: Config,
  msgFile: string,
  source: string,
  _sha: string,
): Promise<void> {
  try {
    if (source) return; // git already has a message (-m/-F/merge/squash/amend/template)

    verifyGitRepo();

    let existing = "";
    try {
      existing = readFileSync(msgFile, "utf-8");
    } catch {
      existing = "";
    }
    // A real (non-comment, non-blank) line means a message is already present.
    const hasMessage = existing
      .split("\n")
      .some((l) => l.trim() && !l.trim().startsWith("#"));
    if (hasMessage) return;

    const recentCommits = getRecentCommits();
    const context = await getStagedContext(config, recentCommits);
    if (context.fileList.length === 0) return; // nothing staged → let git handle it

    // Never POST a secret-bearing diff to the model. Warn in the file (commented)
    // and bail — fail open so the user can still write the message by hand. The
    // editor opens with this warning, the analog of --accept's hard block in a
    // context where a human is present.
    if (context.sensitiveMatches.length > 0) {
      const warning =
        "# convit: sensitive data detected in the staged diff — message not generated.\n" +
        "# Review your changes and write the commit message manually.\n";
      writeFileSync(msgFile, warning + existing, "utf-8");
      return;
    }

    const { model, modelName } = await createModel(config);
    const state: SessionState = {
      attemptCount: 0,
      mode: "normal",
      userDescription: "",
      previousOutput: null,
      previousValidation: null,
    };
    const prompt = buildPrompt(
      context,
      state,
      recentCommits,
      config,
      isInitialCommit(),
      modelName,
    );

    const result = await generateCommit(model, prompt, modelName, config);
    await commitOrDryRun(result.message, config, modelName, {
      kind: "file",
      path: msgFile,
      existing,
    });
  } catch {
    // Fail open: leave the message file exactly as git left it.
    return;
  }
}

/**
 * Shapes the `--json` payload. The `message` is the raw generated text (no
 * trailers); `trailers` lists the lines that would be appended on commit, so a
 * consumer can reconstruct the committed form. Token/cost stats are numeric —
 * the human-formatted "Free (local model)" string never leaks into the JSON.
 */
export function buildMachinePayload(
  result: GenerateResult,
  context: StagedContext,
  cost: { inputCost: number; outputCost: number; totalCost: number },
  config: Config,
  model: string,
  committed: boolean,
) {
  const { classification } = context;
  return {
    message: result.message,
    trailers: expandTrailers(config.trailers, model),
    committed,
    type: classification.type,
    scope: classification.scope,
    confidence: classification.confidence,
    validation: result.validation,
    truncated: result.wasTruncated,
    tokens: {
      input: result.inputTokens,
      output: result.outputTokens,
      total: result.inputTokens + result.outputTokens,
      fromApi: result.tokensFromApi,
    },
    cost: {
      input: cost.inputCost,
      output: cost.outputCost,
      total: cost.totalCost,
      currency: "USD" as const,
    },
    model,
  };
}

export async function runInteractiveLoop(config: Config): Promise<void> {
  // --accept (CI), --json, and --print all run without prompts: skip interactive
  // input, fail closed on the secret gate, and never block on a recoverable error.
  const nonInteractive = config.accept || config.json || config.print;
  // Machine-output modes emit to stdout instead of (or alongside) committing.
  const machineOutput = config.json || config.print;

  // -- ENVIRONMENT VALIDATION --
  try {
    verifyGitRepo();
  } catch (err) {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // -- PROVIDER SETUP --
  const { model, modelName } = await createModel(config);
  const recentCommits = getRecentCommits();
  const initialCommit = isInitialCommit();

  printBanner();

  // -- INITIAL CONTEXT --
  let context: StagedContext;
  try {
    context = await getStagedContext(config, recentCommits);
  } catch (err) {
    cancel(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // -- DISPLAY STAGED FILES --
  const fileListLines = context.fileList.map((f) => `• ${f}`).join("\n");
  const warnings: string[] = [];
  if (context.fileList.length > MAX_FILES_FULL_QUALITY) {
    warnings.push(
      `Large changeset: ${context.fileList.length} files — break into smaller commits for better quality`,
    );
  }
  if (context.rawDiff.length < 50) {
    warnings.push(
      "Small changeset — combine with other changes for meaningful commits",
    );
  }
  const nonWhitespace = context.rawDiff.replace(/[\s\n\r]/g, "").length;
  if (nonWhitespace < 20) {
    warnings.push(
      "Mostly whitespace — consider commit type 'style' or 'chore'",
    );
  }
  const stagedContent = [fileListLines, ...warnings]
    .filter(Boolean)
    .join("\n\n");
  note(stagedContent, `Staged files (${context.fileList.length})`);

  // -- SENSITIVE DATA GATE --
  if (context.sensitiveMatches.length > 0) {
    const gate = evaluateSensitiveAcceptGate(
      nonInteractive,
      context.sensitiveMatches,
    );
    if (!gate.ok) {
      cancel(gate.reason);
      process.exit(gate.code);
    }
    const confirmed = await promptForSensitiveConfirmation(
      context.sensitiveMatches,
      config.apiUrl,
    );
    if (!confirmed) {
      cancel("Cancelled — sensitive data detected");
      return;
    }
  }

  // -- USER DESCRIPTION --
  let initialDescription = "";
  if (!nonInteractive) {
    const descResult = await text({
      message: "Describe your changes (optional)",
      placeholder: "Helps generate more focused commit messages",
    });
    initialDescription = isCancel(descResult) ? "" : descResult;
  }

  const state: SessionState = {
    attemptCount: 0,
    mode: "normal",
    userDescription: initialDescription,
    previousOutput: null,
    previousValidation: null,
  };

  // Tracks the last description we cleared through the secret gate, so a plain
  // regenerate (same description) doesn't re-prompt — only freshly typed text
  // (initial or edit feedback) is re-scanned.
  let lastScannedDescription = "";

  // -- MAIN LOOP --
  while (true) {
    if (context.wasCompressed) {
      const savings = Math.round(
        ((context.originalLength - context.compressedLength) /
          context.originalLength) *
          100,
      );
      const tokFrom = Math.ceil(context.originalLength / 4);
      const tokTo = Math.ceil(context.compressedLength / 4);
      console.log(
        pc.dim(
          `Compressed ${pc.cyan(`${savings}%`)} · ${context.originalLength.toLocaleString()} → ${context.compressedLength.toLocaleString()} chars · ~${formatTokenCount(tokFrom)} → ~${formatTokenCount(tokTo)} tokens`,
        ),
      );
    }

    const scopeParts = [
      pc.dim("type: ") +
        pc.cyan(context.classification.type) +
        pc.dim(` (${context.classification.confidence})`),
      pc.dim("scope: ") + pc.cyan(context.classification.scope),
    ];
    if (context.classification.secondaryScopes.length > 0) {
      scopeParts.push(
        pc.dim("also: ") + context.classification.secondaryScopes.join(", "),
      );
    }
    console.log(pc.dim("\nPre-analysis"));
    console.log("  " + scopeParts.join(" · "));

    const prompt = buildPrompt(
      context,
      state,
      recentCommits,
      config,
      initialCommit,
      modelName,
    );

    if (config.debug) {
      printDebugOutput(context, prompt, config);
    }

    const modeLabel =
      state.mode === "edit"
        ? "Refining"
        : state.mode === "regenerate"
          ? "Regenerating"
          : "Generating";

    const attemptSuffix =
      state.attemptCount > 0
        ? ` (${state.attemptCount + 1}/${MAX_RETRY_ATTEMPTS})`
        : "";
    const secureBadge = isLocalMode(config) ? pc.bold(" [SECURE]") : "";
    console.log(pc.dim(`\n${modeLabel}`) + secureBadge + pc.dim(attemptSuffix));
    const metaParts = [
      `Prompt ~${formatTokenCount(prompt.estimatedInputTokens)} tokens`,
      modelName,
      `temp ${prompt.temperature}`,
    ];
    if (state.userDescription?.trim()) {
      metaParts.push(`"${state.userDescription.trim()}"`);
    }
    console.log(pc.dim("  " + metaParts.join(" · ")));

    // -- DESCRIPTION SECRET GATE --
    // The typed description (and edit feedback) reaches the model too, but it's
    // collected/changed inside this loop — after the static gate. Scan it here,
    // before generation, and only when it's new (avoids re-prompting on plain
    // regenerate). Fails closed under --accept, exactly like the static gate.
    const description = state.userDescription?.trim();
    if (description && description !== lastScannedDescription) {
      const descMatches = detectSensitiveInText(description, "your description");
      if (descMatches.length > 0) {
        const gate = evaluateSensitiveAcceptGate(nonInteractive, descMatches);
        if (!gate.ok) {
          cancel(gate.reason);
          process.exit(gate.code);
        }
        const confirmed = await promptForSensitiveConfirmation(
          descMatches,
          config.apiUrl,
        );
        if (!confirmed) {
          cancel("Cancelled — sensitive data detected");
          return;
        }
      }
      lastScannedDescription = description;
    }

    // -- GENERATE (errors are recoverable) --
    let result: GenerateResult;
    try {
      result = await generateCommit(model, prompt, modelName, config);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Non-interactive modes (--accept/--json/--print) must fail closed: never
      // prompt (no TTY in CI) and never exit 0 on a generation failure. In machine
      // mode this leaves stdout empty, so a consumer sees a nonzero exit and no
      // half-formed payload. Same contract as the validation/secret gates.
      if (nonInteractive) {
        cancel(`Generation failed — ${errMsg}`);
        process.exit(1);
      }
      note(errMsg, "Generation failed");
      const retryChoice = await confirm({
        message: "Retry?",
        initialValue: true,
      });
      if (isCancel(retryChoice) || !retryChoice) {
        cancel("Cancelled");
        return;
      }
      try {
        context = await getStagedContext(config, recentCommits);
      } catch {
        // keep existing context if refresh fails
      }
      continue;
    }

    // -- TOKEN USAGE --
    const cost = calculateCost(result.inputTokens, result.outputTokens, config);
    const totalTokens = result.inputTokens + result.outputTokens;
    const timeDisplay =
      result.durationMs > 60_000
        ? `${(result.durationMs / 60_000).toFixed(2)}m`
        : `${(result.durationMs / 1000).toFixed(2)}s`;
    const tokenLabel = result.tokensFromApi
      ? pc.dim("[API]")
      : pc.yellow("[Estimated]");
    const costLabel =
      !result.tokensFromApi && cost.totalCost > 0
        ? pc.yellow(" [Estimated]")
        : "";

    const tokenStr = `${formatTokenCount(result.inputTokens)} in + ${formatTokenCount(result.outputTokens)} out = ${formatTokenCount(totalTokens)} total`;
    console.log(pc.dim("\n  Tokens  ") + pc.dim(`${tokenStr}  `) + tokenLabel);
    console.log(pc.dim("  Time    ") + timeDisplay);
    const costDisplay =
      cost.totalCost === 0 && isLocalMode(config)
        ? pc.green("✨ Free (local & private)")
        : cost.totalCost === 0
          ? pc.dim("Free")
          : cost.formattedCost + costLabel;
    console.log(pc.dim("  Cost    ") + costDisplay);

    if (result.wasTruncated) {
      console.log(
        pc.yellow(
          "\nIncomplete output — the model stream was interrupted; review the message carefully before committing.",
        ),
      );
    }
    if (result.validation.warnings.length > 0) {
      console.log(pc.yellow("\nWarnings"));
      result.validation.warnings.forEach((w) => console.log("  • " + w));
    }
    if (result.validation.isValid) {
      console.log(pc.green("\nFormat validation passed"));
    } else {
      console.log(pc.red("\nFormat validation failed"));
      result.validation.errors.forEach((e) => console.log("  • " + e));
    }

    console.log();

    // -- AUTO-ACCEPT (--accept flag for CI / automation) --
    if (nonInteractive) {
      const gate = evaluateAutoAcceptGate(result);

      if (machineOutput) {
        // Commit only when --accept is combined AND the auto-accept gate passes —
        // never commit a message that plain --accept would have blocked. Commit
        // first so the payload (with `committed`) is the last thing on stdout.
        const committed = config.accept && gate.ok && !config.dryRun;
        if (config.accept && gate.ok) {
          await commitOrDryRun(result.message, config, modelName);
        }

        const payload = config.json
          ? JSON.stringify(
              buildMachinePayload(result, context, cost, config, modelName, committed),
            ) + "\n"
          : result.message + "\n";

        // Exit from the flush callback: stdout is async when piped, so a bare
        // process.exit() here would truncate the payload. Exit 0 only when the
        // message is valid, so `convit --json && …` is safe.
        emitMachine(payload, () => process.exit(gate.ok ? 0 : 1));
        return;
      }

      // Plain --accept (human chrome, no machine output): block on invalid.
      if (!gate.ok) {
        cancel(gate.reason);
        process.exit(gate.code);
      }
      await commitOrDryRun(result.message, config, modelName);
      return;
    }

    // -- MAX RETRIES GATE --
    if (state.attemptCount + 1 >= MAX_RETRY_ATTEMPTS) {
      note(
        `Maximum attempts reached (${MAX_RETRY_ATTEMPTS}/${MAX_RETRY_ATTEMPTS})`,
        "Warning",
      );
      const maxChoice = await select({
        message: "Choose an action",
        options: [
          {
            value: "accept" as const,
            label: "Accept and commit",
            hint: "Creates the git commit",
          },
          {
            value: "edit" as const,
            label: "Edit message",
            hint: "Refine with feedback",
          },
          {
            value: "cancel" as const,
            label: "Cancel",
            hint: "Exit without committing",
          },
        ],
      });
      if (isCancel(maxChoice) || maxChoice === "cancel") {
        cancel("Cancelled");
        return;
      }
      if (maxChoice === "accept") {
        await commitOrDryRun(result.message, config, modelName);
        return;
      }
      // edit
      const feedbackResult = await text({
        message: "What would you like to change?",
      });
      if (isCancel(feedbackResult) || !feedbackResult.trim()) {
        note("No feedback provided", "Warning");
        continue;
      }
      state.userDescription = feedbackResult;
      state.previousOutput = result.message;
      state.mode = "edit";
      console.log(pc.cyan("\nRefining message...\n"));
      continue;
    }

    const choice = await select({
      message: "Commit these changes?",
      options: [
        {
          value: "accept" as const,
          label: "Yes, commit",
          hint: "Creates the git commit",
        },
        {
          value: "regenerate" as const,
          label: "Regenerate",
          hint: "Try a different message",
        },
        {
          value: "edit" as const,
          label: "Edit message",
          hint: "Refine with feedback",
        },
        {
          value: "cancel" as const,
          label: "Cancel",
          hint: "Exit without committing",
        },
      ],
    });

    if (isCancel(choice) || choice === "cancel") {
      cancel("Cancelled");
      return;
    }
    if (choice === "accept") {
      await commitOrDryRun(result.message, config, modelName);
      return;
    }
    if (choice === "regenerate") {
      state.previousOutput = result.message;
      state.previousValidation = result.validation.isValid
        ? null
        : result.validation;
      state.mode = "regenerate";
      state.attemptCount++;
      const retryMsg = result.validation.isValid
        ? "Generating alternative..."
        : "Applying corrections...";
      console.log(pc.cyan(`\n${retryMsg}\n`));
      try {
        context = await getStagedContext(config, recentCommits);
      } catch {
        // keep existing context
      }
      continue;
    }
    // edit
    const feedbackResult = await text({
      message: "What would you like to change?",
    });
    if (isCancel(feedbackResult) || !feedbackResult.trim()) {
      note("No feedback provided", "Warning");
      continue;
    }
    state.userDescription = feedbackResult;
    state.previousOutput = result.message;
    state.mode = "edit";
    console.log(pc.cyan("\nRefining message...\n"));
  }
}
