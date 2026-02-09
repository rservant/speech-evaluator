// Property-Based Tests for SessionManager - TTS Audio Cache Lifecycle
// Feature: tts-audio-replay-and-save, Properties 1–4

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { SessionManager } from "./session-manager.js";
import { SessionState } from "./types.js";
import type {
  StructuredEvaluation,
  TranscriptSegment,
  DeliveryMetrics,
} from "./types.js";
import type { EvaluationGenerator } from "./evaluation-generator.js";
import type { TTSEngine } from "./tts-engine.js";
import { purgeSessionData } from "./server.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal valid StructuredEvaluation for mocking */
function makeEvaluation(): StructuredEvaluation {
  return {
    opening: "Great speech.",
    items: [
      {
        type: "commendation",
        summary: "Good opening",
        evidence_quote: "hello world this is a test of speech",
        evidence_timestamp: 1,
        explanation: "Strong start",
      },
      {
        type: "commendation",
        summary: "Clear structure",
        evidence_quote: "the main point I want to make today",
        evidence_timestamp: 10,
        explanation: "Well organized",
      },
      {
        type: "recommendation",
        summary: "Slow down",
        evidence_quote: "and then I went to the next part",
        evidence_timestamp: 30,
        explanation: "Pacing was fast",
      },
    ],
    closing: "Well done overall.",
  };
}

/** Minimal transcript segment for setting up sessions */
function makeTranscript(): TranscriptSegment[] {
  return [
    {
      text: "hello world this is a test of speech",
      startTime: 0,
      endTime: 10,
      words: [],
      isFinal: true,
    },
  ];
}

/** Minimal delivery metrics for setting up sessions */
function makeMetrics(): DeliveryMetrics {
  return {
    durationSeconds: 60,
    durationFormatted: "1:00",
    totalWords: 100,
    wordsPerMinute: 100,
    fillerWords: [],
    fillerWordCount: 0,
    fillerWordFrequency: 0,
    pauseCount: 0,
    totalPauseDurationSeconds: 0,
    averagePauseDurationSeconds: 0,
  };
}

/**
 * Generator for random audio buffers between 1KB and 100KB.
 * Represents any possible TTS audio output.
 */
