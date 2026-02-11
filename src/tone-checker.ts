// AI Toastmasters Evaluator — Tone Checker
// Deterministic, rule-based component that validates evaluation scripts
// against prohibited content patterns. No LLM calls — pure regex and keyword matching.
//
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.10

import type {
  ToneViolation,
  ToneCheckResult,
  StructuredEvaluation,
  DeliveryMetrics,
} from "./types.js";
import { splitSentences } from "./utils.js";

// ─── Visual Metric Key Allowlist ────────────────────────────────────────────────

/**
 * Recognized visual metric keys from the VisualObservations schema.
 * Used by hasMetricAnchoredNumber() and validateMetricKeyExists().
 */
const VISUAL_METRIC_KEYS = new Set([
  "gazeBreakdown.audienceFacing",
  "gazeBreakdown.notesFacing",
  "gazeBreakdown.other",
  "faceNotDetectedCount",
  "totalGestureCount",
  "gestureFrequency",
  "gesturePerSentenceRatio",
  "meanBodyStabilityScore",
  "stageCrossingCount",
  "movementClassification",
  "meanFacialEnergyScore",
  "facialEnergyVariation",
]);

// ─── Pattern Definitions ────────────────────────────────────────────────────────

/**
 * Psychological inference patterns (Req 3.3)
 * Detect personal judgments or psychological inferences about the speaker.
 */
const PSYCHOLOGICAL_INFERENCE_PATTERNS: RegExp[] = [
  /\byou seem\b/i,
  /\byou appear to feel\b/i,
  /\byou lack\b/i,
  /\byou were nervous\b/i,
  /\byour anxiety\b/i,
  /\byou felt\b/i,
  /\byou were afraid\b/i,
  /\byou were uncomfortable\b/i,
  /\byou were confident\b/i,
  /\byour fear\b/i,
  /\byour insecurity\b/i,
  /\byou were hesitant\b/i,
  /\byou were uncertain\b/i,
  /\byour doubt\b/i,
  /\byou were worried\b/i,
  /\byou were anxious\b/i,
  /\byour nervousness\b/i,
  /\byou were scared\b/i,
  /\byou were intimidated\b/i,
  /\byour shyness\b/i,
  /\byou were shy\b/i,
  /\byou were timid\b/i,
  /\byou were self-conscious\b/i,
  /\byour self-doubt\b/i,
  /\byou were overwhelmed\b/i,
  /\byou were stressed\b/i,
  /\byour stress\b/i,
  /\byou were tense\b/i,
  /\byour tension\b/i,
  /\byou were frustrated\b/i,
];

/**
 * Visual scope violation patterns (Req 3.4)
 * Detect language that makes claims beyond audio-only observation scope.
 */
const VISUAL_SCOPE_PATTERNS: RegExp[] = [
  /\beye contact\b/i,
  /\bbody language\b/i,
  /\bfacial expression\b/i,
  /\bgesture[sd]?\b/i,
  /\bposture\b/i,
  /\blooked at\b/i,
  /\bsmiled\b/i,
  /\bnodded\b/i,
  /\bhand movement\b/i,
  /\bstood\b/i,
  /\bwalked\b/i,
  /\bpaced\b/i,
  /\bfidgeted\b/i,
  /\bleaned\b/i,
  /\bcrossed arms\b/i,
  /\bmade eye contact\b/i,
  /\byour face\b/i,
  /\byour eyes\b/i,
  /\byour hands\b/i,
  /\byour stance\b/i,
];

/**
 * Visual emotion inference patterns (Req 6.5, 7.1)
 * Detect sentences attributing emotions, psychological states, or intent
 * to visual observations.
 */
const VISUAL_EMOTION_INFERENCE_PATTERNS: RegExp[] = [
  /\byou (?:looked|seemed?|appeared?) (?:nervous|uncomfortable|distracted|confident|anxious|worried|stressed|tense|frustrated|bored|excited|happy|sad|angry|scared|shy|timid|overwhelmed)\b/i,
  /\byour (?:face|expression|eyes|body language|gestures?) (?:showed|revealed|indicated|suggested|betrayed)\b/i,
  /\byou were trying to (?:appear|look|seem)\b/i,
  /\byou felt\b/i,
  /\byour (?:nervousness|anxiety|confidence|discomfort|frustration|tension|stress)\b/i,
  /\byou were (?:clearly |obviously )?(?:nervous|uncomfortable|confident|anxious|stressed|tense|frustrated|bored|excited|happy|sad|angry|scared|shy|timid|overwhelmed)\b/i,
  /\bshowed signs of (?:fear|anxiety|nervousness|stress|discomfort|frustration|tension|confidence)\b/i,
  /\bwas clearly (?:stressed|nervous|anxious|uncomfortable|confident|frustrated|tense|overwhelmed)\b/i,
];

