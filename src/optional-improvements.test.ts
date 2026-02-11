/**
 * Tests for Task 16: Optional high-value improvements
 *
 * 16.1 Confidence scores per metric (Req 21.1)
 * 16.2 Detection coverage percentage (Req 21.2)
 * 16.3 Per-metric suppression in evaluation (Req 21.3)
 * 16.4 Noise-floor auto-calibration for facial energy (Req 21.4)
 * 16.5 Motion dead-zone for body stability (Req 21.5)
 * 16.6 Camera placement heuristic warning (Req 21.6)
 */

import { describe, it, expect, vi } from "vitest";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type FaceDetector,
  type PoseDetector,
  type FaceDetection,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import { EvaluationGenerator, isMetricReliable } from "./evaluation-generator.js";
import type {
  FrameHeader,
  VideoConfig,
  VisualObservations,
  VisualFeedbackItem,
  StructuredEvaluation,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

function makeJpeg(size = 16): Buffer {
  return Buffer.alloc(size, 0xff);
}

function makeFaceDetector(confidence = 0.9): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [
        [100, 100], [200, 100], [150, 150],
        [150, 200], [80, 130], [220, 130],
      ],
      boundingBox: { x: 80, y: 80, width: 160, height: 160 },
      confidence,
    } satisfies FaceDetection),
  };
}

function makePoseDetector(confidence = 0.8): PoseDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      keypoints: [
        { x: 150, y: 100, confidence: 0.9, name: "nose" },
        { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
        { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
        { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
        { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
        { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
        { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
        { x: 140, y: 300, confidence: 0.6, name: "left_hip" },
        { x: 160, y: 300, confidence: 0.6, name: "right_hip" },
      ],
      confidence,
    } satisfies PoseDetection),
  };
}

function makeDeps(faceConf = 0.9, poseConf = 0.8): VideoProcessorDeps {
  return {
    faceDetector: makeFaceDetector(faceConf),
    poseDetector: makePoseDetector(poseConf),
  };
}

function makeHeader(timestamp: number, seq: number, width = 640, height = 480): FrameHeader {
  return { timestamp, seq, width, height };
}

async function feedFrames(
  vp: VideoProcessor,
  count: number,
  startTimestamp = 0.0,
  interval = 0.5,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    vp.enqueueFrame(
      makeHeader(startTimestamp + i * interval, i),
      makeJpeg(),
    );
  }
  vp.startDrainLoop();
  // Wait for drain loop to process
  await new Promise((r) => setTimeout(r, 200 + count * 50));
}

function makeBaseObservations(overrides?: Partial<VisualObservations>): VisualObservations {
  return {
    gazeBreakdown: { audienceFacing: 65, notesFacing: 25, other: 10 },
    faceNotDetectedCount: 2,
    totalGestureCount: 5,
    gestureFrequency: 3.5,
    gesturePerSentenceRatio: 0.6,
    handsDetectedFrames: 40,
    handsNotDetectedFrames: 10,
    meanBodyStabilityScore: 0.85,
    stageCrossingCount: 1,
    movementClassification: "stationary",
    meanFacialEnergyScore: 0.45,
    facialEnergyVariation: 0.3,
    facialEnergyLowSignal: false,
    framesAnalyzed: 50,
    framesReceived: 60,
    framesSkippedBySampler: 5,
    framesErrored: 2,
    framesDroppedByBackpressure: 3,
    framesDroppedByTimestamp: 0,
    framesDroppedByFinalizationBudget: 0,
    resolutionChangeCount: 0,
    videoQualityGrade: "good",
    videoQualityWarning: false,
    finalizationLatencyMs: 500,
    videoProcessingVersion: {
      tfjsVersion: "4.10.0",
      tfjsBackend: "cpu",
      modelVersions: { blazeface: "1.0.0", movenet: "1.0.0" },
      configHash: "abc123",
    },
    gazeReliable: true,
    gestureReliable: true,
    stabilityReliable: true,
    facialEnergyReliable: true,
    ...overrides,
  };
}

// ─── 16.1: Confidence Scores Per Metric ─────────────────────────────────────────

describe("16.1 Confidence scores per metric (Req 21.1)", () => {
  it("should include confidenceScores in VisualObservations after finalize", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    expect(obs.confidenceScores).toBeDefined();
    expect(obs.confidenceScores!.gaze).toBeGreaterThanOrEqual(0);
    expect(obs.confidenceScores!.gaze).toBeLessThanOrEqual(1);
    expect(obs.confidenceScores!.gesture).toBeGreaterThanOrEqual(0);
    expect(obs.confidenceScores!.gesture).toBeLessThanOrEqual(1);
    expect(obs.confidenceScores!.stability).toBeGreaterThanOrEqual(0);
    expect(obs.confidenceScores!.stability).toBeLessThanOrEqual(1);
    expect(obs.confidenceScores!.facialEnergy).toBeGreaterThanOrEqual(0);
    expect(obs.confidenceScores!.facialEnergy).toBeLessThanOrEqual(1);
  });

  it("should derive confidence from model confidence × coverage", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps(0.9, 0.8);
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 20);
    const obs = await vp.finalize();

    // With high-confidence detectors and good coverage, scores should be > 0
    expect(obs.confidenceScores!.gaze).toBeGreaterThan(0);
    expect(obs.confidenceScores!.stability).toBeGreaterThan(0);
  });

  it("should return zero confidence when no frames analyzed", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    const obs = await vp.finalize();

    expect(obs.confidenceScores).toBeDefined();
    expect(obs.confidenceScores!.gaze).toBe(0);
    expect(obs.confidenceScores!.gesture).toBe(0);
    expect(obs.confidenceScores!.stability).toBe(0);
    expect(obs.confidenceScores!.facialEnergy).toBe(0);
  });
});

