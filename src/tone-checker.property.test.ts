// Property-Based Tests for ToneChecker — Detection Completeness
// Feature: phase-2-stability-credibility, Property 5: Tone Checker Detection Completeness
//
// **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**
//
// For any evaluation script containing at least one prohibited content pattern
// from any category (psychological inference, visual scope claim, punitive
// language, or numerical score), the ToneChecker.check() method SHALL return
// passed: false with at least one ToneViolation whose category matches the
// pattern category and whose sentence contains the offending text.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { ToneChecker, hasMetricAnchoredNumber, validateMetricKeyExists } from "./tone-checker.js";
import type {
  StructuredEvaluation,
  DeliveryMetrics,
} from "./types.js";

// ─── Stub Objects ───────────────────────────────────────────────────────────────

/** Minimal StructuredEvaluation stub with all Phase 2 fields */
const STUB_EVALUATION: StructuredEvaluation = {
  opening: "Great speech.",
  items: [],
  closing: "Keep it up.",
  structure_commentary: {
    opening_comment: null,
    body_comment: null,
    closing_comment: null,
  },
};

/** Minimal DeliveryMetrics stub with all Phase 2 fields */
const STUB_METRICS: DeliveryMetrics = {
  durationSeconds: 120,
  durationFormatted: "2:00",
  totalWords: 300,
  wordsPerMinute: 150,
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
  visualMetrics: null,
};

const checker = new ToneChecker();

// ─── Pattern Phrase Lists (mirroring the actual ToneChecker patterns) ───────────

/**
 * Concrete phrases that match each prohibited pattern category.
 * These are drawn from the actual regex patterns in tone-checker.ts.
 */
const PSYCHOLOGICAL_INFERENCE_PHRASES: string[] = [
  "you seem",
  "you appear to feel",
  "you lack",
  "you were nervous",
  "your anxiety",
  "you felt",
  "you were afraid",
  "you were uncomfortable",
  "you were confident",
  "your fear",
  "your insecurity",
  "you were hesitant",
  "you were uncertain",
  "your doubt",
  "you were worried",
  "you were anxious",
  "your nervousness",
  "you were scared",
  "you were intimidated",
  "your shyness",
  "you were shy",
  "you were timid",
  "you were self-conscious",
  "your self-doubt",
  "you were overwhelmed",
  "you were stressed",
  "your stress",
  "you were tense",
  "your tension",
  "you were frustrated",
];

const VISUAL_SCOPE_PHRASES: string[] = [
  "eye contact",
  "body language",
  "facial expression",
  "gesture",
  "gestures",
  "gestured",
  "posture",
  "looked at",
  "smiled",
  "nodded",
  "hand movement",
  "stood",
  "walked",
  "paced",
  "fidgeted",
  "leaned",
  "crossed arms",
  "made eye contact",
  "your face",
  "your eyes",
  "your hands",
  "your stance",
];

const PUNITIVE_LANGUAGE_PHRASES: string[] = [
  "you failed to",
  "you struggle with",
  "you were unable to",
  "your weakness",
  "poor attempt",
  "you couldn't",
  "you didn't manage",
  "you fell short",
  "your failure",
  "you lacked",
  "you were deficient",
  "your shortcoming",
  "you were inadequate",
  "your inability",
  "you were incapable",
  "you were poor at",
  "your poor",
  "you were bad at",
  "your bad",
  "you were terrible",
  "your terrible",
  "you were awful",
  "your awful",
  "you were hopeless",
  "your hopeless",
];

const NUMERICAL_SCORE_PHRASES: string[] = [
  "7/10",
  "8 / 10",
  "9 out of 10",
  "85%",
  "score of",
  "rating of",
  "grade of",
  "3/5",
  "rated 8",
];

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Category type matching ToneViolation categories for the four
 * deterministic pattern categories (excluding ungrounded_claim which
 * requires marker-based detection and is not a simple pattern match).
 */
type PatternCategory =
  | "psychological_inference"
  | "visual_scope"
  | "punitive_language"
  | "numerical_score";

interface CategoryConfig {
  category: PatternCategory;
  phrases: string[];
}

const CATEGORIES: CategoryConfig[] = [
  { category: "psychological_inference", phrases: PSYCHOLOGICAL_INFERENCE_PHRASES },
  { category: "visual_scope", phrases: VISUAL_SCOPE_PHRASES },
  { category: "punitive_language", phrases: PUNITIVE_LANGUAGE_PHRASES },
  { category: "numerical_score", phrases: NUMERICAL_SCORE_PHRASES },
];

/**
 * Generator for a random category and one of its prohibited phrases.
 */
function arbitraryCategoryAndPhrase(): fc.Arbitrary<{
  category: PatternCategory;
  phrase: string;
}> {
  return fc
    .integer({ min: 0, max: CATEGORIES.length - 1 })
    .chain((catIdx) => {
      const config = CATEGORIES[catIdx];
      return fc
        .integer({ min: 0, max: config.phrases.length - 1 })
        .map((phraseIdx) => ({
          category: config.category,
          phrase: config.phrases[phraseIdx],
        }));
    });
}

/**
 * Generator for clean filler text that does NOT contain any prohibited patterns.
 * Uses simple safe words that won't accidentally match any pattern.
 */
function arbitraryCleanText(): fc.Arbitrary<string> {
  const safeWords = [
    "the", "speech", "was", "very", "well", "organized",
    "topic", "interesting", "audience", "engaged", "with",
    "a", "clear", "message", "and", "strong", "delivery",
    "overall", "this", "is", "an", "excellent", "presentation",
    "thank", "for", "sharing", "that", "wonderful", "story",
  ];
  return fc
    .array(fc.constantFrom(...safeWords), { minLength: 2, maxLength: 8 })
    .map((words) => words.join(" "));
}

/**
 * Build a script sentence containing a prohibited phrase embedded in clean text.
 * The sentence ends with a period and optionally has a [[Q:*]] marker
 * (for non-ungrounded categories, markers don't prevent detection).
 */
function arbitraryProhibitedSentence(): fc.Arbitrary<{
  category: PatternCategory;
  phrase: string;
  sentence: string;
  script: string;
}> {
  return fc
    .tuple(
      arbitraryCategoryAndPhrase(),
      arbitraryCleanText(),
      arbitraryCleanText(),
      fc.boolean(), // whether to add a marker (shouldn't affect detection for these categories)
    )
    .map(([{ category, phrase }, prefix, suffix, addMarker]) => {
      const sentence = `${capitalize(prefix)} ${phrase} ${suffix}.`;
      const marker = addMarker ? " [[Q:item-0]]" : "";
      const script = sentence + marker;
      return { category, phrase, sentence, script };
    });
}

