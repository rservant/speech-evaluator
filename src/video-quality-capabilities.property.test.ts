/**
 * Property-based test: Capabilities reflect detector configuration (Property 5)
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 *
 * For any VideoProcessor, the capabilities field in the returned VisualObservations
 * SHALL satisfy:
 * - capabilities.face === true iff deps.faceDetector was defined
 * - capabilities.pose === true iff deps.poseDetector was defined
 *
 * Testing approach: Generate random boolean pairs (hasFace, hasPose) to determine
 * which detectors to include in deps. Create a VideoProcessor with those deps,
 * enqueue at least one frame, finalize, and assert capabilities match.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type FaceDetector,
  type PoseDetector,
  type FaceDetection,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import type { VideoConfig, FrameHeader } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

function makeFaceDetector(): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [
        [100, 100], [200, 100], [150, 150],
        [150, 200], [80, 130], [220, 130],
      ],
      boundingBox: { x: 80, y: 80, width: 160, height: 160 },
      confidence: 0.9,
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

// ─── Property 5 ─────────────────────────────────────────────────────────────────

describe("Feature: video-quality-always-poor, Property 5", () => {
  it("capabilities.face and capabilities.pose match detector presence for all four combos", async () => {
    await fc.assert(
      fc.asyncProperty(
        // hasFace: whether to include a faceDetector
        fc.boolean(),
        // hasPose: whether to include a poseDetector
        fc.boolean(),
        // frameCount: at least 1 frame to produce meaningful output
        fc.integer({ min: 1, max: 20 }),
        async (hasFace, hasPose, frameCount) => {
          const config = makeConfig();
          const deps: VideoProcessorDeps = {
            ...(hasFace ? { faceDetector: makeFaceDetector() } : {}),
            ...(hasPose ? { poseDetector: makePoseDetector() } : {}),
          };

          const vp = new VideoProcessor(config, deps);

          // Enqueue frames with strictly increasing timestamps and seq numbers
          for (let i = 0; i < frameCount; i++) {
            const header: FrameHeader = {
              timestamp: 0.5 + i * 0.5, // strictly increasing, within stale threshold
              seq: i,
              width: 640,
              height: 480,
            };
            vp.enqueueFrame(header, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
          }

          const result = await vp.finalize();

          // Property: capabilities.face === true iff faceDetector was defined
          expect(result.capabilities.face).toBe(hasFace);
          // Property: capabilities.pose === true iff poseDetector was defined
          expect(result.capabilities.pose).toBe(hasPose);
        },
      ),
      { numRuns: 100 },
    );
  });
});
