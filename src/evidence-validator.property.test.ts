// Property-Based Tests for EvidenceValidator
// Feature: ai-toastmasters-evaluator, Property 7: Evidence Quote Validation

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { EvidenceValidator } from "./evidence-validator.js";
import type {
  EvaluationItem,
  StructuredEvaluation,
  TranscriptSegment,
  TranscriptWord,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Pool of realistic words to build transcript text from. */
const WORD_POOL = [
  "today", "want", "talk", "about", "importance", "public", "speaking",
  "helps", "connect", "others", "share", "ideas", "effectively", "community",
  "together", "forward", "project", "meeting", "everyone", "believe",
  "strong", "clear", "message", "audience", "practice", "confidence",
  "growth", "learning", "experience", "challenge", "opportunity", "success",
  "leadership", "teamwork", "communication", "feedback", "improve", "develop",
  "inspire", "motivate", "engage", "present", "deliver", "prepare", "focus",
  "listen", "understand", "support", "encourage", "achieve", "progress",
];

const TIMESTAMP_TOLERANCE = 20; // seconds

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a word from the word pool.
 */
function arbitraryWord(): fc.Arbitrary<string> {
  return fc.constantFrom(...WORD_POOL);
}

/**
 * Generate a non-empty array of transcript segments with word-level timestamps.
 * Each segment contains between 6 and 15 words so that valid quotes can be
 * extracted from individual segments or across segment boundaries.
 */
function arbitraryTranscriptWithWordTimestamps(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      // First segment start time (0 to 60 seconds)
      fc.double({ min: 0, max: 60, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // words in this segment (6 to 15 words to ensure enough for quotes)
          fc.array(arbitraryWord(), { minLength: 6, maxLength: 15 }),
          // duration per word (0.2 to 0.8 seconds)
          fc.double({ min: 0.2, max: 0.8, noNaN: true }),
          // gap to next segment (0.1 to 3 seconds)
          fc.double({ min: 0.1, max: 3, noNaN: true })
        ),
        { minLength: 1, maxLength: 5 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [wordTexts, wordDuration, gap] of segmentSpecs) {
        const segStartTime = currentTime;
        const words: TranscriptWord[] = [];

        for (let i = 0; i < wordTexts.length; i++) {
          const wordStart = currentTime;
          const wordEnd = currentTime + wordDuration;
          words.push({
            word: wordTexts[i],
            startTime: wordStart,
            endTime: wordEnd,
            confidence: 0.95,
          });
          currentTime = wordEnd;
        }

        const segEndTime = currentTime;

        segments.push({
          text: wordTexts.join(" "),
          startTime: segStartTime,
          endTime: segEndTime,
          words,
          isFinal: true,
        });

        currentTime = segEndTime + gap;
      }

      return segments;
    });
}

/**
 * Generate a non-empty array of transcript segments WITHOUT word-level timestamps
 * (segment-level fallback mode).
 */
function arbitraryTranscriptSegmentLevelOnly(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      fc.double({ min: 0, max: 60, noNaN: true }),
      fc.array(
        fc.tuple(
          fc.array(arbitraryWord(), { minLength: 6, maxLength: 15 }),
          fc.double({ min: 0.2, max: 0.8, noNaN: true }),
          fc.double({ min: 0.1, max: 3, noNaN: true })
        ),
        { minLength: 1, maxLength: 5 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [wordTexts, wordDuration, gap] of segmentSpecs) {
        const segStartTime = currentTime;
        const totalDuration = wordTexts.length * wordDuration;
        const segEndTime = segStartTime + totalDuration;

        segments.push({
          text: wordTexts.join(" "),
          startTime: segStartTime,
          endTime: segEndTime,
          words: [], // No word-level timestamps
          isFinal: true,
        });

        currentTime = segEndTime + gap;
      }

      return segments;
    });
}

/**
 * Given transcript segments, extract a valid evidence quote (6-15 contiguous tokens)
 * from the transcript and produce a matching evidence_timestamp within ±20s.
 *
 * This generator builds a valid EvaluationItem that SHOULD pass validation.
 */
