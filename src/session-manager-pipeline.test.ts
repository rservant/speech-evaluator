// Unit tests for SessionManager pipeline wiring (Task 12.1)
// Validates: Requirements 1.2, 1.4, 1.6, 7.1
//
// These tests verify that the SessionManager correctly wires together
// the TranscriptionEngine, MetricsExtractor, EvaluationGenerator, TTSEngine,
// and FilePersistence components through the session lifecycle.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionManager, type SessionManagerDeps } from "./session-manager.js";
import {
  SessionState,
  type TranscriptSegment,
  type DeliveryMetrics,
  type StructuredEvaluation,
} from "./types.js";

// ─── Mock factories ─────────────────────────────────────────────────────────────

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    text: "Hello everyone today I want to talk about leadership",
    startTime: 0,
    endTime: 5,
    words: [
      { word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.95 },
      { word: "everyone", startTime: 0.6, endTime: 1.0, confidence: 0.92 },
      { word: "today", startTime: 1.1, endTime: 1.4, confidence: 0.97 },
      { word: "I", startTime: 1.5, endTime: 1.6, confidence: 0.99 },
      { word: "want", startTime: 1.7, endTime: 1.9, confidence: 0.96 },
      { word: "to", startTime: 2.0, endTime: 2.1, confidence: 0.98 },
      { word: "talk", startTime: 2.2, endTime: 2.5, confidence: 0.94 },
      { word: "about", startTime: 2.6, endTime: 2.9, confidence: 0.93 },
      { word: "leadership", startTime: 3.0, endTime: 3.8, confidence: 0.91 },
    ],
    isFinal: true,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<DeliveryMetrics> = {}): DeliveryMetrics {
  return {
    durationSeconds: 120,
    durationFormatted: "2:00",
    totalWords: 250,
    wordsPerMinute: 125,
    fillerWords: [],
    fillerWordCount: 0,
    fillerWordFrequency: 0,
    pauseCount: 2,
    totalPauseDurationSeconds: 3.5,
    averagePauseDurationSeconds: 1.75,
    intentionalPauseCount: 1,
    hesitationPauseCount: 1,
    classifiedPauses: [],
    energyVariationCoefficient: 0,
    energyProfile: { windowDurationMs: 250, windows: [], coefficientOfVariation: 0, silenceThreshold: 0 },
    classifiedFillers: [],
    ...overrides,
  };
}

function makeEvaluation(): StructuredEvaluation {
  return {
    opening: "That was a wonderful speech about leadership.",
    items: [
      {
        type: "commendation",
        summary: "Strong opening",
        evidence_quote: "Hello everyone today I want to talk about leadership",
        evidence_timestamp: 0,
        explanation: "You grabbed the audience's attention immediately.",
      },
      {
        type: "commendation",
        summary: "Clear structure",
        evidence_quote: "Hello everyone today I want to talk about leadership",
        evidence_timestamp: 0,
        explanation: "Your speech had a clear beginning, middle, and end.",
      },
      {
        type: "recommendation",
        summary: "Vary your pace",
        evidence_quote: "Hello everyone today I want to talk about leadership",
        evidence_timestamp: 0,
        explanation: "Consider slowing down at key moments for emphasis.",
      },
    ],
    closing: "Keep up the great work!",
    structure_commentary: {
      opening_comment: null,
      body_comment: null,
      closing_comment: null,
    },
  };
}

