// TTS Engine — converts evaluation script to spoken audio via OpenAI TTS API.
//
// Pre-TTS time enforcement: before calling the TTS API, the engine estimates
// the script duration using word count / calibratedWPM with a configurable
// safety margin. If the estimate exceeds maxDurationSeconds, the script is
// shortened using structured trimming that preserves opening, at least one
// commendation, the strongest recommendation, and closing.
//
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
// Design: TTSEngine interface with synthesize(), estimateDuration(), trimToFit()

import type { TTSConfig } from "./types.js";
import { splitSentences } from "./utils.js";

// ─── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_TTS_CONFIG: TTSConfig = {
  voice: "nova",
  maxDurationSeconds: 120, // Phase 2: 2min default (down from 210)
  calibratedWPM: 150,
  safetyMarginPercent: 8, // Phase 2: 8% safety margin
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

// ─── Script Section Types ───────────────────────────────────────────────────────

/**
 * Labeled section of a parsed evaluation script.
 * Used by structured trimming to identify what can be removed.
 */
export interface ScriptSection {
  type: "opening" | "commendation" | "recommendation" | "structure_commentary" | "closing";
  sentences: string[];
  /** For items: the summary sentence (first sentence) vs explanation (remaining). */
  summaryEndIndex?: number;
  /** For recommendations: strength indicator (lower index = stronger, i.e., first recommendation is strongest). */
  originalIndex?: number;
}

// ─── Heuristic patterns for section detection ───────────────────────────────────

/**
 * Patterns that indicate a commendation item is starting.
 * These are transition phrases commonly used in Toastmasters evaluations.
 */
const COMMENDATION_PATTERNS = [
  /\bone thing you did (?:really )?well\b/i,
  /\bwhat (?:really )?(?:stood out|impressed)\b/i,
  /\bi (?:really )?(?:liked|loved|appreciated|enjoyed|noticed)\b/i,
  /\byour (?:use of|ability to|skill in)\b/i,
  /\ba (?:real |particular )?strength\b/i,
  /\bcommend(?:ation|able|ed)?\b/i,
  /\bwell done\b/i,
  /\beffective(?:ly)?\b.*\b(?:used|employed|demonstrated)\b/i,
  /\bgreat (?:job|work|use)\b/i,
  /\bexcellent\b/i,
  /\bimpressive\b/i,
];

/**
 * Patterns that indicate a recommendation item is starting.
 */
const RECOMMENDATION_PATTERNS = [
  /\bsomething (?:to )?consider\b/i,
  /\bone (?:area|thing|suggestion)\b.*\b(?:improve|work on|consider|try)\b/i,
  /\byou (?:could|might|may)(?: want to)? (?:try|consider|think about|explore)\b/i,
  /\bnext time\b/i,
  /\brecommend(?:ation)?\b/i,
  /\bsuggestion\b/i,
  /\ban? area (?:for|of) (?:improvement|growth|development)\b/i,
  /\bit (?:might|could|may) help\b/i,
  /\bconsider\b.*\b(?:adding|using|trying|incorporating)\b/i,
  /\bto (?:further )?(?:strengthen|improve|enhance)\b/i,
];

/**
 * Patterns that indicate structure commentary (about speech opening/body/closing).
 */
const STRUCTURE_COMMENTARY_PATTERNS = [
  /\byour (?:speech )?(?:opening|introduction)\b/i,
  /\byour (?:speech )?(?:closing|conclusion)\b/i,
  /\bthe (?:body|middle|main (?:part|section)) of (?:your|the) speech\b/i,
  /\bspeech (?:structure|organization|flow)\b/i,
  /\b(?:opening|body|closing) (?:of|section|part)\b/i,
  /\bhow you (?:opened|structured|organized|closed)\b/i,
  /\byour (?:main )?points were\b/i,
  /\bthe (?:structure|organization|flow) of\b/i,
];

/**
 * Patterns that indicate a closing section (wrap-up/encouragement).
 */
const CLOSING_PATTERNS = [
  /\boverall\b/i,
  /\bin (?:summary|conclusion)\b/i,
  /\bkeep (?:up|going|at it|practicing)\b/i,
  /\blook(?:ing)? forward\b/i,
  /\bgreat (?:speech|job|work) overall\b/i,
  /\bwell done overall\b/i,
  /\bthank you\b/i,
  /\bcongratulations\b/i,
];

