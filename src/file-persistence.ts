// AI Toastmasters Evaluator - File Persistence
// Opt-in saving of session outputs to disk.
// Requirements: 6.1 (save transcript), 6.2 (save metrics), 6.3 (save evaluation), 6.4 (timestamp naming)
//
// Privacy: Persistence is opt-in only. Files are only written when the Operator
// clicks "Save Outputs". Session data lives in server memory only until then.
// Once saved, the files are the operator's responsibility.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session, TranscriptSegment, DeliveryMetrics, StructuredEvaluation, StructuredEvaluationPublic, ConsentRecord } from "./types.js";

/**
 * Formats a number of seconds into `[MM:SS]` timestamp format.
 */
export function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `[${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}]`;
}

/**
 * Renders transcript segments into the transcript.txt format:
 *   [MM:SS] Segment text here...
 */
export function formatTranscript(segments: TranscriptSegment[]): string {
  if (segments.length === 0) {
    return "";
  }

  return segments
    .map((segment) => `${formatTimestamp(segment.startTime)} ${segment.text}`)
    .join("\n");
}

/**
 * Serializes DeliveryMetrics to a pretty-printed JSON string.
 */
export function formatMetrics(metrics: DeliveryMetrics): string {
  return JSON.stringify(metrics, null, 2);
}

/**
 * Renders the evaluation.txt content with a session metadata header
 * followed by the evaluation text.
 *
 * Header includes: date, session ID, duration, speaker name (from consent if available),
 * and consent metadata (confirmed status, timestamp).
 * Body uses the evaluationScript if available, otherwise renders from
 * evaluationPublic (redacted) or evaluation (internal) as fallback.
 *
 * Phase 2 changes (Req 2.6, 8.4):
 * - Speaker name sourced from session.consent?.speakerName
 * - Consent metadata included in header
 * - evaluationPublic used for structured rendering (never saves internal unredacted evaluation)
 */