function arbitraryValidEvaluationItem(
  segments: TranscriptSegment[],
): fc.Arbitrary<EvaluationItem> {
  // Flatten all words to get the full token list and their timestamps
  const allWords: { word: string; startTime: number }[] = [];
  for (const seg of segments) {
    if (seg.words.length > 0) {
      for (const w of seg.words) {
        allWords.push({ word: w.word, startTime: w.startTime });
      }
    } else {
      // Segment-level: split text into tokens, assign segment startTime
      const tokens = seg.text.trim().split(/\s+/);
      for (const t of tokens) {
        allWords.push({ word: t, startTime: seg.startTime });
      }
    }
  }

  const totalTokens = allWords.length;
  // We need at least 6 tokens for a valid quote
  const maxQuoteLen = Math.min(15, totalTokens);
  const minQuoteLen = Math.min(6, totalTokens);

  if (minQuoteLen < 6) {
    // Not enough tokens — shouldn't happen with our generator but handle gracefully
    return fc.constant({
      type: "commendation" as const,
      summary: "Test commendation",
      evidence_quote: allWords.map((w) => w.word).join(" "),
      evidence_timestamp: allWords[0]?.startTime ?? 0,
      explanation: "Test explanation",
    });
  }

  return fc
    .tuple(
      // Quote length (6 to min(15, totalTokens))
      fc.integer({ min: minQuoteLen, max: maxQuoteLen }),
      // Type of evaluation item
      fc.constantFrom("commendation" as const, "recommendation" as const),
      // Timestamp offset within ±20s (but we'll clamp to non-negative)
      fc.double({ min: -TIMESTAMP_TOLERANCE, max: TIMESTAMP_TOLERANCE, noNaN: true })
    )
    .chain(([quoteLen, type, tsOffset]) => {
      // Start index for the quote (must leave room for quoteLen tokens)
      const maxStartIdx = totalTokens - quoteLen;
      return fc.integer({ min: 0, max: maxStartIdx }).map((startIdx) => {
        const quoteWords = allWords
          .slice(startIdx, startIdx + quoteLen)
          .map((w) => w.word);
        const firstMatchedWordTime = allWords[startIdx].startTime;
        // evidence_timestamp within ±20s of the first matched word
        const evidenceTimestamp = Math.max(0, firstMatchedWordTime + tsOffset);

        return {
          type,
          summary: `Test ${type}`,
          evidence_quote: quoteWords.join(" "),
          evidence_timestamp: evidenceTimestamp,
          explanation: "Test explanation",
        };
      });
    });
}

/**
 * Generate a StructuredEvaluation with valid items extracted from the given segments.
 * Produces 2-3 commendations and 1-2 recommendations (3-5 items total).
 */
