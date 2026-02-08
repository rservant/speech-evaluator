// Unit tests for FilePersistence
// Validates: Requirements 6.1, 6.2, 6.3, 6.4

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FilePersistence,
  formatTimestamp,
  formatTranscript,
  formatMetrics,
  formatEvaluation,
  buildDirectoryName,
} from "./file-persistence.js";
import type {
  Session,
  TranscriptSegment,
  DeliveryMetrics,
  StructuredEvaluation,
} from "./types.js";
import { SessionState } from "./types.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-123",
    state: SessionState.IDLE,
    startedAt: new Date("2025-01-15T14:30:00.000Z"),
    stoppedAt: new Date("2025-01-15T14:37:00.000Z"),
    transcript: [],
    liveTranscript: [],
    audioChunks: [],
    metrics: null,
    evaluation: null,
    evaluationScript: null,
    qualityWarning: false,
    outputsSaved: false,
    runId: 1,
    ...overrides,
  };
}

function makeSegments(): TranscriptSegment[] {
  return [
    {
      text: "Hello everyone, today I want to talk about leadership.",
      startTime: 0,
      endTime: 5.2,
      words: [],
      isFinal: true,
    },
    {
      text: "The first point I'd like to make is about communication.",
      startTime: 15.3,
      endTime: 20.1,
      words: [],
      isFinal: true,
    },
    {
      text: "In conclusion, leadership starts with listening.",
      startTime: 90.7,
      endTime: 95.0,
      words: [],
      isFinal: true,
    },
  ];
}

function makeMetrics(): DeliveryMetrics {
  return {
    durationSeconds: 420,
    durationFormatted: "7:00",
    totalWords: 850,
    wordsPerMinute: 121.4,
    fillerWords: [
      { word: "um", count: 3, timestamps: [12.5, 45.2, 120.0] },
      { word: "like", count: 2, timestamps: [30.1, 88.5] },
    ],
    fillerWordCount: 5,
    fillerWordFrequency: 0.71,
    pauseCount: 4,
    totalPauseDurationSeconds: 8.5,
    averagePauseDurationSeconds: 2.125,
  };
}

