// Property-Based Tests for TTSEngine — Evaluation Script Duration Compliance
// Feature: ai-toastmasters-evaluator, Property 6: Evaluation Script Duration Compliance

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { TTSEngine, type OpenAITTSClient } from "./tts-engine.js";
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
