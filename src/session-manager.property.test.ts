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


// ─── Eager Pipeline Property Tests ──────────────────────────────────────────────

// Feature: eager-evaluation-pipeline, Property 4: Cache validity invariant

describe("Feature: eager-evaluation-pipeline, Property 4: Cache validity invariant", () => {
  /**
   * **Validates: Requirements 6.1**
   *
   * For any session, `isEagerCacheValid()` SHALL return true if and only if ALL of:
   * - evaluationCache !== null
   * - eagerStatus === "ready"
   * - cache.runId === session.runId
   * - cache.timeLimitSeconds === session.timeLimitSeconds
   * - cache.voiceConfig === (session.voiceConfig ?? "nova")
   * - cache.ttsAudio.length > 0
   * - cache.evaluation !== null
   * - cache.evaluationScript !== null
   * - cache.evaluationPublic !== null
   */

  // ─── Generators ─────────────────────────────────────────────────────────────

  /** Generator for a valid StructuredEvaluation */
  const arbitraryEvaluation = (): fc.Arbitrary<StructuredEvaluation> =>
    fc.record({
      opening: fc.string({ minLength: 1, maxLength: 100 }),
      items: fc.array(
        fc.record({
          type: fc.constantFrom("commendation" as const, "recommendation" as const),
          summary: fc.string({ minLength: 1, maxLength: 50 }),
          evidence_quote: fc.string({ minLength: 1, maxLength: 50 }),
          evidence_timestamp: fc.float({ min: 0, max: 600, noNaN: true }),
          explanation: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        { minLength: 2, maxLength: 5 },
      ),
      closing: fc.string({ minLength: 1, maxLength: 100 }),
      structure_commentary: fc.record({
        opening_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
        body_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
        closing_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
      }),
    });

  /** Generator for a valid StructuredEvaluationPublic */
  const arbitraryEvaluationPublic = (): fc.Arbitrary<import("./types.js").StructuredEvaluationPublic> =>
    fc.record({
      opening: fc.string({ minLength: 1, maxLength: 100 }),
      items: fc.array(
        fc.record({
          type: fc.constantFrom("commendation" as const, "recommendation" as const),
          summary: fc.string({ minLength: 1, maxLength: 50 }),
          explanation: fc.string({ minLength: 1, maxLength: 100 }),
          evidence_quote: fc.string({ minLength: 1, maxLength: 50 }),
          evidence_timestamp: fc.float({ min: 0, max: 600, noNaN: true }),
        }),
        { minLength: 2, maxLength: 5 },
      ),
      closing: fc.string({ minLength: 1, maxLength: 100 }),
      structure_commentary: fc.record({
        opening_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
        body_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
        closing_comment: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
      }),
    });

  /** Generator for non-empty TTS audio buffer */
  const arbitraryTtsAudio = (): fc.Arbitrary<Buffer> =>
    fc.integer({ min: 1, max: 50000 }).chain((size) =>
      fc.uint8Array({ minLength: size, maxLength: size }).map((arr) => Buffer.from(arr)),
    );

  /** Generator for a valid EvaluationCache that matches session params */
  const arbitraryValidCache = (
    runId: number,
    timeLimitSeconds: number,
    voiceConfig: string,
  ): fc.Arbitrary<import("./types.js").EvaluationCache> =>
    fc.tuple(arbitraryEvaluation(), arbitraryEvaluationPublic(), arbitraryTtsAudio(), fc.string({ minLength: 1, maxLength: 200 })).map(
      ([evaluation, evaluationPublic, ttsAudio, evaluationScript]) => ({
        runId,
        timeLimitSeconds,
        voiceConfig,
        evaluation,
        evaluationScript,
        ttsAudio,
        evaluationPublic,
      }),
    );

  /** Generator for voiceConfig values (including undefined to test default resolution) */
  const arbitraryVoiceConfig = (): fc.Arbitrary<string | undefined> =>
    fc.oneof(
      fc.constant(undefined),
      fc.constant("nova"),
      fc.constant("alloy"),
      fc.constant("echo"),
      fc.constant("shimmer"),
    );

  it("returns true when all validity conditions hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 30, max: 600 }),
        arbitraryVoiceConfig(),
        async (runId, timeLimitSeconds, voiceConfig) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set session params
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.voiceConfig = voiceConfig;
          session.eagerStatus = "ready";

          // Resolve voiceConfig the same way isEagerCacheValid does
          const resolvedVoice = voiceConfig ?? "nova";

          // Build a valid cache matching all session params
          const cache = await fc.sample(arbitraryValidCache(runId, timeLimitSeconds, resolvedVoice), 1)[0];
          session.evaluationCache = cache;

          // PROPERTY: isEagerCacheValid returns true when all conditions hold
          expect(sm.isEagerCacheValid(sessionId)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when evaluationCache is null", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (runId) => {
        const sm = new SessionManager();
        const session = sm.createSession();
        session.runId = runId;
        session.eagerStatus = "ready";
        session.evaluationCache = null;

        expect(sm.isEagerCacheValid(session.id)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("returns false when eagerStatus is not 'ready'", async () => {
    const nonReadyStatuses = fc.constantFrom("idle" as const, "generating" as const, "synthesizing" as const, "failed" as const);

    await fc.assert(
      fc.asyncProperty(
        nonReadyStatuses,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (status, runId, timeLimitSeconds) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.eagerStatus = status;

          const cache = await fc.sample(arbitraryValidCache(runId, timeLimitSeconds, "nova"), 1)[0];
          session.evaluationCache = cache;

          // PROPERTY: non-ready status → invalid
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when cache.runId does not match session.runId", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.eagerStatus = "ready";

          // Cache with a different runId
          const staleRunId = runId + 1;
          const cache = await fc.sample(arbitraryValidCache(staleRunId, timeLimitSeconds, "nova"), 1)[0];
          session.evaluationCache = cache;

          // PROPERTY: mismatched runId → invalid
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when cache.timeLimitSeconds does not match session.timeLimitSeconds", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 300 }),
        async (runId, timeLimitSeconds) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.eagerStatus = "ready";

          // Cache with a different timeLimitSeconds
          const differentTimeLimit = timeLimitSeconds + 30;
          const cache = await fc.sample(arbitraryValidCache(runId, differentTimeLimit, "nova"), 1)[0];
          session.evaluationCache = cache;

          // PROPERTY: mismatched timeLimitSeconds → invalid
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when cache.voiceConfig does not match resolved session.voiceConfig", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.voiceConfig = "alloy"; // resolved = "alloy"
          session.eagerStatus = "ready";

          // Cache with "nova" — doesn't match "alloy"
          const cache = await fc.sample(arbitraryValidCache(runId, timeLimitSeconds, "nova"), 1)[0];
          session.evaluationCache = cache;

          // PROPERTY: mismatched voiceConfig → invalid
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when cache.ttsAudio is empty", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        arbitraryEvaluation(),
        arbitraryEvaluationPublic(),
        async (runId, timeLimitSeconds, evaluation, evaluationPublic) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.eagerStatus = "ready";

          session.evaluationCache = {
            runId,
            timeLimitSeconds,
            voiceConfig: "nova",
            evaluation,
            evaluationScript: "test script",
            ttsAudio: Buffer.alloc(0), // empty!
            evaluationPublic,
          };

          // PROPERTY: empty ttsAudio → invalid
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns false when cache.evaluationPublic is null", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        arbitraryEvaluation(),
        arbitraryTtsAudio(),
        async (runId, timeLimitSeconds, evaluation, ttsAudio) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;
          session.eagerStatus = "ready";

          session.evaluationCache = {
            runId,
            timeLimitSeconds,
            voiceConfig: "nova",
            evaluation,
            evaluationScript: "test script",
            ttsAudio,
            evaluationPublic: null, // null!
          };

          // PROPERTY: null evaluationPublic → invalid (required for delivery)
          expect(sm.isEagerCacheValid(session.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("correctly resolves undefined voiceConfig to 'nova' for comparison", () => {
    // Implementation Hazard 3: compare against resolved voiceConfig, not raw undefined
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 30, max: 600 }), (runId, timeLimitSeconds) => {
        const sm = new SessionManager();
        const session = sm.createSession();
        session.runId = runId;
        session.timeLimitSeconds = timeLimitSeconds;
        session.voiceConfig = undefined; // raw undefined
        session.eagerStatus = "ready";

        // Cache with "nova" — should match undefined resolved to "nova"
        const evaluation = makeEvaluation();
        session.evaluationCache = {
          runId,
          timeLimitSeconds,
          voiceConfig: "nova", // resolved value
          evaluation,
          evaluationScript: "test script",
          ttsAudio: Buffer.from([1, 2, 3]),
          evaluationPublic: {
            opening: evaluation.opening,
            items: evaluation.items.map((i) => ({
              type: i.type,
              summary: i.summary,
              explanation: i.explanation,
              evidence_quote: i.evidence_quote,
              evidence_timestamp: i.evidence_timestamp,
            })),
            closing: evaluation.closing,
            structure_commentary: evaluation.structure_commentary,
          },
        };

        // PROPERTY: undefined voiceConfig resolves to "nova" and matches cache
        expect(sm.isEagerCacheValid(session.id)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});


// ─── Eager Pipeline Property Tests: Properties 1, 2, 3, 9, 14, and State Precondition ──

import type { PipelineStage, EvaluationCache, Session } from "./types.js";
import type { ToneChecker } from "./tone-checker.js";
import type { MetricsExtractor } from "./metrics-extractor.js";
import type { TranscriptionEngine } from "./transcription-engine.js";

// ─── Shared Helpers for Eager Pipeline Tests ────────────────────────────────────

/**
 * Creates a full set of mock deps that allow the eager pipeline to run to completion.
 * Each mock is instrumented with vi.fn() for call tracking.
 * The `failAt` option causes the specified stage to throw.
 */
function makeEagerDeps(options: {
  failAt?: "generate" | "synthesize" | "toneCheck" | "renderScript";
  onGenerate?: () => void;
  onSynthesize?: () => void;
} = {}) {
  const evaluation = makeEvaluation();
  const audioBuffer = Buffer.from([1, 2, 3, 4, 5]);

  const mockEvaluationGenerator = {
    generate: vi.fn().mockImplementation(async () => {
      options.onGenerate?.();
      if (options.failAt === "generate") throw new Error("LLM generation failed");
      return { evaluation, passRate: 1.0 };
    }),
    renderScript: vi.fn().mockImplementation(() => {
      if (options.failAt === "renderScript") throw new Error("Script rendering failed");
      return "This is the evaluation script.";
    }),
    validate: vi.fn(),
    logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
    redact: vi.fn().mockReturnValue({
      scriptRedacted: "This is the redacted script.",
      evaluationPublic: {
        opening: evaluation.opening,
        items: evaluation.items.map((i) => ({
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
  } as unknown as EvaluationGenerator;

  const mockTtsEngine = {
    trimToFit: vi.fn().mockImplementation((text: string) => text),
    synthesize: vi.fn().mockImplementation(async () => {
      options.onSynthesize?.();
      if (options.failAt === "synthesize") throw new Error("TTS synthesis failed");
      return audioBuffer;
    }),
    estimateDuration: vi.fn().mockReturnValue(60),
  } as unknown as TTSEngine;

  const mockToneChecker = {
    check: vi.fn().mockReturnValue({ passed: true, violations: [] }),
    stripViolations: vi.fn().mockImplementation((s: string) => s),
    stripMarkers: vi.fn().mockImplementation((s: string) => s.replace(/\s*\[\[(Q|M):[^\]]+\]\]/g, "").trim()),
    appendScopeAcknowledgment: vi.fn().mockImplementation((s: string) => s),
  } as unknown as ToneChecker;

  const mockMetricsExtractor = {
    extract: vi.fn().mockReturnValue(makeMetrics()),
    computeEnergyProfile: vi.fn().mockReturnValue({
      windowDurationMs: 250,
      windows: [],
      coefficientOfVariation: 0,
      silenceThreshold: 0,
    }),
  } as unknown as MetricsExtractor;

  return {
    evaluationGenerator: mockEvaluationGenerator,
    ttsEngine: mockTtsEngine,
    toneChecker: mockToneChecker,
    metricsExtractor: mockMetricsExtractor,
    evaluation,
    audioBuffer,
  };
}

/**
 * Sets up a session in PROCESSING state with transcript, metrics, and consent,
 * ready for runEagerPipeline().
 */
function setupProcessingSession(sm: SessionManager): Session {
  const session = sm.createSession();
  session.transcript = makeTranscript();
  session.metrics = makeMetrics();
  session.state = SessionState.PROCESSING;
  session.consent = {
    speakerName: "TestSpeaker",
    consentConfirmed: true,
    consentTimestamp: new Date(),
  };
  return session;
}

// ─── Property 1: State and behavioral boundary during eager execution (SessionManager layer) ──

// Feature: eager-evaluation-pipeline, Property 1: State and behavioral boundary during eager execution (SessionManager layer)
describe("Feature: eager-evaluation-pipeline, Property 1: State and behavioral boundary during eager execution (SessionManager layer)", () => {
  /**
   * **Validates: Requirements 1.4, 8.1, 8.2**
   *
   * For any session in PROCESSING state with an in-flight eager pipeline:
   * - session.state remains PROCESSING throughout the entire eager pipeline execution
   * - runEagerPipeline() never calls assertTransition() or delivery-side methods
   * - evaluationCache is null until atomic publish (then non-null only at the end)
   */

  it("session.state remains PROCESSING throughout eager pipeline execution and evaluationCache is null until atomic publish", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }), // runId
        fc.integer({ min: 30, max: 600 }), // timeLimitSeconds
        async (runId, timeLimitSeconds) => {
          const stateSnapshots: SessionState[] = [];
          const cacheSnapshots: (EvaluationCache | null)[] = [];

          const deps = makeEagerDeps({
            onGenerate: () => {
              // Snapshot state during LLM generation
              stateSnapshots.push(session.state);
              cacheSnapshots.push(session.evaluationCache);
            },
            onSynthesize: () => {
              // Snapshot state during TTS synthesis
              stateSnapshots.push(session.state);
              cacheSnapshots.push(session.evaluationCache);
            },
          });

          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          const promise = sm.runEagerPipeline(session.id);
          await promise;

          // PROPERTY: session.state is PROCESSING at every observed point during pipeline
          for (const state of stateSnapshots) {
            expect(state).toBe(SessionState.PROCESSING);
          }

          // PROPERTY: evaluationCache was null at every observed point DURING pipeline
          // (before atomic publish at the end)
          for (const cache of cacheSnapshots) {
            expect(cache).toBeNull();
          }

          // PROPERTY: session.state is still PROCESSING after pipeline completes
          expect(session.state).toBe(SessionState.PROCESSING);

          // PROPERTY: evaluationCache is now non-null (published atomically at the end)
          expect(session.evaluationCache).not.toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("runEagerPipeline never calls assertTransition or completeDelivery", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Spy on assertTransition (private) and completeDelivery
          const assertTransitionSpy = vi.spyOn(sm as any, "assertTransition");
          const completeDeliverySpy = vi.spyOn(sm, "completeDelivery");

          await sm.runEagerPipeline(session.id);

          // PROPERTY: assertTransition was never called during eager pipeline
          expect(assertTransitionSpy).not.toHaveBeenCalled();

          // PROPERTY: completeDelivery was never called during eager pipeline
          expect(completeDeliverySpy).not.toHaveBeenCalled();

          assertTransitionSpy.mockRestore();
          completeDeliverySpy.mockRestore();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Eager status transition sequence with atomic cache publication ──

// Feature: eager-evaluation-pipeline, Property 2: Eager status transition sequence with atomic cache publication
describe("Feature: eager-evaluation-pipeline, Property 2: Eager status transition sequence with atomic cache publication", () => {
  /**
   * **Validates: Requirements 2.2, 2.3, 2.4, 1.5, 9.2, 9.3**
   *
   * Verify valid sequences: idle→generating→synthesizing→ready,
   * idle→generating→failed, idle→generating→synthesizing→failed
   *
   * Verify `ready` implies non-null cache with matching runId and non-null evaluationPublic,
   * and both eagerPromise and eagerRunId are null on terminal states.
   *
   * Verify `invalidated` is never emitted by SessionManager's onProgress callback.
   */

  /** Generator for failure stage or no failure */
  const arbitraryFailureMode = (): fc.Arbitrary<"generate" | "synthesize" | undefined> =>
    fc.constantFrom(undefined, "generate" as const, "synthesize" as const);

  it("follows valid status transition sequences and emits correct progress stages", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        arbitraryFailureMode(),
        async (runId, timeLimitSeconds, failAt) => {
          const progressStages: PipelineStage[] = [];

          const deps = makeEagerDeps({ failAt });
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Verify initial state
          expect(session.eagerStatus).toBe("idle");

          const promise = sm.runEagerPipeline(session.id, (stage) => {
            progressStages.push(stage);
          });

          await promise;

          // PROPERTY: `invalidated` is never emitted by SessionManager's onProgress callback
          expect(progressStages).not.toContain("invalidated");

          // PROPERTY: progress stages follow valid sequences
          if (!failAt) {
            // Success path: generating_evaluation → synthesizing_audio → ready
            expect(progressStages).toEqual([
              "generating_evaluation",
              "synthesizing_audio",
              "ready",
            ]);
            expect(session.eagerStatus).toBe("ready");
          } else if (failAt === "generate") {
            // Early failure: generating_evaluation → failed
            expect(progressStages).toEqual([
              "generating_evaluation",
              "failed",
            ]);
            expect(session.eagerStatus).toBe("failed");
          } else if (failAt === "synthesize") {
            // Late failure: generating_evaluation → synthesizing_audio → failed
            expect(progressStages).toEqual([
              "generating_evaluation",
              "synthesizing_audio",
              "failed",
            ]);
            expect(session.eagerStatus).toBe("failed");
          }

          // PROPERTY: on terminal states, eagerPromise and eagerRunId are null
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: ready implies non-null cache with matching runId and non-null evaluationPublic
          if (session.eagerStatus === "ready") {
            expect(session.evaluationCache).not.toBeNull();
            expect(session.evaluationCache!.runId).toBe(runId);
            expect(session.evaluationCache!.evaluationPublic).not.toBeNull();
            expect(session.evaluationCache!.ttsAudio.length).toBeGreaterThan(0);
            expect(session.evaluationCache!.evaluation).not.toBeNull();
            expect(session.evaluationCache!.evaluationScript).not.toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 3: Failure handling clears partial results ──

// Feature: eager-evaluation-pipeline, Property 3: Failure handling clears partial results
describe("Feature: eager-evaluation-pipeline, Property 3: Failure handling clears partial results", () => {
  /**
   * **Validates: Requirements 1.6**
   *
   * Verify eagerStatus === "failed", session.state === PROCESSING,
   * evaluationCache === null, eagerPromise === null, eagerRunId === null after pipeline failure.
   * Verify the promise resolved (did not reject).
   * Also verify: inject a throwing onProgress callback and confirm the promise still resolves.
   */

  /** Generator for failure stage */
  const arbitraryFailureStage = (): fc.Arbitrary<"generate" | "synthesize"> =>
    fc.constantFrom("generate" as const, "synthesize" as const);

  it("clears partial results on pipeline failure and promise resolves (never rejects)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        arbitraryFailureStage(),
        async (runId, timeLimitSeconds, failAt) => {
          const deps = makeEagerDeps({ failAt });
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // PROPERTY: promise resolves (does not reject)
          let rejected = false;
          try {
            await sm.runEagerPipeline(session.id);
          } catch {
            rejected = true;
          }
          expect(rejected).toBe(false);

          // PROPERTY: eagerStatus is "failed"
          expect(session.eagerStatus).toBe("failed");

          // PROPERTY: session.state is still PROCESSING
          expect(session.state).toBe(SessionState.PROCESSING);

          // PROPERTY: evaluationCache is null (no partial artifacts)
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise is null
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId is null
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("promise still resolves even when onProgress callback throws (safeProgress coverage)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        arbitraryFailureStage(),
        async (runId, failAt) => {
          const deps = makeEagerDeps({ failAt });
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Inject a throwing onProgress callback
          const throwingCallback = (_stage: PipelineStage) => {
            throw new Error("onProgress callback exploded!");
          };

          // PROPERTY: promise resolves even with throwing callback
          let rejected = false;
          try {
            await sm.runEagerPipeline(session.id, throwingCallback);
          } catch {
            rejected = true;
          }
          expect(rejected).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("promise resolves even when onProgress throws on success path (safeProgress coverage)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          // No failure — success path, but callback throws
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          const throwingCallback = (_stage: PipelineStage) => {
            throw new Error("onProgress callback exploded on success!");
          };

          // PROPERTY: promise resolves even with throwing callback on success path
          let rejected = false;
          try {
            await sm.runEagerPipeline(session.id, throwingCallback);
          } catch {
            rejected = true;
          }
          expect(rejected).toBe(false);

          // Pipeline should still complete successfully despite callback errors
          expect(session.eagerStatus).toBe("ready");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: RunId staleness — stale eager results are discarded ──

// Feature: eager-evaluation-pipeline, Property 9: RunId staleness — stale eager results are discarded
describe("Feature: eager-evaluation-pipeline, Property 9: RunId staleness — stale eager results are discarded", () => {
  /**
   * **Validates: Requirements 5.5, 7.3**
   *
   * Verify that if runId changes mid-pipeline: no EvaluationCache is published,
   * session.state is not modified.
   *
   * Verify dual-guard cleanup: eagerStatus is reset to "idle" only if not "ready",
   * eagerPromise and eagerRunId are cleared to null.
   *
   * Verify old run's finally cannot clobber new run.
   */

  it("discards results when runId changes mid-pipeline (during LLM generation)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps({
            onGenerate: () => {
              // Simulate runId change during LLM generation (e.g., panic mute)
              session.runId = runId + 1;
            },
          });

          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          await sm.runEagerPipeline(session.id);

          // PROPERTY: no EvaluationCache published
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: session.state not modified (still PROCESSING)
          expect(session.state).toBe(SessionState.PROCESSING);

          // PROPERTY: eagerStatus reset to "idle" (not "ready")
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: eagerPromise and eagerRunId cleared
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("discards results when runId changes mid-pipeline (during TTS synthesis)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps({
            onSynthesize: () => {
              // Simulate runId change during TTS synthesis
              session.runId = runId + 1;
            },
          });

          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          await sm.runEagerPipeline(session.id);

          // PROPERTY: no EvaluationCache published
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: session.state not modified
          expect(session.state).toBe(SessionState.PROCESSING);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: eagerPromise and eagerRunId cleared
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("old run's finally cannot clobber new run's state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 100 }),
        async (initialRunId) => {
          // We need fine-grained control: run A starts, runId changes, run B starts,
          // run A's finally fires — assert run B's state is untouched.

          let resolveRunA: (() => void) | null = null;
          const runAGeneratePromise = new Promise<void>((r) => { resolveRunA = r; });

          // Run A's generate will block until we release it
          const runAEvalGenerator = {
            generate: vi.fn().mockImplementation(async () => {
              await runAGeneratePromise;
              return { evaluation: makeEvaluation(), passRate: 1.0 };
            }),
            renderScript: vi.fn().mockReturnValue("Script A"),
            validate: vi.fn(),
            logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
            redact: vi.fn().mockReturnValue({
              scriptRedacted: "Redacted A",
              evaluationPublic: {
                opening: "o", items: [], closing: "c",
                structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
              },
            }),
          } as unknown as EvaluationGenerator;

          const runATtsEngine = {
            trimToFit: vi.fn().mockImplementation((s: string) => s),
            synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
            estimateDuration: vi.fn().mockReturnValue(60),
          } as unknown as TTSEngine;

          const runAToneChecker = {
            check: vi.fn().mockReturnValue({ passed: true, violations: [] }),
            stripViolations: vi.fn().mockImplementation((s: string) => s),
            stripMarkers: vi.fn().mockImplementation((s: string) => s),
            appendScopeAcknowledgment: vi.fn().mockImplementation((s: string) => s),
          } as unknown as ToneChecker;

          const smA = new SessionManager({
            evaluationGenerator: runAEvalGenerator,
            ttsEngine: runATtsEngine,
            toneChecker: runAToneChecker,
          });

          const session = setupProcessingSession(smA);
          session.runId = initialRunId;

          // Start run A (runId = initialRunId)
          const promiseA = smA.runEagerPipeline(session.id);

          // Increment runId to simulate cancellation
          session.runId = initialRunId + 1;

          // Now start run B with a fresh SessionManager that shares the same session
          // We need to use the same SM since it holds the session map
          // Instead, we'll directly set up run B's state by calling runEagerPipeline again
          // But first we need to clear the eager fields so run B can start
          // (run A still holds eagerRunId = initialRunId, but runId is now initialRunId+1)

          // Run B: create new deps that complete immediately
          const runBDeps = makeEagerDeps();
          // We can't easily swap deps on the same SM, so let's test the dual-guard
          // by verifying run A's finally doesn't clobber when run B has taken ownership.

          // Manually simulate run B taking ownership of the session's eager fields
          const runBPromise = Promise.resolve();
          session.eagerPromise = runBPromise;
          session.eagerRunId = initialRunId + 1;
          session.eagerStatus = "generating";

          // Now release run A — its finally block will fire
          resolveRunA!();
          await promiseA;

          // PROPERTY: run B's eagerPromise is untouched (run A's finally skipped cleanup
          // because neither guard matched — run B owns both fields)
          expect(session.eagerPromise).toBe(runBPromise);
          expect(session.eagerRunId).toBe(initialRunId + 1);
          expect(session.eagerStatus).toBe("generating");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 14: Single-flight per RunId ──

// Feature: eager-evaluation-pipeline, Property 14: Single-flight per RunId
describe("Feature: eager-evaluation-pipeline, Property 14: Single-flight per RunId", () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * Call runEagerPipeline() twice with same runId — verify second call returns
   * the exact same promise reference (p1 === p2, strict identity check).
   * Verify only one pipeline execution occurs.
   */

  it("returns the same promise reference on duplicate calls and executes pipeline only once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // First call — starts the pipeline
          const p1 = sm.runEagerPipeline(session.id);

          // Second call with same runId — should return same promise
          const p2 = sm.runEagerPipeline(session.id);

          // PROPERTY: strict identity check — same promise reference
          expect(p2).toBe(p1);

          // Wait for completion
          await p1;

          // PROPERTY: pipeline executed only once (generate called once)
          expect(deps.evaluationGenerator.generate).toHaveBeenCalledTimes(1);

          // PROPERTY: TTS synthesize called only once
          expect(deps.ttsEngine.synthesize).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── State Precondition Guard ──

// Feature: eager-evaluation-pipeline, State precondition guard
describe("Feature: eager-evaluation-pipeline, State precondition guard", () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * Verify runEagerPipeline() returns resolved promise and does not modify
   * any eager fields when session.state !== "PROCESSING".
   */

  /** Generator for non-PROCESSING session states */
  const arbitraryNonProcessingState = (): fc.Arbitrary<SessionState> =>
    fc.constantFrom(
      SessionState.IDLE,
      SessionState.RECORDING,
      SessionState.DELIVERING,
    );

  it("returns resolved promise and does not modify eager fields when state is not PROCESSING", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryNonProcessingState(),
        fc.integer({ min: 0, max: 100 }),
        async (nonProcessingState, runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = sm.createSession();
          session.state = nonProcessingState;
          session.runId = runId;

          // Capture initial eager field values
          const initialEagerStatus = session.eagerStatus;
          const initialEagerRunId = session.eagerRunId;
          const initialEagerPromise = session.eagerPromise;
          const initialEvaluationCache = session.evaluationCache;

          const promise = sm.runEagerPipeline(session.id);

          // PROPERTY: promise resolves (does not reject)
          let rejected = false;
          try {
            await promise;
          } catch {
            rejected = true;
          }
          expect(rejected).toBe(false);

          // PROPERTY: no eager fields modified
          expect(session.eagerStatus).toBe(initialEagerStatus);
          expect(session.eagerRunId).toBe(initialEagerRunId);
          expect(session.eagerPromise).toBe(initialEagerPromise);
          expect(session.evaluationCache).toBe(initialEvaluationCache);

          // PROPERTY: session.state unchanged
          expect(session.state).toBe(nonProcessingState);

          // PROPERTY: no pipeline stages executed
          expect(deps.evaluationGenerator.generate).not.toHaveBeenCalled();
          expect(deps.ttsEngine.synthesize).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 5: Cache invalidation on generation parameter change ──

// Feature: eager-evaluation-pipeline, Property 5: Cache invalidation on generation parameter change
describe("Feature: eager-evaluation-pipeline, Property 5: Cache invalidation on generation parameter change", () => {
  /**
   * **Validates: Requirements 6.2**
   *
   * For any session in PROCESSING state with a cached artifact or an in-flight
   * eager pipeline, changing timeLimitSeconds (or voiceConfig) via
   * invalidateEagerCache() SHALL reset eagerStatus to "idle", set evaluationCache
   * to null, clear eagerPromise, and increment runId to cancel any in-flight pipeline.
   */

  it("invalidateEagerCache clears cache and increments runId when cache exists", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Run eager pipeline to completion to populate cache
          await sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("ready");
          expect(session.evaluationCache).not.toBeNull();

          const runIdBefore = session.runId;

          // Invalidate cache (simulates time limit change)
          sm.invalidateEagerCache(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId cleared
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: runId incremented
          expect(session.runId).toBe(runIdBefore + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("invalidateEagerCache clears in-flight eager pipeline state and increments runId", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          let resolveGenerate: (() => void) | null = null;
          const generatePromise = new Promise<void>((r) => { resolveGenerate = r; });

          const blockingEvalGenerator = {
            generate: vi.fn().mockImplementation(async () => {
              await generatePromise;
              return { evaluation: makeEvaluation(), passRate: 1.0 };
            }),
            renderScript: vi.fn().mockReturnValue("Script"),
            validate: vi.fn(),
            logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
            redact: vi.fn().mockReturnValue({
              scriptRedacted: "Redacted",
              evaluationPublic: {
                opening: "o", items: [], closing: "c",
                structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
              },
            }),
          } as unknown as EvaluationGenerator;

          const mockTtsEngine = {
            trimToFit: vi.fn().mockImplementation((s: string) => s),
            synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
            estimateDuration: vi.fn().mockReturnValue(60),
          } as unknown as TTSEngine;

          const sm = new SessionManager({
            evaluationGenerator: blockingEvalGenerator,
            ttsEngine: mockTtsEngine,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Start eager pipeline (will block at generate)
          const eagerPromise = sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("generating");
          expect(session.eagerPromise).not.toBeNull();

          const runIdBefore = session.runId;

          // Invalidate while in-flight
          sm.invalidateEagerCache(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: runId incremented
          expect(session.runId).toBe(runIdBefore + 1);

          // Release the blocked generate so the pipeline can finish
          resolveGenerate!();
          await eagerPromise;

          // After pipeline finishes, it should detect runId mismatch and not publish cache
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: Reset on new recording ──

// Feature: eager-evaluation-pipeline, Property 6: Reset on new recording
describe("Feature: eager-evaluation-pipeline, Property 6: Reset on new recording", () => {
  /**
   * **Validates: Requirements 2.5, 6.3**
   *
   * For any session, calling startRecording() SHALL reset eagerStatus to "idle",
   * set evaluationCache to null, clear eagerPromise, and clear all cached
   * evaluation data regardless of the previous eager state.
   */

  it("startRecording clears eager state and cache when cache was populated", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("ready");
          expect(session.evaluationCache).not.toBeNull();

          // Transition to IDLE so startRecording can be called
          session.state = SessionState.IDLE;

          const runIdBefore = session.runId;

          // Start a new recording
          sm.startRecording(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId cleared
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: runId incremented (startRecording always increments)
          expect(session.runId).toBe(runIdBefore + 1);

          // PROPERTY: session is now RECORDING
          expect(session.state).toBe(SessionState.RECORDING);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("startRecording clears eager state even when eager was idle (no cache)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;

          // Verify initial eager state
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();

          sm.startRecording(session.id);

          // PROPERTY: eager fields remain clean
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: session is RECORDING
          expect(session.state).toBe(SessionState.RECORDING);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 7: Panic mute cancellation and cleanup ──

// Feature: eager-evaluation-pipeline, Property 7: Panic mute cancellation and cleanup
describe("Feature: eager-evaluation-pipeline, Property 7: Panic mute cancellation and cleanup", () => {
  /**
   * **Validates: Requirements 6.4, 7.1**
   *
   * For any session with an in-flight eager pipeline or cached artifacts,
   * calling panicMute() SHALL increment runId (causing the in-flight pipeline
   * to discard results on next checkpoint), reset eagerStatus to "idle",
   * set evaluationCache to null, and transition to IDLE.
   */

  it("panicMute clears eager cache and increments runId when cache exists", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("ready");
          expect(session.evaluationCache).not.toBeNull();

          const runIdBefore = session.runId;

          // Panic mute
          sm.panicMute(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId cleared
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: runId incremented
          expect(session.runId).toBe(runIdBefore + 1);

          // PROPERTY: session transitioned to IDLE
          expect(session.state).toBe(SessionState.IDLE);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("panicMute cancels in-flight eager pipeline via runId increment", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          let resolveGenerate: (() => void) | null = null;
          const generatePromise = new Promise<void>((r) => { resolveGenerate = r; });

          const blockingEvalGenerator = {
            generate: vi.fn().mockImplementation(async () => {
              await generatePromise;
              return { evaluation: makeEvaluation(), passRate: 1.0 };
            }),
            renderScript: vi.fn().mockReturnValue("Script"),
            validate: vi.fn(),
            logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
            redact: vi.fn().mockReturnValue({
              scriptRedacted: "Redacted",
              evaluationPublic: {
                opening: "o", items: [], closing: "c",
                structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
              },
            }),
          } as unknown as EvaluationGenerator;

          const mockTtsEngine = {
            trimToFit: vi.fn().mockImplementation((s: string) => s),
            synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
            estimateDuration: vi.fn().mockReturnValue(60),
          } as unknown as TTSEngine;

          const sm = new SessionManager({
            evaluationGenerator: blockingEvalGenerator,
            ttsEngine: mockTtsEngine,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Start eager pipeline (blocks at generate)
          const eagerPromise = sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("generating");

          const runIdBefore = session.runId;

          // Panic mute while in-flight
          sm.panicMute(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: runId incremented
          expect(session.runId).toBe(runIdBefore + 1);

          // PROPERTY: session transitioned to IDLE
          expect(session.state).toBe(SessionState.IDLE);

          // Release blocked generate and let pipeline finish
          resolveGenerate!();
          await eagerPromise;

          // Pipeline should have detected runId mismatch and not published cache
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("panicMute is a no-op from IDLE state (no runId increment, no eager state change)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (runId) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;

          const runIdBefore = session.runId;

          sm.panicMute(session.id);

          // PROPERTY: no runId increment from IDLE
          expect(session.runId).toBe(runIdBefore);

          // PROPERTY: eager state unchanged
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: Opt-out cancellation and full purge ──

// Feature: eager-evaluation-pipeline, Property 8: Opt-out cancellation and full purge
describe("Feature: eager-evaluation-pipeline, Property 8: Opt-out cancellation and full purge", () => {
  /**
   * **Validates: Requirements 6.5, 7.2**
   *
   * For any session with an in-flight eager pipeline or cached artifacts,
   * calling revokeConsent() SHALL increment runId, reset eagerStatus to "idle",
   * set evaluationCache to null, and clear all session data including evaluation,
   * script, transcript, metrics, and audio chunks.
   *
   * Per privacy-and-retention steering rule: opt-out purges all session data
   * immediately and irrecoverably.
   */

  it("revokeConsent clears eager cache and all session data when cache exists", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("ready");
          expect(session.evaluationCache).not.toBeNull();

          const runIdBefore = session.runId;

          // Revoke consent (opt-out)
          sm.revokeConsent(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId cleared
          expect(session.eagerRunId).toBeNull();

          // PROPERTY: runId incremented (revokeConsent increments from non-IDLE)
          expect(session.runId).toBeGreaterThan(runIdBefore);

          // PROPERTY: all session data purged per privacy-and-retention rule
          expect(session.transcript).toEqual([]);
          expect(session.liveTranscript).toEqual([]);
          expect(session.audioChunks).toEqual([]);
          expect(session.metrics).toBeNull();
          expect(session.evaluation).toBeNull();
          expect(session.evaluationPublic).toBeNull();
          expect(session.evaluationScript).toBeNull();
          expect(session.ttsAudioCache).toBeNull();
          expect(session.consent).toBeNull();

          // PROPERTY: session transitioned to IDLE
          expect(session.state).toBe(SessionState.IDLE);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("revokeConsent cancels in-flight eager pipeline and purges all data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          let resolveGenerate: (() => void) | null = null;
          const generatePromise = new Promise<void>((r) => { resolveGenerate = r; });

          const blockingEvalGenerator = {
            generate: vi.fn().mockImplementation(async () => {
              await generatePromise;
              return { evaluation: makeEvaluation(), passRate: 1.0 };
            }),
            renderScript: vi.fn().mockReturnValue("Script"),
            validate: vi.fn(),
            logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
            redact: vi.fn().mockReturnValue({
              scriptRedacted: "Redacted",
              evaluationPublic: {
                opening: "o", items: [], closing: "c",
                structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
              },
            }),
          } as unknown as EvaluationGenerator;

          const mockTtsEngine = {
            trimToFit: vi.fn().mockImplementation((s: string) => s),
            synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
            estimateDuration: vi.fn().mockReturnValue(60),
          } as unknown as TTSEngine;

          const sm = new SessionManager({
            evaluationGenerator: blockingEvalGenerator,
            ttsEngine: mockTtsEngine,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Start eager pipeline (blocks at generate)
          const eagerPromise = sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("generating");

          const runIdBefore = session.runId;

          // Revoke consent while in-flight
          sm.revokeConsent(session.id);

          // PROPERTY: eagerStatus reset to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: evaluationCache null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: runId incremented
          expect(session.runId).toBeGreaterThan(runIdBefore);

          // PROPERTY: all session data purged
          expect(session.transcript).toEqual([]);
          expect(session.metrics).toBeNull();
          expect(session.consent).toBeNull();

          // PROPERTY: session transitioned to IDLE
          expect(session.state).toBe(SessionState.IDLE);

          // Release blocked generate and let pipeline finish
          resolveGenerate!();
          await eagerPromise;

          // Pipeline should have detected runId mismatch and not published cache
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 13: Auto-purge clears cache ──

// Feature: eager-evaluation-pipeline, Property 13: Auto-purge clears cache
describe("Feature: eager-evaluation-pipeline, Property 13: Auto-purge clears cache", () => {
  /**
   * **Validates: Requirements 6.7**
   *
   * For any session where auto-purge fires, evaluationCache SHALL be set to null
   * and eagerStatus SHALL be reverted to "idle".
   */

  it("purgeSessionData clears evaluationCache and resets eagerStatus to idle", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 600 }),
        async (runId, timeLimitSeconds) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;
          session.timeLimitSeconds = timeLimitSeconds;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);
          expect(session.eagerStatus).toBe("ready");
          expect(session.evaluationCache).not.toBeNull();

          // Simulate auto-purge (same function called by the 10-minute timer)
          purgeSessionData(session);

          // PROPERTY: evaluationCache set to null
          expect(session.evaluationCache).toBeNull();

          // PROPERTY: eagerStatus reverted to "idle"
          expect(session.eagerStatus).toBe("idle");

          // PROPERTY: eagerPromise cleared
          expect(session.eagerPromise).toBeNull();

          // PROPERTY: eagerRunId cleared
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("purgeSessionData is safe to call when eager state is already idle", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (runId) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          session.runId = runId;

          // No eager state set — purge should still work
          purgeSessionData(session);

          // PROPERTY: eager fields remain clean
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
          expect(session.eagerPromise).toBeNull();
          expect(session.eagerRunId).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Coverage Test: runId mutation paths use correct method ──

// Feature: eager-evaluation-pipeline, Coverage: runId mutation paths use correct cleanup method
describe("Feature: eager-evaluation-pipeline, Coverage: runId mutation paths use correct cleanup method", () => {
  /**
   * Verify every runId mutation path uses the correct method:
   * - clearEagerState when runId already incremented (startRecording, panicMute, revokeConsent)
   * - cancelEagerGeneration when it needs incrementing (invalidateEagerCache)
   * - clearEagerState only for purgeSessionData (no runId++ needed)
   */

  it("startRecording: runId incremented BEFORE clearEagerState (not cancelEagerGeneration)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);

          // Transition to IDLE for startRecording
          session.state = SessionState.IDLE;

          const runIdBefore = session.runId;

          sm.startRecording(session.id);

          // startRecording increments runId exactly once (its own increment)
          // If it used cancelEagerGeneration, runId would be incremented twice
          expect(session.runId).toBe(runIdBefore + 1);

          // Eager state is cleared
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("panicMute: runId incremented BEFORE clearEagerState (not cancelEagerGeneration)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);

          const runIdBefore = session.runId;

          sm.panicMute(session.id);

          // panicMute increments runId exactly once (its own increment)
          expect(session.runId).toBe(runIdBefore + 1);

          // Eager state is cleared
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("revokeConsent: runId incremented BEFORE clearEagerState (not cancelEagerGeneration)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);

          const runIdBefore = session.runId;

          sm.revokeConsent(session.id);

          // revokeConsent increments runId exactly once (its own increment)
          expect(session.runId).toBe(runIdBefore + 1);

          // Eager state is cleared
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("invalidateEagerCache: uses cancelEagerGeneration (increments runId itself)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);

          const runIdBefore = session.runId;

          sm.invalidateEagerCache(session.id);

          // invalidateEagerCache calls cancelEagerGeneration which increments runId
          expect(session.runId).toBe(runIdBefore + 1);

          // Eager state is cleared
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("purgeSessionData: does NOT increment runId (pure reset only)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        async (runId) => {
          const deps = makeEagerDeps();
          const sm = new SessionManager({
            evaluationGenerator: deps.evaluationGenerator,
            ttsEngine: deps.ttsEngine,
            toneChecker: deps.toneChecker,
            metricsExtractor: deps.metricsExtractor,
          });

          const session = setupProcessingSession(sm);
          session.runId = runId;

          // Run eager pipeline to completion
          await sm.runEagerPipeline(session.id);

          const runIdBefore = session.runId;

          purgeSessionData(session);

          // purgeSessionData does NOT increment runId
          expect(session.runId).toBe(runIdBefore);

          // Eager state is cleared
          expect(session.eagerStatus).toBe("idle");
          expect(session.evaluationCache).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
