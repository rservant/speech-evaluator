// Property-Based Tests for SessionManager - TTS Audio Cache Lifecycle
// Feature: tts-audio-replay-and-save, Properties 1–4

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { SessionManager } from "./session-manager.js";
import { SessionState } from "./types.js";
import type {
  StructuredEvaluation,
  TranscriptSegment,
  TranscriptWord,
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
    structure_commentary: {
      opening_comment: null,
      body_comment: null,
      closing_comment: null,
    },
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
          generate: vi.fn().mockResolvedValue({ evaluation: makeEvaluation(), passRate: 1.0 }),
          renderScript: vi.fn().mockReturnValue("This is the evaluation script."),
          validate: vi.fn(),
          logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
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

// ─── Phase 2 Property Tests ─────────────────────────────────────────────────────

describe("Feature: phase-2-stability-credibility, Property 2: Consent Record Immutability", () => {
  /**
   * **Validates: Requirements 2.4**
   *
   * For any Session where recording has started (state is not IDLE), attempting
   * to modify the ConsentRecord (change speakerName or consentConfirmed) SHALL
   * fail, and the ConsentRecord SHALL remain unchanged from its value at the
   * time recording began. Immutability is derived from Session.state !== IDLE,
   * not from a stored boolean.
   */

  /**
   * Generator for non-empty speaker names (trimmed, printable strings).
   * Avoids empty strings since a speaker name should be meaningful.
   */
  const arbitrarySpeakerName = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

  /**
   * Generator for non-IDLE session states — these are the states where
   * consent should be immutable.
   */
  const arbitraryNonIdleState = (): fc.Arbitrary<SessionState> =>
    fc.constantFrom(
      SessionState.RECORDING,
      SessionState.PROCESSING,
      SessionState.DELIVERING,
    );

  it("rejects consent modification when session state is not IDLE and preserves original consent", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySpeakerName(),
        fc.boolean(),
        arbitrarySpeakerName(),
        fc.boolean(),
        arbitraryNonIdleState(),
        async (
          initialName,
          initialConsent,
          newName,
          newConsent,
          nonIdleState,
        ) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Step 1: Set initial consent while in IDLE state
          sm.setConsent(sessionId, initialName, initialConsent);

          // Capture the consent record values after setting
          const originalSpeakerName = session.consent!.speakerName;
          const originalConsentConfirmed = session.consent!.consentConfirmed;
          const originalTimestamp = session.consent!.consentTimestamp;

          // Step 2: Transition session to a non-IDLE state
          // We directly set the state to simulate any non-IDLE condition
          // (startRecording requires IDLE and clears data, so we set state directly
          // to test all non-IDLE states uniformly)
          session.state = nonIdleState;

          // Step 3: Attempt to modify consent — should throw
          expect(() => {
            sm.setConsent(sessionId, newName, newConsent);
          }).toThrow();

          // Step 4: Verify the ConsentRecord is unchanged
          expect(session.consent).not.toBeNull();
          expect(session.consent!.speakerName).toBe(originalSpeakerName);
          expect(session.consent!.consentConfirmed).toBe(originalConsentConfirmed);
          expect(session.consent!.consentTimestamp).toBe(originalTimestamp);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("allows consent modification when session is in IDLE state", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySpeakerName(),
        fc.boolean(),
        arbitrarySpeakerName(),
        fc.boolean(),
        async (firstName, firstConsent, secondName, secondConsent) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set initial consent in IDLE — should succeed
          sm.setConsent(sessionId, firstName, firstConsent);
          expect(session.consent!.speakerName).toBe(firstName);
          expect(session.consent!.consentConfirmed).toBe(firstConsent);

          // Modify consent while still in IDLE — should also succeed
          sm.setConsent(sessionId, secondName, secondConsent);
          expect(session.consent!.speakerName).toBe(secondName);
          expect(session.consent!.consentConfirmed).toBe(secondConsent);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves consent immutability through startRecording state transition", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySpeakerName(),
        arbitrarySpeakerName(),
        fc.boolean(),
        async (initialName, newName, newConsent) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set consent and confirm it (consent must be confirmed to start recording)
          sm.setConsent(sessionId, initialName, true);

          const originalSpeakerName = session.consent!.speakerName;
          const originalConsentConfirmed = session.consent!.consentConfirmed;

          // Start recording — transitions to RECORDING state
          sm.startRecording(sessionId);
          expect(session.state).toBe(SessionState.RECORDING);

          // Attempt to modify consent after recording started — should throw
          expect(() => {
            sm.setConsent(sessionId, newName, newConsent);
          }).toThrow();

          // Consent record must remain unchanged
          expect(session.consent).not.toBeNull();
          expect(session.consent!.speakerName).toBe(originalSpeakerName);
          expect(session.consent!.consentConfirmed).toBe(originalConsentConfirmed);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Phase 2 Property 4: Session Data Purge Completeness ────────────────────────

describe("Feature: phase-2-stability-credibility, Property 4: Session Data Purge Completeness", () => {
  /**
   * **Validates: Requirements 2.7, 8.6, 8.7**
   *
   * For any Session with transcript, metrics, evaluation, audio chunks, and
   * evaluation script data, after a purge operation (either opt-out or auto-purge),
   * all of these fields SHALL be null, the ttsAudioCache SHALL be null, and the
   * Session object SHALL still exist with a valid id and state.
   */

  // ─── Generators ─────────────────────────────────────────────────────────────

  /** Generator for TranscriptSegment arrays with valid structure */
  const arbitraryTranscriptSegments = (): fc.Arbitrary<TranscriptSegment[]> =>
    fc
      .array(
        fc.record({
          text: fc.string({ minLength: 1, maxLength: 100 }),
          startTime: fc.float({ min: 0, max: 600, noNaN: true }),
          endTime: fc.float({ min: 0, max: 600, noNaN: true }),
          words: fc.constant([] as TranscriptWord[]),
          isFinal: fc.boolean(),
        }),
        { minLength: 1, maxLength: 10 },
      )
      .map((segments) =>
        segments.map((seg) => ({
          ...seg,
          endTime: Math.max(seg.startTime + 0.1, seg.endTime),
        })),
      );

  /** Generator for ClassifiedPause arrays */
  const arbitraryClassifiedPauses = (): fc.Arbitrary<
    import("./types.js").ClassifiedPause[]
  > =>
    fc.array(
      fc.record({
        start: fc.float({ min: 0, max: 600, noNaN: true }),
        end: fc.float({ min: 0, max: 600, noNaN: true }),
        duration: fc.float({ min: Math.fround(0.3), max: 10, noNaN: true }),
        type: fc.constantFrom("intentional" as const, "hesitation" as const),
        reason: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      { minLength: 0, maxLength: 5 },
    );

  /** Generator for EnergyProfile */
  const arbitraryEnergyProfile = (): fc.Arbitrary<
    import("./types.js").EnergyProfile
  > =>
    fc.record({
      windowDurationMs: fc.constant(250),
      windows: fc.array(fc.float({ min: 0, max: 1, noNaN: true }), {
        minLength: 1,
        maxLength: 20,
      }),
      coefficientOfVariation: fc.float({ min: 0, max: 2, noNaN: true }),
      silenceThreshold: fc.float({ min: 0, max: 1, noNaN: true }),
    });

  /** Generator for ClassifiedFillerEntry arrays */
  const arbitraryClassifiedFillers = (): fc.Arbitrary<
    import("./types.js").ClassifiedFillerEntry[]
  > =>
    fc.array(
      fc.record({
        word: fc.constantFrom("um", "uh", "like", "so", "actually"),
        count: fc.integer({ min: 1, max: 10 }),
        timestamps: fc.array(fc.float({ min: 0, max: 600, noNaN: true }), {
          minLength: 1,
          maxLength: 5,
        }),
        classification: fc.constantFrom(
          "true_filler" as const,
          "discourse_marker" as const,
        ),
      }),
      { minLength: 0, maxLength: 5 },
    );

  /** Generator for DeliveryMetrics with all Phase 2 fields */
  const arbitraryDeliveryMetrics = (): fc.Arbitrary<DeliveryMetrics> =>
    fc
      .tuple(
        fc.float({ min: 1, max: 600, noNaN: true }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        arbitraryClassifiedPauses(),
        fc.float({ min: 0, max: 2, noNaN: true }),
        arbitraryEnergyProfile(),
        arbitraryClassifiedFillers(),
      )
      .map(
        ([
          durationSeconds,
          totalWords,
          fillerWordCount,
          intentionalPauseCount,
          hesitationPauseCount,
          classifiedPauses,
          energyVariationCoefficient,
          energyProfile,
          classifiedFillers,
        ]) => ({
          durationSeconds,
          durationFormatted: `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, "0")}`,
          totalWords,
          wordsPerMinute:
            durationSeconds > 0
              ? Math.round((totalWords / durationSeconds) * 60)
              : 0,
          fillerWords: [],
          fillerWordCount,
          fillerWordFrequency:
            durationSeconds > 0
              ? Math.round((fillerWordCount / (durationSeconds / 60)) * 10) / 10
              : 0,
          pauseCount: intentionalPauseCount + hesitationPauseCount,
          totalPauseDurationSeconds: classifiedPauses.reduce(
            (sum, p) => sum + p.duration,
            0,
          ),
          averagePauseDurationSeconds:
            classifiedPauses.length > 0
              ? classifiedPauses.reduce((sum, p) => sum + p.duration, 0) /
                classifiedPauses.length
              : 0,
          intentionalPauseCount,
          hesitationPauseCount,
          classifiedPauses,
          energyVariationCoefficient,
          energyProfile,
          classifiedFillers,
        }),
      );

  /** Generator for StructureCommentary */
  const arbitraryStructureCommentary = (): fc.Arbitrary<
    import("./types.js").StructureCommentary
  > =>
    fc.record({
      opening_comment: fc.option(
        fc.string({ minLength: 1, maxLength: 100 }),
        { nil: null },
      ),
      body_comment: fc.option(
        fc.string({ minLength: 1, maxLength: 100 }),
        { nil: null },
      ),
      closing_comment: fc.option(
        fc.string({ minLength: 1, maxLength: 100 }),
        { nil: null },
      ),
    });

  /** Generator for StructuredEvaluation with structure_commentary */
  const arbitraryStructuredEvaluation =
    (): fc.Arbitrary<StructuredEvaluation> =>
      fc.record({
        opening: fc.string({ minLength: 1, maxLength: 200 }),
        items: fc.array(
          fc.record({
            type: fc.constantFrom(
              "commendation" as const,
              "recommendation" as const,
            ),
            summary: fc.string({ minLength: 1, maxLength: 100 }),
            evidence_quote: fc.string({ minLength: 1, maxLength: 100 }),
            evidence_timestamp: fc.float({ min: 0, max: 600, noNaN: true }),
            explanation: fc.string({ minLength: 1, maxLength: 200 }),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        closing: fc.string({ minLength: 1, maxLength: 200 }),
        structure_commentary: arbitraryStructureCommentary(),
      });

  /** Generator for audio chunk buffers */
  const arbitraryAudioChunks = (): fc.Arbitrary<Buffer[]> =>
    fc.array(
      fc
        .integer({ min: 100, max: 10000 })
        .chain((size) =>
          fc
            .uint8Array({ minLength: size, maxLength: size })
            .map((arr) => Buffer.from(arr)),
        ),
      { minLength: 1, maxLength: 5 },
    );

  /** Generator for evaluation script strings */
  const arbitraryEvaluationScript = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 10, maxLength: 500 });

  /** Generator for TTS audio cache buffer */
  const arbitraryTtsAudioCache = (): fc.Arbitrary<Buffer> =>
    fc
      .integer({ min: 1024, max: 50000 })
      .chain((size) =>
        fc
          .uint8Array({ minLength: size, maxLength: size })
          .map((arr) => Buffer.from(arr)),
      );

  /** Generator for non-empty speaker names */
  const arbitrarySpeakerName = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

  /** Generator for evaluationPassRate */
  const arbitraryPassRate = (): fc.Arbitrary<number> =>
    fc.float({ min: 0, max: 1, noNaN: true });

  it("purges all session data fields after revokeConsent() and preserves session id and state", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        arbitraryTranscriptSegments(),
        arbitraryDeliveryMetrics(),
        arbitraryStructuredEvaluation(),
        arbitraryAudioChunks(),
        arbitraryEvaluationScript(),
        arbitraryTtsAudioCache(),
        arbitrarySpeakerName(),
        arbitraryPassRate(),
        async (
          transcript,
          liveTranscript,
          metrics,
          evaluation,
          audioChunks,
          evaluationScript,
          ttsAudioCache,
          speakerName,
          passRate,
        ) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Step 1: Set consent while in IDLE state
          sm.setConsent(sessionId, speakerName, true);

          // Step 2: Populate session with all data fields
          session.transcript = transcript;
          session.liveTranscript = liveTranscript;
          session.metrics = metrics;
          session.evaluation = evaluation;
          session.evaluationPublic = {
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
          };
          session.audioChunks = audioChunks;
          session.evaluationScript = evaluationScript;
          session.ttsAudioCache = ttsAudioCache;
          session.qualityWarning = true;
          session.evaluationPassRate = passRate;

          // Verify data is populated before purge
          expect(session.transcript.length).toBeGreaterThan(0);
          expect(session.liveTranscript.length).toBeGreaterThan(0);
          expect(session.metrics).not.toBeNull();
          expect(session.evaluation).not.toBeNull();
          expect(session.evaluationPublic).not.toBeNull();
          expect(session.audioChunks.length).toBeGreaterThan(0);
          expect(session.evaluationScript).not.toBeNull();
          expect(session.ttsAudioCache).not.toBeNull();
          expect(session.consent).not.toBeNull();
          expect(session.evaluationPassRate).not.toBeNull();

          // Capture session id before purge
          const originalId = session.id;

          // Step 3: Call revokeConsent to trigger purge
          sm.revokeConsent(sessionId);

          // Step 4: Verify ALL data fields are null/empty
          expect(session.transcript).toEqual([]);
          expect(session.liveTranscript).toEqual([]);
          expect(session.audioChunks).toEqual([]);
          expect(session.metrics).toBeNull();
          expect(session.evaluation).toBeNull();
          expect(session.evaluationPublic).toBeNull();
          expect(session.evaluationScript).toBeNull();
          expect(session.ttsAudioCache).toBeNull();
          expect(session.consent).toBeNull();
          expect(session.qualityWarning).toBe(false);
          expect(session.evaluationPassRate).toBeNull();

          // Step 5: Verify Session object still exists with valid id and state (IDLE)
          expect(session.id).toBe(originalId);
          expect(session.id).toBeTruthy();
          expect(session.state).toBe(SessionState.IDLE);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("purges all session data from non-IDLE states after revokeConsent()", async () => {
    const arbitraryNonIdleState = (): fc.Arbitrary<SessionState> =>
      fc.constantFrom(
        SessionState.RECORDING,
        SessionState.PROCESSING,
        SessionState.DELIVERING,
      );

    await fc.assert(
      fc.asyncProperty(
        arbitraryTranscriptSegments(),
        arbitraryDeliveryMetrics(),
        arbitraryStructuredEvaluation(),
        arbitraryAudioChunks(),
        arbitraryEvaluationScript(),
        arbitraryTtsAudioCache(),
        arbitrarySpeakerName(),
        arbitraryNonIdleState(),
        async (
          transcript,
          metrics,
          evaluation,
          audioChunks,
          evaluationScript,
          ttsAudioCache,
          speakerName,
          nonIdleState,
        ) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set consent while in IDLE
          sm.setConsent(sessionId, speakerName, true);

          // Populate session data
          session.transcript = transcript;
          session.metrics = metrics;
          session.evaluation = evaluation;
          session.evaluationPublic = {
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
          };
          session.audioChunks = audioChunks;
          session.evaluationScript = evaluationScript;
          session.ttsAudioCache = ttsAudioCache;
          session.qualityWarning = true;
          session.evaluationPassRate = 0.85;

          // Transition to a non-IDLE state
          session.state = nonIdleState;

          const originalId = session.id;
          const originalRunId = session.runId;

          // Call revokeConsent — should work from any state
          sm.revokeConsent(sessionId);

          // Verify all data purged
          expect(session.transcript).toEqual([]);
          expect(session.liveTranscript).toEqual([]);
          expect(session.audioChunks).toEqual([]);
          expect(session.metrics).toBeNull();
          expect(session.evaluation).toBeNull();
          expect(session.evaluationPublic).toBeNull();
          expect(session.evaluationScript).toBeNull();
          expect(session.ttsAudioCache).toBeNull();
          expect(session.consent).toBeNull();
          expect(session.qualityWarning).toBe(false);
          expect(session.evaluationPassRate).toBeNull();

          // Session object still exists with valid id and IDLE state
          expect(session.id).toBe(originalId);
          expect(session.state).toBe(SessionState.IDLE);

          // RunId should have been incremented (to cancel in-flight ops)
          expect(session.runId).toBeGreaterThan(originalRunId);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Phase 2 Property 17: Quality Warning Threshold Correctness ─────────────────

describe("Feature: phase-2-stability-credibility, Property 17: Quality Warning Threshold Correctness", () => {
  /**
   * **Validates: Requirements 10.1**
   *
   * For any transcript and metrics where either (a) totalWords / (durationSeconds / 60) < 10
   * or (b) the mean word confidence (excluding silence/non-speech markers) is below 0.5,
   * the quality warning flag SHALL be set to true. For transcripts meeting both thresholds,
   * the flag SHALL be false.
   */

  // ─── Constants matching session-manager.ts ──────────────────────────────────
  const MIN_WPM = 10;
  const MIN_CONFIDENCE = 0.5;

  const NON_SPEECH_MARKERS = [
    "[silence]",
    "[noise]",
    "[music]",
    "[inaudible]",
    "[laughter]",
    "[applause]",
    "[crosstalk]",
    "[blank_audio]",
  ];

  // ─── Generators ─────────────────────────────────────────────────────────────

  /** Generator for a speech word (not a non-speech marker) with a given confidence range */
  const arbitrarySpeechWord = (
    minConf: number,
    maxConf: number,
  ): fc.Arbitrary<TranscriptWord> =>
    fc.record({
      word: fc
        .stringMatching(/^[a-z]{2,10}$/)
        .filter((w) => !NON_SPEECH_MARKERS.includes(w.toLowerCase())),
      startTime: fc.float({ min: 0, max: 600, noNaN: true }),
      endTime: fc.float({ min: 0, max: 600, noNaN: true }),
      confidence: fc.float({ min: Math.fround(minConf), max: Math.fround(maxConf), noNaN: true }),
    });

  /** Generator for a non-speech marker word with arbitrary confidence */
  const arbitraryNonSpeechMarker = (): fc.Arbitrary<TranscriptWord> =>
    fc.record({
      word: fc.constantFrom(...NON_SPEECH_MARKERS),
      startTime: fc.float({ min: 0, max: 600, noNaN: true }),
      endTime: fc.float({ min: 0, max: 600, noNaN: true }),
      confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    });

  /** Build a transcript segment from a list of words */
  const buildSegment = (words: TranscriptWord[]): TranscriptSegment => ({
    text: words.map((w) => w.word).join(" "),
    startTime: words.length > 0 ? words[0].startTime : 0,
    endTime: words.length > 0 ? words[words.length - 1].endTime : 0,
    words,
    isFinal: true,
  });

  /** Build minimal DeliveryMetrics with controlled totalWords and durationSeconds */
  const buildMetrics = (totalWords: number, durationSeconds: number): DeliveryMetrics => ({
    durationSeconds,
    durationFormatted: `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, "0")}`,
    totalWords,
    wordsPerMinute: durationSeconds > 0 ? Math.round((totalWords / durationSeconds) * 60) : 0,
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
  });

  /**
   * Creates a mock TranscriptionEngine that returns the given transcript from finalize().
   * startLive/stopLive/feedAudio are no-ops. qualityWarning is false.
   */
  const makeMockTranscriptionEngine = (
    transcript: TranscriptSegment[],
  ) =>
    ({
      startLive: vi.fn(),
      stopLive: vi.fn(),
      feedAudio: vi.fn(),
      finalize: vi.fn().mockResolvedValue(transcript),
      get qualityWarning() {
        return false;
      },
    }) as unknown as import("./transcription-engine.js").TranscriptionEngine;

  /**
   * Creates a mock MetricsExtractor that returns the given metrics from extract().
   */
  const makeMockMetricsExtractor = (
    metrics: DeliveryMetrics,
  ) =>
    ({
      extract: vi.fn().mockReturnValue(metrics),
    }) as unknown as import("./metrics-extractor.js").MetricsExtractor;

  /**
   * Helper: run stopRecording on a session with controlled transcript and metrics,
   * then return the resulting qualityWarning flag.
   */
  const runQualityAssessment = async (
    transcript: TranscriptSegment[],
    metrics: DeliveryMetrics,
  ): Promise<boolean> => {
    const mockTE = makeMockTranscriptionEngine(transcript);
    const mockME = makeMockMetricsExtractor(metrics);

    const sm = new SessionManager({
      transcriptionEngine: mockTE,
      metricsExtractor: mockME,
    });

    const session = sm.createSession();
    // Set consent (required for startRecording)
    sm.setConsent(session.id, "TestSpeaker", true);
    // Start recording → transitions to RECORDING
    sm.startRecording(session.id);
    // Feed a dummy audio chunk so audioChunks is non-empty (needed for finalize path)
    sm.feedAudio(session.id, Buffer.alloc(100));
    // Stop recording → triggers finalize → metrics extraction → quality assessment
    await sm.stopRecording(session.id);

    return session.qualityWarning;
  };

  // ─── Test: Low WPM triggers quality warning ────────────────────────────────

  it("sets qualityWarning to true when WPM < 10", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate speech words with high confidence (>= 0.5) so only WPM triggers
        fc.array(arbitrarySpeechWord(0.5, 1.0), { minLength: 1, maxLength: 20 }),
        // Optionally inject non-speech markers
        fc.array(arbitraryNonSpeechMarker(), { minLength: 0, maxLength: 5 }),
        // Generate totalWords and durationSeconds such that WPM < 10
        // totalWords between 1 and 50, durationSeconds long enough that WPM < 10
        fc.integer({ min: 1, max: 50 }),
        async (speechWords, markers, totalWords) => {
          // Ensure WPM < 10: durationSeconds must be > totalWords / 10 * 60
          // i.e., durationSeconds > totalWords * 6
          const durationSeconds = totalWords * 6 + 1; // guarantees WPM < 10

          const allWords = [...speechWords, ...markers];
          const transcript = [buildSegment(allWords)];
          const metrics = buildMetrics(totalWords, durationSeconds);

          const warning = await runQualityAssessment(transcript, metrics);

          // PROPERTY: WPM < 10 → qualityWarning must be true
          expect(warning).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─── Test: Low confidence triggers quality warning ─────────────────────────

  it("sets qualityWarning to true when mean speech-word confidence < 0.5", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate speech words with LOW confidence (< 0.5)
        // Use at least 1 speech word; all with confidence strictly below 0.5
        fc.array(arbitrarySpeechWord(0, 0.49), { minLength: 1, maxLength: 20 }),
        // Optionally inject non-speech markers (these should be excluded from confidence calc)
        fc.array(arbitraryNonSpeechMarker(), { minLength: 0, maxLength: 5 }),
        // Generate metrics with high WPM (>= 10) so only confidence triggers
        fc.integer({ min: 100, max: 5000 }),
        async (speechWords, markers, totalWords) => {
          // Ensure WPM >= 10: durationSeconds such that totalWords / (durationSeconds/60) >= 10
          // i.e., durationSeconds <= totalWords * 6
          const durationSeconds = Math.max(1, Math.floor(totalWords * 6 * 0.5)); // WPM will be ~20

          const allWords = [...speechWords, ...markers];
          const transcript = [buildSegment(allWords)];
          const metrics = buildMetrics(totalWords, durationSeconds);

          const warning = await runQualityAssessment(transcript, metrics);

          // PROPERTY: mean speech-word confidence < 0.5 → qualityWarning must be true
          expect(warning).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─── Test: Both thresholds met → no warning ────────────────────────────────

  it("sets qualityWarning to false when WPM >= 10 AND mean speech-word confidence >= 0.5", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate speech words with HIGH confidence (>= 0.5)
        fc.array(arbitrarySpeechWord(0.5, 1.0), { minLength: 1, maxLength: 20 }),
        // Optionally inject non-speech markers with any confidence (should be excluded)
        fc.array(arbitraryNonSpeechMarker(), { minLength: 0, maxLength: 5 }),
        // Generate metrics with high WPM (>= 10)
        fc.integer({ min: 100, max: 5000 }),
        async (speechWords, markers, totalWords) => {
          // Ensure WPM >= 10: durationSeconds <= totalWords * 6
          const durationSeconds = Math.max(1, Math.floor(totalWords * 6 * 0.5)); // WPM ~20

          const allWords = [...speechWords, ...markers];
          const transcript = [buildSegment(allWords)];
          const metrics = buildMetrics(totalWords, durationSeconds);

          const warning = await runQualityAssessment(transcript, metrics);

          // PROPERTY: WPM >= 10 AND mean confidence >= 0.5 → qualityWarning must be false
          expect(warning).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ─── Test: Non-speech markers excluded from confidence computation ─────────

  it("excludes silence/non-speech markers from confidence computation", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate speech words with HIGH confidence (>= 0.7) — well above threshold
        fc.array(arbitrarySpeechWord(0.7, 1.0), { minLength: 1, maxLength: 10 }),
        // Inject non-speech markers with VERY LOW confidence (0.0-0.1)
        // If these were included, they would drag the mean below 0.5
        fc.array(arbitraryNonSpeechMarker(), { minLength: 3, maxLength: 15 }).map(
          (markers) =>
            markers.map((m) => ({ ...m, confidence: 0.01 })),
        ),
        // High WPM so only confidence matters
        fc.integer({ min: 100, max: 5000 }),
        async (speechWords, lowConfMarkers, totalWords) => {
          const durationSeconds = Math.max(1, Math.floor(totalWords * 6 * 0.5));

          // Interleave speech words and low-confidence markers
          const allWords: TranscriptWord[] = [];
          const maxLen = Math.max(speechWords.length, lowConfMarkers.length);
          for (let i = 0; i < maxLen; i++) {
            if (i < speechWords.length) allWords.push(speechWords[i]);
            if (i < lowConfMarkers.length) allWords.push(lowConfMarkers[i]);
          }

          const transcript = [buildSegment(allWords)];
          const metrics = buildMetrics(totalWords, durationSeconds);

          const warning = await runQualityAssessment(transcript, metrics);

          // PROPERTY: Non-speech markers should be excluded from confidence calc.
          // Speech words have confidence >= 0.7, so mean is >= 0.7 >= 0.5.
          // If markers were included (confidence 0.01), mean would drop below 0.5.
          // Warning should be false because only speech words count.
          expect(warning).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
