// =============================================================================
// Auto-Accept Gates
// =============================================================================
//
// Pure decision helpers for the non-interactive `--accept` flow. CLAUDE.md
// promises `--accept` commits the "first valid message; any sensitive match is
// a hard block." These functions encode that contract so it can be unit-tested
// without driving the interactive state machine or stubbing process.exit.
// =============================================================================

import type { GenerateResult, SensitiveDataMatch } from "../types";

/** A gate decision: proceed, or block with a reason and exit code. */
export type AcceptDecision =
  | { ok: true }
  | { ok: false; reason: string; code: number };

/**
 * Pre-generation gate. In `--accept` mode any sensitive match is a hard block
 * (no network call, non-zero exit). Outside `--accept` the interactive confirm
 * prompt owns the decision, so this returns `ok` and the caller prompts.
 */
export function evaluateSensitiveAcceptGate(
  accept: boolean,
  matches: SensitiveDataMatch[],
): AcceptDecision {
  if (accept && matches.length > 0) {
    return {
      ok: false,
      reason: "Cancelled — sensitive data detected. Remove --accept to confirm.",
      code: 1,
    };
  }
  return { ok: true };
}

/**
 * Post-generation gate. In `--accept` mode, refuse to commit a message that was
 * truncated (incomplete stream) or that failed validation. Truncation is
 * checked first because a truncated message is usually also invalid, and the
 * truncation reason is the more specific, more useful diagnosis.
 */
export function evaluateAutoAcceptGate(
  result: Pick<GenerateResult, "validation" | "wasTruncated">,
): AcceptDecision {
  if (result.wasTruncated) {
    return {
      ok: false,
      reason:
        "Cancelled — generated message was truncated (incomplete stream). Not auto-committing.",
      code: 1,
    };
  }
  if (!result.validation.isValid) {
    return {
      ok: false,
      reason:
        "Cancelled — generated message failed validation. Not auto-committing.",
      code: 1,
    };
  }
  return { ok: true };
}

/** One option for the `--candidates` picker: its index plus display strings. */
export interface CandidateOption {
  value: number;
  label: string;
  hint: string;
}

/**
 * Index of the candidate to auto-select in non-interactive `--candidates` mode:
 * the first that passes {@link evaluateAutoAcceptGate} (the same gate the commit
 * then faces, so a winnable batch isn't failed by an earlier truncated/invalid
 * candidate). Falls back to the first candidate when none pass — the gate will
 * still block the commit, but the choice is deterministic.
 */
export function pickAcceptableCandidate(results: GenerateResult[]): number {
  const idx = results.findIndex((r) => evaluateAutoAcceptGate(r).ok);
  return idx >= 0 ? idx : 0;
}

/**
 * Shapes generated candidates into clack `select` options (pure, so the picker's
 * data can be unit-tested while the `select` call stays thin glue). The label is
 * the subject line; the hint surfaces the temperature and any validity/truncation
 * caveat so the user can weigh a looser candidate against a flagged one.
 */
export function buildCandidateOptions(
  results: GenerateResult[],
): CandidateOption[] {
  return results.map((r, i) => {
    const caveats = [
      r.validation.isValid ? null : "invalid format",
      r.wasTruncated ? "truncated" : null,
    ].filter(Boolean);
    const hint = [`temp ${r.temperature}`, ...caveats].join(" · ");
    return { value: i, label: r.message.split("\n")[0], hint };
  });
}
