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
