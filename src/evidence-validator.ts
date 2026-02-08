// Evidence Validator — validates that every EvaluationItem's evidence_quote
// is grounded in the actual transcript text.
//
// Validation algorithm (from design doc, Property 7):
//   1. Normalize quote and transcript (lowercase, strip punctuation, collapse whitespace, trim).
//   2. Tokenize both into arrays of tokens.
//   3. Contiguous match: quote tokens must appear as a contiguous subsequence
//      in the transcript tokens with at least 6 consecutive matching tokens.
//   4. Timestamp locality (±20 s):
//      - Word-level: |evidence_timestamp − start_time_of_first_matched_word| ≤ 20.
//      - Segment-level fallback: matched tokens fall within a segment whose
//        [startTime, endTime] overlaps [evidence_timestamp − 20, evidence_timestamp + 20].
//   5. Length: quote must contain at most 15 tokens.
//
// Requirements: 4.3, 4.6

import type {
  EvaluationItem,
  StructuredEvaluation,
  TranscriptSegment,
  TranscriptWord,
} from "./types.js";

// ─── Public result type ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

// ─── EvidenceValidator ──────────────────────────────────────────────────────────

export class EvidenceValidator {
  // ── Text helpers ────────────────────────────────────────────────────────────

  /**
   * Normalize text for matching:
   *  1. Lowercase
   *  2. Strip all punctuation (keep only alphanumeric and whitespace)
   *  3. Collapse consecutive whitespace to a single space
   *  4. Trim leading/trailing whitespace
   */
  normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Tokenize normalized text into an array of tokens.
   * A "token" is a contiguous sequence of non-whitespace characters.
   */
  tokenize(text: string): string[] {
    const normalized = this.normalize(text);
    if (normalized.length === 0) return [];
    return normalized.split(" ");
  }

  // ── Contiguous match ───────────────────────────────────────────────────────

