/**
 * Frame sampler that selects frames at a configured rate.
 * Accepts the first frame in each sampling interval and skips the rest.
 *
 * Validates: Requirements 2.3, 2.9, 15.5
 */

export class FrameSampler {
  private intervalSeconds: number; // 1 / frameRate
  private lastSampledTimestamp: number;

  constructor(frameRate: number) {
    this.intervalSeconds = 1 / frameRate;
    this.lastSampledTimestamp = -Infinity;
  }

  /**
   * Returns true if this frame should be processed.
   * The first frame is always sampled (lastSampledTimestamp starts at -Infinity).
   * Subsequent frames are sampled when enough time has elapsed since the last sample.
   */
  shouldSample(timestamp: number): boolean {
    if (timestamp - this.lastSampledTimestamp >= this.intervalSeconds) {
      this.lastSampledTimestamp = timestamp;
      return true;
    }
    return false;
  }

  /** Reset state for a new recording. */
  reset(): void {
    this.lastSampledTimestamp = -Infinity;
  }

  /** Change the sampling rate at runtime (for adaptive sampling). */
  setRate(newRate: number): void {
    this.intervalSeconds = 1 / newRate;
  }
}
