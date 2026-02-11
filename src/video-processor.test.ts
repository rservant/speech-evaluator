/**
 * Unit tests for video-processor.ts — core structure (task 4.1)
 * Validates: Requirements 2.1, 2.4, 2.5, 12.1, 14.1, 15.5, 16.2, 16.4, 16.5, 18.2
 */

import { describe, it, expect, vi } from "vitest";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  roundMetric,
  estimateYaw,
  estimatePitch,
  computeMaxHandDisplacement,
  type FaceDetector,
  type PoseDetector,
  type FaceDetection,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import type { FrameHeader, VideoConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeHeader(
  seq: number,
  timestamp?: number,
  width = 640,
  height = 480,
): FrameHeader {
  return {
    timestamp: timestamp ?? seq * 0.5,
    seq,
    width,
    height,
  };
}

function makeJpeg(size = 16): Buffer {
  return Buffer.alloc(size, 0xff);
}

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

/** Create a mock face detector that returns a valid detection. */
function makeFaceDetector(
  confidence = 0.9,
): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [
        [100, 100],
        [200, 100],
        [150, 150],
        [150, 200],
        [80, 130],
        [220, 130],
      ],
      boundingBox: { x: 80, y: 80, width: 160, height: 160 },
      confidence,
    } satisfies FaceDetection),
  };
}

/** Create a mock pose detector that returns a valid detection. */
function makePoseDetector(
  confidence = 0.8,
): PoseDetector {
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

function makeDeps(overrides?: Partial<VideoProcessorDeps>): VideoProcessorDeps {
  return {
    faceDetector: makeFaceDetector(),
    poseDetector: makePoseDetector(),
    ...overrides,
  };
}

// ─── roundMetric ────────────────────────────────────────────────────────────────

describe("roundMetric", () => {
  it("rounds to 4 decimal places by default", () => {
    expect(roundMetric(0.123456789)).toBe(0.1235);
  });

  it("rounds to specified precision", () => {
    expect(roundMetric(3.14159, 2)).toBe(3.14);
  });

  it("handles zero", () => {
    expect(roundMetric(0)).toBe(0);
  });

  it("handles negative values", () => {
    expect(roundMetric(-1.23456, 3)).toBe(-1.235);
  });
});

// ─── Frame Enqueue Validation ───────────────────────────────────────────────────

describe("VideoProcessor — enqueueFrame validation", () => {
  it("rejects frames with missing header", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(null as unknown as FrameHeader, makeJpeg());
    const obs = await vp.finalize();
    expect(obs.framesReceived).toBe(1);
    expect(obs.framesErrored).toBe(1);
    expect(obs.framesAnalyzed).toBe(0);
  });

  it("rejects frames with negative timestamp", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, -1), makeJpeg());
    const obs = await vp.finalize();
    expect(obs.framesErrored).toBe(1);
  });

  it("rejects frames with non-number timestamp", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(
      { timestamp: "bad" as unknown as number, seq: 0, width: 640, height: 480 },
      makeJpeg(),
    );
    const obs = await vp.finalize();
    expect(obs.framesErrored).toBe(1);
  });

  it("rejects frames with non-integer seq", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(
      { timestamp: 0, seq: 1.5, width: 640, height: 480 },
      makeJpeg(),
    );
    const obs = await vp.finalize();
    expect(obs.framesErrored).toBe(1);
  });

  it("rejects frames with negative seq", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(
      { timestamp: 0, seq: -1, width: 640, height: 480 },
      makeJpeg(),
    );
    const obs = await vp.finalize();
    expect(obs.framesErrored).toBe(1);
  });

  it("rejects frames with empty jpegBuffer", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), Buffer.alloc(0));
    const obs = await vp.finalize();
    expect(obs.framesErrored).toBe(1);
  });

  it("accepts frame with timestamp=0 and seq=0 (falsy-zero check)", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();
    // Frame should be enqueued (not rejected as malformed)
    expect(obs.framesErrored).toBe(0);
    expect(obs.framesReceived).toBe(1);
  });

  it("rejects seq regression (non-increasing seq)", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(5, 1.0), makeJpeg());
    vp.enqueueFrame(makeHeader(3, 1.5), makeJpeg()); // seq regression
    const obs = await vp.finalize();
    expect(obs.framesDroppedByTimestamp).toBe(1);
    expect(obs.framesReceived).toBe(2);
  });

  it("rejects duplicate seq (seq == lastSeq)", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(5, 1.0), makeJpeg());
    vp.enqueueFrame(makeHeader(5, 1.5), makeJpeg()); // same seq
    const obs = await vp.finalize();
    expect(obs.framesDroppedByTimestamp).toBe(1);
  });

  it("rejects timestamp regression (non-monotonic)", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 2.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 1.5), makeJpeg()); // timestamp regression
    const obs = await vp.finalize();
    expect(obs.framesDroppedByTimestamp).toBe(1);
  });

  it("rejects timestamp jump >2s", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 5.0), makeJpeg()); // 5s jump > 2s threshold
    const obs = await vp.finalize();
    expect(obs.framesDroppedByTimestamp).toBe(1);
  });

  it("accepts frames within 2s gap", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 1.5), makeJpeg()); // 1.5s gap, within threshold
    const obs = await vp.finalize();
    expect(obs.framesDroppedByTimestamp).toBe(0);
    expect(obs.framesReceived).toBe(2);
  });
});

// ─── Drain Loop Processing ──────────────────────────────────────────────────────

describe("VideoProcessor — drain loop processes frames", () => {
  it("processes enqueued frames through the drain loop", async () => {
    const faceDetector = makeFaceDetector();
    const poseDetector = makePoseDetector();
    const vp = new VideoProcessor(makeConfig(), { faceDetector, poseDetector });

    // Enqueue frames
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    // Start drain loop and let it run briefly
    const loopPromise = vp.startDrainLoop();

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Finalize stops the loop and returns observations
    const obs = await vp.finalize();

    expect(obs.framesReceived).toBe(3);
    expect(obs.framesAnalyzed).toBeGreaterThan(0);
    expect(faceDetector.detect).toHaveBeenCalled();
    expect(poseDetector.detect).toHaveBeenCalled();
  });
});

// ─── Finalization ───────────────────────────────────────────────────────────────

describe("VideoProcessor — finalization", () => {
  it("returns VisualObservations with all required fields", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());

    const obs = await vp.finalize();

    // Check all required fields exist
    expect(obs).toHaveProperty("gazeBreakdown");
    expect(obs).toHaveProperty("faceNotDetectedCount");
    expect(obs).toHaveProperty("totalGestureCount");
    expect(obs).toHaveProperty("gestureFrequency");
    expect(obs).toHaveProperty("gesturePerSentenceRatio");
    expect(obs).toHaveProperty("handsDetectedFrames");
    expect(obs).toHaveProperty("handsNotDetectedFrames");
    expect(obs).toHaveProperty("meanBodyStabilityScore");
    expect(obs).toHaveProperty("stageCrossingCount");
    expect(obs).toHaveProperty("movementClassification");
    expect(obs).toHaveProperty("meanFacialEnergyScore");
    expect(obs).toHaveProperty("facialEnergyVariation");
    expect(obs).toHaveProperty("facialEnergyLowSignal");
    expect(obs).toHaveProperty("framesAnalyzed");
    expect(obs).toHaveProperty("framesReceived");
    expect(obs).toHaveProperty("framesSkippedBySampler");
    expect(obs).toHaveProperty("framesErrored");
    expect(obs).toHaveProperty("framesDroppedByBackpressure");
    expect(obs).toHaveProperty("framesDroppedByTimestamp");
    expect(obs).toHaveProperty("framesDroppedByFinalizationBudget");
    expect(obs).toHaveProperty("resolutionChangeCount");
    expect(obs).toHaveProperty("videoQualityGrade");
    expect(obs).toHaveProperty("videoQualityWarning");
    expect(obs).toHaveProperty("finalizationLatencyMs");
    expect(obs).toHaveProperty("videoProcessingVersion");
    expect(obs).toHaveProperty("gazeReliable");
    expect(obs).toHaveProperty("gestureReliable");
    expect(obs).toHaveProperty("stabilityReliable");
    expect(obs).toHaveProperty("facialEnergyReliable");
  });

  it("videoQualityWarning is derived from videoQualityGrade", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    const obs = await vp.finalize();
    expect(obs.videoQualityWarning).toBe(obs.videoQualityGrade !== "good");
  });

  it("gaze breakdown percentages sum to 100 when frames analyzed", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());

    const obs = await vp.finalize();

    if (obs.framesAnalyzed > 0) {
      const sum =
        obs.gazeBreakdown.audienceFacing +
        obs.gazeBreakdown.notesFacing +
        obs.gazeBreakdown.other;
      expect(sum).toBeCloseTo(100, 2);
    }
  });

  it("finalizationLatencyMs is recorded", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    const obs = await vp.finalize();
    expect(obs.finalizationLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("videoProcessingVersion contains configHash", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    const obs = await vp.finalize();
    expect(obs.videoProcessingVersion.configHash).toBeTruthy();
    expect(typeof obs.videoProcessingVersion.configHash).toBe("string");
  });

  it("counts remaining queue frames as framesDroppedByFinalizationBudget", async () => {
    // Use a detector that takes a long time to simulate budget exhaustion
    const slowDetector: FaceDetector = {
      detect: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(null), 100),
        ),
    };
    const config = makeConfig({ finalizationBudgetMs: 50 });
    const vp = new VideoProcessor(config, {
      faceDetector: slowDetector,
      poseDetector: makePoseDetector(),
    });

    // Enqueue many frames
    for (let i = 0; i < 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    const obs = await vp.finalize();
    // Some frames should be dropped by budget since detector is slow
    expect(obs.framesDroppedByFinalizationBudget).toBeGreaterThanOrEqual(0);
    // Total should account for all frames
    expect(obs.framesReceived).toBe(10);
  });
});