function makeMockDeps(): SessionManagerDeps {
  const segments = [makeSegment()];
  const metrics = makeMetrics();
  const evaluation = makeEvaluation();

  return {
    transcriptionEngine: {
      startLive: vi.fn(),
      feedAudio: vi.fn(),
      stopLive: vi.fn(),
      finalize: vi.fn().mockResolvedValue(segments),
      get qualityWarning() { return false; },
    } as any,
    metricsExtractor: {
      extract: vi.fn().mockReturnValue(metrics),
      computeEnergyProfile: vi.fn().mockReturnValue({
        windowDurationMs: 250,
        windows: [0.5, 0.8, 0.6],
        coefficientOfVariation: 0.2,
        silenceThreshold: 0.1,
      }),
    } as any,
    evaluationGenerator: {
      generate: vi.fn().mockResolvedValue({ evaluation, passRate: 1.0 }),
      validate: vi.fn().mockReturnValue({ valid: true, issues: [] }),
      renderScript: vi.fn().mockReturnValue("Rendered evaluation script text."),
      redact: vi.fn().mockReturnValue({
        scriptRedacted: "Redacted evaluation script text.",
        evaluationPublic: {
          opening: evaluation.opening,
          items: evaluation.items.map(i => ({
            type: i.type,
            summary: i.summary,
            explanation: i.explanation,
            evidence_quote: i.evidence_quote,
            evidence_timestamp: i.evidence_timestamp,
          })),
          closing: evaluation.closing,
          structure_commentary: evaluation.structure_commentary,
        },
      }),
      logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
    } as any,
    ttsEngine: {
      trimToFit: vi.fn().mockReturnValue("Rendered evaluation script text."),
      synthesize: vi.fn().mockResolvedValue(Buffer.from("fake-audio-data")),
      estimateDuration: vi.fn().mockReturnValue(120),
    } as any,
    toneChecker: {
      check: vi.fn().mockReturnValue({ passed: true, violations: [] }),
      stripViolations: vi.fn().mockImplementation((script: string) => script),
      stripMarkers: vi.fn().mockImplementation((script: string) =>
        script.replace(/\s*\[\[(Q|M):[^\]]+\]\]/g, "").replace(/\s{2,}/g, " ").trim()
      ),
      appendScopeAcknowledgment: vi.fn().mockImplementation((script: string) => script),
    } as any,
    filePersistence: {
      saveSession: vi.fn().mockResolvedValue([
        "output/2024-01-01_12-00-00_abc/transcript.txt",
        "output/2024-01-01_12-00-00_abc/metrics.json",
        "output/2024-01-01_12-00-00_abc/evaluation.txt",
      ]),
    } as any,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("SessionManager Pipeline Wiring", () => {
  let deps: SessionManagerDeps;
  let manager: SessionManager;

  beforeEach(() => {
    deps = makeMockDeps();
    manager = new SessionManager(deps);
  });

  // ─── Backward compatibility ───────────────────────────────────────────────

  describe("backward compatibility (no deps)", () => {
    it("state transitions work without injected dependencies", async () => {
      const noDepsManager = new SessionManager();
      const session = noDepsManager.createSession();

      noDepsManager.startRecording(session.id);
      expect(session.state).toBe(SessionState.RECORDING);

      await noDepsManager.stopRecording(session.id);
      expect(session.state).toBe(SessionState.PROCESSING);

      await noDepsManager.generateEvaluation(session.id);
      expect(session.state).toBe(SessionState.DELIVERING);

      noDepsManager.completeDelivery(session.id);
      expect(session.state).toBe(SessionState.IDLE);
    });

    it("panicMute works without injected dependencies", () => {
      const noDepsManager = new SessionManager();
      const session = noDepsManager.createSession();
      noDepsManager.startRecording(session.id);

      noDepsManager.panicMute(session.id);
      expect(session.state).toBe(SessionState.IDLE);
    });

    it("saveOutputs returns empty array without FilePersistence", async () => {
      const noDepsManager = new SessionManager();
      const session = noDepsManager.createSession();

      const paths = await noDepsManager.saveOutputs(session.id);
      expect(paths).toEqual([]);
    });
  });

  // ─── startRecording pipeline ──────────────────────────────────────────────

  describe("startRecording() pipeline", () => {
    it("calls TranscriptionEngine.startLive() with a callback", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      expect(deps.transcriptionEngine!.startLive).toHaveBeenCalledOnce();
      expect(deps.transcriptionEngine!.startLive).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it("clears previous session data on new recording", async () => {
      const session = manager.createSession();

      // First lifecycle: populate session data
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);
      manager.completeDelivery(session.id);

      // Verify data was populated
      expect(session.transcript.length).toBeGreaterThan(0);
      expect(session.metrics).not.toBeNull();
      expect(session.evaluation).not.toBeNull();

      // Second lifecycle: startRecording should clear everything
      manager.startRecording(session.id);

      expect(session.transcript).toEqual([]);
      expect(session.liveTranscript).toEqual([]);
      expect(session.audioChunks).toEqual([]);
      expect(session.metrics).toBeNull();
      expect(session.evaluation).toBeNull();
      expect(session.evaluationScript).toBeNull();
      expect(session.qualityWarning).toBe(false);
      expect(session.outputsSaved).toBe(false);
      expect(session.stoppedAt).toBeNull();
    });

    it("stores live transcript segments via the callback", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      // Get the callback that was passed to startLive
      const callback = (deps.transcriptionEngine!.startLive as any).mock.calls[0][0];
      const liveSegment = makeSegment({ text: "live caption", isFinal: false });

      callback(liveSegment);

      expect(session.liveTranscript).toHaveLength(1);
      expect(session.liveTranscript[0].text).toBe("live caption");
    });

    it("live transcript callback ignores segments after runId changes", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      const callback = (deps.transcriptionEngine!.startLive as any).mock.calls[0][0];

      // Simulate panic mute (increments runId)
      manager.panicMute(session.id);

      // Callback from old run should be ignored
      const liveSegment = makeSegment({ text: "stale segment" });
      callback(liveSegment);

      expect(session.liveTranscript).toHaveLength(0);
    });
  });

  // ─── stopRecording pipeline ───────────────────────────────────────────────

  describe("stopRecording() pipeline", () => {
    it("calls TranscriptionEngine.stopLive()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      await manager.stopRecording(session.id);

      expect(deps.transcriptionEngine!.stopLive).toHaveBeenCalledOnce();
    });

    it("concatenates audio chunks and calls finalize()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      // Simulate buffered audio chunks
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      session.audioChunks.push(Buffer.from([0x03, 0x04]));

      await manager.stopRecording(session.id);

      expect(deps.transcriptionEngine!.finalize).toHaveBeenCalledOnce();
      const calledWith = (deps.transcriptionEngine!.finalize as any).mock.calls[0][0];
      expect(calledWith).toBeInstanceOf(Buffer);
      expect(calledWith).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    });

    it("stores final transcript from finalize()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      expect(session.transcript).toHaveLength(1);
      expect(session.transcript[0].text).toContain("Hello everyone");
    });

    it("calls MetricsExtractor.extract() with final transcript", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      expect(deps.metricsExtractor!.extract).toHaveBeenCalledOnce();
      expect(deps.metricsExtractor!.extract).toHaveBeenCalledWith(session.transcript);
    });

    it("stores metrics from MetricsExtractor", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      expect(session.metrics).not.toBeNull();
      expect(session.metrics!.wordsPerMinute).toBe(125);
    });

    it("does not call finalize when no audio chunks buffered", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      // No audio chunks pushed

      await manager.stopRecording(session.id);

      expect(deps.transcriptionEngine!.finalize).not.toHaveBeenCalled();
    });

    it("does not call MetricsExtractor when transcript is empty", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      // No audio chunks → no transcript

      await manager.stopRecording(session.id);

      expect(deps.metricsExtractor!.extract).not.toHaveBeenCalled();
    });

    it("discards results if runId changes during finalize (panic mute)", async () => {
      // Make finalize() simulate panic mute happening during the async operation
      (deps.transcriptionEngine!.finalize as any).mockImplementation(
        async function (this: any) {
          // Simulate panic mute happening while finalize is in-flight
          const session = manager.getSession(arguments[0]?.sessionId ?? "");
          // We'll trigger panic mute from outside after calling stopRecording
          return [makeSegment()];
        },
      );

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      // Override finalize to panic mute mid-flight
      (deps.transcriptionEngine!.finalize as any).mockImplementation(async () => {
        manager.panicMute(session.id);
        return [makeSegment()];
      });

      await manager.stopRecording(session.id);

      // Results should be discarded because runId changed during finalize
      expect(session.transcript).toEqual([]);
      expect(session.metrics).toBeNull();
    });
  });

  // ─── generateEvaluation pipeline ──────────────────────────────────────────

  describe("generateEvaluation() pipeline", () => {
    async function setupForEvaluation() {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await manager.stopRecording(session.id);
      return session;
    }

    it("calls EvaluationGenerator.generate() with transcript and metrics", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.evaluationGenerator!.generate).toHaveBeenCalledOnce();
      expect(deps.evaluationGenerator!.generate).toHaveBeenCalledWith(
        session.transcript,
        session.metrics,
      );
    });

    it("calls EvaluationGenerator.renderScript() with evaluation, undefined speakerName, and metrics", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.evaluationGenerator!.renderScript).toHaveBeenCalledOnce();
      const generateResult = await (deps.evaluationGenerator!.generate as any).mock.results[0].value;
      expect(deps.evaluationGenerator!.renderScript).toHaveBeenCalledWith(
        generateResult.evaluation,
        undefined, // No speakerName — redaction happens at stage 7
        session.metrics,
      );
    });

    it("calls ToneChecker.check() with rendered script, evaluation, and metrics", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.toneChecker!.check).toHaveBeenCalledOnce();
      expect(deps.toneChecker!.check).toHaveBeenCalledWith(
        "Rendered evaluation script text.",
        expect.any(Object), // evaluation
        session.metrics,
      );
    });

    it("calls ToneChecker.stripMarkers() to remove markers after tone check", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.toneChecker!.stripMarkers).toHaveBeenCalledOnce();
    });

    it("calls TTSEngine.trimToFit() with session timeLimitSeconds", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.ttsEngine!.trimToFit).toHaveBeenCalledOnce();
      expect(deps.ttsEngine!.trimToFit).toHaveBeenCalledWith(
        expect.any(String),
        120, // session.timeLimitSeconds default
      );
    });

    it("calls ToneChecker.appendScopeAcknowledgment() after trimming", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.toneChecker!.appendScopeAcknowledgment).toHaveBeenCalledOnce();
      expect(deps.toneChecker!.appendScopeAcknowledgment).toHaveBeenCalledWith(
        expect.any(String),
        false, // qualityWarning
        false, // hasStructureCommentary (all null)
      );
    });

    it("calls TTSEngine.synthesize() with script (no redaction without consent)", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(deps.ttsEngine!.synthesize).toHaveBeenCalledOnce();
      // Without consent, no redaction is applied — synthesize receives the processed script
      expect(deps.ttsEngine!.synthesize).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    it("calls redact() and synthesizes redacted script when consent exists", async () => {
      const session = await setupForEvaluation();
      // Set consent directly on session (session is in PROCESSING state, can't use setConsent())
      session.consent = {
        speakerName: "Alice",
        consentConfirmed: true,
        consentTimestamp: new Date(),
      };

      await manager.generateEvaluation(session.id);

      expect((deps.evaluationGenerator as any).redact).toHaveBeenCalledOnce();
      expect((deps.evaluationGenerator as any).redact).toHaveBeenCalledWith({
        script: expect.any(String),
        evaluation: expect.any(Object),
        consent: session.consent,
      });
      // TTS should receive the redacted script
      expect(deps.ttsEngine!.synthesize).toHaveBeenCalledWith("Redacted evaluation script text.");
    });

    it("stores evaluationPublic on session when consent exists", async () => {
      const session = await setupForEvaluation();
      session.consent = {
        speakerName: "Alice",
        consentConfirmed: true,
        consentTimestamp: new Date(),
      };

      await manager.generateEvaluation(session.id);

      expect(session.evaluationPublic).not.toBeNull();
      expect(session.evaluationPublic!.opening).toBe("That was a wonderful speech about leadership.");
    });

    it("stores evaluation and script in session", async () => {
      const session = await setupForEvaluation();

      await manager.generateEvaluation(session.id);

      expect(session.evaluation).not.toBeNull();
      expect(session.evaluation!.opening).toBe("That was a wonderful speech about leadership.");
      expect(session.evaluationScript).toBe("Rendered evaluation script text.");
    });

    it("returns the synthesized audio buffer", async () => {
      const session = await setupForEvaluation();

      const audioBuffer = await manager.generateEvaluation(session.id);

      expect(audioBuffer).toBeInstanceOf(Buffer);
      expect(audioBuffer!.toString()).toBe("fake-audio-data");
    });

    it("returns undefined when no evaluation generator is available", async () => {
      const noDepsManager = new SessionManager();
      const session = noDepsManager.createSession();
      noDepsManager.startRecording(session.id);
      await noDepsManager.stopRecording(session.id);

      const result = await noDepsManager.generateEvaluation(session.id);

      expect(result).toBeUndefined();
    });

    it("returns undefined when no TTS engine is available", async () => {
      const noTtsDeps = { ...deps, ttsEngine: undefined };
      const noTtsManager = new SessionManager(noTtsDeps);
      const session = noTtsManager.createSession();
      noTtsManager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await noTtsManager.stopRecording(session.id);

      const result = await noTtsManager.generateEvaluation(session.id);

      expect(result).toBeUndefined();
      // But evaluation and script should still be stored
      expect(session.evaluation).not.toBeNull();
      expect(session.evaluationScript).not.toBeNull();
    });

    it("discards results if runId changes during generate (panic mute)", async () => {
      // Override generate to simulate panic mute mid-flight
      (deps.evaluationGenerator!.generate as any).mockImplementation(async () => {
        manager.panicMute(session.id);
        return { evaluation: makeEvaluation(), passRate: 1.0 };
      });

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await manager.stopRecording(session.id);

      const result = await manager.generateEvaluation(session.id);

      expect(result).toBeUndefined();
      expect(session.evaluation).toBeNull();
      expect(session.evaluationScript).toBeNull();
    });

    it("discards results if runId changes during synthesize (panic mute)", async () => {
      // Override synthesize to simulate panic mute mid-flight
      (deps.ttsEngine!.synthesize as any).mockImplementation(async () => {
        manager.panicMute(session.id);
        return Buffer.from("should-be-discarded");
      });

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await manager.stopRecording(session.id);

      const result = await manager.generateEvaluation(session.id);

      expect(result).toBeUndefined();
    });
  });

  // ─── panicMute pipeline ───────────────────────────────────────────────────

  describe("panicMute() pipeline", () => {
    it("calls TranscriptionEngine.stopLive() when in RECORDING state", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      // Reset the mock since startRecording also calls stopLive indirectly
      vi.clearAllMocks();

      manager.panicMute(session.id);

      expect(deps.transcriptionEngine!.stopLive).toHaveBeenCalledOnce();
    });

    it("preserves audio chunks after panicMute", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      session.audioChunks.push(Buffer.from([0x03, 0x04]));

      manager.panicMute(session.id);

      expect(session.audioChunks).toHaveLength(2);
    });

    it("handles stopLive() errors gracefully during panic mute", () => {
      (deps.transcriptionEngine!.stopLive as any).mockImplementation(() => {
        throw new Error("Not in live state");
      });

      const session = manager.createSession();
      manager.startRecording(session.id);

      // Should not throw
      expect(() => manager.panicMute(session.id)).not.toThrow();
      expect(session.state).toBe(SessionState.IDLE);
    });
  });

  // ─── saveOutputs pipeline ─────────────────────────────────────────────────

  describe("saveOutputs() pipeline", () => {
    it("calls FilePersistence.saveSession() with the session", async () => {
      const session = manager.createSession();

      const paths = await manager.saveOutputs(session.id);

      expect(deps.filePersistence!.saveSession).toHaveBeenCalledOnce();
      expect(deps.filePersistence!.saveSession).toHaveBeenCalledWith(session);
      expect(paths).toHaveLength(3);
    });

    it("returns saved file paths", async () => {
      const session = manager.createSession();

      const paths = await manager.saveOutputs(session.id);

      expect(paths).toContain("output/2024-01-01_12-00-00_abc/transcript.txt");
      expect(paths).toContain("output/2024-01-01_12-00-00_abc/metrics.json");
      expect(paths).toContain("output/2024-01-01_12-00-00_abc/evaluation.txt");
    });
  });

  // ─── Transcript quality assessment ────────────────────────────────────────

  describe("transcript quality assessment", () => {
    it("sets qualityWarning=false for normal transcript", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      // Default mock metrics have 125 WPM and 0.95 confidence
      expect(session.qualityWarning).toBe(false);
    });

    it("sets qualityWarning=true when WPM is below threshold", async () => {
      // Override metrics to have very low WPM
      (deps.metricsExtractor!.extract as any).mockReturnValue(
        makeMetrics({
          durationSeconds: 120,
          totalWords: 15, // 7.5 WPM — below 10 threshold
          wordsPerMinute: 7.5,
        }),
      );

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      expect(session.qualityWarning).toBe(true);
    });

    it("sets qualityWarning=true when average confidence is below threshold", async () => {
      // Override finalize to return low-confidence words
      const lowConfSegment = makeSegment();
      lowConfSegment.words = lowConfSegment.words.map((w) => ({
        ...w,
        confidence: 0.3, // below 0.5 threshold
      }));
      (deps.transcriptionEngine!.finalize as any).mockResolvedValue([lowConfSegment]);

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      expect(session.qualityWarning).toBe(true);
    });

    it("does not set qualityWarning when transcript has no words (segment-level only)", async () => {
      // Segment-level fallback: no word-level timestamps
      const segmentOnly = makeSegment();
      segmentOnly.words = [];
      (deps.transcriptionEngine!.finalize as any).mockResolvedValue([segmentOnly]);

      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      await manager.stopRecording(session.id);

      // No words to check confidence on, and metrics WPM is above threshold
      expect(session.qualityWarning).toBe(false);
    });
  });

  // ─── Error handling flows (Task 12.2) ──────────────────────────────────────

  describe("error handling flows", () => {
    // ─── Post-pass failure → fall back to Deepgram segments (Req 7.1) ─────

    describe("post-pass transcription failure", () => {
      it("falls back to finalized live transcript segments when finalize() throws", async () => {
        (deps.transcriptionEngine!.finalize as any).mockRejectedValue(
          new Error("OpenAI transcription API error"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));

        // Simulate live transcript segments captured during recording
        const liveCallback = (deps.transcriptionEngine!.startLive as any).mock.calls[0][0];
        liveCallback(makeSegment({ text: "live final segment", isFinal: true }));
        liveCallback(makeSegment({ text: "live interim segment", isFinal: false }));

        await manager.stopRecording(session.id);

        // Should fall back to finalized live segments only
        expect(session.transcript).toHaveLength(1);
        expect(session.transcript[0].text).toBe("live final segment");
        expect(session.qualityWarning).toBe(true);
        expect(session.state).toBe(SessionState.PROCESSING);
      });

      it("sets empty transcript when finalize() throws and no live segments exist", async () => {
        (deps.transcriptionEngine!.finalize as any).mockRejectedValue(
          new Error("OpenAI transcription API error"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        // No live transcript segments

        await manager.stopRecording(session.id);

        expect(session.transcript).toEqual([]);
        expect(session.qualityWarning).toBe(true);
      });

      it("still extracts metrics from fallback segments", async () => {
        (deps.transcriptionEngine!.finalize as any).mockRejectedValue(
          new Error("OpenAI transcription API error"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));

        // Simulate a finalized live segment
        const liveCallback = (deps.transcriptionEngine!.startLive as any).mock.calls[0][0];
        liveCallback(makeSegment({ text: "live final segment", isFinal: true }));

        await manager.stopRecording(session.id);

        expect(deps.metricsExtractor!.extract).toHaveBeenCalledOnce();
        expect(session.metrics).not.toBeNull();
      });
    });

    // ─── Transcription drop → quality warning (Req 7.1) ──────────────────

    describe("transcription drop quality warning", () => {
      it("propagates transcriptionEngine.qualityWarning to session", async () => {
        // Simulate Deepgram connection drop by setting qualityWarning on the engine
        Object.defineProperty(deps.transcriptionEngine!, "qualityWarning", {
          get: () => true,
          configurable: true,
        });

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));

        await manager.stopRecording(session.id);

        expect(session.qualityWarning).toBe(true);
      });

      it("does not downgrade qualityWarning from engine even if transcript quality is fine", async () => {
        Object.defineProperty(deps.transcriptionEngine!, "qualityWarning", {
          get: () => true,
          configurable: true,
        });

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));

        await manager.stopRecording(session.id);

        // Even though metrics are fine (125 WPM, high confidence), qualityWarning stays true
        expect(session.qualityWarning).toBe(true);
      });
    });

    // ─── LLM failure → allow retry (Req 7.3) ─────────────────────────────

    describe("LLM failure", () => {
      it("transitions back to PROCESSING when generate() throws", async () => {
        (deps.evaluationGenerator!.generate as any).mockRejectedValue(
          new Error("OpenAI API rate limit exceeded"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        await expect(manager.generateEvaluation(session.id)).rejects.toThrow(
          "OpenAI API rate limit exceeded",
        );

        // Session should be back in PROCESSING so operator can retry
        expect(session.state).toBe(SessionState.PROCESSING);
        expect(session.evaluation).toBeNull();
        expect(session.evaluationScript).toBeNull();
      });

      it("allows retry after LLM failure", async () => {
        // First call fails
        (deps.evaluationGenerator!.generate as any).mockRejectedValueOnce(
          new Error("OpenAI API timeout"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        // First attempt fails
        await expect(manager.generateEvaluation(session.id)).rejects.toThrow();
        expect(session.state).toBe(SessionState.PROCESSING);

        // Second attempt succeeds (mock returns default evaluation)
        (deps.evaluationGenerator!.generate as any).mockResolvedValueOnce({ evaluation: makeEvaluation(), passRate: 1.0 });
        const audioBuffer = await manager.generateEvaluation(session.id);

        expect(session.state).toBe(SessionState.DELIVERING);
        expect(session.evaluation).not.toBeNull();
        expect(audioBuffer).toBeInstanceOf(Buffer);
      });

      it("does not transition back to PROCESSING if runId changed during generate failure", async () => {
        (deps.evaluationGenerator!.generate as any).mockImplementation(async () => {
          manager.panicMute(session.id);
          throw new Error("LLM error after panic mute");
        });

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        await expect(manager.generateEvaluation(session.id)).rejects.toThrow();

        // panicMute already set state to IDLE, should not be overwritten to PROCESSING
        expect(session.state).toBe(SessionState.IDLE);
      });
    });

    // ─── TTS failure → written evaluation fallback (Req 7.4) ─────────────

    describe("TTS failure", () => {
      it("returns undefined when synthesize() throws but keeps evaluation and script", async () => {
        (deps.ttsEngine!.synthesize as any).mockRejectedValue(
          new Error("OpenAI TTS API error"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        const result = await manager.generateEvaluation(session.id);

        // No audio returned
        expect(result).toBeUndefined();

        // But evaluation and script are preserved for written fallback
        expect(session.evaluation).not.toBeNull();
        expect(session.evaluationScript).not.toBeNull();
        expect(session.state).toBe(SessionState.DELIVERING);
      });

      it("does not throw when TTS fails", async () => {
        (deps.ttsEngine!.synthesize as any).mockRejectedValue(
          new Error("TTS service unavailable"),
        );

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        // Should not throw — TTS failure is handled gracefully
        await expect(manager.generateEvaluation(session.id)).resolves.toBeUndefined();
      });
    });
  });

  // ─── Full pipeline integration ────────────────────────────────────────────

  describe("full pipeline integration", () => {
    it("completes full lifecycle: start → stop → evaluate → deliver → save", async () => {
      const session = manager.createSession();
      expect(session.state).toBe(SessionState.IDLE);

      // Start recording
      manager.startRecording(session.id);
      expect(session.state).toBe(SessionState.RECORDING);
      expect(deps.transcriptionEngine!.startLive).toHaveBeenCalled();

      // Simulate audio buffering
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      session.audioChunks.push(Buffer.from([0x03, 0x04]));

      // Stop recording
      await manager.stopRecording(session.id);
      expect(session.state).toBe(SessionState.PROCESSING);
      expect(session.transcript.length).toBeGreaterThan(0);
      expect(session.metrics).not.toBeNull();

      // Generate evaluation
      const audioBuffer = await manager.generateEvaluation(session.id);
      expect(session.state).toBe(SessionState.DELIVERING);
      expect(session.evaluation).not.toBeNull();
      expect(session.evaluationScript).not.toBeNull();
      expect(audioBuffer).toBeInstanceOf(Buffer);

      // Complete delivery
      manager.completeDelivery(session.id);
      expect(session.state).toBe(SessionState.IDLE);

      // Save outputs
      const paths = await manager.saveOutputs(session.id);
      expect(paths).toHaveLength(3);
    });

    it("handles panic mute during recording and allows restart", async () => {
      const session = manager.createSession();

      // Start and record
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));

      // Panic mute
      manager.panicMute(session.id);
      expect(session.state).toBe(SessionState.IDLE);
      expect(session.audioChunks).toHaveLength(1); // preserved

      // Restart
      manager.startRecording(session.id);
      expect(session.state).toBe(SessionState.RECORDING);
      expect(session.audioChunks).toEqual([]); // cleared on new recording
    });
  });

  // ─── Phase 2 Pipeline Stages (Task 11.1) ──────────────────────────────────

  describe("Phase 2 pipeline stages", () => {
    async function setupForEvaluation() {
      const session = manager.createSession();
      manager.startRecording(session.id);
      session.audioChunks.push(Buffer.from([0x01, 0x02]));
      await manager.stopRecording(session.id);
      return session;
    }

    // ─── Energy profile computation ─────────────────────────────────────

    describe("energy profile computation", () => {
      it("calls MetricsExtractor.computeEnergyProfile() with audio chunks", async () => {
        const session = await setupForEvaluation();

        await manager.generateEvaluation(session.id);

        expect(deps.metricsExtractor!.computeEnergyProfile).toHaveBeenCalledOnce();
        expect(deps.metricsExtractor!.computeEnergyProfile).toHaveBeenCalledWith(
          session.audioChunks,
        );
      });

      it("updates metrics with energy profile data", async () => {
        const session = await setupForEvaluation();

        await manager.generateEvaluation(session.id);

        expect(session.metrics!.energyVariationCoefficient).toBe(0.2);
        expect(session.metrics!.energyProfile.coefficientOfVariation).toBe(0.2);
        expect(session.metrics!.energyProfile.windows).toEqual([0.5, 0.8, 0.6]);
      });
    });

    // ─── Tone check pipeline ────────────────────────────────────────────

    describe("tone check pipeline", () => {
      it("strips violations when tone check fails", async () => {
        const violation = {
          category: "psychological_inference" as const,
          sentence: "You seemed nervous.",
          pattern: "seemed nervous",
          explanation: "Psychological inference",
        };
        (deps.toneChecker!.check as any).mockReturnValue({
          passed: false,
          violations: [violation],
        });

        const session = await setupForEvaluation();
        await manager.generateEvaluation(session.id);

        expect(deps.toneChecker!.stripViolations).toHaveBeenCalledOnce();
        expect(deps.toneChecker!.stripViolations).toHaveBeenCalledWith(
          expect.any(String),
          [violation],
        );
        // stripMarkers should still be called after stripViolations
        expect(deps.toneChecker!.stripMarkers).toHaveBeenCalledOnce();
      });

      it("does not call stripViolations when tone check passes", async () => {
        const session = await setupForEvaluation();
        await manager.generateEvaluation(session.id);

        expect(deps.toneChecker!.stripViolations).not.toHaveBeenCalled();
        // stripMarkers is always called
        expect(deps.toneChecker!.stripMarkers).toHaveBeenCalledOnce();
      });

      it("markers are stripped before script reaches TTS", async () => {
        // renderScript returns a script with markers
        (deps.evaluationGenerator!.renderScript as any).mockReturnValue(
          "Great opening. [[Q:item-0]] Your pace was steady. [[M:wordsPerMinute]] Keep it up."
        );
        // stripMarkers removes them
        (deps.toneChecker!.stripMarkers as any).mockReturnValue(
          "Great opening. Your pace was steady. Keep it up."
        );

        const session = await setupForEvaluation();
        await manager.generateEvaluation(session.id);

        // TTS should receive the marker-free script
        const synthesizeArg = (deps.ttsEngine!.synthesize as any).mock.calls[0][0];
        expect(synthesizeArg).not.toContain("[[Q:");
        expect(synthesizeArg).not.toContain("[[M:");
      });
    });

    // ─── Scope acknowledgment ───────────────────────────────────────────

    describe("scope acknowledgment", () => {
      it("passes hasStructureCommentary=true when structure commentary exists", async () => {
        // Override generate to return evaluation with structure commentary
        const evalWithCommentary = makeEvaluation();
        evalWithCommentary.structure_commentary = {
          opening_comment: "Strong opening hook.",
          body_comment: null,
          closing_comment: null,
        };
        (deps.evaluationGenerator!.generate as any).mockResolvedValue({
          evaluation: evalWithCommentary,
          passRate: 1.0,
        });

        const session = await setupForEvaluation();
        await manager.generateEvaluation(session.id);

        expect(deps.toneChecker!.appendScopeAcknowledgment).toHaveBeenCalledWith(
          expect.any(String),
          false, // qualityWarning
          true,  // hasStructureCommentary
        );
      });

      it("passes qualityWarning=true when session has quality warning", async () => {
        const session = await setupForEvaluation();
        session.qualityWarning = true;

        await manager.generateEvaluation(session.id);

        expect(deps.toneChecker!.appendScopeAcknowledgment).toHaveBeenCalledWith(
          expect.any(String),
          true,  // qualityWarning
          false, // hasStructureCommentary
        );
      });
    });

    // ─── Pass rate storage ──────────────────────────────────────────────

    describe("pass rate storage", () => {
      it("stores evaluationPassRate on session from generate result", async () => {
        (deps.evaluationGenerator!.generate as any).mockResolvedValue({
          evaluation: makeEvaluation(),
          passRate: 0.75,
        });

        const session = await setupForEvaluation();
        await manager.generateEvaluation(session.id);

        expect(session.evaluationPassRate).toBe(0.75);
      });
    });

    // ─── Redaction and public evaluation ────────────────────────────────

    describe("redaction and public evaluation", () => {
      it("does not call redact() when no consent exists", async () => {
        const session = await setupForEvaluation();
        expect(session.consent).toBeNull();

        await manager.generateEvaluation(session.id);

        expect((deps.evaluationGenerator as any).redact).not.toHaveBeenCalled();
        expect(session.evaluationPublic).toBeNull();
      });

      it("stores evaluationPublic as null when no consent", async () => {
        const session = await setupForEvaluation();

        await manager.generateEvaluation(session.id);

        expect(session.evaluationPublic).toBeNull();
      });

      it("stores redacted evaluationScript when consent exists", async () => {
        const session = await setupForEvaluation();
        session.consent = {
          speakerName: "Alice",
          consentConfirmed: true,
          consentTimestamp: new Date(),
        };

        await manager.generateEvaluation(session.id);

        expect(session.evaluationScript).toBe("Redacted evaluation script text.");
      });
    });

    // ─── RunId cancellation at async boundaries ─────────────────────────

    describe("runId cancellation at async boundaries", () => {
      it("discards results if runId changes during TTS synthesis", async () => {
        (deps.ttsEngine!.synthesize as any).mockImplementation(async () => {
          manager.panicMute(session.id);
          return Buffer.from("should-be-discarded");
        });

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        const result = await manager.generateEvaluation(session.id);

        expect(result).toBeUndefined();
        expect(session.ttsAudioCache).toBeNull();
      });

      it("discards results if runId changes during LLM generation", async () => {
        (deps.evaluationGenerator!.generate as any).mockImplementation(async () => {
          manager.panicMute(session.id);
          return { evaluation: makeEvaluation(), passRate: 1.0 };
        });

        const session = manager.createSession();
        manager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await manager.stopRecording(session.id);

        const result = await manager.generateEvaluation(session.id);

        expect(result).toBeUndefined();
        expect(session.evaluation).toBeNull();
      });
    });

    // ─── Pipeline without ToneChecker (backward compat) ─────────────────

    describe("pipeline without ToneChecker", () => {
      it("strips markers via regex fallback when no ToneChecker is configured", async () => {
        const noToneDeps = { ...makeMockDeps(), toneChecker: undefined };
        const noToneManager = new SessionManager(noToneDeps);
        const session = noToneManager.createSession();
        noToneManager.startRecording(session.id);
        session.audioChunks.push(Buffer.from([0x01, 0x02]));
        await noToneManager.stopRecording(session.id);

        // renderScript returns script with markers
        (noToneDeps.evaluationGenerator!.renderScript as any).mockReturnValue(
          "Great speech. [[Q:item-0]] Keep it up. [[M:wordsPerMinute]]"
        );

        await noToneManager.generateEvaluation(session.id);

        // Script should have markers stripped
        expect(session.evaluationScript).not.toContain("[[Q:");
        expect(session.evaluationScript).not.toContain("[[M:");
      });
    });
  });
});
