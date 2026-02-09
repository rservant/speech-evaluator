// AI Toastmasters Evaluator - Metrics Extractor
// Requirements: 3.1 (duration), 3.2 (WPM), 3.3 (filler words), 3.4 (pauses), 3.5 (JSON output), 3.6 (contextual filler detection)
// Phase 2: 5.1 (pause classification), 5.2 (intentional pauses), 5.3 (hesitation pauses)

import type {
  TranscriptSegment,
  DeliveryMetrics,
  FillerWordEntry,
  ClassifiedFillerEntry,
  ClassifiedPause,
  EnergyProfile,
} from "./types.js";

// ─── Known Filler Words ─────────────────────────────────────────────────────────

const KNOWN_FILLERS = new Set([
  "um",
  "uh",
  "ah",
  "like",
  "you know",
  "so",
  "basically",
  "right",
  "actually",
  "literally",
]);

// Single-word fillers that need contextual analysis
const CONTEXTUAL_FILLERS = new Set(["like", "so", "right", "actually"]);

// ─── Pause Classification Constants (Phase 2 — Req 5.1, 5.2, 5.3) ──────────────

// Known filler words used for hesitation detection in pause classification
const FILLER_WORDS_FOR_PAUSE = new Set([
  "um", "uh", "ah", "like", "so", "right", "actually", "basically", "literally", "honestly",
]);

// Sentence-ending punctuation characters
const SENTENCE_ENDING_PUNCT = /[.!?]$/;

// Common sentence-final words used in punctuation fallback heuristic
const COMMON_SENTENCE_FINAL_WORDS = new Set([
  "right", "so", "well", "yes", "no", "okay", "ok", "too", "now", "then",
  "here", "there", "today", "again", "together", "everyone", "all",
]);

// ─── Metrics Extractor ──────────────────────────────────────────────────────────

export class MetricsExtractor {
  private pauseThreshold: number; // reportable threshold (default 1.5s)
  private candidateThreshold: number; // candidate threshold (default 300ms)

  constructor(pauseThreshold: number = 1.5, candidateThreshold: number = 0.3) {
    this.pauseThreshold = pauseThreshold;
    this.candidateThreshold = candidateThreshold;
  }

