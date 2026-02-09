import { describe, it, expect } from "vitest";
import { EvidenceValidator } from "./evidence-validator.js";
import type {
  EvaluationItem,
  StructuredEvaluation,
  TranscriptSegment,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeSegment(
  text: string,
  startTime: number,
  endTime: number,
  words: { word: string; startTime: number; endTime: number }[] = [],
): TranscriptSegment {
  return {
    text,
    startTime,
    endTime,
    words: words.map((w) => ({ ...w, confidence: 0.99 })),
    isFinal: true,
  };
}

function makeItem(
  type: "commendation" | "recommendation",
  quote: string,
  timestamp: number,
): EvaluationItem {
  return {
    type,
    summary: `Test ${type}`,
    evidence_quote: quote,
    evidence_timestamp: timestamp,
    explanation: "Test explanation",
  };
}

function makeEvaluation(items: EvaluationItem[]): StructuredEvaluation {
  return {
    opening: "Great speech.",
    items,
    closing: "Keep it up.",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("EvidenceValidator", () => {
  const validator = new EvidenceValidator();

  // ── normalize ─────────────────────────────────────────────────────────────

  describe("normalize", () => {
    it("lowercases text", () => {
      expect(validator.normalize("Hello WORLD")).toBe("hello world");
    });

    it("strips punctuation", () => {
      expect(validator.normalize("Hello, world! How's it going?")).toBe(
        "hello world hows it going",
      );
    });

    it("collapses whitespace", () => {
      expect(validator.normalize("hello   world\t\nfoo")).toBe(
        "hello world foo",
      );
    });

    it("trims leading and trailing whitespace", () => {
      expect(validator.normalize("  hello world  ")).toBe("hello world");
    });

    it("handles empty string", () => {
      expect(validator.normalize("")).toBe("");
    });

    it("handles string with only punctuation", () => {
      expect(validator.normalize("!@#$%^&*()")).toBe("");
    });
  });

  // ── tokenize ──────────────────────────────────────────────────────────────

  describe("tokenize", () => {
    it("splits normalized text into tokens", () => {
      expect(validator.tokenize("Hello, World! How are you?")).toEqual([
        "hello",
        "world",
        "how",
        "are",
        "you",
      ]);
    });

    it("returns empty array for empty string", () => {
      expect(validator.tokenize("")).toEqual([]);
    });

    it("returns empty array for punctuation-only string", () => {
      expect(validator.tokenize("!!!")).toEqual([]);
    });

    it("handles numbers in text", () => {
      expect(validator.tokenize("I have 3 cats and 2 dogs")).toEqual([
        "i",
        "have",
        "3",
        "cats",
        "and",
        "2",
        "dogs",
      ]);
    });
  });

  // ── findContiguousMatch ───────────────────────────────────────────────────

  describe("findContiguousMatch", () => {
    const transcriptTokens = [
      "today",
      "i",
      "want",
      "to",
      "talk",
      "about",
      "the",
      "importance",
      "of",
      "public",
      "speaking",
      "in",
      "our",
      "daily",
      "lives",
    ];

    it("finds a contiguous match of 6+ tokens", () => {
      const quoteTokens = [
        "talk",
        "about",
        "the",
        "importance",
        "of",
        "public",
      ];
      const result = validator.findContiguousMatch(
        quoteTokens,
        transcriptTokens,
      );
      expect(result.found).toBe(true);
      expect(result.matchIndex).toBe(4); // "talk" is at index 4
    });

    it("returns not found when quote has fewer than 6 tokens", () => {
      const quoteTokens = ["talk", "about", "the"];
      const result = validator.findContiguousMatch(
        quoteTokens,
        transcriptTokens,
      );
      expect(result.found).toBe(false);
      expect(result.matchIndex).toBe(-1);
    });

    it("returns not found when tokens are not contiguous", () => {
      const quoteTokens = [
        "today",
        "talk",
        "importance",
        "public",
        "daily",
        "lives",
      ];
      const result = validator.findContiguousMatch(
        quoteTokens,
        transcriptTokens,
      );
      expect(result.found).toBe(false);
    });

    it("finds match at the beginning of transcript", () => {
      const quoteTokens = [
        "today",
        "i",
        "want",
        "to",
        "talk",
        "about",
      ];
      const result = validator.findContiguousMatch(
        quoteTokens,
        transcriptTokens,
      );
      expect(result.found).toBe(true);
      expect(result.matchIndex).toBe(0);
    });

    it("finds match at the end of transcript", () => {
      const quoteTokens = [
        "public",
        "speaking",
        "in",
        "our",
        "daily",
        "lives",
      ];
      const result = validator.findContiguousMatch(
        quoteTokens,
        transcriptTokens,
      );
      expect(result.found).toBe(true);
      expect(result.matchIndex).toBe(9);
    });
  });

  // ── checkTimestampLocality ────────────────────────────────────────────────

  describe("checkTimestampLocality", () => {
    it("passes with word-level timestamps within ±20s", () => {
      const segments = [
        makeSegment("today i want to talk about the importance", 0, 10, [
          { word: "today", startTime: 0, endTime: 0.5 },
          { word: "i", startTime: 0.6, endTime: 0.7 },
          { word: "want", startTime: 0.8, endTime: 1.0 },
          { word: "to", startTime: 1.1, endTime: 1.2 },
          { word: "talk", startTime: 1.3, endTime: 1.5 },
          { word: "about", startTime: 1.6, endTime: 1.8 },
          { word: "the", startTime: 1.9, endTime: 2.0 },
          { word: "importance", startTime: 2.1, endTime: 2.5 },
        ]),
      ];
      // matchIndex=4 → "talk" at startTime 1.3s, evidence_timestamp=5 → |5-1.3|=3.7 ≤ 20
      expect(validator.checkTimestampLocality(5, 4, segments)).toBe(true);
    });

    it("fails with word-level timestamps outside ±20s", () => {
      const segments = [
        makeSegment("today i want to talk about the importance", 0, 10, [
          { word: "today", startTime: 0, endTime: 0.5 },
          { word: "i", startTime: 0.6, endTime: 0.7 },
          { word: "want", startTime: 0.8, endTime: 1.0 },
          { word: "to", startTime: 1.1, endTime: 1.2 },
          { word: "talk", startTime: 1.3, endTime: 1.5 },
          { word: "about", startTime: 1.6, endTime: 1.8 },
          { word: "the", startTime: 1.9, endTime: 2.0 },
          { word: "importance", startTime: 2.1, endTime: 2.5 },
        ]),
      ];
      // matchIndex=4 → "talk" at startTime 1.3s, evidence_timestamp=50 → |50-1.3|=48.7 > 20
      expect(validator.checkTimestampLocality(50, 4, segments)).toBe(false);
    });

    it("uses segment-level fallback when no word-level timestamps", () => {
      const segments = [
        makeSegment(
          "today i want to talk about the importance of public speaking",
          0,
          15,
        ),
        makeSegment("in our daily lives and work", 16, 25),
      ];
      // matchIndex=4 → "talk" is in first segment (0-15s)
      // evidence_timestamp=10 → window [−10, 30], segment [0, 15] overlaps → true
      expect(validator.checkTimestampLocality(10, 4, segments)).toBe(true);
    });

    it("fails segment-level fallback when outside ±20s window", () => {
      const segments = [
        makeSegment(
          "today i want to talk about the importance of public speaking",
          0,
          5,
        ),
        makeSegment("in our daily lives and work", 6, 10),
      ];
      // matchIndex=4 → "talk" is in first segment (0-5s)
      // evidence_timestamp=60 → window [40, 80], segment [0, 5] does not overlap → false
      expect(validator.checkTimestampLocality(60, 4, segments)).toBe(false);
    });

    it("passes at exact ±20s boundary (word-level)", () => {
      const segments = [
        makeSegment("a b c d e f g", 0, 10, [
          { word: "a", startTime: 10, endTime: 10.5 },
          { word: "b", startTime: 11, endTime: 11.5 },
          { word: "c", startTime: 12, endTime: 12.5 },
          { word: "d", startTime: 13, endTime: 13.5 },
          { word: "e", startTime: 14, endTime: 14.5 },
          { word: "f", startTime: 15, endTime: 15.5 },
          { word: "g", startTime: 16, endTime: 16.5 },
        ]),
      ];
      // matchIndex=0 → "a" at startTime 10s, evidence_timestamp=30 → |30-10|=20 ≤ 20
      expect(validator.checkTimestampLocality(30, 0, segments)).toBe(true);
    });
  });

  // ── validate (integration) ────────────────────────────────────────────────

  describe("validate", () => {
    const segments: TranscriptSegment[] = [
      makeSegment(
        "Today I want to talk about the importance of public speaking in our daily lives.",
        0,
        15,
        [
          { word: "Today", startTime: 0, endTime: 0.5 },
          { word: "I", startTime: 0.6, endTime: 0.7 },
          { word: "want", startTime: 0.8, endTime: 1.0 },
          { word: "to", startTime: 1.1, endTime: 1.2 },
          { word: "talk", startTime: 1.3, endTime: 1.5 },
          { word: "about", startTime: 1.6, endTime: 1.8 },
          { word: "the", startTime: 1.9, endTime: 2.0 },
          { word: "importance", startTime: 2.1, endTime: 2.5 },
          { word: "of", startTime: 2.6, endTime: 2.7 },
          { word: "public", startTime: 2.8, endTime: 3.0 },
          { word: "speaking", startTime: 3.1, endTime: 3.5 },
          { word: "in", startTime: 3.6, endTime: 3.7 },
          { word: "our", startTime: 3.8, endTime: 3.9 },
          { word: "daily", startTime: 4.0, endTime: 4.3 },
          { word: "lives", startTime: 4.4, endTime: 4.7 },
        ],
      ),
      makeSegment(
        "It helps us connect with others and share our ideas effectively.",
        16,
        30,
        [
          { word: "It", startTime: 16, endTime: 16.2 },
          { word: "helps", startTime: 16.3, endTime: 16.5 },
          { word: "us", startTime: 16.6, endTime: 16.7 },
          { word: "connect", startTime: 16.8, endTime: 17.0 },
          { word: "with", startTime: 17.1, endTime: 17.2 },
          { word: "others", startTime: 17.3, endTime: 17.5 },
          { word: "and", startTime: 17.6, endTime: 17.7 },
          { word: "share", startTime: 17.8, endTime: 18.0 },
          { word: "our", startTime: 18.1, endTime: 18.2 },
          { word: "ideas", startTime: 18.3, endTime: 18.5 },
          { word: "effectively", startTime: 18.6, endTime: 19.0 },
        ],
      ),
    ];

    it("passes for a valid evaluation item", () => {
      const item = makeItem(
        "commendation",
        "talk about the importance of public speaking",
        1,
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("fails when quote is not found in transcript", () => {
      const item = makeItem(
        "commendation",
        "this text does not appear anywhere in the speech at all",
        0,
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]).toContain("not found as contiguous match");
    });

    it("fails when quote has fewer than 6 tokens", () => {
      const item = makeItem("commendation", "talk about the", 0);
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain("fewer than 6 tokens");
    });

    it("fails when quote exceeds 15 tokens", () => {
      const item = makeItem(
        "commendation",
        "Today I want to talk about the importance of public speaking in our daily lives and more extra words",
        0,
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes("15-token limit"))).toBe(
        true,
      );
    });

    it("fails when timestamp is outside ±20s of match", () => {
      const item = makeItem(
        "commendation",
        "talk about the importance of public speaking",
        100, // way off
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain("not within ±20s");
    });

    it("validates multiple items and reports all issues", () => {
      const goodItem = makeItem(
        "commendation",
        "talk about the importance of public speaking",
        1,
      );
      const badItem = makeItem(
        "recommendation",
        "this text is completely fabricated and not in the speech",
        0,
      );
      const evaluation = makeEvaluation([goodItem, badItem]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBe(1);
      expect(result.issues[0]).toContain("[recommendation]");
    });

    it("passes with segment-level fallback (no word timestamps)", () => {
      const segmentsNoWords: TranscriptSegment[] = [
        makeSegment(
          "Today I want to talk about the importance of public speaking in our daily lives.",
          0,
          15,
        ),
        makeSegment(
          "It helps us connect with others and share our ideas effectively.",
          16,
          30,
        ),
      ];
      const item = makeItem(
        "commendation",
        "talk about the importance of public speaking",
        10, // within ±20s of segment [0, 15]
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segmentsNoWords);
      expect(result.valid).toBe(true);
    });

    it("returns valid for an evaluation with no items", () => {
      const evaluation = makeEvaluation([]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("handles punctuation differences between quote and transcript", () => {
      // Quote without punctuation should still match transcript with punctuation
      const item = makeItem(
        "commendation",
        "helps us connect with others and share",
        16,
      );
      const evaluation = makeEvaluation([item]);
      const result = validator.validate(evaluation, segments);
      expect(result.valid).toBe(true);
    });
  });
});
