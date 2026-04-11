/**
 * Markdown Evaluation Export (#164)
 *
 * Pure function module that generates a formatted Markdown report from
 * evaluation data. All inputs are deserialized GCS evaluation files.
 *
 * No side effects — suitable for unit testing without mocks.
 */

import type {
  StructuredEvaluation,
  DeliveryMetrics,
  TranscriptSegment,
  MeetingRecord,
} from "./types.js";
import type { EvaluationMetadata } from "./gcs-history.js";

// ─── Input Type ─────────────────────────────────────────────────────────────────

export interface MarkdownExportInput {
  metadata: EvaluationMetadata;
  evaluation: StructuredEvaluation;
  metrics: DeliveryMetrics;
  transcript: TranscriptSegment[];
}

// ─── Generator ──────────────────────────────────────────────────────────────────

/**
 * Generate a formatted Markdown report from evaluation data.
 *
 * Report structure:
 * 1. Header with speaker name, date, speech title
 * 2. Metrics summary table
 * 3. Category scores table (if available)
 * 4. Evaluation items (commendations + recommendations)
 * 5. Structure commentary (if available)
 * 6. Transcript
 */
export function generateMarkdownReport(input: MarkdownExportInput): string {
  const { metadata, evaluation, metrics, transcript } = input;
  const parts: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  const date = new Date(metadata.date);
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  parts.push(`# Speech Evaluation Report`);
  parts.push(``);
  parts.push(`**Speaker:** ${metadata.speakerName}`);
  parts.push(`**Title:** ${metadata.speechTitle}`);
  parts.push(`**Date:** ${dateStr}`);
  if (metadata.projectType) {
    parts.push(`**Project Type:** ${metadata.projectType}`);
  }
  parts.push(`**Mode:** ${metadata.mode}`);
  parts.push(``);
  parts.push(`---`);

  // ── Metrics Summary ─────────────────────────────────────────────────────────
  parts.push(``);
  parts.push(`## Delivery Metrics`);
  parts.push(``);
  parts.push(`| Metric | Value |`);
  parts.push(`|--------|-------|`);
  parts.push(`| Duration | ${metrics.durationFormatted} |`);
  parts.push(`| Words Per Minute | ${metrics.wordsPerMinute} |`);
  parts.push(`| Total Words | ${metrics.totalWords} |`);
  parts.push(`| Filler Words | ${metrics.fillerWordCount} (${(metrics.fillerWordFrequency * 100).toFixed(1)}%) |`);
  parts.push(`| Pauses | ${metrics.pauseCount} (${metrics.totalPauseDurationSeconds.toFixed(1)}s total) |`);

  if (metrics.intentionalPauseCount > 0 || metrics.hesitationPauseCount > 0) {
    parts.push(`| Intentional Pauses | ${metrics.intentionalPauseCount} |`);
    parts.push(`| Hesitation Pauses | ${metrics.hesitationPauseCount} |`);
  }

  if (metadata.passRate > 0) {
    parts.push(`| Evidence Pass Rate | ${(metadata.passRate * 100).toFixed(0)}% |`);
  }

  // ── Category Scores ─────────────────────────────────────────────────────────
  if (evaluation.category_scores && evaluation.category_scores.length > 0) {
    parts.push(``);
    parts.push(`## Category Scores`);
    parts.push(``);
    parts.push(`| Category | Score | Rationale |`);
    parts.push(`|----------|-------|-----------|`);
    for (const cat of evaluation.category_scores) {
      parts.push(`| ${capitalize(cat.category)} | ${cat.score}/10 | ${cat.rationale} |`);
    }
  }

  // ── Evaluation ──────────────────────────────────────────────────────────────
  parts.push(``);
  parts.push(`## Evaluation`);
  parts.push(``);
  parts.push(`> ${evaluation.opening}`);

  // Structure commentary
  const commentary = evaluation.structure_commentary;
  if (commentary) {
    const commentaryParts: string[] = [];
    if (commentary.opening_comment) commentaryParts.push(commentary.opening_comment);
    if (commentary.body_comment) commentaryParts.push(commentary.body_comment);
    if (commentary.closing_comment) commentaryParts.push(commentary.closing_comment);
    if (commentaryParts.length > 0) {
      parts.push(``);
      parts.push(`### Structure Commentary`);
      parts.push(``);
      for (const c of commentaryParts) {
        parts.push(c);
        parts.push(``);
      }
    }
  }

  // Commendations
  const commendations = evaluation.items.filter(i => i.type === "commendation");
  if (commendations.length > 0) {
    parts.push(``);
    parts.push(`### Commendations`);
    parts.push(``);
    for (const item of commendations) {
      parts.push(`#### ✅ ${item.summary}`);
      parts.push(``);
      parts.push(`> "${item.evidence_quote}"`);
      parts.push(``);
      parts.push(item.explanation);
      parts.push(``);
    }
  }

  // Recommendations
  const recommendations = evaluation.items.filter(i => i.type === "recommendation");
  if (recommendations.length > 0) {
    parts.push(``);
    parts.push(`### Recommendations`);
    parts.push(``);
    for (const item of recommendations) {
      parts.push(`#### 💡 ${item.summary}`);
      parts.push(``);
      parts.push(`> "${item.evidence_quote}"`);
      parts.push(``);
      parts.push(item.explanation);
      parts.push(``);
    }
  }

  // Visual feedback
  if (evaluation.visual_feedback && evaluation.visual_feedback.length > 0) {
    parts.push(``);
    parts.push(`### Visual Feedback`);
    parts.push(``);
    for (const vf of evaluation.visual_feedback) {
      parts.push(`- **${vf.summary}**: ${vf.explanation}`);
    }
    parts.push(``);
  }

  // Closing
  parts.push(`> ${evaluation.closing}`);

  // ── Transcript ──────────────────────────────────────────────────────────────
  if (transcript.length > 0) {
    parts.push(``);
    parts.push(`---`);
    parts.push(``);
    parts.push(`## Transcript`);
    parts.push(``);
    for (const seg of transcript) {
      if (seg.text.trim()) {
        const timeLabel = formatTime(seg.startTime);
        const speakerLabel = (seg as unknown as { speaker?: string }).speaker
          ? `**${(seg as unknown as { speaker: string }).speaker}**: `
          : "";
        parts.push(`\`${timeLabel}\` ${speakerLabel}${seg.text.trim()}`);
        parts.push(``);
      }
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  parts.push(`---`);
  parts.push(``);
  parts.push(`*Generated by Speech Evaluator*`);

  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// ─── Meeting Export (#177) ────────────────────────────────────────────────────

export interface MeetingMarkdownExportInput {
  meeting: MeetingRecord;
  evaluations: MarkdownExportInput[];
}

/**
 * Generate a combined Markdown report for an entire meeting.
 * Includes meeting header, table of contents, and per-speaker sections.
 */
export function generateMeetingMarkdownReport(input: MeetingMarkdownExportInput): string {
  const { meeting, evaluations } = input;
  const parts: string[] = [];

  const dateStr = new Date(meeting.meetingDate).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  parts.push(`# Meeting Evaluation Report`);
  parts.push(``);
  if (meeting.clubName) {
    parts.push(`**Club:** ${meeting.clubName}`);
  }
  parts.push(`**Date:** ${dateStr}`);
  parts.push(`**Speakers:** ${evaluations.length}`);
  parts.push(``);

  // Table of contents
  if (evaluations.length > 0) {
    parts.push(`## Speakers`);
    parts.push(``);
    for (let i = 0; i < evaluations.length; i++) {
      const e = evaluations[i];
      parts.push(`${i + 1}. **${e.metadata.speakerName}** — ${e.metadata.speechTitle}`);
    }
    parts.push(``);
    parts.push(`---`);
  }

  // Per-speaker evaluations
  for (const evaluation of evaluations) {
    parts.push(``);
    parts.push(generateMarkdownReport(evaluation));
    parts.push(``);
    parts.push(`---`);
  }

  return parts.join("\n");
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
