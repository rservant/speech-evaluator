// AI Toastmasters Evaluator - File Persistence
// Opt-in saving of session outputs to disk.
// Requirements: 6.1 (save transcript), 6.2 (save metrics), 6.3 (save evaluation), 6.4 (timestamp naming)
//
// Privacy: Persistence is opt-in only. Files are only written when the Operator
// clicks "Save Outputs". Session data lives in server memory only until then.
// Once saved, the files are the operator's responsibility.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session, TranscriptSegment, DeliveryMetrics, StructuredEvaluation } from "./types.js";

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
 * Header includes: date, session ID, duration, speaker name (if provided).
 * Body uses the evaluationScript if available, otherwise renders from StructuredEvaluation.
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

  if (session.speakerName) {
    lines.push(`Speaker: ${session.speakerName}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Body: prefer evaluationScript, fall back to rendering StructuredEvaluation
  if (session.evaluationScript) {
    lines.push(session.evaluationScript);
  } else if (session.evaluation) {
    lines.push(renderEvaluationText(session.evaluation));
  }

  return lines.join("\n");
}

/**
 * Renders a StructuredEvaluation into plain text when no evaluationScript is available.
 */
function renderEvaluationText(evaluation: StructuredEvaluation): string {
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
    if (session.ttsAudioCache) {
      try {
        const audioPath = join(dirPath, "evaluation_audio.mp3");
        await writeFile(audioPath, session.ttsAudioCache);
        savedPaths.push(audioPath);
      } catch (err) {
        console.warn("Failed to save TTS audio file:", err);
      }
    }

    // Mark session as saved
    session.outputsSaved = true;

    return savedPaths;
  }
}
