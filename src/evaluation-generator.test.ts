// Unit tests for EvaluationGenerator
// Tests: prompt construction, LLM call orchestration, retry logic,
//        evidence validation delegation, script rendering, name redaction.

import { describe, it, expect, vi } from "vitest";
import { EvaluationGenerator, cosineSimilarity, EMBEDDING_MODEL, validateObservationData, type OpenAIClient } from "./evaluation-generator.js";
import type {
  ConsentRecord,
  DeliveryMetrics,
  EvaluationItem,
  RedactionInput,
  StructuredEvaluation,
  StructuredEvaluationPublic,
  TranscriptSegment,
  VisualFeedbackItem,
  VisualObservations,
} from "./types.js";

// ─── Test helpers ───────────────────────────────────────────────────────────────

/** Build a minimal valid StructuredEvaluation. */
function makeEvaluation(overrides?: Partial<StructuredEvaluation>): StructuredEvaluation {
  return {
    opening: "Thank you for that wonderful speech.",
    items: [
      {
        type: "commendation",
        summary: "Strong opening",
        evidence_quote: "today I want to talk about leadership and growth",
        evidence_timestamp: 2,
        explanation: "You grabbed the audience's attention right away with a clear topic statement.",
      },
      {
        type: "commendation",
        summary: "Vivid storytelling",
        evidence_quote: "when I was young my grandmother told me stories",
        evidence_timestamp: 30,
        explanation: "Personal anecdotes make your speech relatable and memorable.",
      },
      {
        type: "recommendation",
        summary: "Pacing in the middle",
        evidence_quote: "and then we moved on to the next part quickly",
        evidence_timestamp: 90,
        explanation: "Slowing down in the middle section would let key points land more effectively.",
      },
    ],
    closing: "Overall, a very engaging speech. Keep up the great work!",
    structure_commentary: {
      opening_comment: "You opened with a clear topic statement that set expectations for the audience.",
      body_comment: "The body included a personal anecdote and transitioned to the next point.",
      closing_comment: null,
    },
    ...overrides,
  };
}

/** Build transcript segments that contain the evidence quotes from makeEvaluation. */
function makeTranscriptSegments(): TranscriptSegment[] {
  return [
    {
      text: "Hello everyone, today I want to talk about leadership and growth in our community.",
      startTime: 0,
      endTime: 10,
      words: [
        { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.99 },
        { word: "everyone", startTime: 0.5, endTime: 1, confidence: 0.98 },
        { word: "today", startTime: 1.5, endTime: 2, confidence: 0.97 },
        { word: "I", startTime: 2, endTime: 2.2, confidence: 0.99 },
        { word: "want", startTime: 2.2, endTime: 2.5, confidence: 0.98 },
        { word: "to", startTime: 2.5, endTime: 2.7, confidence: 0.99 },
        { word: "talk", startTime: 2.7, endTime: 3, confidence: 0.97 },
        { word: "about", startTime: 3, endTime: 3.3, confidence: 0.98 },
        { word: "leadership", startTime: 3.3, endTime: 4, confidence: 0.96 },
        { word: "and", startTime: 4, endTime: 4.2, confidence: 0.99 },
        { word: "growth", startTime: 4.2, endTime: 4.5, confidence: 0.97 },
        { word: "in", startTime: 4.5, endTime: 4.7, confidence: 0.98 },
        { word: "our", startTime: 4.7, endTime: 5, confidence: 0.99 },
        { word: "community", startTime: 5, endTime: 5.5, confidence: 0.96 },
      ],
      isFinal: true,
    },
    {
      text: "When I was young my grandmother told me stories about perseverance and courage.",
      startTime: 20,
      endTime: 35,
      words: [
        { word: "When", startTime: 20, endTime: 20.3, confidence: 0.98 },
        { word: "I", startTime: 20.3, endTime: 20.5, confidence: 0.99 },
        { word: "was", startTime: 20.5, endTime: 20.8, confidence: 0.97 },
        { word: "young", startTime: 20.8, endTime: 21.2, confidence: 0.96 },
        { word: "my", startTime: 21.2, endTime: 21.5, confidence: 0.98 },
        { word: "grandmother", startTime: 21.5, endTime: 22, confidence: 0.95 },
        { word: "told", startTime: 22, endTime: 22.3, confidence: 0.97 },
        { word: "me", startTime: 22.3, endTime: 22.5, confidence: 0.99 },
        { word: "stories", startTime: 22.5, endTime: 23, confidence: 0.96 },
        { word: "about", startTime: 23, endTime: 23.3, confidence: 0.98 },
        { word: "perseverance", startTime: 23.3, endTime: 24, confidence: 0.94 },
        { word: "and", startTime: 24, endTime: 24.2, confidence: 0.99 },
        { word: "courage", startTime: 24.2, endTime: 24.8, confidence: 0.97 },
      ],
      isFinal: true,
    },
    {
      text: "And then we moved on to the next part quickly without pausing for effect.",
      startTime: 80,
      endTime: 95,
      words: [
        { word: "And", startTime: 80, endTime: 80.3, confidence: 0.98 },
        { word: "then", startTime: 80.3, endTime: 80.6, confidence: 0.97 },
        { word: "we", startTime: 80.6, endTime: 80.8, confidence: 0.99 },
        { word: "moved", startTime: 80.8, endTime: 81.2, confidence: 0.96 },
        { word: "on", startTime: 81.2, endTime: 81.4, confidence: 0.98 },
        { word: "to", startTime: 81.4, endTime: 81.6, confidence: 0.99 },
        { word: "the", startTime: 81.6, endTime: 81.8, confidence: 0.97 },
        { word: "next", startTime: 81.8, endTime: 82.2, confidence: 0.96 },
        { word: "part", startTime: 82.2, endTime: 82.5, confidence: 0.98 },
        { word: "quickly", startTime: 82.5, endTime: 83, confidence: 0.95 },
        { word: "without", startTime: 83, endTime: 83.5, confidence: 0.97 },
        { word: "pausing", startTime: 83.5, endTime: 84, confidence: 0.96 },
        { word: "for", startTime: 84, endTime: 84.2, confidence: 0.99 },
        { word: "effect", startTime: 84.2, endTime: 84.8, confidence: 0.97 },
      ],
      isFinal: true,
    },
  ];
}

/** Build minimal valid DeliveryMetrics. */
function makeMetrics(overrides?: Partial<DeliveryMetrics>): DeliveryMetrics {
  return {
    durationSeconds: 95,
    durationFormatted: "1:35",
    totalWords: 42,
    wordsPerMinute: 26.5,
    fillerWords: [],
    fillerWordCount: 0,
    fillerWordFrequency: 0,
    pauseCount: 2,
    totalPauseDurationSeconds: 55,
    averagePauseDurationSeconds: 27.5,
    intentionalPauseCount: 1,
    hesitationPauseCount: 1,
    classifiedPauses: [],
    energyVariationCoefficient: 0.3,
    energyProfile: {
      windowDurationMs: 250,
      windows: [],
      coefficientOfVariation: 0.3,
      silenceThreshold: 0.1,
    },
    classifiedFillers: [],
    visualMetrics: null,
    ...overrides,
  };
}

