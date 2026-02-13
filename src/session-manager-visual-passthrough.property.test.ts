/**
 * Property-based test: Non-poor grade without face detector passes visual observations (Property 4)
 *
 * **Validates: Requirements 6.1**
 *
 * For any session where VideoProcessor has no faceDetector and produces a
 * videoQualityGrade of "good" or "degraded", the SessionManager.generateEvaluation
 * method SHALL pass the VisualObservations object (non-null) to the
 * EvaluationGenerator.generate call.
 *
 * Testing approach: Generate random VisualObservations with capabilities.face === false,
 * capabilities.pose === true, and videoQualityGrade randomly chosen from "good" or
 * "degraded" (never "poor"). Create a SessionManager with a mock EvaluationGenerator,
 * set up a session with the generated VisualObservations, call generateEvaluation,
 * and assert the EvaluationGenerator received non-null visualObservations.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { SessionManager } from "./session-manager.js";
import type { SessionManagerDeps } from "./session-manager.js";
import { SessionState } from "./types.js";
import type { VisualObservations } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeBasicTranscript() {
  return [
    {
      text: "hello",
      startTime: 0,
      endTime: 1,
      words: [{ word: "hello", startTime: 0, endTime: 1, confidence: 0.9 }],
      isFinal: true,
    },
  ];
}

function makeBasicMetrics() {
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
    visualMetrics: null,
  };
}

function createMockEvalGenerator(capturedCalls: any[]) {
  return {
    generate: vi.fn().mockImplementation((...args: any[]) => {
      capturedCalls.push(args);
      return Promise.resolve({
        evaluation: {
          opening: "Hello",
          items: [],
          closing: "Goodbye",
          structure_commentary: {
            opening_comment: null,
            body_comment: null,
            closing_comment: null,
          },
        },
        passRate: 1.0,
      });
    }),
    renderScript: vi.fn().mockReturnValue("Test script"),
    redact: vi.fn().mockReturnValue({
      scriptRedacted: "Test script",
      evaluationPublic: {
        opening: "Hello",
        items: [],
        closing: "Goodbye",
        structure_commentary: {
          opening_comment: null,
          body_comment: null,
          closing_comment: null,
        },
      },
    }),
    logConsistencyTelemetry: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockToneChecker() {
  return {
    check: vi.fn().mockReturnValue({ passed: true, violations: [] }),
    stripViolations: vi.fn().mockImplementation((s: string) => s),
    stripMarkers: vi.fn().mockImplementation((s: string) => s),
    appendScopeAcknowledgment: vi.fn().mockImplementation((s: string) => s),
  };
}

// ─── Generators ─────────────────────────────────────────────────────────────────

/** Generate a random non-poor videoQualityGrade */
const nonPoorGradeArb = fc.oneof(
  fc.constant("good" as const),
  fc.constant("degraded" as const),
);

/** Generate a random movementClassification */
const movementClassArb = fc.oneof(
  fc.constant("stationary" as const),
  fc.constant("moderate_movement" as const),
  fc.constant("high_movement" as const),
);