/**
 * Visual judgment patterns (Req 7.2)
 * Detect subjective quality judgments about visual delivery without
 * referencing a specific measurement.
 */
const VISUAL_JUDGMENT_PATTERNS: RegExp[] = [
  /\b(?:great|good|excellent|wonderful|fantastic|amazing|poor|bad|weak|awkward|terrible|impressive|effective|strong|natural) (?:eye contact|posture|gestures?|stage presence|body language|movement)\b/i,
  /\b(?:eye contact|posture|gestures?|stage presence|body language|movement) (?:was|were) (?:great|good|excellent|poor|bad|weak|awkward|effective|strong|natural|impressive|terrible)\b/i,
  /\blacked? (?:eye contact|gestures?|stage presence|movement)\b/i,
];

/**
 * Visual metric terms pattern — used to detect visual terms in sentences.
 * These terms require metric-anchored numbers when hasVideo is true.
 */
const VISUAL_METRIC_TERMS = /\b(gaze|audience[- ]facing|notes[- ]facing|gestures?|stability|stage.?crossings?|facial.?energy|movement|body.?stability)\b/i;

/**
 * Punitive/diagnostic language patterns (Req 3.5)
 * Detect punitive or diagnostic language.
 */
const PUNITIVE_LANGUAGE_PATTERNS: RegExp[] = [
  /\byou failed to\b/i,
  /\byou struggle with\b/i,
  /\byou were unable to\b/i,
  /\byour weakness\b/i,
  /\bpoor attempt\b/i,
  /\byou couldn'?t\b/i,
  /\byou didn'?t manage\b/i,
  /\byou fell short\b/i,
  /\byour failure\b/i,
  /\byou lacked\b/i,
  /\byou were deficient\b/i,
  /\byour shortcoming\b/i,
  /\byou were inadequate\b/i,
  /\byour inability\b/i,
  /\byou were incapable\b/i,
  /\byou were poor at\b/i,
  /\byour poor\b/i,
  /\byou were bad at\b/i,
  /\byour bad\b/i,
  /\byou were terrible\b/i,
  /\byour terrible\b/i,
  /\byou were awful\b/i,
  /\byour awful\b/i,
  /\byou were hopeless\b/i,
  /\byour hopeless\b/i,
];

/**
 * Numerical score patterns (Req 3.6)
 * Detect numerical scores, ratings, or percentage-based assessments.
 */
const NUMERICAL_SCORE_PATTERNS: RegExp[] = [
  /\d+\s*\/\s*10\b/i,
  /\d+\s+out\s+of\s+10\b/i,
  /\d+%/i,
  /\bscore of\b/i,
  /\brating of\b/i,
  /\bgrade of\b/i,
  /\d+\/\d+/i,
  /\brated \d+\b/i,
];

// ─── Assertive Sentence Classification ──────────────────────────────────────────

/**
 * Denylist verb stems — sentences containing these (in past tense or base form)
 * are classified as assertive (claiming specific speaker behavior).
 */
const ASSERTIVE_VERB_STEMS: string[] = [
  "said",
  "used",
  "mentioned",
  "described",
  "paused",
  "delivered",
  "opened",
  "closed",
  "spoke",
  "stated",
  "presented",
  "demonstrated",
  "showed",
  "displayed",
  "exhibited",
  "employed",
  "utilized",
  "incorporated",
  "included",
  "began",
  "started",
  "ended",
  "concluded",
  "finished",
  "repeated",
  "emphasized",
  "highlighted",
  "noted",
  "pointed out",
  "referred to",
];

/**
 * Sensory claim patterns — also classified as assertive.
 */
const SENSORY_CLAIM_PATTERNS: RegExp[] = [
  /\bit sounded like\b/i,
  /\bthe audience heard\b/i,
];

/**
 * Allowlist modal patterns — sentences matching these are classified as
 * non-assertive (general coaching language), even if they contain verb stems.
 */