// ─── Section Parser ─────────────────────────────────────────────────────────────

/**
 * Parse an evaluation script into labeled sections for structured trimming.
 *
 * Heuristic approach:
 * 1. Split the script into sentences using the shared splitSentences() utility.
 * 2. Walk through sentences, classifying each based on pattern matching.
 * 3. Group consecutive sentences of the same type into sections.
 *
 * The parser uses a state machine:
 * - Starts in "opening" state (first 1-3 sentences are opening).
 * - Transitions to item/commentary sections when transition phrases are detected.
 * - The last 1-2 sentences that match closing patterns become the closing.
 *
 * @param script The evaluation script text.
 * @returns Array of labeled ScriptSection objects.
 */
export function parseScriptSections(script: string): ScriptSection[] {
  const sentences = splitSentences(script);
  if (sentences.length === 0) return [];

  // First pass: classify each sentence
  const classifications: Array<{
    sentence: string;
    type: "opening" | "commendation" | "recommendation" | "structure_commentary" | "closing" | "unknown";
  }> = sentences.map((s) => ({ sentence: s, type: "unknown" as const }));

  // Detect sentence types by pattern matching
  for (let i = 0; i < classifications.length; i++) {
    const s = classifications[i].sentence;

    if (matchesAny(s, COMMENDATION_PATTERNS)) {
      classifications[i].type = "commendation";
    } else if (matchesAny(s, RECOMMENDATION_PATTERNS)) {
      classifications[i].type = "recommendation";
    } else if (matchesAny(s, STRUCTURE_COMMENTARY_PATTERNS)) {
      classifications[i].type = "structure_commentary";
    }
  }

  // Identify closing: scan from the end for closing patterns.
  // Closing patterns override item classifications for the last few sentences,
  // because phrases like "Overall, great job" are closing wrap-ups even though
  // they may also match commendation patterns.
  let closingStartIndex = classifications.length;
  for (let i = classifications.length - 1; i >= Math.max(0, classifications.length - 3); i--) {
    if (matchesAny(classifications[i].sentence, CLOSING_PATTERNS)) {
      classifications[i].type = "closing";
      closingStartIndex = i;
    } else {
      break;
    }
  }

  // If no closing patterns found, treat the last sentence as closing
  // (only if it's not classified as an item)
  if (closingStartIndex === classifications.length && classifications.length > 1) {
    const lastIdx = classifications.length - 1;
    if (classifications[lastIdx].type === "unknown") {
      classifications[lastIdx].type = "closing";
      closingStartIndex = lastIdx;
    }
  }

  // Identify opening: first sentences before any item/commentary
  // Opening is the first 1-3 sentences that are "unknown" (not items/commentary)
  let openingEndIndex = 0;
  for (let i = 0; i < Math.min(classifications.length, closingStartIndex); i++) {
    if (classifications[i].type === "unknown") {
      classifications[i].type = "opening";
      openingEndIndex = i + 1;
    } else {
      break;
    }
  }

  // If no opening was found (first sentence is an item), force first sentence as opening
  if (openingEndIndex === 0 && classifications.length > 0) {
    // Don't reclassify items as opening — just leave openingEndIndex at 0
    // The opening section will be empty, which is fine
  }

  // Remaining "unknown" sentences between opening and closing:
  // Assign them to the nearest preceding item type (continuation of that item's explanation)
  let lastItemType: "commendation" | "recommendation" | "structure_commentary" | null = null;
  for (let i = openingEndIndex; i < closingStartIndex; i++) {
    const cType = classifications[i].type;
    if (
      cType === "commendation" ||
      cType === "recommendation" ||
      cType === "structure_commentary"
    ) {
      lastItemType = cType;
    } else if (classifications[i].type === "unknown" && lastItemType) {
      classifications[i].type = lastItemType;
    } else if (classifications[i].type === "unknown") {
      // Unknown sentence before any item — treat as opening continuation
      classifications[i].type = "opening";
    }
  }

  // Second pass: group consecutive sentences of the same type into sections
  const sections: ScriptSection[] = [];
  let currentType: string | null = null;
  let currentSentences: string[] = [];
  let commendationIndex = 0;
  let recommendationIndex = 0;

  for (const c of classifications) {
    if (c.type !== currentType) {
      // Flush current section
      if (currentType && currentSentences.length > 0) {
        const section = createSection(
          currentType as ScriptSection["type"],
          currentSentences,
          currentType === "commendation" ? commendationIndex++ : undefined,
          currentType === "recommendation" ? recommendationIndex++ : undefined,
        );
        sections.push(section);
      }
      currentType = c.type;
      currentSentences = [c.sentence];
    } else {
      currentSentences.push(c.sentence);
    }
  }

  // Flush last section
  if (currentType && currentSentences.length > 0) {
    const section = createSection(
      currentType as ScriptSection["type"],
      currentSentences,
      currentType === "commendation" ? commendationIndex : undefined,
      currentType === "recommendation" ? recommendationIndex : undefined,
    );
    sections.push(section);
  }

  return sections;
}