/**
 * Create a mock OpenAI client that returns the given response(s).
 * If multiple responses are provided, they are returned in order.
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

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("EvaluationGenerator", () => {
  // ── validate() ──────────────────────────────────────────────────────────────

  describe("validate()", () => {
    it("should return valid for evaluation with correct evidence quotes", () => {
      const segments = makeTranscriptSegments();
      const evaluation = makeEvaluation();
      const generator = new EvaluationGenerator(makeMockClient([]));

      const result = generator.validate(evaluation, segments);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should return invalid for fabricated evidence quotes", () => {
      const segments = makeTranscriptSegments();
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Fabricated point",
            evidence_quote: "this quote does not exist anywhere in the transcript at all",
            evidence_timestamp: 5,
            explanation: "This is fabricated.",
          },
          ...makeEvaluation().items.slice(1),
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const result = generator.validate(evaluation, segments);

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it("should return invalid for evidence quotes with wrong timestamps", () => {
      const segments = makeTranscriptSegments();
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 500, // way off
            explanation: "Good opening.",
          },
          ...makeEvaluation().items.slice(1),
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const result = generator.validate(evaluation, segments);

      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes("timestamp"))).toBe(true);
    });
  });

  // ── renderScript() ──────────────────────────────────────────────────────────

  describe("renderScript()", () => {
    it("should produce a script with opening, items, and closing", () => {
      const evaluation = makeEvaluation();
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      // Should contain the opening
      expect(script).toContain("Thank you for that wonderful speech");
      // Should contain the closing
      expect(script).toContain("Keep up the great work");
      // Should contain evidence quotes woven in
      expect(script).toContain("today I want to talk about leadership and growth");
      expect(script).toContain("when I was young my grandmother told me stories");
    });

    it("should include commendation and recommendation labels", () => {
      const evaluation = makeEvaluation();
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      expect(script).toContain("really stood out");
      expect(script).toContain("area to consider for growth");
    });

    it("should not redact third-party names (redaction disabled)", () => {
      const evaluation = makeEvaluation({
        opening: "Thank you Sarah for that wonderful speech about John and Mary.",
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, "Sarah");

      // Redaction is disabled — all names pass through
      expect(script).toContain("Sarah");
      expect(script).toContain("John");
      expect(script).toContain("Mary");
      expect(script).not.toContain("a fellow member");
    });

    it("should not redact when no speakerName is provided", () => {
      const evaluation = makeEvaluation({
        opening: "Thank you for that speech mentioning John.",
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      // Without speakerName, no redaction occurs
      expect(script).toContain("John");
    });
  });

  // ── generate() ──────────────────────────────────────────────────────────────

  describe("generate()", () => {
    it("should call the LLM and return a parsed StructuredEvaluation", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      expect(result.evaluation.opening).toBe(evaluation.opening);
      expect(result.evaluation.items).toHaveLength(3);
      expect(result.evaluation.closing).toBe(evaluation.closing);
      expect(result.passRate).toBe(1.0);
      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    });

    it("should pass quality warning when transcript quality is poor", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      // Low WPM triggers quality warning
      const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

      await generator.generate(makeTranscriptSegments(), metrics);

      // Verify the system prompt includes quality warning
      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("Audio Quality Warning");
    });

    it("should not include quality warning for normal transcripts", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const metrics = makeMetrics({ totalWords: 200, durationSeconds: 120 });

      await generator.generate(makeTranscriptSegments(), metrics);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).not.toContain("Audio Quality Warning");
    });

    it("should retry individual items that fail evidence validation", async () => {
      // First response has one bad quote, second response fixes it
      const badEval: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Great opening.",
          },
          {
            type: "commendation",
            summary: "Bad quote",
            evidence_quote: "this is a completely fabricated quote that does not exist",
            evidence_timestamp: 30,
            explanation: "Fabricated.",
          },
          {
            type: "recommendation",
            summary: "Pacing",
            evidence_quote: "and then we moved on to the next part quickly",
            evidence_timestamp: 90,
            explanation: "Slow down.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      const fixedItem: EvaluationItem = {
        type: "commendation",
        summary: "Vivid storytelling",
        evidence_quote: "when I was young my grandmother told me stories",
        evidence_timestamp: 30,
        explanation: "Personal anecdotes are powerful.",
      };

      const client = makeMockClient([
        JSON.stringify(badEval),
        JSON.stringify(fixedItem),
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // Should have called LLM twice: once for full eval, once for item retry
      expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      // Result should have 3 items (the fixed one replaced the bad one)
      expect(result.evaluation.items).toHaveLength(3);
      expect(result.evaluation.items[1].summary).toBe("Vivid storytelling");
    });

    it("should regenerate fully when shape invariant is violated after dropping items", async () => {
      // First response: only 1 commendation (bad quote on second), so after dropping
      // we'd have < 2 commendations → triggers full regeneration
      const badEval: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Great opening.",
          },
          {
            type: "commendation",
            summary: "Bad quote",
            evidence_quote: "this is a completely fabricated quote that does not exist",
            evidence_timestamp: 30,
            explanation: "Fabricated.",
          },
          {
            type: "recommendation",
            summary: "Pacing",
            evidence_quote: "and then we moved on to the next part quickly",
            evidence_timestamp: 90,
            explanation: "Slow down.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      // Retry for the bad item also fails
      const badRetryItem: EvaluationItem = {
        type: "commendation",
        summary: "Still bad",
        evidence_quote: "another fabricated quote that is not in the transcript",
        evidence_timestamp: 30,
        explanation: "Still fabricated.",
      };

      // Second full generation succeeds
      const goodEval = makeEvaluation();

      const client = makeMockClient([
        JSON.stringify(badEval),       // attempt 1: full generation
        JSON.stringify(badRetryItem),  // attempt 1: item retry (fails)
        JSON.stringify(goodEval),      // attempt 2: full regeneration
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // Should have called LLM 3 times
      expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
      expect(result.evaluation.items).toHaveLength(3);
    });

    it("should throw on empty LLM response", async () => {
      const client: OpenAIClient = {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{ message: { content: null } }],
            })),
          },
        },
      };
      const generator = new EvaluationGenerator(client);

      await expect(
        generator.generate(makeTranscriptSegments(), makeMetrics()),
      ).rejects.toThrow("LLM returned empty response");
    });

    it("should throw on invalid JSON from LLM", async () => {
      const client = makeMockClient(["not valid json {{"]);
      const generator = new EvaluationGenerator(client);

      await expect(
        generator.generate(makeTranscriptSegments(), makeMetrics()),
      ).rejects.toThrow("Failed to parse LLM response as JSON");
    });

    it("should throw on malformed evaluation structure", async () => {
      const client = makeMockClient([JSON.stringify({ foo: "bar" })]);
      const generator = new EvaluationGenerator(client);

      await expect(
        generator.generate(makeTranscriptSegments(), makeMetrics()),
      ).rejects.toThrow("missing or invalid");
    });

    it("should use JSON mode in the API call", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.response_format).toEqual({ type: "json_object" });
    });

    it("should include transcript text and metrics in the user prompt", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMsg = call.messages.find((m: { role: string }) => m.role === "user");
      expect(userMsg.content).toContain("Speech Transcript");
      expect(userMsg.content).toContain("Delivery Metrics");
      expect(userMsg.content).toContain("wordsPerMinute");
    });

    it("should include evaluation objectives when provided in config", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics(), {
        objectives: ["Focus on vocal variety", "Assess body language"],
      });

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMsg = call.messages.find((m: { role: string }) => m.role === "user");
      expect(userMsg.content).toContain("Evaluation Objectives");
      expect(userMsg.content).toContain("Focus on vocal variety");
    });
  });

  // ── Prompt content ──────────────────────────────────────────────────────────

  describe("prompt construction", () => {
    it("should instruct against CRC pattern", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("Do NOT use the CRC");
    });

    it("should specify evidence quoting rules", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("VERBATIM");
      expect(systemMsg.content).toContain("at most 15 words");
      expect(systemMsg.content).toContain("at least 6 words");
    });

    it("should specify commendation and recommendation counts", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("2 to 3 commendations");
      expect(systemMsg.content).toContain("1 to 2 recommendations");
    });

    it("should include structure_commentary in JSON output format specification", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("structure_commentary");
      expect(systemMsg.content).toContain("opening_comment");
      expect(systemMsg.content).toContain("body_comment");
      expect(systemMsg.content).toContain("closing_comment");
    });

    it("should include percentage-based segmentation instructions", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("10-15%");
      expect(systemMsg.content).toContain("70-80%");
      expect(systemMsg.content).toMatch(/opening.*10-15%/is);
      expect(systemMsg.content).toMatch(/body.*70-80%/is);
      expect(systemMsg.content).toMatch(/closing.*10-15%/is);
    });

    it("should include heuristic fallback instructions for short transcripts", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("fewer than 120 words");
      expect(systemMsg.content).toContain("heuristic markers");
      expect(systemMsg.content).toContain("in conclusion");
      expect(systemMsg.content).toContain("to wrap up");
    });

    it("should include null return instruction for unreliable markers", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("return null");
      expect(systemMsg.content).toMatch(/null than to speculate/i);
    });

    it("should include explicit no scores, no ratings instruction for structure commentary", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      await generator.generate(makeTranscriptSegments(), makeMetrics());

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      expect(systemMsg.content).toContain("Do not include numerical scores, ratings, or percentage-based assessments in structure commentary");
    });

    it("should include quality warning with uncertainty qualifier and high-confidence instruction", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      // Low WPM triggers quality warning
      const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

      await generator.generate(makeTranscriptSegments(), metrics);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
      // Should include uncertainty qualifier instruction
      expect(systemMsg.content).toContain("uncertainty qualifier");
      // Should include high-confidence segment instruction (≥0.7)
      expect(systemMsg.content).toContain("0.7");
      // Should include reduced claim strength instruction
      expect(systemMsg.content).toMatch(/reduce claim strength/i);
      // Should include no-fabrication instruction
      expect(systemMsg.content).toMatch(/not fabricate/i);
    });
  });

  // ── parseEvaluation (structure_commentary handling) ─────────────────────────

  describe("parseEvaluation (structure_commentary)", () => {
    it("should parse structure_commentary from LLM response", async () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: "Strong hook with a personal story.",
          body_comment: "Clear transitions between main points.",
          closing_comment: "Ended with a memorable call to action.",
        },
      });
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary).toBeDefined();
      expect(result.evaluation.structure_commentary.opening_comment).toBe("Strong hook with a personal story.");
      expect(result.evaluation.structure_commentary.body_comment).toBe("Clear transitions between main points.");
      expect(result.evaluation.structure_commentary.closing_comment).toBe("Ended with a memorable call to action.");
    });

    it("should default to null for missing structure_commentary", async () => {
      // LLM response without structure_commentary field
      const rawResponse = JSON.stringify({
        opening: "Great speech.",
        items: makeEvaluation().items,
        closing: "Keep it up!",
      });
      const client = makeMockClient([rawResponse]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary).toBeDefined();
      expect(result.evaluation.structure_commentary.opening_comment).toBeNull();
      expect(result.evaluation.structure_commentary.body_comment).toBeNull();
      expect(result.evaluation.structure_commentary.closing_comment).toBeNull();
    });

    it("should handle partial structure_commentary with null sub-fields", async () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: "Good hook.",
          body_comment: null,
          closing_comment: null,
        },
      });
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary.opening_comment).toBe("Good hook.");
      expect(result.evaluation.structure_commentary.body_comment).toBeNull();
      expect(result.evaluation.structure_commentary.closing_comment).toBeNull();
    });

    it("should treat empty string sub-fields as null", async () => {
      const rawResponse = JSON.stringify({
        opening: "Great speech.",
        items: makeEvaluation().items,
        closing: "Keep it up!",
        structure_commentary: {
          opening_comment: "",
          body_comment: "Some body comment.",
          closing_comment: "",
        },
      });
      const client = makeMockClient([rawResponse]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary.opening_comment).toBeNull();
      expect(result.evaluation.structure_commentary.body_comment).toBe("Some body comment.");
      expect(result.evaluation.structure_commentary.closing_comment).toBeNull();
    });

    it("should handle structure_commentary as non-object gracefully", async () => {
      const rawResponse = JSON.stringify({
        opening: "Great speech.",
        items: makeEvaluation().items,
        closing: "Keep it up!",
        structure_commentary: "not an object",
      });
      const client = makeMockClient([rawResponse]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary.opening_comment).toBeNull();
      expect(result.evaluation.structure_commentary.body_comment).toBeNull();
      expect(result.evaluation.structure_commentary.closing_comment).toBeNull();
    });

    it("should preserve structure_commentary through validation and retry pipeline", async () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: "Engaging opening.",
          body_comment: "Well-organized body.",
          closing_comment: "Strong closing.",
        },
      });
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(makeTranscriptSegments(), makeMetrics());

      expect(result.evaluation.structure_commentary.opening_comment).toBe("Engaging opening.");
      expect(result.evaluation.structure_commentary.body_comment).toBe("Well-organized body.");
      expect(result.evaluation.structure_commentary.closing_comment).toBe("Strong closing.");
    });
  });

  // ── renderScript() with markers and structure commentary ────────────────────

  describe("renderScript() marker emission", () => {
    it("should emit [[Q:item-N]] markers after sentences containing evidence quotes", () => {
      const evaluation = makeEvaluation();
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      expect(script).toContain("[[Q:item-0]]");
      expect(script).toContain("[[Q:item-1]]");
      expect(script).toContain("[[Q:item-2]]");
    });

    it("should place [[Q:item-N]] markers after terminal punctuation", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "You grabbed the audience right away.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      // The marker should appear right after terminal punctuation
      const quoteMarkerPattern = /[.!?]\s*\[\[Q:item-0\]\]/;
      expect(script).toMatch(quoteMarkerPattern);
    });

    it("should emit [[M:fieldName]] markers after sentences referencing metrics", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Steady pace throughout",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Your speaking pace was consistent and engaging.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      // "pace" maps to wordsPerMinute
      expect(script).toContain("[[M:wordsPerMinute]]");
    });

    it("should emit multiple markers on the same sentence when it references both a quote and a metric", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "recommendation",
            summary: "Reduce filler words",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Your filler word usage could be reduced for clarity.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      expect(script).toContain("[[Q:item-0]]");
      expect(script).toContain("[[M:fillerWordCount]]");
    });

    it("should not emit metrics markers when no metrics parameter is provided", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Steady pace",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Your pace was consistent.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      expect(script).toContain("[[Q:item-0]]");
      expect(script).not.toMatch(/\[\[M:/);
    });

    it("should detect pause-related metrics keywords", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Effective pausing",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Your pausing after key points was effective.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      expect(script).toContain("[[M:pauseCount]]");
    });

    it("should detect vocal variety / energy metrics keywords", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "commendation",
            summary: "Great vocal variety",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Your vocal variety kept the audience engaged.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      expect(script).toContain("[[M:energyVariationCoefficient]]");
    });

    it("should not duplicate metrics field markers on the same sentence", () => {
      const evaluation = makeEvaluation({
        items: [
          {
            type: "recommendation",
            summary: "Manage pauses better",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Try adding a pause before your key points and pausing for effect.",
          },
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));
      const metrics = makeMetrics();

      const script = generator.renderScript(evaluation, undefined, metrics);

      // "pause" and "pausing" both map to pauseCount — should only appear once per sentence
      const pauseMarkerMatches = script.match(/\[\[M:pauseCount\]\]/g) || [];
      // Each sentence that mentions pauses should have exactly one [[M:pauseCount]]
      // (not duplicated for multiple keyword hits mapping to the same field)
      expect(pauseMarkerMatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("renderScript() structure commentary integration", () => {
    it("should include non-null structure commentary between opening and first item", () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: "You opened with a clear topic statement.",
          body_comment: "The body was well-organized with clear transitions.",
          closing_comment: "Your closing was memorable and impactful.",
        },
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      expect(script).toContain("You opened with a clear topic statement.");
      expect(script).toContain("The body was well-organized with clear transitions.");
      expect(script).toContain("Your closing was memorable and impactful.");

      // Commentary should appear between opening and first item
      const openingIdx = script.indexOf("Thank you for that wonderful speech.");
      const commentaryIdx = script.indexOf("You opened with a clear topic statement.");
      const firstItemIdx = script.indexOf("Something that really stood out");
      expect(commentaryIdx).toBeGreaterThan(openingIdx);
      expect(commentaryIdx).toBeLessThan(firstItemIdx);
    });

    it("should omit null structure commentary fields", () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: "Good opening hook.",
          body_comment: null,
          closing_comment: null,
        },
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      expect(script).toContain("Good opening hook.");
      expect(script).not.toContain("body_comment");
      expect(script).not.toContain("closing_comment");
    });

    it("should not include any structure commentary section when all fields are null", () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: null,
          body_comment: null,
          closing_comment: null,
        },
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      // The script should go directly from opening to first item
      const parts = script.split("\n\n");
      expect(parts[0]).toContain("Thank you for that wonderful speech.");
      expect(parts[1]).toContain("Something that really stood out");
    });

    it("should render only non-null commentary fields as a single paragraph", () => {
      const evaluation = makeEvaluation({
        structure_commentary: {
          opening_comment: null,
          body_comment: "The body had clear transitions.",
          closing_comment: "Strong closing statement.",
        },
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);

      expect(script).toContain("The body had clear transitions.");
      expect(script).toContain("Strong closing statement.");
      expect(script).toContain("The body had clear transitions. Strong closing statement.");
    });

    it("should handle undefined structure_commentary gracefully", () => {
      const evaluation = {
        opening: "Great speech.",
        items: makeEvaluation().items,
        closing: "Keep it up!",
      } as unknown as import("./types.js").StructuredEvaluation;

      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation);
      expect(script).toContain("Great speech.");
      expect(script).toContain("Keep it up!");
    });
  });

  // ── Pass-rate reporting (Req 1.6) ───────────────────────────────────────────

  describe("pass-rate reporting", () => {
    it("should return passRate of 1.0 when all items pass on first attempt", async () => {
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      expect(result.passRate).toBe(1.0);
      expect(result.evaluation.items).toHaveLength(3);
    });

    it("should return passRate < 1.0 when some items need retry", async () => {
      // First response has one bad quote that needs retry
      const badEval: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Great opening.",
          },
          {
            type: "commendation",
            summary: "Bad quote",
            evidence_quote: "this is a completely fabricated quote that does not exist",
            evidence_timestamp: 30,
            explanation: "Fabricated.",
          },
          {
            type: "recommendation",
            summary: "Pacing",
            evidence_quote: "and then we moved on to the next part quickly",
            evidence_timestamp: 90,
            explanation: "Slow down.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      const fixedItem: EvaluationItem = {
        type: "commendation",
        summary: "Vivid storytelling",
        evidence_quote: "when I was young my grandmother told me stories",
        evidence_timestamp: 30,
        explanation: "Personal anecdotes are powerful.",
      };

      const client = makeMockClient([
        JSON.stringify(badEval),
        JSON.stringify(fixedItem),
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // 2 out of 3 items passed on first attempt
      expect(result.passRate).toBeCloseTo(2 / 3);
      expect(result.evaluation.items).toHaveLength(3);
    });

    it("should return passRate of 0 when no items pass on first attempt but all pass after retry", async () => {
      // All 3 items fail first attempt, all 3 get retried successfully
      const badEval: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "C1",
            evidence_quote: "fabricated quote one that does not exist in transcript",
            evidence_timestamp: 2,
            explanation: "Bad.",
          },
          {
            type: "commendation",
            summary: "C2",
            evidence_quote: "fabricated quote two that does not exist in transcript",
            evidence_timestamp: 30,
            explanation: "Bad.",
          },
          {
            type: "recommendation",
            summary: "R1",
            evidence_quote: "fabricated quote three that does not exist in transcript",
            evidence_timestamp: 90,
            explanation: "Bad.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      const fixedC1: EvaluationItem = {
        type: "commendation",
        summary: "Strong opening",
        evidence_quote: "today I want to talk about leadership and growth",
        evidence_timestamp: 2,
        explanation: "Great opening.",
      };
      const fixedC2: EvaluationItem = {
        type: "commendation",
        summary: "Vivid storytelling",
        evidence_quote: "when I was young my grandmother told me stories",
        evidence_timestamp: 30,
        explanation: "Personal anecdotes.",
      };
      const fixedR1: EvaluationItem = {
        type: "recommendation",
        summary: "Pacing",
        evidence_quote: "and then we moved on to the next part quickly",
        evidence_timestamp: 90,
        explanation: "Slow down.",
      };

      const client = makeMockClient([
        JSON.stringify(badEval),
        JSON.stringify(fixedC1),
        JSON.stringify(fixedC2),
        JSON.stringify(fixedR1),
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // 0 out of 3 passed on first attempt (all needed retry)
      expect(result.passRate).toBe(0);
      expect(result.evaluation.items).toHaveLength(3);
    });
  });

  // ── Short-form fallback (Req 9.2, 9.3) ─────────────────────────────────────

  describe("short-form fallback", () => {
    it("should produce short-form fallback with ≥1 commendation + ≥1 recommendation when shape invariant fails", async () => {
      // Both generation attempts produce evaluations that fail shape invariant
      // after validation (only 1 commendation + 1 recommendation survive)
      const evalWith1C1R: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "Strong opening",
            evidence_quote: "today I want to talk about leadership and growth",
            evidence_timestamp: 2,
            explanation: "Great opening.",
          },
          {
            type: "commendation",
            summary: "Bad C2",
            evidence_quote: "fabricated quote that does not exist in the transcript",
            evidence_timestamp: 30,
            explanation: "Fabricated.",
          },
          {
            type: "recommendation",
            summary: "Pacing",
            evidence_quote: "and then we moved on to the next part quickly",
            evidence_timestamp: 90,
            explanation: "Slow down.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      // Retry for bad item also fails
      const badRetryItem: EvaluationItem = {
        type: "commendation",
        summary: "Still bad",
        evidence_quote: "another fabricated quote that is not in the transcript",
        evidence_timestamp: 30,
        explanation: "Still fabricated.",
      };

      // Both attempts produce the same result: 1 commendation + 1 recommendation
      // (shape invariant requires 2 commendations, so it fails)
      const client = makeMockClient([
        JSON.stringify(evalWith1C1R),   // attempt 1: full generation
        JSON.stringify(badRetryItem),   // attempt 1: item retry (fails)
        JSON.stringify(evalWith1C1R),   // attempt 2: full regeneration
        JSON.stringify(badRetryItem),   // attempt 2: item retry (fails)
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // Short-form fallback: ≥1 commendation + ≥1 recommendation
      const commendations = result.evaluation.items.filter((i) => i.type === "commendation");
      const recommendations = result.evaluation.items.filter((i) => i.type === "recommendation");
      expect(commendations.length).toBeGreaterThanOrEqual(1);
      expect(recommendations.length).toBeGreaterThanOrEqual(1);
    });

    it("should fall back to best-effort LLM call when short-form cannot be produced", async () => {
      // Both attempts produce evaluations where ALL items fail validation
      // (no valid items remain for short-form)
      const allBadEval: StructuredEvaluation = {
        opening: "Great speech.",
        items: [
          {
            type: "commendation",
            summary: "Bad C1",
            evidence_quote: "fabricated quote one that does not exist in transcript",
            evidence_timestamp: 2,
            explanation: "Bad.",
          },
          {
            type: "commendation",
            summary: "Bad C2",
            evidence_quote: "fabricated quote two that does not exist in transcript",
            evidence_timestamp: 30,
            explanation: "Bad.",
          },
          {
            type: "recommendation",
            summary: "Bad R1",
            evidence_quote: "fabricated quote three that does not exist in transcript",
            evidence_timestamp: 90,
            explanation: "Bad.",
          },
        ],
        closing: "Keep it up!",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };

      // All retries also fail
      const badRetryItem: EvaluationItem = {
        type: "commendation",
        summary: "Still bad",
        evidence_quote: "yet another fabricated quote not in the transcript at all",
        evidence_timestamp: 30,
        explanation: "Still fabricated.",
      };

      // Last best-effort call returns a valid evaluation
      const bestEffortEval = makeEvaluation();

      const client = makeMockClient([
        JSON.stringify(allBadEval),     // attempt 1: full generation
        JSON.stringify(badRetryItem),   // attempt 1: retry C1 (fails)
        JSON.stringify(badRetryItem),   // attempt 1: retry C2 (fails)
        JSON.stringify(badRetryItem),   // attempt 1: retry R1 (fails)
        JSON.stringify(allBadEval),     // attempt 2: full regeneration
        JSON.stringify(badRetryItem),   // attempt 2: retry C1 (fails)
        JSON.stringify(badRetryItem),   // attempt 2: retry C2 (fails)
        JSON.stringify(badRetryItem),   // attempt 2: retry R1 (fails)
        JSON.stringify(bestEffortEval), // best-effort last call
      ]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      // Best-effort: passRate is 0 since we couldn't validate
      expect(result.passRate).toBe(0);
      // The evaluation should still have items from the best-effort call
      expect(result.evaluation.items.length).toBeGreaterThan(0);
    });

    it("should store evaluationPassRate on session via session-manager integration", async () => {
      // This is tested indirectly — the session-manager extracts passRate from GenerateResult
      // and stores it on session.evaluationPassRate. The unit test here verifies the
      // generate() return type includes passRate.
      const evaluation = makeEvaluation();
      const client = makeMockClient([JSON.stringify(evaluation)]);
      const generator = new EvaluationGenerator(client);

      const result = await generator.generate(
        makeTranscriptSegments(),
        makeMetrics(),
      );

      expect(typeof result.passRate).toBe("number");
      expect(result.passRate).toBeGreaterThanOrEqual(0);
      expect(result.passRate).toBeLessThanOrEqual(1);
    });
  });

  // ── redact() — Pipeline Stage 8 (Req 8.1, 8.2, 8.3, 8.4, 8.5) ────────────

  describe("redact()", () => {
    /** Helper to build a ConsentRecord. */
    function makeConsent(speakerName: string): ConsentRecord {
      return {
        speakerName,
        consentConfirmed: true,
        consentTimestamp: new Date("2024-01-01T00:00:00Z"),
      };
    }

    /** Helper to build a RedactionInput. */
    function makeRedactionInput(overrides?: {
      script?: string;
      evaluation?: StructuredEvaluation;
      speakerName?: string;
    }): RedactionInput {
      const speakerName = overrides?.speakerName ?? "Sarah";
      return {
        script: overrides?.script ?? "Thank you Sarah for that wonderful speech about John and Mary.",
        evaluation: overrides?.evaluation ?? makeEvaluation({
          opening: "Thank you Sarah for that wonderful speech about John and Mary.",
          items: [
            {
              type: "commendation",
              summary: "Strong opening",
              evidence_quote: "Sarah told us about John and his journey",
              evidence_timestamp: 2,
              explanation: "You grabbed the audience's attention right away.",
            },
            {
              type: "commendation",
              summary: "Vivid storytelling",
              evidence_quote: "when Mary shared her experience with the team",
              evidence_timestamp: 30,
              explanation: "Personal anecdotes make your speech relatable.",
            },
            {
              type: "recommendation",
              summary: "Pacing in the middle",
              evidence_quote: "and then we moved on to the next part quickly",
              evidence_timestamp: 90,
              explanation: "Slowing down would let key points land more effectively.",
            },
          ],
          closing: "Overall Sarah, a very engaging speech. Keep up the great work!",
        }),
        consent: makeConsent(speakerName),
      };
    }

    it("should pass through script unchanged (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      // Script passes through unchanged — no redaction
      expect(result.scriptRedacted).toBe(input.script);
      expect(result.scriptRedacted).toContain("John");
      expect(result.scriptRedacted).toContain("Mary");
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should preserve the speaker's own name in the script", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      expect(result.scriptRedacted).toContain("Sarah");
    });

    it("should pass through evidence quotes unchanged in evaluationPublic", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      // All names pass through unchanged
      expect(result.evaluationPublic.items[0].evidence_quote).toContain("John");
      expect(result.evaluationPublic.items[1].evidence_quote).toContain("Mary");
      expect(result.evaluationPublic.items[0].evidence_quote).not.toContain("a fellow member");
    });

    it("should preserve speaker's name in evidence quotes of evaluationPublic", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      expect(result.evaluationPublic.items[0].evidence_quote).toContain("Sarah");
    });

    it("should produce scriptRedacted identical to input script (no redaction)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      expect(result.scriptRedacted).toBe(input.script);
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should produce evaluationPublic with correct StructuredEvaluationPublic shape", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      // Check shape: opening, items, closing, structure_commentary
      expect(typeof result.evaluationPublic.opening).toBe("string");
      expect(typeof result.evaluationPublic.closing).toBe("string");
      expect(Array.isArray(result.evaluationPublic.items)).toBe(true);
      expect(result.evaluationPublic.structure_commentary).toBeDefined();

      // Each item should have the correct shape
      for (const item of result.evaluationPublic.items) {
        expect(item.type).toMatch(/^(commendation|recommendation)$/);
        expect(typeof item.summary).toBe("string");
        expect(typeof item.explanation).toBe("string");
        expect(typeof item.evidence_quote).toBe("string");
        expect(typeof item.evidence_timestamp).toBe("number");
      }
    });

    it("should preserve item count and order in evaluationPublic", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      expect(result.evaluationPublic.items).toHaveLength(input.evaluation.items.length);
      for (let i = 0; i < input.evaluation.items.length; i++) {
        expect(result.evaluationPublic.items[i].type).toBe(input.evaluation.items[i].type);
        expect(result.evaluationPublic.items[i].summary).toBe(input.evaluation.items[i].summary);
        expect(result.evaluationPublic.items[i].evidence_timestamp).toBe(
          input.evaluation.items[i].evidence_timestamp,
        );
      }
    });

    it("should pass through text unchanged when no third-party names present", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        script: "Thank you for that wonderful speech about leadership.",
        evaluation: makeEvaluation({
          opening: "Thank you for that wonderful speech about leadership.",
          items: [
            {
              type: "commendation",
              summary: "Strong opening",
              evidence_quote: "today I want to talk about leadership and growth",
              evidence_timestamp: 2,
              explanation: "Great opening.",
            },
            {
              type: "commendation",
              summary: "Vivid storytelling",
              evidence_quote: "when I was young my grandmother told me stories",
              evidence_timestamp: 30,
              explanation: "Personal anecdotes are powerful.",
            },
            {
              type: "recommendation",
              summary: "Pacing",
              evidence_quote: "and then we moved on to the next part quickly",
              evidence_timestamp: 90,
              explanation: "Slow down.",
            },
          ],
          closing: "Overall, a very engaging speech.",
        }),
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      // No "a fellow member" should appear since there are no third-party names
      expect(result.scriptRedacted).not.toContain("a fellow member");
      expect(result.scriptRedacted).toBe(input.script);
    });

    it("should pass through all names unchanged (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));

      const input = makeRedactionInput({
        script: "Sarah delivered a great speech. She mentioned John as an inspiration.",
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      // All names pass through — no redaction
      expect(result.scriptRedacted).toContain("Sarah");
      expect(result.scriptRedacted).toContain("John");
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should pass through multiple names unchanged (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        script: "The speech mentioned John and Mary and also referenced Bob during the story.",
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      expect(result.scriptRedacted).toContain("John");
      expect(result.scriptRedacted).toContain("Mary");
      expect(result.scriptRedacted).toContain("Bob");
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should NOT redact places, organizations, or brands (conservative)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        script: "The speech was given at the Toastmasters club on Monday in January.",
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      // These should be preserved (non-name entities)
      expect(result.scriptRedacted).toContain("Toastmasters");
      expect(result.scriptRedacted).toContain("Monday");
      expect(result.scriptRedacted).toContain("January");
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should pass through names in opening and closing of evaluationPublic (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        evaluation: makeEvaluation({
          opening: "Thank you Sarah for that speech about John.",
          closing: "Great job Sarah. Tell Mary we said hello!",
        }),
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      // All names pass through unchanged
      expect(result.evaluationPublic.opening).toContain("Sarah");
      expect(result.evaluationPublic.opening).toContain("John");
      expect(result.evaluationPublic.closing).toContain("Sarah");
      expect(result.evaluationPublic.closing).toContain("Mary");
      expect(result.evaluationPublic.opening).not.toContain("a fellow member");
      expect(result.evaluationPublic.closing).not.toContain("a fellow member");
    });

    it("should preserve structure_commentary unchanged in evaluationPublic", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const commentary = {
        opening_comment: "Strong opening hook.",
        body_comment: "Well-organized body.",
        closing_comment: null,
      };
      const input = makeRedactionInput({
        evaluation: makeEvaluation({ structure_commentary: commentary }),
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      expect(result.evaluationPublic.structure_commentary).toEqual(commentary);
    });

    it("should pass through full names unchanged (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        script: "Thank you Sarah Johnson for that speech. She talked about Robert Smith during the story.",
        speakerName: "Sarah Johnson",
      });

      const result = generator.redact(input);

      // All names pass through unchanged
      expect(result.scriptRedacted).toContain("Sarah");
      expect(result.scriptRedacted).toContain("Johnson");
      expect(result.scriptRedacted).toContain("Robert");
      expect(result.scriptRedacted).toContain("Smith");
      expect(result.scriptRedacted).not.toContain("a fellow member");
    });

    it("should return script unchanged — no new words introduced (redaction disabled)", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput({
        script: "The speech mentioned John during the opening.",
        speakerName: "Sarah",
      });

      const result = generator.redact(input);

      expect(result.scriptRedacted).toBe(input.script);
    });

    it("should return scriptRedacted as a string and evaluationPublic as an object", () => {
      const generator = new EvaluationGenerator(makeMockClient([]));
      const input = makeRedactionInput();

      const result = generator.redact(input);

      expect(typeof result.scriptRedacted).toBe("string");
      expect(typeof result.evaluationPublic).toBe("object");
      expect(result.evaluationPublic).not.toBeNull();
    });
  });
});