  /**
   * Extract delivery metrics from finalized transcript segments.
   */
  extract(segments: TranscriptSegment[]): DeliveryMetrics {
    if (segments.length === 0) {
      return this.emptyMetrics();
    }

    // Duration: last segment endTime - first segment startTime
    const durationSeconds =
      segments[segments.length - 1].endTime - segments[0].startTime;

    const durationFormatted = this.formatDuration(durationSeconds);

    // Total words across all segments
    const totalWords = this.countTotalWords(segments);

    // WPM: totalWords / (durationSeconds / 60)
    const durationMinutes = durationSeconds / 60;
    const wordsPerMinute =
      durationMinutes > 0 ? totalWords / durationMinutes : 0;

    // Filler word detection with classification (Phase 2 — Req 5.9)
    const classifiedFillers = this.detectAndClassifyFillers(segments);

    // Backward compat: fillerWords contains only true fillers (same as Phase 1 behavior)
    const fillerWords: FillerWordEntry[] = classifiedFillers
      .filter((f) => f.classification === "true_filler")
      .map(({ word, count, timestamps }) => ({ word, count, timestamps }));
    const fillerWordCount = fillerWords.reduce((sum, f) => sum + f.count, 0);
    const fillerWordFrequency =
      durationMinutes > 0 ? fillerWordCount / durationMinutes : 0;

    // Pause detection with classification (Phase 2)
    const classifiedPauses = this.detectAndClassifyPauses(segments);
    const pauseCount = classifiedPauses.length;
    const totalPauseDurationSeconds = classifiedPauses.reduce(
      (sum, p) => sum + p.duration,
      0
    );
    const averagePauseDurationSeconds =
      pauseCount > 0 ? totalPauseDurationSeconds / pauseCount : 0;

    // Phase 2: Pause classification counts
    const intentionalPauseCount = classifiedPauses.filter(
      (p) => p.type === "intentional"
    ).length;
    const hesitationPauseCount = classifiedPauses.filter(
      (p) => p.type === "hesitation"
    ).length;

    return {
      durationSeconds,
      durationFormatted,
      totalWords,
      wordsPerMinute,
      fillerWords,
      fillerWordCount,
      fillerWordFrequency,
      pauseCount,
      totalPauseDurationSeconds,
      averagePauseDurationSeconds,
      // Phase 2 additions
      intentionalPauseCount,
      hesitationPauseCount,
      classifiedPauses,
      energyVariationCoefficient: 0,
      energyProfile: {
        windowDurationMs: 250,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      },
      classifiedFillers,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Compute speech energy profile from raw audio chunks.
   * Audio is raw PCM 16-bit signed little-endian mono at 16kHz.
   * Phase 2 — Requirements 5.5, 5.6, 5.7, 5.8, 5.11
   *
   * @param audioChunks - Array of raw PCM audio buffers
   * @param windowDurationMs - Window size in milliseconds (default 250ms)
   * @param sampleRate - Audio sample rate in Hz (default 16000)
   * @param silenceK - Multiplier for MAD in adaptive silence threshold (default 1.0)
   * @returns EnergyProfile with normalized RMS windows and coefficient of variation
   */
  computeEnergyProfile(
    audioChunks: Buffer[],
    windowDurationMs: number = 250,
    sampleRate: number = 16000,
    silenceK: number = 1.0
  ): EnergyProfile {
    // Concatenate all audio chunks into a single buffer
    const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);

    if (totalLength === 0) {
      return {
        windowDurationMs,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      };
    }

    const combined = Buffer.concat(audioChunks, totalLength);

    // Each sample is 2 bytes (Int16), so total samples = totalLength / 2
    const totalSamples = Math.floor(combined.length / 2);

    if (totalSamples === 0) {
      return {
        windowDurationMs,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      };
    }

    // Samples per window: sampleRate * windowDurationMs / 1000
    const samplesPerWindow = Math.floor((sampleRate * windowDurationMs) / 1000);

    if (samplesPerWindow === 0) {
      return {
        windowDurationMs,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      };
    }

    // Step 1: Segment into windows and compute RMS per window
    const windowCount = Math.ceil(totalSamples / samplesPerWindow);
    const rawRms: number[] = [];

    for (let w = 0; w < windowCount; w++) {
      const startSample = w * samplesPerWindow;
      const endSample = Math.min(startSample + samplesPerWindow, totalSamples);
      const count = endSample - startSample;

      let sumSquares = 0;
      for (let s = startSample; s < endSample; s++) {
        // Read 16-bit signed little-endian sample
        const sample = combined.readInt16LE(s * 2);
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / count);
      rawRms.push(rms);
    }

    // Step 2: Normalize by max RMS (gain invariance)
    const maxRms = Math.max(...rawRms);

    let normalizedWindows: number[];
    if (maxRms === 0) {
      // All-silence: all windows are 0
      normalizedWindows = rawRms.map(() => 0);
    } else {
      normalizedWindows = rawRms.map((rms) => rms / maxRms);
    }

    // Step 3: Compute adaptive silence threshold: median + k * MAD
    const silenceThreshold = this.computeSilenceThreshold(normalizedWindows, silenceK);

    // Step 4: Exclude silence windows (below threshold)
    const nonSilenceWindows = normalizedWindows.filter((v) => v >= silenceThreshold);

    // Step 5: Compute coefficient of variation on non-silence windows
    const coefficientOfVariation = this.computeCV(nonSilenceWindows);

    return {
      windowDurationMs,
      windows: normalizedWindows,
      coefficientOfVariation,
      silenceThreshold,
    };
  }

  /**
   * Compute adaptive silence threshold: median(values) + k * MAD(values)
   * where MAD = median(|values - median(values)|)
   */
  private computeSilenceThreshold(values: number[], k: number): number {
    if (values.length === 0) return 0;

    const median = this.computeMedian(values);
    const deviations = values.map((v) => Math.abs(v - median));
    const mad = this.computeMedian(deviations);

    return median + k * mad;
  }

  /**
   * Compute the median of an array of numbers.
   */
  private computeMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  /**
   * Compute coefficient of variation: stddev / mean.
   * Returns 0 for empty arrays or single-element arrays (stddev = 0).
   */
  private computeCV(values: number[]): number {
    if (values.length <= 1) return 0;

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (mean === 0) return 0;

    const variance =
      values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
    const stddev = Math.sqrt(variance);

    return stddev / mean;
  }

  // ─── Private Helpers (Filler & Pause) ───────────────────────────────────────

  private emptyMetrics(): DeliveryMetrics {
    return {
      durationSeconds: 0,
      durationFormatted: "0:00",
      totalWords: 0,
      wordsPerMinute: 0,
      fillerWords: [],
      fillerWordCount: 0,
      fillerWordFrequency: 0,
      pauseCount: 0,
      totalPauseDurationSeconds: 0,
      averagePauseDurationSeconds: 0,
      // Phase 2 additions
      intentionalPauseCount: 0,
      hesitationPauseCount: 0,
      classifiedPauses: [],
      energyVariationCoefficient: 0,
      energyProfile: {
        windowDurationMs: 250,
        windows: [],
        coefficientOfVariation: 0,
        silenceThreshold: 0,
      },
      classifiedFillers: [],
    };
  }

  private formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  private countTotalWords(segments: TranscriptSegment[]): number {
    return segments.reduce((total, segment) => {
      if (segment.words.length > 0) {
        return total + segment.words.length;
      }
      // Fallback: count words from text if no word-level data
      const words = segment.text
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      return total + words.length;
    }, 0);
  }

  /**
   * Detect filler words and classify each as true_filler or discourse_marker.
   * Phase 2 — Requirement 5.9
   *
   * - "um", "uh", "ah" → always true_filler
   * - "basically", "literally", "you know" → always true_filler
   * - Contextual words ("like", "so", "right", "actually") in filler position → true_filler
   * - Contextual words in non-filler position → discourse_marker
   */
  private detectAndClassifyFillers(
    segments: TranscriptSegment[]
  ): ClassifiedFillerEntry[] {
    const trueFillerMap = new Map<string, { count: number; timestamps: number[] }>();
    const discourseMarkerMap = new Map<string, { count: number; timestamps: number[] }>();

    for (const segment of segments) {
      if (segment.words.length > 0) {
        this.detectAndClassifyFillersFromWords(segment, trueFillerMap, discourseMarkerMap);
      } else {
        // Segment-level fallback: only non-contextual fillers detected (same as Phase 1)
        // Contextual words cannot be classified without word-level context
        this.detectFillersFromText(segment, trueFillerMap);
      }
    }

    const result: ClassifiedFillerEntry[] = [];

    for (const [word, data] of trueFillerMap.entries()) {
      result.push({
        word,
        count: data.count,
        timestamps: data.timestamps,
        classification: "true_filler",
      });
    }

    for (const [word, data] of discourseMarkerMap.entries()) {
      result.push({
        word,
        count: data.count,
        timestamps: data.timestamps,
        classification: "discourse_marker",
      });
    }

    return result;
  }

  /**
   * Word-level filler detection with classification.
   * Contextual words not in filler position are tracked as discourse markers.
   */
  private detectAndClassifyFillersFromWords(
    segment: TranscriptSegment,
    trueFillerMap: Map<string, { count: number; timestamps: number[] }>,
    discourseMarkerMap: Map<string, { count: number; timestamps: number[] }>
  ): void {
    const words = segment.words;

    for (let i = 0; i < words.length; i++) {
      const word = words[i].word.toLowerCase().replace(/[^a-z]/g, "");

      // Check two-word fillers first ("you know")
      if (i < words.length - 1) {
        const nextWord = words[i + 1].word.toLowerCase().replace(/[^a-z]/g, "");
        const twoWord = `${word} ${nextWord}`;
        if (KNOWN_FILLERS.has(twoWord)) {
          this.addFiller(trueFillerMap, twoWord, words[i].startTime);
          continue;
        }
      }

      // Check single-word fillers
      if (!KNOWN_FILLERS.has(word)) continue;

      // Contextual check for ambiguous fillers
      if (CONTEXTUAL_FILLERS.has(word)) {
        if (this.isFillerInContext(word, words, i)) {
          // Contextual word in filler position → true_filler
          this.addFiller(trueFillerMap, word, words[i].startTime);
        } else {
          // Contextual word NOT in filler position → discourse_marker
          this.addFiller(discourseMarkerMap, word, words[i].startTime);
        }
      } else {
        // Non-contextual fillers (um, uh, ah, basically, literally) always true_filler
        this.addFiller(trueFillerMap, word, words[i].startTime);
      }
    }
  }

  private detectFillerWords(
    segments: TranscriptSegment[]
  ): FillerWordEntry[] {
    const fillerMap = new Map<string, { count: number; timestamps: number[] }>();

    for (const segment of segments) {
      if (segment.words.length > 0) {
        // Word-level detection
        this.detectFillersFromWords(segment, fillerMap);
      } else {
        // Segment-level fallback
        this.detectFillersFromText(segment, fillerMap);
      }
    }

    return Array.from(fillerMap.entries()).map(([word, data]) => ({
      word,
      count: data.count,
      timestamps: data.timestamps,
    }));
  }

  private detectFillersFromWords(
    segment: TranscriptSegment,
    fillerMap: Map<string, { count: number; timestamps: number[] }>
  ): void {
    const words = segment.words;

    for (let i = 0; i < words.length; i++) {
      const word = words[i].word.toLowerCase().replace(/[^a-z]/g, "");

      // Check two-word fillers first ("you know")
      if (i < words.length - 1) {
        const nextWord = words[i + 1].word.toLowerCase().replace(/[^a-z]/g, "");
        const twoWord = `${word} ${nextWord}`;
        if (KNOWN_FILLERS.has(twoWord)) {
          this.addFiller(fillerMap, twoWord, words[i].startTime);
          continue;
        }
      }

      // Check single-word fillers
      if (!KNOWN_FILLERS.has(word)) continue;

      // Contextual check for ambiguous fillers
      if (CONTEXTUAL_FILLERS.has(word)) {
        if (this.isFillerInContext(word, words, i)) {
          this.addFiller(fillerMap, word, words[i].startTime);
        }
      } else {
        // Non-contextual fillers (um, uh, ah, basically, literally) always count
        this.addFiller(fillerMap, word, words[i].startTime);
      }
    }
  }

  private detectFillersFromText(
    segment: TranscriptSegment,
    fillerMap: Map<string, { count: number; timestamps: number[] }>
  ): void {
    const text = segment.text.toLowerCase();
    const words = text.split(/\s+/).filter((w) => w.length > 0);

    for (const word of words) {
      const cleaned = word.replace(/[^a-z]/g, "");
      if (KNOWN_FILLERS.has(cleaned) && !CONTEXTUAL_FILLERS.has(cleaned)) {
        this.addFiller(fillerMap, cleaned, segment.startTime);
      }
    }
  }

  private isFillerInContext(
    word: string,
    words: { word: string }[],
    index: number
  ): boolean {
    switch (word) {
      case "like": {
        // "like" is a filler when mid-sentence and not preceded by verbs that take "like" as complement
        // e.g., "I, like, went to the store" vs "I like pizza"
        if (index === 0) return false; // sentence-initial "like" is usually not filler
        const prevWord = words[index - 1].word
          .toLowerCase()
          .replace(/[^a-z]/g, "");
        const verbsTakingLike = new Set([
          "would",
          "do",
          "dont",
          "did",
          "didnt",
          "really",
          "i",
          "you",
          "we",
          "they",
          "looks",
          "look",
          "feel",
          "feels",
          "sound",
          "sounds",
          "seem",
          "seems",
        ]);
        return !verbsTakingLike.has(prevWord);
      }
      case "so": {
        // "so" is a filler when sentence-initial (first word in segment or after a pause)
        return index === 0;
      }
      case "right": {
        // "right" is a filler when used as a tag question or interjection at end of clause
        return index === words.length - 1 || index === 0;
      }
      case "actually": {
        // "actually" is often a filler when sentence-initial
        return index === 0;
      }
      default:
        return false;
    }
  }

  private addFiller(
    fillerMap: Map<string, { count: number; timestamps: number[] }>,
    word: string,
    timestamp: number
  ): void {
    const existing = fillerMap.get(word);
    if (existing) {
      existing.count++;
      existing.timestamps.push(timestamp);
    } else {
      fillerMap.set(word, { count: 1, timestamps: [timestamp] });
    }
  }

  /**
   * Detect all pause candidates (gaps ≥ candidateThreshold) and classify
   * reportable pauses (gaps ≥ reportableThreshold) as intentional or hesitation.
   * Phase 2 — Requirements 5.1, 5.2, 5.3
   */
  private detectAndClassifyPauses(
    segments: TranscriptSegment[]
  ): ClassifiedPause[] {
    // Step 1: Detect all pause candidates (gaps ≥ candidateThreshold)
    const candidates = this.detectPauseCandidates(segments);

    // Step 2: Filter to reportable pauses (gaps ≥ reportableThreshold)
    const reportable = candidates.filter(
      (p) => p.duration >= this.pauseThreshold
    );

    // Step 3: Build a flat word list for context lookup during classification
    const flatWords = this.buildFlatWordList(segments);

    // Step 4: Classify each reportable pause
    return reportable.map((pause) =>
      this.classifyPause(pause, flatWords)
    );
  }

  /**
   * Detect all pause candidates: gaps ≥ candidateThreshold (default 300ms).
   * Checks both intra-segment word gaps and inter-segment gaps.
   */
  private detectPauseCandidates(
    segments: TranscriptSegment[]
  ): { start: number; end: number; duration: number }[] {
    const pauses: { start: number; end: number; duration: number }[] = [];

    // Check for word-level gaps within segments
    for (const segment of segments) {
      if (segment.words.length > 1) {
        for (let i = 1; i < segment.words.length; i++) {
          const gap =
            segment.words[i].startTime - segment.words[i - 1].endTime;
          if (gap >= this.candidateThreshold) {
            pauses.push({
              start: segment.words[i - 1].endTime,
              end: segment.words[i].startTime,
              duration: gap,
            });
          }
        }
      }
    }

    // Check for inter-segment gaps
    for (let i = 1; i < segments.length; i++) {
      const prevSegment = segments[i - 1];
      const nextSegment = segments[i];

      // Use word-level boundaries if available, otherwise segment-level
      const prevEnd =
        prevSegment.words.length > 0
          ? prevSegment.words[prevSegment.words.length - 1].endTime
          : prevSegment.endTime;
      const nextStart =
        nextSegment.words.length > 0
          ? nextSegment.words[0].startTime
          : nextSegment.startTime;

      const gap = nextStart - prevEnd;
      if (gap >= this.candidateThreshold) {
        pauses.push({
          start: prevEnd,
          end: nextStart,
          duration: gap,
        });
      }
    }

    return pauses;
  }

  /**
   * Build a flat list of words with their text and timestamps from all segments,
   * preserving order. Used for context lookup during pause classification.
   */
  private buildFlatWordList(
    segments: TranscriptSegment[]
  ): { word: string; startTime: number; endTime: number }[] {
    const flatWords: { word: string; startTime: number; endTime: number }[] = [];

    for (const segment of segments) {
      if (segment.words.length > 0) {
        for (const w of segment.words) {
          flatWords.push({
            word: w.word,
            startTime: w.startTime,
            endTime: w.endTime,
          });
        }
      } else {
        // Segment-level fallback: split text into words and distribute timestamps
        const words = segment.text
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0);
        if (words.length === 0) continue;
        const wordDuration =
          (segment.endTime - segment.startTime) / words.length;
        for (let i = 0; i < words.length; i++) {
          flatWords.push({
            word: words[i],
            startTime: segment.startTime + i * wordDuration,
            endTime: segment.startTime + (i + 1) * wordDuration,
          });
        }
      }
    }

    return flatWords;
  }