function createSection(
  type: ScriptSection["type"],
  sentences: string[],
  commendationIdx?: number,
  recommendationIdx?: number,
): ScriptSection {
  const section: ScriptSection = { type, sentences };

  // For items, the first sentence is the summary, rest is explanation
  if (type === "commendation" || type === "recommendation") {
    section.summaryEndIndex = 0; // first sentence is summary
    section.originalIndex = commendationIdx ?? recommendationIdx ?? 0;
  }

  return section;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ─── Section Reassembly ─────────────────────────────────────────────────────────

/**
 * Reassemble sections into a script string.
 */
function reassembleSections(sections: ScriptSection[]): string {
  return sections
    .map((s) => s.sentences.join(" "))
    .join(" ");
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
   * Estimate the spoken duration of a text in seconds, with optional safety margin.
   *
   * Uses: (word count / calibratedWPM) * 60 * (1 + safetyMarginPercent / 100)
   *
   * @param text                The script text to estimate.
   * @param wpm                 Words per minute rate. Defaults to 150.
   * @param safetyMarginPercent Safety margin percentage (e.g., 8 means 8%). Defaults to 0 for backward compat.
   * @returns Estimated duration in seconds (including safety margin).
   */
  estimateDuration(
    text: string,
    wpm: number = DEFAULT_TTS_CONFIG.calibratedWPM,
    safetyMarginPercent: number = 0,
  ): number {
    const words = countWords(text);
    if (words === 0) return 0;
    if (wpm <= 0) return 0;
    const baseEstimate = (words / wpm) * 60;
    return baseEstimate * (1 + safetyMarginPercent / 100);
  }

  // ── trimToFit ───────────────────────────────────────────────────────────────

  /**
   * Shorten a script using structured trimming to fit within maxSeconds.
   *
   * Phase 2 structured trimming algorithm:
   *   1. Parse script into labeled sections (opening, items, structure commentary, closing).
   *   2. If estimated duration (with safety margin) fits, return as-is.
   *   3. Trimming priority (remove in order):
   *      a. Structure commentary (lowest priority)
   *      b. Recommendation explanations (shorten to summary only)
   *      c. Additional commendations beyond the first
   *      d. Additional recommendations beyond the strongest
   *   4. Always preserve: opening + ≥1 commendation + strongest recommendation + closing.
   *   5. If trimming would remove all recommendations, preserve strongest instead of 2nd commendation.
   *   6. Hard-minimum fallback: cap opening/closing to 1 sentence, shorten explanations.
   *   7. Ensure trimmed script ends with a complete sentence.
   *   8. Trimming is purely subtractive — MUST NOT append content.
   *
   * @param text                The script text to trim.
   * @param maxSeconds          Maximum allowed duration in seconds.
   * @param wpm                 Words per minute rate. Defaults to 150.
   * @param safetyMarginPercent Safety margin percentage. Defaults to 0 for backward compat.
   * @returns The trimmed script that fits within maxSeconds.
   */
  trimToFit(
    text: string,
    maxSeconds: number,
    wpm: number = DEFAULT_TTS_CONFIG.calibratedWPM,
    safetyMarginPercent: number = 0,
  ): string {
    // If it already fits, return as-is
    if (this.estimateDuration(text, wpm, safetyMarginPercent) <= maxSeconds) {
      return text;
    }

    const sections = parseScriptSections(text);

    // If parsing produced no sections or only one section, fall back to simple trimming
    if (sections.length <= 1) {
      return this._simpleTrimToFit(text, maxSeconds, wpm, safetyMarginPercent);
    }

    // Check if we have any items (commendations/recommendations)
    const hasItems = sections.some(
      (s) => s.type === "commendation" || s.type === "recommendation",
    );

    // If no items detected, fall back to simple trimming
    if (!hasItems) {
      return this._simpleTrimToFit(text, maxSeconds, wpm, safetyMarginPercent);
    }

    // Work with a mutable copy of sections
    let workingSections = sections.map((s) => ({
      ...s,
      sentences: [...s.sentences],
    }));

    // Helper to check if current sections fit
    const fits = () =>
      this.estimateDuration(reassembleSections(workingSections), wpm, safetyMarginPercent) <= maxSeconds;

    // ── Step 3a: Remove structure commentary ──
    if (!fits()) {
      workingSections = workingSections.filter((s) => s.type !== "structure_commentary");
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // ── Step 3b: Shorten recommendation explanations to summary only ──
    if (!fits()) {
      for (const section of workingSections) {
        if (section.type === "recommendation" && section.sentences.length > 1) {
          // Keep only the summary sentence (first sentence)
          section.sentences = [section.sentences[0]];
        }
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // ── Step 3c: Remove additional commendations beyond the first ──
    // But first, check if we need to preserve a recommendation (Req 6.5)
    if (!fits()) {
      const commendations = workingSections.filter((s) => s.type === "commendation");
      const recommendations = workingSections.filter((s) => s.type === "recommendation");

      if (commendations.length > 1) {
        // Keep only the first commendation
        const firstCommendation = commendations[0];
        workingSections = workingSections.filter(
          (s) => s.type !== "commendation" || s === firstCommendation,
        );
      }

      // If removing commendations removed all recommendations (shouldn't happen, but safety check)
      // and we had recommendations, ensure the strongest is preserved
      if (recommendations.length > 0) {
        const hasRec = workingSections.some((s) => s.type === "recommendation");
        if (!hasRec) {
          // Re-add the strongest recommendation (first one = strongest by convention)
          const strongestRec = recommendations[0];
          // Insert before closing
          const closingIdx = workingSections.findIndex((s) => s.type === "closing");
          if (closingIdx >= 0) {
            workingSections.splice(closingIdx, 0, strongestRec);
          } else {
            workingSections.push(strongestRec);
          }
        }
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // ── Step 3d: Remove additional recommendations beyond the strongest ──
    if (!fits()) {
      const recommendations = workingSections.filter((s) => s.type === "recommendation");
      if (recommendations.length > 1) {
        // Keep only the strongest (first by originalIndex, i.e., first in script order)
        const strongest = recommendations[0];
        workingSections = workingSections.filter(
          (s) => s.type !== "recommendation" || s === strongest,
        );
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // ── Step 3b (extended): Also shorten commendation explanations to summary only ──
    if (!fits()) {
      for (const section of workingSections) {
        if (section.type === "commendation" && section.sentences.length > 1) {
          section.sentences = [section.sentences[0]];
        }
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // ── Step 6: Hard-minimum fallback ──
    // At this point we have: opening + 1 commendation + 1 recommendation + closing (minimum)
    // Apply further shortening:

    // 6a: Cap opening to 1 sentence
    if (!fits()) {
      for (const section of workingSections) {
        if (section.type === "opening" && section.sentences.length > 1) {
          section.sentences = [section.sentences[0]];
        }
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // 6b: Cap closing to 1 sentence
    if (!fits()) {
      for (const section of workingSections) {
        if (section.type === "closing" && section.sentences.length > 1) {
          section.sentences = [section.sentences[0]];
        }
      }
    }

    if (fits()) return ensureCompleteSentence(reassembleSections(workingSections));

    // 6c: Shorten item explanations to summary-only (already done above, but ensure)
    if (!fits()) {
      for (const section of workingSections) {
        if (
          (section.type === "commendation" || section.type === "recommendation") &&
          section.sentences.length > 1
        ) {
          section.sentences = [section.sentences[0]];
        }
      }
    }

    // 6d: If still over limit, deliver the hard-minimum script as-is
    // (safety messaging takes priority over time compliance)
    return ensureCompleteSentence(reassembleSections(workingSections));
  }

  // ── Simple trim fallback (Phase 1 behavior) ────────────────────────────────

  /**
   * Simple sentence-by-sentence trimming from the end.
   * Used as fallback when structured parsing doesn't find items.
   */
  /**
     * Simple sentence-by-sentence trimming from the end.
     * Used as fallback when structured parsing doesn't find items.
     * Falls back to word-level trimming if a single sentence still exceeds the limit.
     */
    /**
       * Simple sentence-by-sentence trimming from the end.
       * Used as fallback when structured parsing doesn't find items.
       * If down to a single sentence that still exceeds the limit, returns it as-is
       * (safety messaging takes priority over time compliance).
       */
      private _simpleTrimToFit(
        text: string,
        maxSeconds: number,
        wpm: number,
        safetyMarginPercent: number,
      ): string {
        if (this.estimateDuration(text, wpm, safetyMarginPercent) <= maxSeconds) {
          return text;
        }

        const sentences = splitSentences(text);

        if (sentences.length <= 1) {
          return text;
        }

        let trimmedSentences = [...sentences];

        while (trimmedSentences.length > 1) {
          trimmedSentences.pop();
          const candidate = trimmedSentences.join(" ");
          if (this.estimateDuration(candidate, wpm, safetyMarginPercent) <= maxSeconds) {
            return candidate;
          }
        }

        return trimmedSentences[0];
      }
    /**
     * Word-level trimming: removes words from the end until the text fits
     * within the time budget. Appends a period to ensure a complete sentence.
     */
    private _wordLevelTrim(
      text: string,
      maxSeconds: number,
      wpm: number,
      safetyMarginPercent: number,
    ): string {
      const words = text.trim().split(/\s+/);
      while (words.length > 1) {
        words.pop();
        let candidate = words.join(" ");
        // Ensure it ends with terminal punctuation
        const lastChar = candidate[candidate.length - 1];
        if (lastChar !== "." && lastChar !== "!" && lastChar !== "?") {
          candidate = candidate + ".";
        }
        if (this.estimateDuration(candidate, wpm, safetyMarginPercent) <= maxSeconds) {
          return candidate;
        }
      }
      return words[0];
    }

  // ── synthesize ──────────────────────────────────────────────────────────────

  /**
   * Synthesize text to speech using the OpenAI TTS API.
   *
   * Before calling the API, the engine enforces the time cap:
   *   1. Estimate duration using word count / calibratedWPM with safety margin.
   *   2. If over maxDurationSeconds, trim the script using structured trimming.
   *   3. Synthesize the (possibly trimmed) script.
   *
   * @param text    The evaluation script text to synthesize.
   * @param config  TTS configuration (voice, maxDuration, calibratedWPM, safetyMarginPercent).
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
      let scriptToSynthesize = this.trimToFit(
        text,
        mergedConfig.maxDurationSeconds,
        mergedConfig.calibratedWPM,
        mergedConfig.safetyMarginPercent,
      );

      // Hard word-level cap: if structured/sentence trimming couldn't fit,
      // enforce the limit by removing words from the end before sending to the API.
      if (this.estimateDuration(scriptToSynthesize, mergedConfig.calibratedWPM, mergedConfig.safetyMarginPercent) > mergedConfig.maxDurationSeconds) {
        scriptToSynthesize = this._wordLevelTrim(
          scriptToSynthesize,
          mergedConfig.maxDurationSeconds,
          mergedConfig.calibratedWPM,
          mergedConfig.safetyMarginPercent,
        );
      }

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

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Ensure a script ends with a complete sentence (terminal punctuation).
 * If the script already ends with `.`, `!`, or `?`, return as-is.
 * Otherwise, trim trailing whitespace — the script should already be
 * composed of complete sentences from splitSentences().
 */
function ensureCompleteSentence(script: string): string {
  const trimmed = script.trim();
  if (trimmed.length === 0) return trimmed;

  // Check if it ends with sentence-ending punctuation
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === "." || lastChar === "!" || lastChar === "?") {
    return trimmed;
  }

  // The script is composed of sentences from splitSentences(), so it should
  // already end with punctuation. If not, return as-is (don't append anything —
  // trimming is purely subtractive).
  return trimmed;
}
