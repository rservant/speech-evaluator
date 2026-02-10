// Evaluation Generator — produces a structured, evidence-based evaluation
// from a transcript and delivery metrics using OpenAI GPT-4o structured output.
//
// Three-stage pipeline (from design doc):
//   Stage 1 — Structured JSON: LLM produces StructuredEvaluation via JSON mode.
//   Stage 2 — Validation: evidence quotes validated against transcript; per-item
//             retry (max 1), full regeneration if shape violated (max 2 total).
//   Stage 3 — Script rendering: validated evaluation rendered into natural spoken text.
//
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6

import type OpenAI from "openai";
import type {
  ConsentRecord,
  DeliveryMetrics,
  EvaluationConfig,
  EvaluationItem,
  EvaluationItemPublic,
  RedactionInput,
  RedactionOutput,
  StructureCommentary,
  StructuredEvaluation,
  StructuredEvaluationPublic,
  TranscriptSegment,
} from "./types.js";
import { EvidenceValidator, type ValidationResult } from "./evidence-validator.js";
import { splitSentences } from "./utils.js";

// ─── Transcript quality thresholds ──────────────────────────────────────────────

const MIN_WORDS_PER_MINUTE = 10;
const MIN_AVERAGE_CONFIDENCE = 0.5;

// ─── High-confidence segment threshold (Req 10.2) ──────────────────────────────

const HIGH_CONFIDENCE_SEGMENT_THRESHOLD = 0.7;

// ─── Non-speech marker detection ────────────────────────────────────────────────

/**
 * Common non-speech tokens emitted by transcription engines.
 * These are excluded from confidence computation per Req 10.1.
 */
const NON_SPEECH_MARKERS = new Set([
  "[silence]",
  "[noise]",
  "[music]",
  "[inaudible]",
  "[laughter]",
  "[applause]",
  "[crosstalk]",
  "[blank_audio]",
]);

/**
 * Returns true if a word is a silence or non-speech marker.
 * A word is considered a marker if:
 * - Its text is empty or whitespace-only
 * - Its text (lowercased, trimmed) matches a known non-speech token
 */
function isSilenceOrNonSpeechMarker(word: string): boolean {
  const trimmed = word.trim();
  if (trimmed.length === 0) return true;
  return NON_SPEECH_MARKERS.has(trimmed.toLowerCase());
}
// ─── Cosine Similarity (Req 7.3, 7.5) ──────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors of equal dimension.
 *
 * Returns dot(a, b) / (norm(a) * norm(b)).
 * Returns 0 for zero-length vectors or vectors of different lengths.
 * Result is in the range [-1, 1] for non-zero vectors.
 *
 * Exported for use by Property 19 tests.
 *
 * Requirements: 7.3, 7.5
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Embedding model constant (Req 7.5) ────────────────────────────────────────

/**
 * Fixed embedding model for consistency monitoring telemetry.
 * Specified as a configured constant to ensure reproducible similarity scoring.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";

// ─── Consistency similarity threshold (Req 7.3) ────────────────────────────────

const CONSISTENCY_SIMILARITY_THRESHOLD = 0.75;

// ─── Shape invariant bounds ─────────────────────────────────────────────────────

const MIN_COMMENDATIONS = 2;
const MAX_COMMENDATIONS = 3;
const MIN_RECOMMENDATIONS = 1;
const MAX_RECOMMENDATIONS = 2;

// ─── Retry budget ───────────────────────────────────────────────────────────────

const MAX_ITEM_RETRIES = 1;
const MAX_FULL_GENERATION_ATTEMPTS = 2;

// ─── Short-form fallback bounds (Req 9.2) ───────────────────────────────────────

const SHORT_FORM_MIN_COMMENDATIONS = 1;
const SHORT_FORM_MIN_RECOMMENDATIONS = 1;

// ─── Metrics field names for marker detection ───────────────────────────────────

const METRICS_FIELD_NAMES = [
  "wordsPerMinute",
  "fillerWordCount",
  "fillerWordFrequency",
  "pauseCount",
  "durationSeconds",
  "intentionalPauseCount",
  "hesitationPauseCount",
  "energyVariationCoefficient",
  "totalPauseDurationSeconds",
  "averagePauseDurationSeconds",
] as const;

/**
 * Human-readable keywords that map to DeliveryMetrics field names.
 * Used to detect when a sentence references a specific metric.
 */
const METRICS_KEYWORDS: Record<string, string> = {
  // wordsPerMinute
  "words per minute": "wordsPerMinute",
  "speaking rate": "wordsPerMinute",
  "speaking pace": "wordsPerMinute",
  "speech pace": "wordsPerMinute",
  "pace": "wordsPerMinute",
  "wpm": "wordsPerMinute",
  "steady pace": "wordsPerMinute",
  "speaking speed": "wordsPerMinute",
  // fillerWordCount / fillerWordFrequency
  "filler word": "fillerWordCount",
  "filler words": "fillerWordCount",
  "um": "fillerWordCount",
  "uh": "fillerWordCount",
  "you know": "fillerWordCount",
  "filler": "fillerWordCount",
  // pauseCount
  "pause": "pauseCount",
  "pauses": "pauseCount",
  "pausing": "pauseCount",
  "paused": "pauseCount",
  // durationSeconds
  "duration": "durationSeconds",
  "speech length": "durationSeconds",
  "how long": "durationSeconds",
  "minutes long": "durationSeconds",
  // intentionalPauseCount
  "intentional pause": "intentionalPauseCount",
  "dramatic pause": "intentionalPauseCount",
  "rhetorical pause": "intentionalPauseCount",
  // hesitationPauseCount
  "hesitation": "hesitationPauseCount",
  "hesitation pause": "hesitationPauseCount",
  // energyVariationCoefficient
  "vocal variety": "energyVariationCoefficient",
  "energy variation": "energyVariationCoefficient",
  "vocal energy": "energyVariationCoefficient",
  "volume variation": "energyVariationCoefficient",
  // totalPauseDurationSeconds
  "total pause": "totalPauseDurationSeconds",
  "pause duration": "totalPauseDurationSeconds",
  // averagePauseDurationSeconds
  "average pause": "averagePauseDurationSeconds",
};

