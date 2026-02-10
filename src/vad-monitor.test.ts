// Unit tests for VADMonitor edge cases
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5

import { describe, it, expect, vi } from "vitest";
import { VADMonitor, computeChunkRMS } from "./vad-monitor.js";
import type { VADConfig, VADEventCallback } from "./vad-monitor.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Seconds per audio chunk (50ms at 16kHz mono) */
const SECONDS_PER_CHUNK = 0.05;

/**
 * Create a 16-bit PCM mono buffer where every sample has the given amplitude.
 * For a constant-amplitude signal, computeChunkRMS returns |amplitude|.
 */
function makeConstantAmplitudeChunk(
  amplitude: number,
  sampleCount = 800,
): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  const clamped = Math.max(-32768, Math.min(32767, Math.round(amplitude)));
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(clamped, i * 2);
  }
  return buf;
}

/**
 * Create a default VADConfig with overrides.
 */
function makeConfig(overrides: Partial<VADConfig> = {}): VADConfig {
  return {
    silenceThresholdSeconds: 5,
    enabled: true,
    silenceFactor: 0.15,
    minSpeechSeconds: 3,
    suppressionSeconds: 10,
    statusIntervalMs: 0, // Emit status on every chunk for testing
    speechEnergyWindowChunks: 6000,
    noiseFloorBootstrapChunks: 40,
    thresholdMultiplier: 0.15,
    ...overrides,
  };
}

/**
 * Create a VADMonitor with tracking callbacks.
 */
function createTrackedMonitor(config: VADConfig) {
  const speechEndCalls: number[] = [];
  const statusCalls: Array<{ energy: number; isSpeech: boolean }> = [];

  const callbacks: VADEventCallback = {
    onSpeechEnd: (dur) => speechEndCalls.push(dur),
    onStatus: (status) => statusCalls.push({ ...status }),
  };

  const monitor = new VADMonitor(config, callbacks);
  return { monitor, speechEndCalls, statusCalls };
}

/**
 * Feed N speech chunks (amplitude 1000) to satisfy suppression rules and bootstrap.
 * Returns the number of chunks fed.
 */
