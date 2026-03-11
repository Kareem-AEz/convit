// =============================================================================
// LLM Generator
// =============================================================================
//
// The streaming interface to the AI model. Handles:
// - Live output display as chunks arrive
// - Partial stream recovery (if connection drops mid-generation)
// - Token counting (API-reported or estimated fallback)
// - Raw output cleaning (code blocks, quotes, preamble stripping)
// =============================================================================

import { type LanguageModel, streamText } from "ai";
import { BRAILLE_SPINNER_FRAMES, pc, spinner } from "../cli/ui";
import { validateCommitMessage } from "../core/validator";
import type { BuiltPrompt, Config, GenerateResult } from "../types";

/**
 * Cleans raw AI output into a valid, well-formatted commit message.
 *
 * Multi-pass cleaning pipeline:
 *
 * Pass 1 — Code block stripping:
 *   Some models wrap their output in ```...``` blocks despite being told not to.
 *
 * Pass 2 — Quote stripping:
 *   Some models wrap output in `"..."` or `'...'` quotes.
 *
 * Pass 3 — Conventional commit header extraction:
 *   Find the first line matching `[a-z]+(` pattern. Then collect: the header
 *   line → blank lines → bullet lines → stop at the first non-blank, non-bullet
 *   line after bullets have started. This strips any preamble or postamble.
 *
 * Pass 4 — Blank line enforcement:
 *   Git's commit format requires an empty line between the subject and body.
 */
export function cleanCommitMessage(raw: string): string {
  let message = raw.trim();

  const codeBlockMatch = message.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (codeBlockMatch) message = codeBlockMatch[1].trim();

  for (const quote of ['"', "'", "`"]) {
    if (message.startsWith(quote) && message.endsWith(quote)) {
      message = message.slice(1, -1).trim();
    }
  }

  const lines = message.split("\n");
  const startIdx = lines.findIndex((line) => /^[a-z]+\(/.test(line.trim()));

  if (startIdx >= 0) {
    const validLines = [lines[startIdx]];
    let foundBullets = false;

    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        validLines.push(lines[i]);
        continue;
      }
      if (line.startsWith("-")) {
        validLines.push(lines[i]);
        foundBullets = true;
        continue;
      }
      if (foundBullets) break;
    }
    message = validLines.join("\n").trim();
  }

  // Ensure blank line between subject and body
  const finalLines = message.split("\n");
  if (finalLines.length > 1 && finalLines[1].trim() !== "") {
    finalLines.splice(1, 0, "");
    message = finalLines.join("\n");
  }

  return message;
}

/**
 * Converts raw API errors into human-readable, actionable error messages.
 *
 * Three recognized error patterns:
 * - AbortError / timeout → model too slow or wrong model name
 * - 404 + generativelanguage → Gemini URL missing `/openai` suffix
 * - ECONNREFUSED / connect → LM Studio not running or wrong URL
 */
export function formatApiError(
  err: unknown,
  modelName: string,
  timeoutSeconds?: number,
  elapsedSeconds?: number,
): string {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorName = err instanceof Error ? err.name : "UnknownError";

  if (errorName === "AbortError" || errorMessage.includes("timeout")) {
    const limit = timeoutSeconds ?? 60;
    const elapsed =
      elapsedSeconds !== undefined
        ? ` (ran ${elapsedSeconds.toFixed(1)}s before abort)`
        : "";
    return (
      `Request timed out after ${limit} seconds${elapsed}.\n\n` +
      `Possible causes:\n` +
      `1. Model is too slow or unresponsive\n` +
      `2. Invalid model name — check CONVIT_MODEL in .env\n` +
      `3. API server is overloaded\n\n` +
      `Current model: ${modelName}\n` +
      `Try a faster model or check your API configuration.`
    );
  }

  if (
    errorMessage.includes("404") &&
    errorMessage.includes("generativelanguage")
  ) {
    return (
      "Google Gemini API Error: 404 Not Found.\n" +
      "Ensure CONVIT_URL ends with '/openai' and CONVIT_MODEL is a valid Gemini model (e.g. gemini-1.5-flash)."
    );
  }

  if (
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("connect")
  ) {
    return (
      `Cannot connect to API.\n\n` +
      `If using LM Studio:\n` +
      `1. Open LM Studio and start the Local Server\n` +
      `2. Ensure a model is loaded\n\n` +
      `If using an External API:\n` +
      `1. Check CONVIT_URL in .env\n` +
      `2. Check your internet connection`
    );
  }

  return errorMessage;
}

/**
 * Streams a commit message from the AI model and returns the cleaned, validated result.
 *
 * Streaming design:
 * The spinner runs until the first text chunk arrives, then stops and prints a
 * separator line. Chunks are written directly to stdout as they arrive.
 *
 * Error handling:
 * - If the stream errors AFTER content was received, the existing content is
 *   used with a warning (handles flaky local models).
 * - If the stream errors BEFORE any content was received, the error is re-thrown.
 *
 * Token counting:
 * Uses API-reported usage when available, falls back to length/4 estimation.
 */
export async function generateCommit(
  model: LanguageModel,
  prompt: BuiltPrompt,
  modelName: string,
  config: Config,
): Promise<GenerateResult> {
  const startTime = Date.now();
  let rawMessage = "";
  let inputTokens = prompt.estimatedInputTokens;
  let outputTokens = 0;
  let tokensFromApi = false;

  const result = streamText({
    model,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    temperature: prompt.temperature,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
    providerOptions: {},
  });

  const spin = spinner({
    frames: BRAILLE_SPINNER_FRAMES,
    delay: 80,
  });
  let firstChunk = true;

  spin.start("Generating");

  const timer = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    spin.message(`Generating · ${elapsed}s`);
  }, 1000);

  try {
    for await (const chunk of result.textStream) {
      if (firstChunk) {
        clearInterval(timer);
        spin.stop();
        console.log("\n" + pc.dim("─".repeat(60)));
        firstChunk = false;
      }
      process.stdout.write(pc.bold(chunk));
      rawMessage += chunk;
    }
  } catch (err) {
    clearInterval(timer);
    spin.stop();
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (rawMessage.trim().length === 0) {
      throw new Error(
        formatApiError(
          err,
          modelName,
          config.timeoutMs / 1000,
          elapsedSeconds,
        ),
      );
    }
    console.log(pc.yellow("\nStream interrupted, but content received."));
  }

  if (firstChunk) {
    clearInterval(timer);
    spin.stop();
  }

  console.log("\n" + pc.dim("─".repeat(60)));

  const usageData = await result.usage;
  if (usageData && (usageData.totalTokens ?? 0) > 0) {
    inputTokens = usageData.inputTokens ?? 0;
    outputTokens = usageData.outputTokens ?? 0;
    tokensFromApi = true;
  } else {
    outputTokens = Math.ceil(rawMessage.length / 4);
  }

  const message = cleanCommitMessage(rawMessage);
  const validation = validateCommitMessage(message, config);
  const durationMs = Date.now() - startTime;

  return {
    message,
    validation,
    inputTokens,
    outputTokens,
    durationMs,
    tokensFromApi,
  };
}
