/**
 * Property-based test: No-face-detector grade depends solely on analysisRate and cameraDrop (Property 1)
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3**
 *
 * For any VideoProcessor instantiated without a faceDetector (but with a poseDetector),
 * and for any combination of framesAnalyzed, expectedSampleCount, faceNotDetectedCount,
 * and cameraDropDetected:
 *   - analysisRate >= 0.8 and no camera drop → "good"
 *   - analysisRate >= 0.8 and camera drop → "degraded"
 *   - 0.5 <= analysisRate < 0.8 → "degraded" (camera drop has no additional effect)
 *   - analysisRate < 0.5 → "poor" (camera drop has no additional effect)
 *
 * The faceNotDetectedCount value SHALL have no effect on the grade.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type PoseDetector,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import type { VideoConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
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
 * Compute the expected grade for a no-face-detector VideoProcessor based on
 * analysisRate and cameraDropDetected, per Requirements 1.1–1.4, 3.1–3.3.
 */
function expectedGrade(
  analysisRate: number,
  cameraDropDetected: boolean,
): "good" | "degraded" | "poor" {
  if (analysisRate < 0.5) return "poor";
  if (analysisRate >= 0.8 && !cameraDropDetected) return "good";
  return "degraded";
}

// ─── Property 1 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 1", () => {
  it("no-face-detector grade depends solely on analysisRate and cameraDrop", async () => {
    await fc.assert(
      fc.asyncProperty(
        // framesAnalyzed: positive integers 1-100
        fc.integer({ min: 1, max: 100 }),
        // expectedSampleCount: positive number > 0 for meaningful test
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        // faceNotDetectedCount: 0 to framesAnalyzed (generated separately, clamped below)
        fc.integer({ min: 0, max: 100 }),
        // cameraDropDetected: boolean
        fc.boolean(),
        async (framesAnalyzed, expectedSampleCount, rawFaceNotDetected, cameraDropDetected) => {
          // Clamp faceNotDetectedCount to [0, framesAnalyzed]
          const faceNotDetectedCount = Math.min(rawFaceNotDetected, framesAnalyzed);

          const analysisRate = Math.min(1, framesAnalyzed / expectedSampleCount);

          // Derive lastReceivedTimestamp from expectedSampleCount:
          // expectedSampleCount = lastReceivedTimestamp * effectiveRate
          // effectiveRate = config.frameRate = 2 (default, normal mode)
          // So lastReceivedTimestamp = expectedSampleCount / frameRate
          const frameRate = 2;
          const lastReceivedTimestamp = expectedSampleCount / frameRate;

          const config = makeConfig();
          const deps: VideoProcessorDeps = {
            poseDetector: makePoseDetector(),
            // No faceDetector — pose-only mode
          };

          const vp = new VideoProcessor(config, deps);

          // Directly set internal state to achieve the desired test values.
          // This avoids complex frame enqueuing and sampling logic.
          const vpAny = vp as any;
          vpAny.framesAnalyzed = framesAnalyzed;
          vpAny.lastReceivedTimestamp = lastReceivedTimestamp;
          vpAny.faceNotDetectedCount = faceNotDetectedCount;

          // Push enough gaze classifications to match framesAnalyzed
          // (processFrame pushes one per frame; needed for gazeBreakdown computation)
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

          const expected = expectedGrade(analysisRate, cameraDropDetected);
          expect(result.videoQualityGrade).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