function arbitraryValidEvaluation(
  segments: TranscriptSegment[],
): fc.Arbitrary<StructuredEvaluation> {
  return fc
    .integer({ min: 3, max: 5 })
    .chain((itemCount) =>
      fc.tuple(...Array.from({ length: itemCount }, () => arbitraryValidEvaluationItem(segments)))
    )
    .map((items) => ({
      opening: "Great speech today.",
      items,
      closing: "Keep up the good work.",
    }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const validator = new EvidenceValidator();

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 7: Evidence Quote Validation", () => {
  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Positive — word-level timestamps)
   *
   * For any StructuredEvaluation where every evidence_quote is extracted
   * verbatim from the transcript (6-15 contiguous tokens) and the
   * evidence_timestamp is within ±20s of the first matched word's startTime,
   * validate() SHALL return { valid: true }.
   */
  it("valid evaluations with word-level timestamps pass validation", () => {
    fc.assert(
      fc.property(
        arbitraryTranscriptWithWordTimestamps().chain((segments) =>
          fc.tuple(fc.constant(segments), arbitraryValidEvaluation(segments))
        ),
        ([segments, evaluation]) => {
          const result = validator.validate(evaluation, segments);

          // Every item should pass: quote is verbatim from transcript,
          // has 6-15 tokens, and timestamp is within ±20s
          expect(result.valid).toBe(true);
          expect(result.issues).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Positive — segment-level fallback)
   *
   * Same property but with segment-level timestamps only (no word-level data).
   * The validator should use the segment-level fallback for timestamp locality.
   */
  it("valid evaluations with segment-level fallback pass validation", () => {
    fc.assert(
      fc.property(
        arbitraryTranscriptSegmentLevelOnly().chain((segments) =>
          fc.tuple(fc.constant(segments), arbitraryValidEvaluation(segments))
        ),
        ([segments, evaluation]) => {
          const result = validator.validate(evaluation, segments);

          expect(result.valid).toBe(true);
          expect(result.issues).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Negative — fabricated quotes)
   *
   * For any evaluation where evidence_quote tokens are NOT present in the
   * transcript, validate() SHALL return { valid: false }.
   */
  it("fabricated quotes that do not appear in the transcript fail validation", () => {
    // Words that are NOT in our WORD_POOL, so they cannot appear in the transcript
    const FABRICATED_WORDS = [
      "xylophone", "quasar", "nebula", "paradox", "quantum",
      "vortex", "zenith", "cipher", "nexus", "prism",
    ];

    fc.assert(
      fc.property(
        fc.tuple(
          arbitraryTranscriptWithWordTimestamps(),
          // Generate a fabricated quote of 6-15 tokens from words NOT in the transcript
          fc.array(fc.constantFrom(...FABRICATED_WORDS), { minLength: 6, maxLength: 15 }),
          fc.constantFrom("commendation" as const, "recommendation" as const),
          fc.double({ min: 0, max: 100, noNaN: true })
        ),
        ([segments, fabricatedWords, type, timestamp]) => {
          const item: EvaluationItem = {
            type,
            summary: `Test ${type}`,
            evidence_quote: fabricatedWords.join(" "),
            evidence_timestamp: timestamp,
            explanation: "Test explanation",
          };

          const evaluation: StructuredEvaluation = {
            opening: "Great speech.",
            items: [item],
            closing: "Keep it up.",
          };

          const result = validator.validate(evaluation, segments);

          expect(result.valid).toBe(false);
          expect(result.issues.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Negative — timestamp out of range)
   *
   * For any evaluation where the evidence_quote is valid but the
   * evidence_timestamp is more than 20s away from the matched word,
   * validate() SHALL return { valid: false }.
   */
  it("valid quotes with timestamps far outside ±20s fail validation", () => {
    fc.assert(
      fc.property(
        arbitraryTranscriptWithWordTimestamps().chain((segments) => {
          // Flatten words to find valid quote positions
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }

          const totalTokens = allWords.length;
          const maxQuoteLen = Math.min(15, totalTokens);
          const minQuoteLen = Math.min(6, totalTokens);

          if (minQuoteLen < 6) {
            // Skip if not enough tokens
            return fc.constant({ segments, item: null as EvaluationItem | null });
          }

          return fc
            .tuple(
              fc.integer({ min: minQuoteLen, max: maxQuoteLen }),
              fc.constantFrom("commendation" as const, "recommendation" as const),
              // Offset that guarantees > 20s away (at least 20.01s)
              fc.oneof(
                fc.double({ min: 20.01, max: 500, noNaN: true }),
                fc.double({ min: -500, max: -20.01, noNaN: true })
              )
            )
            .chain(([quoteLen, type, tsOffset]) => {
              const maxStartIdx = totalTokens - quoteLen;
              return fc.integer({ min: 0, max: maxStartIdx }).map((startIdx) => {
                const quoteWords = allWords
                  .slice(startIdx, startIdx + quoteLen)
                  .map((w) => w.word);
                const firstMatchedWordTime = allWords[startIdx].startTime;
                // Ensure timestamp is > 20s away and non-negative
                const evidenceTimestamp = Math.max(0, firstMatchedWordTime + tsOffset);

                // Double-check the offset is actually > 20s
                // (clamping to 0 might bring it back within range)
                if (Math.abs(evidenceTimestamp - firstMatchedWordTime) <= TIMESTAMP_TOLERANCE) {
                  return { segments, item: null };
                }

                const item: EvaluationItem = {
                  type,
                  summary: `Test ${type}`,
                  evidence_quote: quoteWords.join(" "),
                  evidence_timestamp: evidenceTimestamp,
                  explanation: "Test explanation",
                };

                return { segments, item };
              });
            });
        }),
        ({ segments, item }) => {
          // Skip cases where we couldn't generate a valid out-of-range timestamp
          if (!item) return;

          const evaluation: StructuredEvaluation = {
            opening: "Great speech.",
            items: [item],
            closing: "Keep it up.",
          };

          const result = validator.validate(evaluation, segments);

          expect(result.valid).toBe(false);
          expect(result.issues.length).toBeGreaterThan(0);
          expect(result.issues[0]).toContain("not within ±20s");
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Length constraint)
   *
   * For any evidence_quote with more than 15 tokens, validate() SHALL
   * report a length violation.
   */
  it("quotes exceeding 15 tokens fail the length check", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbitraryTranscriptWithWordTimestamps(),
          // Generate a quote with 16-25 tokens (exceeds the 15-token limit)
          fc.array(arbitraryWord(), { minLength: 16, maxLength: 25 }),
          fc.double({ min: 0, max: 100, noNaN: true })
        ),
        ([segments, longQuoteWords, timestamp]) => {
          const item: EvaluationItem = {
            type: "commendation",
            summary: "Test commendation",
            evidence_quote: longQuoteWords.join(" "),
            evidence_timestamp: timestamp,
            explanation: "Test explanation",
          };

          const evaluation: StructuredEvaluation = {
            opening: "Great speech.",
            items: [item],
            closing: "Keep it up.",
          };

          const result = validator.validate(evaluation, segments);

          expect(result.valid).toBe(false);
          expect(result.issues.some((i) => i.includes("15-token limit"))).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 4.3, 4.6**
   *
   * Property 7: Evidence Quote Validation (Minimum token constraint)
   *
   * For any evidence_quote with fewer than 6 tokens, validate() SHALL
   * report a token count violation.
   */
  it("quotes with fewer than 6 tokens fail the minimum token check", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbitraryTranscriptWithWordTimestamps(),
          // Generate a quote with 1-5 tokens (below the 6-token minimum)
          fc.array(arbitraryWord(), { minLength: 1, maxLength: 5 }),
          fc.double({ min: 0, max: 100, noNaN: true })
        ),
        ([segments, shortQuoteWords, timestamp]) => {
          const item: EvaluationItem = {
            type: "recommendation",
            summary: "Test recommendation",
            evidence_quote: shortQuoteWords.join(" "),
            evidence_timestamp: timestamp,
            explanation: "Test explanation",
          };

          const evaluation: StructuredEvaluation = {
            opening: "Great speech.",
            items: [item],
            closing: "Keep it up.",
          };

          const result = validator.validate(evaluation, segments);

          expect(result.valid).toBe(false);
          expect(result.issues.some((i) => i.includes("fewer than 6 tokens"))).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
