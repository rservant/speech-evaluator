// ─── VAD Monitor (Phase 3 — Req 1, 2, 3, 10, 11) ──────────────────────────────
// Server-side Voice Activity Detection component that processes audio chunks
// in real time during recording to detect sustained silence.

/**
 * Configuration for the VAD monitor.
 * All time-based detection uses audio-time (chunk count × 0.05s), not wall-clock time.
 */
export interface VADConfig {
  /** Duration of continuous silence (in seconds) before emitting a speech-end suggestion. Default: 5 */
  silenceThresholdSeconds: number;
  /** Whether VAD monitoring is enabled. Default: true */
  enabled: boolean;
  /**
   * Fraction of median speech energy used as the silence threshold.
   * Retained as an alias for backward compatibility — prefer `thresholdMultiplier`.
   * Default: 0.15
   */
  silenceFactor: number;
  /** Minimum accumulated speech time (in seconds) before detection activates. Default: 3 */
  minSpeechSeconds: number;
  /** Suppress detection during the first N seconds of recording. Default: 10 */
  suppressionSeconds: number;
  /** Throttle interval for onStatus callbacks (in milliseconds, wall-clock). Default: 250 */
  statusIntervalMs: number;
  /** Sliding window cap for speech RMS values. Default: 6000 */
  speechEnergyWindowChunks: number;
  /**
   * Minimum chunks before adaptive threshold activates.
   * During bootstrap, a fixed conservative RMS threshold is used.
   * Default: 40 (2s of audio at 50ms/chunk)
   */
  noiseFloorBootstrapChunks: number;
  /**
   * Fraction of median speech energy used as the silence threshold.
   * This is the explicit named parameter; `silenceFactor` is an alias.
   * Default: 0.15
   */
  thresholdMultiplier: number;
}

/**
 * Real-time VAD status emitted to the client for audio level visualization.
 */
export interface VADStatus {
  /** Current RMS energy normalized to 0..1 */
  energy: number;
  /** True if the current chunk is classified as speech (above silence threshold) */
  isSpeech: boolean;
}

/**
 * Callbacks for VAD events.
 */
export type VADEventCallback = {
  /** Called when sustained silence is detected after speech. */
  onSpeechEnd: (silenceDurationSeconds: number) => void;
  /** Called periodically with current audio energy status (throttled). */
  onStatus: (status: VADStatus) => void;
};

/** Fixed conservative RMS threshold used during the noise floor bootstrap period */
const BOOTSTRAP_RMS_THRESHOLD = 50;

/** Seconds per audio chunk (50ms at 16kHz mono) */
const SECONDS_PER_CHUNK = 0.05;

/** Minimum floor for energy normalization to prevent wild swings during early recording */
const ENERGY_NORMALIZATION_FLOOR = 100;

/**
 * Compute the RMS (Root Mean Square) energy of a 16-bit PCM audio chunk.
 * Same pattern as MetricsExtractor.computeEnergyProfile() but per-chunk.
 */