// ─── OpenAI client interface (for testability / dependency injection) ────────────

/**
 * Minimal interface for the OpenAI chat completions API surface we use.
 * This allows injecting a mock client in tests without importing the full SDK.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: { type: string };
        temperature?: number;
      }): Promise<{
        choices: Array<{
          message: {
            content: string | null;
          };
        }>;
      }>;
    };
  };
  // Optional embeddings API surface for consistency monitoring telemetry (Req 7.5)
  embeddings?: {
    create(params: {
      model: string;
      input: string;
    }): Promise<{
      data: Array<{
        embedding: number[];
      }>;
    }>;
  };
}

// ─── Generate result type (Req 1.6, 9.2) ────────────────────────────────────────

export interface GenerateResult {
  evaluation: StructuredEvaluation;
  passRate: number; // passedOnFirstAttempt / totalDeliveredItems
}

// ─── Internal validation tracking types ─────────────────────────────────────────

/** Tracks whether an individual item passed evidence validation on first attempt. */
interface ItemValidationRecord {
  item: EvaluationItem;
  passedFirstAttempt: boolean;
}

/** Result of validateAndRetry, including pass-rate tracking data. */
interface ValidateAndRetryResult {
  evaluation: StructuredEvaluation;
  firstAttemptResults: ItemValidationRecord[];
  /** Count of items in the final evaluation that passed on first attempt. */
  passedOnFirstAttempt: number;
}

// ─── EvaluationGenerator ────────────────────────────────────────────────────────

export class EvaluationGenerator {
  private readonly openai: OpenAIClient;
  private readonly evidenceValidator: EvidenceValidator;
  private readonly model: string;

  /** Cached embedding from the previous evaluation for consistency comparison (Req 7.3). */
  private lastEmbedding: number[] | null = null;

  constructor(openaiClient: OpenAIClient, model: string = "gpt-4o") {
    this.openai = openaiClient;
    this.evidenceValidator = new EvidenceValidator();
    this.model = model;
  }

  // ── Stage 1 + 2: Generate and validate ──────────────────────────────────────

  /**
   * Generate a structured evaluation from transcript segments and delivery metrics.
   *
   * Implements the full retry pipeline:
   *  1. Call LLM for structured JSON output.
   *  2. Validate evidence quotes against transcript.
   *  3. Re-prompt failed items individually (max 1 retry per item).
   *  4. If shape invariant violated after dropping failures, regenerate fully (max 2 total).
   *  5. If shape invariant still fails after all retries, produce short-form fallback (Req 9.2).
   *
   * Returns the evaluation along with the pass rate (Req 1.6):
   *  passRate = passedOnFirstAttempt / totalDeliveredItems
   */
  async generate(
    transcript: TranscriptSegment[],
    metrics: DeliveryMetrics,
    config?: EvaluationConfig,
  ): Promise<GenerateResult> {
    const transcriptText = this.buildTranscriptText(transcript);
    const qualityWarning = this.assessTranscriptQuality(transcript, metrics);

    // When quality warning is active, filter to high-confidence segments (Req 10.2)
    let highConfidenceSegments: TranscriptSegment[] | undefined;
    if (qualityWarning) {
      highConfidenceSegments = transcript.filter((seg) => {
        const speechWords = seg.words.filter((w) => !isSilenceOrNonSpeechMarker(w.word));
        if (speechWords.length === 0) return false;
        const meanConfidence = speechWords.reduce((sum, w) => sum + w.confidence, 0) / speechWords.length;
        return meanConfidence >= HIGH_CONFIDENCE_SEGMENT_THRESHOLD;
      });
      // If no segments meet the threshold, use all segments (with strong uncertainty qualifier)
      if (highConfidenceSegments.length === 0) {
        highConfidenceSegments = undefined;
      }
    }

    // Track the last validated result for short-form fallback
    let lastValidatedResult: ValidateAndRetryResult | null = null;

    for (let attempt = 0; attempt < MAX_FULL_GENERATION_ATTEMPTS; attempt++) {
      // Stage 1: Call LLM
      const prompt = this.buildPrompt(transcriptText, metrics, qualityWarning, config, highConfidenceSegments);
      const raw = await this.callLLM(prompt);
      const evaluation = this.parseEvaluation(raw);

      // Stage 2: Validate evidence (with pass-rate tracking)
      const validateResult = await this.validateAndRetry(
        evaluation,
        transcript,
        transcriptText,
        metrics,
        qualityWarning,
        config,
      );
      lastValidatedResult = validateResult;

      // Check shape invariant
      if (this.meetsShapeInvariant(validateResult.evaluation)) {
        return {
          evaluation: validateResult.evaluation,
          passRate: this.computePassRate(
            validateResult.passedOnFirstAttempt,
            validateResult.evaluation.items.length,
          ),
        };
      }

      // Shape violated — will regenerate on next iteration (if budget remains)
    }

    // Exhausted retries — attempt short-form fallback (Req 9.2, 9.3)
    if (lastValidatedResult) {
      const shortForm = this.buildShortFormFallback(lastValidatedResult);
      if (shortForm) {
        return {
          evaluation: shortForm.evaluation,
          passRate: this.computePassRate(
            shortForm.passedOnFirstAttempt,
            shortForm.evaluation.items.length,
          ),
        };
      }
    }

    // Short-form fallback couldn't produce valid items — best-effort last LLM call
    const lastPrompt = this.buildPrompt(transcriptText, metrics, qualityWarning, config, highConfidenceSegments);
    const lastRaw = await this.callLLM(lastPrompt);
    const lastEval = this.parseEvaluation(lastRaw);
    return {
      evaluation: lastEval,
      passRate: 0,
    };
  }