  /**
   * Classify a single reportable pause as intentional or hesitation.
   *
   * Classification heuristics (from design doc):
   * - Intentional: preceding text ends with sentence-ending punctuation (.!?)
   *   AND following text starts a new clause/sentence
   * - Hesitation: preceding text ends mid-sentence (no terminal punctuation)
   * - Hesitation: preceding word is a known filler word
   * - Hesitation: following word repeats or rephrases the preceding word
   * - Fallback: heuristic combining pause duration + capitalization + sentence-final word
   * - Precedence: when both intentional and hesitation indicators present, hesitation wins
   * - Default: hesitation (conservative)
   */
  private classifyPause(
    pause: { start: number; end: number; duration: number },
    flatWords: { word: string; startTime: number; endTime: number }[]
  ): ClassifiedPause {
    // Find the word immediately before and after the pause
    const precedingWord = this.findWordBefore(pause.start, flatWords);
    const followingWord = this.findWordAfter(pause.end, flatWords);

    const hesitationReasons: string[] = [];
    const intentionalReasons: string[] = [];

    if (precedingWord && followingWord) {
      const precText = precedingWord.word;
      const followText = followingWord.word;
      const precCleaned = precText.toLowerCase().replace(/[^a-z]/g, "");
      const followCleaned = followText.toLowerCase().replace(/[^a-z]/g, "");

      // Check hesitation indicators
      // 1. Preceding word is a known filler word
      if (FILLER_WORDS_FOR_PAUSE.has(precCleaned)) {
        hesitationReasons.push(`preceded by filler word "${precCleaned}"`);
      }

      // 2. Following word repeats the preceding word
      if (precCleaned === followCleaned && precCleaned.length > 0) {
        hesitationReasons.push(`followed by repeated word "${followCleaned}"`);
      }

      // 3. Check if preceding text ends with sentence-ending punctuation
      const hasSentenceEndingPunct = SENTENCE_ENDING_PUNCT.test(precText.trim());

      if (hasSentenceEndingPunct) {
        // Check if following text starts a new sentence (capitalized or new clause)
        const followStartsNew =
          followText.length > 0 &&
          followText[0] === followText[0].toUpperCase() &&
          followText[0] !== followText[0].toLowerCase();

        if (followStartsNew) {
          intentionalReasons.push("follows complete sentence, precedes new sentence");
        } else {
          intentionalReasons.push("follows sentence-ending punctuation");
        }
      } else {
        // No terminal punctuation — apply punctuation fallback heuristic
        const fallbackResult = this.punctuationFallbackHeuristic(
          precCleaned,
          followText,
          pause.duration
        );
        if (fallbackResult.type === "intentional") {
          intentionalReasons.push(fallbackResult.reason);
        } else {
          hesitationReasons.push(fallbackResult.reason);
        }
      }
    } else if (precedingWord) {
      // Pause at the end of speech (no following word)
      const precText = precedingWord.word;
      if (SENTENCE_ENDING_PUNCT.test(precText.trim())) {
        intentionalReasons.push("follows complete sentence at end of speech");
      } else {
        hesitationReasons.push("mid-sentence pause at end of speech");
      }
    } else if (followingWord) {
      // Pause at the beginning of speech (no preceding word)
      hesitationReasons.push("pause before speech begins");
    } else {
      // No context available
      hesitationReasons.push("no surrounding context available");
    }

    // Precedence: hesitation wins when both indicators are present (conservative bias)
    if (hesitationReasons.length > 0) {
      return {
        start: pause.start,
        end: pause.end,
        duration: pause.duration,
        type: "hesitation",
        reason: hesitationReasons[0],
      };
    }

    if (intentionalReasons.length > 0) {
      return {
        start: pause.start,
        end: pause.end,
        duration: pause.duration,
        type: "intentional",
        reason: intentionalReasons[0],
      };
    }

    // Default: hesitation (conservative)
    return {
      start: pause.start,
      end: pause.end,
      duration: pause.duration,
      type: "hesitation",
      reason: "default classification (conservative)",
    };
  }

