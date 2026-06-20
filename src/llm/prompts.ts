// =============================================================================
// Prompt Builder
// =============================================================================
//
// Assembles the system + user prompt based on session state. This is a pure
// function that returns a BuiltPrompt — no I/O, no side effects.
// =============================================================================

import {
  MAX_BULLET_LENGTH,
  MAX_DIFF_LENGTH,
  MAX_SUBJECT_LENGTH,
  MIN_BULLETS,
  TEMPERATURE,
} from "../config/defaults";
import {
  buildRefinementPrompt,
  generateCorrectionHints,
  getRetryTemperature,
} from "../core/validator";
import { estimateInputTokens } from "./tokenizer";
import type {
  BuiltPrompt,
  Config,
  SessionState,
  StagedContext,
} from "../types";
import { COMMIT_TYPES } from "../types";

/**
 * Assembles the complete system + user prompt based on the current session state.
 *
 * Mode-based branching (SessionState.mode):
 *
 * "normal":
 *   Standard first-generation. If the user provided a description, it is
 *   injected into the user message as the highest-priority context block.
 *
 * "regenerate" + invalid previous output:
 *   Targeted correction mode. Calls `generateCorrectionHints` on the previous
 *   output to produce specific fix instructions.
 *
 * "regenerate" + valid previous output:
 *   Variety mode. A simple "generate a different version" note is appended.
 *
 * "edit":
 *   Human-in-the-loop refinement. The previous commit message AND the user's
 *   feedback are both included.
 *
 * Recent commits in the system message (not user message):
 *   Placing style context in the system message makes it a global constraint
 *   on the model's behavior, rather than an example in the context window.
 *
 * Token estimation:
 *   Uses js-tiktoken for model-aware counting when possible; falls back to
 *   char/4 estimation. The API returns the exact count post-generation.
 */
export function buildPrompt(
  context: StagedContext,
  state: SessionState,
  recentCommits: string,
  config: Config,
  initialCommit: boolean = false,
  modelName?: string,
): BuiltPrompt {
  const { processedDiff, classification, fileList, diffSummary } = context;

  const formattingOnlyFiles = diffSummary.files
    .filter((f) => f.formattingOnly)
    .map((f) => f.path);

  const rules = config.userConfig.rules ?? {};
  const maxSubject = rules.maxSubjectLength ?? MAX_SUBJECT_LENGTH;
  const maxBullet = rules.maxBulletLength ?? MAX_BULLET_LENGTH;
  const minBullets = rules.minBullets ?? MIN_BULLETS;

  const diffTruncated = processedDiff.length > MAX_DIFF_LENGTH;
  const diffPreview = diffTruncated
    ? processedDiff.slice(0, MAX_DIFF_LENGTH) + "\n[... diff truncated ...]"
    : processedDiff;

  const DIVIDER = "═".repeat(64);

  let systemMessage = `Write commit messages for a builder who cares about clean logic and smooth UI.

FORMAT: type(scope): subject

TYPES: ${COMMIT_TYPES.join(", ")}

RULES:
- Subject: lowercase, imperative, max ${maxSubject} chars, no period.
- Subject Tone: Direct and intentional. Avoid "update files" or "add code."
- Body: ${minBullets}+ bullets starting with "- ", max ${maxBullet} chars each.
- The "Why" Focus: Prioritize the reason for the change over the line of code.
- Precision: If it's a UI change, mention the feel (e.g., "buttery," "snappy," "layout shift").
- Technical Honesty: If it's a temporary fix, call it a "band-aid."

REFINED EXAMPLES:
feat(auth): harden the login loop against session rot

- tighten validation in use-auth to prevent flickering states
- add a 200ms delay to the loading state for perceived speed

fix(tickets): kill the ghost scroll in the sidebar

- adjust the layout-id in motion/react to prevent layout shift
- temporary band-aid for the z-index collision in mobile view

docs(readme): rewrite the vision for clarity

- strip out the corporate fluff and focus on the builder's intent

Output ONLY the commit message. No code blocks or chatter.`;

  if (initialCommit) {
    systemMessage += `

INITIAL COMMIT: This repo has no commits yet. You are creating the first commit.
- Use type: feat (new project) or chore (tooling/setup). Do NOT use fix — nothing is being fixed.
- Describe what the project IS and what it does. Not incremental changes.
- Scope: project name from package.json or directory, or omit. Not a module name like "config".
- Bullets: summarize the project's purpose, key features, and structure.`;
  } else if (recentCommits) {
    systemMessage += `\n\nRECENT COMMIT STYLE (match this tone and format):\n${recentCommits}`;
  }

  let userMessage = `Analyze the following git changes and create a commit message following the format rules.`;

  const needsCorrection =
    state.mode === "regenerate" &&
    state.previousOutput !== null &&
    state.previousValidation !== null &&
    !state.previousValidation.isValid;

  if (needsCorrection) {
    const corrections = generateCorrectionHints(state.previousOutput!, config);
    const refinementPrompt = buildRefinementPrompt(
      state.previousOutput!,
      corrections,
      state.attemptCount,
    );
    userMessage += `\n\n${refinementPrompt}`;
  } else if (state.mode === "edit" && state.previousOutput !== null) {
    userMessage += `\n\nPREVIOUSLY GENERATED COMMIT:\n${state.previousOutput}\n`;
    if (state.userDescription) {
      userMessage += `\nUSER FEEDBACK (Fix this):\n${state.userDescription}\n`;
    }
    userMessage += `\nRefine the PREVIOUSLY GENERATED COMMIT based on the USER FEEDBACK. Keep unchanged parts as-is.`;
  } else if (state.mode === "regenerate") {
    userMessage += `\n\nNote: Generate a different commit message with similar meaning but varied phrasing.`;
  } else {
    if (state.userDescription?.trim()) {
      userMessage += `
${DIVIDER}
USER'S DESCRIPTION (FOCUS ON THIS):
${DIVIDER}
${state.userDescription.trim()}

The user wants the commit message to focus on the changes described above.
Use this as the primary context and ensure your commit message reflects these points.
`;
    }
  }

  userMessage += `
${DIVIDER}
PRE-ANALYSIS HINTS:
${DIVIDER}
${
  initialCommit
    ? "Initial commit — describe the project as a whole. Ignore file-level type/scope hints."
    : `Based on file analysis, this appears to be a '${classification.type}' commit.
Suggested scope: ${classification.scope}
${classification.secondaryScopes.length > 0 ? `Also affects: ${classification.secondaryScopes.join(", ")}\n` : ""}
Use these hints to guide your commit message, but adjust if the actual changes suggest otherwise.`
}${
  formattingOnlyFiles.length > 0
    ? `\n\nFORMATTING-ONLY (whitespace/reformatting, no logic change — prefer 'style', don't describe re-added lines as new code):\n${formattingOnlyFiles.join("\n")}`
    : ""
}

${DIVIDER}
STAGED FILES:
${DIVIDER}
${fileList.join("\n")}

${DIVIDER}
DIFF TO ANALYZE:
${DIVIDER}
${diffPreview}

${DIVIDER}
Remember: Write about these ACTUAL changes, not the examples above. Keep bullets under ${maxBullet} characters!`;

  const baseTemp = rules.temperature ?? TEMPERATURE;
  const temperature =
    state.mode !== "normal"
      ? getRetryTemperature(state.attemptCount, baseTemp)
      : baseTemp;

  const estimatedInputTokens = estimateInputTokens(
    systemMessage,
    userMessage,
    modelName,
  );

  return {
    system: systemMessage,
    user: userMessage,
    temperature,
    estimatedInputTokens,
    diffTruncated,
  };
}
