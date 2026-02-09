import { describe, it, expect } from "vitest";
import { ToneChecker } from "./tone-checker.js";
import type {
  StructuredEvaluation,
  DeliveryMetrics,
  ToneViolation,
} from "./types.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────────

/** Minimal StructuredEvaluation for tests that don't need evaluation context */
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

/** Minimal DeliveryMetrics for tests that don't need metrics context */
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
};

const checker = new ToneChecker();

// ─── check() — Psychological Inference Detection (Req 3.3) ─────────────────────

describe("ToneChecker.check() — psychological inference", () => {
  it("should flag 'you seem nervous'", () => {
    const result = checker.check(
      "You seem nervous during the opening.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe("psychological_inference");
  });

  it("should flag 'you were confident'", () => {
    const result = checker.check(
      "You were confident throughout. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });

  it("should flag 'your anxiety'", () => {
    const result = checker.check(
      "Your anxiety was evident. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });

  it("should flag 'you felt'", () => {
    const result = checker.check(
      "You felt unprepared for the question. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });

  it("should flag 'you were overwhelmed'", () => {
    const result = checker.check(
      "You were overwhelmed by the topic. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });

  it("should be case-insensitive", () => {
    const result = checker.check(
      "YOU SEEM NERVOUS during the speech. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });
});

// ─── check() — Visual Scope Detection (Req 3.4) ────────────────────────────────

describe("ToneChecker.check() — visual scope", () => {
  it("should flag 'eye contact'", () => {
    const result = checker.check(
      "You maintained great eye contact. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'body language'", () => {
    const result = checker.check(
      "Your body language was open and inviting. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'gesture'", () => {
    const result = checker.check(
      "Your gestures were expressive. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'posture'", () => {
    const result = checker.check(
      "Your posture conveyed authority. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'smiled'", () => {
    const result = checker.check(
      "You smiled warmly at the audience. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'your hands'", () => {
    const result = checker.check(
      "Your hands were shaking. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });

  it("should flag 'facial expression'", () => {
    const result = checker.check(
      "Your facial expression showed enthusiasm. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "visual_scope")).toBe(true);
  });
});

// ─── check() — Punitive Language Detection (Req 3.5) ────────────────────────────

describe("ToneChecker.check() — punitive language", () => {
  it("should flag 'you failed to'", () => {
    const result = checker.check(
      "You failed to engage the audience. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });

  it("should flag 'you struggle with'", () => {
    const result = checker.check(
      "You struggle with transitions. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });

  it("should flag 'your weakness'", () => {
    const result = checker.check(
      "Your weakness is pacing. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });

  it("should flag 'poor attempt'", () => {
    const result = checker.check(
      "That was a poor attempt at humor. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });

  it("should flag 'you fell short'", () => {
    const result = checker.check(
      "You fell short of expectations. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });

  it("should flag contractions like \"you couldn't\"", () => {
    const result = checker.check(
      "You couldn't maintain your pace. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "punitive_language")).toBe(true);
  });
});

// ─── check() — Numerical Score Detection (Req 3.6) ─────────────────────────────

describe("ToneChecker.check() — numerical scores", () => {
  it("should flag 'X/10' pattern", () => {
    const result = checker.check(
      "I would give this speech a 7/10.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'X out of 10' pattern", () => {
    const result = checker.check(
      "This was an 8 out of 10 performance.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag percentage pattern", () => {
    const result = checker.check(
      "You achieved 85% effectiveness.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'score of'", () => {
    const result = checker.check(
      "You earned a score of excellent.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'rating of'", () => {
    const result = checker.check(
      "I would give a rating of outstanding.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'grade of'", () => {
    const result = checker.check(
      "This deserves a grade of A.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'rated N' pattern", () => {
    const result = checker.check(
      "Your delivery rated 9 on the scale.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });

  it("should flag 'X / 10' with spaces", () => {
    const result = checker.check(
      "I would rate this 8 / 10.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "numerical_score")).toBe(true);
  });
});

// ─── check() — Ungrounded Claims Detection (Req 3.2) ───────────────────────────

describe("ToneChecker.check() — ungrounded claims", () => {
  it("should flag assertive sentence without marker", () => {
    const result = checker.check(
      "You said something powerful at the start.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "ungrounded_claim")).toBe(true);
  });

  it("should NOT flag assertive sentence WITH [[Q:*]] marker", () => {
    const result = checker.check(
      "You said something powerful at the start. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    // Should not have ungrounded_claim violations
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });

  it("should NOT flag assertive sentence WITH [[M:*]] marker", () => {
    const result = checker.check(
      "You spoke at a steady pace throughout. [[M:wordsPerMinute]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });

  it("should NOT flag non-assertive coaching language", () => {
    const result = checker.check(
      "Next time, consider varying your pace for emphasis.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });

  it("should NOT flag 'you might' suggestions", () => {
    const result = checker.check(
      "You might try using a stronger opening hook.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });

  it("should NOT flag 'perhaps' suggestions", () => {
    const result = checker.check(
      "Perhaps a pause before the conclusion would add impact.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });

  it("should flag 'it sounded like' without marker", () => {
    const result = checker.check(
      "It sounded like you were rushing through the middle section.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "ungrounded_claim")).toBe(true);
  });

  it("should flag 'the audience heard' without marker", () => {
    const result = checker.check(
      "The audience heard a clear message.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "ungrounded_claim")).toBe(true);
  });

  it("should flag unmarked sentence with 'mentioned'", () => {
    const result = checker.check(
      "You mentioned three key points in the body.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "ungrounded_claim")).toBe(true);
  });

  it("should NOT flag a sentence with no assertive verbs and no markers", () => {
    const result = checker.check(
      "Great speech overall.",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    const ungrounded = result.violations.filter((v) => v.category === "ungrounded_claim");
    expect(ungrounded).toHaveLength(0);
  });
});

// ─── check() — Clean Scripts ────────────────────────────────────────────────────

describe("ToneChecker.check() — clean scripts", () => {
  it("should pass a clean script with markers", () => {
    const script =
      "Great speech today. You opened with a compelling story. [[Q:item-0]] " +
      "Your pace was steady throughout. [[M:wordsPerMinute]] " +
      "Next time, consider adding a stronger closing.";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should pass a script with only coaching language", () => {
    const script =
      "Great speech today. You could try varying your pace. " +
      "Perhaps a pause before the conclusion would help. " +
      "One option is to use a rhetorical question.";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ─── check() — Multiple Violations ─────────────────────────────────────────────

describe("ToneChecker.check() — multiple violations", () => {
  it("should detect violations from multiple categories", () => {
    const script =
      "You seem nervous during the opening. " +
      "Your eye contact was poor. " +
      "You failed to engage the audience. " +
      "I give this a 7/10.";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(false);

    const categories = new Set(result.violations.map((v) => v.category));
    expect(categories.has("psychological_inference")).toBe(true);
    expect(categories.has("visual_scope")).toBe(true);
    expect(categories.has("punitive_language")).toBe(true);
    expect(categories.has("numerical_score")).toBe(true);
  });

  it("should report one violation per category per sentence", () => {
    // A sentence with both "you seem" and "your anxiety" — only one psych violation
    const script = "You seem nervous and your anxiety was visible.";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    const psychViolations = result.violations.filter(
      (v) => v.category === "psychological_inference",
    );
    expect(psychViolations).toHaveLength(1);
  });
});

// ─── stripViolations() ──────────────────────────────────────────────────────────

describe("ToneChecker.stripViolations()", () => {
  it("should remove flagged sentences and preserve others", () => {
    const script =
      "Great opening. [[Q:item-0]] You seem nervous. Your pace was good. [[M:wordsPerMinute]]";
    const violations: ToneViolation[] = [
      {
        category: "psychological_inference",
        sentence: "You seem nervous.",
        pattern: "you seem",
        explanation: "test",
      },
    ];
    const result = checker.stripViolations(script, violations);
    expect(result).not.toContain("You seem nervous");
    expect(result).toContain("Great opening.");
    expect(result).toContain("Your pace was good.");
  });

  it("should return the original script when no violations", () => {
    const script = "Great speech. Well done.";
    const result = checker.stripViolations(script, []);
    expect(result).toBe("Great speech. Well done.");
  });

  it("should handle removing multiple sentences", () => {
    const script =
      "Good job. You seem nervous. Your eye contact was poor. Keep it up.";
    const violations: ToneViolation[] = [
      {
        category: "psychological_inference",
        sentence: "You seem nervous.",
        pattern: "you seem",
        explanation: "test",
      },
      {
        category: "visual_scope",
        sentence: "Your eye contact was poor.",
        pattern: "eye contact",
        explanation: "test",
      },
    ];
    const result = checker.stripViolations(script, violations);
    expect(result).toBe("Good job. Keep it up.");
  });

  it("should preserve sentence order after stripping", () => {
    const script = "First. Bad sentence here you seem nervous. Second. Third.";
    const violations: ToneViolation[] = [
      {
        category: "psychological_inference",
        sentence: "Bad sentence here you seem nervous.",
        pattern: "you seem",
        explanation: "test",
      },
    ];
    const result = checker.stripViolations(script, violations);
    expect(result).toBe("First. Second. Third.");
  });
});

// ─── stripMarkers() ─────────────────────────────────────────────────────────────

describe("ToneChecker.stripMarkers()", () => {
  it("should remove [[Q:*]] markers", () => {
    const result = checker.stripMarkers(
      "You opened with a story. [[Q:item-0]] Next sentence.",
    );
    expect(result).toBe("You opened with a story. Next sentence.");
  });

  it("should remove [[M:*]] markers", () => {
    const result = checker.stripMarkers(
      "Your pace was steady. [[M:wordsPerMinute]] Good job.",
    );
    expect(result).toBe("Your pace was steady. Good job.");
  });

  it("should remove multiple markers", () => {
    const result = checker.stripMarkers(
      "Sentence one. [[Q:item-0]] Sentence two. [[M:wordsPerMinute]] Sentence three. [[Q:item-1]]",
    );
    expect(result).toBe("Sentence one. Sentence two. Sentence three.");
  });

  it("should handle adjacent markers on the same sentence", () => {
    const result = checker.stripMarkers(
      "Your pace was steady throughout. [[Q:item-1]][[M:wordsPerMinute]]",
    );
    expect(result).toBe("Your pace was steady throughout.");
  });

  it("should preserve punctuation adjacency", () => {
    const result = checker.stripMarkers(
      "close. [[Q:item-1]] Next",
    );
    expect(result).toBe("close. Next");
  });

  it("should handle script with no markers", () => {
    const result = checker.stripMarkers("No markers here. Just text.");
    expect(result).toBe("No markers here. Just text.");
  });

  it("should handle empty string", () => {
    const result = checker.stripMarkers("");
    expect(result).toBe("");
  });

  it("should handle markers at the very end", () => {
    const result = checker.stripMarkers(
      "Last sentence. [[Q:item-2]]",
    );
    expect(result).toBe("Last sentence.");
  });

  it("should handle markers at the very start", () => {
    const result = checker.stripMarkers(
      "[[Q:item-0]] First sentence.",
    );
    expect(result).toBe("First sentence.");
  });

  it("should normalize multiple spaces to single space after removal", () => {
    const result = checker.stripMarkers(
      "Before.  [[Q:item-0]]  After.",
    );
    expect(result).toBe("Before. After.");
  });
});

// ─── appendScopeAcknowledgment() ────────────────────────────────────────────────

describe("ToneChecker.appendScopeAcknowledgment()", () => {
  it("should append when qualityWarning is true", () => {
    const result = checker.appendScopeAcknowledgment(
      "Great speech.",
      true,
      false,
    );
    expect(result).toContain("based on audio content only");
    expect(result).toBe(
      "Great speech. This evaluation is based on audio content only.",
    );
  });

  it("should append when hasStructureCommentary is true", () => {
    const result = checker.appendScopeAcknowledgment(
      "Great speech.",
      false,
      true,
    );
    expect(result).toContain("based on audio content only");
  });

  it("should append when both conditions are true", () => {
    const result = checker.appendScopeAcknowledgment(
      "Great speech.",
      true,
      true,
    );
    expect(result).toContain("based on audio content only");
  });

  it("should NOT append when both conditions are false", () => {
    const result = checker.appendScopeAcknowledgment(
      "Great speech.",
      false,
      false,
    );
    expect(result).toBe("Great speech.");
  });

  it("should be idempotent — not duplicate if already present", () => {
    const scriptWithAck =
      "Great speech. This evaluation is based on audio content only.";
    const result = checker.appendScopeAcknowledgment(
      scriptWithAck,
      true,
      false,
    );
    expect(result).toBe(scriptWithAck);
    // Count occurrences
    const matches = result.match(/based on audio content only/g);
    expect(matches).toHaveLength(1);
  });

  it("should handle trailing whitespace in input", () => {
    const result = checker.appendScopeAcknowledgment(
      "Great speech.   ",
      true,
      false,
    );
    expect(result).toBe(
      "Great speech. This evaluation is based on audio content only.",
    );
  });
});

// ─── Edge Cases and Integration ─────────────────────────────────────────────────

describe("ToneChecker — edge cases", () => {
  it("should handle empty script", () => {
    const result = checker.check("", STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should not flag partial pattern matches that aren't at word boundaries", () => {
    // "posture" should be flagged, but "composture" is not a word — test word boundary
    const result = checker.check(
      "Your composure was excellent. [[Q:item-0]]",
      STUB_EVALUATION,
      STUB_METRICS,
    );
    // "composure" should NOT match "posture" due to word boundary
    const visualViolations = result.violations.filter(
      (v) => v.category === "visual_scope",
    );
    expect(visualViolations).toHaveLength(0);
  });

  it("should handle a realistic full evaluation script", () => {
    const script =
      "Thank you for that wonderful speech. " +
      "You opened with a compelling personal story about your childhood. [[Q:item-0]] " +
      "Your speaking pace of 145 words per minute was well within the ideal range. [[M:wordsPerMinute]] " +
      "You used the phrase 'imagine a world' to great effect. [[Q:item-1]] " +
      "Next time, you might consider adding a stronger call to action in your closing. " +
      "Overall, a very engaging presentation.";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should detect violation even when sentence has a marker (for non-ungrounded categories)", () => {
    // A sentence can have a marker (grounded) but still violate psychological inference
    const script = "You seem nervous throughout the speech. [[Q:item-0]]";
    const result = checker.check(script, STUB_EVALUATION, STUB_METRICS);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.category === "psychological_inference")).toBe(true);
  });
});