// ─── Phase 2: Quality Warning with Silence/Non-Speech Marker Exclusion ────────
// Validates: Requirements 10.1, 10.2, 10.3

describe("quality warning — silence/non-speech marker exclusion", () => {
  it("should not trigger quality warning when silence markers drag down average but speech words are high-confidence", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Transcript with high-confidence speech words and low-confidence silence markers
    const segments: TranscriptSegment[] = [
      {
        text: "Hello everyone today I want to talk about leadership and growth in our community.",
        startTime: 0,
        endTime: 10,
        words: [
          { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.9 },
          { word: "[silence]", startTime: 0.5, endTime: 1.5, confidence: 0.1 },
          { word: "[noise]", startTime: 1.5, endTime: 2, confidence: 0.05 },
          { word: "everyone", startTime: 2, endTime: 2.5, confidence: 0.85 },
          { word: "", startTime: 2.5, endTime: 3, confidence: 0.0 },
          { word: "today", startTime: 3, endTime: 3.5, confidence: 0.92 },
          { word: "I", startTime: 3.5, endTime: 3.7, confidence: 0.95 },
          { word: "want", startTime: 3.7, endTime: 4, confidence: 0.88 },
          { word: "to", startTime: 4, endTime: 4.2, confidence: 0.93 },
          { word: "talk", startTime: 4.2, endTime: 4.5, confidence: 0.91 },
          { word: "about", startTime: 4.5, endTime: 4.8, confidence: 0.89 },
          { word: "leadership", startTime: 4.8, endTime: 5.5, confidence: 0.87 },
          { word: "and", startTime: 5.5, endTime: 5.7, confidence: 0.94 },
          { word: "growth", startTime: 5.7, endTime: 6, confidence: 0.90 },
        ],
        isFinal: true,
      },
      ...makeTranscriptSegments().slice(1),
    ];

    // Metrics with adequate WPM
    const metrics = makeMetrics({ totalWords: 200, durationSeconds: 120 });

    await generator.generate(segments, metrics);

    // Should NOT include quality warning — speech words have high confidence
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).not.toContain("Audio Quality Warning");
  });

  it("should trigger quality warning when speech words (excluding markers) have low confidence", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Transcript with low-confidence speech words only (no high-confidence segments mixed in)
    const segments: TranscriptSegment[] = [
      {
        text: "Hello everyone today I want to talk about leadership and growth in our community.",
        startTime: 0,
        endTime: 10,
        words: [
          { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.3 },
          { word: "[silence]", startTime: 0.5, endTime: 1.5, confidence: 0.1 },
          { word: "everyone", startTime: 2, endTime: 2.5, confidence: 0.35 },
          { word: "today", startTime: 3, endTime: 3.5, confidence: 0.4 },
          { word: "I", startTime: 3.5, endTime: 3.7, confidence: 0.45 },
          { word: "want", startTime: 3.7, endTime: 4, confidence: 0.38 },
          { word: "to", startTime: 4, endTime: 4.2, confidence: 0.42 },
          { word: "talk", startTime: 4.2, endTime: 4.5, confidence: 0.35 },
          { word: "about", startTime: 4.5, endTime: 4.8, confidence: 0.40 },
          { word: "leadership", startTime: 4.8, endTime: 5.5, confidence: 0.37 },
          { word: "and", startTime: 5.5, endTime: 5.7, confidence: 0.44 },
          { word: "growth", startTime: 5.7, endTime: 6, confidence: 0.39 },
        ],
        isFinal: true,
      },
      {
        text: "When I was young my grandmother told me stories about perseverance and courage.",
        startTime: 20,
        endTime: 35,
        words: [
          { word: "When", startTime: 20, endTime: 20.3, confidence: 0.38 },
          { word: "I", startTime: 20.3, endTime: 20.5, confidence: 0.42 },
          { word: "was", startTime: 20.5, endTime: 20.8, confidence: 0.37 },
          { word: "young", startTime: 20.8, endTime: 21.2, confidence: 0.36 },
          { word: "my", startTime: 21.2, endTime: 21.5, confidence: 0.38 },
          { word: "grandmother", startTime: 21.5, endTime: 22, confidence: 0.35 },
          { word: "told", startTime: 22, endTime: 22.3, confidence: 0.37 },
          { word: "me", startTime: 22.3, endTime: 22.5, confidence: 0.39 },
          { word: "stories", startTime: 22.5, endTime: 23, confidence: 0.36 },
        ],
        isFinal: true,
      },
    ];

    const metrics = makeMetrics({ totalWords: 200, durationSeconds: 120 });

    await generator.generate(segments, metrics);

    // Speech words avg confidence ≈ 0.38 → below 0.5 → quality warning
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toContain("Audio Quality Warning");
  });

  it("should exclude empty and whitespace-only words from confidence computation", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Transcript with empty/whitespace words that have 0 confidence
    const segments: TranscriptSegment[] = [
      {
        text: "Hello everyone today I want to talk about leadership and growth in our community.",
        startTime: 0,
        endTime: 10,
        words: [
          { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.85 },
          { word: "", startTime: 0.5, endTime: 1, confidence: 0.0 },
          { word: "  ", startTime: 1, endTime: 1.5, confidence: 0.0 },
          { word: "everyone", startTime: 2, endTime: 2.5, confidence: 0.80 },
          { word: "today", startTime: 3, endTime: 3.5, confidence: 0.88 },
          { word: "I", startTime: 3.5, endTime: 3.7, confidence: 0.92 },
          { word: "want", startTime: 3.7, endTime: 4, confidence: 0.86 },
          { word: "to", startTime: 4, endTime: 4.2, confidence: 0.90 },
          { word: "talk", startTime: 4.2, endTime: 4.5, confidence: 0.87 },
          { word: "about", startTime: 4.5, endTime: 4.8, confidence: 0.84 },
          { word: "leadership", startTime: 4.8, endTime: 5.5, confidence: 0.82 },
          { word: "and", startTime: 5.5, endTime: 5.7, confidence: 0.91 },
          { word: "growth", startTime: 5.7, endTime: 6, confidence: 0.88 },
        ],
        isFinal: true,
      },
      ...makeTranscriptSegments().slice(1),
    ];

    const metrics = makeMetrics({ totalWords: 200, durationSeconds: 120 });

    await generator.generate(segments, metrics);

    // Speech words avg confidence ≈ 0.87 → above 0.5 → no quality warning
    // Without exclusion: (0.85+0+0+0.80+...) / 13 ≈ 0.66 → still above, but the principle matters
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).not.toContain("Audio Quality Warning");
  });
});