  // ── Stage 2: Validation (delegates to EvidenceValidator) ────────────────────

  /**
   * Validate a StructuredEvaluation against the transcript text.
   * Delegates to EvidenceValidator for the actual token matching and
   * timestamp locality checks.
   */
  validate(
    evaluation: StructuredEvaluation,
    transcriptSegments: TranscriptSegment[],
  ): ValidationResult {
    return this.evidenceValidator.validate(evaluation, transcriptSegments);
  }

  // ── Stage 3: Script rendering ───────────────────────────────────────────────

  /**
   * Render a validated StructuredEvaluation into a natural spoken script.
   *
   * The script follows the section-based structure:
   *  - Opening (1-2 sentences)
   *  - Each commendation/recommendation (2-3 sentences with evidence woven in)
   *  - Closing (1-2 sentences)
   *
   * Third-party name redaction is applied: names other than the speaker's
   * own name are replaced with "[a fellow member]".
   */
  /**
     * Render a validated StructuredEvaluation into a natural spoken script
     * with inline markers for tone checking (pipeline stage 4).
     *
     * Emits:
     *  - `[[Q:item-N]]` after sentences derived from evidence quotes
     *  - `[[M:fieldName]]` after sentences referencing DeliveryMetrics fields
     *
     * Structure commentary (non-null fields) is woven between the opening
     * and the first evaluation item.
     *
     * Markers are stripped later in stage 5 by ToneChecker.stripMarkers().
     *
     * Third-party name redaction is applied after markers (for backward compat;
     * will be moved to pipeline stage 8 in full pipeline wiring).
     */
    renderScript(
      evaluation: StructuredEvaluation,
      speakerName?: string,
      metrics?: DeliveryMetrics,
    ): string {
      const parts: string[] = [];

      // Opening
      parts.push(evaluation.opening);

      // Structure commentary (between opening and first item)
      // Omit sections where the field is null; omit entirely if all null or undefined
      const commentary = evaluation.structure_commentary;
      const commentaryParts: string[] = [];
      if (commentary?.opening_comment) {
        commentaryParts.push(commentary.opening_comment);
      }
      if (commentary?.body_comment) {
        commentaryParts.push(commentary.body_comment);
      }
      if (commentary?.closing_comment) {
        commentaryParts.push(commentary.closing_comment);
      }
      if (commentaryParts.length > 0) {
        parts.push(commentaryParts.join(" "));
      }

      // Items (commendations and recommendations in order) with markers
      for (let i = 0; i < evaluation.items.length; i++) {
        const item = evaluation.items[i];
        const section = this.renderItemSection(item);
        const markedSection = this.applyMarkers(section, i, item, metrics);
        parts.push(markedSection);
      }

      // Closing
      parts.push(evaluation.closing);

      const script = parts.join("\n\n");

      // Apply third-party name redaction for TTS delivery
      return this.redactThirdPartyNames(script, speakerName);
    }

  // ── Prompt construction ─────────────────────────────────────────────────────

  /**
   * Build the system + user prompt for the LLM structured output call.
   *
   * When qualityWarning is active and highConfidenceSegments are available,
   * the user prompt annotates which segments are high-confidence so the LLM
   * can focus evidence on those segments (Req 10.2).
   */
  private buildPrompt(
    transcriptText: string,
    metrics: DeliveryMetrics,
    qualityWarning: boolean,
    config?: EvaluationConfig,
    highConfidenceSegments?: TranscriptSegment[],
  ): { system: string; user: string } {
    const system = this.buildSystemPrompt(qualityWarning);
    const user = this.buildUserPrompt(transcriptText, metrics, config, highConfidenceSegments);
    return { system, user };
  }

