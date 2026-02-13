/**
 * Property-based test: No detectors forces poor grade (Property 6)
 *
 * **Validates: Requirements 7.1, 7.3**
 *
 * For any VideoProcessor instantiated with capabilities.face === false AND
 * capabilities.pose === false, the returned videoQualityGrade SHALL be "poor"
 * regardless of analysisRate or cameraDropDetected.
 *
 * This rule takes precedence over the Analysis_Rate-based grading in Requirement 1 —
 * even if analysisRate >= 0.8, the grade SHALL be "poor" when no detectors are available.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type VideoProcessorDeps,
} from "./video-processor.js";
import type { VideoConfig } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

// ─── Property 6 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 6", () => {
  it("no detectors forces poor grade regardless of analysisRate or cameraDropDetected", async () => {
    await fc.assert(
      fc.asyncProperty(
        // framesAnalyzed: positive integers 1-100
        fc.integer({ min: 1, max: 100 }),
        // expectedSampleCount: positive number > 0
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        // cameraDropDetected: boolean
        fc.boolean(),
        async (framesAnalyzed, expectedSampleCount, cameraDropDetected) => {
          // Derive lastReceivedTimestamp from expectedSampleCount:
          // expectedSampleCount = lastReceivedTimestamp * effectiveRate
          // effectiveRate = config.frameRate = 2 (default, normal mode)
          const frameRate = 2;
          const lastReceivedTimestamp = expectedSampleCount / frameRate;

          const config = makeConfig();
          const deps: VideoProcessorDeps = {
            // No faceDetector, no poseDetector — no detectors at all
          };

          const vp = new VideoProcessor(config, deps);

          // Directly set internal state to achieve the desired test values
          const vpAny = vp as any;
          vpAny.framesAnalyzed = framesAnalyzed;
          vpAny.lastReceivedTimestamp = lastReceivedTimestamp;

          // Push gaze classifications to match framesAnalyzed
          vpAny.gazeClassifications = Array(framesAnalyzed).fill("other");

          // Control camera drop detection:
          // cameraDropDetected = Date.now() - lastFrameWallTime > cameraDropTimeoutSeconds * 1000
          if (cameraDropDetected) {
            vpAny.lastFrameWallTime = Date.now() - (config.cameraDropTimeoutSeconds * 1000 + 1000);
          } else {
            vpAny.lastFrameWallTime = Date.now();
          }

          const result = await vp.finalize();

          // Grade MUST always be "poor" when no detectors are configured,
          // regardless of analysisRate or camera drop status
          expect(result.videoQualityGrade).toBe("poor");
        },
      ),
      { numRuns: 100 },
    );
  });
});