/** Generate random VisualObservations for pose-only mode (no face detector) with non-poor grade */
const visualObservationsArb = fc.record({
  videoQualityGrade: nonPoorGradeArb,
  movementClassification: movementClassArb,
  framesAnalyzed: fc.integer({ min: 1, max: 500 }),
  framesReceived: fc.integer({ min: 1, max: 600 }),
  framesSkippedBySampler: fc.integer({ min: 0, max: 50 }),
  framesErrored: fc.integer({ min: 0, max: 20 }),
  framesDroppedByBackpressure: fc.integer({ min: 0, max: 20 }),
  framesDroppedByTimestamp: fc.integer({ min: 0, max: 10 }),
  framesDroppedByFinalizationBudget: fc.integer({ min: 0, max: 10 }),
  resolutionChangeCount: fc.integer({ min: 0, max: 5 }),
  totalGestureCount: fc.integer({ min: 0, max: 100 }),
  gestureFrequency: fc.double({ min: 0, max: 10, noNaN: true }),
  handsDetectedFrames: fc.integer({ min: 0, max: 500 }),
  handsNotDetectedFrames: fc.integer({ min: 0, max: 500 }),
  meanBodyStabilityScore: fc.double({ min: 0, max: 1, noNaN: true }),
  stageCrossingCount: fc.integer({ min: 0, max: 20 }),
  meanFacialEnergyScore: fc.double({ min: 0, max: 1, noNaN: true }),
  facialEnergyVariation: fc.double({ min: 0, max: 2, noNaN: true }),
  facialEnergyLowSignal: fc.boolean(),
  finalizationLatencyMs: fc.integer({ min: 0, max: 5000 }),
}).map((rec) => {
  const obs: VisualObservations = {
    gazeBreakdown: { audienceFacing: 0, notesFacing: 0, other: 100 },
    faceNotDetectedCount: 0,
    totalGestureCount: rec.totalGestureCount,
    gestureFrequency: rec.gestureFrequency,
    gesturePerSentenceRatio: 0.5,
    handsDetectedFrames: rec.handsDetectedFrames,
    handsNotDetectedFrames: rec.handsNotDetectedFrames,
    meanBodyStabilityScore: rec.meanBodyStabilityScore,
    stageCrossingCount: rec.stageCrossingCount,
    movementClassification: rec.movementClassification,
    meanFacialEnergyScore: rec.meanFacialEnergyScore,
    facialEnergyVariation: rec.facialEnergyVariation,
    facialEnergyLowSignal: rec.facialEnergyLowSignal,
    framesAnalyzed: rec.framesAnalyzed,
    framesReceived: rec.framesReceived,
    framesSkippedBySampler: rec.framesSkippedBySampler,
    framesErrored: rec.framesErrored,
    framesDroppedByBackpressure: rec.framesDroppedByBackpressure,
    framesDroppedByTimestamp: rec.framesDroppedByTimestamp,
    framesDroppedByFinalizationBudget: rec.framesDroppedByFinalizationBudget,
    resolutionChangeCount: rec.resolutionChangeCount,
    videoQualityGrade: rec.videoQualityGrade,
    videoQualityWarning: rec.videoQualityGrade !== "good",
    finalizationLatencyMs: rec.finalizationLatencyMs,
    videoProcessingVersion: {
      tfjsVersion: "4.0.0",
      tfjsBackend: "cpu",
      modelVersions: { blazeface: "1.0", movenet: "1.0" },
      configHash: "abc123",
    },
    gazeReliable: false,
    gestureReliable: true,
    stabilityReliable: true,
    facialEnergyReliable: false,
    capabilities: { face: false, pose: true }, // pose-only mode
  };
  return obs;
});

// ─── Property 4 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 4", () => {
  it("non-poor grade without face detector passes non-null visualObservations to EvaluationGenerator", async () => {
    await fc.assert(
      fc.asyncProperty(
        visualObservationsArb,
        async (visualObs) => {
          const capturedCalls: any[] = [];
          const mockEvalGen = createMockEvalGenerator(capturedCalls);
          const mockToneChecker = createMockToneChecker();

          const mgr = new SessionManager({
            evaluationGenerator: mockEvalGen,
            toneChecker: mockToneChecker,
          } as unknown as SessionManagerDeps);

          const session = mgr.createSession();
          mgr.startRecording(session.id);
          await mgr.stopRecording(session.id);

          // Set up session data for evaluation
          session.transcript = makeBasicTranscript();
          session.metrics = makeBasicMetrics();
          session.visualObservations = visualObs;

          await mgr.generateEvaluation(session.id);

          // Assert EvaluationGenerator.generate was called exactly once
          expect(capturedCalls.length).toBe(1);

          // Assert the 4th argument (visualObservations) is non-null
          const passedVisualObs = capturedCalls[0][3];
          expect(passedVisualObs).not.toBeNull();
          expect(passedVisualObs).toBe(visualObs);

          // Verify it's the same object with pose-only capabilities
          expect(passedVisualObs.capabilities.face).toBe(false);
          expect(passedVisualObs.capabilities.pose).toBe(true);

          // Verify the grade is non-poor (sanity check on our generator)
          expect(["good", "degraded"]).toContain(passedVisualObs.videoQualityGrade);
        },
      ),
      { numRuns: 100 },
    );
  });
});