  private buildSystemPrompt(qualityWarning: boolean): string {
      let prompt = `You are an experienced Toastmasters speech evaluator. Your role is to provide supportive, evidence-based evaluations of speeches.

  ## Output Format
  You MUST respond with a valid JSON object matching this exact structure:
  {
    "opening": "string (1-2 sentences, warm greeting and overall impression)",
    "items": [
      {
        "type": "commendation" or "recommendation",
        "summary": "string (brief label for this point)",
        "evidence_quote": "string (verbatim quote from the transcript, at most 15 words)",
        "evidence_timestamp": number (seconds since speech start when the quoted passage begins),
        "explanation": "string (2-3 sentences explaining why this matters)"
      }
    ],
    "closing": "string (1-2 sentences, encouraging wrap-up)",
    "structure_commentary": {
      "opening_comment": "string or null (descriptive observation about the speech opening)",
      "body_comment": "string or null (descriptive observation about the speech body organization)",
      "closing_comment": "string or null (descriptive observation about the speech closing)"
    }
  }

  ## Evaluation Style
  - Use a free-form natural conversational style. Do NOT use the CRC (Commend-Recommend-Commend) sandwich pattern.
  - Mix commendations and recommendations naturally, as a skilled evaluator would in conversation.
  - Be warm, supportive, and specific. Every point must reference something the speaker actually said or did.

  ## Evidence Rules
  - Every commendation and recommendation MUST include an evidence_quote that is a VERBATIM snippet from the transcript.
  - Each evidence_quote must be at most 15 words long and at least 6 words long.
  - Each evidence_quote must be copied exactly from the transcript text (word for word).
  - The evidence_timestamp must be the approximate start time (in seconds) of where that quote appears in the speech.
  - Do NOT fabricate, paraphrase, or invent quotes. Use only the speaker's actual words.

  ## Counts
  - Include exactly 2 to 3 commendations (type: "commendation").
  - Include exactly 1 to 2 recommendations (type: "recommendation").

  ## Length
  - Opening: 1-2 sentences.
  - Each item explanation: 2-3 sentences.
  - Closing: 1-2 sentences.
  - Target total: approximately 250-400 words when rendered as spoken text.

  ## Speech Structure Commentary
  Analyze the transcript to provide descriptive commentary on the speech's structure.

  ### Segmentation
  - **Opening** (first 10-15% of words): Look for a hook, attention-grabber, or topic introduction.
  - **Body** (middle 70-80% of words): Look for main points, transitions between ideas, and overall organization.
  - **Closing** (final 10-15% of words): Look for a call to action, memorable ending, or summary.

  ### Heuristic Fallback for Short Transcripts
  If the transcript contains fewer than 120 words, do NOT use percentage-based segmentation. Instead, use heuristic markers to identify sections:
  - Opening markers: "today I want to talk about", "let me tell you", "good morning", "I'm here to"
  - Closing markers: "in conclusion", "to wrap up", "to summarize", "in closing", "my final thought"
  - If no reliable markers are found, return null for that section.

  ### Null Handling
  - If you cannot identify a reliable opening, return null for opening_comment.
  - If you cannot identify a reliable closing, return null for closing_comment.
  - If the body is too short or unclear to comment on, return null for body_comment.
  - It is better to return null than to speculate about structure that is not clearly present.

  ### Commentary Style
  - All structure commentary must be descriptive and observational.
  - Do not include numerical scores, ratings, or percentage-based assessments in structure commentary.
  - Describe what the speaker did, not how you would rate it.
  - Good: "You opened with a personal anecdote that drew the audience in."
  - Bad: "Your opening was 7/10" or "Your opening covered 12% of the speech."`;

      if (qualityWarning) {
        prompt += `

  ## Audio Quality Warning
  The transcript quality appears to be degraded (low word count relative to duration, or low confidence scores). Please:
  - Include an uncertainty qualifier in your opening acknowledging the audio quality limitations, such as: "The audio quality made some parts difficult to catch, so I'll focus on what came through clearly."
  - Reduce claim strength and limit evidence-dependent observations to only clearly audible portions of the transcript.
  - Focus observations on high-confidence transcript segments only (segments where the mean word confidence is 0.7 or above).
  - Do not fabricate content to compensate for gaps in the transcript.
  - Still provide your best evaluation with the available content, but be transparent about limitations.`;
      }

      return prompt;
    }