function capitalize(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-2-stability-credibility, Property 5: Tone Checker Detection Completeness", () => {
  /**
   * **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**
   *
   * For any evaluation script containing at least one prohibited content pattern
   * from any category (psychological inference, visual scope claim, punitive
   * language, or numerical score), the ToneChecker.check() method SHALL return
   * passed: false with at least one ToneViolation whose category matches the
   * pattern category and whose sentence contains the offending text.
   */
  it("detects prohibited patterns from any category and returns matching violation", () => {
    fc.assert(
      fc.property(arbitraryProhibitedSentence(), ({ category, phrase, script }) => {
        const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

        // Must fail — the script contains a prohibited pattern
        expect(result.passed).toBe(false);

        // Must have at least one violation matching the injected category
        const matchingViolations = result.violations.filter(
          (v) => v.category === category,
        );
        expect(matchingViolations.length).toBeGreaterThanOrEqual(1);

        // The violation's sentence must contain the offending phrase (case-insensitive)
        const hasMatchingSentence = matchingViolations.some(
          (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
        );
        expect(hasMatchingSentence).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Psychological inference patterns (Req 3.3) are detected regardless of
   * whether the sentence has an evidence marker.
   */
  it("detects psychological inference patterns even with markers present", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: PSYCHOLOGICAL_INFERENCE_PHRASES.length - 1 }),
        arbitraryCleanText(),
        (phraseIdx, suffix) => {
          const phrase = PSYCHOLOGICAL_INFERENCE_PHRASES[phraseIdx];
          const script = `${capitalize(phrase)} ${suffix}. [[Q:item-0]]`;

          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          expect(result.passed).toBe(false);
          const psychViolations = result.violations.filter(
            (v) => v.category === "psychological_inference",
          );
          expect(psychViolations.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Visual scope patterns (Req 3.4) are detected regardless of
   * whether the sentence has an evidence marker.
   */
  it("detects visual scope patterns even with markers present", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: VISUAL_SCOPE_PHRASES.length - 1 }),
        arbitraryCleanText(),
        (phraseIdx, prefix) => {
          const phrase = VISUAL_SCOPE_PHRASES[phraseIdx];
          const script = `${capitalize(prefix)} ${phrase} was notable. [[Q:item-0]]`;

          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          expect(result.passed).toBe(false);
          const visualViolations = result.violations.filter(
            (v) => v.category === "visual_scope",
          );
          expect(visualViolations.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Punitive language patterns (Req 3.5) are detected regardless of
   * whether the sentence has an evidence marker.
   */
  it("detects punitive language patterns even with markers present", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: PUNITIVE_LANGUAGE_PHRASES.length - 1 }),
        arbitraryCleanText(),
        (phraseIdx, suffix) => {
          const phrase = PUNITIVE_LANGUAGE_PHRASES[phraseIdx];
          const script = `${capitalize(phrase)} ${suffix}. [[M:wordsPerMinute]]`;

          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          expect(result.passed).toBe(false);
          const punitiveViolations = result.violations.filter(
            (v) => v.category === "punitive_language",
          );
          expect(punitiveViolations.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Numerical score patterns (Req 3.6) are detected regardless of
   * whether the sentence has an evidence marker.
   */
  it("detects numerical score patterns even with markers present", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: NUMERICAL_SCORE_PHRASES.length - 1 }),
        arbitraryCleanText(),
        (phraseIdx, prefix) => {
          const phrase = NUMERICAL_SCORE_PHRASES[phraseIdx];
          const script = `${capitalize(prefix)} ${phrase} overall. [[Q:item-0]]`;

          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          expect(result.passed).toBe(false);
          const scoreViolations = result.violations.filter(
            (v) => v.category === "numerical_score",
          );
          expect(scoreViolations.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Multi-sentence scripts: a prohibited pattern in one sentence should
   * cause the overall check to fail, even when other sentences are clean.
   */
  it("detects prohibited pattern in multi-sentence scripts with clean surrounding sentences", () => {
    fc.assert(
      fc.property(
        arbitraryCategoryAndPhrase(),
        arbitraryCleanText(),
        fc.integer({ min: 0, max: 2 }),
        ({ category, phrase }, cleanText, insertPosition) => {
          // Build 3 clean sentences + 1 prohibited sentence
          const cleanSentences = [
            "Great speech today.",
            "The topic was interesting.",
            "Well done overall.",
          ];

          // Insert the prohibited sentence at a random position
          const prohibitedSentence = `${capitalize(cleanText)} ${phrase} during the speech.`;
          const pos = Math.min(insertPosition, cleanSentences.length);
          const allSentences = [...cleanSentences];
          allSentences.splice(pos, 0, prohibitedSentence);

          const script = allSentences.join(" ");

          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          // Must fail
          expect(result.passed).toBe(false);

          // Must have a violation matching the category
          const matchingViolations = result.violations.filter(
            (v) => v.category === category,
          );
          expect(matchingViolations.length).toBeGreaterThanOrEqual(1);

          // The violation sentence must contain the phrase
          const hasMatch = matchingViolations.some(
            (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 6: Tone Violation Stripping Correctness ───────────────────────────
// Feature: phase-2-stability-credibility, Property 6: Tone Violation Stripping Correctness
//
// **Validates: Requirements 3.8**
//
// For any evaluation script and set of ToneViolation objects,
// ToneChecker.stripViolations() SHALL return a script where (a) none of the
// flagged sentences appear, (b) all non-flagged sentences are preserved in
// their original order, and (c) the result is a valid string (no orphaned
// whitespace or broken sentence structure).

import { splitSentences } from "./utils.js";
import type { ToneViolation } from "./types.js";

// ─── Generators for Property 6 ─────────────────────────────────────────────────

/**
 * Generator for a single clean sentence that won't accidentally contain
 * prohibited patterns or sentence-splitting punctuation mid-text.
 * Each sentence ends with exactly one terminal punctuation mark.
 */
function arbitrarySentence(): fc.Arbitrary<string> {
  const subjects = [
    "The speech", "Your opening", "The message", "Your closing",
    "The topic", "Your delivery", "The presentation", "Your approach",
  ];
  const verbs = [
    "was", "felt", "seemed", "appeared",
  ];
  // Avoid verbs from the assertive denylist and prohibited patterns
  // Use only safe, non-triggering words
  const safeVerbs = ["was", "is", "remains", "continues to be"];
  const adjectives = [
    "excellent", "wonderful", "remarkable", "impressive",
    "engaging", "thoughtful", "creative", "memorable",
    "compelling", "inspiring", "captivating", "brilliant",
  ];
  const endings: string[] = [".", "!", "?"];

  return fc
    .tuple(
      fc.constantFrom(...subjects),
      fc.constantFrom(...safeVerbs),
      fc.constantFrom(...adjectives),
      fc.constantFrom(...endings),
    )
    .map(([subject, verb, adj, ending]) => `${subject} ${verb} ${adj}${ending}`);
}

/**
 * Generator for a list of unique sentences (3-6 sentences).
 * Ensures no duplicate sentences so we can reliably track which are kept/removed.
 */
function arbitrarySentenceList(): fc.Arbitrary<string[]> {
  return fc
    .integer({ min: 3, max: 6 })
    .chain((count) =>
      fc
        .array(arbitrarySentence(), { minLength: count * 2, maxLength: count * 3 })
        .map((sentences) => {
          // Deduplicate and take the requested count
          const unique = [...new Set(sentences)];
          return unique.slice(0, Math.max(count, Math.min(unique.length, 6)));
        })
        .filter((arr) => arr.length >= 3),
    );
}

/**
 * Generator for a subset of indices to flag as violations.
 * Generates a non-empty subset of indices from [0, length).
 */
function arbitraryFlaggedIndices(length: number): fc.Arbitrary<number[]> {
  return fc
    .subarray(
      Array.from({ length }, (_, i) => i),
      { minLength: 1, maxLength: length },
    );
}

/**
 * Build ToneViolation objects for the flagged sentences.
 * Uses a fixed category since the stripping logic doesn't depend on category.
 */
function buildViolations(
  sentences: string[],
  flaggedIndices: number[],
): ToneViolation[] {
  const categories: ToneViolation["category"][] = [
    "psychological_inference",
    "visual_scope",
    "punitive_language",
    "numerical_score",
    "ungrounded_claim",
  ];
  return flaggedIndices.map((idx, i) => ({
    category: categories[i % categories.length],
    sentence: sentences[idx],
    pattern: "test-pattern",
    explanation: "test violation",
  }));
}

// ─── Property 6 Tests ───────────────────────────────────────────────────────────

describe("Feature: phase-2-stability-credibility, Property 6: Tone Violation Stripping Correctness", () => {
  /**
   * **Validates: Requirements 3.8**
   *
   * For any evaluation script and set of ToneViolation objects,
   * ToneChecker.stripViolations() SHALL return a script where:
   * (a) none of the flagged sentences appear,
   * (b) all non-flagged sentences are preserved in their original order, and
   * (c) the result is a valid string (no orphaned whitespace or broken sentence structure).
   */
  it("strips flagged sentences, preserves non-flagged in order, and produces valid output", () => {
    fc.assert(
      fc.property(
        arbitrarySentenceList().chain((sentences) =>
          arbitraryFlaggedIndices(sentences.length).map((flaggedIndices) => ({
            sentences,
            flaggedIndices,
          })),
        ),
        ({ sentences, flaggedIndices }) => {
          // Build the script from all sentences
          const script = sentences.join(" ");

          // Build violations for flagged sentences
          const violations = buildViolations(sentences, flaggedIndices);

          // Determine which sentences are NOT flagged
          const flaggedSet = new Set(flaggedIndices);
          const keptSentences = sentences.filter((_, i) => !flaggedSet.has(i));
          const flaggedSentences = sentences.filter((_, i) => flaggedSet.has(i));

          // Call stripViolations
          const result = checker.stripViolations(script, violations);

          // (a) None of the flagged sentences appear in the result
          for (const flagged of flaggedSentences) {
            expect(result).not.toContain(flagged);
          }

          // (b) All non-flagged sentences are preserved in their original order
          const resultSentences = splitSentences(result);
          // Strip markers from result sentences for comparison (stripViolations operates on marked script)
          const resultClean = resultSentences.map((s) => s.trim());
          const keptClean = keptSentences.map((s) => s.trim());

          expect(resultClean).toEqual(keptClean);

          // (c) The result is a valid string
          // - Trimmed (no leading/trailing whitespace)
          expect(result).toBe(result.trim());
          // - No double spaces
          expect(result).not.toMatch(/ {2,}/);
          // - If there are kept sentences, the result is non-empty
          if (keptSentences.length > 0) {
            expect(result.length).toBeGreaterThan(0);
          }
          // - If all sentences were flagged, result should be empty
          if (keptSentences.length === 0) {
            expect(result.trim()).toBe("");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 7: Scope Acknowledgment Conditional Append ────────────────────────
// Feature: phase-2-stability-credibility, Property 7: Scope Acknowledgment Conditional Append
//
// **Validates: Requirements 3.10, 6.7**
//
// For any evaluation script where qualityWarning is true OR hasStructureCommentary
// is true, ToneChecker.appendScopeAcknowledgment() SHALL return a script that ends
// with a sentence containing "based on audio content only" (or equivalent).
// For any script where both conditions are false, the script SHALL be returned
// unchanged. The append is idempotent — if the acknowledgment is already present,
// it SHALL NOT be duplicated.

// ─── Generators for Property 7 ─────────────────────────────────────────────────

/**
 * Generator for a clean evaluation script (random sentences joined together).
 * Avoids accidentally including "based on audio content only" in the generated text.
 */
function arbitraryCleanScript(): fc.Arbitrary<string> {
  const sentenceStarters = [
    "Your speech was well organized.",
    "The opening grabbed attention effectively.",
    "You maintained a steady pace throughout.",
    "The transitions between points were smooth.",
    "Your closing left a lasting impression.",
    "The use of examples strengthened your message.",
    "Your vocal variety kept the audience engaged.",
    "The structure of your speech was clear.",
    "You demonstrated strong preparation.",
    "The topic was presented with clarity.",
    "Your enthusiasm was evident in your delivery.",
    "The main points were easy to follow.",
  ];

  return fc
    .shuffledSubarray(sentenceStarters, { minLength: 1, maxLength: 6 })
    .map((sentences) => sentences.join(" "));
}

/**
 * Generator for the two boolean flags (qualityWarning, hasStructureCommentary)
 * where at least one is true — the "should append" case.
 */
function arbitraryAppendCondition(): fc.Arbitrary<{
  qualityWarning: boolean;
  hasStructureCommentary: boolean;
}> {
  return fc
    .tuple(fc.boolean(), fc.boolean())
    .filter(([qw, hsc]) => qw || hsc)
    .map(([qualityWarning, hasStructureCommentary]) => ({
      qualityWarning,
      hasStructureCommentary,
    }));
}

// ─── Property 7 Tests ───────────────────────────────────────────────────────────

describe("Feature: phase-2-stability-credibility, Property 7: Scope Acknowledgment Conditional Append", () => {
  /**
   * **Validates: Requirements 3.10, 6.7**
   *
   * Sub-property 1: When qualityWarning OR hasStructureCommentary is true,
   * the result ends with a sentence containing "based on audio content only".
   */
  it("appends scope acknowledgment when qualityWarning OR hasStructureCommentary is true", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const result = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
          );

          // Result must end with the scope acknowledgment phrase
          expect(result.toLowerCase()).toContain("based on audio content only");

          // The acknowledgment should be at the end of the script
          const lastSentence = result.trim().split(/[.!?]\s+/).pop() ?? "";
          expect(lastSentence.toLowerCase()).toContain("based on audio content only");
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.10, 6.7**
   *
   * Sub-property 2: When both qualityWarning and hasStructureCommentary are false,
   * the result equals the input script unchanged.
   */
  it("returns script unchanged when both qualityWarning and hasStructureCommentary are false", () => {
    fc.assert(
      fc.property(arbitraryCleanScript(), (script) => {
        const result = checker.appendScopeAcknowledgment(script, false, false);

        // Script must be returned exactly as-is
        expect(result).toBe(script);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.10, 6.7**
   *
   * Sub-property 3: Idempotency — calling appendScopeAcknowledgment twice
   * produces the same result as calling it once.
   */
  it("is idempotent — calling twice produces the same result as calling once", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const firstCall = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
          );
          const secondCall = checker.appendScopeAcknowledgment(
            firstCall,
            qualityWarning,
            hasStructureCommentary,
          );

          // Second call must produce the same result as the first
          expect(secondCall).toBe(firstCall);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 20: Marker Elimination After Tone Check ───────────────────────────
// Feature: phase-2-stability-credibility, Property 20: Marker Elimination After Tone Check
//
// **Validates: Requirements 11.2, 11.5**
//
// For any script that has passed through pipeline stage 5 (tone check + fix),
// the output SHALL NOT contain any `[[Q:` or `[[M:` marker substrings.
// Markers are emitted in stage 4 and stripped exactly once at the end of stage 5.

// ─── Generators for Property 20 ─────────────────────────────────────────────────

/**
 * Possible marker names for [[Q:*]] markers (evidence quote references).
 */
const QUOTE_MARKER_NAMES: string[] = [
  "item-0",
  "item-1",
  "item-2",
  "item-3",
  "item-4",
  "item-5",
  "item-6",
  "item-7",
  "item-8",
  "item-9",
];

/**
 * Possible marker names for [[M:*]] markers (metrics field references).
 */
const METRICS_MARKER_NAMES: string[] = [
  "wordsPerMinute",
  "fillerWordCount",
  "fillerWordFrequency",
  "durationSeconds",
  "pauseCount",
  "totalPauseDurationSeconds",
  "intentionalPauseCount",
  "hesitationPauseCount",
  "energyVariationCoefficient",
  "totalWords",
];

/**
 * Generator for a single [[Q:*]] marker string.
 */
function arbitraryQuoteMarker(): fc.Arbitrary<string> {
  return fc.constantFrom(...QUOTE_MARKER_NAMES).map((name) => `[[Q:${name}]]`);
}

/**
 * Generator for a single [[M:*]] marker string.
 */
function arbitraryMetricsMarker(): fc.Arbitrary<string> {
  return fc.constantFrom(...METRICS_MARKER_NAMES).map((name) => `[[M:${name}]]`);
}

/**
 * Generator for any marker (either Q or M type).
 */
function arbitraryMarker(): fc.Arbitrary<string> {
  return fc.oneof(arbitraryQuoteMarker(), arbitraryMetricsMarker());
}

/**
 * Generator for a clean sentence fragment that won't contain marker-like substrings.
 * Uses safe words that cannot accidentally form [[Q: or [[M: patterns.
 */
function arbitraryCleanSentenceFragment(): fc.Arbitrary<string> {
  const safeWords = [
    "The", "speech", "was", "very", "well", "organized",
    "Your", "opening", "grabbed", "attention", "effectively",
    "You", "maintained", "a", "steady", "pace", "throughout",
    "The", "transitions", "between", "points", "were", "smooth",
    "closing", "left", "lasting", "impression", "on", "everyone",
    "use", "of", "examples", "strengthened", "your", "message",
    "vocal", "variety", "kept", "audience", "engaged",
    "structure", "clear", "and", "easy", "to", "follow",
  ];
  return fc
    .array(fc.constantFrom(...safeWords), { minLength: 3, maxLength: 10 })
    .map((words) => words.join(" "));
}

/**
 * Generator for a sentence ending with terminal punctuation.
 */
function arbitraryCompleteSentence(): fc.Arbitrary<string> {
  const endings = [".", "!", "?"];
  return fc
    .tuple(arbitraryCleanSentenceFragment(), fc.constantFrom(...endings))
    .map(([fragment, ending]) => `${fragment}${ending}`);
}

/**
 * Generator for a script with randomly placed markers.
 * Produces a script string with 2-6 sentences, each optionally followed
 * by one or more markers. Also returns the expected clean text (without markers).
 */
function arbitraryMarkedScript(): fc.Arbitrary<{
  markedScript: string;
  expectedCleanParts: string[];
  markerCount: number;
}> {
  return fc
    .integer({ min: 2, max: 6 })
    .chain((sentenceCount) =>
      fc
        .tuple(
          fc.array(arbitraryCompleteSentence(), {
            minLength: sentenceCount,
            maxLength: sentenceCount,
          }),
          fc.array(
            fc.tuple(
              // How many markers after this sentence (0-3)
              fc.integer({ min: 0, max: 3 }),
              // Which markers to use
              fc.array(arbitraryMarker(), { minLength: 3, maxLength: 3 }),
            ),
            { minLength: sentenceCount, maxLength: sentenceCount },
          ),
        )
        .map(([sentences, markerConfigs]) => {
          const parts: string[] = [];
          const expectedCleanParts: string[] = [];
          let markerCount = 0;

          for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            const [numMarkers, markers] = markerConfigs[i];
            const actualMarkerCount = Math.min(numMarkers, markers.length);

            // Build the marked version
            let markedPart = sentence;
            for (let m = 0; m < actualMarkerCount; m++) {
              markedPart += ` ${markers[m]}`;
              markerCount++;
            }

            parts.push(markedPart);
            expectedCleanParts.push(sentence);
          }

          return {
            markedScript: parts.join(" "),
            expectedCleanParts,
            markerCount,
          };
        }),
    );
}

/**
 * Generator for a script that always has at least one marker.
 * Ensures we're testing the stripping behavior on scripts that actually contain markers.
 */
function arbitraryMarkedScriptWithMarkers(): fc.Arbitrary<{
  markedScript: string;
  expectedCleanParts: string[];
  markerCount: number;
}> {
  return arbitraryMarkedScript().filter(({ markerCount }) => markerCount > 0);
}

// ─── Property 20 Tests ──────────────────────────────────────────────────────────

describe("Feature: phase-2-stability-credibility, Property 20: Marker Elimination After Tone Check", () => {
  /**
   * **Validates: Requirements 11.2, 11.5**
   *
   * For any script with randomly placed [[Q:*]] and [[M:*]] markers,
   * calling stripMarkers() SHALL produce output that contains no
   * [[Q: or [[M: marker substrings.
   */
  it("stripMarkers() eliminates all [[Q:*]] and [[M:*]] markers from any marked script", () => {
    fc.assert(
      fc.property(arbitraryMarkedScriptWithMarkers(), ({ markedScript }) => {
        const result = checker.stripMarkers(markedScript);

        // The result must NOT contain any [[Q: or [[M: marker substrings
        expect(result).not.toContain("[[Q:");
        expect(result).not.toContain("[[M:");

        // Also verify no partial marker remnants (closing brackets from markers)
        expect(result).not.toMatch(/\[\[(Q|M):[^\]]*\]\]/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 11.2, 11.5**
   *
   * For any script with randomly placed markers, calling stripMarkers()
   * SHALL preserve all non-marker text content. The clean sentences from
   * the original script must all appear in the stripped result.
   */
  it("stripMarkers() preserves all non-marker text content", () => {
    fc.assert(
      fc.property(
        arbitraryMarkedScriptWithMarkers(),
        ({ markedScript, expectedCleanParts }) => {
          const result = checker.stripMarkers(markedScript);

          // Every clean sentence from the original must appear in the result
          for (const cleanPart of expectedCleanParts) {
            expect(result).toContain(cleanPart);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 11.2, 11.5**
   *
   * The stripped result must be a valid string: trimmed, no double spaces,
   * and no orphaned whitespace from marker removal.
   */
  it("stripMarkers() produces valid whitespace-normalized output", () => {
    fc.assert(
      fc.property(arbitraryMarkedScript(), ({ markedScript }) => {
        const result = checker.stripMarkers(markedScript);

        // Result must be trimmed
        expect(result).toBe(result.trim());

        // No double spaces
        expect(result).not.toMatch(/ {2,}/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 11.2, 11.5**
   *
   * Scripts with no markers should pass through stripMarkers() unchanged
   * (modulo whitespace normalization).
   */
  it("stripMarkers() returns marker-free scripts unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryCompleteSentence(), { minLength: 1, maxLength: 5 }).map(
          (sentences) => sentences.join(" "),
        ),
        (cleanScript) => {
          const result = checker.stripMarkers(cleanScript);

          // A clean script should be returned as-is (after trim/normalize)
          const normalized = cleanScript.replace(/ {2,}/g, " ").trim();
          expect(result).toBe(normalized);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 18: Tone checker flags visual emotion inference and intent attribution ─
// Feature: phase-4-multimodal-video, Property 18
//
// **Validates: Requirements 6.5, 7.1**
//
// For any sentence containing a visual emotion inference pattern (e.g.,
// "you looked nervous", "your expression showed anxiety", "you were trying
// to appear confident"), the Tone_Checker SHALL produce a violation with
// category `visual_emotion_inference`. For any sentence that does not match
// any visual emotion inference pattern, the Tone_Checker SHALL NOT produce
// a `visual_emotion_inference` violation for that sentence.

// ─── Generators for Property 18 ─────────────────────────────────────────────────

/**
 * Emotion/state words used in visual emotion inference patterns.
 * These are the adjectives/nouns that appear in the actual regex patterns.
 */
const EMOTION_ADJECTIVES = [
  "nervous", "uncomfortable", "distracted", "confident", "anxious",
  "worried", "stressed", "tense", "frustrated", "bored", "excited",
  "happy", "sad", "angry", "scared", "shy", "timid", "overwhelmed",
] as const;

const EMOTION_NOUNS = [
  "nervousness", "anxiety", "confidence", "discomfort",
  "frustration", "tension", "stress",
] as const;

const EMOTION_SIGNS = [
  "fear", "anxiety", "nervousness", "stress",
  "discomfort", "frustration", "tension", "confidence",
] as const;

/**
 * Generator: "you looked/seemed/appeared <emotion>" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[0].
 */
function arbitraryLookedEmotion(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom("looked", "seemed", "appeared"),
    fc.constantFrom(...EMOTION_ADJECTIVES),
  ).map(([verb, emotion]) => `you ${verb} ${emotion}`);
}

/**
 * Generator: "your face/expression/... showed/revealed/..." pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[1].
 */
function arbitraryExpressionShowed(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom("face", "expression", "eyes", "body language", "gesture", "gestures"),
    fc.constantFrom("showed", "revealed", "indicated", "suggested", "betrayed"),
  ).map(([part, verb]) => `your ${part} ${verb}`);
}

/**
 * Generator: "you were trying to appear/look/seem" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[2].
 */
function arbitraryTryingToAppear(): fc.Arbitrary<string> {
  return fc.constantFrom("appear", "look", "seem")
    .map((verb) => `you were trying to ${verb}`);
}

/**
 * Generator: "your <emotion noun>" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[4].
 */
function arbitraryYourEmotionNoun(): fc.Arbitrary<string> {
  return fc.constantFrom(...EMOTION_NOUNS)
    .map((noun) => `your ${noun}`);
}

/**
 * Emotion adjectives in the "you were ..." pattern (pattern [5]).
 * This is a subset of EMOTION_ADJECTIVES — "worried" and "distracted"
 * are only in the "looked/seemed/appeared" pattern, not the "you were" pattern.
 */
const YOU_WERE_EMOTIONS = [
  "nervous", "uncomfortable", "confident", "anxious",
  "stressed", "tense", "frustrated", "bored", "excited",
  "happy", "sad", "angry", "scared", "shy", "timid", "overwhelmed",
] as const;

/**
 * Generator: "you were (clearly|obviously)? <emotion>" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[5].
 */
function arbitraryYouWereEmotion(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom("", "clearly ", "obviously "),
    fc.constantFrom(...YOU_WERE_EMOTIONS),
  ).map(([adverb, emotion]) => `you were ${adverb}${emotion}`);
}

/**
 * Generator: "showed signs of <emotion>" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[6].
 */
function arbitraryShowedSignsOf(): fc.Arbitrary<string> {
  return fc.constantFrom(...EMOTION_SIGNS)
    .map((sign) => `showed signs of ${sign}`);
}

/**
 * Generator: "was clearly <emotion>" pattern.
 * Matches VISUAL_EMOTION_INFERENCE_PATTERNS[7].
 */
function arbitraryWasClearly(): fc.Arbitrary<string> {
  return fc.constantFrom(
    "stressed", "nervous", "anxious", "uncomfortable",
    "confident", "frustrated", "tense", "overwhelmed",
  ).map((emotion) => `was clearly ${emotion}`);
}

/**
 * Generator that picks any visual emotion inference phrase from all pattern groups.
 */
function arbitraryVisualEmotionPhrase(): fc.Arbitrary<string> {
  return fc.oneof(
    arbitraryLookedEmotion(),
    arbitraryExpressionShowed(),
    arbitraryTryingToAppear(),
    fc.constant("you felt"),
    arbitraryYourEmotionNoun(),
    arbitraryYouWereEmotion(),
    arbitraryShowedSignsOf(),
    arbitraryWasClearly(),
  );
}

/**
 * Generator for clean filler text that does NOT trigger any tone checker patterns.
 * Uses safe words that won't accidentally match visual emotion inference,
 * psychological inference, visual scope, punitive, or numerical score patterns.
 */
function arbitraryEmotionSafeText(): fc.Arbitrary<string> {
  const safeWords = [
    "the", "speech", "had", "a", "well", "organized",
    "topic", "interesting", "with", "clear", "message",
    "and", "strong", "delivery", "overall", "this",
    "is", "an", "excellent", "presentation", "thank",
    "for", "sharing", "that", "wonderful", "story",
    "during", "the", "opening", "section", "of",
  ];
  return fc
    .array(fc.constantFrom(...safeWords), { minLength: 2, maxLength: 6 })
    .map((words) => words.join(" "));
}

/**
 * Build a full sentence containing a visual emotion inference phrase
 * embedded in safe filler text.
 */
function arbitraryVisualEmotionSentence(): fc.Arbitrary<{
  phrase: string;
  sentence: string;
}> {
  return fc.tuple(
    arbitraryVisualEmotionPhrase(),
    arbitraryEmotionSafeText(),
    arbitraryEmotionSafeText(),
  ).map(([phrase, prefix, suffix]) => {
    const sentence = `${capitalize(prefix)} ${phrase} ${suffix}.`;
    return { phrase, sentence };
  });
}

/**
 * Generator for sentences that should NOT trigger visual_emotion_inference.
 * Uses purely observational, metric-based language.
 */
function arbitraryNonEmotionSentence(): fc.Arbitrary<string> {
  const safeSentences = [
    "I observed audience-facing gaze at 65% of the speech.",
    "The total gesture count was 12 during the presentation.",
    "Your speech had a clear and well-organized structure.",
    "The opening section was engaging and set the tone well.",
    "I noticed a steady pace throughout the delivery.",
    "The transitions between points were smooth and natural.",
    "Your closing left a lasting impression on the audience.",
    "The use of examples strengthened the overall message.",
    "Your vocal variety kept the audience engaged throughout.",
    "The main points were easy to follow and well supported.",
    "I observed a mean body stability score of 0.85.",
    "The facial energy variation coefficient was 0.32.",
  ];
  return fc.constantFrom(...safeSentences);
}

// ─── Property 18 Tests ──────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 18: Tone checker flags visual emotion inference and intent attribution", () => {
  /**
   * **Validates: Requirements 6.5, 7.1**
   *
   * For any sentence containing a visual emotion inference pattern,
   * the ToneChecker SHALL produce a violation with category `visual_emotion_inference`.
   */
  it("flags sentences containing visual emotion inference patterns", () => {
    fc.assert(
      fc.property(arbitraryVisualEmotionSentence(), ({ phrase, sentence }) => {
        const script = sentence;
        const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

        // Must have at least one visual_emotion_inference violation
        const emotionViolations = result.violations.filter(
          (v) => v.category === "visual_emotion_inference",
        );
        expect(emotionViolations.length).toBeGreaterThanOrEqual(1);

        // The violation sentence must contain the offending phrase
        const hasMatch = emotionViolations.some(
          (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
        );
        expect(hasMatch).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 6.5, 7.1**
   *
   * For any sentence that does NOT match any visual emotion inference pattern,
   * the ToneChecker SHALL NOT produce a `visual_emotion_inference` violation.
   */
  it("does not flag sentences without visual emotion inference patterns", () => {
    fc.assert(
      fc.property(arbitraryNonEmotionSentence(), (sentence) => {
        const result = checker.check(sentence, STUB_EVALUATION, STUB_METRICS);

        const emotionViolations = result.violations.filter(
          (v) => v.category === "visual_emotion_inference",
        );
        expect(emotionViolations).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5, 7.1**
   *
   * Visual emotion inference detection works in multi-sentence scripts:
   * a prohibited phrase in one sentence causes a violation even when
   * surrounded by clean sentences.
   */
  it("detects visual emotion inference in multi-sentence scripts with clean surrounding text", () => {
    fc.assert(
      fc.property(
        arbitraryVisualEmotionSentence(),
        fc.integer({ min: 0, max: 2 }),
        ({ phrase, sentence }, insertPos) => {
          const cleanSentences = [
            "Great speech today.",
            "The topic was interesting.",
            "Well done overall.",
          ];
          const pos = Math.min(insertPos, cleanSentences.length);
          const allSentences = [...cleanSentences];
          allSentences.splice(pos, 0, sentence);

          const script = allSentences.join(" ");
          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          const emotionViolations = result.violations.filter(
            (v) => v.category === "visual_emotion_inference",
          );
          expect(emotionViolations.length).toBeGreaterThanOrEqual(1);

          const hasMatch = emotionViolations.some(
            (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5, 7.1**
   *
   * Visual emotion inference is detected regardless of hasVideo flag —
   * emotion/intent attribution from visual data is always prohibited.
   */
  it("flags visual emotion inference regardless of hasVideo option", () => {
    fc.assert(
      fc.property(
        arbitraryVisualEmotionSentence(),
        fc.boolean(),
        ({ phrase, sentence }, hasVideo) => {
          const result = checker.check(
            sentence,
            STUB_EVALUATION,
            STUB_METRICS,
            { hasVideo },
          );

          const emotionViolations = result.violations.filter(
            (v) => v.category === "visual_emotion_inference",
          );
          expect(emotionViolations.length).toBeGreaterThanOrEqual(1);

          const hasMatch = emotionViolations.some(
            (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 19 Generators ─────────────────────────────────────────────────────

/**
 * Adjectives in VISUAL_JUDGMENT_PATTERNS[0]: "<adjective> <visual noun>".
 * This pattern has the full set including wonderful/fantastic/amazing.
 */
const JUDGMENT_ADJECTIVES_PREFIX = [
  "great", "good", "excellent", "wonderful", "fantastic", "amazing",
  "poor", "bad", "weak", "awkward", "terrible", "impressive",
  "effective", "strong", "natural",
] as const;

/**
 * Adjectives in VISUAL_JUDGMENT_PATTERNS[1]: "<visual noun> was/were <adjective>".
 * This pattern has a smaller set — no wonderful/fantastic/amazing.
 */
const JUDGMENT_ADJECTIVES_SUFFIX = [
  "great", "good", "excellent", "poor", "bad", "weak", "awkward",
  "effective", "strong", "natural", "impressive", "terrible",
] as const;

/**
 * Visual delivery nouns that appear in VISUAL_JUDGMENT_PATTERNS.
 */
const VISUAL_DELIVERY_NOUNS = [
  "eye contact", "posture", "gestures", "gesture",
  "stage presence", "body language", "movement",
] as const;

/**
 * Generator: "<adjective> <visual noun>" pattern.
 * Matches VISUAL_JUDGMENT_PATTERNS[0]: e.g., "great eye contact", "poor posture".
 */
function arbitraryAdjectiveVisualNoun(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...JUDGMENT_ADJECTIVES_PREFIX),
    fc.constantFrom(...VISUAL_DELIVERY_NOUNS),
  ).map(([adj, noun]) => `${adj} ${noun}`);
}

/**
 * Generator: "<visual noun> was/were <adjective>" pattern.
 * Matches VISUAL_JUDGMENT_PATTERNS[1]: e.g., "eye contact was great".
 */
function arbitraryVisualNounWasAdjective(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...VISUAL_DELIVERY_NOUNS),
    fc.constantFrom("was", "were"),
    fc.constantFrom(...JUDGMENT_ADJECTIVES_SUFFIX),
  ).map(([noun, verb, adj]) => `${noun} ${verb} ${adj}`);
}

/**
 * Visual nouns that appear in the "lacked" pattern (VISUAL_JUDGMENT_PATTERNS[2]).
 */
const LACKED_VISUAL_NOUNS = [
  "eye contact", "gestures", "gesture", "stage presence", "movement",
] as const;

/**
 * Generator: "lacked <visual noun>" pattern.
 * Matches VISUAL_JUDGMENT_PATTERNS[2]: e.g., "lacked eye contact".
 */
function arbitraryLackedVisualNoun(): fc.Arbitrary<string> {
  return fc.constantFrom(...LACKED_VISUAL_NOUNS)
    .map((noun) => `lacked ${noun}`);
}

/**
 * Generator that picks any visual judgment phrase from all pattern groups.
 */
function arbitraryVisualJudgmentPhrase(): fc.Arbitrary<string> {
  return fc.oneof(
    arbitraryAdjectiveVisualNoun(),
    arbitraryVisualNounWasAdjective(),
    arbitraryLackedVisualNoun(),
  );
}

/**
 * Generator for clean filler text that does NOT trigger any tone checker patterns.
 * Reuses the same safe word set as the emotion tests.
 */
function arbitraryJudgmentSafeText(): fc.Arbitrary<string> {
  const safeWords = [
    "the", "speech", "had", "a", "well", "organized",
    "topic", "interesting", "with", "clear", "message",
    "and", "delivery", "overall", "this",
    "is", "an", "presentation", "thank",
    "for", "sharing", "that", "story",
    "during", "opening", "section", "of",
  ];
  return fc
    .array(fc.constantFrom(...safeWords), { minLength: 2, maxLength: 6 })
    .map((words) => words.join(" "));
}

/**
 * Build a full sentence containing a visual judgment phrase
 * embedded in safe filler text.
 */
function arbitraryVisualJudgmentSentence(): fc.Arbitrary<{
  phrase: string;
  sentence: string;
}> {
  return fc.tuple(
    arbitraryVisualJudgmentPhrase(),
    arbitraryJudgmentSafeText(),
    arbitraryJudgmentSafeText(),
  ).map(([phrase, prefix, suffix]) => {
    const sentence = `${capitalize(prefix)} ${phrase} ${suffix}.`;
    return { phrase, sentence };
  });
}

/**
 * Generator for sentences with visual terms AND metric-anchored numbers.
 * These should NOT trigger visual_judgment violations because they
 * reference specific measurements rather than making subjective claims.
 */
function arbitraryMetricAnchoredVisualSentence(): fc.Arbitrary<string> {
  const metricSentences = [
    "I observed audience-facing gaze at 65% of the speech.",
    "The total gesture count was 12 during the presentation.",
    "I observed a mean body stability score of 0.85.",
    "The facial energy variation coefficient was 0.32.",
    "Audience-facing gaze was measured at 78%.",
    "I observed 8 gestures per minute during the speech.",
    "The stability score of 0.72 indicates moderate movement.",
    "I noted 3 stage crossings during the presentation.",
    "Gaze was audience-facing for 82% of analyzed frames.",
    "The gesture frequency was 5.2 gestures per minute.",
  ];
  return fc.constantFrom(...metricSentences);
}

// ─── Property 19 Tests ──────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 19: Tone checker flags visual judgment without metric-anchored measurement", () => {
  /**
   * **Validates: Requirements 7.2**
   *
   * For any sentence containing a subjective visual quality judgment
   * without a metric-anchored numeric measurement, the ToneChecker SHALL
   * produce a violation with category `visual_judgment`.
   */
  it("flags sentences containing subjective visual quality judgments", () => {
    fc.assert(
      fc.property(arbitraryVisualJudgmentSentence(), ({ phrase, sentence }) => {
        const script = sentence;
        const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

        const judgmentViolations = result.violations.filter(
          (v) => v.category === "visual_judgment",
        );
        expect(judgmentViolations.length).toBeGreaterThanOrEqual(1);

        // The violation sentence must contain the offending phrase
        const hasMatch = judgmentViolations.some(
          (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
        );
        expect(hasMatch).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.2**
   *
   * For any sentence containing a visual term accompanied by a
   * metric-anchored numeric measurement, the ToneChecker SHALL NOT
   * produce a `visual_judgment` violation.
   */
  it("does not flag metric-anchored visual observation sentences", () => {
    fc.assert(
      fc.property(arbitraryMetricAnchoredVisualSentence(), (sentence) => {
        const result = checker.check(sentence, STUB_EVALUATION, STUB_METRICS);

        const judgmentViolations = result.violations.filter(
          (v) => v.category === "visual_judgment",
        );
        expect(judgmentViolations).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.2**
   *
   * Visual judgment detection works in multi-sentence scripts:
   * a subjective judgment in one sentence causes a violation even when
   * surrounded by clean sentences.
   */
  it("detects visual judgment in multi-sentence scripts with clean surrounding text", () => {
    fc.assert(
      fc.property(
        arbitraryVisualJudgmentSentence(),
        fc.integer({ min: 0, max: 2 }),
        ({ phrase, sentence }, insertPos) => {
          const cleanSentences = [
            "Your speech was well structured.",
            "The topic was interesting.",
            "Well done overall.",
          ];
          const pos = Math.min(insertPos, cleanSentences.length);
          const allSentences = [...cleanSentences];
          allSentences.splice(pos, 0, sentence);

          const script = allSentences.join(" ");
          const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);

          const judgmentViolations = result.violations.filter(
            (v) => v.category === "visual_judgment",
          );
          expect(judgmentViolations.length).toBeGreaterThanOrEqual(1);

          const hasMatch = judgmentViolations.some(
            (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.2**
   *
   * Visual judgment is detected regardless of hasVideo flag —
   * subjective quality judgments about visual delivery are always prohibited.
   */
  it("flags visual judgment regardless of hasVideo option", () => {
    fc.assert(
      fc.property(
        arbitraryVisualJudgmentSentence(),
        fc.boolean(),
        ({ phrase, sentence }, hasVideo) => {
          const result = checker.check(
            sentence,
            STUB_EVALUATION,
            STUB_METRICS,
            { hasVideo },
          );

          const judgmentViolations = result.violations.filter(
            (v) => v.category === "visual_judgment",
          );
          expect(judgmentViolations.length).toBeGreaterThanOrEqual(1);

          const hasMatch = judgmentViolations.some(
            (v) => v.sentence.toLowerCase().includes(phrase.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 20 Generators ─────────────────────────────────────────────────────

/**
 * Visual scope terms that trigger VISUAL_SCOPE_PATTERNS.
 * These are the terms that are context-dependent based on hasVideo.
 */
const VISUAL_SCOPE_TERMS = [
  "eye contact",
  "body language",
  "facial expression",
  "gesture",
  "gestures",
  "posture",
  "looked at",
  "smiled",
  "nodded",
  "hand movement",
  "stood",
  "walked",
  "paced",
  "fidgeted",
  "leaned",
  "crossed arms",
  "made eye contact",
  "your face",
  "your eyes",
  "your hands",
  "your stance",
] as const;

/**
 * Safe filler words that won't trigger any tone checker patterns.
 */
function arbitraryScopeSafeText(): fc.Arbitrary<string> {
  const safeWords = [
    "the", "speech", "had", "a", "well", "organized",
    "topic", "interesting", "with", "clear", "message",
    "and", "delivery", "overall", "this",
    "is", "an", "presentation", "thank",
    "for", "sharing", "that", "story",
    "during", "opening", "section", "of",
  ];
  return fc
    .array(fc.constantFrom(...safeWords), { minLength: 2, maxLength: 5 })
    .map((words) => words.join(" "));
}

/**
 * Generator for sentences containing a visual scope term WITHOUT any
 * metric-anchored number. These should trigger visual_scope violations
 * regardless of hasVideo.
 */
function arbitraryUnanchoredVisualSentence(): fc.Arbitrary<{
  term: string;
  sentence: string;
}> {
  return fc.tuple(
    fc.constantFrom(...VISUAL_SCOPE_TERMS),
    arbitraryScopeSafeText(),
    arbitraryScopeSafeText(),
  ).map(([term, prefix, suffix]) => {
    const sentence = `${capitalize(prefix)} ${term} ${suffix}.`;
    return { term, sentence };
  });
}

/**
 * Recognized visual metric keys from the VisualObservations schema.
 */
const RECOGNIZED_METRIC_KEYS = [
  "gazeBreakdown.audienceFacing",
  "gazeBreakdown.notesFacing",
  "gazeBreakdown.other",
  "faceNotDetectedCount",
  "totalGestureCount",
  "gestureFrequency",
  "gesturePerSentenceRatio",
  "meanBodyStabilityScore",
  "stageCrossingCount",
  "movementClassification",
  "meanFacialEnergyScore",
  "facialEnergyVariation",
] as const;

/**
 * Non-existent metric keys that should fail validateMetricKeyExists.
 */
const FAKE_METRIC_KEYS = [
  "gazeBreakdown.leftFacing",
  "emotionScore",
  "confidenceLevel",
  "handShakeCount",
  "blinkRate",
  "smileFrequency",
  "headTiltAngle",
  "shoulderWidth",
  "fakeMetric",
  "totalBlinks",
] as const;

/**
 * Generator for sentences with visual scope terms (matching VISUAL_SCOPE_PATTERNS)
 * AND metric-anchored numbers. These should be permitted when hasVideo is true
 * but flagged when hasVideo is false.
 *
 * Each sentence uses a term from VISUAL_SCOPE_PATTERNS (e.g., "eye contact",
 * "gesture", "posture") combined with a metric-anchored number.
 */
function arbitraryAnchoredVisualSentence(): fc.Arbitrary<string> {
  return fc.oneof(
    // "eye contact" + percentage
    fc.integer({ min: 1, max: 99 }).map(
      (n) => `I observed audience-facing gaze with eye contact at ${n}% of the speech.`,
    ),
    // "gesture" + count with unit
    fc.integer({ min: 1, max: 50 }).map(
      (n) => `The gesture count was ${n} gestures during the speech.`,
    ),
    // "gestures" + frequency
    fc.integer({ min: 1, max: 20 }).map(
      (n) => `I observed ${n} gestures per minute during the speech.`,
    ),
    // "body language" + stability score
    fc.integer({ min: 10, max: 99 }).map(
      (n) => `I observed body language with a stability score of 0.${n} overall.`,
    ),
    // "posture" + stability score
    fc.integer({ min: 10, max: 99 }).map(
      (n) => `The posture showed a stability score of 0.${n} throughout.`,
    ),
    // "hand movement" + count
    fc.integer({ min: 1, max: 30 }).map(
      (n) => `I observed hand movement with ${n} gestures during the speech.`,
    ),
  );
}

/**
 * Generator for valid observation_data strings referencing real metric keys.
 */
function arbitraryValidObservationData(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...RECOGNIZED_METRIC_KEYS),
    fc.integer({ min: 0, max: 100 }),
  ).map(([key, value]) => `metric=${key}; value=${value}; source=visualObservations`);
}

/**
 * Generator for invalid observation_data strings referencing fake metric keys.
 */
function arbitraryInvalidObservationData(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom(...FAKE_METRIC_KEYS),
    fc.integer({ min: 0, max: 100 }),
  ).map(([key, value]) => `metric=${key}; value=${value}; source=visualObservations`);
}

// ─── Property 20 Tests ──────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 20: Context-dependent visual scope enforcement with metric-anchored numbers", () => {
  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * When hasVideo is false, any sentence containing a visual scope term
   * SHALL trigger a visual_scope violation regardless of whether it
   * contains metric-anchored numbers.
   */
  it("flags visual terms as visual_scope violations when hasVideo is false", () => {
    fc.assert(
      fc.property(arbitraryUnanchoredVisualSentence(), ({ term, sentence }) => {
        const result = checker.check(
          sentence,
          STUB_EVALUATION,
          STUB_METRICS,
          { hasVideo: false },
        );

        const scopeViolations = result.violations.filter(
          (v) => v.category === "visual_scope",
        );
        expect(scopeViolations.length).toBeGreaterThanOrEqual(1);

        const hasMatch = scopeViolations.some(
          (v) => v.sentence.toLowerCase().includes(term.toLowerCase()),
        );
        expect(hasMatch).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * When hasVideo is false, even metric-anchored visual sentences
   * SHALL trigger visual_scope violations — video is not available,
   * so visual terms are always out of scope.
   */
  it("flags metric-anchored visual sentences as visual_scope violations when hasVideo is false", () => {
    fc.assert(
      fc.property(arbitraryAnchoredVisualSentence(), (sentence) => {
        const result = checker.check(
          sentence,
          STUB_EVALUATION,
          STUB_METRICS,
          { hasVideo: false },
        );

        const scopeViolations = result.violations.filter(
          (v) => v.category === "visual_scope",
        );
        expect(scopeViolations.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * When hasVideo is true, visual terms WITHOUT metric-anchored numbers
   * SHALL trigger visual_scope violations.
   */
  it("flags unanchored visual terms as visual_scope violations when hasVideo is true", () => {
    fc.assert(
      fc.property(arbitraryUnanchoredVisualSentence(), ({ term, sentence }) => {
        const result = checker.check(
          sentence,
          STUB_EVALUATION,
          STUB_METRICS,
          { hasVideo: true },
        );

        const scopeViolations = result.violations.filter(
          (v) => v.category === "visual_scope",
        );
        expect(scopeViolations.length).toBeGreaterThanOrEqual(1);

        const hasMatch = scopeViolations.some(
          (v) => v.sentence.toLowerCase().includes(term.toLowerCase()),
        );
        expect(hasMatch).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * When hasVideo is true, visual terms WITH metric-anchored numbers
   * SHALL be permitted (no visual_scope violation).
   */
  it("permits metric-anchored visual sentences when hasVideo is true", () => {
    fc.assert(
      fc.property(arbitraryAnchoredVisualSentence(), (sentence) => {
        const result = checker.check(
          sentence,
          STUB_EVALUATION,
          STUB_METRICS,
          { hasVideo: true },
        );

        const scopeViolations = result.violations.filter(
          (v) => v.category === "visual_scope",
        );
        expect(scopeViolations).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * The hasMetricAnchoredNumber helper requires BOTH a recognized visual
   * metric term AND a numeric value. A sentence with a visual metric term
   * but no number, or a number but no metric term, should not pass.
   */
  it("hasMetricAnchoredNumber requires both metric term and numeric value", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          // Has metric term but no number
          "The gaze was directed at the audience.",
          "Stability was maintained throughout.",
          "Gestures were used during the speech.",
          "Facial energy was observed.",
          "Movement was noted on stage.",
          // Has number but no metric term
          "The speech lasted 120 seconds.",
          "There were 5 main points.",
          "The speaker used 3 examples.",
          "A score of 0.85 was recorded.",
        ),
        (sentence) => {
          expect(hasMetricAnchoredNumber(sentence)).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * The validateMetricKeyExists helper validates that observation_data
   * references an actual metric field from the VisualObservations schema.
   * Valid keys pass; non-existent keys fail.
   */
  it("validateMetricKeyExists accepts recognized metric keys", () => {
    fc.assert(
      fc.property(arbitraryValidObservationData(), (observationData) => {
        expect(validateMetricKeyExists(observationData)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * The validateMetricKeyExists helper rejects observation_data strings
   * that reference non-existent metric fields.
   */
  it("validateMetricKeyExists rejects non-existent metric keys", () => {
    fc.assert(
      fc.property(arbitraryInvalidObservationData(), (observationData) => {
        expect(validateMetricKeyExists(observationData)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * Context-dependent behavior in multi-sentence scripts: when hasVideo is true,
   * an unanchored visual sentence triggers a violation even when surrounded by
   * clean sentences, while metric-anchored visual sentences do not.
   */
  it("enforces context-dependent scope in multi-sentence scripts", () => {
    fc.assert(
      fc.property(
        arbitraryUnanchoredVisualSentence(),
        arbitraryAnchoredVisualSentence(),
        fc.integer({ min: 0, max: 2 }),
        ({ term, sentence: unanchored }, anchored, insertPos) => {
          const cleanSentences = [
            "Your speech was well structured.",
            anchored,
            "Well done overall.",
          ];
          const pos = Math.min(insertPos, cleanSentences.length);
          const allSentences = [...cleanSentences];
          allSentences.splice(pos, 0, unanchored);

          const script = allSentences.join(" ");
          const result = checker.check(
            script,
            STUB_EVALUATION,
            STUB_METRICS,
            { hasVideo: true },
          );

          // The unanchored sentence should trigger a visual_scope violation
          const scopeViolations = result.violations.filter(
            (v) => v.category === "visual_scope",
          );
          expect(scopeViolations.length).toBeGreaterThanOrEqual(1);

          // The violation should be for the unanchored sentence
          const hasMatch = scopeViolations.some(
            (v) => v.sentence.toLowerCase().includes(term.toLowerCase()),
          );
          expect(hasMatch).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.5, 7.7**
   *
   * Default behavior (no options): visual terms trigger visual_scope
   * violations, matching the audio-only behavior.
   */
  it("defaults to audio-only scope when no options provided", () => {
    fc.assert(
      fc.property(arbitraryUnanchoredVisualSentence(), ({ term, sentence }) => {
        // No options = default = audio-only = visual terms are violations
        const result = checker.check(sentence, STUB_EVALUATION, STUB_METRICS);

        const scopeViolations = result.violations.filter(
          (v) => v.category === "visual_scope",
        );
        expect(scopeViolations.length).toBeGreaterThanOrEqual(1);

        const hasMatch = scopeViolations.some(
          (v) => v.sentence.toLowerCase().includes(term.toLowerCase()),
        );
        expect(hasMatch).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});


// ─── Property 25: Scope Acknowledgment Matches Video Availability ────────────
// Feature: phase-4-multimodal-video, Property 25: Scope acknowledgment matches video availability
//
// **Validates: Requirements 13.1, 13.2, 13.3**
//
// The ToneChecker's appendScopeAcknowledgment() method SHALL produce scope
// acknowledgment text that correctly reflects video availability:
// - When hasVideo is true: mentions audio and video content
// - When hasVideo is false or not specified: mentions audio content only
// - The acknowledgment is always appended as the final sentence

// ─── Property 25 Tests ──────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 25: Scope acknowledgment matches video availability", () => {
  /**
   * **Validates: Requirements 13.1, 13.2, 13.3**
   *
   * When hasVideo is true and the append condition is met, the scope
   * acknowledgment SHALL mention "audio and video content".
   */
  it("appends video scope acknowledgment when hasVideo is true", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const result = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: true },
          );

          expect(result.toLowerCase()).toContain("based on audio and video content");
          expect(result.toLowerCase()).not.toContain("audio content only");
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 13.1, 13.2, 13.3**
   *
   * When hasVideo is false and the append condition is met, the scope
   * acknowledgment SHALL mention "audio content only" and NOT mention video.
   */
  it("appends audio-only scope acknowledgment when hasVideo is false", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const result = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: false },
          );

          expect(result.toLowerCase()).toContain("based on audio content only");
          expect(result.toLowerCase()).not.toContain("audio and video content");
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 13.2, 13.3**
   *
   * When no options are provided (hasVideo not specified), the scope
   * acknowledgment SHALL default to audio-only behavior.
   */
  it("defaults to audio-only scope acknowledgment when no options provided", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const result = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
          );

          expect(result.toLowerCase()).toContain("based on audio content only");
          expect(result.toLowerCase()).not.toContain("audio and video content");
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 13.1, 13.2**
   *
   * The hasVideo flag determines which acknowledgment text is used.
   * For any script and append condition, the two variants produce
   * different acknowledgment text.
   */
  it("produces different acknowledgment text based on hasVideo flag", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const withVideo = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: true },
          );
          const withoutVideo = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: false },
          );

          expect(withVideo).not.toBe(withoutVideo);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 13.3**
   *
   * Idempotency: calling appendScopeAcknowledgment twice with hasVideo=true
   * produces the same result as calling it once.
   */
  it("is idempotent with hasVideo=true", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        arbitraryAppendCondition(),
        (script, { qualityWarning, hasStructureCommentary }) => {
          const firstCall = checker.appendScopeAcknowledgment(
            script,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: true },
          );
          const secondCall = checker.appendScopeAcknowledgment(
            firstCall,
            qualityWarning,
            hasStructureCommentary,
            { hasVideo: true },
          );

          expect(secondCall).toBe(firstCall);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 13.3**
   *
   * When both qualityWarning and hasStructureCommentary are false,
   * the script is returned unchanged regardless of hasVideo.
   */
  it("returns script unchanged when append condition is not met, regardless of hasVideo", () => {
    fc.assert(
      fc.property(
        arbitraryCleanScript(),
        fc.boolean(),
        (script, hasVideo) => {
          const result = checker.appendScopeAcknowledgment(
            script,
            false,
            false,
            { hasVideo },
          );

          expect(result).toBe(script);
        },
      ),
      { numRuns: 200 },
    );
  });
});
