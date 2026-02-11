// Property-Based Test: Frame sampler selects at configured rate
// Feature: phase-4-multimodal-video, Property 6

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { FrameSampler } from "./frame-sampler.js";

// ─── Generators ─────────────────────────────────────────────────────────────────

/** Generator for valid frame rates in the configurable range (1-5 FPS). */
const arbitraryFrameRate = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max: 5 });

/**
 * Generator for a monotonically increasing sequence of timestamps.
 * Produces sorted, unique timestamps simulating realistic frame arrival.
 * Duration is bounded to keep tests fast while covering meaningful ranges.
 */
const arbitraryMonotonicTimestamps = (): fc.Arbitrary<number[]> =>
  fc
    .array(fc.double({ min: 0, max: 30, noNaN: true, noDefaultInfinity: true }), {
      minLength: 2,
      maxLength: 200,
    })
    .map((arr) => {
      // Sort and deduplicate to guarantee strict monotonic increase
      const sorted = [...new Set(arr)].sort((a, b) => a - b);
      return sorted.length >= 2 ? sorted : [0, 1]; // fallback to ensure at least 2 timestamps
    });

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 6: Frame sampler selects at configured rate", () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any monotonically increasing sequence of frame timestamps and a
   * configured frame rate R, the FrameSampler SHALL select at most R frames
   * per second. Specifically, the time gap between any two consecutively
   * selected frames SHALL be at least 1/R seconds.
   */

  it("consecutive sampled frames are at least 1/frameRate seconds apart", () => {
    fc.assert(
      fc.property(
        arbitraryFrameRate(),
        arbitraryMonotonicTimestamps(),
        (frameRate, timestamps) => {
          const sampler = new FrameSampler(frameRate);
          const interval = 1 / frameRate;
          const sampledTimestamps: number[] = [];

          for (const ts of timestamps) {
            if (sampler.shouldSample(ts)) {
              sampledTimestamps.push(ts);
            }
          }

          // Check that consecutive sampled frames respect the minimum interval
          for (let i = 1; i < sampledTimestamps.length; i++) {
            const gap = sampledTimestamps[i] - sampledTimestamps[i - 1];
            expect(gap).toBeGreaterThanOrEqual(interval - 1e-9); // floating-point tolerance
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("the first frame is always sampled", () => {
    fc.assert(
      fc.property(
        arbitraryFrameRate(),
        arbitraryMonotonicTimestamps(),
        (frameRate, timestamps) => {
          const sampler = new FrameSampler(frameRate);

          // The very first call to shouldSample must return true
          expect(sampler.shouldSample(timestamps[0])).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("sampled count does not exceed the theoretical maximum for the duration", () => {
    fc.assert(
      fc.property(
        arbitraryFrameRate(),
        arbitraryMonotonicTimestamps(),
        (frameRate, timestamps) => {
          const sampler = new FrameSampler(frameRate);
          let sampledCount = 0;

          for (const ts of timestamps) {
            if (sampler.shouldSample(ts)) {
              sampledCount++;
            }
          }

          const duration = timestamps[timestamps.length - 1] - timestamps[0];
          // Upper bound: at most floor(duration * frameRate) + 1 samples
          // (+1 for the first frame at the start of the first interval)
          const maxExpected = Math.floor(duration * frameRate) + 1;
          expect(sampledCount).toBeLessThanOrEqual(maxExpected);
          // Lower bound: at least 1 (the first frame is always sampled)
          expect(sampledCount).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("number of sampled frames approximates duration * frameRate (±1) with dense input", () => {
    fc.assert(
      fc.property(
        arbitraryFrameRate(),
        fc.integer({ min: 2, max: 30 }), // duration in whole seconds
        (frameRate, durationSeconds) => {
          // Generate timestamps at 1ms resolution (integer milliseconds converted
          // to seconds). This simulates a realistic high-rate camera feed where
          // every sampling interval has multiple candidate frames.
          const timestamps: number[] = [];
          for (let ms = 0; ms <= durationSeconds * 1000; ms++) {
            timestamps.push(ms / 1000);
          }

          const sampler = new FrameSampler(frameRate);
          let sampledCount = 0;
          for (const ts of timestamps) {
            if (sampler.shouldSample(ts)) {
              sampledCount++;
            }
          }

          // With 1ms resolution input, every sampling interval (200ms-1000ms)
          // has hundreds of candidate frames. The sampled count should be
          // approximately duration * frameRate + 1 (for the first frame).
          // ±1 tolerance for floating-point boundary effects at interval edges.
          const expectedCount = durationSeconds * frameRate + 1;
          expect(sampledCount).toBeGreaterThanOrEqual(expectedCount - 1);
          expect(sampledCount).toBeLessThanOrEqual(expectedCount + 1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