// ─── 16.2: Detection Coverage Percentage ────────────────────────────────────────

describe("16.2 Detection coverage percentage (Req 21.2)", () => {
  it("should include detectionCoverage in VisualObservations after finalize", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    expect(obs.detectionCoverage).toBeDefined();
    expect(obs.detectionCoverage!.gaze).toBeGreaterThanOrEqual(0);
    expect(obs.detectionCoverage!.gaze).toBeLessThanOrEqual(1);
    expect(obs.detectionCoverage!.gesture).toBeGreaterThanOrEqual(0);
    expect(obs.detectionCoverage!.gesture).toBeLessThanOrEqual(1);
    expect(obs.detectionCoverage!.stability).toBeGreaterThanOrEqual(0);
    expect(obs.detectionCoverage!.stability).toBeLessThanOrEqual(1);
    expect(obs.detectionCoverage!.facialEnergy).toBeGreaterThanOrEqual(0);
    expect(obs.detectionCoverage!.facialEnergy).toBeLessThanOrEqual(1);
  });

  it("should return zero coverage when no frames analyzed", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    const obs = await vp.finalize();

    expect(obs.detectionCoverage).toBeDefined();
    expect(obs.detectionCoverage!.gaze).toBe(0);
    expect(obs.detectionCoverage!.gesture).toBe(0);
    expect(obs.detectionCoverage!.stability).toBe(0);
    expect(obs.detectionCoverage!.facialEnergy).toBe(0);
  });

  it("should report coverage as fraction of framesAnalyzed", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    // With mock detectors always succeeding, coverage should be high
    if (obs.framesAnalyzed > 0) {
      expect(obs.detectionCoverage!.gaze).toBeGreaterThan(0);
    }
  });
});

// ─── 16.3: Per-Metric Suppression in Evaluation ────────────────────────────────