const NON_ASSERTIVE_MODAL_PATTERNS: RegExp[] = [
  /\bconsider\b/i,
  /\bone option\b/i,
  /\byou could try\b/i,
  /\byou might\b/i,
  /\bit may help to\b/i,
  /\bnext time\b/i,
  /\btry to\b/i,
  /\bthink about\b/i,
  /\bperhaps\b/i,
  /\bmaybe\b/i,
  /\byou could\b/i,
  /\byou may want to\b/i,
  /\bit might be helpful\b/i,
  /\ban approach could be\b/i,
  /\ba suggestion would be\b/i,
];

// ─── Marker Patterns ────────────────────────────────────────────────────────────

/** Pattern to match [[Q:*]] and [[M:*]] markers */
const MARKER_PATTERN = /\s*\[\[(Q|M):[^\]]+\]\]/g;

/** Pattern to detect if a sentence contains a Q or M marker */
const HAS_MARKER_PATTERN = /\[\[(Q|M):[^\]]+\]\]/;

// ─── Scope Acknowledgment ───────────────────────────────────────────────────────

const SCOPE_ACKNOWLEDGMENT = "This evaluation is based on audio content only.";
const SCOPE_ACKNOWLEDGMENT_VIDEO = "This evaluation is based on audio and video content.";
const SCOPE_ACKNOWLEDGMENT_DETECTION = /based on audio content only/i;
const SCOPE_ACKNOWLEDGMENT_VIDEO_DETECTION = /based on audio and video content/i;

// ─── ToneChecker Class ─────────────────────────────────────────────────────────

export class ToneChecker {
  /**
   * Check a marked script for tone violations.
   *
   * The script is expected to contain [[Q:*]] and [[M:*]] markers from
   * the script rendering stage. These markers are used to determine
   * whether assertive sentences are grounded in evidence or metrics.
   *
   * @param markedScript - The evaluation script with markers
   * @param evaluation - The structured evaluation (for context)
   * @param metrics - The delivery metrics (for context)
   * @returns ToneCheckResult with pass/fail and any violations
   */
  /**
     * Check a marked script for tone violations.
     *
     * The script is expected to contain [[Q:*]] and [[M:*]] markers from
     * the script rendering stage. These markers are used to determine
     * whether assertive sentences are grounded in evidence or metrics.
     *
     * Marker placement rule: markers appear after terminal punctuation,
     * before following whitespace. So "Sentence. [[Q:item-0]] Next."
     * means the marker belongs to "Sentence.", not "Next.".
     *
     * @param markedScript - The evaluation script with markers
     * @param evaluation - The structured evaluation (for context)
     * @param metrics - The delivery metrics (for context)
     * @returns ToneCheckResult with pass/fail and any violations
     */
    check(
      markedScript: string,
      _evaluation: StructuredEvaluation,
      _metrics: DeliveryMetrics,
      options?: { hasVideo?: boolean },
    ): ToneCheckResult {
      const violations: ToneViolation[] = [];

      // Build a set of sentences that have markers associated with them.
      // Markers appear AFTER the sentence's terminal punctuation, so we
      // need to identify which clean sentence each marker belongs to.
      const markedSentenceTexts = this.extractMarkedSentences(markedScript);

      // Strip markers, then split into clean sentences for pattern checking
      const cleanScript = this.stripMarkers(markedScript);
      const sentences = splitSentences(cleanScript);

      for (const sentence of sentences) {
        // Check each pattern category against this sentence
        this.checkPsychologicalInference(sentence, violations);
        this.checkVisualEmotionInference(sentence, violations);
        this.checkVisualJudgment(sentence, violations);
        this.checkVisualScope(sentence, violations, options);
        this.checkPunitiveLanguage(sentence, violations);
        this.checkNumericalScores(sentence, violations);
        this.checkUngroundedClaims(sentence, markedSentenceTexts, violations);
      }

      return {
        passed: violations.length === 0,
        violations,
      };
    }

