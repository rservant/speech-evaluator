// Property-Based Tests for TTSEngine — Evaluation Script Duration Compliance
// Feature: ai-toastmasters-evaluator, Property 6: Evaluation Script Duration Compliance

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { TTSEngine, type OpenAITTSClient, parseScriptSections, type ScriptSection } from "./tts-engine.js";
import { EvaluationGenerator, type OpenAIClient } from "./evaluation-generator.js";
import type { EvaluationItem, StructuredEvaluation } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_WPM = 150;
const MAX_DURATION_SECONDS = 210; // 3m30s hard cap
const MIN_DURATION_SECONDS = 90; // 1m30s lower target

// ─── Mock clients (not called — only renderScript, estimateDuration, trimToFit used) ──

function createMockTTSClient(): OpenAITTSClient {
  return {
    audio: {
      speech: {
        create: vi.fn().mockResolvedValue({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      },
    },
  };
}

function createMockOpenAIClient(): OpenAIClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "{}" } }],
        }),
      },
    },
  };
}

// ─── Word pools for realistic content generation ────────────────────────────────

const SUMMARY_PHRASES = [
  "your use of vivid storytelling to engage the audience from the very beginning of your speech",
  "the way you structured your argument with clear transitions between each of your main points",
  "how you connected your personal experience to the broader theme in a way that felt authentic",
  "your confident opening that immediately captured the attention of everyone in the room today",
  "the effective use of rhetorical questions throughout your presentation to keep us thinking",
  "your ability to maintain eye contact and project confidence while delivering complex ideas",
  "the natural pacing that kept the audience engaged throughout the entire duration of your talk",
  "how you used humor to lighten the mood at just the right moment during your second point",
  "the powerful closing statement that tied everything together and left us wanting to hear more",
  "your clear articulation and varied vocal tone which made every word easy to follow and enjoy",
];

const EXPLANATION_PHRASES = [
  "this showed real command of the room and kept everyone listening intently to every word. It is a skill that takes years to develop and you demonstrated it beautifully today in front of all of us",
  "it made your message much more relatable and memorable for the audience sitting here today. That personal connection is what separates good speeches from truly great ones and you achieved it naturally",
  "this technique is something many experienced speakers use to great effect in their presentations. You executed it naturally which shows your growing confidence as a communicator and a storyteller",
  "the audience responded visibly and you could feel the energy shift in the room at that moment. That kind of engagement is exactly what we strive for in public speaking and you delivered it well",
  "this demonstrated strong preparation and a deep understanding of your topic and its importance. The depth of your knowledge came through clearly in every example you shared with the audience today",
  "it created a natural flow that made the speech easy and enjoyable to follow from start to finish. Your transitions were smooth and each point built logically on the previous one without any confusion",
  "this is a hallmark of confident and polished public speaking delivery that audiences truly appreciate. You should feel proud of how far you have come in developing this particular skill over time",
  "it helped reinforce your central message and left a lasting impression on everyone in the room today. The way you circled back to your opening theme was particularly effective and showed great planning",
  "this added depth and authenticity that resonated with everyone present in the room during your speech. Audiences can always tell when a speaker is being genuine and you clearly were throughout today",
  "the impact was clear from the audience reaction and engagement level throughout your entire presentation. You had people nodding along and that is the sign of a truly connected and effective speaker",
];

const EVIDENCE_QUOTES = [
  "the moment I realized everything had changed forever",
  "we all have the power to make a difference",
  "leadership is not about titles it is about action",
  "when I stood on that stage for the very first",
  "together we can build something truly remarkable here",
  "the key to success is consistency and dedication always",
  "I learned that failure is just another stepping stone",
  "communication is the bridge between confusion and clarity",
  "every great journey begins with a single brave step",
  "the audience deserves our very best effort every time",
];

const OPENING_PHRASES = [
  "Thank you for sharing that wonderful speech with us today. It was clear from the very first moment that you had put a great deal of thought and preparation into your message.",
  "What a thoughtful and engaging presentation you just delivered. I could tell that this topic means a great deal to you and that passion really came through.",
  "I really enjoyed listening to your speech and the passion behind it. You chose a topic that resonated with everyone in the room and delivered it with conviction.",
  "That was a compelling speech that clearly came from the heart. Your willingness to share personal experiences made it all the more powerful and memorable.",
  "Thank you for that inspiring talk about such an important topic. From start to finish you held our attention and gave us plenty to think about.",
];