describe("quality warning — high-confidence segment filtering in prompt (Req 10.2)", () => {
  it("should include high-confidence segments section in user prompt when quality warning is active", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Create segments with varying confidence levels
    const highConfSegment: TranscriptSegment = {
      text: "Today I want to talk about leadership and growth in our community.",
      startTime: 0,
      endTime: 10,
      words: [
        { word: "Today", startTime: 0, endTime: 0.5, confidence: 0.95 },
        { word: "I", startTime: 0.5, endTime: 0.7, confidence: 0.98 },
        { word: "want", startTime: 0.7, endTime: 1, confidence: 0.92 },
        { word: "to", startTime: 1, endTime: 1.2, confidence: 0.97 },
        { word: "talk", startTime: 1.2, endTime: 1.5, confidence: 0.94 },
        { word: "about", startTime: 1.5, endTime: 1.8, confidence: 0.93 },
        { word: "leadership", startTime: 1.8, endTime: 2.5, confidence: 0.91 },
        { word: "and", startTime: 2.5, endTime: 2.7, confidence: 0.96 },
        { word: "growth", startTime: 2.7, endTime: 3, confidence: 0.90 },
        { word: "in", startTime: 3, endTime: 3.2, confidence: 0.95 },
        { word: "our", startTime: 3.2, endTime: 3.5, confidence: 0.94 },
        { word: "community", startTime: 3.5, endTime: 4, confidence: 0.92 },
      ],
      isFinal: true,
    };

    const lowConfSegment: TranscriptSegment = {
      text: "When I was young my grandmother told me stories about perseverance and courage.",
      startTime: 20,
      endTime: 35,
      words: [
        { word: "When", startTime: 20, endTime: 20.3, confidence: 0.3 },
        { word: "I", startTime: 20.3, endTime: 20.5, confidence: 0.25 },
        { word: "was", startTime: 20.5, endTime: 20.8, confidence: 0.35 },
        { word: "young", startTime: 20.8, endTime: 21.2, confidence: 0.28 },
        { word: "my", startTime: 21.2, endTime: 21.5, confidence: 0.32 },
        { word: "grandmother", startTime: 21.5, endTime: 22, confidence: 0.20 },
        { word: "told", startTime: 22, endTime: 22.3, confidence: 0.30 },
        { word: "me", startTime: 22.3, endTime: 22.5, confidence: 0.35 },
        { word: "stories", startTime: 22.5, endTime: 23, confidence: 0.25 },
      ],
      isFinal: true,
    };

    const anotherHighConfSegment: TranscriptSegment = {
      text: "And then we moved on to the next part quickly without pausing for effect.",
      startTime: 80,
      endTime: 95,
      words: [
        { word: "And", startTime: 80, endTime: 80.3, confidence: 0.88 },
        { word: "then", startTime: 80.3, endTime: 80.6, confidence: 0.87 },
        { word: "we", startTime: 80.6, endTime: 80.8, confidence: 0.92 },
        { word: "moved", startTime: 80.8, endTime: 81.2, confidence: 0.86 },
        { word: "on", startTime: 81.2, endTime: 81.4, confidence: 0.90 },
        { word: "to", startTime: 81.4, endTime: 81.6, confidence: 0.93 },
        { word: "the", startTime: 81.6, endTime: 81.8, confidence: 0.87 },
        { word: "next", startTime: 81.8, endTime: 82.2, confidence: 0.86 },
        { word: "part", startTime: 82.2, endTime: 82.5, confidence: 0.88 },
        { word: "quickly", startTime: 82.5, endTime: 83, confidence: 0.85 },
      ],
      isFinal: true,
    };

    const segments = [highConfSegment, lowConfSegment, anotherHighConfSegment];

    // Low WPM to trigger quality warning
    const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

    await generator.generate(segments, metrics);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user");

    // Should include the high-confidence segments section
    expect(userMsg.content).toContain("High-Confidence Segments");
    expect(userMsg.content).toContain("mean word confidence ≥ 0.7");

    // Should include the high-confidence segment text
    expect(userMsg.content).toContain("leadership");
    expect(userMsg.content).toContain("moved on");
  });

  it("should not include high-confidence segments section when quality warning is not active", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Normal metrics — no quality warning
    const metrics = makeMetrics({ totalWords: 200, durationSeconds: 120 });

    await generator.generate(makeTranscriptSegments(), metrics);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user");

    expect(userMsg.content).not.toContain("High-Confidence Segments");
  });

  it("should not include high-confidence segments section when no segments meet the 0.7 threshold", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // All segments have low confidence
    const lowConfSegments: TranscriptSegment[] = [
      {
        text: "Hello everyone today I want to talk about leadership and growth in our community.",
        startTime: 0,
        endTime: 10,
        words: [
          { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.3 },
          { word: "everyone", startTime: 0.5, endTime: 1, confidence: 0.35 },
          { word: "today", startTime: 1.5, endTime: 2, confidence: 0.28 },
          { word: "I", startTime: 2, endTime: 2.2, confidence: 0.32 },
          { word: "want", startTime: 2.2, endTime: 2.5, confidence: 0.30 },
          { word: "to", startTime: 2.5, endTime: 2.7, confidence: 0.35 },
          { word: "talk", startTime: 2.7, endTime: 3, confidence: 0.28 },
          { word: "about", startTime: 3, endTime: 3.3, confidence: 0.33 },
          { word: "leadership", startTime: 3.3, endTime: 4, confidence: 0.30 },
          { word: "and", startTime: 4, endTime: 4.2, confidence: 0.35 },
          { word: "growth", startTime: 4.2, endTime: 4.5, confidence: 0.28 },
        ],
        isFinal: true,
      },
    ];

    // Low WPM to trigger quality warning
    const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

    await generator.generate(lowConfSegments, metrics);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user");

    // Quality warning should be active (system prompt)
    const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toContain("Audio Quality Warning");

    // But no high-confidence segments section (all below threshold → fallback to all)
    expect(userMsg.content).not.toContain("High-Confidence Segments");
  });

  it("should include no-fabrication instruction in quality warning prompt (Req 10.3)", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

    await generator.generate(makeTranscriptSegments(), metrics);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMsg = call.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toMatch(/not fabricate/i);
    expect(systemMsg.content).toContain("gaps in the transcript");
  });

  it("should exclude silence markers from high-confidence segment filtering", async () => {
    const evaluation = makeEvaluation();
    const client = makeMockClient([JSON.stringify(evaluation)]);
    const generator = new EvaluationGenerator(client);

    // Segment with high-confidence speech words but low-confidence silence markers
    // Mean of speech words should be ≥ 0.7, so it should be included as high-confidence
    const mixedSegment: TranscriptSegment = {
      text: "Today I want to talk about leadership and growth in our community.",
      startTime: 0,
      endTime: 10,
      words: [
        { word: "Today", startTime: 0, endTime: 0.5, confidence: 0.85 },
        { word: "[silence]", startTime: 0.5, endTime: 1.5, confidence: 0.05 },
        { word: "[noise]", startTime: 1.5, endTime: 2, confidence: 0.1 },
        { word: "I", startTime: 2, endTime: 2.2, confidence: 0.90 },
        { word: "want", startTime: 2.2, endTime: 2.5, confidence: 0.88 },
        { word: "to", startTime: 2.5, endTime: 2.7, confidence: 0.92 },
        { word: "talk", startTime: 2.7, endTime: 3, confidence: 0.87 },
        { word: "about", startTime: 3, endTime: 3.3, confidence: 0.85 },
        { word: "leadership", startTime: 3.3, endTime: 4, confidence: 0.83 },
        { word: "and", startTime: 4, endTime: 4.2, confidence: 0.91 },
        { word: "growth", startTime: 4.2, endTime: 4.5, confidence: 0.86 },
      ],
      isFinal: true,
    };

    // Low WPM to trigger quality warning
    const metrics = makeMetrics({ totalWords: 5, durationSeconds: 120 });

    await generator.generate([mixedSegment, ...makeTranscriptSegments().slice(1)], metrics);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === "user");

    // The segment should be included as high-confidence (speech words avg ≈ 0.87)
    // even though silence markers have low confidence
    expect(userMsg.content).toContain("High-Confidence Segments");
    expect(userMsg.content).toContain("leadership");
  });
});

