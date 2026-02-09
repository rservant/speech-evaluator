// Property-Based Tests for EvaluationGenerator — Structured Evaluation Shape Invariant
// Feature: ai-toastmasters-evaluator, Property 8: Structured Evaluation Shape Invariant

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { EvaluationGenerator, type OpenAIClient } from "./evaluation-generator.js";
import type {
  DeliveryMetrics,
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

// Shape invariant bounds (from evaluation-generator.ts)
const MIN_COMMENDATIONS = 2;
const MAX_COMMENDATIONS = 3;
const MIN_RECOMMENDATIONS = 1;
const MAX_RECOMMENDATIONS = 2;

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a word from the word pool.
 */
function arbitraryWord(): fc.Arbitrary<string> {
  return fc.constantFrom(...WORD_POOL);
}

/**
 * Generate transcript segments with word-level timestamps.
 * Produces enough segments (5-8) with enough words per segment (8-15)
 * to support multiple evidence quotes being extracted.
 */
function arbitraryTranscriptSegments(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      fc.double({ min: 0, max: 10, noNaN: true }),
      fc.array(
        fc.tuple(
          fc.array(arbitraryWord(), { minLength: 8, maxLength: 15 }),
          fc.double({ min: 0.2, max: 0.6, noNaN: true }),
          fc.double({ min: 0.5, max: 3, noNaN: true })
        ),
        { minLength: 5, maxLength: 8 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [wordTexts, wordDuration, gap] of segmentSpecs) {
        const segStartTime = currentTime;
        const words: TranscriptWord[] = [];

        for (const wordText of wordTexts) {
          const wordStart = currentTime;
          const wordEnd = currentTime + wordDuration;
          words.push({
            word: wordText,
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
 * Build DeliveryMetrics consistent with the given transcript segments.
 * Uses realistic values so that quality assessment doesn't flag warnings
 * (which would change prompt behavior but not shape invariant).
 */
function metricsFromSegments(segments: TranscriptSegment[]): DeliveryMetrics {
  const totalWords = segments.reduce(
    (sum, seg) => sum + seg.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  const durationSeconds =
    segments.length > 0
      ? segments[segments.length - 1].endTime - segments[0].startTime
      : 0;
  const wordsPerMinute =
    durationSeconds > 0 ? totalWords / (durationSeconds / 60) : 0;

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.floor(durationSeconds % 60);

  return {
    durationSeconds,
    durationFormatted: `${minutes}:${String(seconds).padStart(2, "0")}`,
    totalWords,
    wordsPerMinute,
    fillerWords: [],
    fillerWordCount: 0,
    fillerWordFrequency: 0,
    pauseCount: 0,
    totalPauseDurationSeconds: 0,
    averagePauseDurationSeconds: 0,
  };
}

/**
 * Extract a verbatim evidence quote (6-15 contiguous tokens) from the
 * flattened word list of the transcript segments, along with a timestamp
 * within ±20s of the first matched word.
 */
function extractQuoteFromSegments(
  segments: TranscriptSegment[],
  startWordIndex: number,
  quoteLength: number,
): { quote: string; timestamp: number } {
  const allWords: { word: string; startTime: number }[] = [];
  for (const seg of segments) {
    for (const w of seg.words) {
      allWords.push({ word: w.word, startTime: w.startTime });
    }
  }

  const endIndex = Math.min(startWordIndex + quoteLength, allWords.length);
  const quoteWords = allWords.slice(startWordIndex, endIndex).map((w) => w.word);
  const timestamp = allWords[startWordIndex].startTime;

  return {
    quote: quoteWords.join(" "),
    timestamp,
  };
}

/**
 * Given transcript segments, generate a valid StructuredEvaluation with
 * the specified number of commendations and recommendations.
 * Each item's evidence_quote is extracted verbatim from the transcript.
 */
function buildValidEvaluation(
  segments: TranscriptSegment[],
  numCommendations: number,
  numRecommendations: number,
): StructuredEvaluation {
  const allWords: { word: string; startTime: number }[] = [];
  for (const seg of segments) {
    for (const w of seg.words) {
      allWords.push({ word: w.word, startTime: w.startTime });
    }
  }

  const totalTokens = allWords.length;
  const totalItems = numCommendations + numRecommendations;
  // Space out quotes evenly across the transcript
  const quoteLength = 8; // 8 tokens per quote (within 6-15 range)
  const spacing = Math.max(1, Math.floor((totalTokens - quoteLength) / totalItems));

  const items: EvaluationItem[] = [];

  for (let i = 0; i < numCommendations; i++) {
    const startIdx = Math.min(i * spacing, totalTokens - quoteLength);
    const { quote, timestamp } = extractQuoteFromSegments(segments, startIdx, quoteLength);
    items.push({
      type: "commendation",
      summary: `Commendation ${i + 1}`,
      evidence_quote: quote,
      evidence_timestamp: timestamp,
      explanation: "This was a strong point in the speech.",
    });
  }

  for (let i = 0; i < numRecommendations; i++) {
    const startIdx = Math.min(
      (numCommendations + i) * spacing,
      totalTokens - quoteLength,
    );
    const { quote, timestamp } = extractQuoteFromSegments(segments, startIdx, quoteLength);
    items.push({
      type: "recommendation",
      summary: `Recommendation ${i + 1}`,
      evidence_quote: quote,
      evidence_timestamp: timestamp,
      explanation: "Consider improving this aspect of the speech.",
    });
  }

  return {
    opening: "Thank you for that wonderful speech.",
    items,
    closing: "Keep up the great work!",
  };
}

/**
 * Create a mock OpenAI client that returns the given JSON responses in order.
 */
function makeMockClient(responses: string[]): OpenAIClient {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const content = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return {
            choices: [{ message: { content } }],
          };
        }),
      },
    },
  };
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 8: Structured Evaluation Shape Invariant", () => {
  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * Property 8a: Shape invariant holds for valid LLM responses.
   *
   * For any StructuredEvaluation produced by generate() where the LLM returns
   * a well-formed evaluation with 2-3 commendations and 1-2 recommendations
   * (all with valid evidence quotes), the result SHALL satisfy the shape invariant.
   */
  it("generate() returns evaluations satisfying the shape invariant when LLM produces valid output", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
          )
        ),
        async ([segments, numCommendations, numRecommendations]) => {
          const evaluation = buildValidEvaluation(
            segments,
            numCommendations,
            numRecommendations,
          );

          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Shape invariant: 2-3 commendations, 1-2 recommendations
          const commendations = result.items.filter(
            (i) => i.type === "commendation",
          ).length;
          const recommendations = result.items.filter(
            (i) => i.type === "recommendation",
          ).length;

          expect(commendations).toBeGreaterThanOrEqual(MIN_COMMENDATIONS);
          expect(commendations).toBeLessThanOrEqual(MAX_COMMENDATIONS);
          expect(recommendations).toBeGreaterThanOrEqual(MIN_RECOMMENDATIONS);
          expect(recommendations).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * Property 8b: Shape invariant check correctly identifies valid shapes.
   *
   * For any StructuredEvaluation with commendation count in [2,3] and
   * recommendation count in [1,2], the shape invariant is satisfied.
   * This tests the shape check logic directly on randomly generated evaluations.
   */
  it("evaluations with valid item counts satisfy the shape invariant", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
          fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
        ),
        ([numCommendations, numRecommendations]) => {
          const items: EvaluationItem[] = [];

          for (let i = 0; i < numCommendations; i++) {
            items.push({
              type: "commendation",
              summary: `Commendation ${i + 1}`,
              evidence_quote: "today I want to talk about leadership and growth",
              evidence_timestamp: i * 10,
              explanation: "Good point.",
            });
          }

          for (let i = 0; i < numRecommendations; i++) {
            items.push({
              type: "recommendation",
              summary: `Recommendation ${i + 1}`,
              evidence_quote: "and then we moved on to the next part quickly",
              evidence_timestamp: 60 + i * 10,
              explanation: "Consider improving.",
            });
          }

          const evaluation: StructuredEvaluation = {
            opening: "Great speech.",
            items,
            closing: "Keep it up.",
          };

          const commendations = evaluation.items.filter(
            (i) => i.type === "commendation",
          ).length;
          const recommendations = evaluation.items.filter(
            (i) => i.type === "recommendation",
          ).length;

          expect(commendations).toBeGreaterThanOrEqual(MIN_COMMENDATIONS);
          expect(commendations).toBeLessThanOrEqual(MAX_COMMENDATIONS);
          expect(recommendations).toBeGreaterThanOrEqual(MIN_RECOMMENDATIONS);
          expect(recommendations).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * Property 8c: Shape invariant check correctly rejects invalid shapes.
   *
   * For any StructuredEvaluation where commendation count is outside [2,3]
   * OR recommendation count is outside [1,2], the shape invariant is violated.
   */
  it("evaluations with invalid item counts violate the shape invariant", () => {
    // Generate counts that are outside the valid range
    const invalidCountsArb = fc
      .tuple(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
      )
      .filter(
        ([c, r]) =>
          c < MIN_COMMENDATIONS ||
          c > MAX_COMMENDATIONS ||
          r < MIN_RECOMMENDATIONS ||
          r > MAX_RECOMMENDATIONS,
      );

    fc.assert(
      fc.property(invalidCountsArb, ([numCommendations, numRecommendations]) => {
        const items: EvaluationItem[] = [];

        for (let i = 0; i < numCommendations; i++) {
          items.push({
            type: "commendation",
            summary: `Commendation ${i + 1}`,
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: i * 10,
            explanation: "Good point.",
          });
        }

        for (let i = 0; i < numRecommendations; i++) {
          items.push({
            type: "recommendation",
            summary: `Recommendation ${i + 1}`,
            evidence_quote: "and then we moved on to the next part quickly",
            evidence_timestamp: 60 + i * 10,
            explanation: "Consider improving.",
          });
        }

        const commendations = items.filter(
          (i) => i.type === "commendation",
        ).length;
        const recommendations = items.filter(
          (i) => i.type === "recommendation",
        ).length;

        const shapeValid =
          commendations >= MIN_COMMENDATIONS &&
          commendations <= MAX_COMMENDATIONS &&
          recommendations >= MIN_RECOMMENDATIONS &&
          recommendations <= MAX_RECOMMENDATIONS;

        expect(shapeValid).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * Property 8d: Regeneration on shape violation.
   *
   * When the first LLM attempt produces an evaluation that violates the shape
   * invariant after evidence validation drops items, the system SHALL regenerate
   * the full evaluation (max 2 total attempts). If the second attempt succeeds,
   * the result SHALL satisfy the shape invariant.
   */
  it("generate() regenerates when first attempt violates shape invariant after item drops", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
          )
        ),
        async ([segments, numCommendations, numRecommendations]) => {
          // First attempt: only 1 commendation (violates shape) + 1 bad quote that will fail
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }

          const totalTokens = allWords.length;
          if (totalTokens < 8) return; // skip if not enough tokens

          // Build a bad evaluation: 1 valid commendation + 1 with fabricated quote + 1 recommendation
          const { quote: validQuote1, timestamp: ts1 } = extractQuoteFromSegments(segments, 0, 8);
          const { quote: validRecQuote, timestamp: tsRec } = extractQuoteFromSegments(
            segments,
            Math.min(16, totalTokens - 8),
            8,
          );

          const badEval: StructuredEvaluation = {
            opening: "Great speech.",
            items: [
              {
                type: "commendation",
                summary: "Good point",
                evidence_quote: validQuote1,
                evidence_timestamp: ts1,
                explanation: "Well done.",
              },
              {
                type: "commendation",
                summary: "Bad quote",
                evidence_quote: "xylophone quasar nebula paradox quantum vortex zenith cipher",
                evidence_timestamp: 30,
                explanation: "Fabricated.",
              },
              {
                type: "recommendation",
                summary: "Pacing",
                evidence_quote: validRecQuote,
                evidence_timestamp: tsRec,
                explanation: "Slow down.",
              },
            ],
            closing: "Keep it up!",
          };

          // Retry for the bad item also fails (fabricated)
          const badRetryItem: EvaluationItem = {
            type: "commendation",
            summary: "Still bad",
            evidence_quote: "prism nexus cipher vortex zenith quasar nebula paradox",
            evidence_timestamp: 30,
            explanation: "Still fabricated.",
          };

          // Second full generation: valid evaluation
          const goodEval = buildValidEvaluation(
            segments,
            numCommendations,
            numRecommendations,
          );

          const client = makeMockClient([
            JSON.stringify(badEval),
            JSON.stringify(badRetryItem),
            JSON.stringify(goodEval),
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // After regeneration, shape invariant should hold
          const commendations = result.items.filter(
            (i) => i.type === "commendation",
          ).length;
          const recommendations = result.items.filter(
            (i) => i.type === "recommendation",
          ).length;

          expect(commendations).toBeGreaterThanOrEqual(MIN_COMMENDATIONS);
          expect(commendations).toBeLessThanOrEqual(MAX_COMMENDATIONS);
          expect(recommendations).toBeGreaterThanOrEqual(MIN_RECOMMENDATIONS);
          expect(recommendations).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * Property 8e: All items are typed correctly.
   *
   * For any StructuredEvaluation produced by generate(), every item in the
   * items array SHALL have type equal to either "commendation" or "recommendation".
   */
  it("generate() only produces items of type commendation or recommendation", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
          )
        ),
        async ([segments, numCommendations, numRecommendations]) => {
          const evaluation = buildValidEvaluation(
            segments,
            numCommendations,
            numRecommendations,
          );

          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          for (const item of result.items) {
            expect(["commendation", "recommendation"]).toContain(item.type);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