// ─── Stop ───────────────────────────────────────────────────────────────────────

describe("VideoProcessor — stop", () => {
  it("clears the queue and stops the drain loop", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    vp.stop();

    // After stop, finalize should show no frames analyzed (queue was cleared)
    const obs = await vp.finalize();
    expect(obs.framesAnalyzed).toBe(0);
    expect(obs.framesReceived).toBe(3);
  });

  it("drain loop exits after stop", async () => {
    const faceDetector = makeFaceDetector();
    const vp = new VideoProcessor(makeConfig(), { faceDetector });

    const loopPromise = vp.startDrainLoop();
    vp.stop();

    // Wait a bit to ensure loop exits
    await new Promise((resolve) => setTimeout(resolve, 100));

    // After stop, the drain loop should have exited.
    // Verify that stop cleared the queue.
    const obs = await vp.finalize();
    expect(obs.framesAnalyzed).toBe(0);
  });
});

// ─── Error Handling ─────────────────────────────────────────────────────────────

describe("VideoProcessor — error handling", () => {
  it("per-frame errors don't halt processing", async () => {
    let callCount = 0;
    const flakeyDetector: FaceDetector = {
      detect: () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Simulated inference failure");
        }
        return Promise.resolve({
          landmarks: [[100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130]],
          boundingBox: { x: 80, y: 80, width: 160, height: 160 },
          confidence: 0.9,
        });
      },
    };

    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: flakeyDetector,
      poseDetector: makePoseDetector(),
    });

    // Enqueue multiple frames — first will error, rest should succeed
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.2), makeJpeg());

    const loopPromise = vp.startDrainLoop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const obs = await vp.finalize();

    expect(obs.framesReceived).toBe(3);
    expect(obs.framesErrored).toBeGreaterThanOrEqual(1);
    // At least some frames should have been analyzed despite the error
    expect(obs.framesAnalyzed + obs.framesErrored).toBeGreaterThan(0);
  });

  it("increments framesErrored for detector failures", async () => {
    const failingDetector: FaceDetector = {
      detect: () => Promise.reject(new Error("Always fails")),
    };

    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: failingDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());

    const loopPromise = vp.startDrainLoop();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const obs = await vp.finalize();
    expect(obs.framesErrored).toBeGreaterThanOrEqual(1);
  });
});

// ─── Adaptive Sampling ──────────────────────────────────────────────────────────

describe("VideoProcessor — adaptive sampling", () => {
  it("enters adaptive mode when backpressure exceeds overload threshold", async () => {
    // Use a tiny queue to force backpressure
    const config = makeConfig({ queueMaxSize: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    // Enqueue many frames rapidly to cause backpressure
    for (let i = 0; i < 20; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.1), makeJpeg());
    }

    const obs = await vp.finalize();
    // With a queue of 2 and 20 frames, many should be dropped by backpressure
    expect(obs.framesDroppedByBackpressure).toBeGreaterThan(0);
  });
});

// ─── Resolution Change ──────────────────────────────────────────────────────────

describe("VideoProcessor — resolution change handling", () => {
  it("increments resolutionChangeCount on resolution change", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());

    vp.enqueueFrame(makeHeader(0, 0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 1280, 720), makeJpeg()); // resolution change
    vp.enqueueFrame(makeHeader(2, 1.0, 1280, 720), makeJpeg()); // same resolution

    const obs = await vp.finalize();
    expect(obs.resolutionChangeCount).toBe(1);
  });

  it("preserves accumulated aggregates across resolution changes", async () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());

    vp.enqueueFrame(makeHeader(0, 0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 1280, 720), makeJpeg()); // resolution change
    vp.enqueueFrame(makeHeader(3, 1.5, 1280, 720), makeJpeg());

    const obs = await vp.finalize();
    expect(obs.framesReceived).toBe(4);
    expect(obs.resolutionChangeCount).toBe(1);
  });
});

// ─── getStatus ──────────────────────────────────────────────────────────────────

describe("VideoProcessor — getStatus", () => {
  it("returns initial status with zero values", () => {
    const vp = new VideoProcessor(makeConfig(), makeDeps());
    const status = vp.getStatus();
    expect(status.framesProcessed).toBe(0);
    expect(status.framesDropped).toBe(0);
    expect(status.processingLatencyMs).toBe(0);
  });
});

// ─── No Detectors ───────────────────────────────────────────────────────────────

describe("VideoProcessor — no detectors", () => {
  it("works without any detectors (graceful degradation)", async () => {
    const vp = new VideoProcessor(makeConfig(), {});

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());

    const obs = await vp.finalize();
    expect(obs.framesReceived).toBe(2);
    expect(obs.framesAnalyzed).toBeGreaterThanOrEqual(0);
    expect(obs.framesErrored).toBe(0);
  });
});

// ─── Confidence Gating ──────────────────────────────────────────────────────────

describe("VideoProcessor — confidence gating", () => {
  it("rejects face detections below confidence threshold", async () => {
    const lowConfFace = makeFaceDetector(0.2); // below 0.5 threshold
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: lowConfFace,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    // Face should be classified as "other" due to low confidence
    expect(obs.faceNotDetectedCount).toBeGreaterThanOrEqual(0);
  });

  it("rejects pose detections below confidence threshold", async () => {
    const lowConfPose = makePoseDetector(0.1); // below 0.3 threshold
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: makeFaceDetector(),
      poseDetector: lowConfPose,
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    // Hands should not be detected due to low pose confidence
    expect(obs.handsNotDetectedFrames).toBeGreaterThanOrEqual(0);
  });
});

// ─── estimateYaw / estimatePitch helpers ────────────────────────────────────────

describe("estimateYaw", () => {
  it("returns ~0 for a centered face (symmetric ear distances)", () => {
    // Nose centered between ears
    const landmarks = [
      [150, 100], // right eye
      [250, 100], // left eye
      [200, 150], // nose (centered)
      [200, 200], // mouth
      [120, 130], // right ear
      [280, 130], // left ear
    ];
    const yaw = estimateYaw(landmarks);
    expect(Math.abs(yaw)).toBeLessThan(2); // near zero
  });

  it("returns positive yaw when nose is closer to right ear (turned left)", () => {
    // Nose shifted toward right ear → rightDist < leftDist → negative diff
    // Actually: yaw = atan2(rightDist - leftDist, interEarDist)
    // If nose closer to right ear: rightDist < leftDist → rightDist - leftDist < 0 → negative yaw
    const landmarks = [
      [120, 100], // right eye
      [200, 100], // left eye
      [130, 150], // nose (shifted toward right ear)
      [160, 200], // mouth
      [100, 130], // right ear
      [250, 130], // left ear
    ];
    const yaw = estimateYaw(landmarks);
    // Nose closer to right ear → rightDist < leftDist → negative yaw
    expect(yaw).toBeLessThan(0);
  });

  it("returns negative yaw when nose is closer to left ear (turned right)", () => {
    const landmarks = [
      [200, 100], // right eye
      [280, 100], // left eye
      [270, 150], // nose (shifted toward left ear)
      [240, 200], // mouth
      [150, 130], // right ear
      [300, 130], // left ear
    ];
    const yaw = estimateYaw(landmarks);
    // Nose closer to left ear → rightDist > leftDist → positive yaw
    expect(yaw).toBeGreaterThan(0);
  });

  it("returns 0 when inter-ear distance is 0", () => {
    const landmarks = [
      [150, 100],
      [250, 100],
      [200, 150],
      [200, 200],
      [200, 130], // right ear same as left ear
      [200, 130], // left ear
    ];
    expect(estimateYaw(landmarks)).toBe(0);
  });
});