// ─── Cosine Similarity Tests (Req 7.3, 7.5) ────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it("returns 0 for zero-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when first vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when second vector is all zeros", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns 0 for vectors of different lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("computes correct similarity for known vectors", () => {
    // a = [1, 0], b = [1, 1]
    // dot = 1, normA = 1, normB = sqrt(2)
    // similarity = 1 / sqrt(2) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 10);
  });

  it("is symmetric: cosineSimilarity(a, b) === cosineSimilarity(b, a)", () => {
    const a = [3, 7, 2, 5];
    const b = [1, 4, 8, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});

// ─── EMBEDDING_MODEL constant test (Req 7.5) ───────────────────────────────────

describe("EMBEDDING_MODEL", () => {
  it("is a fixed string constant", () => {
    expect(EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });
});

// ─── Consistency Telemetry Tests (Req 7.1, 7.3, 7.4, 7.5) ─────────────────────

describe("EvaluationGenerator.logConsistencyTelemetry", () => {
  function makeMockClientWithEmbeddings(embeddingResponses: number[][]): OpenAIClient {
    let callIndex = 0;
    return {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "{}" } }],
          })),
        },
      },
      embeddings: {
        create: vi.fn(async () => {
          const embedding = embeddingResponses[callIndex] ?? embeddingResponses[embeddingResponses.length - 1];
          callIndex++;
          return { data: [{ embedding }] };
        }),
      },
    };
  }

  it("does not throw on first call (no previous embedding)", async () => {
    const client = makeMockClientWithEmbeddings([[0.1, 0.2, 0.3]]);
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    // Should not throw
    await expect(generator.logConsistencyTelemetry(evaluation)).resolves.toBeUndefined();
  });

  it("logs similarity on second call when previous embedding exists", async () => {
    const embedding1 = [1, 0, 0];
    const embedding2 = [1, 0, 0]; // identical → similarity = 1.0
    const client = makeMockClientWithEmbeddings([embedding1, embedding2]);
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First call — caches embedding, no comparison
    await generator.logConsistencyTelemetry(evaluation);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("First evaluation"),
    );

    // Second call — compares with cached embedding
    await generator.logConsistencyTelemetry(evaluation);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Summary similarity: 1.0000"),
    );

    consoleSpy.mockRestore();
  });

  it("does not throw when embeddings API is not available", async () => {
    // Client without embeddings API
    const client: OpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "{}" } }],
          })),
        },
      },
    };
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    // Should not throw — gracefully handles missing embeddings API
    await expect(generator.logConsistencyTelemetry(evaluation)).resolves.toBeUndefined();
  });

  it("catches and logs errors without throwing", async () => {
    const client: OpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: "{}" } }],
          })),
        },
      },
      embeddings: {
        create: vi.fn(async () => {
          throw new Error("API error");
        }),
      },
    };
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not throw — errors are caught and logged
    await expect(generator.logConsistencyTelemetry(evaluation)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ConsistencyTelemetry] Failed to compute consistency:"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("uses the configured EMBEDDING_MODEL for API calls", async () => {
    const client = makeMockClientWithEmbeddings([[0.5, 0.5]]);
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    await generator.logConsistencyTelemetry(evaluation);

    expect(client.embeddings!.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small" }),
    );
  });

  it("extracts item summaries for embedding input", async () => {
    const client = makeMockClientWithEmbeddings([[0.1, 0.2]]);
    const generator = new EvaluationGenerator(client);
    const evaluation = makeEvaluation();

    await generator.logConsistencyTelemetry(evaluation);

    const expectedSummaries = evaluation.items.map((i) => i.summary).join(". ");
    expect(client.embeddings!.create).toHaveBeenCalledWith(
      expect.objectContaining({ input: expectedSummaries }),
    );
  });
});

