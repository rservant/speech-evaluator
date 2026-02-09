// Unit tests for EvaluationGenerator
// Tests: prompt construction, LLM call orchestration, retry logic,
//        evidence validation delegation, script rendering, name redaction.

import { describe, it, expect, vi } from "vitest";
import { EvaluationGenerator, type OpenAIClient } from "./evaluation-generator.js";
import type {
  DeliveryMetrics,
  EvaluationItem,
  StructuredEvaluation,
  TranscriptSegment,
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

    it("should redact third-party names when speakerName is provided", () => {
      const evaluation = makeEvaluation({
        opening: "Thank you Sarah for that wonderful speech about John and Mary.",
      });
      const generator = new EvaluationGenerator(makeMockClient([]));

      const script = generator.renderScript(evaluation, "Sarah");

      // Sarah should be preserved (speaker's name)
      expect(script).toContain("Sarah");
      // John and Mary should be redacted
      expect(script).toContain("[a fellow member]");
      expect(script).not.toContain("John");
      expect(script).not.toContain("Mary");
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

      expect(result.opening).toBe(evaluation.opening);
      expect(result.items).toHaveLength(3);
      expect(result.closing).toBe(evaluation.closing);
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
      expect(result.items).toHaveLength(3);
      expect(result.items[1].summary).toBe("Vivid storytelling");
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
      expect(result.items).toHaveLength(3);
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
  });
});