  /**
   * Remove sentences that contain tone violations from the marked script.
   * Preserves non-flagged sentences in their original order.
   *
   * @param markedScript - The script with markers still present
   * @param violations - The violations to strip
   * @returns The script with offending sentences removed
   */
  /**
     * Remove sentences that contain tone violations from the marked script.
     * Preserves non-flagged sentences in their original order.
     * Operates on the marked script (markers still present).
     *
     * @param markedScript - The script with markers still present
     * @param violations - The violations to strip
     * @returns The script with offending sentences removed (markers still present)
     */
    stripViolations(
      markedScript: string,
      violations: ToneViolation[],
    ): string {
      if (violations.length === 0) return markedScript;

      const flaggedSentences = new Set(
        violations.map((v) => v.sentence),
      );

      // Strip markers first to get clean sentences, then rebuild from marked script
      const cleanScript = this.stripMarkers(markedScript);
      const cleanSentences = splitSentences(cleanScript);

      // Build a mapping from clean sentences to their marked equivalents
      // by splitting the marked script at sentence boundaries
      const markedParts = this.splitMarkedScript(markedScript);

      // Filter out flagged sentences, keeping their marked equivalents
      const kept: string[] = [];
      for (let i = 0; i < cleanSentences.length && i < markedParts.length; i++) {
        if (!flaggedSentences.has(cleanSentences[i])) {
          kept.push(markedParts[i]);
        }
      }

      return kept.join(" ");
    }

  /**
   * Remove all [[Q:*]] and [[M:*]] markers from the script.
   * Called exactly once at the end of pipeline stage 5.
   *
   * Preserves punctuation adjacency and normalizes whitespace to single
   * spaces between sentences.
   *
   * @param markedScript - The script with markers
   * @returns The script with all markers removed
   */
  stripMarkers(markedScript: string): string {
    // Remove all marker occurrences (including leading whitespace before marker)
    let result = markedScript.replace(MARKER_PATTERN, "");

    // Normalize whitespace: collapse multiple spaces to single space
    result = result.replace(/ {2,}/g, " ");

    // Trim leading/trailing whitespace
    result = result.trim();

    return result;
  }

  /**
   * Append a scope acknowledgment sentence if conditions are met.
   * Idempotent: if the acknowledgment is already present, it won't be duplicated.
   *
   * @param script - The evaluation script (markers already stripped)
   * @param qualityWarning - Whether the transcript quality is degraded
   * @param hasStructureCommentary - Whether the evaluation references structural inference
   * @returns The script with scope acknowledgment appended if needed
   */
  appendScopeAcknowledgment(
    script: string,
    qualityWarning: boolean,
    hasStructureCommentary: boolean,
    options?: { hasVideo?: boolean },
  ): string {
    // Only append when qualityWarning is true OR hasStructureCommentary is true
    if (!qualityWarning && !hasStructureCommentary) {
      return script;
    }

    // Choose acknowledgment text based on video availability
    if (options?.hasVideo) {
      // Idempotent: don't duplicate if already present
      if (SCOPE_ACKNOWLEDGMENT_VIDEO_DETECTION.test(script)) {
        return script;
      }
      const trimmed = script.trimEnd();
      return trimmed + " " + SCOPE_ACKNOWLEDGMENT_VIDEO;
    }

    // Idempotent: don't duplicate if already present
    if (SCOPE_ACKNOWLEDGMENT_DETECTION.test(script)) {
      return script;
    }

    // Append with a space separator
    const trimmed = script.trimEnd();
    return trimmed + " " + SCOPE_ACKNOWLEDGMENT;
  }

  // ─── Private Pattern Checking Methods ───────────────────────────────────

  private checkPsychologicalInference(
    sentence: string,
    violations: ToneViolation[],
  ): void {
    for (const pattern of PSYCHOLOGICAL_INFERENCE_PATTERNS) {
      if (pattern.test(sentence)) {
        violations.push({
          category: "psychological_inference",
          sentence,
          pattern: pattern.source,
          explanation:
            "Personal judgment or psychological inference about the speaker",
        });
        return; // One violation per category per sentence
      }
    }
  }

  private checkVisualScope(
    sentence: string,
    violations: ToneViolation[],
    options?: { hasVideo?: boolean },
  ): void {
    for (const pattern of VISUAL_SCOPE_PATTERNS) {
      if (pattern.test(sentence)) {
        if (options?.hasVideo) {
          // When video is available, visual terms are permitted ONLY with
          // metric-anchored numbers referencing recognized metric keys
          if (hasMetricAnchoredNumber(sentence)) {
            return; // Permitted — has metric-anchored number
          }
        }
        violations.push({
          category: "visual_scope",
          sentence,
          pattern: pattern.source,
          explanation: options?.hasVideo
            ? "Visual term without metric-anchored numeric measurement"
            : "Claim beyond audio-only observation scope",
        });
        return;
      }
    }
  }