function arbitraryAudioBuffer(): fc.Arbitrary<Buffer> {
  return fc
    .integer({ min: 1024, max: 102400 })
    .chain((size) =>
      fc.uint8Array({ minLength: size, maxLength: size }).map((arr) => Buffer.from(arr)),
    );
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: tts-audio-replay-and-save, Property 1: TTS audio cache stored after synthesis", () => {
  /**
   * **Validates: Requirements 1.1**
   *
   * For any session where TTS synthesis succeeds, the session's `ttsAudioCache`
   * field SHALL equal the buffer returned by `TTSEngine.synthesize()`, and
   * `generateEvaluation()` SHALL return that same buffer.
   */
  it("stores synthesized audio buffer in session.ttsAudioCache and returns it", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAudioBuffer(), async (audioBuffer) => {
        // Create mocks for the full pipeline
        const mockEvaluationGenerator = {
          generate: vi.fn().mockResolvedValue(makeEvaluation()),
          renderScript: vi.fn().mockReturnValue("This is the evaluation script."),
          validate: vi.fn(),
        } as unknown as EvaluationGenerator;

        const mockTtsEngine = {
          trimToFit: vi.fn().mockImplementation((text: string) => text),
          synthesize: vi.fn().mockResolvedValue(audioBuffer),
          estimateDuration: vi.fn().mockReturnValue(60),
        } as unknown as TTSEngine;

        const sm = new SessionManager({
          evaluationGenerator: mockEvaluationGenerator,
          ttsEngine: mockTtsEngine,
        });

        const session = sm.createSession();
        const sessionId = session.id;

        // Set up session state: needs transcript and metrics, state must be PROCESSING
        session.transcript = makeTranscript();
        session.metrics = makeMetrics();
        session.state = SessionState.PROCESSING;

        // Call generateEvaluation — this should store the audio buffer
        const result = await sm.generateEvaluation(sessionId);

        // PROPERTY ASSERTION: ttsAudioCache equals the buffer from synthesize()
        expect(session.ttsAudioCache).toBe(audioBuffer);

        // PROPERTY ASSERTION: return value equals the same buffer
        expect(result).toBe(audioBuffer);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: tts-audio-replay-and-save, Property 2: Panic mute preserves TTS audio cache", () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any session that holds a non-null `ttsAudioCache`, calling `panicMute()`
   * SHALL leave `ttsAudioCache` unchanged (same buffer reference).
   */
  it("preserves ttsAudioCache after panicMute()", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAudioBuffer(), async (audioBuffer) => {
        const sm = new SessionManager();
        const session = sm.createSession();

        // Set ttsAudioCache and put session in a non-IDLE state
        session.ttsAudioCache = audioBuffer;
        session.state = SessionState.DELIVERING;

        // Call panicMute
        sm.panicMute(session.id);

        // PROPERTY ASSERTION: ttsAudioCache is unchanged (same reference)
        expect(session.ttsAudioCache).toBe(audioBuffer);
        // Session should be back to IDLE
        expect(session.state).toBe(SessionState.IDLE);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: tts-audio-replay-and-save, Property 3: Purge clears TTS audio cache", () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * For any session that holds a non-null `ttsAudioCache`, calling
   * `purgeSessionData()` SHALL set `ttsAudioCache` to `null`.
   */
  it("clears ttsAudioCache after purgeSessionData()", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAudioBuffer(), async (audioBuffer) => {
        const sm = new SessionManager();
        const session = sm.createSession();

        // Set ttsAudioCache
        session.ttsAudioCache = audioBuffer;
        expect(session.ttsAudioCache).not.toBeNull();

        // Call purgeSessionData
        purgeSessionData(session);

        // PROPERTY ASSERTION: ttsAudioCache is null
        expect(session.ttsAudioCache).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: tts-audio-replay-and-save, Property 4: New recording clears TTS audio cache", () => {
  /**
   * **Validates: Requirements 1.5**
   *
   * For any session in IDLE state that holds a non-null `ttsAudioCache`,
   * calling `startRecording()` SHALL set `ttsAudioCache` to `null`.
   */
  it("clears ttsAudioCache after startRecording()", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAudioBuffer(), async (audioBuffer) => {
        const sm = new SessionManager();
        const session = sm.createSession();

        // Set ttsAudioCache on an IDLE session
        session.ttsAudioCache = audioBuffer;
        expect(session.state).toBe(SessionState.IDLE);

        // Call startRecording
        sm.startRecording(session.id);

        // PROPERTY ASSERTION: ttsAudioCache is null
        expect(session.ttsAudioCache).toBeNull();
        // Session should now be RECORDING
        expect(session.state).toBe(SessionState.RECORDING);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: tts-audio-replay-and-save, Property 5: Replay returns cached buffer and transitions state", () => {
  /**
   * **Validates: Requirements 2.1, 2.4**
   *
   * For any session in IDLE state with a non-null `ttsAudioCache`, calling
   * `replayTTS()` SHALL return a buffer equal to `ttsAudioCache` AND transition
   * the session state to DELIVERING. Subsequently calling `completeDelivery()`
   * SHALL transition the session back to IDLE.
   */
  it("returns cached buffer, transitions to DELIVERING, and completeDelivery returns to IDLE", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAudioBuffer(), async (audioBuffer) => {
        const sm = new SessionManager();
        const session = sm.createSession();

        // Set ttsAudioCache on an IDLE session
        session.ttsAudioCache = audioBuffer;
        expect(session.state).toBe(SessionState.IDLE);

        // Call replayTTS
        const result = sm.replayTTS(session.id);

        // PROPERTY ASSERTION: return value equals the cached buffer
        expect(result).toBe(audioBuffer);

        // PROPERTY ASSERTION: state transitioned to DELIVERING
        expect(session.state).toBe(SessionState.DELIVERING);

        // Call completeDelivery to transition back
        sm.completeDelivery(session.id);

        // PROPERTY ASSERTION: state is back to IDLE
        expect(session.state).toBe(SessionState.IDLE);
      }),
      { numRuns: 100 },
    );
  });
});
