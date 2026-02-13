/**
 * Property-based test: faceNotDetectedCount remains 0 without face detector (Property 3)
 *
 * **Validates: Requirements 4.1**
 *
 * For any VideoProcessor instantiated without a faceDetector, and for any sequence
 * of frames processed, faceNotDetectedCount SHALL be 0 in the resulting VisualObservations.
 *
 * Testing approach: Generate random frame sequences (varying number of frames,
 * timestamps, etc.) and process them through a VideoProcessor with pose-only deps.
 * After finalize(), assert faceNotDetectedCount === 0.
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
import type { VideoConfig, FrameHeader } from "./types.js";

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

/**
 * Generate an increasing sequence of timestamps suitable for FrameHeaders.
 * Constraints:
 *   - frameCount: 1-50
 *   - timestamps: strictly increasing positive numbers
 *   - gaps between consecutive timestamps <= staleFrameThresholdSeconds (2s default)
 *     to avoid being dropped by the stale-frame guard in enqueueFrame
 */
function frameSequenceArb() {
  return fc
    .integer({ min: 1, max: 50 })
    .chain((frameCount) =>
      fc
        .array(
          fc.double({ min: 0.01, max: 1.5, noNaN: true }),
          { minLength: frameCount, maxLength: frameCount },
        )
        .map((gaps) => {
          // Build strictly increasing timestamps from gaps
          const timestamps: number[] = [];
          let t = 0.5; // start at 0.5s
          for (const gap of gaps) {
            t += gap;
            // Round to avoid floating point issues
            timestamps.push(Math.round(t * 1000) / 1000);
          }
          return timestamps;
        }),
    );
}

// ─── Property 3 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 3", () => {
  it("faceNotDetectedCount remains 0 without face detector for any frame sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        frameSequenceArb(),
        async (timestamps) => {
          const config = makeConfig();
          const deps: VideoProcessorDeps = {
            poseDetector: makePoseDetector(),
            // No faceDetector — pose-only mode
          };

          const vp = new VideoProcessor(config, deps);

          // Enqueue frames with strictly increasing timestamps and seq numbers
          for (let i = 0; i < timestamps.length; i++) {
            const header: FrameHeader = {
              timestamp: timestamps[i],
              seq: i,
              width: 640,
              height: 480,
            };
            // Create a minimal non-empty buffer
            vp.enqueueFrame(header, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
          }

          const result = await vp.finalize();

          // Property: faceNotDetectedCount must be 0 when no face detector is configured
          expect(result.faceNotDetectedCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