function feedSpeechPreamble(
  monitor: VADMonitor,
  config: VADConfig,
): number {
  const minForSuppression = Math.ceil(
    config.suppressionSeconds / SECONDS_PER_CHUNK,
  );
  const minForSpeech = Math.ceil(config.minSpeechSeconds / SECONDS_PER_CHUNK);
  const count = Math.max(
    minForSuppression,
    minForSpeech,
    config.noiseFloorBootstrapChunks,
  );
  for (let i = 0; i < count; i++) {
    monitor.feedChunk(makeConstantAmplitudeChunk(1000));
  }
  return count;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("VADMonitor unit tests — edge cases", () => {
  // ── 1. Empty chunk (0 bytes) ────────────────────────────────────────────────

  describe("empty chunk (0 bytes)", () => {
    it("computeChunkRMS returns 0 for an empty buffer", () => {
      const empty = Buffer.alloc(0);
      expect(computeChunkRMS(empty)).toBe(0);
    });

    it("feedChunk handles an empty buffer gracefully without throwing", () => {
      const config = makeConfig();
      const { monitor } = createTrackedMonitor(config);

      // Should not throw
      expect(() => monitor.feedChunk(Buffer.alloc(0))).not.toThrow();
    });

    it("computeChunkRMS returns 0 for a single-byte buffer (not enough for one Int16 sample)", () => {
      const oneByte = Buffer.alloc(1);
      expect(computeChunkRMS(oneByte)).toBe(0);
    });
  });

  // ── 2. Zero-amplitude audio ─────────────────────────────────────────────────

  describe("zero-amplitude audio (all samples are 0)", () => {
    it("computeChunkRMS returns 0 for a zero-amplitude chunk", () => {
      const zeroChunk = makeConstantAmplitudeChunk(0, 800);
      expect(computeChunkRMS(zeroChunk)).toBe(0);
    });

    it("classifies zero-amplitude chunks as silence", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls } = createTrackedMonitor(config);

      // Feed a zero-amplitude chunk (during bootstrap, threshold is 50)
      monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));

      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0].isSpeech).toBe(false);
    });
  });

  // ── 3. Single chunk ─────────────────────────────────────────────────────────

  describe("single chunk", () => {
    it("feedChunk works with just one chunk and emits a status", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls, speechEndCalls } =
        createTrackedMonitor(config);

      monitor.feedChunk(makeConstantAmplitudeChunk(500, 800));

      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0].energy).toBeGreaterThan(0);
      // Single chunk cannot trigger speech-end (suppression rules not met)
      expect(speechEndCalls).toHaveLength(0);
    });

    it("single speech chunk is classified as speech during bootstrap", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls } = createTrackedMonitor(config);

      // Amplitude 100 >= bootstrap threshold of 50 → speech
      monitor.feedChunk(makeConstantAmplitudeChunk(100, 800));

      expect(statusCalls[0].isSpeech).toBe(true);
    });

    it("single silence chunk is classified as silence during bootstrap", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls } = createTrackedMonitor(config);

      // Amplitude 30 < bootstrap threshold of 50 → silence
      monitor.feedChunk(makeConstantAmplitudeChunk(30, 800));

      expect(statusCalls[0].isSpeech).toBe(false);
    });
  });

  // ── 4. Config boundary values ───────────────────────────────────────────────

  describe("config boundary values", () => {
    it("silenceThresholdSeconds at minimum (3) triggers speech-end correctly", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 3,
        suppressionSeconds: 5,
        minSpeechSeconds: 1,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      // Feed speech preamble to satisfy suppression + bootstrap
      feedSpeechPreamble(monitor, config);

      // Feed silence: need (N-1)*0.05 >= 3 → N >= 61
      const silenceChunks = 62;
      for (let i = 0; i < silenceChunks; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      expect(speechEndCalls).toHaveLength(1);
      expect(speechEndCalls[0]).toBeGreaterThanOrEqual(3);
    });

    it("silenceThresholdSeconds at maximum (15) triggers speech-end correctly", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 15,
        suppressionSeconds: 10,
        minSpeechSeconds: 3,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      // Feed speech preamble
      feedSpeechPreamble(monitor, config);

      // Feed silence: need (N-1)*0.05 >= 15 → N >= 301
      const silenceChunks = 302;
      for (let i = 0; i < silenceChunks; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      expect(speechEndCalls).toHaveLength(1);
      expect(speechEndCalls[0]).toBeGreaterThanOrEqual(15);
    });

    it("silenceThresholdSeconds at maximum (15) does NOT trigger with insufficient silence", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 15,
        suppressionSeconds: 10,
        minSpeechSeconds: 3,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      feedSpeechPreamble(monitor, config);

      // Feed 14.9 seconds of silence = 298 chunks → (297)*0.05 = 14.85s < 15
      const silenceChunks = 298;
      for (let i = 0; i < silenceChunks; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      expect(speechEndCalls).toHaveLength(0);
    });
  });

  // ── 5. reset() clears all state ─────────────────────────────────────────────

  describe("reset() clears all state", () => {
    it("after feeding chunks, reset() returns monitor to initial state", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls, speechEndCalls } =
        createTrackedMonitor(config);

      // Feed speech preamble + some silence to build up state
      feedSpeechPreamble(monitor, config);
      for (let i = 0; i < 50; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      // Reset
      monitor.reset();

      // Clear tracking arrays to observe post-reset behavior
      statusCalls.length = 0;
      speechEndCalls.length = 0;

      // After reset, the monitor should behave as if freshly constructed:
      // - First chunk is in bootstrap period (totalChunksProcessed = 0)
      // - Bootstrap threshold of 50 applies
      // - Amplitude 30 < 50 → silence
      monitor.feedChunk(makeConstantAmplitudeChunk(30, 800));
      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0].isSpeech).toBe(false);

      // Amplitude 100 >= 50 → speech (bootstrap threshold)
      monitor.feedChunk(makeConstantAmplitudeChunk(100, 800));
      expect(statusCalls).toHaveLength(2);
      expect(statusCalls[1].isSpeech).toBe(true);
    });

    it("reset() clears the adaptive threshold (speechRmsValues)", () => {
      const config = makeConfig({
        statusIntervalMs: 0,
        noiseFloorBootstrapChunks: 5,
      });
      const { monitor, statusCalls } = createTrackedMonitor(config);

      // Feed high-amplitude speech to build a high adaptive threshold
      for (let i = 0; i < 20; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(10000, 800));
      }

      // After bootstrap with high speech energy, adaptive threshold would be
      // 10000 * 0.15 = 1500. Amplitude 200 would be silence.
      statusCalls.length = 0;
      monitor.feedChunk(makeConstantAmplitudeChunk(200, 800));
      expect(statusCalls[0].isSpeech).toBe(false);

      // Reset and verify bootstrap threshold (50) is back
      monitor.reset();
      statusCalls.length = 0;

      // Now amplitude 200 >= 50 → speech (bootstrap threshold)
      monitor.feedChunk(makeConstantAmplitudeChunk(200, 800));
      expect(statusCalls[0].isSpeech).toBe(true);
    });

    it("reset() clears suppression counters so speech-end requires new preamble", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 3,
        suppressionSeconds: 5,
        minSpeechSeconds: 1,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      // Satisfy suppression rules
      feedSpeechPreamble(monitor, config);

      // Reset — suppression counters should be cleared
      monitor.reset();
      speechEndCalls.length = 0;

      // Feed silence immediately after reset — suppression rules not met
      // (totalChunksProcessed = 0, speechChunksProcessed = 0)
      for (let i = 0; i < 100; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      // No speech-end should fire because suppression rules are not satisfied
      expect(speechEndCalls).toHaveLength(0);
    });
  });

  // ── 6. stop() prevents further emissions ────────────────────────────────────

  describe("stop() prevents further emissions", () => {
    it("after stop(), feedChunk() is a no-op — no status or speech-end emitted", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls, speechEndCalls } =
        createTrackedMonitor(config);

      // Feed some chunks to establish state
      feedSpeechPreamble(monitor, config);

      const statusCountBefore = statusCalls.length;
      const speechEndCountBefore = speechEndCalls.length;

      // Stop the monitor
      monitor.stop();

      // Feed more chunks — should be no-ops
      for (let i = 0; i < 50; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(1000, 800));
      }
      for (let i = 0; i < 200; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      // No new emissions after stop
      expect(statusCalls.length).toBe(statusCountBefore);
      expect(speechEndCalls.length).toBe(speechEndCountBefore);
    });

    it("stop() mid-silence prevents the pending speech-end from firing", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 5,
        suppressionSeconds: 5,
        minSpeechSeconds: 1,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      // Satisfy suppression rules
      feedSpeechPreamble(monitor, config);

      // Feed some silence (not enough to trigger speech-end yet)
      // 3 seconds of silence = 60 chunks, threshold is 5s
      for (let i = 0; i < 60; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }
      expect(speechEndCalls).toHaveLength(0);

      // Stop the monitor
      monitor.stop();

      // Feed more silence that would have crossed the threshold
      for (let i = 0; i < 100; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      // Speech-end should NOT have fired
      expect(speechEndCalls).toHaveLength(0);
    });
  });

  // ── 7. reset() re-arms after stop() ─────────────────────────────────────────

  describe("reset() re-arms after stop()", () => {
    it("stop() then reset() allows feedChunk() to work again", () => {
      const config = makeConfig({ statusIntervalMs: 0 });
      const { monitor, statusCalls } = createTrackedMonitor(config);

      // Feed some chunks
      monitor.feedChunk(makeConstantAmplitudeChunk(500, 800));
      expect(statusCalls).toHaveLength(1);

      // Stop — feedChunk becomes no-op
      monitor.stop();
      const countAfterStop = statusCalls.length;
      monitor.feedChunk(makeConstantAmplitudeChunk(500, 800));
      expect(statusCalls.length).toBe(countAfterStop);

      // Reset — re-arms the monitor
      monitor.reset();
      monitor.feedChunk(makeConstantAmplitudeChunk(500, 800));
      expect(statusCalls.length).toBe(countAfterStop + 1);
    });

    it("after stop() then reset(), speech-end detection works with fresh state", () => {
      const config = makeConfig({
        silenceThresholdSeconds: 3,
        suppressionSeconds: 5,
        minSpeechSeconds: 1,
        statusIntervalMs: 0,
      });
      const { monitor, speechEndCalls } = createTrackedMonitor(config);

      // Build up state and stop
      feedSpeechPreamble(monitor, config);
      monitor.stop();

      // Reset — fresh state
      monitor.reset();
      speechEndCalls.length = 0;

      // Need to satisfy suppression rules again from scratch
      feedSpeechPreamble(monitor, config);

      // Feed silence to trigger speech-end: need (N-1)*0.05 >= 3 → N >= 61
      for (let i = 0; i < 62; i++) {
        monitor.feedChunk(makeConstantAmplitudeChunk(0, 800));
      }

      expect(speechEndCalls).toHaveLength(1);
      expect(speechEndCalls[0]).toBeGreaterThanOrEqual(3);
    });
  });
});