export function computeChunkRMS(chunk: Buffer): number {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Compute the median of a numeric array.
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
 * Server-side Voice Activity Detection monitor.
 *
 * Processes 16-bit PCM audio chunks in real time during recording to detect
 * sustained silence, emitting speech-end suggestions for operator confirmation.
 *
 * Key design decisions:
 * - Uses audio-time (chunk count × 0.05s) for silence detection and suppression, NOT wall-clock time
 * - Uses adaptive thresholding based on rolling median of speech-active RMS values
 * - During early recording (bootstrap period), uses a fixed conservative threshold
 * - Status throttling uses wall-clock time (rate-limiting, not correctness)
 */
export class VADMonitor {
  private config: VADConfig;
  private callbacks: VADEventCallback;

  // Rolling state
  private speechRmsValues: number[];
  private silenceStartChunk: number | null;
  private totalChunksProcessed: number;
  private speechChunksProcessed: number;
  private lastStatusEmitTime: number;
  private hasSuggestedForCurrentSilence: boolean;
  private stopped: boolean;
  private maxObservedRms: number;

  constructor(config: VADConfig, callbacks: VADEventCallback) {
    this.config = config;
    this.callbacks = callbacks;

    // Initialize rolling state
    this.speechRmsValues = [];
    this.silenceStartChunk = null;
    this.totalChunksProcessed = 0;
    this.speechChunksProcessed = 0;
    this.lastStatusEmitTime = 0;
    this.hasSuggestedForCurrentSilence = false;
    this.stopped = false;
    this.maxObservedRms = 0;
  }

  /**
   * Determine the effective silence threshold based on current state.
   *
   * During the bootstrap period (first `noiseFloorBootstrapChunks` chunks) or when
   * insufficient speech data is available, uses a fixed conservative threshold.
   * After bootstrap with sufficient speech data, uses the adaptive median-based threshold.
   */
  private getSilenceThreshold(): number {
    const isInBootstrap = this.totalChunksProcessed < this.config.noiseFloorBootstrapChunks;
    const hasEnoughSpeechData = this.speechRmsValues.length >= this.config.noiseFloorBootstrapChunks;

    if (isInBootstrap || !hasEnoughSpeechData) {
      // Use fixed conservative threshold during bootstrap or when insufficient speech data
      return BOOTSTRAP_RMS_THRESHOLD;
    }

    // Adaptive threshold: median of speech RMS values × thresholdMultiplier
    const medianSpeechRMS = computeMedian(this.speechRmsValues);
    return medianSpeechRMS * this.config.thresholdMultiplier;
  }

  /**
   * Process a single audio chunk (16-bit PCM, mono, 16kHz).
   * Returns immediately if the monitor is stopped.
   */
  feedChunk(chunk: Buffer): void {
    if (this.stopped) return;

    const chunkRMS = computeChunkRMS(chunk);

    // Track max observed RMS for energy normalization
    if (chunkRMS > this.maxObservedRms) {
      this.maxObservedRms = chunkRMS;
    }

    // Determine silence threshold and classify chunk
    const silenceThreshold = this.getSilenceThreshold();
    const isSpeech = chunkRMS >= silenceThreshold;

    // Update speech tracking
    if (isSpeech) {
      this.speechChunksProcessed++;

      // Add to sliding window of speech RMS values (capped)
      this.speechRmsValues.push(chunkRMS);
      if (this.speechRmsValues.length > this.config.speechEnergyWindowChunks) {
        this.speechRmsValues.shift();
      }
    }

    // Silence episode tracking (audio-time based)
    if (isSpeech) {
      // Speech resumed — reset silence episode tracking
      this.silenceStartChunk = null;
      this.hasSuggestedForCurrentSilence = false;
    } else {
      // Silence chunk
      if (this.silenceStartChunk === null) {
        // Transition from speech to silence: record start chunk
        this.silenceStartChunk = this.totalChunksProcessed;
      }

      // Check if we should emit a speech-end suggestion
      const silenceDuration = (this.totalChunksProcessed - this.silenceStartChunk) * SECONDS_PER_CHUNK;
      const recordingElapsedTime = this.totalChunksProcessed * SECONDS_PER_CHUNK;
      const speechAccumulatedTime = this.speechChunksProcessed * SECONDS_PER_CHUNK;

      if (
        silenceDuration >= this.config.silenceThresholdSeconds &&
        !this.hasSuggestedForCurrentSilence &&
        recordingElapsedTime >= this.config.suppressionSeconds &&
        speechAccumulatedTime >= this.config.minSpeechSeconds
      ) {
        this.hasSuggestedForCurrentSilence = true;
        this.callbacks.onSpeechEnd(silenceDuration);
      }
    }

    // Increment total chunks AFTER silence duration calculation
    // (so that the current chunk is included in the silence duration on the next iteration)
    this.totalChunksProcessed++;

    // Status throttling (wall-clock time — rate-limiting, not correctness)
    const now = Date.now();
    if (now - this.lastStatusEmitTime >= this.config.statusIntervalMs) {
      this.lastStatusEmitTime = now;

      // Normalize energy to 0..1 using max(maxObservedRms, 100) floor
      const normalizationBase = Math.max(this.maxObservedRms, ENERGY_NORMALIZATION_FLOOR);
      const normalizedEnergy = Math.min(chunkRMS / normalizationBase, 1);

      this.callbacks.onStatus({
        energy: normalizedEnergy,
        isSpeech,
      });
    }
  }

  /**
   * Reset all rolling state. Re-arms the monitor (sets stopped = false).
   */
  reset(): void {
    this.speechRmsValues = [];
    this.silenceStartChunk = null;
    this.totalChunksProcessed = 0;
    this.speechChunksProcessed = 0;
    this.lastStatusEmitTime = 0;
    this.hasSuggestedForCurrentSilence = false;
    this.stopped = false;
    this.maxObservedRms = 0;
  }

  /**
   * Stop monitoring. Sets stopped = true; subsequent feedChunk() calls are no-ops.
   */
  stop(): void {
    this.stopped = true;
  }
}