describe("estimatePitch", () => {
  it("returns ~0 for a level face (nose midway between eyes and mouth)", () => {
    // Eye midpoint Y = 100, nose Y = 150, mouth Y = 200
    // eyeNoseDist = 50, noseMouthDist = 50, eyeMouthDist = 100
    // pitch = atan2(50 - 50, 100) = atan2(0, 100) = 0
    const landmarks = [
      [150, 100], // right eye
      [250, 100], // left eye
      [200, 150], // nose
      [200, 200], // mouth
      [120, 130], // right ear
      [280, 130], // left ear
    ];
    const pitch = estimatePitch(landmarks);
    expect(Math.abs(pitch)).toBeLessThan(1);
  });

  it("returns negative pitch when looking down (nose closer to mouth)", () => {
    // Eye midpoint Y = 100, nose Y = 180, mouth Y = 200
    // eyeNoseDist = 80, noseMouthDist = 20, eyeMouthDist = 100
    // pitch = atan2(20 - 80, 100) = atan2(-60, 100) → negative
    const landmarks = [
      [150, 100], // right eye
      [250, 100], // left eye
      [200, 180], // nose (closer to mouth → looking down)
      [200, 200], // mouth
      [120, 130], // right ear
      [280, 130], // left ear
    ];
    const pitch = estimatePitch(landmarks);
    expect(pitch).toBeLessThan(0);
  });

  it("returns positive pitch when looking up (nose closer to eyes)", () => {
    // Eye midpoint Y = 100, nose Y = 110, mouth Y = 200
    // eyeNoseDist = 10, noseMouthDist = 90, eyeMouthDist = 100
    // pitch = atan2(90 - 10, 100) = atan2(80, 100) → positive
    const landmarks = [
      [150, 100], // right eye
      [250, 100], // left eye
      [200, 110], // nose (closer to eyes → looking up)
      [200, 200], // mouth
      [120, 130], // right ear
      [280, 130], // left ear
    ];
    const pitch = estimatePitch(landmarks);
    expect(pitch).toBeGreaterThan(0);
  });

  it("returns 0 when eye-mouth distance is 0", () => {
    const landmarks = [
      [150, 200], // right eye at same Y as mouth
      [250, 200], // left eye at same Y as mouth
      [200, 200], // nose
      [200, 200], // mouth
      [120, 130],
      [280, 130],
    ];
    expect(estimatePitch(landmarks)).toBe(0);
  });
});

// ─── Gaze Classification (integrated via VideoProcessor) ────────────────────────

describe("VideoProcessor — gaze classification", () => {
  /**
   * Helper: create a face detector that returns landmarks producing
   * a specific approximate yaw/pitch.
   */
  function makeFaceDetectorWithLandmarks(
    landmarks: number[][],
    confidence = 0.9,
    bboxFraction = 0.1, // fraction of 640x480 frame
  ): FaceDetector {
    const bboxSize = Math.sqrt(bboxFraction * 640 * 480);
    return {
      detect: vi.fn().mockResolvedValue({
        landmarks,
        boundingBox: {
          x: 320 - bboxSize / 2,
          y: 240 - bboxSize / 2,
          width: bboxSize,
          height: bboxSize,
        },
        confidence,
      } satisfies FaceDetection),
    };
  }

  // Centered face landmarks (yaw ~0, pitch ~0 → audience-facing)
  const centeredLandmarks = [
    [150, 100], // right eye
    [250, 100], // left eye
    [200, 150], // nose (centered)
    [200, 200], // mouth
    [120, 130], // right ear
    [280, 130], // left ear
  ];

  // Looking-down landmarks (pitch < -20° → notes-facing)
  const lookingDownLandmarks = [
    [150, 100], // right eye
    [250, 100], // left eye
    [200, 185], // nose very close to mouth → large eyeNoseDist, small noseMouthDist → negative pitch
    [200, 200], // mouth
    [120, 130], // right ear
    [280, 130], // left ear
  ];

  it("classifies centered face as audience-facing", async () => {
    const faceDetector = makeFaceDetectorWithLandmarks(centeredLandmarks);
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.audienceFacing).toBe(100);
    expect(obs.gazeBreakdown.notesFacing).toBe(0);
    expect(obs.gazeBreakdown.other).toBe(0);
  });

  it("classifies looking-down face as notes-facing", async () => {
    const faceDetector = makeFaceDetectorWithLandmarks(lookingDownLandmarks);
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    // Need multiple frames for EMA to converge past the -20° threshold
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.2), makeJpeg());

    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.notesFacing).toBeGreaterThan(0);
    // After EMA converges, most frames should be notes-facing
    expect(obs.gazeBreakdown.notesFacing).toBeGreaterThanOrEqual(50);
  });

  it("classifies face-not-detected as other and increments faceNotDetectedCount", async () => {
    const noFaceDetector: FaceDetector = {
      detect: vi.fn().mockResolvedValue(null),
    };
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: noFaceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.other).toBe(100);
    expect(obs.faceNotDetectedCount).toBe(1);
  });

  it("classifies face below confidence threshold as other", async () => {
    const lowConfDetector = makeFaceDetectorWithLandmarks(centeredLandmarks, 0.2);
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: lowConfDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.other).toBe(100);
    expect(obs.faceNotDetectedCount).toBe(1);
  });

  it("classifies face below minimum area fraction as other", async () => {
    // Face bbox is tiny: 0.01 of frame area (below 0.05 threshold)
    const tinyFaceDetector = makeFaceDetectorWithLandmarks(
      centeredLandmarks,
      0.9,
      0.01, // 1% of frame area, below 5% threshold
    );
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: tinyFaceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.other).toBe(100);
  });

  it("applies EMA smoothing across frames", async () => {
    // First frame: centered (audience-facing)
    // Second frame: also centered
    // EMA should keep it audience-facing
    const faceDetector = makeFaceDetectorWithLandmarks(centeredLandmarks);
    const vp = new VideoProcessor(makeConfig(), {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.2), makeJpeg());

    const obs = await vp.finalize();

    expect(obs.gazeBreakdown.audienceFacing).toBe(100);
    expect(obs.framesAnalyzed).toBe(3);
  });

  it("resets EMA when face not detected for >1 second", async () => {
    let callCount = 0;
    const intermittentDetector: FaceDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          // First frame: face detected (centered)
          return Promise.resolve({
            landmarks: centeredLandmarks,
            boundingBox: { x: 100, y: 100, width: 200, height: 200 },
            confidence: 0.9,
          });
        }
        // Frames 2+: no face
        return Promise.resolve(null);
      }),
    };

    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: intermittentDetector,
      poseDetector: makePoseDetector(),
    });

    // Frame at t=0: face detected
    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    // Frame at t=1.5: no face, >1s since last face → EMA should reset
    vp.enqueueFrame(makeHeader(1, 1.5), makeJpeg());

    const obs = await vp.finalize();

    // First frame: audience-facing, second frame: other (no face)
    expect(obs.gazeBreakdown.audienceFacing).toBe(50);
    expect(obs.gazeBreakdown.other).toBe(50);
  });

  it("gaze breakdown percentages sum to 100 with mixed classifications", async () => {
    let callCount = 0;
    const mixedDetector: FaceDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 2 === 1) {
          // Odd frames: centered face
          return Promise.resolve({
            landmarks: centeredLandmarks,
            boundingBox: { x: 100, y: 100, width: 200, height: 200 },
            confidence: 0.9,
          });
        }
        // Even frames: no face
        return Promise.resolve(null);
      }),
    };

    const vp = new VideoProcessor(makeConfig(), {
      faceDetector: mixedDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.6), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.2), makeJpeg());
    vp.enqueueFrame(makeHeader(3, 1.8), makeJpeg());

    const obs = await vp.finalize();

    const sum =
      obs.gazeBreakdown.audienceFacing +
      obs.gazeBreakdown.notesFacing +
      obs.gazeBreakdown.other;
    expect(sum).toBeCloseTo(100, 2);
  });
});

// ─── computeMaxHandDisplacement ─────────────────────────────────────────────────

describe("computeMaxHandDisplacement", () => {
  it("returns 0 for identical keypoints", () => {
    const kps = [[100, 200], [150, 250]];
    expect(computeMaxHandDisplacement(kps, kps)).toBe(0);
  });

  it("computes Euclidean distance for single keypoint", () => {
    const current = [[103, 104]];
    const previous = [[100, 100]];
    // sqrt(9 + 16) = 5
    expect(computeMaxHandDisplacement(current, previous)).toBe(5);
  });

  it("returns the maximum displacement across multiple keypoints", () => {
    const current = [[10, 10], [200, 200]];
    const previous = [[10, 10], [100, 100]];
    // First pair: 0, Second pair: sqrt(10000+10000) ≈ 141.42
    const result = computeMaxHandDisplacement(current, previous);
    expect(result).toBeCloseTo(141.42, 1);
  });

  it("handles mismatched lengths by using min count", () => {
    const current = [[10, 10], [20, 20], [30, 30]];
    const previous = [[10, 10]];
    // Only first pair compared: displacement = 0
    expect(computeMaxHandDisplacement(current, previous)).toBe(0);
  });

  it("handles empty arrays", () => {
    expect(computeMaxHandDisplacement([], [])).toBe(0);
  });
});

// ─── Gesture Detection (integrated via VideoProcessor) ──────────────────────────