  /**
   * Find the first position where `quoteTokens` appear as a contiguous
   * subsequence inside `transcriptTokens`.
   *
   * Returns `{ found: true, matchIndex }` when at least 6 consecutive tokens
   * match, or `{ found: false, matchIndex: -1 }` otherwise.
   *
   * `matchIndex` is the index into `transcriptTokens` where the match starts.
   */
  findContiguousMatch(
    quoteTokens: string[],
    transcriptTokens: string[],
  ): { found: boolean; matchIndex: number } {
    if (quoteTokens.length < 6) {
      return { found: false, matchIndex: -1 };
    }

    const qLen = quoteTokens.length;
    const tLen = transcriptTokens.length;

    for (let i = 0; i <= tLen - qLen; i++) {
      let matched = true;
      for (let j = 0; j < qLen; j++) {
        if (transcriptTokens[i + j] !== quoteTokens[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { found: true, matchIndex: i };
      }
    }

    return { found: false, matchIndex: -1 };
  }

  // ── Timestamp locality ─────────────────────────────────────────────────────

  /**
   * Check whether the evidence_timestamp is within ±20 s of the matched
   * position in the transcript.
   *
   * Strategy:
   *  1. Build a flat list of all words (with timestamps) across all segments.
   *  2. If word-level timestamps are available (words array is non-empty and
   *     words have meaningful timestamps), use the start time of the word at
   *     `matchIndex` in the flattened list.
   *  3. Otherwise fall back to segment-level: find the segment that contains
   *     the matched token position and check whether its time range overlaps
   *     with [evidence_timestamp − 20, evidence_timestamp + 20].
   */
  checkTimestampLocality(
    evidenceTimestamp: number,
    matchIndex: number,
    segments: TranscriptSegment[],
  ): boolean {
    const TOLERANCE = 20; // seconds

    // Attempt word-level check first
    const allWords = this.flattenWords(segments);
    if (allWords.length > 0 && matchIndex < allWords.length) {
      const matchedWord = allWords[matchIndex];
      return Math.abs(evidenceTimestamp - matchedWord.startTime) <= TOLERANCE;
    }

    // Segment-level fallback: map matchIndex to a segment
    const segment = this.segmentForTokenIndex(matchIndex, segments);
    if (!segment) return false;

    const windowStart = evidenceTimestamp - TOLERANCE;
    const windowEnd = evidenceTimestamp + TOLERANCE;

    // Overlap check: segment range [startTime, endTime] overlaps [windowStart, windowEnd]
    return segment.startTime <= windowEnd && segment.endTime >= windowStart;
  }

  // ── Main validation entry point ────────────────────────────────────────────

  /**
   * Validate every `EvaluationItem` in a `StructuredEvaluation` against the
   * provided transcript segments.
   *
   * Returns `{ valid: true, issues: [] }` when all items pass, or
   * `{ valid: false, issues: [...] }` with human-readable descriptions of
   * each failure.
   */
  validate(
    evaluation: StructuredEvaluation,
    transcriptSegments: TranscriptSegment[],
  ): ValidationResult {
    const issues: string[] = [];

    // Build the full transcript text from segments
    const fullText = transcriptSegments.map((s) => s.text).join(" ");
    const transcriptTokens = this.tokenize(fullText);

    for (const item of evaluation.items) {
      const itemIssues = this.validateItem(
        item,
        transcriptTokens,
        transcriptSegments,
      );
      issues.push(...itemIssues);
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  // ── Per-item validation ────────────────────────────────────────────────────

  /**
   * Validate a single EvaluationItem. Returns an array of issue strings
   * (empty if the item passes all checks).
   */
  validateItem(
    item: EvaluationItem,
    transcriptTokens: string[],
    segments: TranscriptSegment[],
  ): string[] {
    const issues: string[] = [];
    const quoteTokens = this.tokenize(item.evidence_quote);

    // Check 1: Length — at most 15 tokens
    if (quoteTokens.length > 15) {
      issues.push(
        `[${item.type}] "${item.summary}": evidence quote exceeds 15-token limit (${quoteTokens.length} tokens).`,
      );
    }

    // Check 2: Contiguous match — ≥ 6 consecutive tokens
    if (quoteTokens.length < 6) {
      issues.push(
        `[${item.type}] "${item.summary}": evidence quote has fewer than 6 tokens (${quoteTokens.length} tokens).`,
      );
      return issues; // cannot proceed to timestamp check without a match
    }

    const { found, matchIndex } = this.findContiguousMatch(
      quoteTokens,
      transcriptTokens,
    );

    if (!found) {
      issues.push(
        `[${item.type}] "${item.summary}": evidence quote not found as contiguous match in transcript.`,
      );
      return issues; // cannot check timestamp without a match position
    }

    // Check 3: Timestamp locality — ±20 s
    const localityOk = this.checkTimestampLocality(
      item.evidence_timestamp,
      matchIndex,
      segments,
    );

    if (!localityOk) {
      issues.push(
        `[${item.type}] "${item.summary}": evidence timestamp (${item.evidence_timestamp}s) is not within ±20s of the matched position in the transcript.`,
      );
    }

    return issues;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Flatten all words from all segments into a single ordered array.
   * Returns an empty array if segments have no word-level data.
   */
  private flattenWords(segments: TranscriptSegment[]): TranscriptWord[] {
    const words: TranscriptWord[] = [];
    for (const seg of segments) {
      if (seg.words && seg.words.length > 0) {
        words.push(...seg.words);
      }
    }
    return words;
  }

  /**
   * Given a token index into the full-transcript token array (built by
   * joining all segment texts), find the segment that contains that token.
   *
   * This is used for the segment-level timestamp fallback when word-level
   * timestamps are not available.
   */
  private segmentForTokenIndex(
    tokenIndex: number,
    segments: TranscriptSegment[],
  ): TranscriptSegment | null {
    let cumulativeTokens = 0;

    for (const seg of segments) {
      const segTokens = this.tokenize(seg.text);
      if (tokenIndex < cumulativeTokens + segTokens.length) {
        return seg;
      }
      cumulativeTokens += segTokens.length;
    }

    return null;
  }
}
