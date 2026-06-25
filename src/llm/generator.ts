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

import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  streamText,
  type LanguageModel,
} from "ai";
import { BRAILLE_SPINNER_FRAMES, pc, spinner } from "../cli/ui";
import { validateCommitMessage } from "../core/validator";
import { COMMIT_TYPES, HEADER_RE } from "../types";
import type { BuiltPrompt, Config, GenerateResult } from "../types";

/** The validated shape the model returns in structured mode. */
interface StructuredCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
  body: string[];
}

/**
 * Conventional-commit JSON Schema for structured generation. Field descriptions
 * carry the content/tone rules (the same ones in the prompt) so the model fills
 * each field correctly; structural rules (the `type(scope): subject` shape) are
 * enforced by the schema itself, not regex-cleaned out of free text afterward.
 */
const COMMIT_SCHEMA = jsonSchema<StructuredCommit>({
  type: "object",
  additionalProperties: false,
  required: ["type", "scope", "breaking", "subject", "body"],
  properties: {
    type: {
      type: "string",
      enum: [...COMMIT_TYPES],
      description: "The conventional-commit type that best fits the change.",
    },
    scope: {
      type: ["string", "null"],
      description:
        "A short, lowercase scope naming the area changed (no spaces), or null if none clearly applies.",
    },
    breaking: {
      type: "boolean",
      description: "True only when the change breaks backward compatibility.",
    },
    subject: {
      type: "string",
      description:
        "Imperative, lowercase, no trailing period, ≤50 chars. States what changed.",
    },
    body: {
      type: "array",
      items: { type: "string" },
      description:
        "One or more concise bullets (no leading dash), each ≤72 chars, favoring why over what.",
    },
  },
});

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
 *   Find the first line matching a conventional-commit header (`HEADER_RE`),
 *   then keep that line and everything after it verbatim — prose bodies and
 *   footers (`BREAKING CHANGE:`, `Co-authored-by:`, etc.) are preserved. Only a
 *   preamble before the header and trailing blank lines are dropped.
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
  const startIdx = lines.findIndex((line) => HEADER_RE.test(line.trim()));

  if (startIdx >= 0) {
    const body = lines.slice(startIdx);
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    message = body.join("\n").trim();
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
 * Appends configured footer trailers below the (already cleaned) commit body,
 * after a blank line, just before `git commit`. The `{model}` placeholder
 * expands to the resolved model id for opt-in provenance.
 *
 * Runs *after* the generate/edit loop so trailers are never fed back to the
 * model or stacked on a regenerate — `commitOrDryRun` is the single choke point.
 * Empty/whitespace-only entries are dropped; an empty trailer list is a no-op.
 *
 * Note: trailers are appended as their own blank-line-separated paragraph, so if
 * the body already ends in a footer block (e.g. `BREAKING CHANGE:`) git sees two
 * trailer paragraphs. convit bodies don't emit footers today; revisit if they do.
 */
export function appendTrailers(
  message: string,
  trailers: string[],
  model?: string,
): string {
  const expanded = trailers
    .map((t) => t.replace(/\{model\}/g, model ?? "unknown").trim())
    .filter(Boolean);
  if (expanded.length === 0) return message;
  return `${message.trimEnd()}\n\n${expanded.join("\n")}`;
}

/**
 * Converts raw API errors into human-readable, actionable error messages.
 *
 * Three recognized error patterns:
 * - AbortError / TimeoutError / timeout → model too slow or wrong model name
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

  // `AbortSignal.timeout()` rejects with a `TimeoutError`, not an `AbortError`,
  // so match both names (plus a "timeout" message fallback for other providers).
  if (
    errorName === "AbortError" ||
    errorName === "TimeoutError" ||
    errorMessage.includes("timeout")
  ) {
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
 * A structured result that can't be turned into a usable commit message (e.g. an
 * empty subject). Signals `generateCommit` to fall back to free-text rather than
 * hard-fail the commit — the endpoint works, the model just returned junk.
 */
class UnusableStructuredOutput extends Error {}

/**
 * Assembles a structured commit object into the canonical message string.
 *
 * The result must satisfy `HEADER_RE`/`validateCommitMessage`, so this is where
 * subtle format bugs hide (missing blank line, `!` placement, an out-of-grammar
 * scope). The scope is lowercased and sanitized to the header grammar — dropped
 * if it can't be made valid — and an empty type/subject is a generation failure.
 */
export function assembleCommitMessage(output: StructuredCommit): string {
  const type = output.type.trim();
  const subject = output.subject.trim();
  if (!type || !subject) {
    throw new UnusableStructuredOutput(
      "Structured output missing a type or subject.",
    );
  }

  const rawScope = (output.scope ?? "").trim().toLowerCase();
  const scope = /^[a-z0-9-]+$/.test(rawScope) ? rawScope : "";
  const breaking = output.breaking ? "!" : "";
  const header = `${type}${scope ? `(${scope})` : ""}${breaking}: ${subject}`;

  const bullets = (output.body ?? [])
    .map((b) => b.trim().replace(/^[-*]\s*/, "")) // strip any leading marker
    .filter(Boolean)
    .map((b) => `- ${b}`);

  return bullets.length > 0 ? `${header}\n\n${bullets.join("\n")}` : header;
}

/**
 * True when a structured-generation error should drop to the free-text path:
 * the endpoint can't do schema-constrained output (rejects `response_format`),
 * the model returned no parseable object, or the object was unusable. Other
 * errors (timeout, network) propagate to the caller's recoverable handler.
 */
export function shouldFallbackToFreeText(err: unknown): boolean {
  if (err instanceof UnusableStructuredOutput) return true;
  if (NoObjectGeneratedError.isInstance(err)) return true;
  if (APICallError.isInstance(err)) {
    const haystack = `${err.message} ${String(err.responseBody ?? "")}`;
    // Targeted to structured-output rejections — a bare `schema` would match
    // unrelated 400s and silently mask a real error. The real gateway rejection
    // matched on `response_format` (verified), so precise terms suffice.
    return (
      err.statusCode === 400 &&
      /response_format|json[_-]?schema|structured output|not support/i.test(
        haystack,
      )
    );
  }
  return false;
}

/**
 * Schema-constrained generation: the model returns a validated
 * `{type, scope, subject, body}` object, which is assembled into the message.
 * No regex cleanup — the structure is guaranteed by the schema. Throws on an
 * unsupported endpoint (caught by `generateCommit`, which then falls back).
 */
async function generateStructured(
  model: LanguageModel,
  prompt: BuiltPrompt,
  config: Config,
): Promise<GenerateResult> {
  const startTime = Date.now();
  const spin = spinner({ frames: BRAILLE_SPINNER_FRAMES, delay: 80 });
  spin.start("Generating");
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    spin.message(`Generating · ${elapsed}s`);
  }, 1000);

  let output: StructuredCommit;
  let usageData;
  try {
    const gen = await generateText({
      model,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      temperature: prompt.temperature,
      output: Output.object({ schema: COMMIT_SCHEMA }),
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    });
    output = gen.output;
    usageData = gen.usage;
  } finally {
    clearInterval(timer);
    spin.stop();
  }

  const message = assembleCommitMessage(output);
  console.log("\n" + pc.dim("─".repeat(60)));
  console.log(pc.bold(message));
  console.log("\n" + pc.dim("─".repeat(60)));

  const validation = validateCommitMessage(message, config);
  const tokensFromApi = !!usageData && (usageData.totalTokens ?? 0) > 0;

  return {
    message,
    validation,
    inputTokens: tokensFromApi
      ? (usageData.inputTokens ?? 0)
      : prompt.estimatedInputTokens,
    outputTokens: tokensFromApi
      ? (usageData.outputTokens ?? 0)
      : Math.ceil(message.length / 4),
    durationMs: Date.now() - startTime,
    tokensFromApi,
    wasTruncated: false,
  };
}

