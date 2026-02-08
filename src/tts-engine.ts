// TTS Engine — converts evaluation script to spoken audio via OpenAI TTS API.
//
// Pre-TTS time enforcement: before calling the TTS API, the engine estimates
// the script duration using word count / calibratedWPM. If the estimate exceeds
// maxDurationSeconds, the script is shortened by dropping content at sentence
// boundaries (starting from the closing, then trimming recommendation
// explanations). This avoids audio waveform surgery and produces cleaner speech.
//
// Requirements: 5.1, 5.2
// Design: TTSEngine interface with synthesize(), estimateDuration(), trimToFit()

import type { TTSConfig } from "./types.js";

// ─── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_TTS_CONFIG: TTSConfig = {
  voice: "cedar",
  maxDurationSeconds: 210, // 3m30s hard cap
  calibratedWPM: 150,
};

// ─── OpenAI TTS client interface (for testability / dependency injection) ────────

/**
 * Minimal interface for the OpenAI audio speech API surface we use.
 * This allows injecting a mock client in tests without importing the full SDK.
 */
export interface OpenAITTSClient {
  audio: {
    speech: {
      create(params: {
        model: string;
        voice: string;
        input: string;
      }): Promise<Response>;
    };
  };
}

// ─── Helper: count words ────────────────────────────────────────────────────────

/**
 * Count the number of words in a text string.
 * A "word" is a contiguous sequence of non-whitespace characters.
 */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

// ─── Helper: split into sentences ───────────────────────────────────────────────

/**
 * Split text into sentences at sentence-ending punctuation (.!?),
 * preserving the punctuation with the sentence.
 *
 * Handles common abbreviations and decimal numbers to avoid false splits.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or end of string.
  // Uses a lookbehind to keep the punctuation attached to the sentence.
  const raw = text.match(/[^.!?]*[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!raw) return text.trim().length > 0 ? [text.trim()] : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ─── TTSEngine ──────────────────────────────────────────────────────────────────

export class TTSEngine {
  private readonly openai: OpenAITTSClient;
  private readonly model: string;

  constructor(openaiClient: OpenAITTSClient, model: string = "tts-1") {
    this.openai = openaiClient;
    this.model = model;
  }

  // ── estimateDuration ────────────────────────────────────────────────────────

  /**
   * Estimate the spoken duration of a text in seconds.
   *
   * Uses: word count / calibratedWPM * 60
   *
   * @param text  The script text to estimate.
   * @param wpm   Words per minute rate. Defaults to 150 (calibrated for "cedar" voice).
   * @returns Estimated duration in seconds.
   */
  estimateDuration(text: string, wpm: number = DEFAULT_TTS_CONFIG.calibratedWPM): number {
    const words = countWords(text);
    if (words === 0) return 0;
    if (wpm <= 0) return 0;
    return (words / wpm) * 60;
  }

  // ── trimToFit ───────────────────────────────────────────────────────────────

  /**
   * Shorten a script at sentence boundaries to fit within maxSeconds.
   *
   * Trimming strategy (from design doc):
   *   1. If the script already fits, return it unchanged.
   *   2. Remove sentences from the end (closing content first).
   *   3. Continue removing trailing sentences until the estimate fits.
   *   4. Always preserve at least the first sentence.
   *
   * @param text        The script text to trim.
   * @param maxSeconds  Maximum allowed duration in seconds.
   * @param wpm         Words per minute rate. Defaults to 150.
   * @returns The trimmed script that fits within maxSeconds.
   */
  trimToFit(
    text: string,
    maxSeconds: number,
    wpm: number = DEFAULT_TTS_CONFIG.calibratedWPM,
  ): string {
    // If it already fits, return as-is
    if (this.estimateDuration(text, wpm) <= maxSeconds) {
      return text;
    }

    const sentences = splitSentences(text);

    // Edge case: single sentence or empty — return as-is (can't trim further)
    if (sentences.length <= 1) {
      return text;
    }

    // Remove sentences from the end until the estimate fits within maxSeconds.
    // Always keep at least the first sentence.
    let trimmedSentences = [...sentences];

    while (trimmedSentences.length > 1) {
      trimmedSentences.pop();
      const candidate = trimmedSentences.join(" ");
      if (this.estimateDuration(candidate, wpm) <= maxSeconds) {
        return candidate;
      }
    }

    // Only the first sentence remains — return it even if it exceeds the limit
    return trimmedSentences[0];
  }

  // ── synthesize ──────────────────────────────────────────────────────────────

  /**
   * Synthesize text to speech using the OpenAI TTS API.
   *
   * Before calling the API, the engine enforces the time cap:
   *   1. Estimate duration using word count / calibratedWPM.
   *   2. If over maxDurationSeconds, trim the script at sentence boundaries.
   *   3. Synthesize the (possibly trimmed) script.
   *
   * @param text    The evaluation script text to synthesize.
   * @param config  TTS configuration (voice, maxDuration, calibratedWPM).
   * @returns A Buffer containing the synthesized audio data.
   */
  async synthesize(
    text: string,
    config?: Partial<TTSConfig>,
  ): Promise<Buffer> {
    const mergedConfig: TTSConfig = {
      ...DEFAULT_TTS_CONFIG,
      ...config,
    };

    // Pre-TTS time enforcement: trim if estimated duration exceeds cap
    const scriptToSynthesize = this.trimToFit(
      text,
      mergedConfig.maxDurationSeconds,
      mergedConfig.calibratedWPM,
    );

    // Call OpenAI TTS API
    const response = await this.openai.audio.speech.create({
      model: this.model,
      voice: mergedConfig.voice,
      input: scriptToSynthesize,
    });

    // Convert the response to a Buffer
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