  /**
   * Punctuation fallback heuristic for when punctuation is absent or unreliable.
   * Uses a combination of:
   * - Pause duration (longer pauses more likely intentional)
   * - Capitalization of next token (capitalized → new sentence → intentional)
   * - Whether preceding token is a common sentence-final word
   */
  private punctuationFallbackHeuristic(
    precCleaned: string,
    followText: string,
    duration: number
  ): { type: "intentional" | "hesitation"; reason: string } {
    let intentionalScore = 0;

    // Factor 1: Pause duration — longer pauses (1.5-4s) suggest intentional
    if (duration >= 1.5 && duration <= 4.0) {
      intentionalScore++;
    }

    // Factor 2: Following word is capitalized (suggests new sentence)
    if (
      followText.length > 0 &&
      followText[0] === followText[0].toUpperCase() &&
      followText[0] !== followText[0].toLowerCase()
    ) {
      intentionalScore++;
    }

    // Factor 3: Preceding word is a common sentence-final word
    if (COMMON_SENTENCE_FINAL_WORDS.has(precCleaned)) {
      intentionalScore++;
    }

    // Need at least 2 of 3 indicators for intentional classification
    if (intentionalScore >= 2) {
      return {
        type: "intentional",
        reason: "punctuation fallback: duration/capitalization/sentence-final word heuristic",
      };
    }

    return {
      type: "hesitation",
      reason: "mid-sentence pause (no terminal punctuation)",
    };
  }

  /**
   * Find the word whose endTime is closest to (and ≤) the pause start time.
   */
  private findWordBefore(
    pauseStart: number,
    flatWords: { word: string; startTime: number; endTime: number }[]
  ): { word: string; startTime: number; endTime: number } | null {
    let best: { word: string; startTime: number; endTime: number } | null = null;
    let bestDist = Infinity;

    for (const w of flatWords) {
      const dist = pauseStart - w.endTime;
      if (dist >= -0.001 && dist < bestDist) {
        bestDist = dist;
        best = w;
      }
    }

    return best;
  }

  /**
   * Find the word whose startTime is closest to (and ≥) the pause end time.
   */
  private findWordAfter(
    pauseEnd: number,
    flatWords: { word: string; startTime: number; endTime: number }[]
  ): { word: string; startTime: number; endTime: number } | null {
    let best: { word: string; startTime: number; endTime: number } | null = null;
    let bestDist = Infinity;

    for (const w of flatWords) {
      const dist = w.startTime - pauseEnd;
      if (dist >= -0.001 && dist < bestDist) {
        bestDist = dist;
        best = w;
      }
    }

    return best;
  }
}