  private buildUserPrompt(
    transcriptText: string,
    metrics: DeliveryMetrics,
    config?: EvaluationConfig,
    highConfidenceSegments?: TranscriptSegment[],
  ): string {
    let prompt = `## Speech Transcript
${transcriptText}

## Delivery Metrics
${JSON.stringify(metrics, null, 2)}`;

    // When quality warning is active, annotate high-confidence segments (Req 10.2)
    if (highConfidenceSegments && highConfidenceSegments.length > 0) {
      const highConfText = this.buildTranscriptText(highConfidenceSegments);
      prompt += `

## High-Confidence Segments
The following transcript segments have high confidence (mean word confidence ≥ 0.7). Focus your evidence quotes on these segments:
${highConfText}`;
    }

    if (config?.projectType) {
      // Project-Specific Evaluation section REPLACES the Evaluation Objectives section
      // when projectType is provided (Req 5.1, 5.2, 5.5)
      const titlePart = config.speechTitle
        ? ` titled "${config.speechTitle}"`
        : "";
      prompt += `

## Project-Specific Evaluation
This speech is a ${config.projectType} project${titlePart}.`;

      if (config.objectives && config.objectives.length > 0) {
        prompt += `

### Project Objectives
${config.objectives.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
      }

      prompt += `

### Instructions
- Reference the project type and speech title in your opening.
- Include at least one commendation or recommendation that directly addresses a project objective.
- Balance project-specific feedback with general Toastmasters evaluation criteria.
- Project objectives supplement, not replace, evidence-based feedback.`;
    } else if (config?.objectives && config.objectives.length > 0) {
      // Edge case: objectives present but no projectType — preserve existing rendering (Req 5.3)
      prompt += `

## Evaluation Objectives
${config.objectives.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
    }

    prompt += `

Please evaluate this speech following the instructions and output format specified above. Respond with ONLY the JSON object.`;

    return prompt;
  }

  // ── Single-item re-prompt ───────────────────────────────────────────────────

  private buildItemRetryPrompt(
    item: EvaluationItem,
    transcriptText: string,
    issues: string[],
  ): { system: string; user: string } {
    const system = `You are an experienced Toastmasters speech evaluator. You need to fix an evaluation item whose evidence quote could not be verified against the transcript.

## Output Format
Respond with a valid JSON object matching this exact structure:
{
  "type": "${item.type}",
  "summary": "string",
  "evidence_quote": "string (verbatim quote from the transcript, at most 15 words, at least 6 words)",
  "evidence_timestamp": number,
  "explanation": "string"
}

## Evidence Rules
- The evidence_quote MUST be copied VERBATIM from the transcript below.
- It must be at most 15 words and at least 6 words.
- The evidence_timestamp must be the approximate start time in seconds.
- Do NOT paraphrase or invent quotes.`;

    const user = `## Transcript
${transcriptText}

## Original Item (failed validation)
${JSON.stringify(item, null, 2)}

## Validation Issues
${issues.join("\n")}

Please provide a corrected version of this ${item.type} with a valid evidence quote taken verbatim from the transcript. Respond with ONLY the JSON object.`;

    return { system, user };
  }

  // ── LLM call ───────────────────────────────────────────────────────────────

  private async callLLM(prompt: { system: string; user: string }): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LLM returned empty response");
    }
    return content;
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  /**
   * Parse the raw LLM JSON response into a StructuredEvaluation.
   * Throws if the response doesn't match the expected shape.
   */
  private parseEvaluation(raw: string): StructuredEvaluation {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse LLM response as JSON: ${raw.slice(0, 200)}`);
      }

      const obj = parsed as Record<string, unknown>;

      if (typeof obj.opening !== "string") {
        throw new Error("LLM response missing or invalid 'opening' field");
      }
      if (!Array.isArray(obj.items)) {
        throw new Error("LLM response missing or invalid 'items' array");
      }
      if (typeof obj.closing !== "string") {
        throw new Error("LLM response missing or invalid 'closing' field");
      }

      const items: EvaluationItem[] = (obj.items as unknown[]).map(
        (item, index) => this.parseItem(item, index),
      );

      // Parse structure_commentary with graceful defaults
      const structureCommentary = this.parseStructureCommentary(obj.structure_commentary);

      return {
        opening: obj.opening,
        items,
        closing: obj.closing,
        structure_commentary: structureCommentary,
      };
    }

  private parseItem(raw: unknown, index: number): EvaluationItem {
    const item = raw as Record<string, unknown>;
    const prefix = `items[${index}]`;

    if (item.type !== "commendation" && item.type !== "recommendation") {
      throw new Error(`${prefix}: invalid type "${String(item.type)}"`);
    }
    if (typeof item.summary !== "string") {
      throw new Error(`${prefix}: missing or invalid 'summary'`);
    }
    if (typeof item.evidence_quote !== "string") {
      throw new Error(`${prefix}: missing or invalid 'evidence_quote'`);
    }
    if (typeof item.evidence_timestamp !== "number") {
      throw new Error(`${prefix}: missing or invalid 'evidence_timestamp'`);
    }
    if (typeof item.explanation !== "string") {
      throw new Error(`${prefix}: missing or invalid 'explanation'`);
    }

    return {
      type: item.type,
      summary: item.summary,
      evidence_quote: item.evidence_quote,
      evidence_timestamp: item.evidence_timestamp,
      explanation: item.explanation,
    };
  }

  /**
   * Parse the structure_commentary field from the LLM response.
   * Handles missing/null fields gracefully — defaults each sub-field to null.
   */
  private parseStructureCommentary(raw: unknown): StructureCommentary {
    if (!raw || typeof raw !== "object") {
      return { opening_comment: null, body_comment: null, closing_comment: null };
    }

    const obj = raw as Record<string, unknown>;

    return {
      opening_comment: typeof obj.opening_comment === "string" && obj.opening_comment.length > 0
        ? obj.opening_comment
        : null,
      body_comment: typeof obj.body_comment === "string" && obj.body_comment.length > 0
        ? obj.body_comment
        : null,
      closing_comment: typeof obj.closing_comment === "string" && obj.closing_comment.length > 0
        ? obj.closing_comment
        : null,
    };
  }

  // ── Validate and retry pipeline ────────────────────────────────────────────

  /**
   * Validate all items in the evaluation. For items that fail, attempt a
   * single per-item retry. Drop items that still fail after retry.
   *
   * Tracks first-attempt pass/fail per item for pass-rate computation (Req 1.6).
   */
  private async validateAndRetry(
    evaluation: StructuredEvaluation,
    segments: TranscriptSegment[],
    transcriptText: string,
    metrics: DeliveryMetrics,
    qualityWarning: boolean,
    config?: EvaluationConfig,
  ): Promise<ValidateAndRetryResult> {
    const validatedItems: EvaluationItem[] = [];
    const firstAttemptResults: ItemValidationRecord[] = [];

    for (const item of evaluation.items) {
      // Validate this single item
      const singleEval: StructuredEvaluation = {
        opening: evaluation.opening,
        items: [item],
        closing: evaluation.closing,
        structure_commentary: evaluation.structure_commentary,
      };
      const result = this.evidenceValidator.validate(singleEval, segments);

      if (result.valid) {
        validatedItems.push(item);
        firstAttemptResults.push({ item, passedFirstAttempt: true });
        continue;
      }

      // Item failed first attempt — attempt one retry
      firstAttemptResults.push({ item, passedFirstAttempt: false });
      const retried = await this.retryItem(item, transcriptText, result.issues, segments);
      if (retried) {
        validatedItems.push(retried);
      }
      // else: item is dropped
    }

    return {
      evaluation: {
        opening: evaluation.opening,
        items: validatedItems,
        closing: evaluation.closing,
        structure_commentary: evaluation.structure_commentary,
      },
      firstAttemptResults,
      // Count items that are in the final evaluation AND passed on first attempt.
      // Items that passed first attempt are the original items (not retried replacements).
      passedOnFirstAttempt: firstAttemptResults.filter(
        (r) => r.passedFirstAttempt && validatedItems.includes(r.item),
      ).length,
    };
  }

  /**
   * Re-prompt the LLM for a single failed item. Returns the corrected item
   * if it passes validation, or null if the retry also fails.
   */
  private async retryItem(
    item: EvaluationItem,
    transcriptText: string,
    issues: string[],
    segments: TranscriptSegment[],
  ): Promise<EvaluationItem | null> {
    try {
      const prompt = this.buildItemRetryPrompt(item, transcriptText, issues);
      const raw = await this.callLLM(prompt);
      const retriedItem = this.parseItem(JSON.parse(raw), 0);

      // Validate the retried item
      const singleEval: StructuredEvaluation = {
        opening: "",
        items: [retriedItem],
        closing: "",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      };
      const result = this.evidenceValidator.validate(singleEval, segments);

      if (result.valid) {
        return retriedItem;
      }
    } catch {
      // Retry failed — item will be dropped
    }

    return null;
  }

  // ── Shape invariant check ──────────────────────────────────────────────────

  /**
   * Check whether the evaluation meets the shape invariant:
   *  - 2-3 commendations
   *  - 1-2 recommendations
   */
  private meetsShapeInvariant(evaluation: StructuredEvaluation): boolean {
    const commendations = evaluation.items.filter((i) => i.type === "commendation").length;
    const recommendations = evaluation.items.filter((i) => i.type === "recommendation").length;

    return (
      commendations >= MIN_COMMENDATIONS &&
      commendations <= MAX_COMMENDATIONS &&
      recommendations >= MIN_RECOMMENDATIONS &&
      recommendations <= MAX_RECOMMENDATIONS
    );
  }

  // ── Pass-rate computation (Req 1.6) ────────────────────────────────────────

  /**
   * Compute the evidence validation pass rate.
   *
   * passRate = passedOnFirstAttempt / totalDeliveredItems
   *
   * Returns 0 when there are no delivered items (avoids division by zero).
   */
  private computePassRate(passedOnFirstAttempt: number, totalDeliveredItems: number): number {
    if (totalDeliveredItems === 0) return 0;
    return passedOnFirstAttempt / totalDeliveredItems;
  }

  // ── Short-form fallback (Req 9.2, 9.3) ────────────────────────────────────

  /**
   * Build a short-form fallback evaluation when the standard shape invariant
   * cannot be met after exhausting all retry and regeneration attempts.
   *
   * Takes whatever valid items remain from the last validation pass and
   * ensures ≥1 commendation + ≥1 recommendation. Every item in the
   * short-form fallback has already passed evidence validation.
   *
   * Returns null if we don't have enough valid items to meet the short-form
   * minimum (≥1 commendation + ≥1 recommendation).
   */
  private buildShortFormFallback(
    lastResult: ValidateAndRetryResult,
  ): { evaluation: StructuredEvaluation; passedOnFirstAttempt: number } | null {
    const { evaluation, firstAttemptResults } = lastResult;
    const validItems = evaluation.items;

    const commendations = validItems.filter((i) => i.type === "commendation");
    const recommendations = validItems.filter((i) => i.type === "recommendation");

    // Need at least 1 commendation and 1 recommendation for short-form
    if (
      commendations.length < SHORT_FORM_MIN_COMMENDATIONS ||
      recommendations.length < SHORT_FORM_MIN_RECOMMENDATIONS
    ) {
      return null;
    }

    // Take the minimum required items (all valid items that remain)
    const shortFormItems = validItems;

    // Recompute passedOnFirstAttempt for the short-form items
    const passedOnFirstAttempt = firstAttemptResults.filter(
      (r) => r.passedFirstAttempt && shortFormItems.includes(r.item),
    ).length;

    return {
      evaluation: {
        opening: evaluation.opening,
        items: shortFormItems,
        closing: evaluation.closing,
        structure_commentary: evaluation.structure_commentary,
      },
      passedOnFirstAttempt,
    };
  }

  // ── Transcript helpers ─────────────────────────────────────────────────────

  /**
   * Build a plain-text representation of the transcript for the LLM prompt.
   * Includes timestamps for context.
   */
  private buildTranscriptText(segments: TranscriptSegment[]): string {
    return segments
      .map((seg) => {
        const minutes = Math.floor(seg.startTime / 60);
        const seconds = Math.floor(seg.startTime % 60);
        const ts = `${minutes}:${String(seconds).padStart(2, "0")}`;
        return `[${ts}] ${seg.text}`;
      })
      .join("\n");
  }

  /**
   * Assess transcript quality. Returns true if quality is poor.
   *
   * Checks:
   *  - Word count relative to recording duration (flag if < 10 WPM)
   *  - Average word confidence (flag if < 0.5), computed over speech words only
   *    (excluding silence and non-speech markers per Req 10.1)
   */
  private assessTranscriptQuality(
    segments: TranscriptSegment[],
    metrics: DeliveryMetrics,
  ): boolean {
    // Check words per minute
    if (metrics.durationSeconds > 0) {
      const wpm = metrics.totalWords / (metrics.durationSeconds / 60);
      if (wpm < MIN_WORDS_PER_MINUTE) {
        return true;
      }
    }

    // Check average word confidence — exclude silence/non-speech markers
    const allWords = segments.flatMap((s) => s.words);
    const speechWords = allWords.filter((w) => !isSilenceOrNonSpeechMarker(w.word));
    if (speechWords.length > 0) {
      const avgConfidence =
        speechWords.reduce((sum, w) => sum + w.confidence, 0) / speechWords.length;
      if (avgConfidence < MIN_AVERAGE_CONFIDENCE) {
        return true;
      }
    }

    return false;
  }

  // ── Script rendering helpers ───────────────────────────────────────────────

  /**
   * Render a single evaluation item into a natural spoken paragraph.
   * Weaves the evidence quote into the explanation naturally.
   */
  private renderItemSection(item: EvaluationItem): string {
    const typeLabel = item.type === "commendation"
      ? "Something that really stood out was"
      : "One area to consider for growth is";

    return `${typeLabel} ${item.summary.toLowerCase()}. When you said, "${item.evidence_quote}", ${item.explanation}`;
  }

  /**
   * Apply [[Q:item-N]] and [[M:fieldName]] markers to a rendered item section.
   *
   * Markers are placed after terminal punctuation, before following whitespace.
   * A sentence gets a [[Q:item-N]] marker if it contains the evidence quote text.
   * A sentence gets [[M:fieldName]] markers for each metrics field it references.
   * Multiple markers may appear on the same sentence.
   */
  private applyMarkers(
    section: string,
    itemIndex: number,
    item: EvaluationItem,
    metrics?: DeliveryMetrics,
  ): string {
    const sentences = splitSentences(section);
    if (sentences.length === 0) return section;

    // Normalize the evidence quote for fuzzy matching within sentences
    const quoteNormalized = item.evidence_quote.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

    const markedSentences = sentences.map((sentence) => {
      let markers = "";

      // Check if this sentence contains the evidence quote
      const sentenceNormalized = sentence.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
      if (quoteNormalized.length > 0 && sentenceNormalized.includes(quoteNormalized)) {
        markers += `[[Q:item-${itemIndex}]]`;
      }

      // Check if this sentence references any metrics fields
      if (metrics) {
        const sentenceLower = sentence.toLowerCase();
        const matchedFields = new Set<string>();
        for (const [keyword, fieldName] of Object.entries(METRICS_KEYWORDS)) {
          if (sentenceLower.includes(keyword) && !matchedFields.has(fieldName)) {
            matchedFields.add(fieldName);
          }
        }
        for (const fieldName of matchedFields) {
          markers += `[[M:${fieldName}]]`;
        }
      }

      if (markers.length === 0) return sentence;

      // Place markers after terminal punctuation, before following whitespace
      // Find the last terminal punctuation character
      const terminalMatch = sentence.match(/[.!?][.!?]*$/);
      if (terminalMatch) {
        // Insert markers right after the terminal punctuation
        return sentence + markers;
      }

      // No terminal punctuation — append markers at the end
      return sentence + markers;
    });

    // Reconstruct the section by replacing original sentences with marked ones.
    // We need to preserve the original whitespace structure between sentences.
    let result = section;
    for (let i = 0; i < sentences.length; i++) {
      if (markedSentences[i] !== sentences[i]) {
        result = result.replace(sentences[i], markedSentences[i]);
      }
    }

    return result;
  }

  /**
   * Redact third-party names from the rendered script for TTS delivery.
   *
   * Per privacy steering rules:
   *  - Third-party names should be replaced with "[a fellow member]"
   *  - The speaker's own name (if provided) is NOT redacted
   *
   * This is a best-effort heuristic: we look for capitalized words that
   * appear to be proper names (2+ consecutive capitalized words, or single
   * capitalized words not at sentence start) and replace them.
   *
   * Note: In a production system this would use NER. For MVP, we apply
   * a conservative approach — the LLM is instructed not to include names,
   * and this serves as a safety net.
   */
  /**
     * Internal helper: redact third-party names in a text string.
     * Uses a best-effort heuristic: capitalized words mid-sentence that look like
     * proper person names are replaced with "a fellow member".
     *
     * Conservative: does not redact uncertain entities (places, orgs, brands).
     * Preserves the speaker's own name.
     */
    private redactThirdPartyNames(script: string, speakerName?: string): string {
      if (!speakerName) {
        // Without a speaker name, we can't distinguish speaker from third-party.
        // Return as-is; the LLM prompt already instructs against including names.
        return script;
      }

      return this.redactText(script, speakerName);
    }

    /**
     * Core redaction logic: replaces third-party private individual names with
     * "a fellow member" in the given text. Speaker's own name is preserved.
     *
     * Conservative heuristic:
     * - Only redacts capitalized words that appear mid-sentence (not sentence-start)
     * - Skips common non-name capitalized words (places, orgs, brands, common English words)
     * - Skips words that match any token in the speaker's name
     * - Does NOT redact uncertain entities
     */
    private redactText(text: string, speakerName: string): string {
      // Build a set of speaker name tokens to preserve (case-insensitive)
      const speakerTokens = new Set(
        speakerName.toLowerCase().split(/\s+/).filter(Boolean),
      );

      // Common capitalized words that are NOT person names — conservative exclusion list
      const nonNameWords = new Set([
        // Common English words that may appear capitalized
        "i", "the", "a", "an", "this", "that", "these", "those",
        "my", "your", "his", "her", "its", "our", "their",
        // Days, months
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
        "january", "february", "march", "april", "may", "june", "july",
        "august", "september", "october", "november", "december",
        // Common place/org indicators — if the word is one of these, skip
        "toastmasters", "club", "university", "college", "school", "church",
        "hospital", "company", "corporation", "inc", "llc", "ltd",
        "street", "avenue", "road", "boulevard", "park", "city", "town",
        "state", "country", "america", "american", "english", "spanish",
        "french", "german", "chinese", "japanese", "african", "european",
        "asian", "christian", "muslim", "jewish", "buddhist",
        // Common words that start sentences or appear after quotes
        "one", "next", "first", "second", "third", "also", "however",
        "overall", "finally", "additionally", "furthermore", "meanwhile",
        "something", "when", "where", "what", "who", "how", "why",
        "thank", "thanks", "great", "good", "well", "keep",
      ]);

      const sentences = text.split(/(?<=[.!?])\s+/);
      const redacted = sentences.map((sentence) => {
        // Replace potential third-party names (capitalized words mid-sentence)
        return sentence.replace(
          /(?<=\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
          (match) => {
            const matchTokens = match.toLowerCase().split(/\s+/);

            // If any token matches the speaker name, preserve it
            if (matchTokens.some((t) => speakerTokens.has(t))) {
              return match;
            }

            // If all tokens are in the non-name exclusion list, preserve (conservative)
            if (matchTokens.every((t) => nonNameWords.has(t))) {
              return match;
            }

            return "a fellow member";
          },
        );
      });

      return redacted.join(" ");
    }

    /**
     * Public redaction method (Pipeline Stage 8).
     *
     * Redacts third-party private individual names from both the script and
     * the structured evaluation, producing:
     * - `scriptRedacted`: the script with names replaced by "a fellow member"
     * - `evaluationPublic`: a StructuredEvaluationPublic with redacted evidence quotes
     *
     * The replacement phrase "a fellow member" is identical across scriptRedacted
     * and evaluationPublic.items[*].evidence_quote.
     *
     * Conservative: does not redact uncertain entities (places, orgs, brands).
     * Preserves the speaker's own name (from consent.speakerName).
     *
     * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
     */
    redact(input: RedactionInput): RedactionOutput {
      const { script, evaluation, consent } = input;
      const speakerName = consent.speakerName;

      // Redact the script
      const scriptRedacted = this.redactText(script, speakerName);

      // Redact the evaluation to produce the public version
      // All user-visible text fields must be redacted (Req 8.4)
      const publicItems: EvaluationItemPublic[] = evaluation.items.map((item) => ({
        type: item.type,
        summary: this.redactText(item.summary, speakerName),
        explanation: this.redactText(item.explanation, speakerName),
        evidence_quote: this.redactText(item.evidence_quote, speakerName),
        evidence_timestamp: item.evidence_timestamp,
      }));

      const evaluationPublic: StructuredEvaluationPublic = {
        opening: this.redactText(evaluation.opening, speakerName),
        items: publicItems,
        closing: this.redactText(evaluation.closing, speakerName),
        structure_commentary: evaluation.structure_commentary,
      };

      return { scriptRedacted, evaluationPublic };
    }

    // ── Consistency Monitoring Telemetry (Req 7.1, 7.3, 7.4, 7.5) ────────────

    /**
     * Retrieve an embedding vector for the given text using the configured
     * embedding model. Returns null if the embeddings API is not available.
     *
     * This is a separate method to allow mocking in tests.
     */
    async getEmbedding(text: string): Promise<number[] | null> {
      if (!this.openai.embeddings) {
        return null;
      }
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      });
      if (response.data.length === 0) {
        return null;
      }
      return response.data[0].embedding;
    }

    /**
     * Log consistency telemetry for the given evaluation.
     *
     * This method is async and non-blocking — it MUST NOT block or modify
     * evaluation delivery (Design Decision #7). Errors are caught and logged,
     * never thrown.
     *
     * Behavior:
     * - Extracts item summaries from the evaluation
     * - Computes an embedding using the fixed EMBEDDING_MODEL
     * - If a previous evaluation's embedding is cached, computes cosine similarity
     * - Logs the similarity score (threshold: 0.75 per Req 7.3)
     * - Caches the current embedding for future comparison
     *
     * Requirements: 7.1, 7.3, 7.4, 7.5
     */
    async logConsistencyTelemetry(evaluation: StructuredEvaluation): Promise<void> {
      try {
        // Extract summaries from all items to form a single text for embedding
        const summaries = evaluation.items.map((item) => item.summary).join(". ");

        // Get embedding using the fixed model (Req 7.5)
        const embedding = await this.getEmbedding(summaries);

        if (!embedding) {
          console.log("[ConsistencyTelemetry] Embeddings API not available, skipping consistency check");
          return;
        }

        // Compare with previous evaluation's embedding if available
        if (this.lastEmbedding) {
          const similarity = cosineSimilarity(this.lastEmbedding, embedding);
          const meetsThreshold = similarity >= CONSISTENCY_SIMILARITY_THRESHOLD;
          console.log(
            `[ConsistencyTelemetry] Summary similarity: ${similarity.toFixed(4)} (threshold: ${CONSISTENCY_SIMILARITY_THRESHOLD}, meets: ${meetsThreshold})`,
          );
        } else {
          console.log("[ConsistencyTelemetry] First evaluation — no previous embedding to compare");
        }

        // Cache current embedding for next comparison
        this.lastEmbedding = embedding;
      } catch (err) {
        // Non-blocking: log and continue — never throw (Design Decision #7)
        console.warn("[ConsistencyTelemetry] Failed to compute consistency:", err);
      }
    }
}