export function formatEvaluation(session: Session): string {
  const lines: string[] = [];

  // Header
  lines.push("=== Toastmasters Speech Evaluation ===");
  lines.push("");

  const date = session.stoppedAt ?? session.startedAt ?? new Date();
  lines.push(`Date: ${date.toISOString().split("T")[0]}`);
  lines.push(`Session ID: ${session.id}`);

  if (session.metrics) {
    lines.push(`Duration: ${session.metrics.durationFormatted}`);
  }

  // Use consent.speakerName as the primary source (Phase 2), fall back to deprecated speakerName
  const speakerName = session.consent?.speakerName ?? session.speakerName;
  if (speakerName) {
    lines.push(`Speaker: ${speakerName}`);
  }

  // Include consent metadata in header (Req 2.6)
  if (session.consent) {
    lines.push(`Consent: ${session.consent.consentConfirmed ? "Confirmed" : "Not Confirmed"}`);
    const ts = session.consent.consentTimestamp;
    const tsStr = ts instanceof Date && !isNaN(ts.getTime()) ? ts.toISOString() : "N/A";
    lines.push(`Consent Timestamp: ${tsStr}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Body: prefer evaluationScript, fall back to rendering StructuredEvaluation
  // When rendering from structured data, use evaluationPublic (redacted) if available (Req 8.4)
  if (session.evaluationScript) {
    lines.push(session.evaluationScript);
  } else if (session.evaluationPublic) {
    lines.push(renderEvaluationText(session.evaluationPublic));
  } else if (session.evaluation) {
    lines.push(renderEvaluationText(session.evaluation));
  }

  return lines.join("\n");
}

/**
 * Renders a StructuredEvaluation or StructuredEvaluationPublic into plain text
 * when no evaluationScript is available.
 * Both types share the same shape (opening, items, closing) so this function
 * accepts either.
 */
function renderEvaluationText(evaluation: StructuredEvaluation | StructuredEvaluationPublic): string {
  const parts: string[] = [];

  parts.push(evaluation.opening);
  parts.push("");

  for (const item of evaluation.items) {
    const label = item.type === "commendation" ? "Commendation" : "Recommendation";
    parts.push(`${label}: ${item.summary}`);
    parts.push(`  "${item.evidence_quote}"`);
    parts.push(`  ${item.explanation}`);
    parts.push("");
  }

  parts.push(evaluation.closing);

  return parts.join("\n");
}

/**
 * Generates the output directory name from a session.
 * Format: `{YYYY-MM-DD_HH-mm-ss}_{sessionId}`
 */
export function buildDirectoryName(session: Session): string {
  const date = session.startedAt ?? new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  return `${timestamp}_${session.id}`;
}

/**
 * FilePersistence handles opt-in saving of session outputs to disk.
 *
 * Output directory structure:
 *   {baseDir}/{YYYY-MM-DD_HH-mm-ss}_{sessionId}/
 *     transcript.txt
 *     metrics.json
 *     evaluation.txt
 */
export class FilePersistence {
  private baseDir: string;

  constructor(baseDir: string = "output") {
    this.baseDir = baseDir;
  }

  /**
   * Saves session outputs to disk. Only called when the Operator clicks "Save Outputs".
   *
   * Creates a timestamped directory containing:
   * - transcript.txt: Full transcript with [MM:SS] timestamps
   * - metrics.json: Serialized DeliveryMetrics
   * - evaluation.txt: Session metadata header + evaluation text
   *
   * Sets session.outputsSaved = true after successful save.
   *
   * @returns Array of file paths that were written.
   */
  async saveSession(session: Session): Promise<string[]> {
    const dirName = buildDirectoryName(session);
    const dirPath = join(this.baseDir, dirName);

    await mkdir(dirPath, { recursive: true });

    const savedPaths: string[] = [];

    // Write transcript.txt
    const transcriptPath = join(dirPath, "transcript.txt");
    const transcriptContent = formatTranscript(session.transcript);
    await writeFile(transcriptPath, transcriptContent, "utf-8");
    savedPaths.push(transcriptPath);

    // Write metrics.json
    const metricsPath = join(dirPath, "metrics.json");
    const metricsContent = session.metrics
      ? formatMetrics(session.metrics)
      : "{}";
    await writeFile(metricsPath, metricsContent, "utf-8");
    savedPaths.push(metricsPath);

    // Write evaluation.txt
    const evaluationPath = join(dirPath, "evaluation.txt");
    const evaluationContent = formatEvaluation(session);
    await writeFile(evaluationPath, evaluationContent, "utf-8");
    savedPaths.push(evaluationPath);

    // Write evaluation_audio.mp3 (if TTS audio was cached)
    // Check ttsAudioCache first, then fall back to evaluationCache.ttsAudio
    // (eager-cache-hit delivery path stores audio in evaluationCache.ttsAudio rather than ttsAudioCache)
    const ttsAudioBuffer = session.ttsAudioCache ?? session.evaluationCache?.ttsAudio ?? null;
    if (ttsAudioBuffer) {
      try {
        const audioPath = join(dirPath, "evaluation_audio.mp3");
        await writeFile(audioPath, ttsAudioBuffer);
        savedPaths.push(audioPath);
      } catch (err) {
        console.warn("Failed to save TTS audio file:", err);
      }
    }

    // Write consent.json (if consent record exists) — Req 2.6
    // Serializes the ConsentRecord for round-trip verification (Property 3)
    if (session.consent) {
      const consentPath = join(dirPath, "consent.json");
      const ts = session.consent.consentTimestamp;
      const tsStr = ts instanceof Date && !isNaN(ts.getTime()) ? ts.toISOString() : null;
      const consentContent = JSON.stringify({
        speakerName: session.consent.speakerName,
        consentConfirmed: session.consent.consentConfirmed,
        consentTimestamp: tsStr,
      }, null, 2);
      await writeFile(consentPath, consentContent, "utf-8");
      savedPaths.push(consentPath);
    }

    // Write project-context.json (if project context exists) — Req 5.4
    if (session.projectContext) {
      const projectContextPath = join(dirPath, "project-context.json");
      const projectContextContent = JSON.stringify({
        speechTitle: session.projectContext.speechTitle,
        projectType: session.projectContext.projectType,
        objectives: session.projectContext.objectives,
      }, null, 2);
      await writeFile(projectContextPath, projectContextContent, "utf-8");
      savedPaths.push(projectContextPath);
    }

    // Mark session as saved
    session.outputsSaved = true;

    return savedPaths;
  }
}