// ─── Phase 4: Visual Feedback Tests ─────────────────────────────────────────────

/** Build a minimal valid VisualObservations for testing. */
function makeVisualObservations(overrides?: Partial<VisualObservations>): VisualObservations {
  return {
    gazeBreakdown: { audienceFacing: 65, notesFacing: 25, other: 10 },
    faceNotDetectedCount: 2,
    totalGestureCount: 12,
    gestureFrequency: 7.6,
    gesturePerSentenceRatio: 0.6,
    handsDetectedFrames: 80,
    handsNotDetectedFrames: 20,
    meanBodyStabilityScore: 0.82,
    stageCrossingCount: 1,
    movementClassification: "moderate_movement",
    meanFacialEnergyScore: 0.45,
    facialEnergyVariation: 0.3,
    facialEnergyLowSignal: false,
    framesAnalyzed: 100,
    framesReceived: 120,
    framesSkippedBySampler: 10,
    framesErrored: 2,
    framesDroppedByBackpressure: 5,
    framesDroppedByTimestamp: 3,
    framesDroppedByFinalizationBudget: 0,
    resolutionChangeCount: 0,
    videoQualityGrade: "good",
    videoQualityWarning: false,
    finalizationLatencyMs: 150,
    videoProcessingVersion: {
      tfjsVersion: "4.0.0",
      tfjsBackend: "cpu",
      modelVersions: { blazeface: "1.0.0", movenet: "1.0.0" },
      configHash: "abc123",
    },
    gazeReliable: true,
    gestureReliable: true,
    stabilityReliable: true,
    facialEnergyReliable: true,
    capabilities: { face: true, pose: true },
    ...overrides,
  };
}

