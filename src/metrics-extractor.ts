// AI Toastmasters Evaluator - Metrics Extractor
// Requirements: 3.1 (duration), 3.2 (WPM), 3.3 (filler words), 3.4 (pauses), 3.5 (JSON output), 3.6 (contextual filler detection)

import type {
  TranscriptSegment,
  DeliveryMetrics,
  FillerWordEntry,
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

// ─── Metrics Extractor ──────────────────────────────────────────────────────────

export class MetricsExtractor {
  private pauseThreshold: number;

  constructor(pauseThreshold: number = 1.5) {
    this.pauseThreshold = pauseThreshold;
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

    // Filler word detection
    const fillerWords = this.detectFillerWords(segments);
    const fillerWordCount = fillerWords.reduce((sum, f) => sum + f.count, 0);
    const fillerWordFrequency =
      durationMinutes > 0 ? fillerWordCount / durationMinutes : 0;

    // Pause detection
    const pauses = this.detectPauses(segments);
    const pauseCount = pauses.length;
    const totalPauseDurationSeconds = pauses.reduce(
      (sum, p) => sum + p.duration,
      0
    );
    const averagePauseDurationSeconds =
      pauseCount > 0 ? totalPauseDurationSeconds / pauseCount : 0;

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
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

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

  private detectPauses(
    segments: TranscriptSegment[]
  ): { start: number; end: number; duration: number }[] {
    const pauses: { start: number; end: number; duration: number }[] = [];

    // Check for word-level gaps within segments
    for (const segment of segments) {
      if (segment.words.length > 1) {
        for (let i = 1; i < segment.words.length; i++) {
          const gap =
            segment.words[i].startTime - segment.words[i - 1].endTime;
          if (gap >= this.pauseThreshold) {
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
      const gap = segments[i].startTime - segments[i - 1].endTime;
      if (gap >= this.pauseThreshold) {
        pauses.push({
          start: segments[i - 1].endTime,
          end: segments[i].startTime,
          duration: gap,
        });
      }
    }

    return pauses;
  }
}