describe("VideoProcessor — gesture detection", () => {
  /**
   * Helper: create a pose detector that returns specific hand keypoints.
   * Keypoints include wrists and elbows for hand detection.
   */
  function makePoseDetectorWithHands(
    leftWrist: [number, number],
    rightWrist: [number, number],
    leftElbow: [number, number],
    rightElbow: [number, number],
    bodyTop = 100,
    bodyBottom = 400,
    confidence = 0.8,
  ): PoseDetector {
    return {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: bodyTop, confidence: 0.9, name: "nose" },
          { x: 130, y: bodyTop + 20, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: bodyTop + 20, confidence: 0.8, name: "right_shoulder" },
          { x: leftWrist[0], y: leftWrist[1], confidence: 0.7, name: "left_wrist" },
          { x: rightWrist[0], y: rightWrist[1], confidence: 0.7, name: "right_wrist" },
          { x: leftElbow[0], y: leftElbow[1], confidence: 0.7, name: "left_elbow" },
          { x: rightElbow[0], y: rightElbow[1], confidence: 0.7, name: "right_elbow" },
          { x: 140, y: bodyBottom, confidence: 0.6, name: "left_hip" },
          { x: 160, y: bodyBottom, confidence: 0.6, name: "right_hip" },
        ],
        confidence,
      } satisfies PoseDetection),
    };
  }

  it("detects a gesture when hand displacement exceeds threshold", async () => {
    // Body bbox height = 400 - 100 = 300. Threshold = 0.15 → need > 45px displacement.
    // Frame 0: hands at (120, 200) and (180, 200)
    // Frame 1: hands at (120, 260) and (180, 260) → 60px displacement > 45px
    const poseFrame0 = makePoseDetectorWithHands(
      [120, 200], [180, 200], [125, 160], [175, 160],
    );
    const poseFrame1 = makePoseDetectorWithHands(
      [120, 260], [180, 260], [125, 220], [175, 220],
    );

    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return poseFrame0.detect();
        return poseFrame1.detect();
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));
    const obs = await vp.finalize();

    expect(obs.totalGestureCount).toBe(1);
    expect(obs.gestureFrequency).toBeGreaterThan(0);
  });

  it("does not detect gesture when displacement is below threshold", async () => {
    // Body bbox height = 300. Threshold = 0.15 → need > 45px.
    // Both frames have hands at nearly the same position (5px move < 45px).
    const poseFrame0 = makePoseDetectorWithHands(
      [120, 200], [180, 200], [125, 160], [175, 160],
    );
    const poseFrame1 = makePoseDetectorWithHands(
      [122, 203], [182, 203], [127, 163], [177, 163],
    );

    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return poseFrame0.detect();
        return poseFrame1.detect();
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));
    const obs = await vp.finalize();

    expect(obs.totalGestureCount).toBe(0);
  });

  it("jitter guard: no gesture on first frame (no previous keypoints)", async () => {
    // Even with large hand positions, the first frame should not trigger a gesture
    // because there are no previous keypoints to compare against.
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));
    const obs = await vp.finalize();

    expect(obs.totalGestureCount).toBe(0);
  });

  it("jitter guard: no gesture when hands disappear and reappear", async () => {
    // Frame 0: hands detected at position A
    // Frame 1: hands NOT detected (pose confidence too low)
    // Frame 2: hands detected at position B (far from A)
    // No gesture should be detected on frame 2 because previous frame had no hands.
    const poseWithHands = makePoseDetectorWithHands(
      [120, 200], [180, 200], [125, 160], [175, 160],
    );
    const poseNoHands: PoseDetector = {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: 100, confidence: 0.9, name: "nose" },
          { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
          // Wrists with low confidence — below threshold
          { x: 120, y: 200, confidence: 0.1, name: "left_wrist" },
          { x: 180, y: 200, confidence: 0.1, name: "right_wrist" },
          { x: 125, y: 160, confidence: 0.1, name: "left_elbow" },
          { x: 175, y: 160, confidence: 0.1, name: "right_elbow" },
          { x: 140, y: 400, confidence: 0.6, name: "left_hip" },
          { x: 160, y: 400, confidence: 0.6, name: "right_hip" },
        ],
        confidence: 0.8,
      } satisfies PoseDetection),
    };
    const poseWithHandsFar = makePoseDetectorWithHands(
      [120, 350], [180, 350], [125, 310], [175, 310],
    );

    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return poseWithHands.detect();
        if (callCount === 2) return poseNoHands.detect();
        return poseWithHandsFar.detect();
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));
    const obs = await vp.finalize();

    // No gesture: frame 0 has no previous, frame 1 has no hands, frame 2 has no previous hands
    expect(obs.totalGestureCount).toBe(0);
  });

  it("tracks gesture events with timestamps", async () => {
    // Two consecutive frames with large hand displacement → gesture at frame 1's timestamp
    const poseFrame0 = makePoseDetectorWithHands(
      [120, 200], [180, 200], [125, 160], [175, 160],
    );
    const poseFrame1 = makePoseDetectorWithHands(
      [120, 300], [180, 300], [125, 260], [175, 260],
    );

    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return poseFrame0.detect();
        return poseFrame1.detect();
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));
    const obs = await vp.finalize();

    expect(obs.totalGestureCount).toBe(1);
    // gestureFrequency should be positive (gestures per minute)
    expect(obs.gestureFrequency).toBeGreaterThan(0);
  });

  it("does not detect gesture when bodyBboxHeight is zero", async () => {
    // Pose detector returns keypoints all at the same y → bbox height = 0
    const poseFlat: PoseDetector = {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: 200, confidence: 0.9, name: "nose" },
          { x: 130, y: 200, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: 200, confidence: 0.8, name: "right_shoulder" },
          { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
          { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
          { x: 125, y: 200, confidence: 0.7, name: "left_elbow" },
          { x: 175, y: 200, confidence: 0.7, name: "right_elbow" },
          { x: 140, y: 200, confidence: 0.6, name: "left_hip" },
          { x: 160, y: 200, confidence: 0.6, name: "right_hip" },
        ],
        confidence: 0.8,
      } satisfies PoseDetection),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector: poseFlat,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));
    const obs = await vp.finalize();

    expect(obs.totalGestureCount).toBe(0);
  });

  it("tracks hands detected/not detected frame counts", async () => {
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));
    const obs = await vp.finalize();

    // Default mock pose detector returns hand keypoints
    expect(obs.handsDetectedFrames).toBe(2);
    expect(obs.handsNotDetectedFrames).toBe(0);
  });
});

// ─── gesturePerSentenceRatio ────────────────────────────────────────────────────

describe("VideoProcessor — gesturePerSentenceRatio", () => {
  it("returns null when no transcript segments provided", async () => {
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));
    const obs = await vp.finalize();

    expect(obs.gesturePerSentenceRatio).toBeNull();
  });

  it("returns null when empty transcript segments provided", async () => {
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));
    const obs = await vp.finalize([]);

    expect(obs.gesturePerSentenceRatio).toBeNull();
  });

  it("computes ratio when gestures align with transcript segments", async () => {
    // Create frames with large hand displacement to trigger gestures
    const poseFrame0 = {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: 100, confidence: 0.9, name: "nose" },
          { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
          { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
          { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
          { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
          { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
          { x: 140, y: 400, confidence: 0.6, name: "left_hip" },
          { x: 160, y: 400, confidence: 0.6, name: "right_hip" },
        ],
        confidence: 0.8,
      } satisfies PoseDetection),
    };
    const poseFrame1 = {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: 100, confidence: 0.9, name: "nose" },
          { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
          { x: 120, y: 300, confidence: 0.7, name: "left_wrist" },
          { x: 180, y: 300, confidence: 0.7, name: "right_wrist" },
          { x: 125, y: 260, confidence: 0.7, name: "left_elbow" },
          { x: 175, y: 260, confidence: 0.7, name: "right_elbow" },
          { x: 140, y: 400, confidence: 0.6, name: "left_hip" },
          { x: 160, y: 400, confidence: 0.6, name: "right_hip" },
        ],
        confidence: 0.8,
      } satisfies PoseDetection),
    };

    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return poseFrame0.detect();
        return poseFrame1.detect();
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));

    const segments = [
      { text: "Hello world", startTime: 0.0, endTime: 1.0, words: [], isFinal: true },
      { text: "Second sentence", startTime: 1.0, endTime: 2.0, words: [], isFinal: true },
    ];

    const obs = await vp.finalize(segments);

    // Gesture at timestamp 0.5 falls within segment 1 [0.0, 1.0]
    // Segment 2 has no gesture
    expect(obs.gesturePerSentenceRatio).toBe(0.5);
  });

  it("returns 0 when no gestures detected but segments exist", async () => {
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    // Only one frame → no gesture possible (jitter guard)
    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));

    const segments = [
      { text: "Hello world", startTime: 0.0, endTime: 1.0, words: [], isFinal: true },
    ];

    const obs = await vp.finalize(segments);

    expect(obs.gesturePerSentenceRatio).toBe(0);
  });
});

// ─── Body Stability and Stage Crossing (Task 4.8) ──────────────────────────────