const CLOSING_PHRASES = [
  "Keep pushing yourself and you will continue to grow as a speaker. I am genuinely excited to see where your speaking journey takes you next.",
  "I look forward to hearing your next speech and seeing your continued growth. You have all the tools you need to become an outstanding communicator.",
  "You have a strong foundation to build on and great things ahead. Every speech you give is another step forward on your path to excellence.",
  "Continue developing these skills and you will truly shine on stage. The progress you have made is already impressive and the best is yet to come.",
  "Your dedication to improvement is evident and I am excited for your journey. Keep bringing this level of energy and thoughtfulness to every speech you give.",
];

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a random EvaluationItem with realistic content.
 */
function arbitraryEvaluationItem(
  type: "commendation" | "recommendation",
): fc.Arbitrary<EvaluationItem> {
  return fc.tuple(
    fc.constantFrom(...SUMMARY_PHRASES),
    fc.constantFrom(...EVIDENCE_QUOTES),
    fc.double({ min: 0, max: 600, noNaN: true }),
    fc.constantFrom(...EXPLANATION_PHRASES),
  ).map(([summary, evidence_quote, evidence_timestamp, explanation]) => ({
    type,
    summary,
    evidence_quote,
    evidence_timestamp,
    explanation,
  }));
}

/**
 * Generate a random StructuredEvaluation with 2-3 commendations and 1-2 recommendations.
 * This produces evaluations of realistic size that should render to scripts
 * within the target duration range.
 */
function arbitraryStructuredEvaluation(): fc.Arbitrary<StructuredEvaluation> {
  return fc.tuple(
    fc.constantFrom(...OPENING_PHRASES),
    fc.integer({ min: 2, max: 3 }),
    fc.integer({ min: 1, max: 2 }),
    fc.constantFrom(...CLOSING_PHRASES),
  ).chain(([opening, numCommendations, numRecommendations, closing]) =>
    fc.tuple(
      fc.constant(opening),
      fc.array(arbitraryEvaluationItem("commendation"), {
        minLength: numCommendations,
        maxLength: numCommendations,
      }),
      fc.array(arbitraryEvaluationItem("recommendation"), {
        minLength: numRecommendations,
        maxLength: numRecommendations,
      }),
      fc.constant(closing),
    ).map(([open, commendations, recommendations, close]) => ({
      opening: open,
      items: [...commendations, ...recommendations],
      closing: close,
    })),
  );
}

/**
 * Generate a StructuredEvaluation that is intentionally very long (many items
 * with verbose content) to stress-test the trimToFit upper bound enforcement.
 */