  private checkVisualEmotionInference(
    sentence: string,
    violations: ToneViolation[],
  ): void {
    for (const pattern of VISUAL_EMOTION_INFERENCE_PATTERNS) {
      if (pattern.test(sentence)) {
        violations.push({
          category: "visual_emotion_inference",
          sentence,
          pattern: pattern.source,
          explanation:
            "Attribution of emotion, psychological state, or intent from visual observation",
        });
        return; // One violation per category per sentence
      }
    }
  }

  private checkVisualJudgment(
    sentence: string,
    violations: ToneViolation[],
  ): void {
    for (const pattern of VISUAL_JUDGMENT_PATTERNS) {
      if (pattern.test(sentence)) {
        violations.push({
          category: "visual_judgment",
          sentence,
          pattern: pattern.source,
          explanation:
            "Subjective quality judgment about visual delivery without metric backing",
        });
        return; // One violation per category per sentence
      }
    }
  }

  private checkPunitiveLanguage(
    sentence: string,
    violations: ToneViolation[],
  ): void {
    for (const pattern of PUNITIVE_LANGUAGE_PATTERNS) {
      if (pattern.test(sentence)) {
        violations.push({
          category: "punitive_language",
          sentence,
          pattern: pattern.source,
          explanation:
            "Punitive or diagnostic language",
        });
        return;
      }
    }
  }

  private checkNumericalScores(
    sentence: string,
    violations: ToneViolation[],
  ): void {
    for (const pattern of NUMERICAL_SCORE_PATTERNS) {
      if (pattern.test(sentence)) {
        violations.push({
          category: "numerical_score",
          sentence,
          pattern: pattern.source,
          explanation:
            "Numerical score, rating, or percentage-based assessment",
        });
        return;
      }
    }
  }

  /**
   * Check for ungrounded claims (Req 3.2).
   *
   * An assertive sentence (one that claims specific speaker behavior)
   * must contain a [[Q:*]] or [[M:*]] marker, or match the general
   * coaching language allowlist. Unmarked assertive sentences are flagged.
   */
  /**
     * Check for ungrounded claims (Req 3.2).
     *
     * An assertive sentence (one that claims specific speaker behavior)
     * must contain a [[Q:*]] or [[M:*]] marker, or match the general
     * coaching language allowlist. Unmarked assertive sentences are flagged.
     */
    private checkUngroundedClaims(
      sentence: string,
      markedSentenceTexts: Set<string>,
      violations: ToneViolation[],
    ): void {
      // If the sentence has a marker associated with it, it's grounded — skip
      if (markedSentenceTexts.has(sentence)) {
        return;
      }

      // If the sentence matches a non-assertive modal pattern, it's coaching language — skip
      if (this.isNonAssertive(sentence)) {
        return;
      }

      // If the sentence is assertive (contains denylist verb stems or sensory claims), flag it
      const assertiveMatch = this.findAssertivePattern(sentence);
      if (assertiveMatch) {
        violations.push({
          category: "ungrounded_claim",
          sentence,
          pattern: assertiveMatch,
          explanation:
            "Assertive claim about speaker behavior without evidence marker or metrics reference",
        });
      }
    }

  /**
   * Check if a sentence matches any non-assertive modal pattern.
   */
  private isNonAssertive(sentence: string): boolean {
    return NON_ASSERTIVE_MODAL_PATTERNS.some((p) => p.test(sentence));
  }

  /**
   * Find the first assertive pattern match in a sentence.
   * Returns the matched pattern string, or null if not assertive.
   */
  private findAssertivePattern(sentence: string): string | null {
    const lowerSentence = sentence.toLowerCase();

    // Check verb stems
    for (const stem of ASSERTIVE_VERB_STEMS) {
      // Build a word-boundary regex for the stem
      const regex = new RegExp(`\\b${escapeRegex(stem)}\\b`, "i");
      if (regex.test(lowerSentence)) {
        return stem;
      }
    }

    // Check sensory claim patterns
    for (const pattern of SENSORY_CLAIM_PATTERNS) {
      if (pattern.test(sentence)) {
        return pattern.source;
      }
    }

    return null;
  }

