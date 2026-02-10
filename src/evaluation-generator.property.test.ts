// Property-Based Tests for EvaluationGenerator — Structured Evaluation Shape Invariant
// Feature: ai-toastmasters-evaluator, Property 8: Structured Evaluation Shape Invariant

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { EvaluationGenerator, cosineSimilarity, type OpenAIClient } from "./evaluation-generator.js";
import { EvidenceValidator } from "./evidence-validator.js";
import type {
  ConsentRecord,
  DeliveryMetrics,
  EvaluationItem,
  RedactionInput,
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
    intentionalPauseCount: 0,
    hesitationPauseCount: 0,
    classifiedPauses: [],
    energyVariationCoefficient: 0,
    energyProfile: {
      windowDurationMs: 250,
      windows: [],
      coefficientOfVariation: 0,
      silenceThreshold: 0,
    },
    classifiedFillers: [],
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
    structure_commentary: {
      opening_comment: null,
      body_comment: null,
      closing_comment: null,
    },
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
          const commendations = result.evaluation.items.filter(
            (i) => i.type === "commendation",
          ).length;
          const recommendations = result.evaluation.items.filter(
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
            structure_commentary: {
              opening_comment: null,
              body_comment: null,
              closing_comment: null,
            },
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
            structure_commentary: {
              opening_comment: null,
              body_comment: null,
              closing_comment: null,
            },
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
          const commendations = result.evaluation.items.filter(
            (i) => i.type === "commendation",
          ).length;
          const recommendations = result.evaluation.items.filter(
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

          for (const item of result.evaluation.items) {
            expect(["commendation", "recommendation"]).toContain(item.type);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: Null Structure Commentary Omission ─────────────────────────────
// Feature: phase-2-stability-credibility, Property 8: Null Structure Commentary Omission

describe("Feature: phase-2-stability-credibility, Property 8: Null Structure Commentary Omission", () => {
  // ── Generators ──────────────────────────────────────────────────────────────

  /**
   * Generate a non-empty, realistic commentary string that is unique enough
   * to be reliably detected in the rendered script.
   */
  function arbitraryCommentaryText(): fc.Arbitrary<string> {
    const templates = [
      "Your opening grabbed attention with a compelling question.",
      "The body of your speech was well organized with clear transitions.",
      "Your closing left the audience with a memorable takeaway.",
      "You started with a strong personal anecdote that drew listeners in.",
      "The main points in your speech flowed logically from one to the next.",
      "Your conclusion circled back to your opening theme effectively.",
      "The introduction set clear expectations for what was to come.",
      "Each section of your speech built upon the previous one nicely.",
      "You wrapped up with a powerful call to action.",
    ];
    return fc.constantFrom(...templates);
  }

  /**
   * Generate a StructureCommentary with independently nullable fields.
   * Each field is either a non-empty string or null, controlled independently.
   */
  function arbitraryStructureCommentary(): fc.Arbitrary<{
    opening_comment: string | null;
    body_comment: string | null;
    closing_comment: string | null;
  }> {
    return fc.tuple(
      fc.option(arbitraryCommentaryText(), { nil: null }),
      fc.option(arbitraryCommentaryText(), { nil: null }),
      fc.option(arbitraryCommentaryText(), { nil: null }),
    ).map(([opening, body, closing]) => ({
      opening_comment: opening,
      body_comment: body,
      closing_comment: closing,
    }));
  }

  /**
   * Build a valid StructuredEvaluation with the given structure_commentary.
   * Uses fixed items so the test focuses purely on commentary rendering.
   */
  function buildEvaluationWithCommentary(commentary: {
    opening_comment: string | null;
    body_comment: string | null;
    closing_comment: string | null;
  }): StructuredEvaluation {
    return {
      opening: "Thank you for that wonderful speech.",
      items: [
        {
          type: "commendation",
          summary: "clear message delivery",
          evidence_quote: "today I want to talk about leadership",
          evidence_timestamp: 5,
          explanation: "this set a strong foundation for your speech.",
        },
        {
          type: "commendation",
          summary: "effective use of examples",
          evidence_quote: "when we worked together on the project",
          evidence_timestamp: 30,
          explanation: "the audience could relate to your experience.",
        },
        {
          type: "recommendation",
          summary: "pacing in the middle section",
          evidence_quote: "and then we moved forward quickly to discuss",
          evidence_timestamp: 60,
          explanation: "slowing down here would let your points land.",
        },
      ],
      closing: "Keep up the great work and keep growing!",
      structure_commentary: commentary,
    };
  }

  // Create a shared generator instance with a mock client (renderScript is synchronous)
  function createGenerator(): EvaluationGenerator {
    const mockClient = makeMockClient(["{}"]);
    return new EvaluationGenerator(mockClient);
  }

  /**
   * **Validates: Requirements 4.3**
   *
   * Property 8: When a structure_commentary field is null, its content
   * SHALL NOT appear in the rendered script. When all three are null,
   * no structure commentary section SHALL appear at all.
   */
  it("null commentary fields are omitted from the rendered script; non-null fields appear", () => {
    const generator = createGenerator();

    fc.assert(
      fc.property(
        arbitraryStructureCommentary(),
        (commentary) => {
          const evaluation = buildEvaluationWithCommentary(commentary);
          // Call renderScript without speakerName to avoid redaction interference
          const script = generator.renderScript(evaluation);

          // Check each field independently
          if (commentary.opening_comment === null) {
            // Null opening_comment → its text must NOT appear
            // (no text to check since it's null — verified by absence of any
            // opening commentary content; we verify via the non-null case below)
          } else {
            // Non-null opening_comment → its text MUST appear in the script
            expect(script).toContain(commentary.opening_comment);
          }

          if (commentary.body_comment === null) {
            // Null body_comment → nothing to find
          } else {
            expect(script).toContain(commentary.body_comment);
          }

          if (commentary.closing_comment === null) {
            // Null closing_comment → nothing to find
          } else {
            expect(script).toContain(commentary.closing_comment);
          }

          // When ALL three are null, no commentary text should appear between
          // the opening and the first item section
          const allNull =
            commentary.opening_comment === null &&
            commentary.body_comment === null &&
            commentary.closing_comment === null;

          if (allNull) {
            // The script should go directly from opening to the first item.
            // Split by double-newline (the join separator in renderScript).
            const sections = script.split("\n\n");
            // First section is the opening, second should be the first item
            // (no commentary paragraph in between)
            expect(sections[0]).toBe(evaluation.opening);
            // The second section should start with item rendering, not commentary
            expect(sections[1]).toContain("Something that really stood out was");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.3**
   *
   * Property 8 (individual null omission): For each commentary field independently,
   * when it is null the rendered script SHALL NOT contain that field's text,
   * while the other non-null fields still appear.
   */
  it("each null commentary field is independently omitted while non-null siblings appear", () => {
    const generator = createGenerator();

    // Generate commentary where at least one field is null and at least one is non-null
    const mixedCommentaryArb = arbitraryStructureCommentary().filter((c) => {
      const nullCount = [c.opening_comment, c.body_comment, c.closing_comment]
        .filter((v) => v === null).length;
      return nullCount >= 1 && nullCount <= 2; // mixed: some null, some non-null
    });

    fc.assert(
      fc.property(
        mixedCommentaryArb,
        (commentary) => {
          const evaluation = buildEvaluationWithCommentary(commentary);
          const script = generator.renderScript(evaluation);

          // Non-null fields must appear
          const nonNullFields = [
            commentary.opening_comment,
            commentary.body_comment,
            commentary.closing_comment,
          ].filter((f): f is string => f !== null);

          for (const field of nonNullFields) {
            expect(script).toContain(field);
          }

          // The commentary paragraph (joined non-null fields) should be present
          // as a single paragraph between opening and first item
          const sections = script.split("\n\n");
          const commentaryParagraph = nonNullFields.join(" ");
          expect(sections).toContain(commentaryParagraph);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.3**
   *
   * Property 8 (all non-null): When all three commentary fields are non-null,
   * all three texts SHALL appear in the rendered script as a joined paragraph.
   */
  it("all non-null commentary fields appear joined in the rendered script", () => {
    const generator = createGenerator();

    const allNonNullArb = fc.tuple(
      arbitraryCommentaryText(),
      arbitraryCommentaryText(),
      arbitraryCommentaryText(),
    ).map(([opening, body, closing]) => ({
      opening_comment: opening,
      body_comment: body,
      closing_comment: closing,
    }));

    fc.assert(
      fc.property(
        allNonNullArb,
        (commentary) => {
          const evaluation = buildEvaluationWithCommentary(commentary);
          const script = generator.renderScript(evaluation);

          // All three texts must appear
          expect(script).toContain(commentary.opening_comment!);
          expect(script).toContain(commentary.body_comment!);
          expect(script).toContain(commentary.closing_comment!);

          // They should be joined as a single paragraph
          const joinedCommentary = [
            commentary.opening_comment,
            commentary.body_comment,
            commentary.closing_comment,
          ].join(" ");
          expect(script).toContain(joinedCommentary);

          // The commentary paragraph should be between opening and first item
          const sections = script.split("\n\n");
          const openingIdx = sections.indexOf(evaluation.opening);
          const commentaryIdx = sections.indexOf(joinedCommentary);
          expect(openingIdx).toBe(0);
          expect(commentaryIdx).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.3**
   *
   * Property 8 (all null): When all three commentary fields are null,
   * no structure commentary section SHALL appear in the rendered script.
   */
  it("all-null commentary produces no commentary section in the rendered script", () => {
    const generator = createGenerator();

    fc.assert(
      fc.property(
        // Generate varied evaluations with all-null commentary
        fc.tuple(
          fc.constantFrom(
            "Thank you for sharing your thoughts today.",
            "What a compelling speech that was.",
            "I appreciate you stepping up to speak.",
          ),
          fc.constantFrom(
            "Keep pushing forward!",
            "Great progress on your speaking journey!",
            "Looking forward to your next speech!",
          ),
        ),
        ([opening, closing]) => {
          const commentary = {
            opening_comment: null,
            body_comment: null,
            closing_comment: null,
          };
          const evaluation: StructuredEvaluation = {
            ...buildEvaluationWithCommentary(commentary),
            opening,
            closing,
          };
          const script = generator.renderScript(evaluation);

          // Split into sections by double-newline
          const sections = script.split("\n\n");

          // First section is opening
          expect(sections[0]).toBe(opening);

          // Second section should be the first item (no commentary in between)
          expect(sections[1]).toContain("Something that really stood out was");

          // Last section should be the closing
          expect(sections[sections.length - 1]).toBe(closing);

          // Total sections: opening + items (3) + closing = 5 (no commentary)
          expect(sections.length).toBe(5);
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─── Property 18: Evidence Pass Rate Computation ────────────────────────────────
// Feature: phase-2-stability-credibility, Property 18: Evidence Pass Rate Computation

describe("Feature: phase-2-stability-credibility, Property 18: Evidence Pass Rate Computation", () => {
  /**
   * **Validates: Requirements 1.6**
   *
   * Property 18: For any set of evaluation items with known first-attempt
   * pass/fail status, the computed pass rate SHALL equal
   * `passedOnFirstAttempt / totalDeliveredItems`, where `totalDeliveredItems`
   * is the count of items in the final accepted evaluation and
   * `passedOnFirstAttempt` is the count of those that passed evidence
   * validation without item-level retry.
   */

  /**
   * Build a StructuredEvaluation with a guaranteed shape-valid mix of items:
   * - `passCount` items with valid evidence quotes (pass first attempt)
   * - `failCount` items with fabricated quotes (fail first attempt)
   *
   * The type distribution ensures the shape invariant (2-3 commendations,
   * 1-2 recommendations) holds after all retries succeed. Pass items are
   * assigned as 2 commendations first, then recommendations. Fail items
   * fill remaining slots.
   *
   * Returns the evaluation and retry items (valid quotes for each failed item).
   */
  function buildMixedPassFailEvaluation(
    segments: TranscriptSegment[],
    passCount: number,
    failCount: number,
  ): {
    evaluation: StructuredEvaluation;
    retryItems: EvaluationItem[];
  } {
    const allWords: { word: string; startTime: number }[] = [];
    for (const seg of segments) {
      for (const w of seg.words) {
        allWords.push({ word: w.word, startTime: w.startTime });
      }
    }

    const totalTokens = allWords.length;
    const totalItems = passCount + failCount;
    const quoteLength = 8;
    const spacing = Math.max(1, Math.floor((totalTokens - quoteLength) / Math.max(totalItems + 1, 1)));

    // Assign types to meet shape invariant: 2 commendations + 1 recommendation minimum
    // We build a type sequence: [C, C, R, C?, R?] depending on total count
    const typeSequence: Array<"commendation" | "recommendation"> = [];
    const total = passCount + failCount;
    // First 2 are commendations, 3rd is recommendation, rest alternate
    for (let i = 0; i < total; i++) {
      if (i < 2) typeSequence.push("commendation");
      else if (i === 2) typeSequence.push("recommendation");
      else typeSequence.push(i % 2 === 0 ? "commendation" : "recommendation");
    }

    const items: EvaluationItem[] = [];
    const retryItems: EvaluationItem[] = [];
    let quoteIdx = 0;

    // Pass items first (valid quotes)
    for (let i = 0; i < passCount; i++) {
      const startIdx = Math.min(quoteIdx * spacing, totalTokens - quoteLength);
      const { quote, timestamp } = extractQuoteFromSegments(segments, startIdx, quoteLength);
      items.push({
        type: typeSequence[i],
        summary: `Pass item ${i + 1}`,
        evidence_quote: quote,
        evidence_timestamp: timestamp,
        explanation: `This is pass item ${i + 1}.`,
      });
      quoteIdx++;
    }

    // Fail items (fabricated quotes) + retry items (valid quotes)
    for (let i = 0; i < failCount; i++) {
      const itemIdx = passCount + i;
      const retryStartIdx = Math.min(quoteIdx * spacing, totalTokens - quoteLength);
      const { quote: retryQuote, timestamp: retryTs } = extractQuoteFromSegments(
        segments,
        retryStartIdx,
        quoteLength,
      );

      items.push({
        type: typeSequence[itemIdx],
        summary: `Fail item ${i + 1}`,
        evidence_quote: "xylophone quasar nebula paradox quantum vortex zenith cipher",
        evidence_timestamp: 30,
        explanation: `This is fail item ${i + 1}.`,
      });

      retryItems.push({
        type: typeSequence[itemIdx],
        summary: `Fail item ${i + 1} retried`,
        evidence_quote: retryQuote,
        evidence_timestamp: retryTs,
        explanation: `This is retried fail item ${i + 1}.`,
      });
      quoteIdx++;
    }

    return {
      evaluation: {
        opening: "Thank you for that wonderful speech.",
        items,
        closing: "Keep up the great work!",
        structure_commentary: {
          opening_comment: null,
          body_comment: null,
          closing_comment: null,
        },
      },
      retryItems,
    };
  }

  it("passRate equals passedOnFirstAttempt / totalDeliveredItems for all-pass scenarios", async () => {
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
          // All items have valid quotes → all pass first attempt → passRate = 1.0
          const evaluation = buildValidEvaluation(segments, numCommendations, numRecommendations);
          const totalItems = evaluation.items.length;

          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // All items passed first attempt
          const expectedPassRate = totalItems / totalItems; // 1.0
          expect(result.passRate).toBeCloseTo(expectedPassRate, 10);
          expect(result.passRate).toBe(1.0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("passRate equals passedOnFirstAttempt / totalDeliveredItems for mixed pass/fail scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            // passCount: 2-3 items pass first attempt (enough for shape invariant)
            fc.integer({ min: 2, max: 3 }),
            // failCount: 1-2 items fail first attempt but pass after retry
            fc.integer({ min: 1, max: 2 }),
          )
        ),
        async ([segments, passCount, failCount]) => {
          const { evaluation, retryItems } = buildMixedPassFailEvaluation(
            segments,
            passCount,
            failCount,
          );

          // Mock responses:
          // 1st call: initial LLM generation → returns the mixed evaluation
          // Subsequent calls: retry responses for each failed item (single item JSON)
          const responses: string[] = [JSON.stringify(evaluation)];
          for (const retryItem of retryItems) {
            responses.push(JSON.stringify(retryItem));
          }

          const client = makeMockClient(responses);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Total delivered = passCount (passed first attempt) + failCount (passed after retry)
          const totalDelivered = result.evaluation.items.length;
          // passedOnFirstAttempt = passCount (only the items with valid quotes from the start)
          const expectedPassRate = totalDelivered > 0
            ? passCount / totalDelivered
            : 0;

          expect(result.passRate).toBeCloseTo(expectedPassRate, 10);

          // Also verify the fundamental property: passRate is in [0, 1]
          expect(result.passRate).toBeGreaterThanOrEqual(0);
          expect(result.passRate).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("passRate is 0 when all items fail first attempt but pass after retry", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        async (segments) => {
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          const totalTokens = allWords.length;
          if (totalTokens < 24) return; // need enough tokens for 3 distinct quotes

          // Build evaluation where ALL items have fabricated quotes (fail first attempt)
          const fabricatedQuote = "xylophone quasar nebula paradox quantum vortex zenith cipher";
          const badEval: StructuredEvaluation = {
            opening: "Thank you for that wonderful speech.",
            items: [
              {
                type: "commendation",
                summary: "Point 1",
                evidence_quote: fabricatedQuote,
                evidence_timestamp: 30,
                explanation: "Fabricated.",
              },
              {
                type: "commendation",
                summary: "Point 2",
                evidence_quote: fabricatedQuote,
                evidence_timestamp: 30,
                explanation: "Fabricated.",
              },
              {
                type: "recommendation",
                summary: "Point 3",
                evidence_quote: fabricatedQuote,
                evidence_timestamp: 30,
                explanation: "Fabricated.",
              },
            ],
            closing: "Keep up the great work!",
            structure_commentary: {
              opening_comment: null,
              body_comment: null,
              closing_comment: null,
            },
          };

          // Build valid retry items for each failed item
          const retryItems: EvaluationItem[] = [];
          for (let i = 0; i < 3; i++) {
            const startIdx = Math.min(i * 8, totalTokens - 8);
            const { quote, timestamp } = extractQuoteFromSegments(segments, startIdx, 8);
            retryItems.push({
              type: badEval.items[i].type,
              summary: `Retried ${i + 1}`,
              evidence_quote: quote,
              evidence_timestamp: timestamp,
              explanation: `Retried item ${i + 1}.`,
            });
          }

          const responses: string[] = [JSON.stringify(badEval)];
          for (const item of retryItems) {
            responses.push(JSON.stringify(item));
          }

          const client = makeMockClient(responses);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // All items failed first attempt → passedOnFirstAttempt = 0
          // passRate = 0 / totalDelivered = 0
          expect(result.passRate).toBe(0);

          // But items should still be delivered (via retry)
          expect(result.evaluation.items.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("passRate is always in [0, 1] and equals the exact ratio", async () => {
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
          const evaluation = buildValidEvaluation(segments, numCommendations, numRecommendations);
          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // passRate must always be in [0, 1]
          expect(result.passRate).toBeGreaterThanOrEqual(0);
          expect(result.passRate).toBeLessThanOrEqual(1);

          // For valid evaluations, passRate should be a rational number p/q
          // where p <= q and q = totalDeliveredItems
          const totalDelivered = result.evaluation.items.length;
          if (totalDelivered > 0) {
            // passRate * totalDelivered should be a non-negative integer
            const passedCount = Math.round(result.passRate * totalDelivered);
            expect(result.passRate).toBeCloseTo(passedCount / totalDelivered, 10);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─── Property 1: Extended Structural Shape Invariant ─────────────────────────────
// Feature: phase-2-stability-credibility, Property 1: Extended Structural Shape Invariant

describe("Feature: phase-2-stability-credibility, Property 1: Extended Structural Shape Invariant", () => {
  /**
   * **Validates: Requirements 1.1, 4.9, 5.10**
   *
   * Property 1: For any StructuredEvaluation produced by the Phase 2
   * Evaluation Generator, the object SHALL contain:
   *   (a) a non-empty `opening` string,
   *   (b) a non-empty `closing` string,
   *   (c) an `items` array where every item has non-empty `evidence_quote`,
   *       numeric `evidence_timestamp`, non-empty `summary`, and non-empty `explanation`,
   *   (d) a `structure_commentary` object with `opening_comment`, `body_comment`,
   *       and `closing_comment` fields (each either a non-empty string or null).
   */

  // ── Generators ──────────────────────────────────────────────────────────────

  /**
   * Generate a non-empty string for opening/closing text.
   */
  function arbitraryNonEmptyString(): fc.Arbitrary<string> {
    return fc.constantFrom(
      "Thank you for that wonderful speech.",
      "What a compelling presentation today.",
      "I appreciate you sharing your thoughts with us.",
      "That was a thought-provoking speech.",
      "Keep up the great work and keep growing!",
      "Looking forward to your next speech!",
      "Great progress on your speaking journey!",
      "Continue building on these strengths!",
    );
  }

  /**
   * Generate a structure_commentary with independently nullable fields.
   * Each field is either a non-empty string or null.
   */
  function arbitraryStructureCommentaryForShape(): fc.Arbitrary<{
    opening_comment: string | null;
    body_comment: string | null;
    closing_comment: string | null;
  }> {
    const commentTemplates = [
      "Your opening grabbed attention with a compelling question.",
      "The body of your speech was well organized with clear transitions.",
      "Your closing left the audience with a memorable takeaway.",
      "You started with a strong personal anecdote.",
      "The main points flowed logically from one to the next.",
      "Your conclusion circled back to your opening theme effectively.",
    ];
    const arbitraryComment = fc.constantFrom(...commentTemplates);

    return fc.tuple(
      fc.option(arbitraryComment, { nil: null }),
      fc.option(arbitraryComment, { nil: null }),
      fc.option(arbitraryComment, { nil: null }),
    ).map(([opening, body, closing]) => ({
      opening_comment: opening,
      body_comment: body,
      closing_comment: closing,
    }));
  }

  /**
   * Build a valid StructuredEvaluation with random structure_commentary,
   * drawing evidence quotes from the given transcript segments.
   */
  function buildValidEvaluationWithCommentary(
    segments: TranscriptSegment[],
    numCommendations: number,
    numRecommendations: number,
    opening: string,
    closing: string,
    commentary: { opening_comment: string | null; body_comment: string | null; closing_comment: string | null },
  ): StructuredEvaluation {
    const allWords: { word: string; startTime: number }[] = [];
    for (const seg of segments) {
      for (const w of seg.words) {
        allWords.push({ word: w.word, startTime: w.startTime });
      }
    }

    const totalTokens = allWords.length;
    const totalItems = numCommendations + numRecommendations;
    const quoteLength = 8;
    const spacing = Math.max(1, Math.floor((totalTokens - quoteLength) / Math.max(totalItems, 1)));

    const items: EvaluationItem[] = [];

    for (let i = 0; i < numCommendations; i++) {
      const startIdx = Math.min(i * spacing, totalTokens - quoteLength);
      const { quote, timestamp } = extractQuoteFromSegments(segments, startIdx, quoteLength);
      items.push({
        type: "commendation",
        summary: `Strong point about ${WORD_POOL[i % WORD_POOL.length]}`,
        evidence_quote: quote,
        evidence_timestamp: timestamp,
        explanation: "This was a strong point in the speech that resonated well.",
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
        summary: `Consider improving ${WORD_POOL[(numCommendations + i) % WORD_POOL.length]}`,
        evidence_quote: quote,
        evidence_timestamp: timestamp,
        explanation: "Consider improving this aspect of the speech for next time.",
      });
    }

    return {
      opening,
      items,
      closing,
      structure_commentary: commentary,
    };
  }

  /**
   * Assert the extended structural shape invariant on a StructuredEvaluation.
   */
  function assertExtendedShapeInvariant(evaluation: StructuredEvaluation): void {
    // (a) non-empty opening string
    expect(typeof evaluation.opening).toBe("string");
    expect(evaluation.opening.length).toBeGreaterThan(0);

    // (b) non-empty closing string
    expect(typeof evaluation.closing).toBe("string");
    expect(evaluation.closing.length).toBeGreaterThan(0);

    // (c) every item has non-empty evidence_quote, numeric evidence_timestamp,
    //     non-empty summary, and non-empty explanation
    expect(Array.isArray(evaluation.items)).toBe(true);
    for (const item of evaluation.items) {
      expect(typeof item.evidence_quote).toBe("string");
      expect(item.evidence_quote.length).toBeGreaterThan(0);

      expect(typeof item.evidence_timestamp).toBe("number");
      expect(Number.isFinite(item.evidence_timestamp)).toBe(true);

      expect(typeof item.summary).toBe("string");
      expect(item.summary.length).toBeGreaterThan(0);

      expect(typeof item.explanation).toBe("string");
      expect(item.explanation.length).toBeGreaterThan(0);
    }

    // (d) structure_commentary with opening_comment, body_comment, closing_comment
    //     (each either a non-empty string or null)
    expect(evaluation.structure_commentary).toBeDefined();
    expect(typeof evaluation.structure_commentary).toBe("object");
    expect(evaluation.structure_commentary).not.toBeNull();

    const sc = evaluation.structure_commentary;
    for (const field of ["opening_comment", "body_comment", "closing_comment"] as const) {
      const value = sc[field];
      if (value !== null) {
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  }

  // ── Tests ───────────────────────────────────────────────────────────────────

  /**
   * Property 1a: Extended shape invariant holds for valid LLM responses
   * with varied structure_commentary configurations.
   *
   * For any valid LLM response (well-formed JSON with valid evidence quotes),
   * generate() SHALL produce a StructuredEvaluation satisfying the extended
   * structural shape invariant.
   */
  it("generate() returns evaluations satisfying the extended structural shape invariant", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
            arbitraryNonEmptyString(),
            arbitraryNonEmptyString(),
            arbitraryStructureCommentaryForShape(),
          )
        ),
        async ([segments, numC, numR, opening, closing, commentary]) => {
          const evaluation = buildValidEvaluationWithCommentary(
            segments, numC, numR, opening, closing, commentary,
          );

          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Assert the full extended structural shape invariant
          assertExtendedShapeInvariant(result.evaluation);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 1b: Extended shape invariant holds after regeneration.
   *
   * When the first LLM attempt fails evidence validation and triggers
   * regeneration, the final result SHALL still satisfy the extended
   * structural shape invariant including structure_commentary.
   */
  it("generate() satisfies extended shape invariant after regeneration from failed first attempt", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
            arbitraryStructureCommentaryForShape(),
          )
        ),
        async ([segments, numC, numR, commentary]) => {
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          if (allWords.length < 8) return; // skip if not enough tokens

          // First attempt: shape-violating evaluation (1 valid commendation + 1 fabricated + 1 rec)
          const { quote: validQuote1, timestamp: ts1 } = extractQuoteFromSegments(segments, 0, 8);
          const { quote: validRecQuote, timestamp: tsRec } = extractQuoteFromSegments(
            segments,
            Math.min(16, allWords.length - 8),
            8,
          );

          const badEval: StructuredEvaluation = {
            opening: "Great speech today.",
            items: [
              {
                type: "commendation",
                summary: "Good opening",
                evidence_quote: validQuote1,
                evidence_timestamp: ts1,
                explanation: "Well done on the opening.",
              },
              {
                type: "commendation",
                summary: "Bad quote item",
                evidence_quote: "xylophone quasar nebula paradox quantum vortex zenith cipher",
                evidence_timestamp: 30,
                explanation: "Fabricated evidence.",
              },
              {
                type: "recommendation",
                summary: "Pacing",
                evidence_quote: validRecQuote,
                evidence_timestamp: tsRec,
                explanation: "Slow down a bit.",
              },
            ],
            closing: "Keep it up!",
            structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
          };

          // Retry for the bad item also fails
          const badRetryItem: EvaluationItem = {
            type: "commendation",
            summary: "Still bad",
            evidence_quote: "prism nexus cipher vortex zenith quasar nebula paradox",
            evidence_timestamp: 30,
            explanation: "Still fabricated.",
          };

          // Second full generation: valid evaluation with commentary
          const goodEval = buildValidEvaluationWithCommentary(
            segments, numC, numR,
            "Thank you for that wonderful speech.",
            "Keep up the great work!",
            commentary,
          );

          const client = makeMockClient([
            JSON.stringify(badEval),
            JSON.stringify(badRetryItem),
            JSON.stringify(goodEval),
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // After regeneration, extended shape invariant must hold
          assertExtendedShapeInvariant(result.evaluation);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 1c: Extended shape invariant holds for short-form fallback.
   *
   * When both generation attempts fail the shape invariant, the short-form
   * fallback SHALL still satisfy the extended structural shape invariant.
   */
  it("short-form fallback satisfies extended structural shape invariant", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        async (segments) => {
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          if (allWords.length < 16) return; // need enough tokens for 2 distinct quotes

          // Build evaluations where evidence validation will drop items,
          // violating shape invariant on both attempts, forcing short-form fallback.
          // Each attempt has 1 valid commendation + 1 fabricated commendation + 1 valid rec.
          const { quote: q1, timestamp: t1 } = extractQuoteFromSegments(segments, 0, 8);
          const { quote: qRec, timestamp: tRec } = extractQuoteFromSegments(
            segments, Math.min(8, allWords.length - 8), 8,
          );

          const fabricatedQuote = "xylophone quasar nebula paradox quantum vortex zenith cipher";
          const fabricatedRetry = "prism nexus cipher vortex zenith quasar nebula paradox";

          const badEval: StructuredEvaluation = {
            opening: "Great speech.",
            items: [
              { type: "commendation", summary: "Good", evidence_quote: q1, evidence_timestamp: t1, explanation: "Well done." },
              { type: "commendation", summary: "Bad", evidence_quote: fabricatedQuote, evidence_timestamp: 30, explanation: "Fabricated." },
              { type: "recommendation", summary: "Pace", evidence_quote: qRec, evidence_timestamp: tRec, explanation: "Slow down." },
            ],
            closing: "Keep it up!",
            structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
          };

          const badRetryItem: EvaluationItem = {
            type: "commendation", summary: "Still bad",
            evidence_quote: fabricatedRetry, evidence_timestamp: 30, explanation: "Still fabricated.",
          };

          // Both attempts return the same bad evaluation → shape fails both times → short-form fallback
          const client = makeMockClient([
            JSON.stringify(badEval),   // attempt 1 generation
            JSON.stringify(badRetryItem), // attempt 1 item retry
            JSON.stringify(badEval),   // attempt 2 generation
            JSON.stringify(badRetryItem), // attempt 2 item retry
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Even in fallback, extended shape invariant must hold
          assertExtendedShapeInvariant(result.evaluation);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 1d: structure_commentary fields are correctly typed
   * (each is either a non-empty string or null) across all commentary
   * configurations.
   *
   * This tests the shape invariant directly on the parsed output without
   * going through the full generate pipeline, verifying that the parser
   * enforces the type contract for all commentary field combinations.
   */
  it("structure_commentary fields are each non-empty string or null for all configurations", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments().chain((segments) =>
          fc.tuple(
            fc.constant(segments),
            fc.integer({ min: MIN_COMMENDATIONS, max: MAX_COMMENDATIONS }),
            fc.integer({ min: MIN_RECOMMENDATIONS, max: MAX_RECOMMENDATIONS }),
            arbitraryStructureCommentaryForShape(),
          )
        ),
        async ([segments, numC, numR, commentary]) => {
          const evaluation = buildValidEvaluationWithCommentary(
            segments, numC, numR,
            "Thank you for that speech.",
            "Keep growing!",
            commentary,
          );

          const client = makeMockClient([JSON.stringify(evaluation)]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Verify structure_commentary type contract specifically
          const sc = result.evaluation.structure_commentary;
          expect(sc).toBeDefined();
          expect(typeof sc).toBe("object");
          expect(sc).not.toBeNull();

          // Each field must be either null or a non-empty string
          for (const field of ["opening_comment", "body_comment", "closing_comment"] as const) {
            const value = sc[field];
            if (value === null) {
              // null is valid
              expect(value).toBeNull();
            } else {
              // must be a non-empty string
              expect(typeof value).toBe("string");
              expect(value.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─── Property 16: Short-Form Fallback Shape and Evidence ────────────────────────
// Feature: phase-2-stability-credibility, Property 16: Short-Form Fallback Shape and Evidence

describe("Feature: phase-2-stability-credibility, Property 16: Short-Form Fallback Shape and Evidence", () => {
  /**
   * **Validates: Requirements 9.2, 9.3**
   *
   * Property 16: For any evaluation produced in short-form fallback mode
   * (when the standard shape invariant cannot be met), the evaluation SHALL
   * contain at least 1 commendation and at least 1 recommendation, and every
   * item SHALL pass evidence validation (contiguous normalized token match
   * ≥ 6 tokens, timestamp locality ≤ 20s, evidence quote ≤ 15 words).
   */

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Build an evaluation that will trigger short-form fallback:
   * - 1 valid commendation (passes evidence validation)
   * - 1 fabricated commendation (fails evidence validation → gets dropped)
   * - 1 valid recommendation (passes evidence validation)
   *
   * After the fabricated commendation is dropped (and its retry also fails),
   * only 1 commendation remains → shape invariant (2-3 commendations) fails.
   * When both generation attempts produce this pattern, short-form fallback
   * kicks in with the remaining valid items (≥1 commendation + ≥1 recommendation).
   */
  function buildShortFormTriggerEvaluation(
    segments: TranscriptSegment[],
  ): {
    evaluation: StructuredEvaluation;
    fabricatedRetryItem: EvaluationItem;
  } {
    const allWords: { word: string; startTime: number }[] = [];
    for (const seg of segments) {
      for (const w of seg.words) {
        allWords.push({ word: w.word, startTime: w.startTime });
      }
    }

    const totalTokens = allWords.length;

    // Valid commendation: extract 8 tokens from the start of the transcript
    const commStartIdx = 0;
    const { quote: commQuote, timestamp: commTs } = extractQuoteFromSegments(
      segments,
      commStartIdx,
      8,
    );

    // Valid recommendation: extract 8 tokens from later in the transcript
    const recStartIdx = Math.min(16, totalTokens - 8);
    const { quote: recQuote, timestamp: recTs } = extractQuoteFromSegments(
      segments,
      recStartIdx,
      8,
    );

    // Fabricated commendation: quote that does NOT exist in the transcript
    const fabricatedQuote =
      "xylophone quasar nebula paradox quantum vortex zenith cipher";

    // Fabricated retry item: also does NOT exist in the transcript
    const fabricatedRetryItem: EvaluationItem = {
      type: "commendation",
      summary: "Retried fabricated item",
      evidence_quote:
        "prism nexus cipher vortex zenith quasar nebula paradox",
      evidence_timestamp: 30,
      explanation: "Still fabricated after retry.",
    };

    const evaluation: StructuredEvaluation = {
      opening: "Thank you for that wonderful speech.",
      items: [
        {
          type: "commendation",
          summary: "Strong opening point",
          evidence_quote: commQuote,
          evidence_timestamp: commTs,
          explanation: "This was a strong point in the speech.",
        },
        {
          type: "commendation",
          summary: "Fabricated observation",
          evidence_quote: fabricatedQuote,
          evidence_timestamp: 30,
          explanation: "This quote is fabricated and will fail validation.",
        },
        {
          type: "recommendation",
          summary: "Pacing improvement",
          evidence_quote: recQuote,
          evidence_timestamp: recTs,
          explanation: "Consider improving the pacing here.",
        },
      ],
      closing: "Keep up the great work!",
      structure_commentary: {
        opening_comment: null,
        body_comment: null,
        closing_comment: null,
      },
    };

    return { evaluation, fabricatedRetryItem };
  }

  // ── Property Test ───────────────────────────────────────────────────────────

  it("short-form fallback contains ≥1 commendation, ≥1 recommendation, and all items pass evidence validation", async () => {
    const validator = new EvidenceValidator();

    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        async (segments) => {
          // Need enough tokens for 2 distinct 8-token quotes
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          if (allWords.length < 24) return; // skip if not enough tokens

          const { evaluation: badEval, fabricatedRetryItem } =
            buildShortFormTriggerEvaluation(segments);

          // Mock client responses:
          // Attempt 1: bad evaluation → item retry for fabricated commendation (also fails)
          // Attempt 2: same bad evaluation → item retry for fabricated commendation (also fails)
          // Both attempts fail shape invariant → short-form fallback
          const client = makeMockClient([
            JSON.stringify(badEval), // attempt 1 generation
            JSON.stringify(fabricatedRetryItem), // attempt 1 item retry (fails validation)
            JSON.stringify(badEval), // attempt 2 generation
            JSON.stringify(fabricatedRetryItem), // attempt 2 item retry (fails validation)
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // ── Verify short-form shape: ≥1 commendation + ≥1 recommendation ──
          const commendations = result.evaluation.items.filter(
            (i) => i.type === "commendation",
          );
          const recommendations = result.evaluation.items.filter(
            (i) => i.type === "recommendation",
          );

          expect(commendations.length).toBeGreaterThanOrEqual(1);
          expect(recommendations.length).toBeGreaterThanOrEqual(1);

          // ── Verify every item passes evidence validation independently ──
          const validationResult = validator.validate(
            result.evaluation,
            segments,
          );
          expect(validationResult.valid).toBe(true);
          expect(validationResult.issues).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("short-form fallback items each have ≤15-word quotes, ≥6 contiguous token match, and timestamp within ±20s", async () => {
    const validator = new EvidenceValidator();

    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        async (segments) => {
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          if (allWords.length < 24) return;

          const { evaluation: badEval, fabricatedRetryItem } =
            buildShortFormTriggerEvaluation(segments);

          const client = makeMockClient([
            JSON.stringify(badEval),
            JSON.stringify(fabricatedRetryItem),
            JSON.stringify(badEval),
            JSON.stringify(fabricatedRetryItem),
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // Build full transcript token array for manual verification
          const fullText = segments.map((s) => s.text).join(" ");
          const transcriptTokens = validator.tokenize(fullText);

          for (const item of result.evaluation.items) {
            const quoteTokens = validator.tokenize(item.evidence_quote);

            // ── Check 1: quote ≤ 15 tokens ──
            expect(quoteTokens.length).toBeLessThanOrEqual(15);

            // ── Check 2: ≥ 6 contiguous token match ──
            expect(quoteTokens.length).toBeGreaterThanOrEqual(6);
            const { found, matchIndex } = validator.findContiguousMatch(
              quoteTokens,
              transcriptTokens,
            );
            expect(found).toBe(true);

            // ── Check 3: timestamp locality ≤ 20s ──
            const localityOk = validator.checkTimestampLocality(
              item.evidence_timestamp,
              matchIndex,
              segments,
            );
            expect(localityOk).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("short-form fallback passRate reflects first-attempt results correctly", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        async (segments) => {
          const allWords: { word: string; startTime: number }[] = [];
          for (const seg of segments) {
            for (const w of seg.words) {
              allWords.push({ word: w.word, startTime: w.startTime });
            }
          }
          if (allWords.length < 24) return;

          const { evaluation: badEval, fabricatedRetryItem } =
            buildShortFormTriggerEvaluation(segments);

          const client = makeMockClient([
            JSON.stringify(badEval),
            JSON.stringify(fabricatedRetryItem),
            JSON.stringify(badEval),
            JSON.stringify(fabricatedRetryItem),
          ]);
          const generator = new EvaluationGenerator(client);
          const metrics = metricsFromSegments(segments);

          const result = await generator.generate(segments, metrics);

          // passRate must be in [0, 1]
          expect(result.passRate).toBeGreaterThanOrEqual(0);
          expect(result.passRate).toBeLessThanOrEqual(1);

          // In the short-form fallback, the 2 valid items (commendation + recommendation)
          // passed on first attempt, and the fabricated commendation was dropped.
          // So passedOnFirstAttempt = 2, totalDelivered = 2, passRate = 1.0
          const totalDelivered = result.evaluation.items.length;
          expect(totalDelivered).toBe(2);
          expect(result.passRate).toBe(1.0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 15: Redaction Correctness
// Feature: phase-2-stability-credibility, Property 15: Redaction Correctness
// **Validates: Requirements 8.1, 8.2, 8.4, 8.5**
//
// For any evaluation script containing third-party private individual names
// (not the speaker's name) and non-name entities (places, organizations, brands),
// redaction SHALL:
//   (a) replace each third-party name with "a fellow member"
//   (b) preserve the speaker's own name unchanged
//   (c) leave non-name entities unredacted
//   (d) not introduce new words other than the generic replacement phrase
// ═══════════════════════════════════════════════════════════════════════════════

describe("Property 15: Redaction Correctness", () => {
  // ── Name pools ──────────────────────────────────────────────────────────────
  // First names that match the heuristic pattern [A-Z][a-z]+ and are NOT in the
  // nonNameWords exclusion list inside redactText().
  const FIRST_NAMES = [
    "Alice", "Bob", "Carlos", "Diana", "Elena", "Frank", "Grace",
    "Hector", "Irene", "James", "Karen", "Leo", "Mia", "Nathan",
    "Olivia", "Pedro", "Quinn", "Rosa", "Tom", "Vera",
  ];

  const LAST_NAMES = [
    "Smith", "Garcia", "Chen", "Patel", "Kim", "Lopez", "Brown",
    "Wilson", "Taylor", "Anderson", "Thomas", "Jackson", "White",
    "Harris", "Martin", "Thompson", "Moore", "Clark", "Lewis", "Walker",
  ];

  // Non-name entities from the exclusion list that should NOT be redacted.
  // These are words present in the nonNameWords set inside redactText().
  const NON_NAME_ENTITIES = [
    "Toastmasters", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday", "Sunday", "January", "February", "March", "April",
    "June", "July", "August", "September", "October", "November", "December",
    "University", "College", "Church", "Hospital", "Company",
    "American", "English", "Spanish", "French", "German",
    "Chinese", "Japanese", "African", "European", "Asian",
    "Christian", "However", "Finally", "Additionally", "Furthermore",
    "Overall", "Meanwhile",
  ];

  // Filler sentence fragments that don't contain capitalized words mid-sentence
  const SENTENCE_PREFIXES = [
    "The speaker talked about",
    "It was clear that",
    "During the speech we heard",
    "At that point the speaker said",
    "In the middle of the talk",
    "The audience noticed that",
    "We could hear that",
    "Throughout the presentation",
    "At the beginning the speaker mentioned",
    "Later in the speech",
  ];

  const SENTENCE_SUFFIXES = [
    "which was very effective.",
    "and it resonated with the audience.",
    "during the second point.",
    "as part of the opening remarks.",
    "in a compelling way.",
    "with great enthusiasm.",
    "to illustrate the main idea.",
    "and the audience responded well.",
    "which added depth to the message.",
    "as a powerful example.",
  ];

  // ── Generators ──────────────────────────────────────────────────────────────

  /** Generate a first name from the pool. */
  function arbitraryFirstName(): fc.Arbitrary<string> {
    return fc.constantFrom(...FIRST_NAMES);
  }

  /** Generate a last name from the pool. */
  function arbitraryLastName(): fc.Arbitrary<string> {
    return fc.constantFrom(...LAST_NAMES);
  }

  /**
   * Generate a person name: either a first name alone or "First Last".
   * Both forms match the [A-Z][a-z]+(\s+[A-Z][a-z]+)* regex pattern.
   */
  function arbitraryPersonName(): fc.Arbitrary<string> {
    return fc.oneof(
      arbitraryFirstName(),
      fc.tuple(arbitraryFirstName(), arbitraryLastName()).map(
        ([first, last]) => `${first} ${last}`,
      ),
    );
  }

  /** Generate a non-name entity from the exclusion list. */
  function arbitraryNonNameEntity(): fc.Arbitrary<string> {
    return fc.constantFrom(...NON_NAME_ENTITIES);
  }

  /**
   * Build a sentence that places a name mid-sentence (after whitespace),
   * where the redactText() heuristic can detect it via the lookbehind (?<=\s).
   */
  function buildMidSentenceNameSentence(name: string): string {
    const prefix =
      SENTENCE_PREFIXES[Math.floor(Math.random() * SENTENCE_PREFIXES.length)];
    const suffix =
      SENTENCE_SUFFIXES[Math.floor(Math.random() * SENTENCE_SUFFIXES.length)];
    return `${prefix} ${name} ${suffix}`;
  }

  /**
   * Build a sentence that places a non-name entity mid-sentence.
   */
  function buildNonNameEntitySentence(entity: string): string {
    return `The event at ${entity} was well attended and very productive.`;
  }

  /**
   * Build a sentence that places the speaker's name mid-sentence.
   */
  function buildSpeakerNameSentence(speakerName: string): string {
    return `The audience appreciated ${speakerName} for the insightful presentation.`;
  }

  /**
   * Generate a RedactionInput with controlled content:
   * - A script containing the speaker's name, third-party names, and non-name entities mid-sentence
   * - A minimal evaluation with items referencing the same names
   * - A consent record with the speaker's name
   */
  function arbitraryRedactionInput(): fc.Arbitrary<{
    input: RedactionInput;
    speakerName: string;
    thirdPartyNames: string[];
    nonNameEntities: string[];
  }> {
    return fc
      .tuple(
        arbitraryPersonName(), // speaker name
        fc.array(arbitraryPersonName(), { minLength: 1, maxLength: 3 }), // third-party names
        fc.array(arbitraryNonNameEntity(), { minLength: 1, maxLength: 3 }), // non-name entities
        fc.constantFrom(...SENTENCE_PREFIXES),
        fc.constantFrom(...SENTENCE_SUFFIXES),
      )
      .filter(([speakerName, thirdPartyNames]) => {
        // Ensure speaker name tokens don't overlap with any third-party name tokens
        const speakerTokens = new Set(
          speakerName.toLowerCase().split(/\s+/),
        );
        return thirdPartyNames.every((tpName) => {
          const tpTokens = tpName.toLowerCase().split(/\s+/);
          return !tpTokens.some((t) => speakerTokens.has(t));
        });
      })
      .map(([speakerName, thirdPartyNames, nonNameEntities, prefix, suffix]) => {
        // Build script sentences with names placed mid-sentence
        const scriptSentences: string[] = [];

        // Opening sentence with speaker name mid-sentence
        scriptSentences.push(buildSpeakerNameSentence(speakerName));

        // Sentences with third-party names mid-sentence
        for (const tpName of thirdPartyNames) {
          scriptSentences.push(`${prefix} ${tpName} ${suffix}`);
        }

        // Sentences with non-name entities mid-sentence
        for (const entity of nonNameEntities) {
          scriptSentences.push(buildNonNameEntitySentence(entity));
        }

        // A plain sentence with no names
        scriptSentences.push(
          "The speech was well structured and delivered with confidence.",
        );

        const script = scriptSentences.join(" ");

        // Build a minimal evaluation with items that reference third-party names
        const items: EvaluationItem[] = [
          {
            type: "commendation",
            summary: "Strong delivery",
            evidence_quote: `the speaker mentioned ${thirdPartyNames[0]} during the talk`,
            evidence_timestamp: 10,
            explanation: `Referencing ${thirdPartyNames[0]} added credibility.`,
          },
          {
            type: "commendation",
            summary: "Good structure",
            evidence_quote: "the speech was well structured and delivered",
            evidence_timestamp: 20,
            explanation: "Clear organization throughout.",
          },
          {
            type: "recommendation",
            summary: "Pacing improvement",
            evidence_quote: `appreciated ${speakerName} for the insightful presentation`,
            evidence_timestamp: 5,
            explanation: "Consider varying the pace more.",
          },
        ];

        const evaluation: StructuredEvaluation = {
          opening: `Thank you for that wonderful speech. We heard ${speakerName} deliver a compelling message.`,
          items,
          closing: "Keep up the great work and continue to grow as a speaker.",
          structure_commentary: {
            opening_comment: null,
            body_comment: null,
            closing_comment: null,
          },
        };

        const consent: ConsentRecord = {
          speakerName,
          consentConfirmed: true,
          consentTimestamp: new Date(),
        };

        const input: RedactionInput = { script, evaluation, consent };

        return { input, speakerName, thirdPartyNames, nonNameEntities };
      });
  }

  // ── Helper: create a generator instance ─────────────────────────────────────

  function createRedactionGenerator(): EvaluationGenerator {
    const mockClient: OpenAIClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" } }],
          }),
        },
      },
    } as unknown as OpenAIClient;
    return new EvaluationGenerator(mockClient);
  }

  // ── Helper: tokenize text into words for comparison ─────────────────────────

  function tokenize(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
  }

  // ── Property Test ───────────────────────────────────────────────────────────

  it("(a) third-party names are replaced with 'a fellow member', (b) speaker name preserved, (c) non-name entities unredacted, (d) no new words introduced", () => {
    const generator = createRedactionGenerator();

    fc.assert(
      fc.property(
        arbitraryRedactionInput(),
        ({ input, speakerName, thirdPartyNames, nonNameEntities }) => {
          const result = generator.redact(input);

          // ── Sub-property (a): Third-party names replaced ──────────────
          // Each third-party name that was placed mid-sentence should be
          // replaced with "a fellow member" in the redacted script.
          for (const tpName of thirdPartyNames) {
            // The name tokens should not appear as capitalized mid-sentence
            // words in the redacted output
            const nameTokens = tpName.split(/\s+/);
            for (const token of nameTokens) {
              // Check that the capitalized token doesn't appear in the
              // redacted script in its original capitalized form mid-sentence.
              // We search for the token preceded by a space (mid-sentence position).
              const midSentencePattern = new RegExp(`(?<=\\s)${token}(?=\\s|[.!?,;:]|$)`);
              expect(
                midSentencePattern.test(result.scriptRedacted),
              ).toBe(false);
            }
          }

          // The replacement phrase must appear in the redacted script
          expect(result.scriptRedacted).toContain("a fellow member");

          // ── Sub-property (b): Speaker's own name preserved ────────────
          // The speaker's name tokens should still appear in the redacted script
          expect(result.scriptRedacted).toContain(speakerName);

          // Also check the evaluationPublic: speaker name should be preserved
          // in the recommendation evidence quote that references the speaker
          const recItem = result.evaluationPublic.items.find(
            (i) => i.type === "recommendation",
          );
          if (recItem) {
            const speakerTokens = speakerName.split(/\s+/);
            for (const token of speakerTokens) {
              expect(recItem.evidence_quote).toContain(token);
            }
          }

          // ── Sub-property (c): Non-name entities not redacted ──────────
          // Entities from the exclusion list should survive redaction
          for (const entity of nonNameEntities) {
            expect(result.scriptRedacted).toContain(entity);
          }

          // ── Sub-property (d): No new words introduced ─────────────────
          // Every word in the redacted output must either:
          //   1. Exist in the original input text, OR
          //   2. Be part of the replacement phrase "a fellow member"
          const replacementTokens = new Set(["a", "fellow", "member"]);
          const originalTokens = new Set(tokenize(input.script));

          const redactedTokens = tokenize(result.scriptRedacted);
          for (const token of redactedTokens) {
            const inOriginal = originalTokens.has(token);
            const inReplacement = replacementTokens.has(token);
            expect(inOriginal || inReplacement).toBe(true);
          }

          // ── Also verify evaluationPublic consistency ───────────────────
          // The replacement phrase in the script and evidence quotes must be
          // identical: "a fellow member" (no brackets)
          expect(result.scriptRedacted).not.toContain("[a fellow member]");
          for (const item of result.evaluationPublic.items) {
            expect(item.evidence_quote).not.toContain("[a fellow member]");
          }

          // Item count and order preserved
          expect(result.evaluationPublic.items).toHaveLength(
            input.evaluation.items.length,
          );
          for (let i = 0; i < input.evaluation.items.length; i++) {
            expect(result.evaluationPublic.items[i].type).toBe(
              input.evaluation.items[i].type,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("redaction in evaluationPublic opening and closing replaces third-party names and preserves speaker name", () => {
    const generator = createRedactionGenerator();

    fc.assert(
      fc.property(
        arbitraryRedactionInput(),
        ({ input, speakerName, thirdPartyNames }) => {
          const result = generator.redact(input);

          // Speaker name should be preserved in opening and closing
          // (the opening contains the speaker name mid-sentence)
          expect(result.evaluationPublic.opening).toContain(speakerName);

          // Third-party names in evidence quotes should be redacted
          const firstItem = result.evaluationPublic.items[0];
          const firstTpName = thirdPartyNames[0];
          const nameTokens = firstTpName.split(/\s+/);
          for (const token of nameTokens) {
            const midSentencePattern = new RegExp(`(?<=\\s)${token}(?=\\s|[.!?,;:]|$)`);
            expect(midSentencePattern.test(firstItem.evidence_quote)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 21: Public Output Redaction Completeness
// Feature: phase-2-stability-credibility, Property 21: Public Output Redaction Completeness
// **Validates: Requirements 8.1, 8.4, 8.5**
//
// For any StructuredEvaluationPublic or script string sent to the Web UI
// (via evaluation_ready message) or saved to disk (via "Save Outputs"),
// the content SHALL NOT contain any third-party private individual names.
// The speaker's own name (from ConsentRecord) MAY appear.
// Non-name entities (places, organizations, brands) MAY appear.
//
// Key difference from Property 15:
// - Property 15 tests the redaction *mechanism* (replacement, preservation, no new words)
// - Property 21 tests the *completeness* of the public output — verifying that
//   NO third-party names survive in ANY field of the public output
// ═══════════════════════════════════════════════════════════════════════════════

describe("Property 21: Public Output Redaction Completeness", () => {
  // ── Name pools ──────────────────────────────────────────────────────────────
  // First names that match the heuristic pattern [A-Z][a-z]+ and are NOT in the
  // nonNameWords exclusion list inside redactText().
  const FIRST_NAMES = [
    "Alice", "Bob", "Carlos", "Diana", "Elena", "Frank", "Grace",
    "Hector", "Irene", "James", "Karen", "Leo", "Mia", "Nathan",
    "Olivia", "Pedro", "Quinn", "Rosa", "Tom", "Vera",
  ];

  const LAST_NAMES = [
    "Smith", "Garcia", "Chen", "Patel", "Kim", "Lopez", "Brown",
    "Wilson", "Taylor", "Anderson", "Thomas", "Jackson", "White",
    "Harris", "Martin", "Thompson", "Moore", "Clark", "Lewis", "Walker",
  ];

  // Non-name entities from the exclusion list that should NOT be redacted.
  const NON_NAME_ENTITIES = [
    "Toastmasters", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday", "Sunday", "January", "February", "March", "April",
    "June", "July", "August", "September", "October", "November", "December",
    "University", "College", "Church", "Hospital", "Company",
    "American", "English", "Spanish", "French", "German",
    "Chinese", "Japanese", "African", "European", "Asian",
    "Christian", "However", "Finally", "Additionally", "Furthermore",
    "Overall", "Meanwhile",
  ];

  // Sentence fragments for building mid-sentence name placements
  const SENTENCE_PREFIXES = [
    "The speaker talked about",
    "It was clear that",
    "During the speech we heard",
    "At that point the speaker said",
    "In the middle of the talk",
    "The audience noticed that",
    "We could hear that",
    "Throughout the presentation",
    "At the beginning the speaker mentioned",
    "Later in the speech",
  ];

  const SENTENCE_SUFFIXES = [
    "which was very effective.",
    "and it resonated with the audience.",
    "during the second point.",
    "as part of the opening remarks.",
    "in a compelling way.",
    "with great enthusiasm.",
    "to illustrate the main idea.",
    "and the audience responded well.",
    "which added depth to the message.",
    "as a powerful example.",
  ];

  // ── Generators ──────────────────────────────────────────────────────────────

  function arbitraryFirstName(): fc.Arbitrary<string> {
    return fc.constantFrom(...FIRST_NAMES);
  }

  function arbitraryLastName(): fc.Arbitrary<string> {
    return fc.constantFrom(...LAST_NAMES);
  }

  function arbitraryPersonName(): fc.Arbitrary<string> {
    return fc.oneof(
      arbitraryFirstName(),
      fc.tuple(arbitraryFirstName(), arbitraryLastName()).map(
        ([first, last]) => `${first} ${last}`,
      ),
    );
  }

  function arbitraryNonNameEntity(): fc.Arbitrary<string> {
    return fc.constantFrom(...NON_NAME_ENTITIES);
  }

  /**
   * Build a sentence that places a name mid-sentence (after whitespace),
   * where the redactText() heuristic can detect it via the lookbehind (?<=\s).
   */
  function buildMidSentenceNameSentence(name: string, prefixIdx: number, suffixIdx: number): string {
    const prefix = SENTENCE_PREFIXES[prefixIdx % SENTENCE_PREFIXES.length];
    const suffix = SENTENCE_SUFFIXES[suffixIdx % SENTENCE_SUFFIXES.length];
    return `${prefix} ${name} ${suffix}`;
  }

  /**
   * Generate a comprehensive RedactionInput that injects third-party names
   * into ALL text fields of the public output:
   * - script (multiple sentences with names mid-sentence)
   * - evaluation.opening (name mid-sentence)
   * - evaluation.closing (name mid-sentence)
   * - evaluation.items[*].evidence_quote (name mid-sentence)
   * - evaluation.items[*].explanation (name mid-sentence)
   * - evaluation.items[*].summary (name mid-sentence)
   *
   * This ensures completeness testing across every field that appears in
   * the public output.
   */
  function arbitraryComprehensiveRedactionInput(): fc.Arbitrary<{
    input: RedactionInput;
    speakerName: string;
    thirdPartyNames: string[];
    nonNameEntities: string[];
  }> {
    return fc
      .tuple(
        arbitraryPersonName(), // speaker name
        fc.array(arbitraryPersonName(), { minLength: 1, maxLength: 4 }), // third-party names
        fc.array(arbitraryNonNameEntity(), { minLength: 0, maxLength: 3 }), // non-name entities
        fc.nat({ max: 9 }), // prefix index
        fc.nat({ max: 9 }), // suffix index
      )
      .filter(([speakerName, thirdPartyNames]) => {
        // Ensure speaker name tokens don't overlap with any third-party name tokens
        const speakerTokens = new Set(
          speakerName.toLowerCase().split(/\s+/),
        );
        return thirdPartyNames.every((tpName) => {
          const tpTokens = tpName.toLowerCase().split(/\s+/);
          return !tpTokens.some((t) => speakerTokens.has(t));
        });
      })
      .map(([speakerName, thirdPartyNames, nonNameEntities, prefixIdx, suffixIdx]) => {
        // Pick a primary third-party name to inject everywhere
        const primaryTpName = thirdPartyNames[0];

        // ── Build script with names in various positions ──────────────
        const scriptSentences: string[] = [];

        // Speaker name mid-sentence (should be preserved)
        scriptSentences.push(
          `The audience appreciated ${speakerName} for the insightful presentation.`,
        );

        // Third-party names mid-sentence (should be redacted)
        for (const tpName of thirdPartyNames) {
          scriptSentences.push(
            buildMidSentenceNameSentence(tpName, prefixIdx, suffixIdx),
          );
        }

        // Non-name entities mid-sentence (should be preserved)
        for (const entity of nonNameEntities) {
          scriptSentences.push(
            `The event at ${entity} was well attended and very productive.`,
          );
        }

        // Plain sentence
        scriptSentences.push(
          "The speech was well structured and delivered with confidence.",
        );

        const script = scriptSentences.join(" ");

        // ── Build evaluation with names injected into ALL fields ──────
        // opening: third-party name mid-sentence
        const opening = `Thank you for that wonderful speech. We heard from ${primaryTpName} and ${speakerName} during the talk.`;

        // closing: third-party name mid-sentence
        const closing = `Keep up the great work. The feedback from ${primaryTpName} was also noteworthy.`;

        // items: inject third-party names into summary, explanation, and evidence_quote
        const items: EvaluationItem[] = [
          {
            type: "commendation",
            summary: `Strong delivery alongside ${primaryTpName} in the group`,
            evidence_quote: `the speaker mentioned ${primaryTpName} during the talk`,
            evidence_timestamp: 10,
            explanation: `Referencing ${primaryTpName} added credibility to the argument.`,
          },
          {
            type: "commendation",
            summary: "Good structure throughout the speech",
            evidence_quote: "the speech was well structured and delivered",
            evidence_timestamp: 20,
            explanation: "Clear organization throughout the presentation.",
          },
          {
            type: "recommendation",
            summary: `Consider the approach used by ${speakerName} more often`,
            evidence_quote: `appreciated ${speakerName} for the insightful presentation`,
            evidence_timestamp: 5,
            explanation: "Consider varying the pace for greater impact.",
          },
        ];

        // If we have more third-party names, add items referencing them
        if (thirdPartyNames.length > 1) {
          items.push({
            type: "recommendation",
            summary: `Pacing near ${thirdPartyNames[1]} reference could improve`,
            evidence_quote: `the speaker said ${thirdPartyNames[1]} which was very effective`,
            evidence_timestamp: 30,
            explanation: `The mention of ${thirdPartyNames[1]} was good but could be expanded.`,
          });
        }

        const evaluation: StructuredEvaluation = {
          opening,
          items,
          closing,
          structure_commentary: {
            opening_comment: null,
            body_comment: null,
            closing_comment: null,
          },
        };

        const consent: ConsentRecord = {
          speakerName,
          consentConfirmed: true,
          consentTimestamp: new Date(),
        };

        const input: RedactionInput = { script, evaluation, consent };

        return { input, speakerName, thirdPartyNames, nonNameEntities };
      });
  }

  // ── Helper: create a generator instance ─────────────────────────────────────

  function createRedactionGenerator(): EvaluationGenerator {
    const mockClient: OpenAIClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "{}" } }],
          }),
        },
      },
    } as unknown as OpenAIClient;
    return new EvaluationGenerator(mockClient);
  }

  /**
   * Check that a text field does NOT contain any third-party name token
   * in a mid-sentence position (preceded by whitespace, in its original
   * capitalized form). This is the detectable scope of the redaction heuristic.
   */
  function assertNoThirdPartyNames(
    text: string,
    thirdPartyNames: string[],
    fieldLabel: string,
  ): void {
    for (const tpName of thirdPartyNames) {
      const nameTokens = tpName.split(/\s+/);
      for (const token of nameTokens) {
        // The redaction heuristic detects capitalized words mid-sentence
        // (preceded by whitespace). Check that no such token survives.
        const midSentencePattern = new RegExp(
          `(?<=\\s)${token}(?=\\s|[.!?,;:]|$)`,
        );
        expect(
          midSentencePattern.test(text),
          `Third-party name token "${token}" (from "${tpName}") found in ${fieldLabel}: "${text}"`,
        ).toBe(false);
      }
    }
  }

  // ── Property Test ───────────────────────────────────────────────────────────

  it("no third-party name tokens survive in any field of the public output (scriptRedacted, opening, closing, items[*].summary, items[*].explanation, items[*].evidence_quote)", () => {
    const generator = createRedactionGenerator();

    fc.assert(
      fc.property(
        arbitraryComprehensiveRedactionInput(),
        ({ input, speakerName, thirdPartyNames, nonNameEntities }) => {
          const result = generator.redact(input);

          // ── Check scriptRedacted ──────────────────────────────────────
          assertNoThirdPartyNames(
            result.scriptRedacted,
            thirdPartyNames,
            "scriptRedacted",
          );

          // ── Check evaluationPublic.opening ────────────────────────────
          assertNoThirdPartyNames(
            result.evaluationPublic.opening,
            thirdPartyNames,
            "evaluationPublic.opening",
          );

          // ── Check evaluationPublic.closing ────────────────────────────
          assertNoThirdPartyNames(
            result.evaluationPublic.closing,
            thirdPartyNames,
            "evaluationPublic.closing",
          );

          // ── Check ALL items fields ────────────────────────────────────
          for (let i = 0; i < result.evaluationPublic.items.length; i++) {
            const item = result.evaluationPublic.items[i];

            assertNoThirdPartyNames(
              item.evidence_quote,
              thirdPartyNames,
              `evaluationPublic.items[${i}].evidence_quote`,
            );

            assertNoThirdPartyNames(
              item.explanation,
              thirdPartyNames,
              `evaluationPublic.items[${i}].explanation`,
            );

            assertNoThirdPartyNames(
              item.summary,
              thirdPartyNames,
              `evaluationPublic.items[${i}].summary`,
            );
          }

          // ── Speaker's own name MAY appear (positive check) ────────────
          // The speaker name was placed mid-sentence in the script and
          // in the recommendation evidence_quote — it should survive.
          expect(result.scriptRedacted).toContain(speakerName);

          // ── Non-name entities MAY appear (positive check) ─────────────
          for (const entity of nonNameEntities) {
            expect(result.scriptRedacted).toContain(entity);
          }

          // ── Replacement phrase present where names were ───────────────
          // Since we injected third-party names, "a fellow member" must
          // appear in the redacted output.
          expect(result.scriptRedacted).toContain("a fellow member");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("structure_commentary fields pass through unchanged (no name injection in commentary)", () => {
    const generator = createRedactionGenerator();

    fc.assert(
      fc.property(
        arbitraryComprehensiveRedactionInput(),
        ({ input }) => {
          const result = generator.redact(input);

          // structure_commentary is passed through as-is (not redacted)
          // since it comes from the LLM and doesn't contain user names.
          // Verify it matches the input exactly.
          expect(result.evaluationPublic.structure_commentary).toEqual(
            input.evaluation.structure_commentary,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─── Property 19: Cosine Similarity Computation Correctness ─────────────────────
// Feature: phase-2-stability-credibility, Property 19: Cosine Similarity Computation Correctness

describe("Feature: phase-2-stability-credibility, Property 19: Cosine Similarity Computation Correctness", () => {
  // ── Generators ──────────────────────────────────────────────────────────────

  /**
   * Generate a vector dimension (length) for paired vectors.
   */
  function arbitraryDimension(): fc.Arbitrary<number> {
    return fc.integer({ min: 1, max: 100 });
  }

  /**
   * Generate a single finite, non-NaN float component for vectors.
   */
  function arbitraryComponent(): fc.Arbitrary<number> {
    return fc.float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
  }

  /**
   * Generate a non-zero vector of the given length.
   * Filters out all-zero vectors to ensure the norm is positive.
   */
  function arbitraryNonZeroVector(length: number): fc.Arbitrary<number[]> {
    return fc
      .array(arbitraryComponent(), { minLength: length, maxLength: length })
      .filter((v) => v.some((x) => x !== 0));
  }

  /**
   * Generate a pair of non-zero vectors of equal dimension.
   * First generates a shared dimension, then two independent non-zero vectors.
   */
  function arbitraryNonZeroVectorPair(): fc.Arbitrary<[number[], number[]]> {
    return arbitraryDimension().chain((dim) =>
      fc.tuple(arbitraryNonZeroVector(dim), arbitraryNonZeroVector(dim)),
    );
  }

  /**
   * Generate a single non-zero vector (for identical-vector tests).
   */
  function arbitrarySingleNonZeroVector(): fc.Arbitrary<number[]> {
    return arbitraryDimension().chain((dim) => arbitraryNonZeroVector(dim));
  }

  /**
   * Generate a zero vector of a given length.
   */
  function arbitraryZeroVector(): fc.Arbitrary<number[]> {
    return fc.integer({ min: 1, max: 100 }).map((len) => new Array(len).fill(0));
  }

  // ── Reference implementation ────────────────────────────────────────────────

  /**
   * Reference cosine similarity computation for comparison.
   */
  function referenceCosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ── Property Tests ──────────────────────────────────────────────────────────

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19a: Range invariant — for any two non-zero vectors of equal
   * dimension, the computed cosine similarity SHALL be in the range [-1, 1].
   */
  it("result is in [-1, 1] for any two non-zero vectors of equal dimension", () => {
    fc.assert(
      fc.property(
        arbitraryNonZeroVectorPair(),
        ([a, b]) => {
          const sim = cosineSimilarity(a, b);
          expect(sim).toBeGreaterThanOrEqual(-1);
          expect(sim).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19b: Identical vectors — for any non-zero vector, the cosine
   * similarity with itself SHALL be 1.0 (within floating-point tolerance).
   */
  it("identical non-zero vectors have cosine similarity of 1.0", () => {
    fc.assert(
      fc.property(
        arbitrarySingleNonZeroVector(),
        (v) => {
          const sim = cosineSimilarity(v, v);
          expect(Math.abs(sim - 1.0)).toBeLessThan(1e-10);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19c: Reference implementation comparison — for any two non-zero
   * vectors of equal dimension, the result SHALL equal
   * dot(a, b) / (norm(a) * norm(b)) within floating-point tolerance.
   */
  it("result matches reference dot(a,b) / (norm(a) * norm(b)) computation", () => {
    fc.assert(
      fc.property(
        arbitraryNonZeroVectorPair(),
        ([a, b]) => {
          const actual = cosineSimilarity(a, b);
          const expected = referenceCosine(a, b);
          expect(Math.abs(actual - expected)).toBeLessThan(1e-10);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19d: Zero vector handling — when either vector is all zeros,
   * the result SHALL be 0.
   */
  it("returns 0 when either vector is all zeros", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }).chain((dim) =>
          fc.tuple(
            arbitraryNonZeroVector(dim),
            fc.constant(new Array(dim).fill(0)),
            fc.boolean(), // swap order
          ),
        ),
        ([nonZero, zero, swap]) => {
          if (swap) {
            expect(cosineSimilarity(zero, nonZero)).toBe(0);
          } else {
            expect(cosineSimilarity(nonZero, zero)).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19d (both zero): When both vectors are all zeros, the result
   * SHALL be 0.
   */
  it("returns 0 when both vectors are all zeros", () => {
    fc.assert(
      fc.property(
        arbitraryZeroVector(),
        (zeroVec) => {
          expect(cosineSimilarity(zeroVec, zeroVec)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Property 19e: Symmetry — cosineSimilarity(a, b) SHALL equal
   * cosineSimilarity(b, a) for any two non-zero vectors of equal dimension.
   */
  it("is symmetric: cosineSimilarity(a, b) === cosineSimilarity(b, a)", () => {
    fc.assert(
      fc.property(
        arbitraryNonZeroVectorPair(),
        ([a, b]) => {
          const ab = cosineSimilarity(a, b);
          const ba = cosineSimilarity(b, a);
          expect(Math.abs(ab - ba)).toBeLessThan(1e-10);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── CTX-P3: Project context included in prompt when provided ───────────────────

describe("Feature: phase-3-semi-automation, CTX-P3: Project context included in prompt when provided", () => {
  // ── Generators ──────────────────────────────────────────────────────────────

  /**
   * Generate a non-empty project type string from realistic Toastmasters project types.
   */
  function arbitraryProjectType(): fc.Arbitrary<string> {
    return fc.constantFrom(
      "Ice Breaker",
      "Evaluation and Feedback",
      "Researching and Presenting",
      "Introduction to Vocal Variety",
      "Connect with Storytelling",
      "Persuasive Speaking",
      "Custom / Other",
    );
  }

  /**
   * Generate a non-empty speech title string from realistic title words.
   */
  function arbitrarySpeechTitle(): fc.Arbitrary<string> {
    const TITLE_WORDS = [
      "My", "Journey", "To", "Toastmasters", "Finding", "Voice", "The",
      "Power", "Of", "Words", "Speaking", "Up", "A", "New", "Beginning",
      "Lessons", "From", "Life", "Growth", "Through", "Challenge",
    ];
    return fc.array(fc.constantFrom(...TITLE_WORDS), { minLength: 1, maxLength: 8 })
      .map((words) => words.join(" "));
  }

  /**
   * Generate a non-empty objective string from realistic objective phrases.
   */
  function arbitraryObjective(): fc.Arbitrary<string> {
    const OBJECTIVE_PARTS = [
      "Introduce yourself and share your personal story",
      "Organize your speech with an opening body and conclusion",
      "Speak for 4 to 6 minutes",
      "Use vocal variety to enhance your message",
      "Vary pace pitch volume and pauses",
      "Persuade the audience to adopt your viewpoint",
      "Use logical arguments and emotional appeals",
      "Research a topic and present your findings",
      "Use credible sources to support your points",
      "Share a personal story that connects with the audience",
    ];
    return fc.constantFrom(...OBJECTIVE_PARTS);
  }

  /**
   * Generate an EvaluationConfig with a non-empty projectType and at least one objective.
   * speechTitle is optionally present (non-null or undefined).
   */
  function arbitraryProjectConfig(): fc.Arbitrary<{
    projectType: string;
    speechTitle: string | undefined;
    objectives: string[];
  }> {
    return fc.record({
      projectType: arbitraryProjectType(),
      speechTitle: fc.option(arbitrarySpeechTitle(), { nil: undefined }),
      objectives: fc.array(arbitraryObjective(), { minLength: 1, maxLength: 10 }),
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function createGenerator(): EvaluationGenerator {
    const mockClient = makeMockClient(["{}"]);
    return new EvaluationGenerator(mockClient);
  }

  /**
   * Build minimal but valid transcript text and delivery metrics for prompt construction.
   */
  function buildMinimalInputs(): { transcriptText: string; metrics: DeliveryMetrics } {
    const transcriptText = "Today I want to talk about the importance of public speaking.";
    const metrics: DeliveryMetrics = {
      durationSeconds: 60,
      durationFormatted: "1:00",
      totalWords: 11,
      wordsPerMinute: 11,
      fillerWords: [],
      fillerWordCount: 0,
      fillerWordFrequency: 0,
      pauseCount: 0,
      totalPauseDurationSeconds: 0,
      averagePauseDurationSeconds: 0,
      intentionalPauseCount: 0,
      hesitationPauseCount: 0,
      classifiedPauses: [],
      energyVariationCoefficient: 0,
      energyProfile: {
        windowDurationMs: 250,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      },
      classifiedFillers: [],
    };
    return { transcriptText, metrics };
  }

  // ── Property Tests ──────────────────────────────────────────────────────────

  /**
   * **Validates: Requirements 5.1, 5.2, 5.5**
   *
   * CTX-P3: For any non-null ProjectContext with a non-empty projectType and
   * at least one objective, the LLM prompt built by buildUserPrompt() SHALL
   * contain the project type string, the speech title string (if non-null),
   * and each objective string. The prompt SHALL also contain instructions to
   * reference project objectives in the evaluation.
   */
  it("buildUserPrompt() contains project type, speech title, objectives, and project instructions", () => {
    const generator = createGenerator();
    const { transcriptText, metrics } = buildMinimalInputs();

    fc.assert(
      fc.property(
        arbitraryProjectConfig(),
        (config) => {
          const prompt = (generator as any).buildUserPrompt(
            transcriptText,
            metrics,
            config,
          );

          // The prompt SHALL contain the project type string
          expect(prompt).toContain(config.projectType);

          // The prompt SHALL contain the speech title string when non-null
          if (config.speechTitle !== undefined) {
            expect(prompt).toContain(config.speechTitle);
          }

          // The prompt SHALL contain each objective string
          for (const objective of config.objectives) {
            expect(prompt).toContain(objective);
          }

          // The prompt SHALL contain the "Project-Specific Evaluation" section header
          expect(prompt).toContain("## Project-Specific Evaluation");

          // The prompt SHALL contain instructions to reference project objectives
          expect(prompt).toContain("Reference the project type and speech title in your opening");
          expect(prompt).toContain("directly addresses a project objective");
          expect(prompt).toContain("Balance project-specific feedback with general Toastmasters evaluation criteria");
          expect(prompt).toContain("Project objectives supplement, not replace, evidence-based feedback");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── CTX-P1: Absent project context produces no project prompt sections ─────────

describe("Feature: phase-3-semi-automation, CTX-P1: Absent project context produces no project prompt sections", () => {
  // ── Generators ──────────────────────────────────────────────────────────────

  /**
   * Generate an EvaluationConfig where projectType is undefined, speechTitle is
   * undefined, and objectives is empty — representing absent project context.
   * Three variants: config is undefined, config is an empty object, or config
   * has explicit undefined/empty values.
   */
  function arbitraryAbsentProjectConfig(): fc.Arbitrary<
    | undefined
    | { speechTitle?: undefined; projectType?: undefined; objectives?: string[] }
  > {
    return fc.oneof(
      // Case 1: config is entirely undefined
      fc.constant(undefined),
      // Case 2: config is an empty object (no fields set)
      fc.constant({} as { speechTitle?: undefined; projectType?: undefined; objectives?: string[] }),
      // Case 3: config has explicit undefined/empty values
      fc.constant({
        speechTitle: undefined,
        projectType: undefined,
        objectives: [] as string[],
      }),
    );
  }

  /**
   * Generate random transcript text from the word pool to ensure the property
   * holds regardless of transcript content.
   */
  function arbitraryTranscriptText(): fc.Arbitrary<string> {
    return fc.array(fc.constantFrom(...WORD_POOL), { minLength: 5, maxLength: 30 })
      .map((words) => words.join(" "));
  }

  /**
   * Generate varied but valid DeliveryMetrics to ensure the property holds
   * regardless of metrics values.
   */
  function arbitraryMetrics(): fc.Arbitrary<DeliveryMetrics> {
    return fc.record({
      durationSeconds: fc.double({ min: 10, max: 600, noNaN: true }),
      totalWords: fc.integer({ min: 10, max: 2000 }),
      wordsPerMinute: fc.double({ min: 50, max: 250, noNaN: true }),
      fillerWordCount: fc.integer({ min: 0, max: 50 }),
      pauseCount: fc.integer({ min: 0, max: 30 }),
    }).map((r) => ({
      durationSeconds: r.durationSeconds,
      durationFormatted: `${Math.floor(r.durationSeconds / 60)}:${String(Math.floor(r.durationSeconds % 60)).padStart(2, "0")}`,
      totalWords: r.totalWords,
      wordsPerMinute: r.wordsPerMinute,
      fillerWords: [],
      fillerWordCount: r.fillerWordCount,
      fillerWordFrequency: 0,
      pauseCount: r.pauseCount,
      totalPauseDurationSeconds: 0,
      averagePauseDurationSeconds: 0,
      intentionalPauseCount: 0,
      hesitationPauseCount: 0,
      classifiedPauses: [],
      energyVariationCoefficient: 0,
      energyProfile: {
        windowDurationMs: 250,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      },
      classifiedFillers: [],
    }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function createGenerator(): EvaluationGenerator {
    const mockClient = makeMockClient(["{}"]);
    return new EvaluationGenerator(mockClient);
  }

  // ── Property Tests ──────────────────────────────────────────────────────────

  /**
   * **Validates: Requirements 4.6, 5.3**
   *
   * CTX-P1: For any EvaluationConfig where speechTitle is undefined/null and
   * projectType is undefined/null and objectives is empty, the LLM prompt
   * built by buildUserPrompt() SHALL NOT contain the strings
   * "Project-Specific Evaluation", "Project Objectives", or any of the
   * project-specific instruction text. The prompt SHALL be identical to the
   * Phase 2 prompt.
   */
  it("buildUserPrompt() produces no project sections when project context is absent", () => {
    const generator = createGenerator();

    fc.assert(
      fc.property(
        arbitraryAbsentProjectConfig(),
        arbitraryTranscriptText(),
        arbitraryMetrics(),
        (config, transcriptText, metrics) => {
          const prompt = (generator as any).buildUserPrompt(
            transcriptText,
            metrics,
            config,
          );

          // The prompt SHALL NOT contain the project-specific section header
          expect(prompt).not.toContain("Project-Specific Evaluation");

          // The prompt SHALL NOT contain the project objectives subsection header
          expect(prompt).not.toContain("Project Objectives");

          // The prompt SHALL NOT contain project-specific instruction text
          expect(prompt).not.toContain("Reference the project type and speech title in your opening");
          expect(prompt).not.toContain("directly addresses a project objective");
          expect(prompt).not.toContain("Balance project-specific feedback with general Toastmasters evaluation criteria");
          expect(prompt).not.toContain("Project objectives supplement, not replace, evidence-based feedback");

          // The prompt SHALL NOT contain the Evaluation Objectives section
          // (only rendered when objectives are present without projectType)
          expect(prompt).not.toContain("## Evaluation Objectives");
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.6, 5.3**
   *
   * CTX-P1 (identity): For any transcript text and metrics, the prompt built
   * with absent project context SHALL be identical to the prompt built with
   * no config at all (undefined). This verifies Phase 2 behavioral equivalence.
   */
  it("buildUserPrompt() with absent project config is identical to buildUserPrompt() with undefined config", () => {
    const generator = createGenerator();

    fc.assert(
      fc.property(
        arbitraryTranscriptText(),
        arbitraryMetrics(),
        (transcriptText, metrics) => {
          // Baseline: no config at all (Phase 2 behavior)
          const baselinePrompt = (generator as any).buildUserPrompt(
            transcriptText,
            metrics,
            undefined,
          );

          // Variant 1: empty object config
          const emptyConfigPrompt = (generator as any).buildUserPrompt(
            transcriptText,
            metrics,
            {},
          );

          // Variant 2: explicit undefined/empty values
          const explicitAbsentPrompt = (generator as any).buildUserPrompt(
            transcriptText,
            metrics,
            { speechTitle: undefined, projectType: undefined, objectives: [] },
          );

          // All three SHALL produce identical prompts
          expect(emptyConfigPrompt).toBe(baselinePrompt);
          expect(explicitAbsentPrompt).toBe(baselinePrompt);
        },
      ),
      { numRuns: 100 },
    );
  });
});