function makeEvaluation(): StructuredEvaluation {
  return {
    opening: "That was a compelling speech about leadership.",
    items: [
      {
        type: "commendation",
        summary: "Strong opening",
        evidence_quote: "Hello everyone today I want to talk about leadership",
        evidence_timestamp: 0,
        explanation: "You immediately engaged the audience with a clear topic statement.",
      },
      {
        type: "commendation",
        summary: "Clear structure",
        evidence_quote: "The first point I'd like to make",
        evidence_timestamp: 15.3,
        explanation: "Your speech had a logical flow that was easy to follow.",
      },
      {
        type: "recommendation",
        summary: "Stronger conclusion",
        evidence_quote: "In conclusion leadership starts with listening",
        evidence_timestamp: 90.7,
        explanation: "Consider ending with a call to action to leave a lasting impression.",
      },
    ],
    closing: "Overall, a well-delivered speech with room to grow. Keep it up!",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FilePersistence", () => {
  let tempDir: string;
  let persistence: FilePersistence;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "file-persistence-test-"));
    persistence = new FilePersistence(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── formatTimestamp ──────────────────────────────────────────────────────

  describe("formatTimestamp()", () => {
    it("formats 0 seconds as [00:00]", () => {
      expect(formatTimestamp(0)).toBe("[00:00]");
    });

    it("formats seconds under a minute", () => {
      expect(formatTimestamp(15)).toBe("[00:15]");
    });

    it("formats exact minutes", () => {
      expect(formatTimestamp(60)).toBe("[01:00]");
    });

    it("formats minutes and seconds", () => {
      expect(formatTimestamp(90)).toBe("[01:30]");
    });

    it("formats large timestamps", () => {
      expect(formatTimestamp(1500)).toBe("[25:00]");
    });

    it("floors fractional seconds", () => {
      expect(formatTimestamp(15.7)).toBe("[00:15]");
    });

    it("treats negative seconds as zero", () => {
      expect(formatTimestamp(-5)).toBe("[00:00]");
    });
  });

  // ─── formatTranscript ─────────────────────────────────────────────────────

  describe("formatTranscript()", () => {
    it("formats segments with [MM:SS] timestamps", () => {
      const segments = makeSegments();
      const result = formatTranscript(segments);

      expect(result).toBe(
        "[00:00] Hello everyone, today I want to talk about leadership.\n" +
        "[00:15] The first point I'd like to make is about communication.\n" +
        "[01:30] In conclusion, leadership starts with listening."
      );
    });

    it("returns empty string for empty segments", () => {
      expect(formatTranscript([])).toBe("");
    });

    it("handles a single segment", () => {
      const segments: TranscriptSegment[] = [
        {
          text: "Hello world.",
          startTime: 0,
          endTime: 2.0,
          words: [],
          isFinal: true,
        },
      ];
      const result = formatTranscript(segments);
      expect(result).toBe("[00:00] Hello world.");
    });
  });

  // ─── formatMetrics ────────────────────────────────────────────────────────

  describe("formatMetrics()", () => {
    it("serializes DeliveryMetrics as pretty-printed JSON", () => {
      const metrics = makeMetrics();
      const result = formatMetrics(metrics);
      const parsed = JSON.parse(result);

      expect(parsed.durationSeconds).toBe(420);
      expect(parsed.durationFormatted).toBe("7:00");
      expect(parsed.totalWords).toBe(850);
      expect(parsed.wordsPerMinute).toBe(121.4);
      expect(parsed.fillerWords).toHaveLength(2);
      expect(parsed.fillerWordCount).toBe(5);
      expect(parsed.pauseCount).toBe(4);
    });

    it("produces valid JSON that round-trips", () => {
      const metrics = makeMetrics();
      const json = formatMetrics(metrics);
      const parsed = JSON.parse(json) as DeliveryMetrics;

      expect(parsed).toEqual(metrics);
    });
  });

  // ─── formatEvaluation ─────────────────────────────────────────────────────

  describe("formatEvaluation()", () => {
    it("includes session metadata header", () => {
      const session = makeSession({
        metrics: makeMetrics(),
        speakerName: "Alice",
      });
      const result = formatEvaluation(session);

      expect(result).toContain("=== Toastmasters Speech Evaluation ===");
      expect(result).toContain("Date: 2025-01-15");
      expect(result).toContain("Session ID: test-session-123");
      expect(result).toContain("Duration: 7:00");
      expect(result).toContain("Speaker: Alice");
    });

    it("uses evaluationScript when available", () => {
      const session = makeSession({
        evaluationScript: "That was a great speech. Well done!",
        evaluation: makeEvaluation(),
      });
      const result = formatEvaluation(session);

      expect(result).toContain("That was a great speech. Well done!");
    });

    it("renders StructuredEvaluation when no evaluationScript", () => {
      const session = makeSession({
        evaluation: makeEvaluation(),
        evaluationScript: null,
      });
      const result = formatEvaluation(session);

      expect(result).toContain("That was a compelling speech about leadership.");
      expect(result).toContain("Commendation: Strong opening");
      expect(result).toContain("Recommendation: Stronger conclusion");
      expect(result).toContain("Overall, a well-delivered speech with room to grow. Keep it up!");
    });

    it("omits speaker name when not provided", () => {
      const session = makeSession();
      const result = formatEvaluation(session);

      expect(result).not.toContain("Speaker:");
    });

    it("omits duration when metrics are null", () => {
      const session = makeSession({ metrics: null });
      const result = formatEvaluation(session);

      expect(result).not.toContain("Duration:");
    });

    it("uses stoppedAt date for the header", () => {
      const session = makeSession({
        stoppedAt: new Date("2025-06-20T10:00:00.000Z"),
      });
      const result = formatEvaluation(session);

      expect(result).toContain("Date: 2025-06-20");
    });
  });

  // ─── buildDirectoryName ───────────────────────────────────────────────────

  describe("buildDirectoryName()", () => {
    it("produces {YYYY-MM-DD_HH-mm-ss}_{sessionId} format", () => {
      const session = makeSession({
        id: "abc-def-123",
        startedAt: new Date("2025-01-15T14:30:45.000Z"),
      });
      const name = buildDirectoryName(session);

      // Note: the exact hours depend on the local timezone of the test runner,
      // so we verify the structure rather than exact values
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_abc-def-123$/);
    });

    it("includes the session ID", () => {
      const session = makeSession({ id: "my-unique-session" });
      const name = buildDirectoryName(session);

      expect(name).toContain("my-unique-session");
    });

    it("uses current date when startedAt is null", () => {
      const session = makeSession({ startedAt: null });
      const name = buildDirectoryName(session);

      // Should still produce a valid directory name
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_test-session-123$/);
    });
  });

  // ─── saveSession (integration with filesystem) ────────────────────────────

  describe("saveSession()", () => {
    it("creates the output directory", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      await persistence.saveSession(session);

      const entries = await readdir(tempDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_test-session-123$/);
    });

    it("creates exactly three files in the output directory", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      await persistence.saveSession(session);

      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);

      expect(files.sort()).toEqual(["evaluation.txt", "metrics.json", "transcript.txt"]);
    });

    it("returns the paths of all three written files", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      const paths = await persistence.saveSession(session);

      expect(paths).toHaveLength(3);
      expect(paths[0]).toContain("transcript.txt");
      expect(paths[1]).toContain("metrics.json");
      expect(paths[2]).toContain("evaluation.txt");
    });

    it("writes correct transcript.txt content", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[0], "utf-8");

      expect(content).toContain("[00:00] Hello everyone");
      expect(content).toContain("[00:15] The first point");
      expect(content).toContain("[01:30] In conclusion");
    });

    it("writes correct metrics.json content", async () => {
      const metrics = makeMetrics();
      const session = makeSession({
        transcript: makeSegments(),
        metrics,
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[1], "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(metrics);
    });

    it("writes correct evaluation.txt content", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "That was a wonderful speech about leadership!",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[2], "utf-8");

      expect(content).toContain("=== Toastmasters Speech Evaluation ===");
      expect(content).toContain("Session ID: test-session-123");
      expect(content).toContain("That was a wonderful speech about leadership!");
    });

    it("sets session.outputsSaved to true after successful save", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      expect(session.outputsSaved).toBe(false);

      await persistence.saveSession(session);

      expect(session.outputsSaved).toBe(true);
    });

    it("handles session with no transcript (empty segments)", async () => {
      const session = makeSession({
        transcript: [],
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[0], "utf-8");

      expect(content).toBe("");
    });

    it("handles session with no metrics (null)", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: null,
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[1], "utf-8");

      expect(content).toBe("{}");
    });

    it("handles session with no evaluation and no script", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: null,
        evaluationScript: null,
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[2], "utf-8");

      expect(content).toContain("=== Toastmasters Speech Evaluation ===");
      expect(content).toContain("Session ID: test-session-123");
      // No evaluation body, just the header
    });

    it("renders StructuredEvaluation when evaluationScript is null", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: null,
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[2], "utf-8");

      expect(content).toContain("Commendation: Strong opening");
      expect(content).toContain("Recommendation: Stronger conclusion");
    });

    it("includes speaker name in evaluation header when provided", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        speakerName: "Bob",
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[2], "utf-8");

      expect(content).toContain("Speaker: Bob");
    });
  });
});
