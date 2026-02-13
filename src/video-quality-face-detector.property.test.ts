/**
 * Property-based test: Face-detector grade preserves original dual-metric behavior (Property 2)
 *
 * **Validates: Requirements 1.5, 2.1, 2.2, 2.3**
 *
 * For any VideoProcessor instantiated with a faceDetector, and for any combination
 * of analysisRate, faceDetectionRate, and cameraDropDetected:
 *   - analysisRate >= 0.8 AND faceDetectionRate >= 0.6 AND no camera drop → "good"
 *   - analysisRate < 0.5 OR faceDetectionRate < 0.3 → "poor"
 *   - Otherwise → "degraded"
 *
 * Where:
 *   - faceDetectionRate = (framesAnalyzed - faceNotDetectedCount) / framesAnalyzed
 *   - analysisRate = Math.min(1, framesAnalyzed / expectedSampleCount)
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type FaceDetector,
  type FaceDetection,
  type PoseDetector,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import type { VideoConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

function makeFaceDetector(): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [
        [100, 100], // right eye
        [140, 100], // left eye
        [120, 130], // nose
        [120, 160], // mouth
        [80, 110],  // right ear
        [160, 110], // left ear
      ],
      boundingBox: { x: 70, y: 70, width: 100, height: 120 },
      confidence: 0.95,
    } satisfies FaceDetection),
  };
}

function makePoseDetector(): PoseDetector {
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
      confidence: 0.8,
    } satisfies PoseDetection),
  };
}

// ─── Expected grade oracle ──────────────────────────────────────────────────────

/**
 * Compute the expected grade for a face-detector VideoProcessor based on
 * analysisRate, faceDetectionRate, and cameraDropDetected, per Requirements 1.5, 2.1–2.3, 3.1–3.3.
 */
function expectedGrade(
  analysisRate: number,
  faceDetectionRate: number,
  cameraDropDetected: boolean,
): "good" | "degraded" | "poor" {
  // Poor conditions (Req 2.2)
  if (analysisRate < 0.5 || faceDetectionRate < 0.3) return "poor";

  // Good conditions (Req 2.1)
  if (analysisRate >= 0.8 && faceDetectionRate >= 0.6 && !cameraDropDetected) return "good";

  // Everything else (Req 2.3) — includes camera drop downgrade from good to degraded (Req 3.1)
  return "degraded";
}

// ─── Property 2 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 2", () => {
  it("face-detector grade preserves original dual-metric behavior", async () => {
    await fc.assert(
      fc.asyncProperty(
        // framesAnalyzed: positive integers 1-100
        fc.integer({ min: 1, max: 100 }),
        // expectedSampleCount: positive number > 0 for meaningful test
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        // faceDetectedFrames: 0 to 100 (clamped to framesAnalyzed below)
        fc.integer({ min: 0, max: 100 }),
        // cameraDropDetected: boolean
        fc.boolean(),
        async (framesAnalyzed, expectedSampleCount, rawFaceDetectedFrames, cameraDropDetected) => {
          // Clamp faceDetectedFrames to [0, framesAnalyzed]
          const faceDetectedFrames = Math.min(rawFaceDetectedFrames, framesAnalyzed);
          const faceNotDetectedCount = framesAnalyzed - faceDetectedFrames;

          const analysisRate = Math.min(1, framesAnalyzed / expectedSampleCount);
          const faceDetectionRate = faceDetectedFrames / framesAnalyzed;

          // Derive lastReceivedTimestamp from expectedSampleCount:
          // expectedSampleCount = lastReceivedTimestamp * effectiveRate
          // effectiveRate = config.frameRate = 2 (default, normal mode)
          // So lastReceivedTimestamp = expectedSampleCount / frameRate
          const frameRate = 2;
          const lastReceivedTimestamp = expectedSampleCount / frameRate;

          const config = makeConfig();
          const deps: VideoProcessorDeps = {
            faceDetector: makeFaceDetector(),
            poseDetector: makePoseDetector(),
          };

          const vp = new VideoProcessor(config, deps);

          // Directly set internal state to achieve the desired test values.
          const vpAny = vp as any;
          vpAny.framesAnalyzed = framesAnalyzed;
          vpAny.lastReceivedTimestamp = lastReceivedTimestamp;
          vpAny.faceNotDetectedCount = faceNotDetectedCount;

          // Push gaze classifications to match framesAnalyzed
          // (processFrame pushes one per frame; needed for gazeBreakdown and faceDetectedFrames computation)
          // faceDetectedFrames = gazeClassifications.length - faceNotDetectedCount
          // So gazeClassifications.length must equal framesAnalyzed
          vpAny.gazeClassifications = Array(framesAnalyzed).fill("other");

          // Control camera drop detection:
          // cameraDropDetected = Date.now() - lastFrameWallTime > cameraDropTimeoutSeconds * 1000
          // Default cameraDropTimeoutSeconds = 5, so threshold = 5000ms
          if (cameraDropDetected) {
            // Set lastFrameWallTime far in the past so camera drop is detected
            vpAny.lastFrameWallTime = Date.now() - (config.cameraDropTimeoutSeconds * 1000 + 1000);
          } else {
            // Set lastFrameWallTime to now so no camera drop
            vpAny.lastFrameWallTime = Date.now();
          }

          const result = await vp.finalize();

          const expected = expectedGrade(analysisRate, faceDetectionRate, cameraDropDetected);
          expect(result.videoQualityGrade).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