  /**
   * Extract the set of clean sentence texts that have markers associated with them.
   *
   * Markers appear AFTER the sentence's terminal punctuation in the marked script,
   * e.g., "You said something. [[Q:item-0]] Next sentence."
   * This means the marker belongs to "You said something.", not "Next sentence."
   *
   * Strategy: find all markers in the raw text, look backwards to find the
   * preceding sentence, strip markers from that sentence, and add it to the set.
   */
  private extractMarkedSentences(markedScript: string): Set<string> {
    const markedSentences = new Set<string>();

    // Split the marked script into clean sentences first
    const cleanScript = this.stripMarkers(markedScript);
    const cleanSentences = splitSentences(cleanScript);

    // For each clean sentence, check if it's followed by a marker in the original text
    for (const sentence of cleanSentences) {
      // Find this sentence in the original marked script (after stripping markers from the search area)
      // We need to check if a marker appears after this sentence in the original text
      if (this.sentenceHasMarker(markedScript, sentence)) {
        markedSentences.add(sentence);
      }
    }

    return markedSentences;
  }

  /**
   * Check if a clean sentence has a marker associated with it in the marked script.
   * A marker is associated with a sentence if it appears immediately after the
   * sentence's terminal punctuation (possibly with whitespace between).
   */
  private sentenceHasMarker(markedScript: string, cleanSentence: string): boolean {
    // Escape the sentence for use in regex, but we need to be careful with
    // special characters. Instead, do a simple string search.
    const idx = markedScript.indexOf(cleanSentence);
    if (idx === -1) return false;

    // Look at what follows the sentence in the marked script
    const afterSentence = markedScript.slice(idx + cleanSentence.length);

    // Check if a marker follows (possibly with whitespace)
    return /^\s*\[\[(Q|M):[^\]]+\]\]/.test(afterSentence);
  }

  /**
   * Split a marked script into parts that correspond 1:1 with the clean sentences
   * from splitSentences(stripMarkers(markedScript)).
   *
   * Each part includes the sentence text plus any trailing markers and whitespace
   * that belong to it.
   */
  private splitMarkedScript(markedScript: string): string[] {
    const cleanScript = this.stripMarkers(markedScript);
    const cleanSentences = splitSentences(cleanScript);
    const parts: string[] = [];

    let remaining = markedScript;

    for (const sentence of cleanSentences) {
      // Find this sentence in the remaining marked text
      const idx = remaining.indexOf(sentence);
      if (idx === -1) {
        // Fallback: just use the clean sentence
        parts.push(sentence);
        continue;
      }

      // The part starts at the sentence and includes any trailing markers
      let endIdx = idx + sentence.length;

      // Consume any trailing markers and whitespace that belong to this sentence
      const afterSentence = remaining.slice(endIdx);
      const markerMatch = afterSentence.match(/^(\s*\[\[(Q|M):[^\]]+\]\])*/);
      if (markerMatch && markerMatch[0]) {
        endIdx += markerMatch[0].length;
      }

      parts.push(remaining.slice(idx, endIdx).trim());
      remaining = remaining.slice(endIdx);
    }

    return parts;
  }
}

// ─── Exported Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a sentence contains a metric-anchored numeric measurement.
 * Requires BOTH a recognized visual metric term AND a numeric value.
 * A sentence like "I observed low gaze" fails; "I observed 65% audience-facing gaze" passes
 * only if the metric term maps to a recognized key.
 */
export function hasMetricAnchoredNumber(sentence: string): boolean {
  // Must contain a recognized visual metric term
  if (!VISUAL_METRIC_TERMS.test(sentence)) return false;
  // Must also contain a numeric value in metric context
  // Percentage (e.g., "65%")
  if (/\d+(\.\d+)?%/.test(sentence)) return true;
  // Number with unit (e.g., "12 gestures", "2 stage crossings", "3 times")
  if (/\d+(\.\d+)?\s+(?:\w+\s+)*(gestures?|times|crossings?|frames?|seconds?|minutes?)\b/i.test(sentence)) return true;
  // Decimal with score/ratio/frequency term (e.g., "score of 0.85", "0.85 score")
  if (/\b(score|ratio|frequency)\b.*\d+\.\d+/i.test(sentence)) return true;
  if (/\d+\.\d+.*\b(score|ratio|frequency)\b/i.test(sentence)) return true;
  return false;
}

/**
 * Validate that an observation_data string references an actual metric field
 * present in the VisualObservations structure.
 * References to non-existent metric fields are treated as visual_scope violations.
 */
export function validateMetricKeyExists(observationData: string): boolean {
  const metricMatch = observationData.match(/metric=([^;]+)/);
  if (!metricMatch) return false;
  const metricKey = metricMatch[1].trim();
  return VISUAL_METRIC_KEYS.has(metricKey);
}

// ─── Utility ────────────────────────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
