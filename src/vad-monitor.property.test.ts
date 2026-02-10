// Property-Based Tests for VADMonitor
// Feature: phase-3-semi-automation, VAD-P1: Chunk RMS classification matches adaptive threshold

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { VADMonitor, computeChunkRMS } from "./vad-monitor.js";
import type { VADConfig, VADEventCallback, VADStatus } from "./vad-monitor.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Fixed conservative RMS threshold used during bootstrap (mirrors vad-monitor.ts constant) */
const BOOTSTRAP_RMS_THRESHOLD = 50;

/** Seconds per audio chunk (50ms at 16kHz mono) */
const SECONDS_PER_CHUNK = 0.05;

/**
 * Compute the median of a numeric array (mirrors the private computeMedian in vad-monitor.ts).
 * Returns 0 for empty arrays.
 */
function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Create a 16-bit PCM mono buffer where every sample has the given amplitude.
 * For a constant-amplitude signal, computeChunkRMS returns |amplitude|.
 */
function makeConstantAmplitudeChunk(amplitude: number, sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  // Clamp to Int16 range
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

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generator for audio chunk sequences with controlled speech/silence patterns.
 * Based on the design document's arbitraryAudioChunkSequence generator.
 */
const arbitraryAudioChunkSequence = fc.record({
  chunks: fc.array(
    fc.record({
      isSpeech: fc.boolean(),
      amplitude: fc.integer({ min: 0, max: 32767 }),
      sampleCount: fc.constant(800), // 50ms at 16kHz
    }),
    { minLength: 1, maxLength: 200 }
  ),
  config: fc.record({
    silenceThresholdSeconds: fc.integer({ min: 3, max: 15 }),
    silenceFactor: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
    minSpeechSeconds: fc.integer({ min: 1, max: 5 }),
    suppressionSeconds: fc.integer({ min: 5, max: 15 }),
  }),
});

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-3-semi-automation, VAD-P1: Chunk RMS classification matches adaptive threshold", () => {
  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * VAD-P1: Chunk RMS classification matches adaptive threshold
   *
   * For any audio chunk and any speech energy baseline (array of prior speech-active
   * RMS values), the VAD_Monitor SHALL classify the chunk as silence if and only if
   * its computed RMS energy is below `median(speechRmsValues) * silenceFactor`.
   * Chunks at or above the threshold SHALL be classified as speech.
   *
   * This test feeds a sequence of speech-energy "baseline" chunks to establish the
   * adaptive threshold, then feeds a single "probe" chunk and verifies the
   * classification matches the expected result based on the computed threshold.
   *
   * We test the post-bootstrap regime by ensuring enough chunks are processed
   * and enough speech data is collected before probing.
   */
  it("classifies probe chunk correctly against adaptive threshold after bootstrap", () => {
    // Generator: a set of speech RMS values (the baseline), a probe amplitude,
    // and a silenceFactor (thresholdMultiplier).
    //
    // Strategy: simulate the monitor's sequential processing to compute the
    // exact speechRmsValues array and threshold that the monitor will use when
    // classifying the probe chunk. This accounts for the bootstrap period and
    // the fact that the adaptive threshold may cause some baseline chunks to be
    // classified as silence (and thus excluded from speechRmsValues).
    const arbitraryClassificationScenario = fc.record({
      // Baseline amplitudes to feed before the probe.
      // Must have enough entries to exit bootstrap and accumulate speech data.
      baselineAmplitudes: fc.array(
        fc.integer({ min: 0, max: 20000 }),
        { minLength: 50, maxLength: 200 }
      ),
      // The probe chunk amplitude to classify
      probeAmplitude: fc.integer({ min: 0, max: 32767 }),
      // The threshold multiplier (silenceFactor)
      thresholdMultiplier: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
      // Bootstrap chunk count
      noiseFloorBootstrapChunks: fc.constant(40),
    });

    fc.assert(
      fc.property(arbitraryClassificationScenario, ({ baselineAmplitudes, probeAmplitude, thresholdMultiplier, noiseFloorBootstrapChunks }) => {
        // Track the last status emitted
        let lastStatus: VADStatus | null = null;

        const config = makeConfig({
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks,
          statusIntervalMs: 0, // Emit on every chunk
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Simulate the monitor's sequential processing to compute the expected
        // speechRmsValues and threshold at the time of the probe chunk.
        const simulatedSpeechRmsValues: number[] = [];
        let totalChunks = 0;

        for (const amp of baselineAmplitudes) {
          const chunkRMS = Math.abs(amp);

          // Determine threshold for this chunk (same logic as getSilenceThreshold)
          const isInBootstrap = totalChunks < noiseFloorBootstrapChunks;
          const hasEnoughSpeechData = simulatedSpeechRmsValues.length >= noiseFloorBootstrapChunks;

          let threshold: number;
          if (isInBootstrap || !hasEnoughSpeechData) {
            threshold = BOOTSTRAP_RMS_THRESHOLD;
          } else {
            const median = computeMedian(simulatedSpeechRmsValues);
            threshold = median * thresholdMultiplier;
          }

          const isSpeech = chunkRMS >= threshold;
          if (isSpeech) {
            simulatedSpeechRmsValues.push(chunkRMS);
            if (simulatedSpeechRmsValues.length > config.speechEnergyWindowChunks) {
              simulatedSpeechRmsValues.shift();
            }
          }

          totalChunks++;

          // Feed the actual chunk to the monitor
          const chunk = makeConstantAmplitudeChunk(amp, 800);
          monitor.feedChunk(chunk);
        }

        // Now compute the expected threshold for the probe chunk
        const probeIsInBootstrap = totalChunks < noiseFloorBootstrapChunks;
        const probeHasEnoughSpeechData = simulatedSpeechRmsValues.length >= noiseFloorBootstrapChunks;

        let expectedThreshold: number;
        if (probeIsInBootstrap || !probeHasEnoughSpeechData) {
          expectedThreshold = BOOTSTRAP_RMS_THRESHOLD;
        } else {
          const median = computeMedian(simulatedSpeechRmsValues);
          expectedThreshold = median * thresholdMultiplier;
        }

        // Feed the probe chunk
        const probeChunk = makeConstantAmplitudeChunk(probeAmplitude, 800);
        monitor.feedChunk(probeChunk);

        // The probe chunk's RMS = |probeAmplitude| (constant amplitude)
        const probeRMS = Math.abs(probeAmplitude);

        // Verify classification
        expect(lastStatus).not.toBeNull();
        const expectedIsSpeech = probeRMS >= expectedThreshold;
        expect(lastStatus!.isSpeech).toBe(expectedIsSpeech);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * During the bootstrap period (first noiseFloorBootstrapChunks chunks),
   * the VADMonitor uses a fixed conservative threshold of 50 RMS units.
   * Chunks with RMS < 50 are silence; chunks with RMS >= 50 are speech.
   */
  it("classifies chunks against fixed bootstrap threshold during bootstrap period", () => {
    const arbitraryBootstrapScenario = fc.record({
      // Probe amplitude during bootstrap
      probeAmplitude: fc.integer({ min: 0, max: 32767 }),
      // Which chunk index to probe (within bootstrap period)
      probeIndex: fc.integer({ min: 0, max: 39 }),
      // Amplitudes for chunks before the probe (all within bootstrap)
      prefixAmplitudes: fc.array(
        fc.integer({ min: 0, max: 32767 }),
        { minLength: 0, maxLength: 39 }
      ),
    });

    fc.assert(
      fc.property(arbitraryBootstrapScenario, ({ probeAmplitude, probeIndex, prefixAmplitudes }) => {
        let lastStatus: VADStatus | null = null;

        const config = makeConfig({
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed prefix chunks (up to probeIndex, staying within bootstrap)
        const chunksToFeed = Math.min(probeIndex, prefixAmplitudes.length);
        for (let i = 0; i < chunksToFeed; i++) {
          const chunk = makeConstantAmplitudeChunk(prefixAmplitudes[i], 800);
          monitor.feedChunk(chunk);
        }

        // Feed the probe chunk (still within bootstrap since totalChunksProcessed < 40)
        const probeChunk = makeConstantAmplitudeChunk(probeAmplitude, 800);
        monitor.feedChunk(probeChunk);

        // During bootstrap, threshold is fixed at 50
        const probeRMS = Math.abs(probeAmplitude);
        const expectedIsSpeech = probeRMS >= BOOTSTRAP_RMS_THRESHOLD;

        expect(lastStatus).not.toBeNull();
        expect(lastStatus!.isSpeech).toBe(expectedIsSpeech);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * When insufficient speech data is available after bootstrap (fewer than
   * noiseFloorBootstrapChunks speech-active chunks observed), the fixed
   * bootstrap threshold continues to be used even after the bootstrap period ends.
   */
  it("uses fixed threshold when insufficient speech data after bootstrap period", () => {
    const arbitraryInsufficientSpeechScenario = fc.record({
      // Number of silence chunks to feed (amplitude < 50, so they won't be speech)
      // Feed enough to pass bootstrap but with no speech data
      silenceChunkCount: fc.integer({ min: 41, max: 100 }),
      silenceAmplitude: fc.integer({ min: 0, max: 49 }),
      // Probe amplitude
      probeAmplitude: fc.integer({ min: 0, max: 32767 }),
    });

    fc.assert(
      fc.property(arbitraryInsufficientSpeechScenario, ({ silenceChunkCount, silenceAmplitude, probeAmplitude }) => {
        let lastStatus: VADStatus | null = null;

        const config = makeConfig({
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed silence-only chunks (amplitude < 50 = bootstrap threshold)
        // These won't be classified as speech, so speechRmsValues stays empty
        for (let i = 0; i < silenceChunkCount; i++) {
          const chunk = makeConstantAmplitudeChunk(silenceAmplitude, 800);
          monitor.feedChunk(chunk);
        }

        // We're past bootstrap (totalChunksProcessed > 40) but have no speech data
        // (speechRmsValues.length < noiseFloorBootstrapChunks), so fixed threshold applies

        // Feed probe
        const probeChunk = makeConstantAmplitudeChunk(probeAmplitude, 800);
        monitor.feedChunk(probeChunk);

        const probeRMS = Math.abs(probeAmplitude);
        const expectedIsSpeech = probeRMS >= BOOTSTRAP_RMS_THRESHOLD;

        expect(lastStatus).not.toBeNull();
        expect(lastStatus!.isSpeech).toBe(expectedIsSpeech);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.2**
   *
   * Verify that computeChunkRMS correctly computes the RMS of a constant-amplitude
   * 16-bit PCM buffer. For a buffer where every sample is `A`, RMS = |A|.
   */
  it("computeChunkRMS returns |amplitude| for constant-amplitude buffers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -32768, max: 32767 }),
        fc.integer({ min: 1, max: 2000 }),
        (amplitude, sampleCount) => {
          const chunk = makeConstantAmplitudeChunk(amplitude, sampleCount);
          const rms = computeChunkRMS(chunk);
          // For constant amplitude A, RMS = sqrt(A^2) = |A|
          expect(rms).toBeCloseTo(Math.abs(amplitude), 5);
        }
      ),
      { numRuns: 200 }
    );
  });
});


// ─── VAD-P2: Speech-end suggestion emitted on sustained silence ─────────────────

describe("Feature: phase-3-semi-automation, VAD-P2: Speech-end suggestion emitted on sustained silence", () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * VAD-P2: Speech-end suggestion emitted on sustained silence
   *
   * For any sequence of audio chunks where (a) the suppression window has elapsed,
   * (b) minimum speech activity has been observed, and (c) consecutive silence chunks
   * span at least `silenceThresholdSeconds`, the VAD_Monitor SHALL emit exactly one
   * `onSpeechEnd` callback with a `silenceDurationSeconds` value greater than or equal
   * to the configured threshold.
   *
   * Strategy:
   * 1. Generate randomized but valid config values (suppressionSeconds, minSpeechSeconds,
   *    silenceThresholdSeconds, thresholdMultiplier).
   * 2. Feed enough high-amplitude speech chunks to satisfy suppression rules
   *    (elapsed time >= suppressionSeconds AND speech time >= minSpeechSeconds)
   *    and to exit the bootstrap period with a reliable adaptive threshold.
   * 3. Feed low-amplitude silence chunks for at least silenceThresholdSeconds.
   * 4. Assert exactly one onSpeechEnd was emitted with silenceDurationSeconds >= threshold.
   */
  it("emits exactly one onSpeechEnd when suppression satisfied and silence exceeds threshold", () => {
    const SPEECH_AMPLITUDE = 1000; // Well above any adaptive threshold
    const SILENCE_AMPLITUDE = 0;   // Well below any threshold
    const SAMPLES_PER_CHUNK = 800; // 50ms at 16kHz

    const arbitrarySpeechEndScenario = fc.record({
      // Config parameters — constrained to keep test runtime reasonable
      suppressionSeconds: fc.integer({ min: 5, max: 10 }),
      minSpeechSeconds: fc.integer({ min: 1, max: 4 }),
      silenceThresholdSeconds: fc.integer({ min: 3, max: 8 }),
      thresholdMultiplier: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
      // Extra speech chunks beyond the minimum required (to add randomness)
      extraSpeechChunks: fc.integer({ min: 0, max: 40 }),
      // Extra silence chunks beyond the minimum required
      extraSilenceChunks: fc.integer({ min: 1, max: 40 }),
    });

    fc.assert(
      fc.property(arbitrarySpeechEndScenario, ({
        suppressionSeconds,
        minSpeechSeconds,
        silenceThresholdSeconds,
        thresholdMultiplier,
        extraSpeechChunks,
        extraSilenceChunks,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds,
          minSpeechSeconds,
          silenceThresholdSeconds,
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Phase 1: Feed speech chunks to satisfy ALL suppression rules.
        // We need:
        //   - totalChunksProcessed * 0.05 >= suppressionSeconds (elapsed time)
        //   - speechChunksProcessed * 0.05 >= minSpeechSeconds (speech time)
        //   - totalChunksProcessed >= noiseFloorBootstrapChunks (exit bootstrap)
        //   - speechRmsValues.length >= noiseFloorBootstrapChunks (enough speech data for adaptive threshold)
        //
        // Since all chunks are speech, speechChunksProcessed == totalChunksProcessed.
        // The binding constraint is max(suppressionSeconds/0.05, minSpeechSeconds/0.05, 40).
        const minSpeechChunksForSuppression = Math.ceil(suppressionSeconds / SECONDS_PER_CHUNK);
        const minSpeechChunksForMinSpeech = Math.ceil(minSpeechSeconds / SECONDS_PER_CHUNK);
        const minSpeechChunksForBootstrap = 40; // noiseFloorBootstrapChunks
        const totalSpeechChunks = Math.max(
          minSpeechChunksForSuppression,
          minSpeechChunksForMinSpeech,
          minSpeechChunksForBootstrap,
        ) + extraSpeechChunks;

        for (let i = 0; i < totalSpeechChunks; i++) {
          const chunk = makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK);
          monitor.feedChunk(chunk);
        }

        // No speech-end should have been emitted yet (all speech, no silence)
        expect(speechEndCalls).toHaveLength(0);

        // Phase 2: Feed silence chunks to trigger speech-end detection.
        // We need silence duration >= silenceThresholdSeconds.
        // Silence duration = (totalChunksProcessed - silenceStartChunk) * 0.05
        // silenceStartChunk is set on the first silence chunk.
        // The check happens BEFORE totalChunksProcessed is incremented.
        // So after feeding N silence chunks, the silence duration seen on the Nth chunk is:
        //   (totalChunksProcessed_before_increment - silenceStartChunk) * 0.05
        //   = ((totalSpeechChunks + N - 1) - totalSpeechChunks) * 0.05
        //   = (N - 1) * 0.05
        // We need (N - 1) * 0.05 >= silenceThresholdSeconds
        // => N >= silenceThresholdSeconds / 0.05 + 1
        const minSilenceChunks = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK) + 1;
        const totalSilenceChunks = minSilenceChunks + extraSilenceChunks;

        for (let i = 0; i < totalSilenceChunks; i++) {
          const chunk = makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK);
          monitor.feedChunk(chunk);
        }

        // Exactly one onSpeechEnd should have been emitted
        expect(speechEndCalls).toHaveLength(1);

        // The reported silence duration should be >= the configured threshold
        expect(speechEndCalls[0]).toBeGreaterThanOrEqual(silenceThresholdSeconds);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Verify that the silence duration reported in onSpeechEnd accurately reflects
   * the audio-time duration of the silence episode (not wall-clock time).
   * The reported value should be (totalChunksProcessed - silenceStartChunk) * 0.05.
   */
  it("reports silence duration in audio-time that matches chunk count", () => {
    const SPEECH_AMPLITUDE = 1000;
    const SILENCE_AMPLITUDE = 0;
    const SAMPLES_PER_CHUNK = 800;

    const arbitraryDurationScenario = fc.record({
      // How many silence chunks beyond the threshold to feed
      // (the exact silence duration should be deterministic based on chunk count)
      silenceThresholdSeconds: fc.integer({ min: 3, max: 8 }),
      // Extra silence chunks beyond the exact threshold boundary
      extraSilenceChunks: fc.integer({ min: 0, max: 20 }),
    });

    fc.assert(
      fc.property(arbitraryDurationScenario, ({
        silenceThresholdSeconds,
        extraSilenceChunks,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds: 5,
          minSpeechSeconds: 1,
          silenceThresholdSeconds,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed enough speech to satisfy all suppression rules
        // suppressionSeconds=5 => 100 chunks, minSpeechSeconds=1 => 20 chunks, bootstrap=40
        const speechChunks = Math.ceil(5 / SECONDS_PER_CHUNK); // 100 chunks = 5s
        for (let i = 0; i < speechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Feed silence chunks: exactly enough to trigger + extra
        const minSilenceChunks = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK) + 1;
        const totalSilenceChunks = minSilenceChunks + extraSilenceChunks;

        for (let i = 0; i < totalSilenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Exactly one emission
        expect(speechEndCalls).toHaveLength(1);

        // The reported duration should be a multiple of SECONDS_PER_CHUNK (audio-time)
        const reportedDuration = speechEndCalls[0];
        const durationInChunks = reportedDuration / SECONDS_PER_CHUNK;
        // Should be an integer (or very close to one) since it's chunk-based
        expect(Math.abs(durationInChunks - Math.round(durationInChunks))).toBeLessThan(0.001);

        // The reported duration should be >= threshold
        expect(reportedDuration).toBeGreaterThanOrEqual(silenceThresholdSeconds);

        // The reported duration should be the exact silence duration at the moment
        // the threshold was first crossed. Since hasSuggestedForCurrentSilence prevents
        // re-emission, the value is frozen at the first crossing point.
        // First crossing: (N-1) * 0.05 >= silenceThresholdSeconds where N is the chunk index
        // The exact value is (minSilenceChunks - 1) * 0.05
        const expectedDuration = (minSilenceChunks - 1) * SECONDS_PER_CHUNK;
        expect(reportedDuration).toBeCloseTo(expectedDuration, 10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * No onSpeechEnd is emitted if silence duration is less than silenceThresholdSeconds,
   * even when all other suppression conditions are met.
   */
  it("does not emit onSpeechEnd when silence is shorter than threshold", () => {
    const SPEECH_AMPLITUDE = 1000;
    const SILENCE_AMPLITUDE = 0;
    const SAMPLES_PER_CHUNK = 800;

    const arbitraryShortSilenceScenario = fc.record({
      silenceThresholdSeconds: fc.integer({ min: 3, max: 10 }),
      // Silence chunks: fewer than needed to reach the threshold
      // Need (N-1)*0.05 < silenceThresholdSeconds => N < silenceThresholdSeconds/0.05 + 1
      // So max silence chunks = ceil(silenceThresholdSeconds/0.05) - 1 (one less than needed)
      // We generate a fraction of the threshold to ensure we're under
      silenceFraction: fc.double({ min: 0.1, max: 0.95, noNaN: true }),
    });

    fc.assert(
      fc.property(arbitraryShortSilenceScenario, ({
        silenceThresholdSeconds,
        silenceFraction,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds: 5,
          minSpeechSeconds: 1,
          silenceThresholdSeconds,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed enough speech to satisfy all suppression rules
        const speechChunks = Math.ceil(5 / SECONDS_PER_CHUNK); // 100 chunks = 5s
        for (let i = 0; i < speechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Feed silence chunks: fewer than needed to reach the threshold
        // The maximum silence duration we'll reach is (silenceChunks - 1) * 0.05
        // We want this to be < silenceThresholdSeconds
        const maxSilenceChunks = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK);
        const silenceChunks = Math.max(1, Math.floor(maxSilenceChunks * silenceFraction));

        for (let i = 0; i < silenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Verify the silence duration we achieved is actually below threshold
        // Silence duration = (silenceChunks - 1) * 0.05
        const achievedSilenceDuration = (silenceChunks - 1) * SECONDS_PER_CHUNK;
        if (achievedSilenceDuration < silenceThresholdSeconds) {
          // No onSpeechEnd should have been emitted
          expect(speechEndCalls).toHaveLength(0);
        }
        // If by rounding we happened to reach the threshold, that's fine — skip assertion
      }),
      { numRuns: 200 }
    );
  });
});


// ─── VAD-P3: At most one suggestion per silence episode ─────────────────────────

describe("Feature: phase-3-semi-automation, VAD-P3: At most one suggestion per silence episode", () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * VAD-P3: At most one suggestion per silence episode
   *
   * For any sequence of audio chunks fed to the VAD_Monitor, the number of
   * `onSpeechEnd` emissions SHALL be at most equal to the number of distinct
   * silence episodes (where a silence episode is a maximal contiguous run of
   * silence chunks bounded by speech chunks on both sides or by recording
   * start/end). No two consecutive `onSpeechEnd` emissions SHALL occur without
   * an intervening speech-active chunk.
   *
   * Strategy:
   * Generate sequences with multiple speech→silence→speech→silence patterns.
   * Use high amplitude (1000+) for speech and 0 for silence to ensure
   * deterministic classification. Satisfy suppression rules first (enough
   * elapsed time and speech time). Count the number of distinct silence
   * episodes in the generated sequence and verify onSpeechEnd count ≤ episode count.
   * Also verify no two consecutive onSpeechEnd emissions occur without an
   * intervening speech chunk.
   */
  it("emits at most one onSpeechEnd per silence episode across multi-episode sequences", () => {
    const SPEECH_AMPLITUDE = 1000; // Well above any adaptive threshold
    const SILENCE_AMPLITUDE = 0;   // Well below any threshold
    const SAMPLES_PER_CHUNK = 800; // 50ms at 16kHz

    // Generator: produce a sequence of "segments" where each segment is either
    // a run of speech chunks or a run of silence chunks. This naturally creates
    // distinct silence episodes separated by speech.
    const arbitrarySegment = fc.record({
      type: fc.constantFrom("speech" as const, "silence" as const),
      // Number of chunks in this segment
      chunkCount: fc.integer({ min: 1, max: 60 }),
    });

    const arbitraryMultiEpisodeScenario = fc.record({
      // Config parameters
      silenceThresholdSeconds: fc.integer({ min: 3, max: 6 }),
      suppressionSeconds: fc.integer({ min: 5, max: 8 }),
      minSpeechSeconds: fc.integer({ min: 1, max: 3 }),
      thresholdMultiplier: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
      // The sequence of segments (speech/silence runs)
      segments: fc.array(arbitrarySegment, { minLength: 2, maxLength: 15 }),
    });

    fc.assert(
      fc.property(arbitraryMultiEpisodeScenario, ({
        silenceThresholdSeconds,
        suppressionSeconds,
        minSpeechSeconds,
        thresholdMultiplier,
        segments,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          silenceThresholdSeconds,
          suppressionSeconds,
          minSpeechSeconds,
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Phase 1: Feed enough speech to satisfy suppression rules and bootstrap.
        // This ensures the adaptive threshold is established and suppression
        // conditions are met before we start the multi-episode sequence.
        const minChunksForSuppression = Math.ceil(suppressionSeconds / SECONDS_PER_CHUNK);
        const minChunksForMinSpeech = Math.ceil(minSpeechSeconds / SECONDS_PER_CHUNK);
        const preambleSpeechChunks = Math.max(minChunksForSuppression, minChunksForMinSpeech, 40);

        for (let i = 0; i < preambleSpeechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // No emissions should have occurred during the preamble (all speech)
        expect(speechEndCalls).toHaveLength(0);

        // Phase 2: Feed the generated segment sequence and track silence episodes.
        // A silence episode is a maximal contiguous run of silence chunks.
        // We count episodes by detecting transitions: when we go from speech
        // (or preamble) to silence, that starts a new episode.
        let lastChunkType: "speech" | "silence" = "speech"; // preamble was speech
        let silenceEpisodeCount = 0;

        // Track chunk indices where onSpeechEnd fires to verify interleaving
        let totalChunksFed = preambleSpeechChunks;
        const speechEndChunkIndices: number[] = [];
        const originalOnSpeechEnd = callbacks.onSpeechEnd;
        callbacks.onSpeechEnd = (silenceDuration) => {
          speechEndChunkIndices.push(totalChunksFed);
          originalOnSpeechEnd(silenceDuration);
        };
        // Re-wire the callbacks — but since VADMonitor stores the reference at
        // construction time, we need to track emissions differently.
        // Instead, let's just track via the speechEndCalls array length changes.

        // Actually, the callbacks object was passed by reference to the constructor,
        // and the monitor stores the reference. Since we're mutating the same object,
        // the monitor will use the updated callback. Let's verify by resetting:
        // No — the monitor stores `this.callbacks = callbacks` which is the same
        // object reference. Mutating `callbacks.onSpeechEnd` after construction
        // WILL affect the monitor. But let's keep it simple and just use speechEndCalls.

        // Restore original callback
        callbacks.onSpeechEnd = originalOnSpeechEnd;

        for (const segment of segments) {
          const amplitude = segment.type === "speech" ? SPEECH_AMPLITUDE : SILENCE_AMPLITUDE;

          if (segment.type === "silence" && lastChunkType === "speech") {
            // Transition from speech to silence: new silence episode
            silenceEpisodeCount++;
          }

          for (let i = 0; i < segment.chunkCount; i++) {
            monitor.feedChunk(makeConstantAmplitudeChunk(amplitude, SAMPLES_PER_CHUNK));
            totalChunksFed++;
          }

          lastChunkType = segment.type;
        }

        // Property 1: onSpeechEnd count ≤ number of distinct silence episodes
        expect(speechEndCalls.length).toBeLessThanOrEqual(silenceEpisodeCount);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.4**
   *
   * No two consecutive onSpeechEnd emissions occur without an intervening
   * speech-active chunk. This is verified by constructing a deterministic
   * multi-episode sequence (speech→silence→speech→silence→...) where each
   * silence episode is long enough to trigger, and checking that each emission
   * corresponds to a distinct silence episode with speech in between.
   */
  it("never emits two consecutive onSpeechEnd without intervening speech", () => {
    const SPEECH_AMPLITUDE = 1000;
    const SILENCE_AMPLITUDE = 0;
    const SAMPLES_PER_CHUNK = 800;

    const arbitraryInterleaveScenario = fc.record({
      silenceThresholdSeconds: fc.integer({ min: 3, max: 6 }),
      // Number of silence episodes to create (each separated by speech)
      episodeCount: fc.integer({ min: 2, max: 5 }),
      // Extra silence chunks per episode beyond the minimum needed
      extraSilencePerEpisode: fc.integer({ min: 1, max: 20 }),
      // Speech chunks between episodes (must be >= 1 to separate episodes)
      speechChunksBetweenEpisodes: fc.integer({ min: 1, max: 40 }),
    });

    fc.assert(
      fc.property(arbitraryInterleaveScenario, ({
        silenceThresholdSeconds,
        episodeCount,
        extraSilencePerEpisode,
        speechChunksBetweenEpisodes,
      }) => {
        // Track which chunk index each onSpeechEnd fires at, and whether
        // the chunk was speech or silence at that point.
        const emissionLog: { chunkIndex: number }[] = [];
        let totalChunks = 0;

        const config = makeConfig({
          silenceThresholdSeconds,
          suppressionSeconds: 5,
          minSpeechSeconds: 1,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => { emissionLog.push({ chunkIndex: totalChunks }); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Preamble: satisfy suppression rules with speech
        const preambleChunks = Math.ceil(5 / SECONDS_PER_CHUNK); // 100 chunks = 5s
        for (let i = 0; i < preambleChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
          totalChunks++;
        }

        // Build alternating speech/silence episodes
        const minSilenceChunks = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK) + 1;
        const silenceChunksPerEpisode = minSilenceChunks + extraSilencePerEpisode;

        // Track the chunk ranges for each phase (speech vs silence)
        const phases: { type: "speech" | "silence"; startChunk: number; endChunk: number }[] = [];

        for (let ep = 0; ep < episodeCount; ep++) {
          // Silence episode
          const silenceStart = totalChunks;
          for (let i = 0; i < silenceChunksPerEpisode; i++) {
            monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
            totalChunks++;
          }
          phases.push({ type: "silence", startChunk: silenceStart, endChunk: totalChunks - 1 });

          // Speech between episodes (except after the last episode)
          if (ep < episodeCount - 1) {
            const speechStart = totalChunks;
            for (let i = 0; i < speechChunksBetweenEpisodes; i++) {
              monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
              totalChunks++;
            }
            phases.push({ type: "speech", startChunk: speechStart, endChunk: totalChunks - 1 });
          }
        }

        // Property: No two consecutive emissions without intervening speech.
        // Each emission should fall within a distinct silence phase, and between
        // any two emissions there must be a speech phase.
        for (let i = 1; i < emissionLog.length; i++) {
          const prevChunk = emissionLog[i - 1].chunkIndex;
          const currChunk = emissionLog[i].chunkIndex;

          // Find which phases these emissions fall in
          const prevPhase = phases.find(p => prevChunk >= p.startChunk && prevChunk <= p.endChunk);
          const currPhase = phases.find(p => currChunk >= p.startChunk && currChunk <= p.endChunk);

          // Both should be in silence phases
          expect(prevPhase?.type).toBe("silence");
          expect(currPhase?.type).toBe("silence");

          // They should be in different silence phases (not the same one)
          expect(prevPhase).not.toBe(currPhase);

          // There must be a speech phase between them
          const hasSpeechBetween = phases.some(
            p => p.type === "speech" && p.startChunk > prevPhase!.endChunk && p.endChunk < currPhase!.startChunk
          );
          expect(hasSpeechBetween).toBe(true);
        }

        // Also verify: total emissions ≤ episodeCount
        expect(emissionLog.length).toBeLessThanOrEqual(episodeCount);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.4**
   *
   * Within a single long silence episode (no intervening speech), exactly one
   * onSpeechEnd is emitted regardless of how long the silence continues.
   * This directly tests the `hasSuggestedForCurrentSilence` guard.
   */
  it("emits exactly one onSpeechEnd for a single extended silence episode", () => {
    const SPEECH_AMPLITUDE = 1000;
    const SILENCE_AMPLITUDE = 0;
    const SAMPLES_PER_CHUNK = 800;

    const arbitraryExtendedSilenceScenario = fc.record({
      silenceThresholdSeconds: fc.integer({ min: 3, max: 6 }),
      // Multiplier for how many times longer than the threshold the silence lasts
      silenceMultiplier: fc.integer({ min: 2, max: 10 }),
    });

    fc.assert(
      fc.property(arbitraryExtendedSilenceScenario, ({
        silenceThresholdSeconds,
        silenceMultiplier,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          silenceThresholdSeconds,
          suppressionSeconds: 5,
          minSpeechSeconds: 1,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Preamble: satisfy suppression rules
        const preambleChunks = Math.ceil(5 / SECONDS_PER_CHUNK); // 100 chunks = 5s
        for (let i = 0; i < preambleChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Feed silence for silenceMultiplier × silenceThresholdSeconds
        // This is much longer than needed to trigger, testing that only one emission occurs
        const totalSilenceSeconds = silenceThresholdSeconds * silenceMultiplier;
        const totalSilenceChunks = Math.ceil(totalSilenceSeconds / SECONDS_PER_CHUNK) + 1;

        for (let i = 0; i < totalSilenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Exactly one emission despite extended silence
        expect(speechEndCalls).toHaveLength(1);

        // The reported duration should be >= threshold
        expect(speechEndCalls[0]).toBeGreaterThanOrEqual(silenceThresholdSeconds);
      }),
      { numRuns: 200 }
    );
  });
});


// ─── VAD-P4: Suppression rules prevent premature suggestions ────────────────────

describe("Feature: phase-3-semi-automation, VAD-P4: Suppression rules prevent premature suggestions", () => {
  /**
   * **Validates: Requirements 1.5, 1.7**
   *
   * VAD-P4: Suppression rules prevent premature suggestions
   *
   * For any sequence of audio chunks, the VAD_Monitor SHALL NOT emit an
   * `onSpeechEnd` callback if either (a) fewer than `suppressionSeconds`
   * (default 10) have elapsed since monitoring started, or (b) fewer than
   * `minSpeechSeconds` (default 3) of speech-active chunks have been observed.
   * Both conditions must be satisfied before any suggestion can be emitted.
   *
   * Test 1: No onSpeechEnd when elapsed time < suppressionSeconds
   * Even with enough speech and enough silence, if the total recording elapsed
   * time (totalChunksProcessed * 0.05) is less than suppressionSeconds, no
   * onSpeechEnd should be emitted.
   */
  it("does not emit onSpeechEnd when elapsed time is less than suppressionSeconds", () => {
    const SPEECH_AMPLITUDE = 1000; // Well above any threshold
    const SILENCE_AMPLITUDE = 0;   // Well below any threshold
    const SAMPLES_PER_CHUNK = 800; // 50ms at 16kHz

    const arbitraryElapsedTimeScenario = fc.record({
      // suppressionSeconds: how long to suppress (we'll ensure we stay under this)
      suppressionSeconds: fc.integer({ min: 5, max: 15 }),
      // minSpeechSeconds: set low so speech requirement is easily met
      minSpeechSeconds: fc.integer({ min: 1, max: 3 }),
      // silenceThresholdSeconds: set low so silence threshold is easily met
      silenceThresholdSeconds: fc.integer({ min: 3, max: 5 }),
      // fraction of suppressionSeconds to use as total elapsed time (< 1.0 means under suppression)
      elapsedFraction: fc.double({ min: 0.2, max: 0.95, noNaN: true }),
    });

    fc.assert(
      fc.property(arbitraryElapsedTimeScenario, ({
        suppressionSeconds,
        minSpeechSeconds,
        silenceThresholdSeconds,
        elapsedFraction,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds,
          minSpeechSeconds,
          silenceThresholdSeconds,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Total chunks we can feed while staying under suppressionSeconds
        // elapsed time = totalChunksProcessed * 0.05
        // We want totalChunksProcessed * 0.05 < suppressionSeconds
        // => totalChunksProcessed < suppressionSeconds / 0.05
        const maxTotalChunks = Math.ceil(suppressionSeconds / SECONDS_PER_CHUNK) - 1;
        const totalBudget = Math.max(1, Math.floor(maxTotalChunks * elapsedFraction));

        // Allocate chunks: enough speech to satisfy minSpeechSeconds, then silence
        const minSpeechChunks = Math.ceil(minSpeechSeconds / SECONDS_PER_CHUNK);
        // Ensure we have enough speech chunks (but don't exceed total budget)
        const speechChunks = Math.min(minSpeechChunks + 10, Math.floor(totalBudget * 0.6));
        const silenceChunks = totalBudget - speechChunks;

        if (speechChunks <= 0 || silenceChunks <= 0) return; // Skip degenerate cases

        // Feed speech chunks
        for (let i = 0; i < speechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Feed silence chunks
        for (let i = 0; i < silenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Verify we stayed under suppressionSeconds
        // The suppression check uses totalChunksProcessed BEFORE increment,
        // so the max elapsed time seen during feedChunk is (totalBudget - 1) * 0.05
        const maxElapsedTimeSeen = (totalBudget - 1) * SECONDS_PER_CHUNK;
        if (maxElapsedTimeSeen < suppressionSeconds) {
          // No onSpeechEnd should have been emitted
          expect(speechEndCalls).toHaveLength(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.5, 1.7**
   *
   * Test 2: No onSpeechEnd when speech accumulated time < minSpeechSeconds
   * Even with enough elapsed time and enough silence, if the accumulated speech
   * time (speechChunksProcessed * 0.05) is less than minSpeechSeconds, no
   * onSpeechEnd should be emitted.
   */
  it("does not emit onSpeechEnd when speech time is less than minSpeechSeconds", () => {
    const SPEECH_AMPLITUDE = 1000; // Well above any threshold
    const SILENCE_AMPLITUDE = 0;   // Well below any threshold
    const SAMPLES_PER_CHUNK = 800; // 50ms at 16kHz

    const arbitrarySpeechTimeScenario = fc.record({
      // suppressionSeconds: set low so elapsed time requirement is easily met
      suppressionSeconds: fc.integer({ min: 5, max: 8 }),
      // minSpeechSeconds: the speech time threshold we'll stay under
      minSpeechSeconds: fc.integer({ min: 3, max: 5 }),
      // silenceThresholdSeconds: set low so silence threshold is easily met
      silenceThresholdSeconds: fc.integer({ min: 3, max: 5 }),
      // fraction of minSpeechSeconds to use as speech time (< 1.0 means under threshold)
      speechFraction: fc.double({ min: 0.1, max: 0.95, noNaN: true }),
    });

    fc.assert(
      fc.property(arbitrarySpeechTimeScenario, ({
        suppressionSeconds,
        minSpeechSeconds,
        silenceThresholdSeconds,
        speechFraction,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds,
          minSpeechSeconds,
          silenceThresholdSeconds,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Speech chunks: fewer than minSpeechSeconds worth
        // speechChunksProcessed * 0.05 < minSpeechSeconds
        // => speechChunksProcessed < minSpeechSeconds / 0.05
        const maxSpeechChunks = Math.ceil(minSpeechSeconds / SECONDS_PER_CHUNK) - 1;
        const speechChunks = Math.max(1, Math.floor(maxSpeechChunks * speechFraction));

        // Silence chunks: enough to exceed both suppressionSeconds (elapsed time)
        // and silenceThresholdSeconds (silence duration)
        // We need total elapsed time >= suppressionSeconds, so:
        // (speechChunks + silenceChunks) * 0.05 >= suppressionSeconds
        // => silenceChunks >= suppressionSeconds / 0.05 - speechChunks
        const minSilenceForSuppression = Math.ceil(suppressionSeconds / SECONDS_PER_CHUNK) - speechChunks;
        // Also need silence duration >= silenceThresholdSeconds:
        // (silenceChunks - 1) * 0.05 >= silenceThresholdSeconds (the -1 accounts for the check timing)
        const minSilenceForThreshold = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK) + 1;
        const silenceChunks = Math.max(minSilenceForSuppression, minSilenceForThreshold) + 10;

        if (speechChunks <= 0) return; // Skip degenerate cases

        // Feed speech chunks first
        for (let i = 0; i < speechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Feed silence chunks
        for (let i = 0; i < silenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Verify that speech time is indeed under minSpeechSeconds
        const speechTime = speechChunks * SECONDS_PER_CHUNK;
        if (speechTime < minSpeechSeconds) {
          // No onSpeechEnd should have been emitted
          expect(speechEndCalls).toHaveLength(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.5, 1.7**
   *
   * Test 3: onSpeechEnd IS emitted once both suppression conditions are satisfied.
   * This is the positive counterpart — when elapsed time >= suppressionSeconds AND
   * speech time >= minSpeechSeconds AND silence >= silenceThresholdSeconds, exactly
   * one onSpeechEnd should be emitted. This confirms the suppression rules are
   * necessary AND sufficient.
   */
  it("emits onSpeechEnd when both suppression conditions are satisfied", () => {
    const SPEECH_AMPLITUDE = 1000;
    const SILENCE_AMPLITUDE = 0;
    const SAMPLES_PER_CHUNK = 800;

    const arbitrarySatisfiedScenario = fc.record({
      suppressionSeconds: fc.integer({ min: 5, max: 10 }),
      minSpeechSeconds: fc.integer({ min: 1, max: 4 }),
      silenceThresholdSeconds: fc.integer({ min: 3, max: 6 }),
      // Extra speech chunks beyond the minimum required
      extraSpeechChunks: fc.integer({ min: 0, max: 20 }),
      // Extra silence chunks beyond the minimum required
      extraSilenceChunks: fc.integer({ min: 1, max: 20 }),
    });

    fc.assert(
      fc.property(arbitrarySatisfiedScenario, ({
        suppressionSeconds,
        minSpeechSeconds,
        silenceThresholdSeconds,
        extraSpeechChunks,
        extraSilenceChunks,
      }) => {
        const speechEndCalls: number[] = [];

        const config = makeConfig({
          suppressionSeconds,
          minSpeechSeconds,
          silenceThresholdSeconds,
          thresholdMultiplier: 0.15,
          silenceFactor: 0.15,
          noiseFloorBootstrapChunks: 40,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: (silenceDuration) => { speechEndCalls.push(silenceDuration); },
          onStatus: () => {},
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed enough speech to satisfy ALL conditions:
        // 1. elapsed time >= suppressionSeconds: totalChunks * 0.05 >= suppressionSeconds
        // 2. speech time >= minSpeechSeconds: speechChunks * 0.05 >= minSpeechSeconds
        // 3. bootstrap: totalChunks >= noiseFloorBootstrapChunks (40)
        // Since all chunks are speech, speechChunks == totalChunks
        const minChunksForSuppression = Math.ceil(suppressionSeconds / SECONDS_PER_CHUNK);
        const minChunksForSpeech = Math.ceil(minSpeechSeconds / SECONDS_PER_CHUNK);
        const minChunksForBootstrap = 40;
        const speechChunks = Math.max(
          minChunksForSuppression,
          minChunksForSpeech,
          minChunksForBootstrap,
        ) + extraSpeechChunks;

        for (let i = 0; i < speechChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // No emission yet (all speech, no silence)
        expect(speechEndCalls).toHaveLength(0);

        // Feed silence to trigger speech-end detection
        const minSilenceChunks = Math.ceil(silenceThresholdSeconds / SECONDS_PER_CHUNK) + 1;
        const totalSilenceChunks = minSilenceChunks + extraSilenceChunks;

        for (let i = 0; i < totalSilenceChunks; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SILENCE_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Exactly one onSpeechEnd should have been emitted
        expect(speechEndCalls).toHaveLength(1);
        expect(speechEndCalls[0]).toBeGreaterThanOrEqual(silenceThresholdSeconds);
      }),
      { numRuns: 200 }
    );
  });
});


// ─── VAD-P5: Adaptive threshold tracks median speech energy ─────────────────────

describe("Feature: phase-3-semi-automation, VAD-P5: Adaptive threshold tracks median speech energy", () => {
  /**
   * **Validates: Requirements 1.6**
   *
   * VAD-P5: Adaptive threshold tracks median speech energy
   *
   * For any set of speech-active RMS values observed by the VAD_Monitor, the
   * computed silence threshold SHALL equal `median(speechRmsValues) * silenceFactor`.
   * As new speech chunks are observed, the threshold SHALL update to reflect the
   * new median.
   *
   * Strategy: Feed a known sequence of high-amplitude speech chunks (all well above
   * the bootstrap threshold of 50) to establish a predictable speechRmsValues array.
   * After bootstrap is complete and enough speech data is collected, feed a probe
   * chunk and verify its classification matches the expected adaptive threshold
   * (median(speechRmsValues) * thresholdMultiplier).
   *
   * We use constant-amplitude chunks so that computeChunkRMS returns |amplitude|,
   * making the expected speechRmsValues array deterministic.
   */
  it("classifies probe chunk against adaptive threshold = median(speechRmsValues) * thresholdMultiplier", () => {
    const SAMPLES_PER_CHUNK = 800; // 50ms at 16kHz

    const arbitraryAdaptiveThresholdScenario = fc.record({
      // Speech amplitudes to feed — all above bootstrap threshold (50) to ensure
      // they are classified as speech during bootstrap AND after adaptive threshold kicks in.
      // We use amplitudes in [200, 20000] to stay well above any reasonable adaptive threshold.
      speechAmplitudes: fc.array(
        fc.integer({ min: 200, max: 20000 }),
        { minLength: 50, maxLength: 200 }
      ),
      // The probe chunk amplitude — can be anything from 0 to 32767
      probeAmplitude: fc.integer({ min: 0, max: 32767 }),
      // The threshold multiplier (silenceFactor)
      thresholdMultiplier: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
      // Bootstrap chunk count (keep small for test efficiency)
      noiseFloorBootstrapChunks: fc.integer({ min: 10, max: 40 }),
    });

    fc.assert(
      fc.property(arbitraryAdaptiveThresholdScenario, ({
        speechAmplitudes,
        probeAmplitude,
        thresholdMultiplier,
        noiseFloorBootstrapChunks,
      }) => {
        // Ensure we have enough speech amplitudes to exit bootstrap AND have enough
        // speech data for the adaptive threshold to activate.
        // Need: speechAmplitudes.length >= noiseFloorBootstrapChunks
        if (speechAmplitudes.length < noiseFloorBootstrapChunks) return; // pre-condition filter

        let lastStatus: VADStatus | null = null;

        const config = makeConfig({
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks,
          statusIntervalMs: 0, // Emit on every chunk
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed all speech chunks. Since all amplitudes are >= 200 (well above
        // BOOTSTRAP_RMS_THRESHOLD=50), every chunk will be classified as speech
        // during bootstrap. After bootstrap, the adaptive threshold =
        // median(speechRmsValues) * thresholdMultiplier. With amplitudes in
        // [200, 20000] and thresholdMultiplier <= 0.5, the adaptive threshold
        // will be at most 10000, and all our amplitudes are >= 200, so they
        // will continue to be classified as speech.
        //
        // We verify this assumption: the adaptive threshold after all speech
        // chunks should be <= min(speechAmplitudes).
        const expectedSpeechRmsValues: number[] = [];

        for (const amp of speechAmplitudes) {
          const chunk = makeConstantAmplitudeChunk(amp, SAMPLES_PER_CHUNK);
          monitor.feedChunk(chunk);

          // Track what the monitor should have in its speechRmsValues
          expectedSpeechRmsValues.push(Math.abs(amp));
          if (expectedSpeechRmsValues.length > config.speechEnergyWindowChunks) {
            expectedSpeechRmsValues.shift();
          }
        }

        // Verify our assumption: adaptive threshold should be below all speech amplitudes
        const expectedMedian = computeMedian(expectedSpeechRmsValues);
        const expectedAdaptiveThreshold = expectedMedian * thresholdMultiplier;
        const minSpeechAmplitude = Math.min(...speechAmplitudes.map(a => Math.abs(a)));

        // If this assumption fails, the test scenario is invalid — skip it
        if (expectedAdaptiveThreshold >= minSpeechAmplitude) return;

        // Now feed the probe chunk and verify classification
        const probeChunk = makeConstantAmplitudeChunk(probeAmplitude, SAMPLES_PER_CHUNK);
        monitor.feedChunk(probeChunk);

        const probeRMS = Math.abs(probeAmplitude);
        const expectedIsSpeech = probeRMS >= expectedAdaptiveThreshold;

        expect(lastStatus).not.toBeNull();
        expect(lastStatus!.isSpeech).toBe(expectedIsSpeech);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.6**
   *
   * The adaptive threshold updates as new speech data arrives. After feeding
   * an initial batch of speech chunks, the threshold reflects their median.
   * After feeding additional speech chunks with different amplitudes, the
   * threshold updates to reflect the new median of the combined set.
   *
   * Strategy: Feed two batches of speech chunks with distinct amplitude ranges.
   * After each batch, probe with a carefully chosen amplitude that would be
   * classified differently depending on which batch's median is used. This
   * verifies the threshold truly tracks the evolving median.
   */
  it("threshold updates as new speech chunks are observed", () => {
    const SAMPLES_PER_CHUNK = 800;

    const arbitraryThresholdUpdateScenario = fc.record({
      // First batch: lower amplitudes (e.g., 200-500)
      batch1Count: fc.integer({ min: 45, max: 80 }),
      batch1Amplitude: fc.integer({ min: 200, max: 500 }),
      // Second batch: higher amplitudes (e.g., 2000-5000)
      // batch2Count is generated relative to batch1Count to ensure it outnumbers batch1
      // so the median shifts to batch2Amplitude
      batch2Extra: fc.integer({ min: 5, max: 40 }),
      batch2Amplitude: fc.integer({ min: 2000, max: 5000 }),
      // Threshold multiplier
      thresholdMultiplier: fc.double({ min: 0.1, max: 0.3, noNaN: true }),
    });

    fc.assert(
      fc.property(arbitraryThresholdUpdateScenario, ({
        batch1Count,
        batch1Amplitude,
        batch2Extra,
        batch2Amplitude,
        thresholdMultiplier,
      }) => {
        // batch2Count must be larger than batch1Count + 1 (the +1 accounts for the
        // probe chunk fed after batch1) so that the median shifts to batch2Amplitude.
        const batch2Count = batch1Count + 1 + batch2Extra;

        let lastStatus: VADStatus | null = null;

        const noiseFloorBootstrapChunks = 40;

        const config = makeConfig({
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: 6000,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed batch 1: all same amplitude (constant)
        for (let i = 0; i < batch1Count; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(batch1Amplitude, SAMPLES_PER_CHUNK));
        }

        // After batch 1, the adaptive threshold should be:
        // median([batch1Amplitude repeated batch1Count times]) * thresholdMultiplier
        // = batch1Amplitude * thresholdMultiplier
        const threshold1 = batch1Amplitude * thresholdMultiplier;

        // Probe with an amplitude that is above threshold1
        // Use batch1Amplitude itself (which is definitely above threshold1 since thresholdMultiplier < 1)
        const probe1Chunk = makeConstantAmplitudeChunk(batch1Amplitude, SAMPLES_PER_CHUNK);
        monitor.feedChunk(probe1Chunk);
        expect(lastStatus).not.toBeNull();
        expect(lastStatus!.isSpeech).toBe(true); // batch1Amplitude >= threshold1

        // Feed batch 2: higher amplitudes. Since batch2Count > batch1Count + 1,
        // the majority of values in speechRmsValues will be batch2Amplitude,
        // shifting the median upward.
        for (let i = 0; i < batch2Count; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(batch2Amplitude, SAMPLES_PER_CHUNK));
        }

        // After batch 2, speechRmsValues contains batch1Count+1 entries of batch1Amplitude
        // and batch2Count entries of batch2Amplitude. Since batch2Count > batch1Count+1,
        // the median is batch2Amplitude.
        const allValues: number[] = [];
        for (let i = 0; i < batch1Count + 1; i++) allValues.push(batch1Amplitude); // +1 for probe1
        for (let i = 0; i < batch2Count; i++) allValues.push(batch2Amplitude);

        const newMedian = computeMedian(allValues);
        const threshold2 = newMedian * thresholdMultiplier;

        // Verify the threshold has increased (batch2 outnumbers batch1, so median = batch2Amplitude)
        expect(threshold2).toBeGreaterThan(threshold1);

        // Probe with an amplitude between threshold1 and threshold2 to demonstrate
        // the threshold has truly shifted — this amplitude would have been speech
        // under the old threshold but is silence under the new one.
        const probeBetween = Math.floor((threshold1 + threshold2) / 2);
        if (probeBetween > threshold1 && probeBetween < threshold2 && probeBetween > 0) {
          const probeChunk = makeConstantAmplitudeChunk(probeBetween, SAMPLES_PER_CHUNK);
          monitor.feedChunk(probeChunk);

          // This amplitude is below the new adaptive threshold, so it should be silence
          expect(lastStatus!.isSpeech).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.6**
   *
   * The adaptive threshold respects the sliding window cap (speechEnergyWindowChunks).
   * When more than speechEnergyWindowChunks speech chunks are observed, older values
   * are dropped from the window, and the median (and thus threshold) reflects only
   * the most recent values.
   *
   * Strategy: Feed speechEnergyWindowChunks chunks at one amplitude, then feed
   * speechEnergyWindowChunks more chunks at a different amplitude. After the second
   * batch, the window should contain only the second batch's values, so the threshold
   * should reflect the second batch's median.
   */
  it("sliding window drops old values and threshold reflects recent speech energy", () => {
    const SAMPLES_PER_CHUNK = 800;

    const arbitrarySlidingWindowScenario = fc.record({
      // Use a small window for test efficiency
      windowSize: fc.integer({ min: 50, max: 100 }),
      // First batch amplitude
      batch1Amplitude: fc.integer({ min: 200, max: 1000 }),
      // Second batch amplitude (significantly different)
      batch2Amplitude: fc.integer({ min: 3000, max: 10000 }),
      // Threshold multiplier
      thresholdMultiplier: fc.double({ min: 0.1, max: 0.3, noNaN: true }),
    });

    fc.assert(
      fc.property(arbitrarySlidingWindowScenario, ({
        windowSize,
        batch1Amplitude,
        batch2Amplitude,
        thresholdMultiplier,
      }) => {
        let lastStatus: VADStatus | null = null;

        const noiseFloorBootstrapChunks = 40;

        const config = makeConfig({
          thresholdMultiplier,
          silenceFactor: thresholdMultiplier,
          noiseFloorBootstrapChunks,
          statusIntervalMs: 0,
          speechEnergyWindowChunks: windowSize,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: (status) => { lastStatus = status; },
        };

        const monitor = new VADMonitor(config, callbacks);

        // Feed batch 1: fill the entire window with batch1Amplitude
        for (let i = 0; i < windowSize; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(batch1Amplitude, SAMPLES_PER_CHUNK));
        }

        // After batch 1, threshold = batch1Amplitude * thresholdMultiplier
        // Verify with a probe
        const threshold1 = batch1Amplitude * thresholdMultiplier;
        const probe1Chunk = makeConstantAmplitudeChunk(batch1Amplitude, SAMPLES_PER_CHUNK);
        monitor.feedChunk(probe1Chunk);
        expect(lastStatus).not.toBeNull();
        expect(lastStatus!.isSpeech).toBe(true);

        // Feed batch 2: fill the entire window with batch2Amplitude
        // This should push out all batch1 values from the sliding window
        for (let i = 0; i < windowSize; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(batch2Amplitude, SAMPLES_PER_CHUNK));
        }

        // After batch 2, the window should contain only batch2Amplitude values
        // (the batch1 values and the probe1 have been pushed out).
        // Threshold = batch2Amplitude * thresholdMultiplier
        const threshold2 = batch2Amplitude * thresholdMultiplier;

        // Verify the threshold has increased significantly
        expect(threshold2).toBeGreaterThan(threshold1);

        // Probe with batch1Amplitude — it should now be classified as silence
        // because batch1Amplitude < threshold2 (since batch2Amplitude >> batch1Amplitude
        // and thresholdMultiplier >= 0.1, threshold2 >= 300 while batch1Amplitude <= 1000)
        // Actually, we need to check: batch1Amplitude < batch2Amplitude * thresholdMultiplier?
        // batch1Amplitude <= 1000, batch2Amplitude >= 3000, thresholdMultiplier >= 0.1
        // threshold2 >= 300. batch1Amplitude could be >= 300.
        // So we need to verify the condition before asserting.
        if (batch1Amplitude < threshold2) {
          const probeChunk = makeConstantAmplitudeChunk(batch1Amplitude, SAMPLES_PER_CHUNK);
          monitor.feedChunk(probeChunk);
          expect(lastStatus!.isSpeech).toBe(false);
        }

        // Also verify: a probe at batch2Amplitude is still speech
        const probe2Chunk = makeConstantAmplitudeChunk(batch2Amplitude, SAMPLES_PER_CHUNK);
        monitor.feedChunk(probe2Chunk);
        expect(lastStatus!.isSpeech).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});


// ─── VAD-P6: VAD status messages throttled to configured interval ───────────────

describe("Feature: phase-3-semi-automation, VAD-P6: VAD status messages throttled to configured interval", () => {
  /**
   * **Validates: Requirements 10.2**
   *
   * VAD-P6: VAD status messages throttled to configured interval
   *
   * For any sequence of N audio chunks fed to the VAD_Monitor within a time window
   * of T milliseconds, the number of `onStatus` callbacks emitted SHALL be at most
   * `ceil(T / statusIntervalMs) + 1`. The +1 accounts for the first emission at
   * time 0 (when no time has elapsed yet, the first chunk always triggers a status
   * since lastStatusEmitTime starts at 0 and Date.now() - 0 >= statusIntervalMs
   * when statusIntervalMs > 0 and Date.now() is sufficiently large, OR when
   * statusIntervalMs is 0).
   *
   * Strategy: Use vi.useFakeTimers() to control Date.now(). Feed multiple chunks
   * at controlled wall-clock times and verify the status emission count respects
   * the throttle interval.
   */
  it("emits at most ceil(T / statusIntervalMs) + 1 status messages over T milliseconds", () => {
    const SAMPLES_PER_CHUNK = 800;
    const SPEECH_AMPLITUDE = 1000;

    const arbitraryThrottleScenario = fc.record({
      // Status interval in ms (the throttle period)
      statusIntervalMs: fc.integer({ min: 50, max: 1000 }),
      // Number of time steps to simulate (each step advances the clock by a random amount)
      timeStepCount: fc.integer({ min: 2, max: 20 }),
      // Chunks to feed per time step
      chunksPerStep: fc.integer({ min: 1, max: 10 }),
      // Time advance per step in ms (can be less than or greater than statusIntervalMs)
      timeAdvancePerStepMs: fc.integer({ min: 1, max: 500 }),
    });

    fc.assert(
      fc.property(arbitraryThrottleScenario, ({
        statusIntervalMs,
        timeStepCount,
        chunksPerStep,
        timeAdvancePerStepMs,
      }) => {
        // Use fake timers to control Date.now()
        vi.useFakeTimers();
        try {
          // Start at a known time
          const startTime = 1000000; // arbitrary start time in ms
          vi.setSystemTime(startTime);

          let statusCount = 0;

          const config = makeConfig({
            statusIntervalMs,
            noiseFloorBootstrapChunks: 40,
          });

          const callbacks: VADEventCallback = {
            onSpeechEnd: () => {},
            onStatus: () => { statusCount++; },
          };

          const monitor = new VADMonitor(config, callbacks);

          // Feed chunks across multiple time steps
          let currentTime = startTime;

          for (let step = 0; step < timeStepCount; step++) {
            // Feed multiple chunks at the current wall-clock time
            for (let c = 0; c < chunksPerStep; c++) {
              monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
            }

            // Advance the clock
            currentTime += timeAdvancePerStepMs;
            vi.setSystemTime(currentTime);
          }

          // Total wall-clock time elapsed
          const totalElapsedMs = currentTime - startTime;

          // The maximum number of status emissions allowed:
          // At most ceil(totalElapsedMs / statusIntervalMs) + 1
          // The +1 accounts for the first emission at time 0 (or the initial emission
          // before any time has elapsed).
          const maxExpectedStatuses = Math.ceil(totalElapsedMs / statusIntervalMs) + 1;

          expect(statusCount).toBeLessThanOrEqual(maxExpectedStatuses);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 10.2**
   *
   * When multiple chunks are fed at the exact same wall-clock instant (no time
   * advance), at most 1 status message should be emitted (since the time delta
   * is 0 and 0 >= statusIntervalMs is only true when statusIntervalMs is 0).
   *
   * For statusIntervalMs > 0: after the first emission, subsequent chunks at the
   * same instant should NOT trigger additional status emissions because
   * Date.now() - lastStatusEmitTime < statusIntervalMs.
   */
  it("emits at most 1 status when all chunks are fed at the same wall-clock instant", () => {
    const SAMPLES_PER_CHUNK = 800;
    const SPEECH_AMPLITUDE = 1000;

    const arbitrarySameInstantScenario = fc.record({
      // Status interval > 0 to test throttling (statusIntervalMs=0 would emit every chunk)
      statusIntervalMs: fc.integer({ min: 1, max: 1000 }),
      // Number of chunks to feed at the same instant
      chunkCount: fc.integer({ min: 2, max: 100 }),
    });

    fc.assert(
      fc.property(arbitrarySameInstantScenario, ({
        statusIntervalMs,
        chunkCount,
      }) => {
        vi.useFakeTimers();
        try {
          const startTime = 1000000;
          vi.setSystemTime(startTime);

          let statusCount = 0;

          const config = makeConfig({
            statusIntervalMs,
            noiseFloorBootstrapChunks: 40,
          });

          const callbacks: VADEventCallback = {
            onSpeechEnd: () => {},
            onStatus: () => { statusCount++; },
          };

          const monitor = new VADMonitor(config, callbacks);

          // Feed all chunks at the same wall-clock instant
          for (let i = 0; i < chunkCount; i++) {
            monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
          }

          // With statusIntervalMs > 0, the first chunk triggers a status
          // (since Date.now() - 0 >= statusIntervalMs when startTime is large).
          // Subsequent chunks at the same instant: Date.now() - lastStatusEmitTime = 0 < statusIntervalMs.
          // So at most 1 status should be emitted.
          expect(statusCount).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 10.2**
   *
   * When statusIntervalMs is 0, every chunk should produce a status emission
   * (no throttling). This is the degenerate case used by other tests.
   */
  it("emits a status for every chunk when statusIntervalMs is 0", () => {
    const SAMPLES_PER_CHUNK = 800;
    const SPEECH_AMPLITUDE = 1000;

    const arbitraryNoThrottleScenario = fc.record({
      chunkCount: fc.integer({ min: 1, max: 100 }),
    });

    fc.assert(
      fc.property(arbitraryNoThrottleScenario, ({
        chunkCount,
      }) => {
        let statusCount = 0;

        const config = makeConfig({
          statusIntervalMs: 0, // No throttling
          noiseFloorBootstrapChunks: 40,
        });

        const callbacks: VADEventCallback = {
          onSpeechEnd: () => {},
          onStatus: () => { statusCount++; },
        };

        const monitor = new VADMonitor(config, callbacks);

        for (let i = 0; i < chunkCount; i++) {
          monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
        }

        // Every chunk should produce a status when statusIntervalMs is 0
        expect(statusCount).toBe(chunkCount);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 10.2**
   *
   * When the clock advances by exactly statusIntervalMs between each chunk,
   * every chunk should produce a status emission (one per interval boundary).
   */
  it("emits a status for each chunk when clock advances by exactly statusIntervalMs between chunks", () => {
    const SAMPLES_PER_CHUNK = 800;
    const SPEECH_AMPLITUDE = 1000;

    const arbitraryExactIntervalScenario = fc.record({
      statusIntervalMs: fc.integer({ min: 50, max: 500 }),
      chunkCount: fc.integer({ min: 2, max: 50 }),
    });

    fc.assert(
      fc.property(arbitraryExactIntervalScenario, ({
        statusIntervalMs,
        chunkCount,
      }) => {
        vi.useFakeTimers();
        try {
          const startTime = 1000000;
          vi.setSystemTime(startTime);

          let statusCount = 0;

          const config = makeConfig({
            statusIntervalMs,
            noiseFloorBootstrapChunks: 40,
          });

          const callbacks: VADEventCallback = {
            onSpeechEnd: () => {},
            onStatus: () => { statusCount++; },
          };

          const monitor = new VADMonitor(config, callbacks);

          // Feed one chunk, then advance clock by exactly statusIntervalMs, repeat
          for (let i = 0; i < chunkCount; i++) {
            monitor.feedChunk(makeConstantAmplitudeChunk(SPEECH_AMPLITUDE, SAMPLES_PER_CHUNK));
            vi.setSystemTime(startTime + (i + 1) * statusIntervalMs);
          }

          // Each chunk should produce a status since the clock advances by
          // exactly statusIntervalMs between each feed
          expect(statusCount).toBe(chunkCount);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 200 }
    );
  });
});
