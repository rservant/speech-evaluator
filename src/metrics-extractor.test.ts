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
