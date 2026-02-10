// Unit tests for FilePersistence
// Validates: Requirements 6.1, 6.2, 6.3, 6.4

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
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
  StructuredEvaluationPublic,
  ConsentRecord,
  ProjectContext,
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
    evaluationPublic: null,
    evaluationScript: null,
    ttsAudioCache: null,
    qualityWarning: false,
    outputsSaved: false,
    runId: 1,
    consent: null,
    timeLimitSeconds: 120,
    evaluationPassRate: null,
    projectContext: null,
    vadConfig: { silenceThresholdSeconds: 5, enabled: true },
    eagerStatus: "idle",
    eagerRunId: null,
    eagerPromise: null,
    evaluationCache: null,
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
    intentionalPauseCount: 2,
    hesitationPauseCount: 2,
    classifiedPauses: [],
    energyVariationCoefficient: 0.35,
    energyProfile: {
      windowDurationMs: 250,
      windows: [],
      coefficientOfVariation: 0.35,
      silenceThreshold: 0.1,
    },
    classifiedFillers: [],
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
    structure_commentary: {
      opening_comment: null,
      body_comment: null,
      closing_comment: null,
    },
  };
}

function makeConsent(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    speakerName: "Alice",
    consentConfirmed: true,
    consentTimestamp: new Date("2025-01-15T14:29:00.000Z"),
    ...overrides,
  };
}

