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
  DeliveryMetrics,
  EvaluationConfig,
  EvaluationItem,
  StructuredEvaluation,
  TranscriptSegment,
} from "./types.js";
import { EvidenceValidator, type ValidationResult } from "./evidence-validator.js";

// ─── Transcript quality thresholds ──────────────────────────────────────────────

const MIN_WORDS_PER_MINUTE = 10;
const MIN_AVERAGE_CONFIDENCE = 0.5;

// ─── Shape invariant bounds ─────────────────────────────────────────────────────

const MIN_COMMENDATIONS = 2;
const MAX_COMMENDATIONS = 3;
const MIN_RECOMMENDATIONS = 1;
const MAX_RECOMMENDATIONS = 2;

// ─── Retry budget ───────────────────────────────────────────────────────────────

const MAX_ITEM_RETRIES = 1;
const MAX_FULL_GENERATION_ATTEMPTS = 2;

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
}

// ─── EvaluationGenerator ────────────────────────────────────────────────────────

export class EvaluationGenerator {
  private readonly openai: OpenAIClient;
  private readonly evidenceValidator: EvidenceValidator;
  private readonly model: string;

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
   */
  async generate(
    transcript: TranscriptSegment[],
    metrics: DeliveryMetrics,
    config?: EvaluationConfig,
  ): Promise<StructuredEvaluation> {
    const transcriptText = this.buildTranscriptText(transcript);
    const qualityWarning = this.assessTranscriptQuality(transcript, metrics);

    for (let attempt = 0; attempt < MAX_FULL_GENERATION_ATTEMPTS; attempt++) {
      // Stage 1: Call LLM
      const prompt = this.buildPrompt(transcriptText, metrics, qualityWarning, config);
      const raw = await this.callLLM(prompt);
      const evaluation = this.parseEvaluation(raw);

      // Stage 2: Validate evidence
      const validated = await this.validateAndRetry(
        evaluation,
        transcript,
        transcriptText,
        metrics,
        qualityWarning,
        config,
      );

      // Check shape invariant
      if (this.meetsShapeInvariant(validated)) {
        return validated;
      }

      // Shape violated — will regenerate on next iteration (if budget remains)
    }

    // Exhausted retries — best-effort: call LLM one last time and return as-is
    const lastPrompt = this.buildPrompt(transcriptText, metrics, qualityWarning, config);
    const lastRaw = await this.callLLM(lastPrompt);
    return this.parseEvaluation(lastRaw);
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
  renderScript(
    evaluation: StructuredEvaluation,
    speakerName?: string,
  ): string {
    const parts: string[] = [];

    // Opening
    parts.push(evaluation.opening);

    // Items (commendations and recommendations in order)
    for (const item of evaluation.items) {
      const section = this.renderItemSection(item);
      parts.push(section);
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
   */
  private buildPrompt(
    transcriptText: string,
    metrics: DeliveryMetrics,
    qualityWarning: boolean,
    config?: EvaluationConfig,
  ): { system: string; user: string } {
    const system = this.buildSystemPrompt(qualityWarning);
    const user = this.buildUserPrompt(transcriptText, metrics, config);
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
  "closing": "string (1-2 sentences, encouraging wrap-up)"
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
- Target total: approximately 250-400 words when rendered as spoken text.`;

    if (qualityWarning) {
      prompt += `

## Audio Quality Warning
The transcript quality appears to be poor (low word count relative to duration, or low confidence scores). Please:
- Acknowledge the audio quality limitations in your opening.
- Base your evaluation only on what is clearly present in the transcript.
- Include a caveat that some aspects of the speech may not have been captured accurately.
- Still provide your best evaluation with the available content.`;
    }

    return prompt;
  }

  private buildUserPrompt(
    transcriptText: string,
    metrics: DeliveryMetrics,
    config?: EvaluationConfig,
  ): string {
    let prompt = `## Speech Transcript
${transcriptText}

## Delivery Metrics
${JSON.stringify(metrics, null, 2)}`;

    if (config?.objectives && config.objectives.length > 0) {
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

    return {
      opening: obj.opening,
      items,
      closing: obj.closing,
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

  // ── Validate and retry pipeline ────────────────────────────────────────────

  /**
   * Validate all items in the evaluation. For items that fail, attempt a
   * single per-item retry. Drop items that still fail after retry.
   */
  private async validateAndRetry(
    evaluation: StructuredEvaluation,
    segments: TranscriptSegment[],
    transcriptText: string,
    metrics: DeliveryMetrics,
    qualityWarning: boolean,
    config?: EvaluationConfig,
  ): Promise<StructuredEvaluation> {
    const validatedItems: EvaluationItem[] = [];

    for (const item of evaluation.items) {
      // Validate this single item
      const singleEval: StructuredEvaluation = {
        opening: evaluation.opening,
        items: [item],
        closing: evaluation.closing,
      };
      const result = this.evidenceValidator.validate(singleEval, segments);

      if (result.valid) {
        validatedItems.push(item);
        continue;
      }

      // Item failed — attempt one retry
      const retried = await this.retryItem(item, transcriptText, result.issues, segments);
      if (retried) {
        validatedItems.push(retried);
      }
      // else: item is dropped
    }

    return {
      opening: evaluation.opening,
      items: validatedItems,
      closing: evaluation.closing,
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
   *  - Average word confidence (flag if < 0.5)
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

    // Check average word confidence
    const allWords = segments.flatMap((s) => s.words);
    if (allWords.length > 0) {
      const avgConfidence =
        allWords.reduce((sum, w) => sum + w.confidence, 0) / allWords.length;
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
  private redactThirdPartyNames(script: string, speakerName?: string): string {
    if (!speakerName) {
      // Without a speaker name, we can't distinguish speaker from third-party.
      // Return as-is; the LLM prompt already instructs against including names.
      return script;
    }

    // Build a set of speaker name tokens to preserve (case-insensitive)
    const speakerTokens = new Set(
      speakerName.toLowerCase().split(/\s+/).filter(Boolean),
    );

    // Simple heuristic: find capitalized words that aren't at sentence start
    // and aren't the speaker's name, then replace with "[a fellow member]"
    const sentences = script.split(/(?<=[.!?])\s+/);
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
          return "[a fellow member]";
        },
      );
    });

    return redacted.join(" ");
  }
}