/**
 * Generates a commit message, preferring schema-constrained output when enabled
 * (`config.structured`, the default). If the structured attempt can't yield a
 * usable message — unsupported endpoint, unparseable, or empty fields — it falls
 * back to the free-text path. Any other error (timeout, network) is reformatted
 * through `formatApiError` so the caller surfaces the same actionable guidance
 * the free-text path gives.
 */
export async function generateCommit(
  model: LanguageModel,
  prompt: BuiltPrompt,
  modelName: string,
  config: Config,
): Promise<GenerateResult> {
  if (config.structured) {
    try {
      return await generateStructured(model, prompt, config);
    } catch (err) {
      if (shouldFallbackToFreeText(err)) {
        console.log(
          pc.dim("\nCouldn't use structured output — using free-text."),
        );
        return generateFreeText(model, prompt, modelName, config);
      }
      throw new Error(formatApiError(err, modelName, config.timeoutMs / 1000));
    }
  }
  return generateFreeText(model, prompt, modelName, config);
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
async function generateFreeText(
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
  let wasTruncated = false;

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
        formatApiError(err, modelName, config.timeoutMs / 1000, elapsedSeconds),
      );
    }
    wasTruncated = true;
    console.log(pc.yellow("\nStream interrupted, but content received."));
  }

  if (firstChunk) {
    clearInterval(timer);
    spin.stop();
  }

  console.log("\n" + pc.dim("─".repeat(60)));

  // `result.usage` can reject when the stream was interrupted (the same failure
  // that salvaged `rawMessage` above). Guard it so a usage rejection doesn't
  // discard the recovered message — fall back to a length/4 token estimate.
  let usageData: Awaited<typeof result.usage> | undefined;
  try {
    usageData = await result.usage;
  } catch {
    usageData = undefined;
  }
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
    wasTruncated,
  };
}