function makeEvaluationPublic(): StructuredEvaluationPublic {
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
        evidence_quote: "a fellow member made a great point",
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
    structure_commentary: {
      opening_comment: null,
      body_comment: null,
      closing_comment: null,
    },
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

    // ─── Phase 2: Consent metadata in evaluation header (Req 2.6) ─────────

    it("includes consent metadata in header when consent is present", () => {
      const consent = makeConsent();
      const session = makeSession({
        metrics: makeMetrics(),
        consent,
      });
      const result = formatEvaluation(session);

      expect(result).toContain("Speaker: Alice");
      expect(result).toContain("Consent: Confirmed");
      expect(result).toContain("Consent Timestamp: 2025-01-15T14:29:00.000Z");
    });

    it("shows 'Not Confirmed' when consent is not confirmed", () => {
      const consent = makeConsent({ consentConfirmed: false });
      const session = makeSession({ consent });
      const result = formatEvaluation(session);

      expect(result).toContain("Consent: Not Confirmed");
    });

    it("uses consent.speakerName over deprecated speakerName", () => {
      const consent = makeConsent({ speakerName: "ConsentAlice" });
      const session = makeSession({
        consent,
        speakerName: "DeprecatedBob",
      });
      const result = formatEvaluation(session);

      expect(result).toContain("Speaker: ConsentAlice");
      expect(result).not.toContain("Speaker: DeprecatedBob");
    });

    it("falls back to deprecated speakerName when consent is null", () => {
      const session = makeSession({
        consent: null,
        speakerName: "FallbackBob",
      });
      const result = formatEvaluation(session);

      expect(result).toContain("Speaker: FallbackBob");
      expect(result).not.toContain("Consent:");
    });

    it("omits consent lines when consent is null", () => {
      const session = makeSession({ consent: null });
      const result = formatEvaluation(session);

      expect(result).not.toContain("Consent:");
      expect(result).not.toContain("Consent Timestamp:");
    });

    // ─── Phase 2: evaluationPublic rendering (Req 8.4) ───────────────────

    it("renders evaluationPublic when no evaluationScript and evaluationPublic is available", () => {
      const evalPublic = makeEvaluationPublic();
      const session = makeSession({
        evaluation: makeEvaluation(),
        evaluationPublic: evalPublic,
        evaluationScript: null,
      });
      const result = formatEvaluation(session);

      // Should use evaluationPublic (which has redacted evidence quote)
      expect(result).toContain("a fellow member made a great point");
    });

    it("prefers evaluationScript over evaluationPublic", () => {
      const session = makeSession({
        evaluation: makeEvaluation(),
        evaluationPublic: makeEvaluationPublic(),
        evaluationScript: "This is the rendered script.",
      });
      const result = formatEvaluation(session);

      expect(result).toContain("This is the rendered script.");
      // Should NOT contain the structured rendering
      expect(result).not.toContain("Commendation: Strong opening");
    });

    it("falls back to internal evaluation when both evaluationScript and evaluationPublic are null", () => {
      const session = makeSession({
        evaluation: makeEvaluation(),
        evaluationPublic: null,
        evaluationScript: null,
      });
      const result = formatEvaluation(session);

      expect(result).toContain("Commendation: Strong opening");
      expect(result).toContain("Recommendation: Stronger conclusion");
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

    // ─── Phase 2: Consent JSON file (Req 2.6, Property 3) ────────────────

    it("writes consent.json when consent record exists", async () => {
      const consent = makeConsent();
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        consent,
      });

      const paths = await persistence.saveSession(session);

      // Should have 4 paths: transcript, metrics, evaluation, consent
      expect(paths).toHaveLength(4);
      expect(paths[3]).toContain("consent.json");

      const content = await readFile(paths[3], "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.speakerName).toBe("Alice");
      expect(parsed.consentConfirmed).toBe(true);
      expect(parsed.consentTimestamp).toBe("2025-01-15T14:29:00.000Z");
    });

    it("consent.json round-trips to equivalent ConsentRecord", async () => {
      const consent = makeConsent({
        speakerName: "Charlie",
        consentConfirmed: true,
        consentTimestamp: new Date("2025-03-10T09:15:30.000Z"),
      });
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        consent,
      });

      const paths = await persistence.saveSession(session);
      const consentPath = paths.find((p) => p.endsWith("consent.json"))!;
      const content = await readFile(consentPath, "utf-8");
      const parsed = JSON.parse(content);

      // Round-trip: reconstruct ConsentRecord from saved JSON
      const restored: ConsentRecord = {
        speakerName: parsed.speakerName,
        consentConfirmed: parsed.consentConfirmed,
        consentTimestamp: new Date(parsed.consentTimestamp),
      };

      expect(restored.speakerName).toBe(consent.speakerName);
      expect(restored.consentConfirmed).toBe(consent.consentConfirmed);
      expect(restored.consentTimestamp.toISOString()).toBe(consent.consentTimestamp.toISOString());
    });

    it("does not write consent.json when consent is null", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        consent: null,
      });

      const paths = await persistence.saveSession(session);

      expect(paths).toHaveLength(3);
      expect(paths.some((p) => p.endsWith("consent.json"))).toBe(false);

      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);
      expect(files.sort()).toEqual(["evaluation.txt", "metrics.json", "transcript.txt"]);
    });

    it("includes consent.json in directory listing alongside other files", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        consent: makeConsent(),
      });

      await persistence.saveSession(session);

      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);
      expect(files.sort()).toEqual([
        "consent.json",
        "evaluation.txt",
        "metrics.json",
        "transcript.txt",
      ]);
    });

    it("includes consent metadata in evaluation.txt header when consent exists", async () => {
      const consent = makeConsent();
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        consent,
      });

      const paths = await persistence.saveSession(session);
      const evalContent = await readFile(paths[2], "utf-8");

      expect(evalContent).toContain("Speaker: Alice");
      expect(evalContent).toContain("Consent: Confirmed");
      expect(evalContent).toContain("Consent Timestamp:");
    });

    // ─── Phase 2: Redacted evaluation saving (Req 8.4) ───────────────────

    it("uses evaluationPublic for structured rendering in saved evaluation.txt", async () => {
      const evalPublic = makeEvaluationPublic();
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationPublic: evalPublic,
        evaluationScript: null,
      });

      const paths = await persistence.saveSession(session);
      const content = await readFile(paths[2], "utf-8");

      // Should use evaluationPublic (redacted) not internal evaluation
      expect(content).toContain("a fellow member made a great point");
    });

    // ─── Phase 3: Project context persistence (Req 5.4) ─────────────────

    it("writes project-context.json when projectContext is present", async () => {
      const projectContext: ProjectContext = {
        speechTitle: "My Journey to Toastmasters",
        projectType: "Ice Breaker",
        objectives: ["Introduce yourself", "Speak for 4-6 minutes"],
      };
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        projectContext,
      });

      const paths = await persistence.saveSession(session);

      const projectContextPath = paths.find((p) => p.endsWith("project-context.json"));
      expect(projectContextPath).toBeDefined();

      const content = await readFile(projectContextPath!, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.speechTitle).toBe("My Journey to Toastmasters");
      expect(parsed.projectType).toBe("Ice Breaker");
      expect(parsed.objectives).toEqual(["Introduce yourself", "Speak for 4-6 minutes"]);
    });

    it("does not write project-context.json when projectContext is null", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        projectContext: null,
      });

      const paths = await persistence.saveSession(session);

      expect(paths.some((p) => p.endsWith("project-context.json"))).toBe(false);

      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);
      expect(files).not.toContain("project-context.json");
    });

    // ─── TTS Audio File Persistence (Requirements 4.1, 4.2, 4.4) ─────────

    it("writes evaluation_audio.mp3 with correct content when ttsAudioCache is present", async () => {
      const audioBuffer = Buffer.from("fake-mp3-audio-data-for-testing");
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        ttsAudioCache: audioBuffer,
      });

      const paths = await persistence.saveSession(session);

      // Should return 4 paths (3 base files + audio)
      expect(paths).toHaveLength(4);
      expect(paths[3]).toContain("evaluation_audio.mp3");

      // Audio file content must match the cache buffer
      const audioContent = await readFile(paths[3], null);
      expect(Buffer.compare(audioContent, audioBuffer)).toBe(0);

      // Verify the file exists in the directory
      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);
      expect(files.sort()).toEqual([
        "evaluation.txt",
        "evaluation_audio.mp3",
        "metrics.json",
        "transcript.txt",
      ]);
    });

    it("does not write audio file when ttsAudioCache is null, other files still saved", async () => {
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        ttsAudioCache: null,
      });

      const paths = await persistence.saveSession(session);

      // Should return only 3 paths (no audio)
      expect(paths).toHaveLength(3);
      expect(paths.some((p) => p.endsWith("evaluation_audio.mp3"))).toBe(false);

      // Verify only 3 files in directory
      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);
      const files = await readdir(dirPath);
      expect(files.sort()).toEqual(["evaluation.txt", "metrics.json", "transcript.txt"]);
    });

    it("continues saving other files when audio write fails, audio path not in returned paths", async () => {
      const audioBuffer = Buffer.from("fake-mp3-audio-data");
      const session = makeSession({
        transcript: makeSegments(),
        metrics: makeMetrics(),
        evaluation: makeEvaluation(),
        evaluationScript: "Great speech!",
        ttsAudioCache: audioBuffer,
      });

      // Save once to create the output directory and the audio file
      await persistence.saveSession(session);
      session.outputsSaved = false;

      // Get the output directory path
      const entries = await readdir(tempDir);
      const dirPath = join(tempDir, entries[0]);

      // Remove the audio file, then create a directory with the same name
      // so that writeFile will fail (can't write a file where a directory exists)
      const audioFilePath = join(dirPath, "evaluation_audio.mp3");
      await rm(audioFilePath);
      await mkdir(audioFilePath, { recursive: true });

      // Save again — the directory already exists with evaluation_audio.mp3 as a subdirectory
      const paths = await persistence.saveSession(session);

      // The 3 base files should still be saved (they get overwritten)
      expect(paths.filter((p) => p.endsWith("transcript.txt"))).toHaveLength(1);
      expect(paths.filter((p) => p.endsWith("metrics.json"))).toHaveLength(1);
      expect(paths.filter((p) => p.endsWith("evaluation.txt"))).toHaveLength(1);

      // Audio path should NOT be in the returned paths since write failed
      expect(paths.filter((p) => p.endsWith("evaluation_audio.mp3"))).toHaveLength(0);
      expect(paths).toHaveLength(3);
    });
  });
});
