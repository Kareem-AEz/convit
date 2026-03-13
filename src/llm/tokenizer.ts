// =============================================================================
// Token Counting
// =============================================================================
//
// Uses js-tiktoken for accurate token counts that match OpenAI-compatible APIs.
// Falls back to char-based estimation when the model is unknown or tiktoken fails.
// =============================================================================

import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";

type EncodingName =
  | "gpt2"
  | "r50k_base"
  | "p50k_base"
  | "p50k_edit"
  | "cl100k_base"
  | "o200k_base";

let cachedEncoder: Tiktoken | null = null;
let cachedEncoding: EncodingName | null = null;

/**
 * Infers the tiktoken encoding for a model name.
 * - gpt-4o, o1, o3, grok-4, gpt-4.1+ → o200k_base
 * - gpt-4, gpt-3.5, most API-compatible → cl100k_base
 * - LM Studio / unknown → cl100k_base (common default)
 */
function inferEncoding(modelName: string | undefined): EncodingName {
  if (!modelName) return "cl100k_base";
  const lower = modelName.toLowerCase();
  if (
    lower.includes("gpt-4o") ||
    lower.includes("o1") ||
    lower.includes("o3") ||
    lower.includes("o4") ||
    lower.includes("gpt-4.1") ||
    lower.includes("gpt-4.5") ||
    lower.includes("gpt-5") ||
    lower.includes("grok-4")
  ) {
    return "o200k_base";
  }
  return "cl100k_base";
}

/**
 * Returns a tiktoken encoder, using cache when the encoding matches.
 */
function getEncoder(encoding: EncodingName): Tiktoken | null {
  if (cachedEncoder && cachedEncoding === encoding) return cachedEncoder;
  try {
    cachedEncoder = getEncoding(encoding);
    cachedEncoding = encoding;
    return cachedEncoder;
  } catch {
    return null;
  }
}

/**
 * Counts tokens for a string using the appropriate encoding.
 */
function countWithEncoder(encoder: Tiktoken, text: string): number {
  try {
    return encoder.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Overhead for OpenAI chat format: ~3 tokens per message + 3 for assistant priming.
 * GPT-3.5 uses 4 per message; newer models use 3.
 */
const CHAT_OVERHEAD_PER_MESSAGE = 3;
const CHAT_OVERHEAD_ASSISTANT_PRIMING = 3;

/**
 * Estimates input tokens for a chat prompt (system + user messages).
 *
 * Uses js-tiktoken when the model is known or inferable; falls back to
 * char/4 estimation if tiktoken fails. Includes chat format overhead.
 */
export function estimateInputTokens(
  systemMessage: string,
  userMessage: string,
  modelName?: string,
): number {
  const encoding = inferEncoding(modelName);
  const encoder = getEncoder(encoding);

  if (encoder) {
    const systemTokens = countWithEncoder(encoder, systemMessage);
    const userTokens = countWithEncoder(encoder, userMessage);
    const overhead =
      CHAT_OVERHEAD_PER_MESSAGE * 2 + CHAT_OVERHEAD_ASSISTANT_PRIMING;
    return systemTokens + userTokens + overhead;
  }

  const totalChars = systemMessage.length + userMessage.length;
  return (
    Math.ceil(totalChars / 4) +
    CHAT_OVERHEAD_PER_MESSAGE * 2 +
    CHAT_OVERHEAD_ASSISTANT_PRIMING
  );
}