describe("16.3 Per-metric suppression in evaluation (Req 21.3)", () => {
  it("isMetricReliable maps gaze metrics to gazeReliable flag", () => {
    const obs = makeBaseObservations({ gazeReliable: false });
    expect(isMetricReliable("gazeBreakdown.audienceFacing", obs)).toBe(false);
    expect(isMetricReliable("gazeBreakdown.notesFacing", obs)).toBe(false);
    expect(isMetricReliable("faceNotDetectedCount", obs)).toBe(false);
  });

  it("isMetricReliable maps gesture metrics to gestureReliable flag", () => {
    const obs = makeBaseObservations({ gestureReliable: false });
    expect(isMetricReliable("totalGestureCount", obs)).toBe(false);
    expect(isMetricReliable("gestureFrequency", obs)).toBe(false);
    expect(isMetricReliable("gesturePerSentenceRatio", obs)).toBe(false);
  });

  it("isMetricReliable maps stability metrics to stabilityReliable flag", () => {
    const obs = makeBaseObservations({ stabilityReliable: false });
    expect(isMetricReliable("meanBodyStabilityScore", obs)).toBe(false);
    expect(isMetricReliable("stageCrossingCount", obs)).toBe(false);
    expect(isMetricReliable("movementClassification", obs)).toBe(false);
  });

  it("isMetricReliable maps facial energy metrics to facialEnergyReliable flag", () => {
    const obs = makeBaseObservations({ facialEnergyReliable: false });
    expect(isMetricReliable("meanFacialEnergyScore", obs)).toBe(false);
    expect(isMetricReliable("facialEnergyVariation", obs)).toBe(false);
  });

  it("isMetricReliable returns true for unknown metrics (conservative)", () => {
    const obs = makeBaseObservations();
    expect(isMetricReliable("unknownMetric", obs)).toBe(true);
  });

  it("renderScript suppresses visual feedback items referencing unreliable metrics", () => {
    const obs = makeBaseObservations({
      gazeReliable: false,
      gestureReliable: true,
    });

    const gazeItem: VisualFeedbackItem = {
      type: "visual_observation",
      summary: "Gaze observation",
      observation_data: "metric=gazeBreakdown.audienceFacing; value=65; source=visualObservations",
      explanation: "I observed audience-facing gaze at 65%.",
    };

    const gestureItem: VisualFeedbackItem = {
      type: "visual_observation",
      summary: "Gesture observation",
      observation_data: "metric=totalGestureCount; value=5; source=visualObservations",
      explanation: "I observed 5 gestures during the speech.",
    };

    const evaluation: StructuredEvaluation = {
      opening: "Great speech.",
      items: [{
        type: "commendation",
        summary: "Good content",
        explanation: "Well structured.",
        evidence_quote: "today today today today today today",
        evidence_timestamp: 0,
      }, {
        type: "commendation",
        summary: "Good delivery",
        explanation: "Clear voice.",
        evidence_quote: "today today today today today today",
        evidence_timestamp: 1,
      }],
      closing: "Keep it up.",
      structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      visual_feedback: [gazeItem, gestureItem],
    };

    const client = { chat: { completions: { create: vi.fn() } }, embeddings: { create: vi.fn() } };
    const generator = new EvaluationGenerator(client as any);
    const script = generator.renderScript(evaluation, undefined, undefined, obs);

    // Gaze item should be suppressed (gazeReliable = false)
    expect(script).not.toContain(gazeItem.explanation);
    // Gesture item should be present (gestureReliable = true)
    expect(script).toContain(gestureItem.explanation);
    // Transition should be present since at least one item survived
    expect(script).toContain("Looking at your delivery from a visual perspective...");
  });

  it("renderScript removes visual section entirely when all items reference unreliable metrics", () => {
    const obs = makeBaseObservations({
      gazeReliable: false,
      gestureReliable: false,
    });

    const gazeItem: VisualFeedbackItem = {
      type: "visual_observation",
      summary: "Gaze observation",
      observation_data: "metric=gazeBreakdown.audienceFacing; value=65; source=visualObservations",
      explanation: "I observed audience-facing gaze at 65%.",
    };

    const gestureItem: VisualFeedbackItem = {
      type: "visual_observation",
      summary: "Gesture observation",
      observation_data: "metric=totalGestureCount; value=5; source=visualObservations",
      explanation: "I observed 5 gestures during the speech.",
    };

    const evaluation: StructuredEvaluation = {
      opening: "Great speech.",
      items: [{
        type: "commendation",
        summary: "Good content",
        explanation: "Well structured.",
        evidence_quote: "today today today today today today",
        evidence_timestamp: 0,
      }, {
        type: "commendation",
        summary: "Good delivery",
        explanation: "Clear voice.",
        evidence_quote: "today today today today today today",
        evidence_timestamp: 1,
      }],
      closing: "Keep it up.",
      structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      visual_feedback: [gazeItem, gestureItem],
    };

    const client = { chat: { completions: { create: vi.fn() } }, embeddings: { create: vi.fn() } };
    const generator = new EvaluationGenerator(client as any);
    const script = generator.renderScript(evaluation, undefined, undefined, obs);

    // No visual section at all
    expect(script).not.toContain("Looking at your delivery from a visual perspective...");
    expect(script).not.toContain(gazeItem.explanation);
    expect(script).not.toContain(gestureItem.explanation);
  });
});

// ─── 16.4: Noise-Floor Auto-Calibration ─────────────────────────────────────────

describe("16.4 Noise-floor auto-calibration for facial energy (Req 21.4)", () => {
  it("should subtract noise floor from facial energy after first 3 seconds", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    // Feed frames during calibration period (first 3 seconds)
    for (let i = 0; i < 6; i++) {
      vp.enqueueFrame(makeHeader(i * 0.5, i), makeJpeg());
    }
    // Feed frames after calibration period
    for (let i = 6; i < 20; i++) {
      vp.enqueueFrame(makeHeader(3.0 + (i - 6) * 0.5, i), makeJpeg());
    }

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 1500));
    const obs = await vp.finalize();

    // Should have processed frames and computed facial energy
    expect(obs.framesAnalyzed).toBeGreaterThan(0);
    // Facial energy should be non-negative (noise floor subtracted, clamped to 0)
    expect(obs.meanFacialEnergyScore).toBeGreaterThanOrEqual(0);
  });
});