function arbitraryOversizedEvaluation(): fc.Arbitrary<StructuredEvaluation> {
  // Generate 3 commendations + 2 recommendations, each with long explanations
  const longExplanation =
    "this was truly remarkable because it demonstrated an exceptional level of preparation " +
    "and the audience could feel the energy shift in the room as you delivered each point " +
    "with conviction and clarity that is rarely seen in speakers at any level of experience " +
    "and I believe this will serve you well in future presentations and beyond";

  return fc.tuple(
    fc.constantFrom(
      "Thank you so much for that absolutely wonderful and deeply inspiring speech that you shared with all of us here today. " +
      "It was truly a pleasure to listen to every single word you said and I want to share some detailed observations.",
    ),
    fc.array(
      fc.tuple(
        fc.constantFrom(...SUMMARY_PHRASES),
        fc.constantFrom(...EVIDENCE_QUOTES),
        fc.double({ min: 0, max: 600, noNaN: true }),
      ).map(([summary, quote, ts]) => ({
        type: "commendation" as const,
        summary,
        evidence_quote: quote,
        evidence_timestamp: ts,
        explanation: longExplanation,
      })),
      { minLength: 3, maxLength: 3 },
    ),
    fc.array(
      fc.tuple(
        fc.constantFrom(...SUMMARY_PHRASES),
        fc.constantFrom(...EVIDENCE_QUOTES),
        fc.double({ min: 0, max: 600, noNaN: true }),
      ).map(([summary, quote, ts]) => ({
        type: "recommendation" as const,
        summary,
        evidence_quote: quote,
        evidence_timestamp: ts,
        explanation: longExplanation,
      })),
      { minLength: 2, maxLength: 2 },
    ),
    fc.constantFrom(
      "Keep pushing yourself forward because you have demonstrated incredible potential " +
      "and I am truly excited to see where your speaking journey takes you in the months and years ahead. " +
      "The entire club is behind you and cheering you on every step of the way.",
    ),
  ).map(([opening, commendations, recommendations, closing]) => ({
    opening,
    items: [...commendations, ...recommendations],
    closing,
  }));
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 6: Evaluation Script Duration Compliance", () => {
  const ttsEngine = new TTSEngine(createMockTTSClient());
  const evalGenerator = new EvaluationGenerator(createMockOpenAIClient());

  /**
   * **Validates: Requirements 4.5**
   *
   * Property 6a: Upper bound enforcement — trimToFit guarantees ≤210s.
   *
   * For any evaluation script rendered from a random StructuredEvaluation,
   * after trimming with trimToFit(text, 210, 150), the estimated duration
   * SHALL be at most 210 seconds.
   */
  it("trimToFit enforces the 210-second upper bound on any rendered evaluation script", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredEvaluation(),
        (evaluation) => {
          const script = evalGenerator.renderScript(evaluation);
          const trimmed = ttsEngine.trimToFit(script, MAX_DURATION_SECONDS, DEFAULT_WPM);
          const estimatedDuration = ttsEngine.estimateDuration(trimmed, DEFAULT_WPM);

          expect(estimatedDuration).toBeLessThanOrEqual(MAX_DURATION_SECONDS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.5**
   *
   * Property 6b: Upper bound enforcement on oversized scripts.
   *
   * For any intentionally oversized evaluation script (verbose content, many items),
   * after trimming with trimToFit(text, 210, 150), the estimated duration
   * SHALL be at most 210 seconds. This stress-tests the trimming logic.
   */
  it("trimToFit enforces the 210-second upper bound even on oversized evaluation scripts", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedEvaluation(),
        (evaluation) => {
          const script = evalGenerator.renderScript(evaluation);
          const trimmed = ttsEngine.trimToFit(script, MAX_DURATION_SECONDS, DEFAULT_WPM);
          const estimatedDuration = ttsEngine.estimateDuration(trimmed, DEFAULT_WPM);

          expect(estimatedDuration).toBeLessThanOrEqual(MAX_DURATION_SECONDS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.5**
   *
   * Property 6c: Lower bound target — reasonably-sized evaluations produce scripts ≥90s.
   *
   * For any StructuredEvaluation with 2-3 commendations and 1-2 recommendations
   * (the standard shape), the rendered script (before trimming) SHALL have an
   * estimated duration of at least 90 seconds. This validates that the renderScript
   * template produces sufficiently long output for the target range.
   */
  it("reasonably-sized evaluations render to scripts with estimated duration ≥90 seconds", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredEvaluation(),
        (evaluation) => {
          const script = evalGenerator.renderScript(evaluation);
          const estimatedDuration = ttsEngine.estimateDuration(script, DEFAULT_WPM);

          expect(estimatedDuration).toBeGreaterThanOrEqual(MIN_DURATION_SECONDS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.5**
   *
   * Property 6d: Duration stays within [90, 210] after full pipeline.
   *
   * For any reasonably-sized StructuredEvaluation, after rendering to script
   * and trimming with trimToFit, the estimated duration SHALL be between
   * 90 and 210 seconds inclusive.
   */
  it("rendered and trimmed evaluation scripts have estimated duration in [90, 210] seconds", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredEvaluation(),
        (evaluation) => {
          const script = evalGenerator.renderScript(evaluation);
          const trimmed = ttsEngine.trimToFit(script, MAX_DURATION_SECONDS, DEFAULT_WPM);
          const estimatedDuration = ttsEngine.estimateDuration(trimmed, DEFAULT_WPM);

          expect(estimatedDuration).toBeGreaterThanOrEqual(MIN_DURATION_SECONDS);
          expect(estimatedDuration).toBeLessThanOrEqual(MAX_DURATION_SECONDS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.5**
   *
   * Property 6e: trimToFit is idempotent.
   *
   * For any evaluation script, applying trimToFit twice with the same parameters
   * SHALL produce the same result as applying it once.
   */
  it("trimToFit is idempotent — applying it twice yields the same result", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredEvaluation(),
        (evaluation) => {
          const script = evalGenerator.renderScript(evaluation);
          const trimmedOnce = ttsEngine.trimToFit(script, MAX_DURATION_SECONDS, DEFAULT_WPM);
          const trimmedTwice = ttsEngine.trimToFit(trimmedOnce, MAX_DURATION_SECONDS, DEFAULT_WPM);

          expect(trimmedTwice).toBe(trimmedOnce);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 13: Duration Estimation with Safety Margin ────────────────────────
// Feature: ai-toastmasters-evaluator, Property 13
// **Validates: Requirements 6.2**

// ─── Generators for Property 13 ─────────────────────────────────────────────────

/**
 * Generate a non-empty text string with a known word count.
 * Words are simple alphabetic tokens separated by single spaces.
 */
function arbitraryNonEmptyText(): fc.Arbitrary<string> {
  return fc
    .array(
      fc.stringMatching(/^[a-z]{1,10}$/).filter((s) => s.length > 0),
      { minLength: 1, maxLength: 200 },
    )
    .map((words) => words.join(" "));
}

/**
 * Generate a valid (positive) WPM value.
 */
function arbitraryPositiveWPM(): fc.Arbitrary<number> {
  return fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generate a safety margin percentage in [0, 100].
 */
function arbitrarySafetyMargin(): fc.Arbitrary<number> {
  return fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
}

// ─── Helper: count words (mirrors the implementation) ───────────────────────────

function testCountWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

// ─── Property 13 Tests ──────────────────────────────────────────────────────────

describe("Property 13: Duration Estimation with Safety Margin", () => {
  const engine = new TTSEngine(createMockTTSClient());

  /**
   * **Validates: Requirements 6.2**
   *
   * Property 13a: Mathematical correctness — estimateDuration equals the expected formula.
   *
   * For any non-empty text, valid WPM, and safety margin:
   *   estimateDuration(text, wpm, margin) === (countWords(text) / wpm) * 60 * (1 + margin / 100)
   */
  it("estimateDuration equals (words / wpm) * 60 * (1 + margin / 100) for non-empty text and valid WPM", () => {
    fc.assert(
      fc.property(
        arbitraryNonEmptyText(),
        arbitraryPositiveWPM(),
        arbitrarySafetyMargin(),
        (text, wpm, margin) => {
          const actual = engine.estimateDuration(text, wpm, margin);
          const words = testCountWords(text);
          const expected = (words / wpm) * 60 * (1 + margin / 100);

          expect(actual).toBeCloseTo(expected, 6);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * Property 13b: Positive margin produces strictly greater estimate than zero margin.
   *
   * For any non-empty text and valid WPM, estimateDuration with margin > 0
   * is always strictly greater than estimateDuration with margin = 0.
   */
  it("estimate with margin > 0 is always greater than estimate with margin = 0", () => {
    fc.assert(
      fc.property(
        arbitraryNonEmptyText(),
        arbitraryPositiveWPM(),
        fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
        (text, wpm, positiveMargin) => {
          const withMargin = engine.estimateDuration(text, wpm, positiveMargin);
          const withoutMargin = engine.estimateDuration(text, wpm, 0);

          expect(withMargin).toBeGreaterThan(withoutMargin);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * Property 13c: Monotonically increasing with margin.
   *
   * For any non-empty text and valid WPM, if margin1 < margin2 then
   * estimateDuration(text, wpm, margin1) < estimateDuration(text, wpm, margin2).
   */
  it("estimate is monotonically increasing with margin", () => {
    fc.assert(
      fc.property(
        arbitraryNonEmptyText(),
        arbitraryPositiveWPM(),
        arbitrarySafetyMargin(),
        arbitrarySafetyMargin(),
        (text, wpm, m1, m2) => {
          // Ensure m1 < m2 with a meaningful gap to avoid floating-point equality
          const marginLow = Math.min(m1, m2);
          const marginHigh = Math.max(m1, m2);
          // Skip when margins are too close (floating-point precision)
          fc.pre(marginHigh - marginLow > 0.001);

          const durationLow = engine.estimateDuration(text, wpm, marginLow);
          const durationHigh = engine.estimateDuration(text, wpm, marginHigh);

          expect(durationHigh).toBeGreaterThan(durationLow);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * Property 13d: Empty text returns 0 regardless of margin.
   *
   * For any WPM and any safety margin, estimateDuration of empty text is 0.
   */
  it("estimate is 0 for empty text regardless of margin", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "   ", "\t", "\n", "  \n  "),
        arbitraryPositiveWPM(),
        arbitrarySafetyMargin(),
        (emptyText, wpm, margin) => {
          expect(engine.estimateDuration(emptyText, wpm, margin)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * Property 13e: Zero or negative WPM returns 0 regardless of margin.
   *
   * For any text and any safety margin, estimateDuration with wpm <= 0 is 0.
   */
  it("estimate is 0 for wpm <= 0 regardless of margin", () => {
    fc.assert(
      fc.property(
        arbitraryNonEmptyText(),
        fc.double({ min: -1000, max: 0, noNaN: true, noDefaultInfinity: true }),
        arbitrarySafetyMargin(),
        (text, nonPositiveWPM, margin) => {
          expect(engine.estimateDuration(text, nonPositiveWPM, margin)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ─── Property 14: Structured Trimming Correctness ───────────────────────────────
// Feature: phase-2-stability-credibility, Property 14: Structured Trimming Correctness
// **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

// ─── Generators for Property 14 ─────────────────────────────────────────────────

/**
 * Word pools for building realistic evaluation scripts with known structure.
 * Scripts are assembled directly (not via renderScript) so we control section
 * markers that parseScriptSections can detect.
 */

const P14_OPENING_SENTENCES = [
  "Thank you for sharing that wonderful speech with us today.",
  "What a thoughtful and engaging presentation you just delivered.",
  "I really enjoyed listening to your speech and the passion behind it.",
  "That was a compelling speech that clearly came from the heart.",
];

const P14_COMMENDATION_STARTERS = [
  "One thing you did really well was",
  "What really stood out was",
  "I really appreciated",
  "I really liked",
  "Your use of vivid storytelling was impressive and",
];

const P14_COMMENDATION_BODIES = [
  "your ability to connect with the audience through personal stories that felt genuine and relatable.",
  "the way you structured your argument with clear transitions between each of your main points.",
  "how you used humor to lighten the mood at just the right moment during your second point.",
  "your confident opening that immediately captured the attention of everyone in the room today.",
  "the natural pacing that kept the audience engaged throughout the entire duration of your talk.",
];

const P14_COMMENDATION_EXPLANATIONS = [
  "This showed real command of the room and kept everyone listening intently to every word you said.",
  "It made your message much more relatable and memorable for the audience sitting here today.",
  "This technique is something many experienced speakers use to great effect in their presentations.",
  "The audience responded visibly and you could feel the energy shift in the room at that moment.",
];

const P14_RECOMMENDATION_STARTERS = [
  "Something to consider for next time is",
  "One area to consider for growth is",
  "You might want to try",
  "Next time you could consider",
  "It might help to think about",
];

const P14_RECOMMENDATION_BODIES = [
  "varying your vocal tone more to emphasize key points and create a more dynamic delivery.",
  "adding a stronger call to action at the end to leave the audience with a clear takeaway.",
  "using more pauses for dramatic effect to let your important points sink in with the audience.",
  "incorporating more specific examples to support your main argument and make it more convincing.",
];

const P14_RECOMMENDATION_EXPLANATIONS = [
  "This would help create more contrast and keep the audience engaged throughout your entire speech.",
  "A clear call to action gives the audience something concrete to remember and act on after your talk.",
  "Strategic pauses can be incredibly powerful and give your words more weight and impact.",
  "Specific examples make abstract ideas tangible and help the audience connect with your message.",
];

const P14_STRUCTURE_COMMENTARY_SENTENCES = [
  "Your speech opening was strong and immediately grabbed the attention of the audience.",
  "The body of your speech was well organized with clear transitions between your main points.",
  "Your speech closing tied everything together nicely and left a lasting impression on the audience.",
  "How you structured your speech showed careful planning and a clear understanding of your message.",
  "The speech structure flowed naturally from your opening through the body to a satisfying conclusion.",
];

const P14_CLOSING_SENTENCES = [
  "Overall, great job on this speech and I look forward to hearing your next one.",
  "Keep up the excellent work and continue developing these skills.",
  "In summary, you delivered a strong speech with plenty of room to grow even further.",
  "Keep practicing and you will continue to grow as a speaker.",
];

/**
 * Build a single commendation section string with 1-3 sentences.
 */
function arbitraryCommendationSection(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...P14_COMMENDATION_STARTERS),
    fc.constantFrom(...P14_COMMENDATION_BODIES),
    fc.boolean(),
    fc.constantFrom(...P14_COMMENDATION_EXPLANATIONS),
  ).map(([starter, body, includeExplanation, explanation]) => {
    const base = `${starter} ${body}`;
    return includeExplanation ? `${base} ${explanation}` : base;
  });
}

/**
 * Build a single recommendation section string with 1-3 sentences.
 */
function arbitraryRecommendationSection(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...P14_RECOMMENDATION_STARTERS),
    fc.constantFrom(...P14_RECOMMENDATION_BODIES),
    fc.boolean(),
    fc.constantFrom(...P14_RECOMMENDATION_EXPLANATIONS),
  ).map(([starter, body, includeExplanation, explanation]) => {
    const base = `${starter} ${body}`;
    return includeExplanation ? `${base} ${explanation}` : base;
  });
}

/**
 * Build a structure commentary section (0-3 sentences).
 */
function arbitraryStructureCommentary(): fc.Arbitrary<string> {
  return fc.array(
    fc.constantFrom(...P14_STRUCTURE_COMMENTARY_SENTENCES),
    { minLength: 1, maxLength: 3 },
  ).map((sentences) => sentences.join(" "));
}

/**
 * Generate a realistic evaluation script with known structure that
 * parseScriptSections can detect. The script is assembled from parts
 * with recognizable transition phrases.
 *
 * Structure:
 *   - Opening: 1-2 greeting sentences
 *   - Optional structure commentary: 1-3 sentences about speech structure
 *   - Commendations: 1-3 items with transition phrases
 *   - Recommendations: 1-2 items with transition phrases
 *   - Closing: 1-2 wrap-up sentences
 */
function arbitraryStructuredScript(): fc.Arbitrary<{
  script: string;
  numCommendations: number;
  numRecommendations: number;
  hasStructureCommentary: boolean;
}> {
  return fc.tuple(
    // Opening: 1-2 sentences
    fc.array(fc.constantFrom(...P14_OPENING_SENTENCES), { minLength: 1, maxLength: 2 }),
    // Structure commentary: present or absent
    fc.boolean(),
    fc.array(fc.constantFrom(...P14_STRUCTURE_COMMENTARY_SENTENCES), { minLength: 1, maxLength: 2 }),
    // Commendations: 1-3
    fc.integer({ min: 1, max: 3 }),
    // Recommendations: 1-2
    fc.integer({ min: 1, max: 2 }),
    // Closing: 1-2 sentences
    fc.array(fc.constantFrom(...P14_CLOSING_SENTENCES), { minLength: 1, maxLength: 2 }),
  ).chain(([openingSentences, includeStructure, structureSentences, numComm, numRec, closingSentences]) =>
    fc.tuple(
      fc.constant(openingSentences),
      fc.constant(includeStructure),
      fc.constant(structureSentences),
      fc.array(arbitraryCommendationSection(), { minLength: numComm, maxLength: numComm }),
      fc.array(arbitraryRecommendationSection(), { minLength: numRec, maxLength: numRec }),
      fc.constant(closingSentences),
    ).map(([opening, hasStructure, structure, commendations, recommendations, closing]) => {
      const parts: string[] = [];
      parts.push(opening.join(" "));
      if (hasStructure) {
        parts.push(structure.join(" "));
      }
      for (const c of commendations) {
        parts.push(c);
      }
      for (const r of recommendations) {
        parts.push(r);
      }
      parts.push(closing.join(" "));

      return {
        script: parts.join(" "),
        numCommendations: numComm,
        numRecommendations: numRec,
        hasStructureCommentary: hasStructure,
      };
    }),
  );
}

/**
 * Generate an oversized evaluation script that is guaranteed to exceed
 * a given time limit. Uses many items with verbose explanations.
 */
function arbitraryOversizedStructuredScript(): fc.Arbitrary<{
  script: string;
  numCommendations: number;
  numRecommendations: number;
}> {
  // Build a very long script: 3 commendations + 2 recommendations, each with long explanations
  const longExplanation =
    "This was truly remarkable because it demonstrated an exceptional level of preparation " +
    "and the audience could feel the energy shift in the room as you delivered each point " +
    "with conviction and clarity that is rarely seen in speakers at any level of experience " +
    "and I believe this will serve you well in future presentations and beyond.";

  return fc.tuple(
    fc.constantFrom(...P14_OPENING_SENTENCES),
    fc.constantFrom(...P14_OPENING_SENTENCES),
    fc.array(
      fc.tuple(
        fc.constantFrom(...P14_COMMENDATION_STARTERS),
        fc.constantFrom(...P14_COMMENDATION_BODIES),
      ).map(([starter, body]) => `${starter} ${body} ${longExplanation} ${longExplanation}`),
      { minLength: 3, maxLength: 3 },
    ),
    fc.array(
      fc.tuple(
        fc.constantFrom(...P14_RECOMMENDATION_STARTERS),
        fc.constantFrom(...P14_RECOMMENDATION_BODIES),
      ).map(([starter, body]) => `${starter} ${body} ${longExplanation} ${longExplanation}`),
      { minLength: 2, maxLength: 2 },
    ),
    fc.array(fc.constantFrom(...P14_STRUCTURE_COMMENTARY_SENTENCES), { minLength: 2, maxLength: 3 }),
    fc.constantFrom(...P14_CLOSING_SENTENCES),
    fc.constantFrom(...P14_CLOSING_SENTENCES),
  ).map(([open1, open2, commendations, recommendations, structure, close1, close2]) => {
    const parts: string[] = [];
    parts.push(`${open1} ${open2}`);
    parts.push(structure.join(" "));
    for (const c of commendations) parts.push(c);
    for (const r of recommendations) parts.push(r);
    parts.push(`${close1} ${close2}`);

    return {
      script: parts.join(" "),
      numCommendations: 3,
      numRecommendations: 2,
    };
  });
}

// ─── Helper functions for Property 14 ───────────────────────────────────────────

/**
 * Check if a section type exists in the parsed sections.
 */
function hasSectionType(sections: ScriptSection[], type: ScriptSection["type"]): boolean {
  return sections.some((s) => s.type === type);
}

/**
 * Count sections of a given type.
 */
function countSectionType(sections: ScriptSection[], type: ScriptSection["type"]): number {
  return sections.filter((s) => s.type === type).length;
}

/**
 * Check if text ends with terminal punctuation (. ! ?).
 */
function endsWithTerminalPunctuation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lastChar = trimmed[trimmed.length - 1];
  return lastChar === "." || lastChar === "!" || lastChar === "?";
}

/**
 * Check that trimmed text is a subset of original text (purely subtractive).
 * Every word in the trimmed text must appear in the original text in order.
 */
function isSubsetOf(trimmed: string, original: string): boolean {
  // Normalize whitespace for comparison
  const trimmedWords = trimmed.trim().split(/\s+/).filter(w => w.length > 0);
  const originalWords = original.trim().split(/\s+/).filter(w => w.length > 0);

  let oi = 0;
  for (const tw of trimmedWords) {
    // Find this word in the original starting from current position
    let found = false;
    while (oi < originalWords.length) {
      if (originalWords[oi] === tw) {
        found = true;
        oi++;
        break;
      }
      oi++;
    }
    if (!found) return false;
  }
  return true;
}

// ─── Property 14 Tests ──────────────────────────────────────────────────────────

describe("Property 14: Structured Trimming Correctness", () => {
  const engine = new TTSEngine(createMockTTSClient());
  const DEFAULT_SAFETY_MARGIN = 8;

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14a: Trimmed output fits within the time limit (or is the hard-minimum).
   *
   * For any evaluation script that exceeds the time limit after safety margin,
   * the trimmed script's estimated duration SHALL be at or below the time limit,
   * unless the hard-minimum script itself exceeds it.
   */
  it("trimmed output fits within the time limit or is the hard-minimum", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 30, max: 90 }),
        ({ script }, maxSeconds) => {
          // Ensure the script actually exceeds the limit
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          const trimmedDuration = engine.estimateDuration(trimmed, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          // The trimmed output should fit, OR it's the hard-minimum that can't be reduced further
          // Hard-minimum = opening(1 sentence) + 1 commendation(1 sentence) + 1 recommendation(1 sentence) + closing(1 sentence)
          const sections = parseScriptSections(trimmed);
          const commendations = sections.filter(s => s.type === "commendation");
          const recommendations = sections.filter(s => s.type === "recommendation");
          const openings = sections.filter(s => s.type === "opening");
          const closings = sections.filter(s => s.type === "closing");

          const isHardMinimum =
            commendations.length <= 1 &&
            recommendations.length <= 1 &&
            openings.every(s => s.sentences.length <= 1) &&
            closings.every(s => s.sentences.length <= 1) &&
            commendations.every(s => s.sentences.length <= 1) &&
            recommendations.every(s => s.sentences.length <= 1);

          if (!isHardMinimum) {
            // If not at hard-minimum, it must fit
            expect(trimmedDuration).toBeLessThanOrEqual(maxSeconds);
          }
          // If at hard-minimum, it's acceptable to exceed (safety messaging priority)
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14b: Trimmed output preserves the opening section.
   *
   * For any evaluation script that exceeds the time limit, the trimmed script
   * SHALL contain an opening section (as detected by parseScriptSections).
   */
  it("trimmed output preserves the opening section", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          // The trimmed script should still contain opening content
          // Check that the first sentence of the original opening appears in the trimmed output
          const originalSections = parseScriptSections(script);
          const originalOpening = originalSections.find(s => s.type === "opening");
          if (originalOpening && originalOpening.sentences.length > 0) {
            const firstOpeningSentence = originalOpening.sentences[0];
            expect(trimmed).toContain(firstOpeningSentence);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14c: Trimmed output preserves at least one commendation.
   *
   * For any evaluation script with commendations that exceeds the time limit,
   * the trimmed script SHALL contain at least one commendation section.
   */
  it("trimmed output preserves at least one commendation", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          // Verify original has commendations
          const originalSections = parseScriptSections(script);
          const originalCommendations = originalSections.filter(s => s.type === "commendation");
          fc.pre(originalCommendations.length > 0);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          const trimmedSections = parseScriptSections(trimmed);

          expect(trimmedSections.some(s => s.type === "commendation")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14d: Trimmed output preserves at least one recommendation
   * (if the original had any).
   *
   * For any evaluation script with recommendations that exceeds the time limit,
   * the trimmed script SHALL contain at least one recommendation section
   * (the strongest).
   */
  it("trimmed output preserves at least one recommendation when original has recommendations", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          // Verify original has recommendations
          const originalSections = parseScriptSections(script);
          const originalRecommendations = originalSections.filter(s => s.type === "recommendation");
          fc.pre(originalRecommendations.length > 0);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          const trimmedSections = parseScriptSections(trimmed);

          expect(trimmedSections.some(s => s.type === "recommendation")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14e: Trimmed output preserves the closing section.
   *
   * For any evaluation script that exceeds the time limit, the trimmed script
   * SHALL contain closing content.
   */
  it("trimmed output preserves the closing section", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          // The trimmed script should still contain closing content
          const originalSections = parseScriptSections(script);
          const originalClosing = originalSections.find(s => s.type === "closing");
          if (originalClosing && originalClosing.sentences.length > 0) {
            // At least the first closing sentence should be preserved
            const firstClosingSentence = originalClosing.sentences[0];
            expect(trimmed).toContain(firstClosingSentence);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14f: Trimmed output ends with a complete sentence.
   *
   * For any evaluation script that exceeds the time limit, the trimmed script
   * SHALL end with terminal punctuation (. ! ?).
   */
  it("trimmed output ends with a complete sentence (terminal punctuation)", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          expect(endsWithTerminalPunctuation(trimmed)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14g: Trimming is purely subtractive — never appends content.
   *
   * For any evaluation script that exceeds the time limit, every word in the
   * trimmed output SHALL appear in the original script in the same order
   * (the trimmed output is a subsequence of the original).
   */
  it("trimming is purely subtractive — trimmed output is a subsequence of the original", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const originalDuration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(originalDuration > maxSeconds);

          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          expect(isSubsetOf(trimmed, script)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14h: trimToFit is idempotent.
   *
   * For any evaluation script, applying trimToFit twice with the same parameters
   * SHALL produce the same result as applying it once.
   */
  it("trimToFit is idempotent — applying it twice yields the same result", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredScript(),
        fc.integer({ min: 20, max: 120 }),
        ({ script }, maxSeconds) => {
          const trimmedOnce = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          const trimmedTwice = engine.trimToFit(trimmedOnce, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          expect(trimmedTwice).toBe(trimmedOnce);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14i: Scripts that already fit are returned unchanged.
   *
   * For any evaluation script whose estimated duration is within the time limit,
   * trimToFit SHALL return the script unchanged.
   */
  it("scripts that already fit within the time limit are returned unchanged", () => {
    fc.assert(
      fc.property(
        arbitraryStructuredScript(),
        ({ script }) => {
          // Use a very generous time limit so the script fits
          const maxSeconds = 600;
          const duration = engine.estimateDuration(script, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);
          fc.pre(duration <= maxSeconds);

          const result = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          expect(result).toBe(script);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5, 6.6**
   *
   * Property 14j: Trimmed output is always shorter than or equal to the original.
   *
   * For any evaluation script and time limit, the trimmed output SHALL have
   * a word count less than or equal to the original.
   */
  it("trimmed output word count is always <= original word count", () => {
    fc.assert(
      fc.property(
        arbitraryOversizedStructuredScript(),
        fc.integer({ min: 20, max: 80 }),
        ({ script }, maxSeconds) => {
          const trimmed = engine.trimToFit(script, maxSeconds, DEFAULT_WPM, DEFAULT_SAFETY_MARGIN);

          const originalWords = testCountWords(script);
          const trimmedWords = testCountWords(trimmed);

          expect(trimmedWords).toBeLessThanOrEqual(originalWords);
        },
      ),
      { numRuns: 200 },
    );
  });
});
