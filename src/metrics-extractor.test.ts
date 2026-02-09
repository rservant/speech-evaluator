// Unit tests for contextual filler word detection
// Validates: Requirements 3.3, 3.6

import { describe, it, expect } from "vitest";
import { MetricsExtractor } from "./metrics-extractor.js";
import type { TranscriptSegment, TranscriptWord } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a TranscriptSegment from a list of words with auto-generated timestamps.
 * Each word gets 0.3s duration with 0.05s gaps.
 */
function makeSegment(
  words: string[],
  startTime: number = 0
): TranscriptSegment {
  const transcriptWords: TranscriptWord[] = [];
  let time = startTime;
  for (const w of words) {
    transcriptWords.push({
      word: w,
      startTime: time,
      endTime: time + 0.3,
      confidence: 0.95,
    });
    time += 0.35; // 0.3s word + 0.05s gap
  }
  return {
    text: words.join(" "),
    startTime,
    endTime: transcriptWords.length > 0 ? transcriptWords[transcriptWords.length - 1].endTime : startTime,
    words: transcriptWords,
    isFinal: true,
  };
}

/**
 * Helper to find a specific filler word entry from metrics results.
 */
function findFiller(
  metrics: ReturnType<MetricsExtractor["extract"]>,
  word: string
) {
  return metrics.fillerWords.find((f) => f.word === word);
}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe("MetricsExtractor - Contextual Filler Word Detection", () => {
  const extractor = new MetricsExtractor();

  // ─── "like" contextual detection ────────────────────────────────────────────

  describe('"like" - contextual detection', () => {
    it('should detect "like" as filler when mid-sentence preceded by non-verb', () => {
      // "the like problem" — "the" is not in verbsTakingLike, so "like" is filler
      const segment = makeSegment(["the", "like", "problem", "is", "here"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should NOT detect "like" as filler when preceded by "I" (pronoun in verbsTakingLike)', () => {
      // "I like pizza" — "I" is in verbsTakingLike set
      const segment = makeSegment(["I", "like", "pizza"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "like" as filler when preceded by "would"', () => {
      const segment = makeSegment(["would", "like", "to", "go"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "like" as filler when preceded by "look"', () => {
      // "look like a star" — "look" is in verbsTakingLike
      const segment = makeSegment(["they", "look", "like", "stars"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "like" as filler when preceded by "feel"', () => {
      const segment = makeSegment(["I", "feel", "like", "dancing"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "like" as filler when preceded by "sounds"', () => {
      const segment = makeSegment(["that", "sounds", "like", "fun"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "like" as filler at sentence start (index 0)', () => {
      const segment = makeSegment(["like", "I", "said", "before"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeUndefined();
    });

    it('should detect "like" as filler when preceded by article "a"', () => {
      // "it was a like really big deal" — "a" is not in verbsTakingLike
      const segment = makeSegment(["it", "was", "a", "like", "really", "big"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should detect multiple "like" fillers in one segment', () => {
      // "and like the thing is like so cool"
      // "and" → "like" (filler), "is" → "like" (filler since "is" is not in verbsTakingLike)
      const segment = makeSegment([
        "and", "like", "the", "thing", "is", "like", "so", "cool",
      ]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "like");
      expect(filler).toBeDefined();
      // "and" is not in verbsTakingLike → first "like" is filler
      // "is" is not in verbsTakingLike → second "like" is filler
      expect(filler!.count).toBe(2);
    });
  });

  // ─── "so" contextual detection ──────────────────────────────────────────────

  describe('"so" - contextual detection', () => {
    it('should detect "so" as filler when sentence-initial (index 0)', () => {
      const segment = makeSegment(["so", "I", "went", "to", "the", "store"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "so");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should NOT detect "so" as filler when mid-sentence conjunction', () => {
      // "I was tired so I left" — "so" at index 3, not index 0
      const segment = makeSegment(["I", "was", "tired", "so", "I", "left"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "so");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "so" in "so that" mid-sentence', () => {
      const segment = makeSegment([
        "I", "studied", "hard", "so", "that", "I", "could", "pass",
      ]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "so");
      expect(filler).toBeUndefined();
    });

    it('should NOT detect "so" in "so much" mid-sentence', () => {
      const segment = makeSegment(["I", "love", "it", "so", "much"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "so");
      expect(filler).toBeUndefined();
    });

    it('should detect "so" as filler in separate segments when segment-initial', () => {
      const seg1 = makeSegment(["so", "the", "thing", "is"], 0);
      const seg2 = makeSegment(["so", "I", "decided", "to", "go"], 5);
      const metrics = extractor.extract([seg1, seg2]);
      const filler = findFiller(metrics, "so");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(2);
    });
  });

  // ─── "right" contextual detection ───────────────────────────────────────────

  describe('"right" - contextual detection', () => {
    it('should detect "right" as filler at end of segment (tag question)', () => {
      const segment = makeSegment(["that", "was", "great", "right"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "right");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should detect "right" as filler at start of segment (interjection)', () => {
      const segment = makeSegment(["right", "so", "let", "me", "explain"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "right");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should NOT detect "right" as filler when mid-sentence', () => {
      // "turn right at the corner" — "right" at index 1, not first or last
      const segment = makeSegment(["turn", "right", "at", "the", "corner"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "right");
      expect(filler).toBeUndefined();
    });
  });

  // ─── "actually" contextual detection ────────────────────────────────────────

  describe('"actually" - contextual detection', () => {
    it('should detect "actually" as filler when sentence-initial', () => {
      const segment = makeSegment(["actually", "I", "think", "we", "should"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "actually");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should NOT detect "actually" as filler when mid-sentence', () => {
      const segment = makeSegment([
        "I", "actually", "went", "to", "the", "store",
      ]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "actually");
      expect(filler).toBeUndefined();
    });
  });

  // ─── Non-contextual fillers (always detected) ──────────────────────────────

  describe("non-contextual fillers - always detected", () => {
    it('should always detect "um" as filler regardless of position', () => {
      const segment = makeSegment(["um", "I", "think", "um", "that"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "um");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(2);
    });

    it('should always detect "uh" as filler', () => {
      const segment = makeSegment(["the", "uh", "problem"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "uh");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should always detect "ah" as filler', () => {
      const segment = makeSegment(["ah", "yes", "of", "course"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "ah");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it("should detect multiple different non-contextual fillers in one segment", () => {
      const segment = makeSegment(["um", "I", "uh", "think", "ah", "yes"]);
      const metrics = extractor.extract([segment]);
      expect(findFiller(metrics, "um")?.count).toBe(1);
      expect(findFiller(metrics, "uh")?.count).toBe(1);
      expect(findFiller(metrics, "ah")?.count).toBe(1);
      expect(metrics.fillerWordCount).toBe(3);
    });
  });

  // ─── "you know" bigram detection ────────────────────────────────────────────

  describe('"you know" - bigram detection', () => {
    it('should detect "you know" as a bigram filler', () => {
      const segment = makeSegment([
        "and", "you", "know", "the", "thing", "is",
      ]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "you know");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });

    it('should detect multiple "you know" occurrences', () => {
      const segment = makeSegment([
        "you", "know", "I", "think", "you", "know", "it", "matters",
      ]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "you know");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(2);
    });

    it('should detect "you know" at the start of a segment', () => {
      const segment = makeSegment(["you", "know", "what", "I", "mean"]);
      const metrics = extractor.extract([segment]);
      const filler = findFiller(metrics, "you know");
      expect(filler).toBeDefined();
      expect(filler!.count).toBe(1);
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should return empty metrics for empty transcript", () => {
      const metrics = extractor.extract([]);
      expect(metrics.fillerWordCount).toBe(0);
      expect(metrics.fillerWords).toEqual([]);
      expect(metrics.totalWords).toBe(0);
      expect(metrics.durationSeconds).toBe(0);
    });

    it("should handle single-word transcript (non-filler)", () => {
      const segment = makeSegment(["hello"]);
      const metrics = extractor.extract([segment]);
      expect(metrics.fillerWordCount).toBe(0);
      expect(metrics.fillerWords).toEqual([]);
      expect(metrics.totalWords).toBe(1);
    });

    it("should handle single-word transcript that is a non-contextual filler", () => {
      const segment = makeSegment(["um"]);
      const metrics = extractor.extract([segment]);
      expect(metrics.fillerWordCount).toBe(1);
      expect(findFiller(metrics, "um")?.count).toBe(1);
    });

    it('should handle single-word "like" (index 0, not filler)', () => {
      const segment = makeSegment(["like"]);
      const metrics = extractor.extract([segment]);
      // "like" at index 0 is not a filler
      expect(findFiller(metrics, "like")).toBeUndefined();
      expect(metrics.fillerWordCount).toBe(0);
    });

    it('should handle single-word "so" (index 0, IS filler)', () => {
      const segment = makeSegment(["so"]);
      const metrics = extractor.extract([segment]);
      // "so" at index 0 IS a filler
      expect(findFiller(metrics, "so")).toBeDefined();
      expect(metrics.fillerWordCount).toBe(1);
    });

    it("should handle transcript where every word is a non-contextual filler", () => {
      const segment = makeSegment(["um", "uh", "ah", "um", "uh"]);
      const metrics = extractor.extract([segment]);
      expect(metrics.fillerWordCount).toBe(5);
      expect(metrics.totalWords).toBe(5);
    });

    it("should handle mixed contextual and non-contextual fillers", () => {
      // "um so like the uh thing" — um (filler), so (index 0 = filler),
      // like (preceded by "so" which is not in verbsTakingLike = filler),
      // uh (filler)
      const segment = makeSegment(["um", "so", "like", "the", "uh", "thing"]);
      const metrics = extractor.extract([segment]);
      expect(findFiller(metrics, "um")?.count).toBe(1);
      // "so" at index 1 is NOT filler (only filler at index 0)
      expect(findFiller(metrics, "so")).toBeUndefined();
      // "like" at index 2, preceded by "so" (not in verbsTakingLike) → filler
      expect(findFiller(metrics, "like")?.count).toBe(1);
      expect(findFiller(metrics, "uh")?.count).toBe(1);
      expect(metrics.fillerWordCount).toBe(3);
    });

    it("should handle segment-level fallback (no word-level data)", () => {
      // When words array is empty, only non-contextual fillers are detected from text
      const segment: TranscriptSegment = {
        text: "um I like went uh to the store so yeah",
        startTime: 0,
        endTime: 5,
        words: [],
        isFinal: true,
      };
      const metrics = extractor.extract([segment]);
      // Only non-contextual fillers detected in segment-level fallback
      expect(findFiller(metrics, "um")?.count).toBe(1);
      expect(findFiller(metrics, "uh")?.count).toBe(1);
      // Contextual fillers ("like", "so") are NOT detected in segment-level fallback
      expect(findFiller(metrics, "like")).toBeUndefined();
      expect(findFiller(metrics, "so")).toBeUndefined();
    });

    it("should handle words with punctuation attached", () => {
      // Transcription may include punctuation: "um," or "like."
      const segment: TranscriptSegment = {
        text: "um, I went, like, to the store",
        startTime: 0,
        endTime: 5,
        words: [
          { word: "um,", startTime: 0, endTime: 0.3, confidence: 0.9 },
          { word: "I", startTime: 0.35, endTime: 0.65, confidence: 0.9 },
          { word: "went,", startTime: 0.7, endTime: 1.0, confidence: 0.9 },
          { word: "like,", startTime: 1.05, endTime: 1.35, confidence: 0.9 },
          { word: "to", startTime: 1.4, endTime: 1.7, confidence: 0.9 },
          { word: "the", startTime: 1.75, endTime: 2.05, confidence: 0.9 },
          { word: "store", startTime: 2.1, endTime: 2.4, confidence: 0.9 },
        ],
        isFinal: true,
      };
      const metrics = extractor.extract([segment]);
      // "um," should be cleaned to "um" and detected
      expect(findFiller(metrics, "um")?.count).toBe(1);
      // "like," at index 3, preceded by "went," (cleaned to "went", not in verbsTakingLike) → filler
      expect(findFiller(metrics, "like")?.count).toBe(1);
    });

    it("should handle multiple segments with fillers across them", () => {
      const seg1 = makeSegment(["um", "hello", "everyone"], 0);
      const seg2 = makeSegment(["so", "today", "I", "want", "to", "talk"], 5);
      const seg3 = makeSegment(["and", "uh", "the", "point", "is"], 10);
      const metrics = extractor.extract([seg1, seg2, seg3]);
      expect(findFiller(metrics, "um")?.count).toBe(1);
      expect(findFiller(metrics, "so")?.count).toBe(1); // index 0 in seg2
      expect(findFiller(metrics, "uh")?.count).toBe(1);
      expect(metrics.fillerWordCount).toBe(3);
    });
  });
});


// ─── Phase 2: Filler Word Classification Tests ──────────────────────────────────
// Validates: Requirements 5.9

describe("MetricsExtractor - Filler Word Classification", () => {
  const extractor = new MetricsExtractor();

  /**
   * Helper to find a classified filler entry by word and classification.
   */
  function findClassified(
    metrics: ReturnType<MetricsExtractor["extract"]>,
    word: string,
    classification?: "true_filler" | "discourse_marker"
  ) {
    return metrics.classifiedFillers.find(
      (f) =>
        f.word === word &&
        (classification === undefined || f.classification === classification)
    );
  }

  // ─── Always true_filler: "um", "uh", "ah" ──────────────────────────────────

  describe("always true_filler words", () => {
    it('should classify "um" as true_filler regardless of position', () => {
      const segment = makeSegment(["um", "I", "think", "um", "that"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "um", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(2);
      expect(entry!.classification).toBe("true_filler");
    });

    it('should classify "uh" as true_filler', () => {
      const segment = makeSegment(["the", "uh", "problem"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "uh", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "ah" as true_filler', () => {
      const segment = makeSegment(["ah", "yes", "of", "course"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "ah", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "basically" as true_filler', () => {
      const segment = makeSegment(["it", "is", "basically", "done"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "basically", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "you know" as true_filler', () => {
      const segment = makeSegment(["and", "you", "know", "the", "thing"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "you know", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });
  });

  // ─── Contextual words in filler position → true_filler ────────────────────

  describe("contextual words in filler position → true_filler", () => {
    it('should classify "like" as true_filler when in filler position', () => {
      // "the like problem" — "the" is not in verbsTakingLike → filler position
      const segment = makeSegment(["the", "like", "problem", "is", "here"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "like", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "so" as true_filler when sentence-initial', () => {
      const segment = makeSegment(["so", "I", "went", "to", "the", "store"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "so", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "right" as true_filler at end of segment', () => {
      const segment = makeSegment(["that", "was", "great", "right"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "right", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "actually" as true_filler when sentence-initial', () => {
      const segment = makeSegment(["actually", "I", "think", "we", "should"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "actually", "true_filler");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });
  });

  // ─── Contextual words NOT in filler position → discourse_marker ───────────

  describe("contextual words NOT in filler position → discourse_marker", () => {
    it('should classify "like" as discourse_marker when preceded by verb', () => {
      // "I like pizza" — "I" is in verbsTakingLike → not filler position
      const segment = makeSegment(["I", "like", "pizza"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "like", "discourse_marker");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      // Should NOT appear as true_filler
      expect(findClassified(metrics, "like", "true_filler")).toBeUndefined();
    });

    it('should classify "like" as discourse_marker at sentence start', () => {
      // "like" at index 0 → not filler position
      const segment = makeSegment(["like", "I", "said", "before"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "like", "discourse_marker");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
    });

    it('should classify "so" as discourse_marker when mid-sentence', () => {
      // "I was tired so I left" — "so" at index 3, not index 0
      const segment = makeSegment(["I", "was", "tired", "so", "I", "left"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "so", "discourse_marker");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      expect(findClassified(metrics, "so", "true_filler")).toBeUndefined();
    });

    it('should classify "right" as discourse_marker when mid-sentence', () => {
      // "turn right at the corner" — "right" at index 1, not first or last
      const segment = makeSegment(["turn", "right", "at", "the", "corner"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "right", "discourse_marker");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      expect(findClassified(metrics, "right", "true_filler")).toBeUndefined();
    });

    it('should classify "actually" as discourse_marker when mid-sentence', () => {
      const segment = makeSegment(["I", "actually", "went", "to", "the", "store"]);
      const metrics = extractor.extract([segment]);
      const entry = findClassified(metrics, "actually", "discourse_marker");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      expect(findClassified(metrics, "actually", "true_filler")).toBeUndefined();
    });
  });

  // ─── Mixed classification in same transcript ─────────────────────────────

  describe("mixed classification in same transcript", () => {
    it("should classify same word differently across segments based on position", () => {
      // Segment 1: "so I went" — "so" at index 0 → true_filler
      // Segment 2: "I was tired so I left" — "so" at index 3 → discourse_marker
      const seg1 = makeSegment(["so", "I", "went"], 0);
      const seg2 = makeSegment(["I", "was", "tired", "so", "I", "left"], 5);
      const metrics = extractor.extract([seg1, seg2]);

      const trueFiller = findClassified(metrics, "so", "true_filler");
      const discourseMarker = findClassified(metrics, "so", "discourse_marker");
      expect(trueFiller).toBeDefined();
      expect(trueFiller!.count).toBe(1);
      expect(discourseMarker).toBeDefined();
      expect(discourseMarker!.count).toBe(1);
    });

    it("should handle mix of true fillers and discourse markers for different words", () => {
      // "um the like problem actually is so cool right"
      // um → true_filler (always)
      // like at index 2, preceded by "the" (not in verbsTakingLike) → true_filler
      // actually at index 4 (not index 0) → discourse_marker
      // so at index 5 (not index 0) → discourse_marker
      // right at index 7 (last word) → true_filler
      const segment = makeSegment([
        "um", "the", "like", "problem", "actually", "is", "so", "cool", "right",
      ]);
      const metrics = extractor.extract([segment]);

      expect(findClassified(metrics, "um", "true_filler")).toBeDefined();
      expect(findClassified(metrics, "like", "true_filler")).toBeDefined();
      expect(findClassified(metrics, "right", "true_filler")).toBeDefined();
      expect(findClassified(metrics, "actually", "discourse_marker")).toBeDefined();
      expect(findClassified(metrics, "so", "discourse_marker")).toBeDefined();
    });
  });

  // ─── Backward compatibility: fillerWordCount = sum of true_filler ─────────

  describe("backward compatibility", () => {
    it("fillerWordCount should equal sum of true_filler counts only", () => {
      // "so I like went" — "so" at index 0 → true_filler, "like" preceded by "I" → discourse_marker
      // "um the thing" — "um" → true_filler
      const seg1 = makeSegment(["so", "I", "like", "went"], 0);
      const seg2 = makeSegment(["um", "the", "thing"], 5);
      const metrics = extractor.extract([seg1, seg2]);

      const trueFillerSum = metrics.classifiedFillers
        .filter((f) => f.classification === "true_filler")
        .reduce((sum, f) => sum + f.count, 0);

      expect(metrics.fillerWordCount).toBe(trueFillerSum);
      // "so" (true_filler) + "um" (true_filler) = 2
      expect(metrics.fillerWordCount).toBe(2);
    });

    it("fillerWordCount should not include discourse_marker counts", () => {
      // "I like pizza and I actually went" — "like" preceded by "I" → discourse_marker,
      // "actually" at index 4 → discourse_marker
      const segment = makeSegment(["I", "like", "pizza", "and", "actually", "went"]);
      const metrics = extractor.extract([segment]);

      // No true fillers in this segment
      expect(metrics.fillerWordCount).toBe(0);
      // But discourse markers should exist
      expect(metrics.classifiedFillers.filter((f) => f.classification === "discourse_marker").length).toBeGreaterThan(0);
    });

    it("fillerWords array should contain only true_filler entries", () => {
      // "so I was tired so I left" — first "so" at index 0 → true_filler, second "so" at index 4 → discourse_marker
      const segment = makeSegment(["so", "I", "was", "tired", "so", "I", "left"]);
      const metrics = extractor.extract([segment]);

      // fillerWords should only have the true_filler "so" with count 1
      const soFiller = metrics.fillerWords.find((f) => f.word === "so");
      expect(soFiller).toBeDefined();
      expect(soFiller!.count).toBe(1);
      expect(metrics.fillerWordCount).toBe(1);
    });

    it("fillerWordFrequency should be based on true_filler count only", () => {
      // Create a 60-second segment with 2 true fillers and 1 discourse marker
      const words: TranscriptWord[] = [
        { word: "um", startTime: 0, endTime: 0.3, confidence: 0.95 },
        { word: "I", startTime: 0.35, endTime: 0.65, confidence: 0.95 },
        { word: "like", startTime: 0.7, endTime: 1.0, confidence: 0.95 }, // preceded by "I" → discourse_marker
        { word: "pizza", startTime: 1.05, endTime: 1.35, confidence: 0.95 },
        { word: "uh", startTime: 30, endTime: 30.3, confidence: 0.95 },
        { word: "yeah", startTime: 59.7, endTime: 60, confidence: 0.95 },
      ];
      const segment: TranscriptSegment = {
        text: words.map((w) => w.word).join(" "),
        startTime: 0,
        endTime: 60,
        words,
        isFinal: true,
      };
      const metrics = extractor.extract([segment]);

      // 2 true fillers (um, uh) in 1 minute = frequency of 2
      expect(metrics.fillerWordCount).toBe(2);
      expect(metrics.fillerWordFrequency).toBeCloseTo(2, 1);
    });
  });

  // ─── Edge cases for classification ────────────────────────────────────────

  describe("classification edge cases", () => {
    it("should return empty classifiedFillers for empty transcript", () => {
      const metrics = extractor.extract([]);
      expect(metrics.classifiedFillers).toEqual([]);
    });

    it("should return empty classifiedFillers when no filler words present", () => {
      const segment = makeSegment(["hello", "world", "how", "are", "you"]);
      const metrics = extractor.extract([segment]);
      expect(metrics.classifiedFillers).toEqual([]);
    });

    it("should have valid classification field on every entry", () => {
      const segment = makeSegment([
        "um", "so", "I", "like", "went", "right",
      ]);
      const metrics = extractor.extract([segment]);

      for (const entry of metrics.classifiedFillers) {
        expect(["true_filler", "discourse_marker"]).toContain(entry.classification);
        expect(entry.count).toBeGreaterThan(0);
        expect(entry.timestamps.length).toBe(entry.count);
      }
    });

    it("should handle segment-level fallback (no word data) — only true_filler", () => {
      const segment: TranscriptSegment = {
        text: "um I like went uh to the store so yeah",
        startTime: 0,
        endTime: 5,
        words: [],
        isFinal: true,
      };
      const metrics = extractor.extract([segment]);

      // Only non-contextual fillers detected in segment-level fallback, all as true_filler
      const umEntry = findClassified(metrics, "um", "true_filler");
      const uhEntry = findClassified(metrics, "uh", "true_filler");
      expect(umEntry).toBeDefined();
      expect(uhEntry).toBeDefined();
      // No discourse markers in segment-level fallback (can't determine context)
      expect(metrics.classifiedFillers.filter((f) => f.classification === "discourse_marker")).toEqual([]);
    });

    it("timestamps should be correctly assigned to classified entries", () => {
      const seg1 = makeSegment(["um", "hello"], 0);
      const seg2 = makeSegment(["so", "the", "thing"], 5);
      const metrics = extractor.extract([seg1, seg2]);

      const umEntry = findClassified(metrics, "um", "true_filler");
      expect(umEntry).toBeDefined();
      expect(umEntry!.timestamps[0]).toBe(0); // first word of seg1

      const soEntry = findClassified(metrics, "so", "true_filler");
      expect(soEntry).toBeDefined();
      expect(soEntry!.timestamps[0]).toBe(5); // first word of seg2
    });
  });
});


// ─── Phase 2: Pause Classification Tests ────────────────────────────────────────
// Validates: Requirements 5.1, 5.2, 5.3

describe("MetricsExtractor - Pause Classification", () => {
  const extractor = new MetricsExtractor();

  // Helper to create a segment with specific word timings
  function makeTimedSegment(
    words: { word: string; start: number; end: number }[]
  ): TranscriptSegment {
    return {
      text: words.map((w) => w.word).join(" "),
      startTime: words.length > 0 ? words[0].start : 0,
      endTime: words.length > 0 ? words[words.length - 1].end : 0,
      words: words.map((w) => ({
        word: w.word,
        startTime: w.start,
        endTime: w.end,
        confidence: 0.95,
      })),
      isFinal: true,
    };
  }

  // ─── Intentional pause classification ─────────────────────────────────────

  describe("intentional pause classification", () => {
    it("should classify pause after sentence-ending punctuation as intentional", () => {
      // "Hello world." [2s pause] "This is new."
      const seg1 = makeTimedSegment([
        { word: "Hello", start: 0, end: 0.3 },
        { word: "world.", start: 0.35, end: 0.65 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "This", start: 2.65, end: 2.95 },
        { word: "is", start: 3.0, end: 3.3 },
        { word: "new.", start: 3.35, end: 3.65 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("intentional");
      expect(metrics.classifiedPauses[0].reason).toContain("follows complete sentence");
      expect(metrics.intentionalPauseCount).toBe(1);
      expect(metrics.hesitationPauseCount).toBe(0);
    });

    it("should classify pause after exclamation mark as intentional", () => {
      // "Amazing!" [2s pause] "Now let me"
      const seg1 = makeTimedSegment([
        { word: "Amazing!", start: 0, end: 0.4 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Now", start: 2.4, end: 2.7 },
        { word: "let", start: 2.75, end: 3.05 },
        { word: "me", start: 3.1, end: 3.4 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("intentional");
    });

    it("should classify pause after question mark as intentional", () => {
      // "Why?" [2s pause] "Because it matters."
      const seg1 = makeTimedSegment([
        { word: "Why?", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Because", start: 2.3, end: 2.7 },
        { word: "it", start: 2.75, end: 2.95 },
        { word: "matters.", start: 3.0, end: 3.4 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("intentional");
    });
  });

  // ─── Hesitation pause classification ──────────────────────────────────────

  describe("hesitation pause classification", () => {
    it("should classify mid-sentence pause as hesitation", () => {
      // "I was" [2s pause] "going to the store"
      const seg1 = makeTimedSegment([
        { word: "I", start: 0, end: 0.1 },
        { word: "was", start: 0.15, end: 0.45 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "going", start: 2.45, end: 2.75 },
        { word: "to", start: 2.8, end: 3.0 },
        { word: "the", start: 3.05, end: 3.25 },
        { word: "store", start: 3.3, end: 3.6 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.hesitationPauseCount).toBe(1);
      expect(metrics.intentionalPauseCount).toBe(0);
    });

    it("should classify pause preceded by filler word as hesitation", () => {
      // "and um" [2s pause] "The thing is"
      const seg1 = makeTimedSegment([
        { word: "and", start: 0, end: 0.2 },
        { word: "um", start: 0.25, end: 0.45 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "The", start: 2.45, end: 2.75 },
        { word: "thing", start: 2.8, end: 3.1 },
        { word: "is", start: 3.15, end: 3.35 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.classifiedPauses[0].reason).toContain("filler word");
    });

    it("should classify pause followed by repeated word as hesitation", () => {
      // "the the" with a 2s pause between them
      const seg1 = makeTimedSegment([
        { word: "I", start: 0, end: 0.1 },
        { word: "went", start: 0.15, end: 0.45 },
        { word: "to", start: 0.5, end: 0.7 },
        { word: "the", start: 0.75, end: 1.0 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "the", start: 3.0, end: 3.2 },
        { word: "store", start: 3.25, end: 3.55 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.classifiedPauses[0].reason).toContain("repeated word");
    });

    it("should classify pause preceded by 'uh' as hesitation", () => {
      // "I uh" [2s pause] "Think so."
      const seg1 = makeTimedSegment([
        { word: "I", start: 0, end: 0.1 },
        { word: "uh", start: 0.15, end: 0.35 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Think", start: 2.35, end: 2.65 },
        { word: "so.", start: 2.7, end: 2.95 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.classifiedPauses[0].reason).toContain("filler word");
    });
  });

  // ─── Hesitation-wins precedence rule ──────────────────────────────────────

  describe("hesitation-wins precedence rule", () => {
    it("should classify as hesitation when both indicators present (filler + punctuation)", () => {
      // "um." [2s pause] "The next point" — has sentence-ending punct AND filler word
      const seg1 = makeTimedSegment([
        { word: "um.", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "The", start: 2.3, end: 2.6 },
        { word: "next", start: 2.65, end: 2.95 },
        { word: "point", start: 3.0, end: 3.3 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      // Hesitation wins because preceding word is a filler, even though it has punctuation
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
    });

    it("should classify as hesitation when repeated word + sentence-ending punct", () => {
      // "done." [2s pause] "done." — has punctuation but also repetition
      const seg1 = makeTimedSegment([
        { word: "I'm", start: 0, end: 0.2 },
        { word: "done.", start: 0.25, end: 0.55 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "done.", start: 2.55, end: 2.85 },
        { word: "Okay.", start: 2.9, end: 3.2 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.classifiedPauses[0].reason).toContain("repeated word");
    });
  });

  // ─── Candidate vs reportable threshold ────────────────────────────────────

  describe("candidate vs reportable threshold", () => {
    it("should not report pauses below the reportable threshold (1.5s)", () => {
      // Gap of 1.0s — above candidate (300ms) but below reportable (1.5s)
      const seg1 = makeTimedSegment([
        { word: "Hello", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "world", start: 1.3, end: 1.6 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(0);
      expect(metrics.pauseCount).toBe(0);
    });

    it("should report pauses at exactly the reportable threshold (1.5s)", () => {
      const seg1 = makeTimedSegment([
        { word: "Hello.", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "World", start: 1.8, end: 2.1 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.pauseCount).toBe(1);
    });

    it("should use custom thresholds when provided", () => {
      const customExtractor = new MetricsExtractor(2.0, 0.5);
      // Gap of 1.8s — above default reportable (1.5s) but below custom (2.0s)
      const seg1 = makeTimedSegment([
        { word: "Hello.", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "World", start: 2.1, end: 2.4 },
      ]);
      const metrics = customExtractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(0);
      expect(metrics.pauseCount).toBe(0);
    });
  });

  // ─── Count consistency ────────────────────────────────────────────────────

  describe("count consistency", () => {
    it("pauseCount should equal intentionalPauseCount + hesitationPauseCount", () => {
      // Create a transcript with multiple pauses of different types
      const seg1 = makeTimedSegment([
        { word: "First", start: 0, end: 0.3 },
        { word: "point.", start: 0.35, end: 0.65 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Second", start: 2.65, end: 2.95 }, // 2s gap — intentional (after ".")
      ]);
      const seg3 = makeTimedSegment([
        { word: "and", start: 5.0, end: 5.2 },
        { word: "um", start: 5.25, end: 5.45 },
      ]);
      const seg4 = makeTimedSegment([
        { word: "third", start: 7.45, end: 7.75 }, // 2s gap after "um" — hesitation
      ]);
      const metrics = extractor.extract([seg1, seg2, seg3, seg4]);

      expect(metrics.pauseCount).toBe(
        metrics.intentionalPauseCount + metrics.hesitationPauseCount
      );
      expect(metrics.pauseCount).toBeGreaterThan(0);
    });

    it("should return zero counts for transcript with no pauses", () => {
      const segment = makeSegment(["hello", "world", "how", "are", "you"]);
      const metrics = extractor.extract([segment]);

      expect(metrics.pauseCount).toBe(0);
      expect(metrics.intentionalPauseCount).toBe(0);
      expect(metrics.hesitationPauseCount).toBe(0);
      expect(metrics.classifiedPauses).toHaveLength(0);
    });

    it("should return zero counts for empty transcript", () => {
      const metrics = extractor.extract([]);

      expect(metrics.pauseCount).toBe(0);
      expect(metrics.intentionalPauseCount).toBe(0);
      expect(metrics.hesitationPauseCount).toBe(0);
      expect(metrics.classifiedPauses).toEqual([]);
    });
  });

  // ─── Punctuation fallback heuristic ───────────────────────────────────────

  describe("punctuation fallback heuristic", () => {
    it("should use fallback when no punctuation: duration + capitalization + sentence-final word → intentional", () => {
      // "everyone" [2s pause] "Today we" — no punctuation, but:
      // - duration 1.5-4s ✓, capitalized next word ✓, sentence-final word "everyone" ✓
      const seg1 = makeTimedSegment([
        { word: "thank", start: 0, end: 0.3 },
        { word: "everyone", start: 0.35, end: 0.75 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Today", start: 2.75, end: 3.05 },
        { word: "we", start: 3.1, end: 3.3 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("intentional");
      expect(metrics.classifiedPauses[0].reason).toContain("punctuation fallback");
    });

    it("should classify as hesitation when fallback heuristic has insufficient indicators", () => {
      // "the" [2s pause] "thing" — no punctuation, no capitalization, not sentence-final word
      const seg1 = makeTimedSegment([
        { word: "the", start: 0, end: 0.2 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "thing", start: 2.2, end: 2.5 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
    });
  });

  // ─── Intra-segment pause classification ───────────────────────────────────

  describe("intra-segment pause classification", () => {
    it("should classify intra-segment pauses (word-level gaps within a segment)", () => {
      // Single segment with a 2s gap between words
      const segment = makeTimedSegment([
        { word: "I", start: 0, end: 0.1 },
        { word: "think", start: 0.15, end: 0.45 },
        { word: "that", start: 2.45, end: 2.75 }, // 2s gap after "think"
        { word: "works", start: 2.8, end: 3.1 },
      ]);
      const metrics = extractor.extract([segment]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].type).toBe("hesitation");
      expect(metrics.classifiedPauses[0].start).toBeCloseTo(0.45);
      expect(metrics.classifiedPauses[0].end).toBeCloseTo(2.45);
    });
  });

  // ─── ClassifiedPause structure ────────────────────────────────────────────

  describe("ClassifiedPause structure", () => {
    it("should include start, end, duration, type, and reason fields", () => {
      const seg1 = makeTimedSegment([
        { word: "Hello.", start: 0, end: 0.3 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "World", start: 2.3, end: 2.6 },
      ]);
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      const pause = metrics.classifiedPauses[0];
      expect(pause).toHaveProperty("start");
      expect(pause).toHaveProperty("end");
      expect(pause).toHaveProperty("duration");
      expect(pause).toHaveProperty("type");
      expect(pause).toHaveProperty("reason");
      expect(pause.duration).toBeCloseTo(2.0);
      expect(["intentional", "hesitation"]).toContain(pause.type);
      expect(pause.reason.length).toBeGreaterThan(0);
    });
  });

  // ─── Segment-level fallback (no word-level data) ──────────────────────────

  describe("segment-level fallback for pause classification", () => {
    it("should classify inter-segment pauses when no word-level data available", () => {
      const seg1: TranscriptSegment = {
        text: "This is a complete thought.",
        startTime: 0,
        endTime: 2.0,
        words: [],
        isFinal: true,
      };
      const seg2: TranscriptSegment = {
        text: "And here is another one.",
        startTime: 4.0,
        endTime: 6.0,
        words: [],
        isFinal: true,
      };
      const metrics = extractor.extract([seg1, seg2]);

      expect(metrics.classifiedPauses).toHaveLength(1);
      expect(metrics.classifiedPauses[0].duration).toBeCloseTo(2.0);
      // "thought." ends with period, "And" is capitalized → intentional
      expect(metrics.classifiedPauses[0].type).toBe("intentional");
    });
  });

  // ─── Multiple pauses with mixed classification ────────────────────────────

  describe("multiple pauses with mixed classification", () => {
    it("should correctly classify a mix of intentional and hesitation pauses", () => {
      // Seg1: "First point." → intentional pause → Seg2: "Second" → hesitation pause (after "um") → Seg3
      const seg1 = makeTimedSegment([
        { word: "First", start: 0, end: 0.3 },
        { word: "point.", start: 0.35, end: 0.65 },
      ]);
      const seg2 = makeTimedSegment([
        { word: "Second", start: 2.65, end: 2.95 },
        { word: "um", start: 3.0, end: 3.2 },
      ]);
      const seg3 = makeTimedSegment([
        { word: "thing", start: 5.2, end: 5.5 },
      ]);
      const metrics = extractor.extract([seg1, seg2, seg3]);

      expect(metrics.classifiedPauses.length).toBeGreaterThanOrEqual(2);

      // First pause: after "point." → intentional
      const firstPause = metrics.classifiedPauses.find(
        (p) => p.start < 1.0
      );
      expect(firstPause).toBeDefined();
      expect(firstPause!.type).toBe("intentional");

      // Second pause: after "um" → hesitation
      const secondPause = metrics.classifiedPauses.find(
        (p) => p.start > 3.0
      );
      expect(secondPause).toBeDefined();
      expect(secondPause!.type).toBe("hesitation");

      // Verify counts add up
      expect(metrics.pauseCount).toBe(
        metrics.intentionalPauseCount + metrics.hesitationPauseCount
      );
    });
  });
});


// ─── Phase 2: Energy Profile Computation Tests ──────────────────────────────────
// Validates: Requirements 5.5, 5.6, 5.7, 5.8, 5.11

describe("MetricsExtractor - computeEnergyProfile", () => {
  const extractor = new MetricsExtractor();

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Create a PCM 16-bit LE mono buffer from an array of sample values.
   * Each sample is a signed 16-bit integer (-32768 to 32767).
   */
  function makePcmBuffer(samples: number[]): Buffer {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      buf.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, samples[i]))), i * 2);
    }
    return buf;
  }

  /**
   * Create a PCM buffer with a constant amplitude for a given number of samples.
   */
  function makeConstantBuffer(amplitude: number, sampleCount: number): Buffer {
    const samples = new Array(sampleCount).fill(amplitude);
    return makePcmBuffer(samples);
  }

  /**
   * Create a PCM buffer with alternating amplitude windows.
   * Each window is 4000 samples (250ms at 16kHz).
   */
  function makeAlternatingWindows(
    amplitudes: number[],
    samplesPerWindow: number = 4000
  ): Buffer {
    const allSamples: number[] = [];
    for (const amp of amplitudes) {
      for (let i = 0; i < samplesPerWindow; i++) {
        allSamples.push(amp);
      }
    }
    return makePcmBuffer(allSamples);
  }

  // ─── Empty / edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should return empty profile for empty audio chunks", () => {
      const profile = extractor.computeEnergyProfile([]);

      expect(profile.windowDurationMs).toBe(250);
      expect(profile.windows).toEqual([]);
      expect(profile.coefficientOfVariation).toBe(0);
      expect(profile.silenceThreshold).toBe(0);
    });

    it("should return empty profile for a single empty buffer", () => {
      const profile = extractor.computeEnergyProfile([Buffer.alloc(0)]);

      expect(profile.windows).toEqual([]);
      expect(profile.coefficientOfVariation).toBe(0);
    });

    it("should return CV of 0 for all-zero audio (complete silence)", () => {
      // 2 windows of silence (8000 samples = 2 * 4000)
      const buf = makeConstantBuffer(0, 8000);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.windows.length).toBe(2);
      // All windows should be 0 (silence)
      for (const w of profile.windows) {
        expect(w).toBe(0);
      }
      expect(profile.coefficientOfVariation).toBe(0);
    });

    it("should return CV of 0 for a single window of audio", () => {
      // Exactly 4000 samples = 1 window
      const buf = makeConstantBuffer(1000, 4000);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.windows.length).toBe(1);
      expect(profile.windows[0]).toBe(1); // normalized: max is itself
      // Single non-silence window → CV = 0 (stddev of single value is 0)
      expect(profile.coefficientOfVariation).toBe(0);
    });

    it("should handle a buffer with a single sample", () => {
      const buf = makePcmBuffer([5000]);
      const profile = extractor.computeEnergyProfile([buf]);

      // 1 sample → ceil(1/4000) = 1 window
      expect(profile.windows.length).toBe(1);
      expect(profile.coefficientOfVariation).toBe(0);
    });
  });

  // ─── Window count ───────────────────────────────────────────────────────────

  describe("window count", () => {
    it("should produce correct number of windows for exact multiple of window size", () => {
      // 3 windows = 12000 samples
      const buf = makeConstantBuffer(1000, 12000);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.windows.length).toBe(3);
    });

    it("should produce ceil(totalSamples / samplesPerWindow) windows for non-exact multiple", () => {
      // 4001 samples → ceil(4001/4000) = 2 windows
      const buf = makeConstantBuffer(1000, 4001);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.windows.length).toBe(2);
    });

    it("should handle multiple audio chunks concatenated", () => {
      // Two chunks of 4000 samples each = 8000 total = 2 windows
      const chunk1 = makeConstantBuffer(1000, 4000);
      const chunk2 = makeConstantBuffer(2000, 4000);
      const profile = extractor.computeEnergyProfile([chunk1, chunk2]);

      expect(profile.windows.length).toBe(2);
    });
  });

  // ─── RMS computation ────────────────────────────────────────────────────────

  describe("RMS computation", () => {
    it("should compute correct RMS for constant amplitude", () => {
      // A constant signal of amplitude A has RMS = |A|
      // Two windows: one at 1000, one at 2000
      const buf = makeAlternatingWindows([1000, 2000]);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.windows.length).toBe(2);
      // RMS of constant 1000 = 1000, RMS of constant 2000 = 2000
      // Normalized: 1000/2000 = 0.5, 2000/2000 = 1.0
      expect(profile.windows[0]).toBeCloseTo(0.5, 5);
      expect(profile.windows[1]).toBeCloseTo(1.0, 5);
    });

    it("should produce normalized values in [0, 1] range", () => {
      const buf = makeAlternatingWindows([500, 1000, 3000, 2000, 100]);
      const profile = extractor.computeEnergyProfile([buf]);

      for (const w of profile.windows) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
      // The maximum window should be exactly 1.0
      expect(Math.max(...profile.windows)).toBeCloseTo(1.0, 5);
    });
  });

  // ─── Gain invariance (Req 5.6) ─────────────────────────────────────────────

  describe("gain invariance", () => {
    it("should produce the same normalized profile regardless of gain factor", () => {
      const baseAmplitudes = [500, 1000, 3000, 2000, 800];
      const buf1 = makeAlternatingWindows(baseAmplitudes);

      // Apply gain factor of 3
      const gainedAmplitudes = baseAmplitudes.map((a) => a * 3);
      const buf2 = makeAlternatingWindows(gainedAmplitudes);

      const profile1 = extractor.computeEnergyProfile([buf1]);
      const profile2 = extractor.computeEnergyProfile([buf2]);

      expect(profile1.windows.length).toBe(profile2.windows.length);
      for (let i = 0; i < profile1.windows.length; i++) {
        expect(profile1.windows[i]).toBeCloseTo(profile2.windows[i], 5);
      }
      expect(profile1.coefficientOfVariation).toBeCloseTo(
        profile2.coefficientOfVariation,
        5
      );
    });

    it("should produce the same CV for half-gain audio", () => {
      const baseAmplitudes = [1000, 5000, 2000, 8000];
      const buf1 = makeAlternatingWindows(baseAmplitudes);
      const halfAmplitudes = baseAmplitudes.map((a) => Math.round(a / 2));
      const buf2 = makeAlternatingWindows(halfAmplitudes);

      const profile1 = extractor.computeEnergyProfile([buf1]);
      const profile2 = extractor.computeEnergyProfile([buf2]);

      expect(profile1.coefficientOfVariation).toBeCloseTo(
        profile2.coefficientOfVariation,
        4
      );
    });
  });

  // ─── Silence threshold and exclusion (Req 5.7) ─────────────────────────────

  describe("silence threshold and exclusion", () => {
    it("should compute a non-zero silence threshold for mixed audio", () => {
      // Mix of loud and quiet windows
      const buf = makeAlternatingWindows([100, 5000, 100, 5000, 100]);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.silenceThreshold).toBeGreaterThan(0);
    });

    it("should exclude silence windows from CV computation", () => {
      // Use 5 windows with 2 clearly quiet and 3 louder, with k=0 so threshold = median
      // Amplitudes: [100, 5000, 100, 5000, 10000]
      // Normalized: [0.01, 0.5, 0.01, 0.5, 1.0]
      // sorted: [0.01, 0.01, 0.5, 0.5, 1.0], median = 0.5
      // With k=0: threshold = 0.5
      // Windows >= 0.5: [0.5, 0.5, 1.0] → 3 windows (the two 0.01 windows are excluded)
      const buf = makeAlternatingWindows([100, 5000, 100, 5000, 10000]);
      const profile = extractor.computeEnergyProfile([buf], 250, 16000, 0);

      // The two quiet windows (0.01) should be below the threshold
      expect(profile.windows.filter((w) => w < profile.silenceThreshold).length).toBe(2);
      // CV should be non-zero since the remaining windows [0.5, 0.5, 1.0] have variation
      expect(profile.coefficientOfVariation).toBeGreaterThan(0);
    });

    it("should return CV of 0 when all windows are below silence threshold", () => {
      // All very quiet windows — they should all be classified as silence
      // With uniform values, median = value, MAD = 0, threshold = value
      // So windows at exactly the threshold are NOT below it (>= threshold)
      // Use all-zero to guarantee all-silence
      const buf = makeConstantBuffer(0, 8000);
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.coefficientOfVariation).toBe(0);
    });
  });

  // ─── Coefficient of variation computation ─────────────────────────────────

  describe("coefficient of variation", () => {
    it("should return 0 for uniform amplitude (no variation)", () => {
      // All windows have the same amplitude → CV = 0
      const buf = makeConstantBuffer(5000, 20000); // 5 windows
      const profile = extractor.computeEnergyProfile([buf]);

      expect(profile.coefficientOfVariation).toBe(0);
    });

    it("should return non-zero CV for varying amplitude", () => {
      // Windows with different amplitudes should produce non-zero CV
      // Use k=0 to ensure the threshold doesn't filter out too many windows
      const buf = makeAlternatingWindows([1000, 5000, 2000, 8000]);
      const profile = extractor.computeEnergyProfile([buf], 250, 16000, 0);

      // Normalized: [0.125, 0.625, 0.25, 1.0]
      // With k=0: threshold = median = (0.25+0.625)/2 = 0.4375
      // Windows >= 0.4375: [0.625, 1.0] → 2 windows with variation
      expect(profile.coefficientOfVariation).toBeGreaterThan(0);
    });

    it("should compute correct CV for known values", () => {
      // Two windows: amplitude 1000 and 3000
      // RMS: 1000, 3000 → normalized: 1/3, 1.0
      // Both above silence threshold (median=2/3, MAD=1/3, threshold=2/3+1/3=1.0)
      // Actually let's use a simpler case with silenceK=0 to avoid threshold complications
      const buf = makeAlternatingWindows([3000, 6000, 9000]);
      // RMS: 3000, 6000, 9000 → normalized: 1/3, 2/3, 1.0
      // With k=0: threshold = median = 2/3, so windows >= 2/3 are kept: [2/3, 1.0]
      // mean = (2/3 + 1) / 2 = 5/6
      // variance = ((2/3 - 5/6)^2 + (1 - 5/6)^2) / 2 = (1/36 + 1/36) / 2 = 1/36
      // stddev = 1/6
      // CV = (1/6) / (5/6) = 1/5 = 0.2
      const profile = extractor.computeEnergyProfile([buf], 250, 16000, 0);

      expect(profile.windows.length).toBe(3);
      expect(profile.windows[0]).toBeCloseTo(1 / 3, 5);
      expect(profile.windows[1]).toBeCloseTo(2 / 3, 5);
      expect(profile.windows[2]).toBeCloseTo(1.0, 5);
      expect(profile.coefficientOfVariation).toBeCloseTo(0.2, 5);
    });
  });

  // ─── Configurable parameters ──────────────────────────────────────────────

  describe("configurable parameters", () => {
    it("should respect custom window duration", () => {
      // 500ms window = 8000 samples per window at 16kHz
      // 16000 samples → 2 windows
      const buf = makeConstantBuffer(1000, 16000);
      const profile = extractor.computeEnergyProfile([buf], 500);

      expect(profile.windowDurationMs).toBe(500);
      expect(profile.windows.length).toBe(2);
    });

    it("should respect custom silenceK parameter", () => {
      // Higher k → higher threshold → more windows classified as silence
      const buf = makeAlternatingWindows([100, 500, 1000, 5000, 10000]);

      const profileLowK = extractor.computeEnergyProfile([buf], 250, 16000, 0.5);
      const profileHighK = extractor.computeEnergyProfile([buf], 250, 16000, 2.0);

      // Higher k should produce a higher silence threshold
      expect(profileHighK.silenceThreshold).toBeGreaterThanOrEqual(
        profileLowK.silenceThreshold
      );
    });
  });

  // ─── Privacy: raw samples not persisted (Req 5.11) ────────────────────────

  describe("privacy compliance", () => {
    it("should not include raw sample data in the returned profile", () => {
      const buf = makeAlternatingWindows([1000, 5000, 2000]);
      const profile = extractor.computeEnergyProfile([buf]);

      // The profile should only contain derived data, not raw samples
      expect(profile).toHaveProperty("windowDurationMs");
      expect(profile).toHaveProperty("windows");
      expect(profile).toHaveProperty("coefficientOfVariation");
      expect(profile).toHaveProperty("silenceThreshold");
      // Should NOT have any raw sample arrays
      expect(profile).not.toHaveProperty("samples");
      expect(profile).not.toHaveProperty("rawSamples");
      expect(profile).not.toHaveProperty("audioData");
      // Windows should be normalized values, not raw amplitudes
      for (const w of profile.windows) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    });
  });
});