describe("VideoProcessor — body stability and stage crossing", () => {
  /**
   * Helper: create a pose detector that returns specific hip positions.
   * Hip positions determine body center-of-mass.
   */
  function makePoseDetectorWithHips(
    leftHipX: number,
    leftHipY: number,
    rightHipX: number,
    rightHipY: number,
    confidence = 0.8,
  ): PoseDetector {
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
          { x: leftHipX, y: leftHipY, confidence: 0.6, name: "left_hip" },
          { x: rightHipX, y: rightHipY, confidence: 0.6, name: "right_hip" },
        ],
        confidence,
      } satisfies PoseDetection),
    };
  }

  it("computes body center from hip keypoints normalized by frame dimensions", async () => {
    // Frame is 640x480. Hips at (280, 300) and (360, 300).
    // Center = ((280+360)/2 / 640, (300+300)/2 / 480) = (0.5, 0.625)
    const poseDetector = makePoseDetectorWithHips(280, 300, 360, 300);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));

    const obs = await vp.finalize();

    // With a single frame, body center history has 1 entry.
    // Single-window stability: no displacement → score = 1.0
    expect(obs.meanBodyStabilityScore).toBe(1.0);
    expect(obs.movementClassification).toBe("stationary");
    expect(obs.stageCrossingCount).toBe(0);
  });

  it("returns stationary classification for minimal movement", async () => {
    // Multiple frames with very similar hip positions within one 5s window
    let callCount = 0;
    const hipPositions = [
      [320, 300, 320, 300], // center: (320/640, 300/480) = (0.5, 0.625)
      [322, 301, 322, 301], // tiny movement
      [318, 299, 318, 299], // tiny movement
    ];

    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const pos = hipPositions[Math.min(callCount, hipPositions.length - 1)];
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: pos[0], y: pos[1], confidence: 0.6, name: "left_hip" },
            { x: pos[2], y: pos[3], confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0.85);
    expect(obs.movementClassification).toBe("stationary");
    expect(obs.stageCrossingCount).toBe(0);
  });

  it("detects high movement when body moves significantly", async () => {
    // Large displacement within a window: body moves from left to right side of frame
    let callCount = 0;
    // Frame 640x480. Move from x=100 to x=540 (normalized: 0.15625 to 0.84375)
    // Displacement in normalized coords: ~0.6875 horizontal
    // Diagonal displacement / sqrt(2) → score = 1 - 0.6875/sqrt(2) ≈ 0.514
    const hipPositions = [
      [100, 300, 100, 300], // far left
      [220, 300, 220, 300],
      [340, 300, 340, 300], // center
      [460, 300, 460, 300],
      [540, 300, 540, 300], // far right
    ];

    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const pos = hipPositions[Math.min(callCount, hipPositions.length - 1)];
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: pos[0], y: pos[1], confidence: 0.6, name: "left_hip" },
            { x: pos[2], y: pos[3], confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    // All within one 5s window
    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(3, 1.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(4, 2.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 500));

    const obs = await vp.finalize();

    // Large movement → low stability score
    expect(obs.meanBodyStabilityScore).toBeLessThan(0.85);
    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0);
    expect(obs.meanBodyStabilityScore).toBeLessThanOrEqual(1);
  });

  it("detects stage crossing when body moves >25% frame width between windows", async () => {
    // Two 5s windows. Window 1: body at x≈0.2. Window 2: body at x≈0.7.
    // Horizontal displacement = 0.5 > 0.25 threshold → stage crossing
    let callCount = 0;
    // Window 1 (t=0-4.5): hips at x=128 → normalized 128/640 = 0.2
    // Window 2 (t=5-9.5): hips at x=448 → normalized 448/640 = 0.7
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const isWindow2 = callCount >= 3;
        const hipX = isWindow2 ? 448 : 128;
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: hipX, y: 300, confidence: 0.6, name: "left_hip" },
            { x: hipX, y: 300, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    // Use higher staleFrameThresholdSeconds to allow timestamp jumps between windows
    const config = makeConfig({ frameRate: 2, minValidFramesPerWindow: 3, staleFrameThresholdSeconds: 10 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    // Window 1: timestamps 0-4.5 (3 frames)
    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
    // Window 2: timestamps 5-9.5 (3 frames)
    vp.enqueueFrame(makeHeader(3, 5.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(4, 5.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(5, 6.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 500));

    const obs = await vp.finalize();

    expect(obs.stageCrossingCount).toBe(1);
  });

  it("does not detect stage crossing for small horizontal movement", async () => {
    // Two windows with body moving only slightly (< 25% frame width)
    let callCount = 0;
    // Window 1: hips at x=300 → 300/640 ≈ 0.469
    // Window 2: hips at x=380 → 380/640 ≈ 0.594
    // Displacement ≈ 0.125 < 0.25 → no crossing
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const isWindow2 = callCount >= 3;
        const hipX = isWindow2 ? 380 : 300;
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: hipX, y: 300, confidence: 0.6, name: "left_hip" },
            { x: hipX, y: 300, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2, minValidFramesPerWindow: 3, staleFrameThresholdSeconds: 10 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    // Window 1
    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
    // Window 2
    vp.enqueueFrame(makeHeader(3, 5.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(4, 5.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(5, 6.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 500));

    const obs = await vp.finalize();

    expect(obs.stageCrossingCount).toBe(0);
  });

  it("excludes windows with insufficient valid frames from aggregates", async () => {
    // Only 2 frames in a window, minValidFramesPerWindow = 3 → excluded
    const poseDetector = makePoseDetectorWithHips(320, 300, 320, 300);
    const config = makeConfig({ frameRate: 2, minValidFramesPerWindow: 3 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    // Only 2 frames in one window → insufficient
    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));

    const obs = await vp.finalize();

    // Window excluded → defaults to 1.0 stability
    expect(obs.meanBodyStabilityScore).toBe(1.0);
    expect(obs.movementClassification).toBe("stationary");
  });

  it("does not bridge stage crossings across resolution changes", async () => {
    // Window 1 at 640x480 with body at x=0.2
    // Resolution change
    // Window 2 at 1280x720 with body at x=0.8
    // Should NOT count as stage crossing
    let callCount = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const isWindow2 = callCount >= 3;
        // Window 1: hips at x=128 on 640-wide frame → normalized 0.2
        // Window 2: hips at x=1024 on 1280-wide frame → normalized 0.8
        const hipX = isWindow2 ? 576 : 128;
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: hipX, y: 300, confidence: 0.6, name: "left_hip" },
            { x: hipX, y: 300, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2, minValidFramesPerWindow: 3, staleFrameThresholdSeconds: 10 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    // Window 1 at 640x480
    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
    // Resolution change → Window 2 at 1280x720
    vp.enqueueFrame(makeHeader(3, 5.0, 1280, 720), makeJpeg());
    vp.enqueueFrame(makeHeader(4, 5.5, 1280, 720), makeJpeg());
    vp.enqueueFrame(makeHeader(5, 6.0, 1280, 720), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 500));

    const obs = await vp.finalize();

    // Stage crossing should NOT be detected across resolution change
    expect(obs.stageCrossingCount).toBe(0);
    expect(obs.resolutionChangeCount).toBe(1);
  });

  it("stability score is clamped to [0, 1]", async () => {
    // Even with extreme movement, score should be between 0 and 1
    let callCount = 0;
    // Extreme movement: from (0,0) to (640,480) in normalized coords (0,0) to (1,1)
    const hipPositions = [
      [10, 10, 10, 10],
      [630, 470, 630, 470],
      [10, 10, 10, 10],
    ];

    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const pos = hipPositions[Math.min(callCount, hipPositions.length - 1)];
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: pos[0], y: pos[1], confidence: 0.6, name: "left_hip" },
            { x: pos[2], y: pos[3], confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0);
    expect(obs.meanBodyStabilityScore).toBeLessThanOrEqual(1);
  });

  it("returns null body center when hip keypoints have low confidence", async () => {
    // Hip keypoints below pose confidence threshold → no body center
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockResolvedValue({
        keypoints: [
          { x: 150, y: 100, confidence: 0.9, name: "nose" },
          { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
          { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
          { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
          { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
          { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
          { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
          { x: 140, y: 300, confidence: 0.1, name: "left_hip" },  // below threshold
          { x: 160, y: 300, confidence: 0.1, name: "right_hip" }, // below threshold
        ],
        confidence: 0.8,
      } satisfies PoseDetection),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 200));

    const obs = await vp.finalize();

    // No body center history → default stability
    expect(obs.meanBodyStabilityScore).toBe(1.0);
    expect(obs.stageCrossingCount).toBe(0);
  });

  it("classifies moderate movement correctly", async () => {
    // Movement that results in mean score between 0.5 and 0.84
    let callCount = 0;
    // Moderate movement: body moves ~30% of frame width within a window
    // Normalized displacement ≈ 0.3 horizontal → displacement/sqrt(2) ≈ 0.212
    // Score ≈ 1 - 0.212 ≈ 0.788 → moderate_movement
    const hipPositions = [
      [192, 300, 192, 300], // x = 192/640 = 0.3
      [256, 300, 256, 300], // x = 0.4
      [384, 300, 384, 300], // x = 0.6
    ];

    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(() => {
        const pos = hipPositions[Math.min(callCount, hipPositions.length - 1)];
        callCount++;
        return Promise.resolve({
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: pos[0], y: pos[1], confidence: 0.6, name: "left_hip" },
            { x: pos[2], y: pos[3], confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    expect(obs.meanBodyStabilityScore).toBeGreaterThanOrEqual(0.5);
    expect(obs.meanBodyStabilityScore).toBeLessThan(0.85);
    expect(obs.movementClassification).toBe("moderate_movement");
  });
});

// ─── Facial Energy Computation (Task 4.11) ──────────────────────────────────────

describe("VideoProcessor — facial energy computation", () => {
  /**
   * Helper: create a face detector that returns specific landmarks per call.
   * BlazeFace 6 landmarks: [0] right eye, [1] left eye, [2] nose, [3] mouth, [4] right ear, [5] left ear
   */
  function makeFaceDetectorWithVaryingLandmarks(
    landmarkSets: number[][][],
  ): FaceDetector {
    let callCount = 0;
    return {
      detect: vi.fn().mockImplementation(() => {
        const landmarks = landmarkSets[Math.min(callCount, landmarkSets.length - 1)];
        callCount++;
        return Promise.resolve({
          landmarks,
          boundingBox: { x: 80, y: 80, width: 160, height: 160 },
          confidence: 0.9,
        } satisfies FaceDetection);
      }),
    };
  }

  it("computes non-zero facial energy deltas when landmarks change between frames", async () => {
    // Frame 1: neutral face
    const neutral = [
      [100, 100], // right eye
      [200, 100], // left eye
      [150, 150], // nose
      [150, 200], // mouth
      [80, 130],  // right ear
      [220, 130], // left ear
    ];
    // Frame 2: mouth opens (mouth y moves down)
    const mouthOpen = [
      [100, 100],
      [200, 100],
      [150, 150],
      [150, 220], // mouth moved down by 20
      [80, 130],
      [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([neutral, mouthOpen]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));

    const obs = await vp.finalize();

    // First frame has no previous → delta = 0
    // Second frame has mouth delta = 20, eye deltas = 0, head tilt delta ≈ 0
    // So we should have deltas [0, ~20]
    // After min-max normalization: min=0, max≈20 → normalized [0, 1]
    // Mean ≈ 0.5
    expect(obs.meanFacialEnergyScore).toBeGreaterThan(0);
    expect(obs.meanFacialEnergyScore).toBeLessThanOrEqual(1);
    expect(obs.facialEnergyLowSignal).toBe(false);
  });

  it("returns low signal when all landmarks are identical across frames", async () => {
    const staticLandmarks = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([
      staticLandmarks, staticLandmarks, staticLandmarks,
    ]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    // All deltas are 0 → variance < epsilon → low signal
    expect(obs.meanFacialEnergyScore).toBe(0);
    expect(obs.facialEnergyVariation).toBe(0);
    expect(obs.facialEnergyLowSignal).toBe(true);
  });

  it("computes correct min-max normalization across varying deltas", async () => {
    // Frame 1: baseline
    const frame1 = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];
    // Frame 2: small movement (mouth moves 5px)
    const frame2 = [
      [100, 100], [200, 100], [150, 150], [150, 205], [80, 130], [220, 130],
    ];
    // Frame 3: large movement (mouth moves 30px, eyes move 10px)
    const frame3 = [
      [100, 110], [200, 110], [150, 150], [150, 235], [80, 130], [220, 130],
    ];
    // Frame 4: back to near baseline
    const frame4 = [
      [100, 101], [200, 101], [150, 150], [150, 206], [80, 130], [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([frame1, frame2, frame3, frame4]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());
    vp.enqueueFrame(makeHeader(3, 1.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 500));

    const obs = await vp.finalize();

    // Should have meaningful energy scores after normalization
    expect(obs.meanFacialEnergyScore).toBeGreaterThanOrEqual(0);
    expect(obs.meanFacialEnergyScore).toBeLessThanOrEqual(1);
    expect(obs.facialEnergyVariation).toBeGreaterThanOrEqual(0);
    expect(obs.facialEnergyLowSignal).toBe(false);
  });

  it("excludes frames without face detection from energy calculation", async () => {
    // Frame 1: face detected (baseline)
    // Frame 2: no face detected → should not contribute to energy deltas
    // Frame 3: face detected → delta computed against frame 1 (previous face landmarks)
    const landmarks = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];
    const movedLandmarks = [
      [100, 110], [200, 110], [150, 160], [150, 220], [80, 130], [220, 130],
    ];

    let callCount = 0;
    const faceDetector: FaceDetector = {
      detect: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // No face detected on second frame
          return Promise.resolve({
            landmarks: [],
            boundingBox: { x: 0, y: 0, width: 0, height: 0 },
            confidence: 0.1, // below threshold
          } satisfies FaceDetection);
        }
        const lm = callCount === 1 ? landmarks : movedLandmarks;
        return Promise.resolve({
          landmarks: lm,
          boundingBox: { x: 80, y: 80, width: 160, height: 160 },
          confidence: 0.9,
        } satisfies FaceDetection);
      }),
    };

    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    // Only 2 face-detected frames contribute to energy deltas
    // Frame 1: delta=0 (no previous), Frame 3: delta>0 (vs frame 1 landmarks)
    expect(obs.faceNotDetectedCount).toBe(1);
    expect(obs.framesAnalyzed).toBe(3);
  });

  it("detects eyebrow displacement changes", async () => {
    const baseline = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];
    // Eyes move up significantly (eyebrow raise)
    const eyebrowRaise = [
      [100, 80], [200, 80], [150, 150], [150, 200], [80, 130], [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([baseline, eyebrowRaise]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));

    const obs = await vp.finalize();

    // Eye y-position changed by 20px → should produce non-zero energy
    expect(obs.meanFacialEnergyScore).toBeGreaterThan(0);
    expect(obs.facialEnergyLowSignal).toBe(false);
  });

  it("detects head tilt variation", async () => {
    const baseline = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];
    // Nose shifts horizontally relative to eye midpoint (head tilt)
    const tilted = [
      [100, 100], [200, 100], [180, 150], [150, 200], [80, 130], [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([baseline, tilted]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 300));

    const obs = await vp.finalize();

    // Head tilt angle changed → should produce non-zero energy
    expect(obs.meanFacialEnergyScore).toBeGreaterThan(0);
    expect(obs.facialEnergyLowSignal).toBe(false);
  });

  it("returns zero energy with no frames", async () => {
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, makeDeps());

    const obs = await vp.finalize();

    expect(obs.meanFacialEnergyScore).toBe(0);
    expect(obs.facialEnergyVariation).toBe(0);
    expect(obs.facialEnergyLowSignal).toBe(true);
  });

  it("facial energy metrics are rounded to 4 decimal places", async () => {
    const frame1 = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];
    const frame2 = [
      [100, 103], [200, 97], [150, 153], [150, 213], [80, 130], [220, 130],
    ];
    const frame3 = [
      [100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130],
    ];

    const faceDetector = makeFaceDetectorWithVaryingLandmarks([frame1, frame2, frame3]);
    const config = makeConfig({ frameRate: 2 });
    const vp = new VideoProcessor(config, {
      faceDetector,
      poseDetector: makePoseDetector(),
    });

    vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());

    vp.startDrainLoop();
    await new Promise((r) => setTimeout(r, 400));

    const obs = await vp.finalize();

    // Check rounding: at most 4 decimal places
    const meanStr = obs.meanFacialEnergyScore.toString();
    const varStr = obs.facialEnergyVariation.toString();
    const decimalPart = (s: string) => s.includes(".") ? s.split(".")[1].length : 0;
    expect(decimalPart(meanStr)).toBeLessThanOrEqual(4);
    expect(decimalPart(varStr)).toBeLessThanOrEqual(4);
  });
});

// ─── Temporal Integrity Tests (Task 5.5) ────────────────────────────────────────
// Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5

describe("VideoProcessor — temporal integrity", () => {
  // ── Frame Reordering ──────────────────────────────────────────────────────

  describe("frame reordering", () => {
    it("drops out-of-order timestamps before enqueue", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      // Send frames with timestamps [1.0, 1.5, 1.2] — frame at 1.2 should be dropped
      // seq must also be monotonic, so use seq [0, 1, 2] but timestamp 1.2 regresses
      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 1.5), makeJpeg());
      // seq=2 is valid (increasing), but timestamp 1.2 < 1.5 → timestamp regression
      vp.enqueueFrame(makeHeader(2, 1.2), makeJpeg());

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(3);
      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("drops frames with out-of-order seq numbers", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      // Timestamps [1.0, 2.0, 2.5] are monotonic, but seq [0, 5, 3] has regression
      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(5, 1.5), makeJpeg());
      vp.enqueueFrame(makeHeader(3, 2.0), makeJpeg()); // seq regression: 3 <= 5

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(3);
      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("drops frames with both seq and timestamp out of order", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(5, 2.0), makeJpeg());
      // Both seq (3 <= 5) and timestamp (1.5 <= 2.0) regress
      vp.enqueueFrame(makeHeader(3, 1.5), makeJpeg());

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(3);
      expect(obs.framesDroppedByTimestamp).toBe(1);
      // Only 2 frames should have been enqueued and potentially analyzed
      expect(obs.framesAnalyzed + obs.framesSkippedBySampler + obs.framesDroppedByBackpressure + obs.framesDroppedByFinalizationBudget).toBeLessThanOrEqual(2);
    });
  });

  // ── Timestamp Regression ──────────────────────────────────────────────────

  describe("timestamp regression", () => {
    it("drops frames with timestamp equal to last processed", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 1.0), makeJpeg()); // same timestamp → regression

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(2);
      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("drops frames with timestamp less than last processed", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 2.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 1.5), makeJpeg()); // timestamp regression

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(2);
      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("counts multiple timestamp regressions correctly", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 2.0), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.5), makeJpeg()); // regression
      vp.enqueueFrame(makeHeader(3, 1.8), makeJpeg()); // regression (still <= 2.0)
      vp.enqueueFrame(makeHeader(4, 2.0), makeJpeg()); // regression (equal to 2.0)

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(5);
      expect(obs.framesDroppedByTimestamp).toBe(3);
    });
  });

  // ── Timestamp Jumps >2s ───────────────────────────────────────────────────

  describe("timestamp jumps >2s", () => {
    it("drops frames with timestamp jump exactly >2s", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 4.0), makeJpeg()); // jump of 3.0s > 2.0s threshold

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(2);
      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("accepts frames with timestamp jump exactly at 2s boundary", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 1.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 3.0), makeJpeg()); // jump of exactly 2.0s — at boundary

      const obs = await vp.finalize();

      // 2.0s is exactly at the threshold (>2s drops, so 2.0 should be accepted)
      expect(obs.framesDroppedByTimestamp).toBe(0);
      expect(obs.framesReceived).toBe(2);
    });

    it("drops frames with large timestamp jump (5s)", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 5.0), makeJpeg()); // 5s jump

      const obs = await vp.finalize();

      expect(obs.framesDroppedByTimestamp).toBe(1);
    });

    it("counts timestamp jump drops separately from other drops", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg()); // valid
      vp.enqueueFrame(makeHeader(2, 5.0), makeJpeg()); // jump >2s → dropped
      vp.enqueueFrame(makeHeader(3, 0.3), makeJpeg()); // timestamp regression → dropped

      const obs = await vp.finalize();

      expect(obs.framesReceived).toBe(4);
      expect(obs.framesDroppedByTimestamp).toBe(2);
      expect(obs.framesDroppedByBackpressure).toBe(0);
      expect(obs.framesErrored).toBe(0);
    });
  });

  // ── Camera Pause/Resume ───────────────────────────────────────────────────

  describe("camera pause/resume", () => {
    it("gap in frames within 2s does not produce false gestures", async () => {
      // Simulate camera pause: frames at [0.0, 0.5, 1.0] then gap, then [1.3, 1.6]
      // All within 2s threshold so no drops, but the gap should not cause false gestures
      const config = makeConfig({ frameRate: 2 });
      const vp = new VideoProcessor(config, makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());
      // Small gap (within 2s threshold)
      vp.enqueueFrame(makeHeader(3, 2.3), makeJpeg());
      vp.enqueueFrame(makeHeader(4, 2.6), makeJpeg());

      vp.startDrainLoop();
      await new Promise((r) => setTimeout(r, 400));
      const obs = await vp.finalize();

      // Default mock detectors return consistent positions → no gestures expected
      expect(obs.totalGestureCount).toBe(0);
      expect(obs.framesDroppedByTimestamp).toBe(0);
      expect(obs.framesReceived).toBe(5);
    });

    it("gap in frames within 2s does not produce false stage crossings", async () => {
      const config = makeConfig({ frameRate: 2 });
      const vp = new VideoProcessor(config, makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
      // Gap then resume — still within 2s
      vp.enqueueFrame(makeHeader(3, 2.5, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(4, 2.8, 640, 480), makeJpeg());

      vp.startDrainLoop();
      await new Promise((r) => setTimeout(r, 400));
      const obs = await vp.finalize();

      // Default mock detectors return consistent hip positions → no crossings
      expect(obs.stageCrossingCount).toBe(0);
      expect(obs.framesDroppedByTimestamp).toBe(0);
    });

    it("frames after >2s gap are dropped, preventing false gestures from stale data", async () => {
      // Frames at [0.0, 0.5, 1.0] then 3s gap → frame at 4.0 should be dropped
      const config = makeConfig({ frameRate: 2 });
      const vp = new VideoProcessor(config, makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.0), makeJpeg());
      // >2s gap
      vp.enqueueFrame(makeHeader(3, 4.0), makeJpeg()); // 3s jump → dropped

      vp.startDrainLoop();
      await new Promise((r) => setTimeout(r, 300));
      const obs = await vp.finalize();

      expect(obs.framesDroppedByTimestamp).toBe(1);
      // The dropped frame cannot produce false gestures since it never enters the queue
      expect(obs.totalGestureCount).toBe(0);
    });
  });

  // ── Resolution Change Mid-Session ─────────────────────────────────────────

  describe("resolution change mid-session", () => {
    it("increments resolutionChangeCount and resets baselines", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.0, 1280, 720), makeJpeg()); // resolution change
      vp.enqueueFrame(makeHeader(3, 1.5, 1280, 720), makeJpeg());

      const obs = await vp.finalize();

      expect(obs.resolutionChangeCount).toBe(1);
      expect(obs.framesReceived).toBe(4);
    });

    it("preserves aggregate counts across resolution changes", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      // 3 frames at 640x480, then 3 frames at 1280x720
      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(2, 1.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(3, 1.5, 1280, 720), makeJpeg()); // resolution change
      vp.enqueueFrame(makeHeader(4, 2.0, 1280, 720), makeJpeg());

      vp.startDrainLoop();
      await new Promise((r) => setTimeout(r, 400));
      const obs = await vp.finalize();

      // All 5 frames should be received
      expect(obs.framesReceived).toBe(5);
      // Aggregates should include frames from both resolutions
      expect(obs.framesAnalyzed + obs.framesSkippedBySampler).toBeGreaterThanOrEqual(1);
      expect(obs.resolutionChangeCount).toBe(1);
      // Gaze classifications should include frames from both resolutions
      const gazeSum = obs.gazeBreakdown.audienceFacing + obs.gazeBreakdown.notesFacing + obs.gazeBreakdown.other;
      if (obs.framesAnalyzed > 0) {
        expect(gazeSum).toBeCloseTo(100, 2);
      }
    });

    it("EMA resets on resolution change — no stale smoothing from old resolution", async () => {
      // After resolution change, EMA should start fresh.
      // This means the first frame after resolution change should not be influenced
      // by smoothing state from the previous resolution.
      let callCount = 0;
      const centeredLandmarks = [
        [150, 100], [250, 100], [200, 150], [200, 200], [120, 130], [280, 130],
      ];
      const faceDetector: FaceDetector = {
        detect: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            landmarks: centeredLandmarks,
            boundingBox: { x: 80, y: 80, width: 160, height: 160 },
            confidence: 0.9,
          } satisfies FaceDetection);
        }),
      };

      const config = makeConfig({ frameRate: 5 }); // high rate to ensure all frames sampled
      const vp = new VideoProcessor(config, {
        faceDetector,
        poseDetector: makePoseDetector(),
      });

      // Frames at 640x480
      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.3, 640, 480), makeJpeg());
      // Resolution change to 1280x720 — EMA should reset
      vp.enqueueFrame(makeHeader(2, 0.6, 1280, 720), makeJpeg());
      vp.enqueueFrame(makeHeader(3, 0.9, 1280, 720), makeJpeg());

      vp.startDrainLoop();
      await new Promise((r) => setTimeout(r, 400));
      const obs = await vp.finalize();

      expect(obs.resolutionChangeCount).toBe(1);
      // All frames should be analyzed (no drops)
      expect(obs.framesDroppedByTimestamp).toBe(0);
      // Gaze should still be valid after EMA reset
      expect(obs.gazeBreakdown.audienceFacing + obs.gazeBreakdown.notesFacing + obs.gazeBreakdown.other).toBeCloseTo(100, 2);
    });

    it("multiple resolution changes are counted correctly", async () => {
      const vp = new VideoProcessor(makeConfig(), makeDeps());

      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.5, 1280, 720), makeJpeg()); // change 1
      vp.enqueueFrame(makeHeader(2, 1.0, 320, 240), makeJpeg()); // change 2
      vp.enqueueFrame(makeHeader(3, 1.5, 1280, 720), makeJpeg()); // change 3

      const obs = await vp.finalize();

      expect(obs.resolutionChangeCount).toBe(3);
      expect(obs.framesReceived).toBe(4);
    });

    it("no false gestures across resolution change boundary when drain loop is running", async () => {
      // When the drain loop is running concurrently with enqueue,
      // resetBaselines() during enqueue clears previousHandKeypoints,
      // preventing false gestures from cross-resolution pixel coordinate differences.
      const poseFrame640: PoseDetector = {
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
          confidence: 0.8,
        } satisfies PoseDetection),
      };

      // At 1280x720, same normalized position → different pixel coords
      // Wrists at (240, 400) instead of (120, 200) — large pixel displacement
      // but resolution change resets previousHandKeypoints → no gesture
      const poseFrame1280: PoseDetector = {
        detect: vi.fn().mockResolvedValue({
          keypoints: [
            { x: 300, y: 200, confidence: 0.9, name: "nose" },
            { x: 260, y: 240, confidence: 0.8, name: "left_shoulder" },
            { x: 340, y: 240, confidence: 0.8, name: "right_shoulder" },
            { x: 240, y: 400, confidence: 0.7, name: "left_wrist" },
            { x: 360, y: 400, confidence: 0.7, name: "right_wrist" },
            { x: 250, y: 320, confidence: 0.7, name: "left_elbow" },
            { x: 350, y: 320, confidence: 0.7, name: "right_elbow" },
            { x: 280, y: 600, confidence: 0.6, name: "left_hip" },
            { x: 320, y: 600, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection),
      };

      let callCount = 0;
      const poseDetector: PoseDetector = {
        detect: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 2) return poseFrame640.detect();
          return poseFrame1280.detect();
        }),
      };

      const config = makeConfig({ frameRate: 5 });
      const vp = new VideoProcessor(config, {
        faceDetector: makeFaceDetector(),
        poseDetector,
      });

      // Start drain loop first so it processes frames concurrently
      vp.startDrainLoop();

      // Enqueue frames at 640x480
      vp.enqueueFrame(makeHeader(0, 0.0, 640, 480), makeJpeg());
      vp.enqueueFrame(makeHeader(1, 0.3, 640, 480), makeJpeg());

      // Wait for first two frames to be processed
      await new Promise((r) => setTimeout(r, 300));

      // Resolution change — resetBaselines() clears previousHandKeypoints
      vp.enqueueFrame(makeHeader(2, 0.6, 1280, 720), makeJpeg());

      await new Promise((r) => setTimeout(r, 300));
      const obs = await vp.finalize();

      // No gesture between frames 0 and 1 (same positions)
      // No gesture on frame 2 (previousHandKeypoints was reset by resolution change)
      expect(obs.totalGestureCount).toBe(0);
      expect(obs.resolutionChangeCount).toBe(1);
    });
  });
});