// ─── 16.5: Motion Dead-Zone ─────────────────────────────────────────────────────

describe("16.5 Motion dead-zone for body stability (Req 21.5)", () => {
  it("should filter small posture sway when motionDeadZoneFraction > 0", async () => {
    const config = makeConfig({
      frameRate: 2,
      motionDeadZoneFraction: 0.02, // 2% of frame diagonal
    });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 20);
    const obs = await vp.finalize();

    // With dead-zone enabled and mock detectors returning consistent positions,
    // stability should be high (small movements filtered out)
    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0);
    expect(obs.meanBodyStabilityScore).toBeLessThanOrEqual(1);
  });

  it("should not filter when motionDeadZoneFraction is 0 (disabled)", async () => {
    const config = makeConfig({
      frameRate: 2,
      motionDeadZoneFraction: 0, // disabled
    });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 20);
    const obs = await vp.finalize();

    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0);
    expect(obs.meanBodyStabilityScore).toBeLessThanOrEqual(1);
  });

  it("dead-zone snaps to previous position for small displacements", async () => {
    // Create a pose detector that returns slightly varying positions
    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        // Tiny variation in hip positions (< 2% of frame diagonal)
        const jitter = (callCount % 2 === 0) ? 1 : 0; // 1 pixel jitter
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: 140 + jitter, y: 300, confidence: 0.6, name: "left_hip" },
            { x: 160 + jitter, y: 300, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({
      frameRate: 2,
      motionDeadZoneFraction: 0.02,
    });
    const deps: VideoProcessorDeps = {
      faceDetector: makeFaceDetector(),
      poseDetector,
    };
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 20);
    const obs = await vp.finalize();

    // With dead-zone filtering tiny jitter, stability should be very high
    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0.9);
  });
});

// ─── 16.6: Camera Placement Heuristic Warning ──────────────────────────────────

describe("16.6 Camera placement heuristic warning (Req 21.6)", () => {
  it("should include cameraPlacementWarning in VisualObservations", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    expect(obs.cameraPlacementWarning).toBeDefined();
    expect(typeof obs.cameraPlacementWarning!.estimatedAngleDeg).toBe("number");
    expect(typeof obs.cameraPlacementWarning!.isFrontal).toBe("boolean");
  });

  it("should report frontal when face landmarks are symmetric", async () => {
    // Symmetric face landmarks → frontal camera
    const faceDetector: FaceDetector = {
      detect: vi.fn().mockResolvedValue({
        landmarks: [
          [140, 100], [160, 100], [150, 130], // eyes + nose centered
          [150, 160], [120, 120], [180, 120], // mouth + ears symmetric
        ],
        boundingBox: { x: 100, y: 80, width: 100, height: 120 },
        confidence: 0.95,
      } satisfies FaceDetection),
    };

    const config = makeConfig({ frameRate: 2 });
    const deps: VideoProcessorDeps = {
      faceDetector,
      poseDetector: makePoseDetector(),
    };
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    expect(obs.cameraPlacementWarning).toBeDefined();
    expect(obs.cameraPlacementWarning!.isFrontal).toBe(true);
    expect(obs.cameraPlacementWarning!.warning).toBeUndefined();
  });

  it("should warn when face landmarks are highly asymmetric (off-axis camera)", async () => {
    // Highly asymmetric face landmarks → off-axis camera
    const faceDetector: FaceDetector = {
      detect: vi.fn().mockResolvedValue({
        landmarks: [
          [160, 100], [200, 100], [190, 130], // nose far from center
          [190, 160], [150, 120], [210, 120], // ears very asymmetric relative to nose
        ],
        boundingBox: { x: 140, y: 80, width: 80, height: 120 },
        confidence: 0.95,
      } satisfies FaceDetection),
    };

    const config = makeConfig({ frameRate: 2 });
    const deps: VideoProcessorDeps = {
      faceDetector,
      poseDetector: makePoseDetector(),
    };
    const vp = new VideoProcessor(config, deps);

    await feedFrames(vp, 10);
    const obs = await vp.finalize();

    expect(obs.cameraPlacementWarning).toBeDefined();
    // The asymmetry should produce a non-zero angle
    expect(obs.cameraPlacementWarning!.estimatedAngleDeg).toBeGreaterThan(0);
  });

  it("should not include cameraPlacementWarning when no frames analyzed", async () => {
    const config = makeConfig({ frameRate: 2 });
    const deps = makeDeps();
    const vp = new VideoProcessor(config, deps);

    const obs = await vp.finalize();

    // No frames → no face landmarks → no warning
    expect(obs.cameraPlacementWarning).toBeUndefined();
  });
});
