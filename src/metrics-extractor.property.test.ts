// Property-Based Tests for MetricsExtractor
// Feature: ai-toastmasters-evaluator, Property 2: Duration Computation Correctness

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { MetricsExtractor } from "./metrics-extractor.js";
import type { TranscriptSegment } from "./types.js";

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a non-empty array of transcript segments with non-decreasing timestamps.
 * Segments are generated sequentially so that the first segment's startTime <= last segment's endTime.
 */
function arbitraryNonEmptySegments(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      // First segment start time (0 to 100 seconds)
      fc.double({ min: 0, max: 100, noNaN: true }),
      // Array of segment durations and gap durations
      fc.array(
        fc.tuple(
          // segment duration (0.1 to 30 seconds)
          fc.double({ min: 0.1, max: 30, noNaN: true }),
          // gap to next segment (0 to 5 seconds)
          fc.double({ min: 0, max: 5, noNaN: true }),
          // words in this segment
          fc.array(
            fc.string({ minLength: 1, maxLength: 8 }).map((s) =>
              s.replace(/\s+/g, "a") || "word"
            ),
            { minLength: 1, maxLength: 6 }
          )
        ),
        { minLength: 1, maxLength: 10 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [duration, gap, wordTexts] of segmentSpecs) {
        const startTime = currentTime;
        const endTime = startTime + duration;

        const words: TranscriptWord[] = wordTexts.map((w, i) => {
          const fraction =
            wordTexts.length > 1 ? i / (wordTexts.length - 1) : 0;
          const wordStart = startTime + fraction * (endTime - startTime);
          const wordDuration = duration / Math.max(wordTexts.length, 1);
          const wordEnd = Math.min(wordStart + wordDuration, endTime);
          return {
            word: w,
            startTime: wordStart,
            endTime: Math.max(wordEnd, wordStart),
            confidence: 0.95,
          };
        });

        segments.push({
          text: wordTexts.join(" "),
          startTime,
          endTime,
          words,
          isFinal: true,
        });

        currentTime = endTime + gap;
      }

      return segments;
    });
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 2: Duration Computation Correctness", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 3.1**
   *
   * Property 2: Duration Computation Correctness
   *
   * For any non-empty transcript (list of segments with timestamps),
   * the computed durationSeconds SHALL equal the difference between
   * the last segment's endTime and the first segment's startTime.
   */
  it("durationSeconds equals lastSegment.endTime - firstSegment.startTime for any non-empty transcript", () => {
    fc.assert(
      fc.property(arbitraryNonEmptySegments(), (segments) => {
        const metrics = extractor.extract(segments);

        const expectedDuration =
          segments[segments.length - 1].endTime - segments[0].startTime;

        expect(metrics.durationSeconds).toBeCloseTo(expectedDuration, 10);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 3: WPM Computation Correctness ────────────────────────────────────

// Import TranscriptWord type for the WPM generator
import type { TranscriptWord } from "./types.js";

/**
 * Generate a non-empty array of transcript segments with a known total word count
 * and known duration, suitable for verifying WPM computation.
 *
 * Strategy: generate segments with explicit word arrays where words.length matches
 * the whitespace-separated token count in the text field. Also generates segments
 * without word-level data (empty words array) to test the text-based fallback path.
 */
function arbitrarySegmentsForWPM(): fc.Arbitrary<{
  segments: TranscriptSegment[];
  expectedTotalWords: number;
  expectedDurationSeconds: number;
}> {
  return fc
    .tuple(
      // First segment start time (0 to 100 seconds)
      fc.double({ min: 0, max: 100, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // segment duration (0.1 to 30 seconds) — positive to ensure non-zero total duration
          fc.double({ min: 0.1, max: 30, noNaN: true }),
          // gap to next segment (0 to 5 seconds)
          fc.double({ min: 0, max: 5, noNaN: true }),
          // number of words in this segment (1 to 10)
          fc.integer({ min: 1, max: 10 }),
          // whether this segment has word-level data
          fc.boolean()
        ),
        { minLength: 1, maxLength: 8 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;
      let totalWords = 0;

      for (const [duration, gap, wordCount, hasWordLevel] of segmentSpecs) {
        const startTime = currentTime;
        const endTime = startTime + duration;

        // Generate simple word tokens (no whitespace in individual words)
        const wordTexts = Array.from(
          { length: wordCount },
          (_, i) => `word${i}`
        );
        totalWords += wordCount;

        let words: TranscriptWord[] = [];
        if (hasWordLevel) {
          words = wordTexts.map((w, i) => {
            const fraction = wordCount > 1 ? i / (wordCount - 1) : 0;
            const wordStart = startTime + fraction * (endTime - startTime);
            const wordDuration = duration / Math.max(wordCount, 1);
            const wordEnd = Math.min(wordStart + wordDuration, endTime);
            return {
              word: w,
              startTime: wordStart,
              endTime: Math.max(wordEnd, wordStart),
              confidence: 0.95,
            };
          });
        }

        segments.push({
          text: wordTexts.join(" "),
          startTime,
          endTime,
          words,
          isFinal: true,
        });

        currentTime = endTime + gap;
      }

      const expectedDurationSeconds =
        segments[segments.length - 1].endTime - segments[0].startTime;

      return { segments, expectedTotalWords: totalWords, expectedDurationSeconds };
    });
}

describe("Feature: ai-toastmasters-evaluator, Property 3: WPM Computation Correctness", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 3.2**
   *
   * Property 3: WPM Computation Correctness
   *
   * For any non-empty transcript, the computed wordsPerMinute SHALL equal
   * totalWords / (durationSeconds / 60), where totalWords is the count of
   * all words across all segments.
   */
  it("wordsPerMinute equals totalWords / (durationSeconds / 60) for any non-empty transcript", () => {
    fc.assert(
      fc.property(arbitrarySegmentsForWPM(), ({ segments, expectedTotalWords, expectedDurationSeconds }) => {
        const metrics = extractor.extract(segments);

        // Verify totalWords matches expected count
        expect(metrics.totalWords).toBe(expectedTotalWords);

        // Verify WPM formula: totalWords / (durationSeconds / 60)
        const durationMinutes = expectedDurationSeconds / 60;
        const expectedWPM =
          durationMinutes > 0 ? expectedTotalWords / durationMinutes : 0;

        expect(metrics.wordsPerMinute).toBeCloseTo(expectedWPM, 10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * Edge case: WPM is 0 when duration is 0 (empty transcript).
   */
  it("wordsPerMinute is 0 for an empty transcript", () => {
    const metrics = extractor.extract([]);
    expect(metrics.wordsPerMinute).toBe(0);
    expect(metrics.totalWords).toBe(0);
  });
});


// ─── Property 4: Filler Word Metrics Internal Consistency ───────────────────────

/**
 * Known filler words used by the MetricsExtractor.
 * Non-contextual fillers are always counted; contextual fillers depend on position.
 * For the generator we use a mix of both to exercise both code paths.
 */
const NON_CONTEXTUAL_FILLERS = ["um", "uh", "ah", "basically", "literally"];
const CONTEXTUAL_FILLERS_LIST = ["like", "so", "right", "actually"];
const ALL_SINGLE_FILLERS = [...NON_CONTEXTUAL_FILLERS, ...CONTEXTUAL_FILLERS_LIST];
const NORMAL_WORDS = ["the", "speech", "was", "great", "today", "we", "talked", "about", "ideas", "people", "think", "important", "really", "going", "forward", "together", "community", "project", "meeting", "everyone"];

/**
 * Generate a non-empty array of transcript segments that contain a mix of
 * normal words and known filler words. Each segment has word-level timestamps
 * so the MetricsExtractor can apply contextual heuristics.
 */
function arbitrarySegmentsWithFillers(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      // First segment start time (0 to 60 seconds)
      fc.double({ min: 0, max: 60, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // segment duration (0.5 to 10 seconds)
          fc.double({ min: 0.5, max: 10, noNaN: true }),
          // gap to next segment (0 to 3 seconds)
          fc.double({ min: 0, max: 3, noNaN: true }),
          // words in this segment: mix of normal words and fillers
          fc.array(
            fc.oneof(
              { weight: 3, arbitrary: fc.constantFrom(...NORMAL_WORDS) },
              { weight: 1, arbitrary: fc.constantFrom(...NON_CONTEXTUAL_FILLERS) },
              { weight: 1, arbitrary: fc.constantFrom(...CONTEXTUAL_FILLERS_LIST) }
            ),
            { minLength: 1, maxLength: 12 }
          )
        ),
        { minLength: 1, maxLength: 8 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [duration, gap, wordTexts] of segmentSpecs) {
        const startTime = currentTime;
        const endTime = startTime + duration;

        const words: TranscriptWord[] = wordTexts.map((w, i) => {
          const wordDuration = duration / wordTexts.length;
          const wordStart = startTime + i * wordDuration;
          const wordEnd = wordStart + wordDuration;
          return {
            word: w,
            startTime: wordStart,
            endTime: Math.min(wordEnd, endTime),
            confidence: 0.95,
          };
        });

        segments.push({
          text: wordTexts.join(" "),
          startTime,
          endTime,
          words,
          isFinal: true,
        });

        currentTime = endTime + gap;
      }

      return segments;
    });
}

describe("Feature: ai-toastmasters-evaluator, Property 4: Filler Word Metrics Internal Consistency", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 3.3**
   *
   * Property 4: Filler Word Metrics Internal Consistency
   *
   * For any transcript processed by the Metrics Extractor, the fillerWordCount
   * SHALL equal the sum of all individual FillerWordEntry.count values, and
   * fillerWordFrequency SHALL equal fillerWordCount / (durationSeconds / 60).
   */
  it("fillerWordCount equals sum of FillerWordEntry.count values and fillerWordFrequency equals fillerWordCount / (durationSeconds / 60)", () => {
    fc.assert(
      fc.property(arbitrarySegmentsWithFillers(), (segments) => {
        const metrics = extractor.extract(segments);

        // Property 4a: fillerWordCount === sum of all FillerWordEntry.count values
        const sumOfCounts = metrics.fillerWords.reduce(
          (sum, entry) => sum + entry.count,
          0
        );
        expect(metrics.fillerWordCount).toBe(sumOfCounts);

        // Property 4b: fillerWordFrequency === fillerWordCount / (durationSeconds / 60)
        const durationMinutes = metrics.durationSeconds / 60;
        const expectedFrequency =
          durationMinutes > 0 ? metrics.fillerWordCount / durationMinutes : 0;
        expect(metrics.fillerWordFrequency).toBeCloseTo(expectedFrequency, 10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * Each FillerWordEntry.count SHALL equal the length of its timestamps array.
   */
  it("each FillerWordEntry.count equals the length of its timestamps array", () => {
    fc.assert(
      fc.property(arbitrarySegmentsWithFillers(), (segments) => {
        const metrics = extractor.extract(segments);

        for (const entry of metrics.fillerWords) {
          expect(entry.count).toBe(entry.timestamps.length);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * Edge case: fillerWordCount and fillerWordFrequency are 0 for an empty transcript.
   */
  it("fillerWordCount and fillerWordFrequency are 0 for an empty transcript", () => {
    const metrics = extractor.extract([]);
    expect(metrics.fillerWordCount).toBe(0);
    expect(metrics.fillerWordFrequency).toBe(0);
    expect(metrics.fillerWords).toEqual([]);
  });
});



// ─── Property 5: Pause Detection Correctness ────────────────────────────────────

/**
 * Represents a gap that is intentionally placed between words or segments.
 * We track whether it should be detected as a pause (gap >= threshold).
 */
interface PlannedGap {
  start: number;
  end: number;
  duration: number;
  shouldBePause: boolean;
}

const DEFAULT_PAUSE_THRESHOLD = 1.5;

/**
 * Generate transcript segments with known intra-segment word gaps and inter-segment gaps.
 * Returns both the segments and the list of planned gaps so we can verify detection.
 *
 * Strategy:
 * - Generate multiple segments, each with multiple words
 * - Between consecutive words WITHIN a segment, insert a known gap (above or below threshold)
 * - Between consecutive segments, insert a known gap (above or below threshold)
 * - Track all gaps and whether they should be detected as pauses
 *
 * The implementation detects:
 * 1. Word-level gaps within segments (word[i].endTime to word[i+1].startTime)
 * 2. Inter-segment gaps (segment[i].endTime to segment[i+1].startTime)
 */
function arbitrarySegmentsWithKnownPauses(): fc.Arbitrary<{
  segments: TranscriptSegment[];
  plannedGaps: PlannedGap[];
}> {
  return fc
    .tuple(
      // First segment start time (0 to 50 seconds)
      fc.double({ min: 0, max: 50, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // Number of words in this segment (1 to 5)
          fc.integer({ min: 1, max: 5 }),
          // Duration per word (0.2 to 1.0 seconds)
          fc.double({ min: 0.2, max: 1.0, noNaN: true }),
          // Intra-segment gaps between consecutive words: array of gap durations
          // Each gap is either below threshold (0 to 1.49) or above threshold (1.5 to 5.0)
          fc.array(
            fc.oneof(
              // Gap below threshold (not a pause)
              fc.double({ min: 0, max: 1.49, noNaN: true }),
              // Gap above threshold (is a pause)
              fc.double({ min: 1.5, max: 5.0, noNaN: true })
            ),
            { minLength: 0, maxLength: 4 }
          ),
          // Inter-segment gap after this segment: either below or above threshold
          fc.oneof(
            fc.double({ min: 0, max: 1.49, noNaN: true }),
            fc.double({ min: 1.5, max: 5.0, noNaN: true })
          )
        ),
        { minLength: 1, maxLength: 6 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      const plannedGaps: PlannedGap[] = [];
      let currentTime = firstStart;

      for (let segIdx = 0; segIdx < segmentSpecs.length; segIdx++) {
        const [wordCount, wordDuration, intraGaps, interSegmentGap] =
          segmentSpecs[segIdx];

        const segStartTime = currentTime;
        const words: TranscriptWord[] = [];

        // Build words with known intra-segment gaps
        for (let w = 0; w < wordCount; w++) {
          const wordStart = currentTime;
          const wordEnd = currentTime + wordDuration;

          words.push({
            word: `word${w}`,
            startTime: wordStart,
            endTime: wordEnd,
            confidence: 0.95,
          });

          currentTime = wordEnd;

          // Add intra-segment gap between consecutive words (not after the last word)
          if (w < wordCount - 1 && w < intraGaps.length) {
            const gap = intraGaps[w];
            const gapStart = currentTime;
            const gapEnd = currentTime + gap;
            // Compute the effective gap the same way the implementation does:
            // word[i+1].startTime - word[i].endTime, which equals gapEnd - wordEnd.
            // Due to floating-point arithmetic, this may differ slightly from the raw gap.
            const effectiveGap = gapEnd - wordEnd;

            plannedGaps.push({
              start: gapStart,
              end: gapEnd,
              duration: effectiveGap,
              shouldBePause: effectiveGap >= DEFAULT_PAUSE_THRESHOLD,
            });

            currentTime = gapEnd;
          }
        }

        const segEndTime = currentTime;

        segments.push({
          text: words.map((w) => w.word).join(" "),
          startTime: segStartTime,
          endTime: segEndTime,
          words,
          isFinal: true,
        });

        // Add inter-segment gap (not after the last segment)
        if (segIdx < segmentSpecs.length - 1) {
          const gapStart = segEndTime;
          const gapEnd = segEndTime + interSegmentGap;
          // Compute the effective gap the same way the implementation does:
          // segments[i+1].startTime - segments[i].endTime, which equals gapEnd - segEndTime.
          // Due to floating-point arithmetic, this may differ slightly from the raw interSegmentGap.
          const effectiveGap = gapEnd - segEndTime;

          plannedGaps.push({
            start: gapStart,
            end: gapEnd,
            duration: effectiveGap,
            shouldBePause: effectiveGap >= DEFAULT_PAUSE_THRESHOLD,
          });

          currentTime = gapEnd;
        }
      }

      return { segments, plannedGaps };
    });
}

/**
 * Generate transcript segments WITHOUT word-level timestamps (segment-level fallback).
 * Only inter-segment gaps are detectable in this mode.
 */
function arbitrarySegmentLevelOnlyWithKnownPauses(): fc.Arbitrary<{
  segments: TranscriptSegment[];
  plannedGaps: PlannedGap[];
}> {
  return fc
    .tuple(
      // First segment start time
      fc.double({ min: 0, max: 50, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // Segment duration (0.5 to 10 seconds)
          fc.double({ min: 0.5, max: 10, noNaN: true }),
          // Number of words in text (for text content)
          fc.integer({ min: 1, max: 8 }),
          // Inter-segment gap
          fc.oneof(
            fc.double({ min: 0, max: 1.49, noNaN: true }),
            fc.double({ min: 1.5, max: 5.0, noNaN: true })
          )
        ),
        { minLength: 1, maxLength: 6 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      const plannedGaps: PlannedGap[] = [];
      let currentTime = firstStart;

      for (let i = 0; i < segmentSpecs.length; i++) {
        const [duration, wordCount, interGap] = segmentSpecs[i];
        const startTime = currentTime;
        const endTime = startTime + duration;

        const wordTexts = Array.from(
          { length: wordCount },
          (_, j) => `word${j}`
        );

        segments.push({
          text: wordTexts.join(" "),
          startTime,
          endTime,
          words: [], // No word-level timestamps — segment-level fallback
          isFinal: true,
        });

        currentTime = endTime;

        // Inter-segment gap (not after last segment)
        if (i < segmentSpecs.length - 1) {
          const gapStart = currentTime;
          const gapEnd = currentTime + interGap;
          // Compute the effective gap the same way the implementation does:
          // segments[i+1].startTime - segments[i].endTime, which equals gapEnd - endTime.
          // Due to floating-point arithmetic, this may differ slightly from the raw interGap.
          const effectiveGap = gapEnd - endTime;
          plannedGaps.push({
            start: gapStart,
            end: gapEnd,
            duration: effectiveGap,
            shouldBePause: effectiveGap >= DEFAULT_PAUSE_THRESHOLD,
          });
          currentTime = gapEnd;
        }
      }

      return { segments, plannedGaps };
    });
}

describe("Feature: ai-toastmasters-evaluator, Property 5: Pause Detection Correctness", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 3.4**
   *
   * Property 5: Pause Detection Correctness
   *
   * For any transcript with known inter-segment or inter-word time gaps,
   * the Metrics Extractor SHALL identify exactly those gaps exceeding the
   * configured pause threshold as pauses, and totalPauseDurationSeconds
   * SHALL equal the sum of all detected pause durations.
   */
  it("detects exactly those gaps >= threshold as pauses (word-level + inter-segment)", () => {
    fc.assert(
      fc.property(
        arbitrarySegmentsWithKnownPauses(),
        ({ segments, plannedGaps }) => {
          const metrics = extractor.extract(segments);

          // Count expected pauses from our planned gaps
          const expectedPauses = plannedGaps.filter((g) => g.shouldBePause);
          const expectedPauseCount = expectedPauses.length;
          const expectedTotalDuration = expectedPauses.reduce(
            (sum, g) => sum + g.duration,
            0
          );

          // Verify pause count matches
          expect(metrics.pauseCount).toBe(expectedPauseCount);

          // Verify totalPauseDurationSeconds equals sum of detected pause durations
          expect(metrics.totalPauseDurationSeconds).toBeCloseTo(
            expectedTotalDuration,
            10
          );

          // Verify averagePauseDurationSeconds
          const expectedAverage =
            expectedPauseCount > 0
              ? expectedTotalDuration / expectedPauseCount
              : 0;
          expect(metrics.averagePauseDurationSeconds).toBeCloseTo(
            expectedAverage,
            10
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * Segment-level fallback: when word-level timestamps are unavailable,
   * pause detection uses inter-segment gaps only.
   */
  it("detects inter-segment pauses correctly in segment-level fallback mode (no word timestamps)", () => {
    fc.assert(
      fc.property(
        arbitrarySegmentLevelOnlyWithKnownPauses(),
        ({ segments, plannedGaps }) => {
          const metrics = extractor.extract(segments);

          const expectedPauses = plannedGaps.filter((g) => g.shouldBePause);
          const expectedPauseCount = expectedPauses.length;
          const expectedTotalDuration = expectedPauses.reduce(
            (sum, g) => sum + g.duration,
            0
          );

          expect(metrics.pauseCount).toBe(expectedPauseCount);
          expect(metrics.totalPauseDurationSeconds).toBeCloseTo(
            expectedTotalDuration,
            10
          );

          const expectedAverage =
            expectedPauseCount > 0
              ? expectedTotalDuration / expectedPauseCount
              : 0;
          expect(metrics.averagePauseDurationSeconds).toBeCloseTo(
            expectedAverage,
            10
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * Edge case: no pauses when all gaps are below threshold.
   */
  it("reports zero pauses when no gaps exceed the threshold", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.double({ min: 0, max: 50, noNaN: true }),
            fc.array(
              fc.tuple(
                fc.integer({ min: 2, max: 5 }),
                fc.double({ min: 0.3, max: 0.8, noNaN: true }),
                // All intra-word gaps below threshold
                fc.array(
                  fc.double({ min: 0, max: 1.0, noNaN: true }),
                  { minLength: 1, maxLength: 4 }
                ),
                // All inter-segment gaps below threshold
                fc.double({ min: 0, max: 1.0, noNaN: true })
              ),
              { minLength: 1, maxLength: 5 }
            )
          )
          .map(([firstStart, segSpecs]) => {
            const segments: TranscriptSegment[] = [];
            let currentTime = firstStart;

            for (let s = 0; s < segSpecs.length; s++) {
              const [wordCount, wordDur, intraGaps, interGap] = segSpecs[s];
              const segStart = currentTime;
              const words: TranscriptWord[] = [];

              for (let w = 0; w < wordCount; w++) {
                words.push({
                  word: `w${w}`,
                  startTime: currentTime,
                  endTime: currentTime + wordDur,
                  confidence: 0.9,
                });
                currentTime += wordDur;
                if (w < wordCount - 1 && w < intraGaps.length) {
                  currentTime += intraGaps[w];
                }
              }

              segments.push({
                text: words.map((w) => w.word).join(" "),
                startTime: segStart,
                endTime: currentTime,
                words,
                isFinal: true,
              });

              if (s < segSpecs.length - 1) {
                currentTime += interGap;
              }
            }
            return segments;
          }),
        (segments) => {
          const metrics = extractor.extract(segments);
          expect(metrics.pauseCount).toBe(0);
          expect(metrics.totalPauseDurationSeconds).toBe(0);
          expect(metrics.averagePauseDurationSeconds).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * Edge case: empty transcript has no pauses.
   */
  it("reports zero pauses for an empty transcript", () => {
    const metrics = extractor.extract([]);
    expect(metrics.pauseCount).toBe(0);
    expect(metrics.totalPauseDurationSeconds).toBe(0);
    expect(metrics.averagePauseDurationSeconds).toBe(0);
  });
});


// ─── Property 9: Pause Classification Correctness ───────────────────────────────
// Feature: phase-2-stability-credibility, Property 9: Pause Classification Correctness

/**
 * Pause classification scenario types used by the generator.
 * Each scenario constructs a transcript with a specific pause context
 * so we can verify the classification heuristic.
 */
type PauseScenario =
  | "sentence_ending_intentional"   // pause after ".!?" + capitalized next word → intentional
  | "filler_preceded_hesitation"    // pause after a filler word → hesitation
  | "repeated_word_hesitation"      // following word repeats preceding word → hesitation
  | "mid_sentence_hesitation"       // no terminal punctuation, no filler, no repeat → hesitation
  | "hesitation_wins_precedence";   // sentence-ending punct BUT also filler preceded → hesitation

const PAUSE_SCENARIOS: PauseScenario[] = [
  "sentence_ending_intentional",
  "filler_preceded_hesitation",
  "repeated_word_hesitation",
  "mid_sentence_hesitation",
  "hesitation_wins_precedence",
];

const FILLER_WORDS_SET = new Set([
  "um", "uh", "ah", "like", "so", "right", "actually", "basically", "literally", "honestly",
]);

/**
 * Generate a transcript with a single reportable pause (≥1.5s) whose classification
 * context is controlled by the chosen scenario. Returns the segments and the expected
 * classification type.
 *
 * Strategy:
 * - Build two segments separated by a gap ≥ 1.5s
 * - The last word of segment 1 and first word of segment 2 are chosen to match the scenario
 * - Word-level timestamps are provided for accurate pause detection
 */
function arbitraryClassificationScenario(): fc.Arbitrary<{
  segments: TranscriptSegment[];
  expectedType: "intentional" | "hesitation";
  scenario: PauseScenario;
}> {
  return fc
    .tuple(
      // Scenario selection
      fc.constantFrom(...PAUSE_SCENARIOS),
      // Pause duration (reportable: 1.5s to 4.0s)
      fc.double({ min: 1.55, max: 4.0, noNaN: true }),
      // Start time offset
      fc.double({ min: 0, max: 20, noNaN: true }),
      // Number of prefix words in segment 1 (before the critical last word)
      fc.integer({ min: 1, max: 4 }),
      // Number of suffix words in segment 2 (after the critical first word)
      fc.integer({ min: 1, max: 4 }),
      // A filler word to use when needed
      fc.constantFrom("um", "uh", "ah"),
      // A normal word for repetition scenarios
      fc.constantFrom("idea", "point", "speech", "topic", "plan")
    )
    .map(([scenario, pauseDuration, startOffset, prefixCount, suffixCount, fillerWord, repeatWord]) => {
      const wordDuration = 0.3;
      const wordGap = 0.05; // small gap between words (well below candidate threshold)
      let currentTime = startOffset;

      // Build prefix words for segment 1
      const seg1Words: TranscriptWord[] = [];
      const normalWords = ["the", "great", "today", "we", "talked", "about", "ideas", "people"];

      for (let i = 0; i < prefixCount; i++) {
        const w = normalWords[i % normalWords.length];
        seg1Words.push({
          word: w,
          startTime: currentTime,
          endTime: currentTime + wordDuration,
          confidence: 0.95,
        });
        currentTime += wordDuration + wordGap;
      }

      // Add the critical last word of segment 1 based on scenario
      let lastWordText: string;
      let expectedType: "intentional" | "hesitation";

      switch (scenario) {
        case "sentence_ending_intentional":
          // Ends with sentence-ending punctuation, next word capitalized
          // Use "done." to avoid accidental repeated-word match with the following word
          lastWordText = "done.";
          expectedType = "intentional";
          break;
        case "filler_preceded_hesitation":
          // Last word is a filler word (no sentence-ending punctuation)
          lastWordText = fillerWord;
          expectedType = "hesitation";
          break;
        case "repeated_word_hesitation":
          // Last word will be repeated by the first word of segment 2
          lastWordText = repeatWord;
          expectedType = "hesitation";
          break;
        case "mid_sentence_hesitation":
          // No terminal punctuation, no filler, no repeat → mid-sentence hesitation
          lastWordText = "about";
          expectedType = "hesitation";
          break;
        case "hesitation_wins_precedence":
          // Sentence-ending punctuation BUT preceded by filler → hesitation wins
          lastWordText = fillerWord + ".";
          expectedType = "hesitation";
          break;
      }

      seg1Words.push({
        word: lastWordText,
        startTime: currentTime,
        endTime: currentTime + wordDuration,
        confidence: 0.95,
      });
      currentTime += wordDuration;

      const seg1Start = startOffset;
      const seg1End = currentTime;

      // The pause gap
      const pauseStart = currentTime;
      currentTime += pauseDuration;
      const pauseEnd = currentTime;

      // Build segment 2 words
      const seg2Words: TranscriptWord[] = [];

      // First word of segment 2 based on scenario
      let firstWordText: string;
      switch (scenario) {
        case "sentence_ending_intentional":
          // Capitalized word to indicate new sentence; must differ from preceding "done."
          firstWordText = "Meanwhile";
          break;
        case "repeated_word_hesitation":
          // Same word as the last word of segment 1
          firstWordText = repeatWord;
          break;
        case "hesitation_wins_precedence":
          // Capitalized (would suggest intentional, but filler takes precedence)
          firstWordText = "Next";
          break;
        default:
          firstWordText = "something";
          break;
      }

      seg2Words.push({
        word: firstWordText,
        startTime: currentTime,
        endTime: currentTime + wordDuration,
        confidence: 0.95,
      });
      currentTime += wordDuration + wordGap;

      // Add suffix words
      for (let i = 0; i < suffixCount; i++) {
        const w = normalWords[(i + 3) % normalWords.length];
        seg2Words.push({
          word: w,
          startTime: currentTime,
          endTime: currentTime + wordDuration,
          confidence: 0.95,
        });
        currentTime += wordDuration + wordGap;
      }

      const seg2Start = pauseEnd;
      const seg2End = currentTime;

      const segments: TranscriptSegment[] = [
        {
          text: seg1Words.map((w) => w.word).join(" "),
          startTime: seg1Start,
          endTime: seg1End,
          words: seg1Words,
          isFinal: true,
        },
        {
          text: seg2Words.map((w) => w.word).join(" "),
          startTime: seg2Start,
          endTime: seg2End,
          words: seg2Words,
          isFinal: true,
        },
      ];

      return { segments, expectedType, scenario };
    });
}

/**
 * Generate a transcript with multiple reportable pauses of mixed classification types.
 * Returns the segments and the expected count of intentional vs hesitation pauses.
 */
function arbitraryMultiPauseTranscript(): fc.Arbitrary<{
  segments: TranscriptSegment[];
  expectedIntentionalCount: number;
  expectedHesitationCount: number;
  expectedTotalPauseCount: number;
}> {
  return fc
    .tuple(
      fc.double({ min: 0, max: 10, noNaN: true }),
      // Generate 2-5 pause scenarios
      fc.array(
        fc.tuple(
          fc.constantFrom(...PAUSE_SCENARIOS),
          fc.double({ min: 1.55, max: 3.5, noNaN: true }),
          fc.constantFrom("um", "uh", "ah"),
          fc.constantFrom("idea", "point", "speech", "topic")
        ),
        { minLength: 2, maxLength: 5 }
      )
    )
    .map(([startOffset, pauseSpecs]) => {
      const wordDuration = 0.3;
      const wordGap = 0.05;
      let currentTime = startOffset;
      const segments: TranscriptSegment[] = [];
      let expectedIntentionalCount = 0;
      let expectedHesitationCount = 0;
      const normalWords = ["the", "great", "today", "we", "talked", "about", "ideas", "people"];

      for (let pIdx = 0; pIdx < pauseSpecs.length; pIdx++) {
        const [scenario, pauseDuration, fillerWord, repeatWord] = pauseSpecs[pIdx];

        // Build a segment before the pause
        const segWords: TranscriptWord[] = [];
        const segStart = currentTime;

        // Add 2 normal prefix words
        for (let i = 0; i < 2; i++) {
          const w = normalWords[(pIdx * 2 + i) % normalWords.length];
          segWords.push({
            word: w,
            startTime: currentTime,
            endTime: currentTime + wordDuration,
            confidence: 0.95,
          });
          currentTime += wordDuration + wordGap;
        }

        // Add the critical last word
        let lastWord: string;
        let isIntentional: boolean;

        switch (scenario) {
          case "sentence_ending_intentional":
            lastWord = "done.";
            isIntentional = true;
            break;
          case "filler_preceded_hesitation":
            lastWord = fillerWord;
            isIntentional = false;
            break;
          case "repeated_word_hesitation":
            lastWord = repeatWord;
            isIntentional = false;
            break;
          case "mid_sentence_hesitation":
            lastWord = "about";
            isIntentional = false;
            break;
          case "hesitation_wins_precedence":
            lastWord = fillerWord + ".";
            isIntentional = false;
            break;
        }

        segWords.push({
          word: lastWord,
          startTime: currentTime,
          endTime: currentTime + wordDuration,
          confidence: 0.95,
        });
        currentTime += wordDuration;

        segments.push({
          text: segWords.map((w) => w.word).join(" "),
          startTime: segStart,
          endTime: currentTime,
          words: segWords,
          isFinal: true,
        });

        // Add the pause gap
        currentTime += pauseDuration;

        // Build the segment after the pause (first word depends on scenario)
        const afterWords: TranscriptWord[] = [];
        const afterStart = currentTime;

        let firstWord: string;
        switch (scenario) {
          case "sentence_ending_intentional":
            firstWord = "Meanwhile";
            break;
          case "repeated_word_hesitation":
            firstWord = repeatWord;
            break;
          case "hesitation_wins_precedence":
            firstWord = "Next";
            break;
          default:
            firstWord = "something";
            break;
        }

        afterWords.push({
          word: firstWord,
          startTime: currentTime,
          endTime: currentTime + wordDuration,
          confidence: 0.95,
        });
        currentTime += wordDuration + wordGap;

        // Add a trailing normal word
        afterWords.push({
          word: normalWords[(pIdx + 5) % normalWords.length],
          startTime: currentTime,
          endTime: currentTime + wordDuration,
          confidence: 0.95,
        });
        currentTime += wordDuration + wordGap;

        segments.push({
          text: afterWords.map((w) => w.word).join(" "),
          startTime: afterStart,
          endTime: currentTime,
          words: afterWords,
          isFinal: true,
        });

        if (isIntentional) {
          expectedIntentionalCount++;
        } else {
          expectedHesitationCount++;
        }
      }

      return {
        segments,
        expectedIntentionalCount,
        expectedHesitationCount,
        expectedTotalPauseCount: pauseSpecs.length,
      };
    });
}

describe("Feature: phase-2-stability-credibility, Property 9: Pause Classification Correctness", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 5.1, 5.2, 5.3**
   *
   * Property 9a: Every classified pause must be either "intentional" or "hesitation".
   * For any transcript with reportable pauses (≥1.5s), every classified pause has a valid type.
   */
  it("every classified pause has type 'intentional' or 'hesitation'", () => {
    fc.assert(
      fc.property(arbitraryClassificationScenario(), ({ segments }) => {
        const metrics = extractor.extract(segments);

        for (const pause of metrics.classifiedPauses) {
          expect(["intentional", "hesitation"]).toContain(pause.type);
          expect(pause.reason).toBeTruthy();
          expect(pause.duration).toBeGreaterThanOrEqual(1.5);
          expect(pause.start).toBeLessThan(pause.end);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.1, 5.2, 5.3**
   *
   * Property 9b: Pauses after sentence-ending punctuation with a capitalized following
   * word should be classified as intentional (unless hesitation indicators also present).
   * Pauses preceded by filler words should be classified as hesitation.
   * Pauses where the following word repeats the preceding word should be hesitation.
   * When both intentional and hesitation indicators are present, hesitation wins.
   */
  it("classifies pauses correctly based on surrounding context", () => {
    fc.assert(
      fc.property(
        arbitraryClassificationScenario(),
        ({ segments, expectedType, scenario }) => {
          const metrics = extractor.extract(segments);

          // We constructed exactly one reportable pause
          expect(metrics.classifiedPauses.length).toBe(1);

          const pause = metrics.classifiedPauses[0];
          expect(pause.type).toBe(expectedType);

          // Verify specific reason patterns based on scenario
          switch (scenario) {
            case "sentence_ending_intentional":
              expect(pause.reason).toMatch(/sentence|punctuation/i);
              break;
            case "filler_preceded_hesitation":
              expect(pause.reason).toMatch(/filler/i);
              break;
            case "repeated_word_hesitation":
              expect(pause.reason).toMatch(/repeated/i);
              break;
            case "mid_sentence_hesitation":
              expect(pause.reason).toMatch(/mid-sentence|no terminal/i);
              break;
            case "hesitation_wins_precedence":
              // Hesitation wins even though there's sentence-ending punctuation
              expect(pause.type).toBe("hesitation");
              break;
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.1, 5.2, 5.3**
   *
   * Property 9c: The sum of intentionalPauseCount + hesitationPauseCount must equal pauseCount.
   * Tested across transcripts with multiple pauses of mixed types.
   */
  it("intentionalPauseCount + hesitationPauseCount equals pauseCount", () => {
    fc.assert(
      fc.property(
        arbitraryMultiPauseTranscript(),
        ({ segments }) => {
          const metrics = extractor.extract(segments);

          // Core invariant: counts must add up
          expect(metrics.intentionalPauseCount + metrics.hesitationPauseCount).toBe(
            metrics.pauseCount
          );

          // Also verify against classifiedPauses array
          expect(metrics.classifiedPauses.length).toBe(metrics.pauseCount);

          const intentionalFromArray = metrics.classifiedPauses.filter(
            (p) => p.type === "intentional"
          ).length;
          const hesitationFromArray = metrics.classifiedPauses.filter(
            (p) => p.type === "hesitation"
          ).length;

          expect(intentionalFromArray).toBe(metrics.intentionalPauseCount);
          expect(hesitationFromArray).toBe(metrics.hesitationPauseCount);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.1, 5.2, 5.3**
   *
   * Property 9d: Multi-pause transcripts produce correct classification counts
   * matching the expected intentional and hesitation counts from the generator.
   */
  it("multi-pause transcripts produce expected classification counts", () => {
    fc.assert(
      fc.property(
        arbitraryMultiPauseTranscript(),
        ({ segments, expectedIntentionalCount, expectedHesitationCount, expectedTotalPauseCount }) => {
          const metrics = extractor.extract(segments);

          // Total pause count should match expected
          expect(metrics.pauseCount).toBe(expectedTotalPauseCount);

          // Classification counts should match expected
          expect(metrics.intentionalPauseCount).toBe(expectedIntentionalCount);
          expect(metrics.hesitationPauseCount).toBe(expectedHesitationCount);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.1**
   *
   * Property 9e: Only gaps ≥ 1.5s (reportable threshold) are reported as pauses.
   * Gaps between 300ms and 1.5s are candidates but not reported.
   */
  it("only gaps >= reportable threshold are classified and reported", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({ min: 0, max: 10, noNaN: true }),
          // Gap that is a candidate but NOT reportable (300ms to 1.49s)
          fc.double({ min: 0.3, max: 1.49, noNaN: true }),
          // Gap that IS reportable (≥1.5s) — use 1.51 min to avoid floating-point
          // boundary issues where accumulated arithmetic makes the computed gap
          // slightly less than the exact reportableGap value
          fc.double({ min: 1.51, max: 4.0, noNaN: true })
        ),
        ([startOffset, subThresholdGap, reportableGap]) => {
          const wordDuration = 0.3;
          let currentTime = startOffset;

          // Segment 1: ends with a word, then sub-threshold gap
          const seg1Words: TranscriptWord[] = [
            { word: "hello", startTime: currentTime, endTime: currentTime + wordDuration, confidence: 0.95 },
          ];
          currentTime += wordDuration;
          const seg1End = currentTime;

          // Sub-threshold gap (candidate but not reportable)
          currentTime += subThresholdGap;

          // Segment 2: normal word, then reportable gap
          const seg2Start = currentTime;
          const seg2Words: TranscriptWord[] = [
            { word: "world.", startTime: currentTime, endTime: currentTime + wordDuration, confidence: 0.95 },
          ];
          currentTime += wordDuration;
          const seg2End = currentTime;

          // Reportable gap
          currentTime += reportableGap;

          // Segment 3: starts new sentence
          const seg3Start = currentTime;
          const seg3Words: TranscriptWord[] = [
            { word: "Today", startTime: currentTime, endTime: currentTime + wordDuration, confidence: 0.95 },
          ];
          currentTime += wordDuration;
          const seg3End = currentTime;

          const segments: TranscriptSegment[] = [
            { text: "hello", startTime: startOffset, endTime: seg1End, words: seg1Words, isFinal: true },
            { text: "world.", startTime: seg2Start, endTime: seg2End, words: seg2Words, isFinal: true },
            { text: "Today", startTime: seg3Start, endTime: seg3End, words: seg3Words, isFinal: true },
          ];

          const metrics = extractor.extract(segments);

          // Only the reportable gap should be counted
          expect(metrics.pauseCount).toBe(1);
          expect(metrics.classifiedPauses.length).toBe(1);
          expect(metrics.classifiedPauses[0].duration).toBeGreaterThanOrEqual(1.5);
        }
      ),
      { numRuns: 200 }
    );
  });
});


// ─── Property 10: Energy Profile Computation Correctness ────────────────────────
// Feature: phase-2-stability-credibility, Property 10: Energy Profile Computation Correctness

/**
 * Generate a non-empty array of PCM audio buffers (16-bit signed LE, mono, 16kHz).
 *
 * Strategy:
 * - Generate 1-4 audio chunks with varying sample counts
 * - Each sample is a random Int16 value (-32768 to 32767)
 * - Total samples are guaranteed to be >= 1 so the energy profile is non-empty
 * - Varying amplitudes exercise normalization, silence thresholding, and CV computation
 */
function arbitraryPCMAudioChunks(): fc.Arbitrary<{
  chunks: Buffer[];
  totalSamples: number;
}> {
  return fc
    .array(
      // Each chunk: array of Int16 sample values
      fc.array(
        fc.integer({ min: -32768, max: 32767 }),
        { minLength: 1, maxLength: 8000 } // up to 2 windows worth per chunk
      ),
      { minLength: 1, maxLength: 4 }
    )
    .map((chunkSamples) => {
      const chunks: Buffer[] = chunkSamples.map((samples) => {
        const buf = Buffer.alloc(samples.length * 2);
        for (let i = 0; i < samples.length; i++) {
          buf.writeInt16LE(samples[i], i * 2);
        }
        return buf;
      });
      const totalSamples = chunkSamples.reduce((sum, s) => sum + s.length, 0);
      return { chunks, totalSamples };
    });
}

/**
 * Generate PCM audio buffers where all samples are zero (all-silence).
 */
function arbitraryAllSilenceAudioChunks(): fc.Arbitrary<{
  chunks: Buffer[];
  totalSamples: number;
}> {
  return fc
    .integer({ min: 1, max: 16000 }) // 1 to 16000 samples (up to 4 windows)
    .map((sampleCount) => {
      const buf = Buffer.alloc(sampleCount * 2); // alloc fills with zeros
      return { chunks: [buf], totalSamples: sampleCount };
    });
}

/**
 * Generate PCM audio buffers with a single constant non-zero amplitude
 * (all windows have identical RMS → CV should be 0 for non-silence windows).
 */
function arbitraryConstantAmplitudeAudioChunks(): fc.Arbitrary<{
  chunks: Buffer[];
  totalSamples: number;
  amplitude: number;
}> {
  return fc
    .tuple(
      // Number of samples: at least 2 full windows (8000 samples) to have meaningful CV
      fc.integer({ min: 8000, max: 20000 }),
      // Constant amplitude (non-zero)
      fc.integer({ min: 100, max: 32000 })
    )
    .map(([sampleCount, amplitude]) => {
      const buf = Buffer.alloc(sampleCount * 2);
      for (let i = 0; i < sampleCount; i++) {
        buf.writeInt16LE(amplitude, i * 2);
      }
      return { chunks: [buf], totalSamples: sampleCount, amplitude };
    });
}

describe("Feature: phase-2-stability-credibility, Property 10: Energy Profile Computation Correctness", () => {
  const extractor = new MetricsExtractor();
  const DEFAULT_WINDOW_MS = 250;
  const DEFAULT_SAMPLE_RATE = 16000;
  const SAMPLES_PER_WINDOW = (DEFAULT_SAMPLE_RATE * DEFAULT_WINDOW_MS) / 1000; // 4000

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10a: Window count correctness.
   * For any non-empty audio input, the number of windows equals
   * ceil(totalSamples / samplesPerWindow).
   */
  it("window count equals ceil(totalSamples / samplesPerWindow)", () => {
    fc.assert(
      fc.property(arbitraryPCMAudioChunks(), ({ chunks, totalSamples }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        const expectedWindowCount = Math.ceil(totalSamples / SAMPLES_PER_WINDOW);
        expect(profile.windows.length).toBe(expectedWindowCount);
        expect(profile.windowDurationMs).toBe(DEFAULT_WINDOW_MS);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10b: Normalized RMS range.
   * All normalized RMS values are in [0, 1] range.
   */
  it("all normalized RMS values are in [0, 1] range", () => {
    fc.assert(
      fc.property(arbitraryPCMAudioChunks(), ({ chunks }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        for (const value of profile.windows) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1.0);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10c: Maximum normalized RMS is exactly 1.0 (unless all-silence).
   * For any non-empty audio with at least one non-zero sample, the maximum
   * normalized RMS value is exactly 1.0.
   */
  it("maximum normalized RMS is 1.0 when audio has non-zero samples", () => {
    fc.assert(
      fc.property(
        arbitraryPCMAudioChunks().filter(({ chunks }) => {
          // Ensure at least one non-zero sample exists
          for (const chunk of chunks) {
            for (let i = 0; i < chunk.length; i += 2) {
              if (chunk.readInt16LE(i) !== 0) return true;
            }
          }
          return false;
        }),
        ({ chunks }) => {
          const profile = extractor.computeEnergyProfile(chunks);

          const maxValue = Math.max(...profile.windows);
          expect(maxValue).toBe(1.0);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10d: All-silence audio produces all-zero windows and max is 0.
   */
  it("all-silence audio produces all-zero normalized windows", () => {
    fc.assert(
      fc.property(arbitraryAllSilenceAudioChunks(), ({ chunks }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        for (const value of profile.windows) {
          expect(value).toBe(0);
        }
        expect(profile.coefficientOfVariation).toBe(0);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10e: Silence threshold is non-negative.
   * For any non-empty audio input, the silence threshold is >= 0.
   */
  it("silence threshold is non-negative", () => {
    fc.assert(
      fc.property(arbitraryPCMAudioChunks(), ({ chunks }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        expect(profile.silenceThreshold).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10f: Coefficient of variation is non-negative.
   * For any non-empty audio input, the CV is >= 0.
   */
  it("coefficient of variation is non-negative", () => {
    fc.assert(
      fc.property(arbitraryPCMAudioChunks(), ({ chunks }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        expect(profile.coefficientOfVariation).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10g: Non-silence windows are used for CV computation.
   * For constant-amplitude audio (all windows have identical RMS), all non-silence
   * windows have the same normalized value (1.0), so CV should be 0.
   */
  it("constant amplitude audio produces CV of 0 (no variation among non-silence windows)", () => {
    fc.assert(
      fc.property(arbitraryConstantAmplitudeAudioChunks(), ({ chunks }) => {
        const profile = extractor.computeEnergyProfile(chunks);

        // All windows should have the same RMS → normalized to 1.0 → CV = 0
        expect(profile.coefficientOfVariation).toBeCloseTo(0, 10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10h: Empty audio buffer returns zero-length profile.
   */
  it("empty audio buffer returns empty profile with zero CV", () => {
    const profile = extractor.computeEnergyProfile([]);
    expect(profile.windows.length).toBe(0);
    expect(profile.coefficientOfVariation).toBe(0);
    expect(profile.silenceThreshold).toBe(0);
    expect(profile.windowDurationMs).toBe(250);
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10i: Window count with custom window duration.
   * Verifying the formula works with non-default window sizes.
   */
  it("window count is correct with custom window duration", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbitraryPCMAudioChunks(),
          fc.constantFrom(100, 200, 500) // custom window durations in ms
        ),
        ([{ chunks, totalSamples }, windowMs]) => {
          const profile = extractor.computeEnergyProfile(chunks, windowMs);

          const samplesPerWindow = Math.floor((DEFAULT_SAMPLE_RATE * windowMs) / 1000);
          const expectedWindowCount = Math.ceil(totalSamples / samplesPerWindow);

          expect(profile.windows.length).toBe(expectedWindowCount);
          expect(profile.windowDurationMs).toBe(windowMs);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.5, 5.7, 5.8**
   *
   * Property 10j: Multi-chunk concatenation correctness.
   * The energy profile from multiple chunks should be identical to the profile
   * from a single concatenated buffer (verifying chunk concatenation is correct).
   */
  it("multi-chunk audio produces same profile as single concatenated buffer", () => {
    fc.assert(
      fc.property(arbitraryPCMAudioChunks(), ({ chunks }) => {
        // Compute profile from multiple chunks
        const profileMulti = extractor.computeEnergyProfile(chunks);

        // Compute profile from single concatenated buffer
        const combined = Buffer.concat(chunks);
        const profileSingle = extractor.computeEnergyProfile([combined]);

        // Both should produce identical results
        expect(profileMulti.windows.length).toBe(profileSingle.windows.length);
        for (let i = 0; i < profileMulti.windows.length; i++) {
          expect(profileMulti.windows[i]).toBeCloseTo(profileSingle.windows[i], 10);
        }
        expect(profileMulti.coefficientOfVariation).toBeCloseTo(
          profileSingle.coefficientOfVariation, 10
        );
        expect(profileMulti.silenceThreshold).toBeCloseTo(
          profileSingle.silenceThreshold, 10
        );
      }),
      { numRuns: 200 }
    );
  });
});


// ─── Property 11: Energy Gain Invariance ────────────────────────────────────────
// Feature: phase-2-stability-credibility, Property 11: Energy Gain Invariance

/**
 * Generate PCM audio buffers with samples in a restricted amplitude range,
 * paired with a positive gain factor, such that `sample * gain` stays within
 * the Int16 range [-32768, 32767].
 *
 * Strategy:
 * - Base samples are restricted to [-3000, 3000]
 * - Gain factors range from 1.5 to 10.0
 * - Maximum possible product: 3000 * 10 = 30000, safely within Int16 range
 * - At least one non-zero sample is guaranteed so normalization is meaningful
 * - Returns both the original chunks and the gained chunks as separate buffers
 */
function arbitraryAudioWithGain(): fc.Arbitrary<{
  originalChunks: Buffer[];
  gainedChunks: Buffer[];
  gain: number;
  totalSamples: number;
}> {
  return fc
    .tuple(
      // Audio samples: 1-3 chunks, each with 100-8000 samples in restricted range
      fc.array(
        fc.array(
          fc.integer({ min: -3000, max: 3000 }),
          { minLength: 100, maxLength: 8000 }
        ),
        { minLength: 1, maxLength: 3 }
      ),
      // Gain factor: positive, moderate range to avoid clipping
      fc.double({ min: 1.5, max: 10.0, noNaN: true })
    )
    .filter(([chunkSamples, _gain]) => {
      // Ensure at least one non-zero sample exists for meaningful normalization
      for (const samples of chunkSamples) {
        for (const s of samples) {
          if (s !== 0) return true;
        }
      }
      return false;
    })
    .map(([chunkSamples, gain]) => {
      const originalChunks: Buffer[] = [];
      const gainedChunks: Buffer[] = [];
      let totalSamples = 0;

      for (const samples of chunkSamples) {
        const origBuf = Buffer.alloc(samples.length * 2);
        const gainBuf = Buffer.alloc(samples.length * 2);

        for (let i = 0; i < samples.length; i++) {
          const original = samples[i];
          // Apply gain and clamp to Int16 range
          const gained = Math.max(-32768, Math.min(32767, Math.round(original * gain)));

          origBuf.writeInt16LE(original, i * 2);
          gainBuf.writeInt16LE(gained, i * 2);
        }

        originalChunks.push(origBuf);
        gainedChunks.push(gainBuf);
        totalSamples += samples.length;
      }

      return { originalChunks, gainedChunks, gain, totalSamples };
    });
}

describe("Feature: phase-2-stability-credibility, Property 11: Energy Gain Invariance", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 5.6**
   *
   * Property 11a: Normalized window values are identical under gain scaling.
   *
   * For any non-empty audio input and any positive gain factor g,
   * computeEnergyProfile(audio) and computeEnergyProfile(audio * g)
   * should produce identical normalized window values (within floating-point tolerance).
   *
   * Rationale: RMS scales linearly with gain. After dividing by max RMS,
   * the gain factor cancels out, producing identical normalized profiles.
   */
  it("normalized window values are identical for original and gained audio", () => {
    fc.assert(
      fc.property(arbitraryAudioWithGain(), ({ originalChunks, gainedChunks }) => {
        const profileOrig = extractor.computeEnergyProfile(originalChunks);
        const profileGained = extractor.computeEnergyProfile(gainedChunks);

        // Same number of windows
        expect(profileGained.windows.length).toBe(profileOrig.windows.length);

        // Each normalized window value should be identical (within FP tolerance)
        for (let i = 0; i < profileOrig.windows.length; i++) {
          expect(profileGained.windows[i]).toBeCloseTo(profileOrig.windows[i], 5);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.6**
   *
   * Property 11b: Coefficient of variation is identical under gain scaling.
   *
   * Since the normalized windows are identical, the CV (stddev/mean of
   * non-silence windows) should also be identical.
   */
  it("coefficient of variation is identical for original and gained audio", () => {
    fc.assert(
      fc.property(arbitraryAudioWithGain(), ({ originalChunks, gainedChunks }) => {
        const profileOrig = extractor.computeEnergyProfile(originalChunks);
        const profileGained = extractor.computeEnergyProfile(gainedChunks);

        expect(profileGained.coefficientOfVariation).toBeCloseTo(
          profileOrig.coefficientOfVariation, 5
        );
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.6**
   *
   * Property 11c: Silence threshold is identical under gain scaling.
   *
   * The silence threshold is computed on normalized values (median + k * MAD),
   * so it should be invariant to uniform gain changes.
   */
  it("silence threshold is identical for original and gained audio", () => {
    fc.assert(
      fc.property(arbitraryAudioWithGain(), ({ originalChunks, gainedChunks }) => {
        const profileOrig = extractor.computeEnergyProfile(originalChunks);
        const profileGained = extractor.computeEnergyProfile(gainedChunks);

        expect(profileGained.silenceThreshold).toBeCloseTo(
          profileOrig.silenceThreshold, 5
        );
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.6**
   *
   * Property 11d: Gain invariance holds for various gain factors.
   *
   * Tests with a wider range of gain factors including fractional gains (< 1)
   * to verify that scaling down also preserves the normalized profile.
   * Uses a slightly wider gain range but still avoids clipping by using
   * very small base amplitudes.
   */
  it("gain invariance holds for fractional gain factors (scaling down)", () => {
    const smallAmplitudeWithFractionalGain = fc
      .tuple(
        // Samples with larger amplitudes so scaling down still has non-zero values
        fc.array(
          fc.array(
            fc.integer({ min: -20000, max: 20000 }),
            { minLength: 100, maxLength: 4000 }
          ),
          { minLength: 1, maxLength: 2 }
        ),
        // Fractional gain: 0.1 to 0.9 (scaling down, no clipping risk)
        fc.double({ min: 0.1, max: 0.9, noNaN: true })
      )
      .filter(([chunkSamples, _gain]) => {
        for (const samples of chunkSamples) {
          for (const s of samples) {
            if (s !== 0) return true;
          }
        }
        return false;
      })
      .map(([chunkSamples, gain]) => {
        const originalChunks: Buffer[] = [];
        const gainedChunks: Buffer[] = [];

        for (const samples of chunkSamples) {
          const origBuf = Buffer.alloc(samples.length * 2);
          const gainBuf = Buffer.alloc(samples.length * 2);

          for (let i = 0; i < samples.length; i++) {
            const original = samples[i];
            const gained = Math.max(-32768, Math.min(32767, Math.round(original * gain)));
            origBuf.writeInt16LE(original, i * 2);
            gainBuf.writeInt16LE(gained, i * 2);
          }

          originalChunks.push(origBuf);
          gainedChunks.push(gainBuf);
        }

        return { originalChunks, gainedChunks, gain };
      });

    fc.assert(
      fc.property(smallAmplitudeWithFractionalGain, ({ originalChunks, gainedChunks }) => {
        const profileOrig = extractor.computeEnergyProfile(originalChunks);
        const profileGained = extractor.computeEnergyProfile(gainedChunks);

        expect(profileGained.windows.length).toBe(profileOrig.windows.length);

        for (let i = 0; i < profileOrig.windows.length; i++) {
          expect(profileGained.windows[i]).toBeCloseTo(profileOrig.windows[i], 4);
        }

        expect(profileGained.coefficientOfVariation).toBeCloseTo(
          profileOrig.coefficientOfVariation, 4
        );

        expect(profileGained.silenceThreshold).toBeCloseTo(
          profileOrig.silenceThreshold, 4
        );
      }),
      { numRuns: 200 }
    );
  });
});


// ─── Property 12: Filler Word Classification Consistency ────────────────────────
// Feature: phase-2-stability-credibility, Property 12: Filler Word Classification Consistency

/**
 * Words that are always classified as true_filler (never discourse_marker).
 * These are non-contextual fillers: "um", "uh", "ah" are pure fillers;
 * "basically", "literally", "you know" are always true fillers when detected.
 */
const ALWAYS_TRUE_FILLERS = ["um", "uh", "ah"];
const NON_CONTEXTUAL_FILLER_WORDS = ["um", "uh", "ah", "basically", "literally", "you know"];
const CONTEXTUAL_FILLER_WORDS = ["like", "so", "right", "actually"];
const FILLER_SAFE_NORMAL_WORDS = [
  "the", "speech", "was", "great", "today", "we", "talked",
  "about", "ideas", "people", "think", "important", "going",
  "forward", "together", "community", "project", "meeting", "everyone",
];

/**
 * Generate transcript segments with a rich mix of filler words and normal words.
 * Segments have word-level timestamps so contextual classification can be exercised.
 *
 * Strategy:
 * - Mix always-filler words (um, uh, ah), non-contextual fillers (basically, literally),
 *   contextual fillers (like, so, right, actually), and normal words
 * - Contextual words appear in both filler and non-filler positions depending on
 *   their index within the word array (exercising both classification paths)
 * - Word-level timestamps are always provided for accurate contextual classification
 */
function arbitrarySegmentsForFillerClassification(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      // First segment start time (0 to 60 seconds)
      fc.double({ min: 0, max: 60, noNaN: true }),
      // Array of segment specs
      fc.array(
        fc.tuple(
          // segment duration (0.5 to 10 seconds)
          fc.double({ min: 0.5, max: 10, noNaN: true }),
          // gap to next segment (0 to 3 seconds)
          fc.double({ min: 0, max: 3, noNaN: true }),
          // words in this segment: mix of normal words and fillers
          fc.array(
            fc.oneof(
              { weight: 4, arbitrary: fc.constantFrom(...FILLER_SAFE_NORMAL_WORDS) },
              { weight: 2, arbitrary: fc.constantFrom(...ALWAYS_TRUE_FILLERS) },
              { weight: 1, arbitrary: fc.constantFrom("basically", "literally") },
              { weight: 2, arbitrary: fc.constantFrom(...CONTEXTUAL_FILLER_WORDS) }
            ),
            { minLength: 1, maxLength: 15 }
          )
        ),
        { minLength: 1, maxLength: 8 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [duration, gap, wordTexts] of segmentSpecs) {
        const startTime = currentTime;
        const endTime = startTime + duration;

        const words: TranscriptWord[] = wordTexts.map((w, i) => {
          const wordDuration = duration / wordTexts.length;
          const wordStart = startTime + i * wordDuration;
          const wordEnd = wordStart + wordDuration;
          return {
            word: w,
            startTime: wordStart,
            endTime: Math.min(wordEnd, endTime),
            confidence: 0.95,
          };
        });

        segments.push({
          text: wordTexts.join(" "),
          startTime,
          endTime,
          words,
          isFinal: true,
        });

        currentTime = endTime + gap;
      }

      return segments;
    });
}

describe("Feature: phase-2-stability-credibility, Property 12: Filler Word Classification Consistency", () => {
  const extractor = new MetricsExtractor();

  /**
   * **Validates: Requirements 5.9**
   *
   * Property 12a: Every classifiedFillers entry has a valid classification.
   * For any transcript, every entry in classifiedFillers has classification
   * equal to either "true_filler" or "discourse_marker".
   */
  it("every classifiedFillers entry has classification 'true_filler' or 'discourse_marker'", () => {
    fc.assert(
      fc.property(arbitrarySegmentsForFillerClassification(), (segments) => {
        const metrics = extractor.extract(segments);

        for (const entry of metrics.classifiedFillers) {
          expect(["true_filler", "discourse_marker"]).toContain(entry.classification);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.9**
   *
   * Property 12b: fillerWordCount equals the sum of counts from classifiedFillers
   * entries where classification === "true_filler" (backward compatibility).
   */
  it("fillerWordCount equals sum of true_filler counts from classifiedFillers", () => {
    fc.assert(
      fc.property(arbitrarySegmentsForFillerClassification(), (segments) => {
        const metrics = extractor.extract(segments);

        const trueFillerSum = metrics.classifiedFillers
          .filter((e) => e.classification === "true_filler")
          .reduce((sum, e) => sum + e.count, 0);

        expect(metrics.fillerWordCount).toBe(trueFillerSum);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.9**
   *
   * Property 12c: fillerWordFrequency equals fillerWordCount / (durationSeconds / 60).
   */
  it("fillerWordFrequency equals fillerWordCount / (durationSeconds / 60)", () => {
    fc.assert(
      fc.property(arbitrarySegmentsForFillerClassification(), (segments) => {
        const metrics = extractor.extract(segments);

        const durationMinutes = metrics.durationSeconds / 60;
        const expectedFrequency =
          durationMinutes > 0 ? metrics.fillerWordCount / durationMinutes : 0;

        expect(metrics.fillerWordFrequency).toBeCloseTo(expectedFrequency, 10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.9**
   *
   * Property 12d: "um", "uh", "ah" entries are always classified as "true_filler".
   * These words are never contextual and must always be true fillers.
   */
  it('"um", "uh", "ah" entries are always classified as true_filler', () => {
    fc.assert(
      fc.property(arbitrarySegmentsForFillerClassification(), (segments) => {
        const metrics = extractor.extract(segments);

        for (const entry of metrics.classifiedFillers) {
          if (ALWAYS_TRUE_FILLERS.includes(entry.word)) {
            expect(entry.classification).toBe("true_filler");
          }
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.9**
   *
   * Property 12e: Each ClassifiedFillerEntry.count equals the length of its timestamps array.
   */
  it("each ClassifiedFillerEntry.count equals the length of its timestamps array", () => {
    fc.assert(
      fc.property(arbitrarySegmentsForFillerClassification(), (segments) => {
        const metrics = extractor.extract(segments);

        for (const entry of metrics.classifiedFillers) {
          expect(entry.count).toBe(entry.timestamps.length);
        }
      }),
      { numRuns: 200 }
    );
  });
});