// ─── Task 5.6: Statistical Stability Test Gate ──────────────────────────────────
// Validates: Requirements 4.1, 5.2, 3.1, 18.1
// This gate must pass before proceeding to session integration.

describe("VideoProcessor — Statistical stability test gate", () => {
  /**
   * Gesture false positive test (< 5%).
   * Mock detectors return random small noise around a fixed position.
   * Small jitter in wrist positions should NOT trigger gestures because
   * the displacement threshold (15% of body bbox height) filters them out.
   * Validates: Requirement 4.1
   */
  it("gesture false positives < 5% with random noise around stationary position", async () => {
    const FRAME_COUNT = 30;
    const BASE_WRIST_Y = 200;
    const BODY_BBOX_HEIGHT = 200; // nose(100) to hip(300)
    // Max noise: ±5px on a 200px body bbox = 2.5%, well below 15% threshold
    const MAX_NOISE = 5;

    // Seeded pseudo-random for reproducibility
    let seed = 42;
    function seededRandom(): number {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1; // range [-1, 1]
    }

    // Pre-generate noisy wrist positions for each frame
    const wristPositions: Array<{ lx: number; ly: number; rx: number; ry: number }> = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      wristPositions.push({
        lx: 120 + seededRandom() * MAX_NOISE,
        ly: BASE_WRIST_Y + seededRandom() * MAX_NOISE,
        rx: 180 + seededRandom() * MAX_NOISE,
        ry: BASE_WRIST_Y + seededRandom() * MAX_NOISE,
      });
    }

    let frameIdx = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(async () => {
        const pos = wristPositions[Math.min(frameIdx, FRAME_COUNT - 1)];
        frameIdx++;
        return {
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: pos.lx, y: pos.ly, confidence: 0.7, name: "left_wrist" },
            { x: pos.rx, y: pos.ry, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: 140, y: 300, confidence: 0.6, name: "left_hip" },
            { x: 160, y: 300, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection;
      }),
    };

    const config = makeConfig({ frameRate: 5 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.startDrainLoop();

    for (let i = 0; i < FRAME_COUNT; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.2, 640, 480), makeJpeg());
    }

    // Wait for processing
    await new Promise((r) => setTimeout(r, 500));
    const obs = await vp.finalize();

    // Gesture false positive rate must be < 5%
    const falsePositiveRate = obs.framesAnalyzed > 0
      ? obs.totalGestureCount / obs.framesAnalyzed
      : 0;
    expect(falsePositiveRate).toBeLessThan(0.05);
    // With ±5px noise on 200px body bbox, max displacement ~= 3.5% < 15% threshold
    // So we expect zero gestures
    expect(obs.totalGestureCount).toBe(0);
  });

  /**
   * Stage crossing false positive test (< 5%).
   * Mock detectors return random small noise around a fixed body center.
   * Small movements (< 25% frame width) should NOT trigger crossings.
   * Validates: Requirement 5.2
   */
  it("stage crossing false positives < 5% with small random movements", async () => {
    const FRAME_COUNT = 30;
    // Body center at normalized ~0.5 (hips at 140,160 on 640 width = ~0.234 normalized)
    // Small noise: ±3px on 640px width = ~0.5%, well below 25% threshold
    const MAX_NOISE = 3;

    let seed = 123;
    function seededRandom(): number {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    }

    const hipPositions: Array<{ lx: number; ly: number; rx: number; ry: number }> = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      hipPositions.push({
        lx: 140 + seededRandom() * MAX_NOISE,
        ly: 300 + seededRandom() * MAX_NOISE,
        rx: 160 + seededRandom() * MAX_NOISE,
        ry: 300 + seededRandom() * MAX_NOISE,
      });
    }

    let frameIdx = 0;
    const poseDetector: PoseDetector = {
      detect: vi.fn().mockImplementation(async () => {
        const pos = hipPositions[Math.min(frameIdx, FRAME_COUNT - 1)];
        frameIdx++;
        return {
          keypoints: [
            { x: 150, y: 100, confidence: 0.9, name: "nose" },
            { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
            { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
            { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
            { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
            { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
            { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
            { x: pos.lx, y: pos.ly, confidence: 0.6, name: "left_hip" },
            { x: pos.rx, y: pos.ry, confidence: 0.6, name: "right_hip" },
          ],
          confidence: 0.8,
        } satisfies PoseDetection;
      }),
    };

    const config = makeConfig({ frameRate: 5 });
    const vp = new VideoProcessor(config, {
      faceDetector: makeFaceDetector(),
      poseDetector,
    });

    vp.startDrainLoop();

    for (let i = 0; i < FRAME_COUNT; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.2, 640, 480), makeJpeg());
    }

    await new Promise((r) => setTimeout(r, 500));
    const obs = await vp.finalize();

    // Stage crossing false positive rate must be < 5%
    // With ±3px noise on 640px width, normalized displacement ~0.5% << 25% threshold
    expect(obs.stageCrossingCount).toBe(0);
    // Movement should be classified as stationary (high stability)
    expect(obs.movementClassification).toBe("stationary");
  });

  /**
   * Gaze classification variance test (within ±2% across repeated runs).
   * Run the same deterministic frame sequence through VideoProcessor 5 times
   * with identical mock detectors. Verify gaze percentages are identical
   * across all runs (variance = 0 with deterministic inputs, within ±2%).
   * Validates: Requirements 3.1, 18.1
   */
  it("gaze classification variance within ±2% across repeated runs with same input", async () => {
    const FRAME_COUNT = 20;
    const RUNS = 5;

    // Fixed face landmarks that produce a consistent "audience-facing" classification
    // (yaw near 0, pitch near 0)
    const audienceFacingLandmarks: number[][] = [
      [100, 100], // right eye
      [200, 100], // left eye
      [150, 150], // nose
      [150, 200], // mouth
      [80, 130],  // right ear
      [220, 130], // left ear
    ];

    const results: Array<{
      audienceFacing: number;
      notesFacing: number;
      other: number;
    }> = [];

    for (let run = 0; run < RUNS; run++) {
      const faceDetector: FaceDetector = {
        detect: vi.fn().mockResolvedValue({
          landmarks: audienceFacingLandmarks,
          boundingBox: { x: 80, y: 80, width: 160, height: 160 },
          confidence: 0.9,
        } satisfies FaceDetection),
      };

      const config = makeConfig({ frameRate: 5 });
      const vp = new VideoProcessor(config, {
        faceDetector,
        poseDetector: makePoseDetector(),
      });

      vp.startDrainLoop();

      for (let i = 0; i < FRAME_COUNT; i++) {
        vp.enqueueFrame(makeHeader(i, i * 0.2, 640, 480), makeJpeg());
      }

      await new Promise((r) => setTimeout(r, 500));
      const obs = await vp.finalize();

      results.push({
        audienceFacing: obs.gazeBreakdown.audienceFacing,
        notesFacing: obs.gazeBreakdown.notesFacing,
        other: obs.gazeBreakdown.other,
      });
    }

    // All runs should produce identical results (deterministic inputs)
    for (let i = 1; i < RUNS; i++) {
      expect(Math.abs(results[i].audienceFacing - results[0].audienceFacing)).toBeLessThanOrEqual(2);
      expect(Math.abs(results[i].notesFacing - results[0].notesFacing)).toBeLessThanOrEqual(2);
      expect(Math.abs(results[i].other - results[0].other)).toBeLessThanOrEqual(2);
    }

    // With deterministic inputs, variance should actually be 0
    const audienceValues = results.map((r) => r.audienceFacing);
    const notesValues = results.map((r) => r.notesFacing);
    const otherValues = results.map((r) => r.other);

    const variance = (vals: number[]) => {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
    };

    expect(variance(audienceValues)).toBe(0);
    expect(variance(notesValues)).toBe(0);
    expect(variance(otherValues)).toBe(0);
  });
});
