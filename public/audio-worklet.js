/**
 * AudioWorklet processor for the AI Toastmasters Evaluator.
 *
 * Responsibilities:
 * 1. Downsample from the browser's native sample rate (e.g. 48 kHz) to 16 kHz
 *    using a simple low-pass FIR filter before decimation.
 * 2. Convert Float32 samples (Web Audio API range [-1, 1]) to Int16 with clipping.
 * 3. Buffer output samples and emit 50 ms chunks (800 samples at 16 kHz).
 *
 * Audio Format Contract (from design.md):
 *   - Channels: Mono (1 channel)
 *   - Encoding: 16-bit linear PCM (LINEAR16)
 *   - Sample Rate: 16,000 Hz
 *   - Chunk duration: 50 ms → 800 samples → 1,600 bytes
 */

// ─── Low-Pass FIR Filter Coefficients ───────────────────────────────────────────
// Simple 7-tap low-pass FIR filter for anti-aliasing before decimation.
// Designed for ~5.5 kHz cutoff at 48 kHz (Nyquist for 16 kHz target is 8 kHz).
// Symmetric coefficients, normalized to sum ≈ 1.
const FIR_COEFFICIENTS = [0.05, 0.1, 0.2, 0.3, 0.2, 0.1, 0.05];
const FIR_LENGTH = FIR_COEFFICIENTS.length;

/** Target output sample rate */
const TARGET_SAMPLE_RATE = 16000;

/** Samples per output chunk (50 ms at 16 kHz) */
const CHUNK_SAMPLES = 800;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // The native sample rate is available via the global `sampleRate` in AudioWorkletGlobalScope
    this._nativeSampleRate = sampleRate;
    this._ratio = this._nativeSampleRate / TARGET_SAMPLE_RATE;

    // Ring buffer for FIR filter history (holds the last FIR_LENGTH - 1 input samples)
    this._filterHistory = new Float32Array(FIR_LENGTH);
    this._filterHistoryIndex = 0;

    // Fractional resampling position (for non-integer ratios)
    this._resampleOffset = 0;

    // Output buffer accumulating Int16 samples until we have a full chunk
    this._outputBuffer = new Int16Array(CHUNK_SAMPLES);
    this._outputBufferIndex = 0;

    // Flag to stop processing when told to
    this._active = true;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") {
        this._active = false;
      }
    };
  }

  /**
   * Apply the FIR low-pass filter to a single input sample.
   * Maintains a circular buffer of recent samples.
   *
   * @param {number} sample - Input Float32 sample
   * @returns {number} Filtered sample
   */
  _applyFilter(sample) {
    // Write sample into circular buffer
    this._filterHistory[this._filterHistoryIndex] = sample;
    this._filterHistoryIndex = (this._filterHistoryIndex + 1) % FIR_LENGTH;

    // Convolve with FIR coefficients
    let result = 0;
    for (let i = 0; i < FIR_LENGTH; i++) {
      const histIdx = (this._filterHistoryIndex + i) % FIR_LENGTH;
      result += this._filterHistory[histIdx] * FIR_COEFFICIENTS[i];
    }
    return result;
  }

  /**
   * Convert a Float32 sample [-1, 1] to Int16 with clipping.
   *
   * @param {number} sample - Float32 sample
   * @returns {number} Int16 sample
   */
  _float32ToInt16(sample) {
    // Clamp to [-1, 1]
    const clamped = Math.max(-1, Math.min(1, sample));
    // Scale to Int16 range. Use 0x7FFF (32767) for positive, 0x8000 (32768) for negative.
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }

  /**
   * Process incoming audio data.
   * Called by the Web Audio API with 128-sample blocks at the native sample rate.
   *
   * @param {Float32Array[][]} inputs - Input audio data (we use channel 0 of input 0)
   * @param {Float32Array[][]} outputs - Not used (we don't produce output audio)
   * @param {Object} parameters - Not used
   * @returns {boolean} true to keep the processor alive
   */
  process(inputs, outputs, parameters) {
    if (!this._active) {
      return false; // Stop the processor
    }

    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true; // No input data, keep alive
    }

    // Take mono channel (channel 0)
    const inputData = input[0];
    const ratio = this._ratio;

    // Process each input sample through the filter, then downsample
    for (let i = 0; i < inputData.length; i++) {
      // Apply low-pass filter to every input sample
      const filtered = this._applyFilter(inputData[i]);

      // Check if this sample position aligns with our output sample rate
      this._resampleOffset += 1;
      if (this._resampleOffset >= ratio) {
        this._resampleOffset -= ratio;

        // Convert filtered Float32 to Int16 and add to output buffer
        const int16Sample = this._float32ToInt16(filtered);
        this._outputBuffer[this._outputBufferIndex] = int16Sample;
        this._outputBufferIndex += 1;

        // When we have a full 50ms chunk, send it to the main thread
        if (this._outputBufferIndex >= CHUNK_SAMPLES) {
          // Copy the buffer and send it (transferable for zero-copy)
          const chunk = new Int16Array(this._outputBuffer);
          this.port.postMessage({ type: "audio_chunk", samples: chunk.buffer }, [chunk.buffer]);

          // Reset output buffer (need a new one since we transferred ownership)
          this._outputBuffer = new Int16Array(CHUNK_SAMPLES);
          this._outputBufferIndex = 0;
        }
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
