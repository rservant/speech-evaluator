/**
 * Unit tests for frame-sampler.ts
 * Validates: Requirements 2.3, 2.9, 15.5
 */

import { describe, it, expect } from "vitest";
import { FrameSampler } from "./frame-sampler.js";

// ─── Samples at Configured Rate ─────────────────────────────────────────────

describe("FrameSampler", () => {
  describe("samples at configured rate", () => {
    it("samples frames spaced exactly at the interval", () => {
      const sampler = new FrameSampler(2); // 2 FPS → 0.5s interval
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.5)).toBe(true);
      expect(sampler.shouldSample(1.0)).toBe(true);
      expect(sampler.shouldSample(1.5)).toBe(true);
    });

    it("samples at 5 FPS (0.2s interval)", () => {
      const sampler = new FrameSampler(5);
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.2)).toBe(true);
      expect(sampler.shouldSample(0.4)).toBe(true);
    });

    it("samples at 1 FPS (1.0s interval)", () => {
      const sampler = new FrameSampler(1);
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.5)).toBe(false);
      expect(sampler.shouldSample(1.0)).toBe(true);
      expect(sampler.shouldSample(1.5)).toBe(false);
      expect(sampler.shouldSample(2.0)).toBe(true);
    });
  });

  // ─── First Frame Always Sampled ─────────────────────────────────────────────

  describe("first frame is always sampled", () => {
    it("samples the very first frame at timestamp 0", () => {
      const sampler = new FrameSampler(2);
      expect(sampler.shouldSample(0)).toBe(true);
    });

    it("samples the very first frame at a non-zero timestamp", () => {
      const sampler = new FrameSampler(2);
      expect(sampler.shouldSample(5.0)).toBe(true);
    });

    it("samples the first frame regardless of frame rate", () => {
      for (const rate of [1, 2, 3, 4, 5]) {
        const sampler = new FrameSampler(rate);
        expect(sampler.shouldSample(0)).toBe(true);
      }
    });
  });

  // ─── Frames Within Interval Are Skipped ───────────────────────────────────

  describe("frames within interval are skipped", () => {
    it("skips frames that arrive before the interval elapses", () => {
      const sampler = new FrameSampler(2); // 0.5s interval
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.1)).toBe(false);
      expect(sampler.shouldSample(0.2)).toBe(false);
      expect(sampler.shouldSample(0.3)).toBe(false);
      expect(sampler.shouldSample(0.49)).toBe(false);
    });

    it("skips rapid frames at high input rate", () => {
      const sampler = new FrameSampler(2); // 0.5s interval
      // Simulate 30 FPS input (~0.033s apart)
      expect(sampler.shouldSample(0.0)).toBe(true);
      for (let t = 0.033; t < 0.5; t += 0.033) {
        expect(sampler.shouldSample(t)).toBe(false);
      }
      expect(sampler.shouldSample(0.5)).toBe(true);
    });
  });

  // ─── reset() Allows Re-sampling ──────────────────────────────────────────

  describe("reset() allows re-sampling", () => {
    it("allows the next frame to be sampled after reset", () => {
      const sampler = new FrameSampler(2);
      sampler.shouldSample(0.0);
      sampler.shouldSample(0.5);

      sampler.reset();

      // After reset, the next frame should be sampled regardless of timestamp
      expect(sampler.shouldSample(0.6)).toBe(true);
    });

    it("reset allows re-sampling at timestamp 0", () => {
      const sampler = new FrameSampler(2);
      sampler.shouldSample(0.0);
      sampler.shouldSample(0.5);

      sampler.reset();

      expect(sampler.shouldSample(0.0)).toBe(true);
    });

    it("reset does not affect the configured rate", () => {
      const sampler = new FrameSampler(2); // 0.5s interval
      sampler.shouldSample(0.0);
      sampler.reset();

      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.3)).toBe(false);
      expect(sampler.shouldSample(0.5)).toBe(true);
    });
  });

  // ─── setRate() Changes Interval at Runtime ────────────────────────────────

  describe("setRate() changes the interval at runtime", () => {
    it("halves the effective rate when setRate is called with half the rate", () => {
      const sampler = new FrameSampler(2); // 0.5s interval
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.5)).toBe(true);

      sampler.setRate(1); // now 1.0s interval
      // Last sampled at 0.5, next should be at 1.5
      expect(sampler.shouldSample(1.0)).toBe(false);
      expect(sampler.shouldSample(1.5)).toBe(true);
    });

    it("doubles the effective rate when setRate is called with double the rate", () => {
      const sampler = new FrameSampler(1); // 1.0s interval
      expect(sampler.shouldSample(0.0)).toBe(true);

      sampler.setRate(2); // now 0.5s interval
      expect(sampler.shouldSample(0.5)).toBe(true);
      expect(sampler.shouldSample(0.7)).toBe(false);
      expect(sampler.shouldSample(1.0)).toBe(true);
    });

    it("takes effect immediately for the next shouldSample call", () => {
      const sampler = new FrameSampler(2); // 0.5s interval
      expect(sampler.shouldSample(0.0)).toBe(true);

      sampler.setRate(5); // now 0.2s interval
      expect(sampler.shouldSample(0.2)).toBe(true);
      expect(sampler.shouldSample(0.3)).toBe(false);
      expect(sampler.shouldSample(0.4)).toBe(true);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles zero timestamp correctly", () => {
      const sampler = new FrameSampler(2);
      expect(sampler.shouldSample(0)).toBe(true);
      expect(sampler.shouldSample(0)).toBe(false); // same timestamp, within interval
    });

    it("handles very high frame rate (e.g., 1000 FPS → 0.001s interval)", () => {
      const sampler = new FrameSampler(1000);
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.0005)).toBe(false);
      expect(sampler.shouldSample(0.001)).toBe(true);
      expect(sampler.shouldSample(0.002)).toBe(true);
    });

    it("handles large timestamp gaps gracefully", () => {
      const sampler = new FrameSampler(2);
      expect(sampler.shouldSample(0.0)).toBe(true);
      // Large gap — should still sample
      expect(sampler.shouldSample(100.0)).toBe(true);
    });

    it("handles fractional frame rates", () => {
      const sampler = new FrameSampler(3); // 0.333...s interval
      expect(sampler.shouldSample(0.0)).toBe(true);
      expect(sampler.shouldSample(0.3)).toBe(false);
      expect(sampler.shouldSample(1.0 / 3)).toBe(true);
    });
  });
});