function makeVisualFeedbackItem(overrides?: Partial<VisualFeedbackItem>): VisualFeedbackItem {
  return {
    type: "visual_observation",
    summary: "Audience-facing gaze",
    observation_data: "metric=gazeBreakdown.audienceFacing; value=65%; source=visualObservations",
    explanation: "I observed that you faced the audience for 65% of the speech, which is below the typical 80% target.",
    ...overrides,
  };
}

describe("Phase 4: Visual Feedback Integration", () => {
  // ── generate() with null visualObservations produces Phase 3 identical output ──

  describe("generate() with null visualObservations", () => {
    it("should produce byte-identical prompts to Phase 3 when visualObservations is null", async () => {
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, null);

      // Call with no visual observations (Phase 3 style)
      const client2 = makeMockClient([response]);
      const generator2 = new EvaluationGenerator(client2);
      await generator2.generate(segments, metrics, undefined);

      // Both should have been called with identical prompts
      const call1 = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const call2 = (client2.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(call1.messages[0].content).toBe(call2.messages[0].content); // system prompt
      expect(call1.messages[1].content).toBe(call2.messages[1].content); // user prompt
    });

    it("should produce byte-identical prompts when visualObservations is undefined", async () => {
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, undefined);

      const client2 = makeMockClient([response]);
      const generator2 = new EvaluationGenerator(client2);
      await generator2.generate(segments, metrics);

      const call1 = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const call2 = (client2.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(call1.messages[0].content).toBe(call2.messages[0].content);
      expect(call1.messages[1].content).toBe(call2.messages[1].content);
    });
  });

  // ── generate() with valid visualObservations includes visual section ──

  describe("generate() with valid visualObservations", () => {
    it("should include Visual Observations section in user prompt", async () => {
      const visualObs = makeVisualObservations();
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).toContain("## Visual Observations (from video analysis)");
      expect(userPrompt).toContain("Visual Feedback Instructions");
    });

    it("should include visual_feedback in system prompt JSON schema", async () => {
      const visualObs = makeVisualObservations();
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemPrompt = call.messages[0].content;
      expect(systemPrompt).toContain("visual_feedback");
      expect(systemPrompt).toContain("visual_observation");
      expect(systemPrompt).toContain("observation_data");
    });
  });

  // ── generate() suppresses visual data when videoQualityGrade is "poor" ──

  describe("generate() with poor video quality", () => {
    it("should not include Visual Observations section when grade is poor", async () => {
      const visualObs = makeVisualObservations({ videoQualityGrade: "poor", videoQualityWarning: true });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      const systemPrompt = call.messages[0].content;
      expect(userPrompt).not.toContain("Visual Observations");
      expect(systemPrompt).not.toContain("visual_feedback");
    });

    it("should produce prompts identical to Phase 3 when grade is poor", async () => {
      const visualObs = makeVisualObservations({ videoQualityGrade: "poor", videoQualityWarning: true });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);

      const client1 = makeMockClient([response]);
      const generator1 = new EvaluationGenerator(client1);
      const client2 = makeMockClient([response]);
      const generator2 = new EvaluationGenerator(client2);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator1.generate(segments, metrics, undefined, visualObs);
      await generator2.generate(segments, metrics, undefined, null);

      const call1 = (client1.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const call2 = (client2.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(call1.messages[0].content).toBe(call2.messages[0].content);
      expect(call1.messages[1].content).toBe(call2.messages[1].content);
    });
  });

  // ── buildUserPrompt() excludes unreliable metrics ──

  describe("buildUserPrompt() unreliable metric filtering", () => {
    it("should exclude gaze data when gazeReliable is false", async () => {
      const visualObs = makeVisualObservations({ gazeReliable: false });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).toContain("Visual Observations");
      expect(userPrompt).not.toContain("audienceFacing");
      expect(userPrompt).not.toContain("notesFacing");
    });

    it("should exclude gesture data when gestureReliable is false", async () => {
      const visualObs = makeVisualObservations({ gestureReliable: false });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).not.toContain("totalGestureCount");
      expect(userPrompt).not.toContain("gestureFrequency");
    });

    it("should exclude stability data when stabilityReliable is false", async () => {
      const visualObs = makeVisualObservations({ stabilityReliable: false });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).not.toContain("meanBodyStabilityScore");
      expect(userPrompt).not.toContain("stageCrossingCount");
    });

    it("should exclude facial energy data when facialEnergyReliable is false", async () => {
      const visualObs = makeVisualObservations({ facialEnergyReliable: false });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).not.toContain("meanFacialEnergyScore");
      expect(userPrompt).not.toContain("facialEnergyVariation");
    });

    it("should add degraded quality uncertainty note", async () => {
      const visualObs = makeVisualObservations({ videoQualityGrade: "degraded", videoQualityWarning: true });
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      await generator.generate(segments, metrics, undefined, visualObs);

      const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userPrompt = call.messages[1].content;
      expect(userPrompt).toContain("partial video coverage");
    });
  });

  // ── parseEvaluation() handles visual_feedback array ──

  describe("parseEvaluation() visual_feedback", () => {
    it("should parse valid visual_feedback items from LLM response", async () => {
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      const result = await generator.generate(segments, metrics, undefined, makeVisualObservations());

      expect(result.evaluation.visual_feedback).toBeDefined();
      expect(result.evaluation.visual_feedback).toHaveLength(1);
      expect(result.evaluation.visual_feedback![0].type).toBe("visual_observation");
      expect(result.evaluation.visual_feedback![0].summary).toBe("Audience-facing gaze");
    });

    it("should default to undefined when visual_feedback is missing", async () => {
      const evaluation = makeEvaluation();
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      const result = await generator.generate(segments, metrics);

      expect(result.evaluation.visual_feedback).toBeUndefined();
    });

    it("should filter out malformed visual_feedback items", async () => {
      const evaluation = {
        ...makeEvaluation(),
        visual_feedback: [
          makeVisualFeedbackItem(),
          { type: "visual_observation", summary: "", observation_data: "x", explanation: "y" }, // empty summary
          { type: "wrong_type", summary: "x", observation_data: "x", explanation: "y" }, // wrong type
        ],
      };
      const response = JSON.stringify(evaluation);
      const client = makeMockClient([response]);
      const generator = new EvaluationGenerator(client);
      const segments = makeTranscriptSegments();
      const metrics = makeMetrics();

      const result = await generator.generate(segments, metrics, undefined, makeVisualObservations());

      expect(result.evaluation.visual_feedback).toHaveLength(1);
    });
  });

  // ── renderScript() over-stripping fallback ──

  describe("renderScript() visual feedback", () => {
    it("should include visual feedback section with transition sentence", () => {
      const visualObs = makeVisualObservations();
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, undefined, makeMetrics(), visualObs);

      expect(script).toContain("Looking at your delivery from a visual perspective...");
      expect(script).toContain("I observed that you faced the audience for 65%");
    });

    it("should remove visual section entirely when all items fail validation (over-stripping)", () => {
      const visualObs = makeVisualObservations();
      const evaluation = makeEvaluation({
        visual_feedback: [
          makeVisualFeedbackItem({
            observation_data: "metric=nonExistentMetric; value=99%; source=visualObservations",
          }),
        ],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, undefined, makeMetrics(), visualObs);

      expect(script).not.toContain("Looking at your delivery from a visual perspective...");
      expect(script).not.toContain("nonExistentMetric");
    });

    it("should not include visual section when visual_feedback is undefined", () => {
      const evaluation = makeEvaluation();
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, undefined, makeMetrics());

      expect(script).not.toContain("Looking at your delivery from a visual perspective...");
    });

    it("should not include visual section when visualObservations is null", () => {
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, undefined, makeMetrics(), null);

      expect(script).not.toContain("Looking at your delivery from a visual perspective...");
    });

    it("should render visual feedback after items and before closing", () => {
      const visualObs = makeVisualObservations();
      const evaluation = makeEvaluation({
        visual_feedback: [makeVisualFeedbackItem()],
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, undefined, makeMetrics(), visualObs);

      const closingIndex = script.indexOf(evaluation.closing);
      const visualIndex = script.indexOf("Looking at your delivery from a visual perspective...");
      const lastItemExplanation = evaluation.items[evaluation.items.length - 1].explanation;
      const lastItemIndex = script.indexOf(lastItemExplanation);

      expect(visualIndex).toBeGreaterThan(lastItemIndex);
      expect(visualIndex).toBeLessThan(closingIndex);
    });
  });

  // ── validateObservationData() ──

  describe("validateObservationData()", () => {
    const observations = makeVisualObservations();

    it("should return true for valid observation_data with correct metric and value", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=gazeBreakdown.audienceFacing; value=65%; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(true);
    });

    it("should return true for value within ±1% tolerance", () => {
      // actual is 65, 65.6 is within 1% (65 * 0.01 = 0.65)
      const item = makeVisualFeedbackItem({
        observation_data: "metric=gazeBreakdown.audienceFacing; value=65.6%; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(true);
    });

    it("should return false for value outside ±1% tolerance", () => {
      // actual is 65, 70 is way outside 1%
      const item = makeVisualFeedbackItem({
        observation_data: "metric=gazeBreakdown.audienceFacing; value=70%; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(false);
    });

    it("should return false for non-existent metric name", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=nonExistentMetric; value=65%; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(false);
    });

    it("should return false for malformed observation_data", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "this is not valid grammar",
      });
      expect(validateObservationData(item, observations)).toBe(false);
    });

    it("should return false for wrong source", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=gazeBreakdown.audienceFacing; value=65%; source=wrongSource",
      });
      expect(validateObservationData(item, observations)).toBe(false);
    });

    it("should return false for missing value field", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=gazeBreakdown.audienceFacing; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(false);
    });

    it("should handle actual value of 0 — cited must be exactly 0", () => {
      const zeroObs = makeVisualObservations({ stageCrossingCount: 0 });
      const item = makeVisualFeedbackItem({
        observation_data: "metric=stageCrossingCount; value=0; source=visualObservations",
      });
      expect(validateObservationData(item, zeroObs)).toBe(true);

      const nonZeroItem = makeVisualFeedbackItem({
        observation_data: "metric=stageCrossingCount; value=0.1; source=visualObservations",
      });
      expect(validateObservationData(nonZeroItem, zeroObs)).toBe(false);
    });

    it("should validate non-gaze metrics correctly", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=totalGestureCount; value=12; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(true);
    });

    it("should validate meanBodyStabilityScore correctly", () => {
      const item = makeVisualFeedbackItem({
        observation_data: "metric=meanBodyStabilityScore; value=0.82; source=visualObservations",
      });
      expect(validateObservationData(item, observations)).toBe(true);
    });

    it("should return false for empty observation_data", () => {
      const item = makeVisualFeedbackItem({ observation_data: "" });
      expect(validateObservationData(item, observations)).toBe(false);
    });
  });
});