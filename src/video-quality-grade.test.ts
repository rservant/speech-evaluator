/**
 * Unit tests for computeVideoQualityGrade without face detector (task 10)
 * Tests the pose-only mode grade computation through the public finalize() API.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 3.1, 3.3, 8.3, 8.4, 8.5
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type PoseDetector,
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

/** Create pose-only deps (no face detector). */
function makePoseOnlyDeps(): VideoProcessorDeps {
  return { poseDetector: makePoseDetector() };
}

/**
 * Helper: create a VideoProcessor in pose-only mode and set internal state
 * to achieve a specific analysisRate when finalize() is called.
 *
 * analysisRate = min(1, framesAnalyzed / (lastReceivedTimestamp * effectiveRate))
 *
 * We enqueue frames to build up framesAnalyzed and lastReceivedTimestamp,
 * then manipulate lastReceivedTimestamp directly to achieve the exact desired ratio.
 */
async function createProcessorWithAnalysisRate(
  targetRate: number,
  opts?: {
    cameraDrop?: boolean;
    configOverrides?: Partial<VideoConfig>;
  },
): Promise<VideoProcessor> {
  const config = makeConfig({
    // Use staleFrameThresholdSeconds large enough to allow timestamp gaps
    staleFrameThresholdSeconds: 100,
    ...opts?.configOverrides,
  });
  const vp = new VideoProcessor(config, makePoseOnlyDeps());

  // Enqueue 10 frames at 0.5s intervals (all will be sampled with frameRate=2)
  // This gives framesAnalyzed = 10
  const frameCount = 10;
  for (let i = 1; i <= frameCount; i++) {
    vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
  }

  // Now adjust lastReceivedTimestamp to achieve the desired analysisRate.
  // analysisRate = min(1, framesAnalyzed / (lastReceivedTimestamp * frameRate))
  // We want: targetRate = framesAnalyzed / (lastReceivedTimestamp * frameRate)
  // So: lastReceivedTimestamp = framesAnalyzed / (targetRate * frameRate)
  //
  // For targetRate >= 1.0, the clamping means any lastReceivedTimestamp that gives
  // raw rate >= 1.0 works. We keep the natural value.
  if (targetRate < 1.0) {
    const effectiveRate = config.frameRate; // normal mode
    const desiredTimestamp = frameCount / (targetRate * effectiveRate);
    // Set lastReceivedTimestamp to the desired value
    (vp as any).lastReceivedTimestamp = desiredTimestamp;
  }

  // For camera drop: set lastFrameWallTime far in the past
  if (opts?.cameraDrop) {
    (vp as any).lastFrameWallTime =
      Date.now() - (config.cameraDropTimeoutSeconds * 1000 + 1000);
  }

  return vp;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("computeVideoQualityGrade without face detector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 10.1: analysisRate >= 0.8 and no camera drop → "good" (Req 1.2)
  it("returns 'good' when analysisRate >= 0.8 and no camera drop", async () => {
    // analysisRate = 1.0 (10 frames analyzed, expectedSampleCount = 10)
    const vp = await createProcessorWithAnalysisRate(1.0);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("good");
    expect(obs.capabilities.face).toBe(false);
    expect(obs.capabilities.pose).toBe(true);
  });

  it("returns 'good' when analysisRate is exactly 0.8 and no camera drop", async () => {
    const vp = await createProcessorWithAnalysisRate(0.8);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("good");
  });

  // 10.2: 0.5 <= analysisRate < 0.8 → "degraded" (Req 1.3)
  it("returns 'degraded' when analysisRate is between 0.5 and 0.8", async () => {
    const vp = await createProcessorWithAnalysisRate(0.6);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  it("returns 'degraded' when analysisRate is exactly 0.5", async () => {
    const vp = await createProcessorWithAnalysisRate(0.5);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  it("returns 'degraded' when analysisRate is 0.79", async () => {
    const vp = await createProcessorWithAnalysisRate(0.79);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  // 10.3: analysisRate < 0.5 → "poor" (Req 1.4)
  it("returns 'poor' when analysisRate is below 0.5", async () => {
    const vp = await createProcessorWithAnalysisRate(0.3);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  it("returns 'poor' when analysisRate is 0.49", async () => {
    const vp = await createProcessorWithAnalysisRate(0.49);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  // 10.4: camera drop caps "good" to "degraded" (Req 3.1)
  it("caps grade to 'degraded' when camera drop is detected and analysisRate >= 0.8", async () => {
    const vp = await createProcessorWithAnalysisRate(1.0, { cameraDrop: true });
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  it("camera drop does not change 'degraded' grade from analysisRate", async () => {
    const vp = await createProcessorWithAnalysisRate(0.6, { cameraDrop: true });
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  // 10.5: camera drop does not change "poor" grade (Req 3.3)
  it("camera drop does not change 'poor' grade", async () => {
    const vp = await createProcessorWithAnalysisRate(0.3, { cameraDrop: true });
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  // 10.6: expectedSampleCount <= 0 returns "poor" (Req 8.4)
  it("returns 'poor' when expectedSampleCount <= 0 (no frames received)", async () => {
    const config = makeConfig();
    const vp = new VideoProcessor(config, makePoseOnlyDeps());
    // No frames enqueued → lastReceivedTimestamp = 0 → expectedSampleCount = 0
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  it("returns 'poor' when expectedSampleCount is 0 due to zero frameRate", async () => {
    // Edge case: frameRate = 0 would make expectedSampleCount = 0
    // But frameRate=0 would cause FrameSampler division by zero, so we test
    // by directly setting lastReceivedTimestamp to 0 after enqueuing frames
    const config = makeConfig();
    const vp = new VideoProcessor(config, makePoseOnlyDeps());
    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    // Force lastReceivedTimestamp to 0 so expectedSampleCount = 0
    (vp as any).lastReceivedTimestamp = 0;
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  // 10.7: analysisRate > 1.0 is clamped to 1.0 (Req 8.3)
  it("clamps analysisRate > 1.0 to 1.0 and returns 'good' when no camera drop", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const vp = new VideoProcessor(config, makePoseOnlyDeps());

    // Enqueue 10 frames at 0.5s intervals
    for (let i = 1; i <= 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    // Set lastReceivedTimestamp very low so framesAnalyzed / expectedSampleCount > 1.0
    // framesAnalyzed will be 10, expectedSampleCount = 1.0 * 2 = 2
    // raw analysisRate = 10 / 2 = 5.0, clamped to 1.0
    (vp as any).lastReceivedTimestamp = 1.0;

    const obs = await vp.finalize();
    // Clamped to 1.0 → "good" (>= 0.8 threshold)
    expect(obs.videoQualityGrade).toBe("good");
  });

  // 10.8: camera warmup delay does not inflate expectedSampleCount (Req 8.5)
  it("camera warmup delay does not inflate expectedSampleCount or force poor grade", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const vp = new VideoProcessor(config, makePoseOnlyDeps());

    // Simulate a 10-second wall-clock warmup delay by advancing recordingStartTime
    // far into the past. This would inflate expectedSampleCount if wall-clock were used.
    const now = Date.now();
    (vp as any).recordingStartTime = now - 10000; // 10s ago

    // Send 10 frames at 0.5s intervals starting at video-time 0.5
    // Video duration = lastReceivedTimestamp = 5.0
    // expectedSampleCount = 5.0 * 2 = 10 (using video-time, not wall-clock)
    // framesAnalyzed = 10
    // analysisRate = 10/10 = 1.0 → "good"
    //
    // If wall-clock were used: duration ≈ 10s, expectedSampleCount ≈ 20,
    // analysisRate ≈ 10/20 = 0.5 → "degraded" or worse
    for (let i = 1; i <= 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("good");
    // Verify video-time was used (not wall-clock)
    // If wall-clock were used, the grade would be "degraded" or "poor"
    expect(obs.videoQualityWarning).toBe(false);
  });
});

// ─── With Face Detector (Regression) ────────────────────────────────────────────

import type { FaceDetector, FaceDetection } from "./video-processor.js";

/**
 * Create a mock FaceDetector that returns a valid face detection for the first
 * `detectedCount` calls, then returns null for subsequent calls.
 * This lets us control faceDetectionRate precisely.
 */
function makeFaceDetector(detectedCount: number): FaceDetector {
  let callCount = 0;
  return {
    detect: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= detectedCount) {
        return {
          landmarks: [
            [150, 100],
            [130, 110],
            [170, 110],
            [140, 130],
            [135, 140],
            [165, 140],
          ],
          boundingBox: { x: 100, y: 80, width: 100, height: 100 },
          confidence: 0.9,
        } satisfies FaceDetection;
      }
      return null;
    }),
  };
}

/** Create deps with both face and pose detectors. */
function makeDualDeps(faceDetectedCount: number): VideoProcessorDeps {
  return {
    faceDetector: makeFaceDetector(faceDetectedCount),
    poseDetector: makePoseDetector(),
  };
}

/**
 * Helper: create a VideoProcessor with both face and pose detectors,
 * controlling analysisRate and faceDetectionRate.
 *
 * faceDetectionRate = (framesAnalyzed - faceNotDetectedCount) / framesAnalyzed
 *
 * We enqueue `frameCount` frames. The face detector returns a valid detection
 * for the first `faceDetectedCount` frames, then null for the rest.
 * So faceNotDetectedCount = frameCount - faceDetectedCount (for sampled frames).
 * faceDetectionRate = faceDetectedCount / frameCount.
 *
 * analysisRate is controlled by adjusting lastReceivedTimestamp after enqueuing.
 */
async function createDualProcessorWithRates(
  targetAnalysisRate: number,
  faceDetectionRatio: number,
  opts?: {
    cameraDrop?: boolean;
    configOverrides?: Partial<VideoConfig>;
  },
): Promise<VideoProcessor> {
  const frameCount = 10;
  const faceDetectedCount = Math.round(faceDetectionRatio * frameCount);

  const config = makeConfig({
    staleFrameThresholdSeconds: 100,
    ...opts?.configOverrides,
  });
  const vp = new VideoProcessor(config, makeDualDeps(faceDetectedCount));

  // Enqueue frames at 0.5s intervals (finalize() will drain and process them)
  for (let i = 1; i <= frameCount; i++) {
    vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
  }

  // Adjust lastReceivedTimestamp to achieve the desired analysisRate
  // analysisRate = min(1, framesAnalyzed / (lastReceivedTimestamp * frameRate))
  if (targetAnalysisRate < 1.0) {
    const effectiveRate = config.frameRate;
    const desiredTimestamp = frameCount / (targetAnalysisRate * effectiveRate);
    (vp as any).lastReceivedTimestamp = desiredTimestamp;
  }

  // For camera drop: set lastFrameWallTime far in the past
  if (opts?.cameraDrop) {
    (vp as any).lastFrameWallTime =
      Date.now() - (config.cameraDropTimeoutSeconds * 1000 + 1000);
  }

  return vp;
}

describe("computeVideoQualityGrade with face detector (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 11.1: analysisRate >= 0.8 AND faceDetectionRate >= 0.6 AND no camera drop → "good" (Req 2.1)
  it("returns 'good' when analysisRate >= 0.8, faceDetectionRate >= 0.6, and no camera drop", async () => {
    // analysisRate = 1.0, faceDetectionRate = 0.8 (8 of 10 frames detected)
    const vp = await createDualProcessorWithRates(1.0, 0.8);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("good");
    expect(obs.capabilities.face).toBe(true);
    expect(obs.capabilities.pose).toBe(true);
  });

  it("returns 'good' at boundary: analysisRate = 0.8, faceDetectionRate = 0.6", async () => {
    // analysisRate = 0.8, faceDetectionRate = 0.6 (6 of 10 frames detected)
    const vp = await createDualProcessorWithRates(0.8, 0.6);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("good");
  });

  // 11.2: analysisRate < 0.5 OR faceDetectionRate < 0.3 → "poor" (Req 2.2)
  it("returns 'poor' when analysisRate < 0.5 (even with high faceDetectionRate)", async () => {
    // analysisRate = 0.3, faceDetectionRate = 1.0 (all faces detected)
    const vp = await createDualProcessorWithRates(0.3, 1.0);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  it("returns 'poor' when faceDetectionRate < 0.3 (even with high analysisRate)", async () => {
    // analysisRate = 1.0, faceDetectionRate = 0.2 (2 of 10 frames detected)
    const vp = await createDualProcessorWithRates(1.0, 0.2);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  it("returns 'poor' when both analysisRate < 0.5 and faceDetectionRate < 0.3", async () => {
    // analysisRate = 0.3, faceDetectionRate = 0.1 (1 of 10 frames detected)
    const vp = await createDualProcessorWithRates(0.3, 0.1);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  it("returns 'poor' at boundary: faceDetectionRate = 0.2 (below 0.3 threshold)", async () => {
    // analysisRate = 1.0, faceDetectionRate = 0.2
    const vp = await createDualProcessorWithRates(1.0, 0.2);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("poor");
  });

  // 11.3: otherwise → "degraded" (Req 2.3)
  it("returns 'degraded' when analysisRate is between 0.5 and 0.8 with adequate faceDetectionRate", async () => {
    // analysisRate = 0.6, faceDetectionRate = 0.8 — not good (analysisRate < 0.8), not poor
    const vp = await createDualProcessorWithRates(0.6, 0.8);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  it("returns 'degraded' when faceDetectionRate is between 0.3 and 0.6 with high analysisRate", async () => {
    // analysisRate = 1.0, faceDetectionRate = 0.4 — not good (faceDetectionRate < 0.6), not poor (>= 0.3)
    const vp = await createDualProcessorWithRates(1.0, 0.4);
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });

  it("returns 'degraded' when camera drop detected with otherwise good metrics", async () => {
    // analysisRate = 1.0, faceDetectionRate = 0.8, but camera drop → caps to "degraded"
    const vp = await createDualProcessorWithRates(1.0, 0.8, { cameraDrop: true });
    const obs = await vp.finalize();
    expect(obs.videoQualityGrade).toBe("degraded");
  });
});
