// Property-Based Tests for FilePersistence
// Feature: ai-toastmasters-evaluator, Property 10: Session Output File Round-Trip

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FilePersistence,
  buildDirectoryName,
  formatTranscript,
  formatMetrics,
  formatEvaluation,
} from "./file-persistence.js";
import type {
  Session,
  TranscriptSegment,
  DeliveryMetrics,
  StructuredEvaluation,
  EvaluationItem,
  FillerWordEntry,
} from "./types.js";
import { SessionState } from "./types.js";

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a non-empty string of words without newlines.
 * Transcript.txt uses newlines as delimiters, so segment text must not contain them.
 */
function arbitrarySegmentText(): fc.Arbitrary<string> {
  return fc
    .array(
      fc.constantFrom(
        "hello", "world", "today", "we", "discuss", "leadership",
        "the", "first", "point", "is", "about", "communication",
        "in", "conclusion", "thank", "you", "everyone", "great",
        "speech", "ideas", "people", "think", "important", "forward",
        "together", "community", "project", "meeting", "really", "going"
      ),
      { minLength: 1, maxLength: 12 }
    )
    .map((words) => words.join(" "));
}

/**
 * Generate a positive finite double suitable for numeric metric fields.
 */
function arbitraryPositiveFinite(max: number = 10000): fc.Arbitrary<number> {
  return fc.double({ min: 0, max, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generate a strictly positive finite double (> 0).
 */
function arbitraryStrictlyPositiveFinite(max: number = 10000): fc.Arbitrary<number> {
  return fc.double({ min: 0.01, max, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generate a FillerWordEntry with valid data.
 */
function arbitraryFillerWordEntry(): fc.Arbitrary<FillerWordEntry> {
  return fc
    .tuple(
      fc.constantFrom("um", "uh", "ah", "like", "so", "basically", "right", "actually"),
      fc.integer({ min: 1, max: 20 })
    )
    .chain(([word, count]) =>
      fc
        .array(arbitraryPositiveFinite(1500), { minLength: count, maxLength: count })
        .map((timestamps) => ({ word, count, timestamps }))
    );
}

/**
 * Generate a valid DeliveryMetrics object with internally consistent values.
 * All numeric fields are finite positive numbers.
 */
function arbitraryDeliveryMetrics(): fc.Arbitrary<DeliveryMetrics> {
  return fc
    .tuple(
      arbitraryStrictlyPositiveFinite(1500),  // durationSeconds
      fc.integer({ min: 1, max: 5000 }),       // totalWords
      fc.array(arbitraryFillerWordEntry(), { minLength: 0, maxLength: 5 }),
      fc.integer({ min: 0, max: 50 }),          // pauseCount
      arbitraryPositiveFinite(300)              // totalPauseDurationSeconds
    )
    .map(([durationSeconds, totalWords, fillerWords, pauseCount, totalPauseDurationSeconds]) => {
      const durationMinutes = durationSeconds / 60;
      const wordsPerMinute = totalWords / durationMinutes;
      const fillerWordCount = fillerWords.reduce((sum, e) => sum + e.count, 0);
      const fillerWordFrequency = durationMinutes > 0 ? fillerWordCount / durationMinutes : 0;
      const averagePauseDurationSeconds = pauseCount > 0 ? totalPauseDurationSeconds / pauseCount : 0;

      // Format duration as M:SS
      const totalSecs = Math.floor(durationSeconds);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      const durationFormatted = `${mins}:${String(secs).padStart(2, "0")}`;

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
    });
}

/**
 * Generate a non-empty array of transcript segments with non-decreasing timestamps.
 * Segment text contains no newlines (since transcript.txt uses newlines as line delimiters).
 */
function arbitraryTranscriptSegments(): fc.Arbitrary<TranscriptSegment[]> {
  return fc
    .tuple(
      arbitraryPositiveFinite(100), // first segment start time
      fc.array(
        fc.tuple(
          fc.double({ min: 0.1, max: 30, noNaN: true, noDefaultInfinity: true }), // segment duration
          fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),    // gap to next
          arbitrarySegmentText()
        ),
        { minLength: 1, maxLength: 10 }
      )
    )
    .map(([firstStart, segmentSpecs]) => {
      const segments: TranscriptSegment[] = [];
      let currentTime = firstStart;

      for (const [duration, gap, text] of segmentSpecs) {
        const startTime = currentTime;
        const endTime = startTime + duration;

        segments.push({
          text,
          startTime,
          endTime,
          words: [],
          isFinal: true,
        });

        currentTime = endTime + gap;
      }

      return segments;
    });
}

/**
 * Generate an EvaluationItem with valid data.
 */
function arbitraryEvaluationItem(): fc.Arbitrary<EvaluationItem> {
  return fc.tuple(
    fc.constantFrom("commendation" as const, "recommendation" as const),
    arbitrarySegmentText(), // summary
    arbitrarySegmentText(), // evidence_quote
    arbitraryPositiveFinite(1500), // evidence_timestamp
    arbitrarySegmentText()  // explanation
  ).map(([type, summary, evidence_quote, evidence_timestamp, explanation]) => ({
    type,
    summary,
    evidence_quote,
    evidence_timestamp,
    explanation,
  }));
}

/**
 * Generate a StructuredEvaluation with valid data.
 */
function arbitraryStructuredEvaluation(): fc.Arbitrary<StructuredEvaluation> {
  return fc.tuple(
    arbitrarySegmentText(), // opening
    fc.array(arbitraryEvaluationItem(), { minLength: 1, maxLength: 5 }),
    arbitrarySegmentText()  // closing
  ).map(([opening, items, closing]) => ({
    opening,
    items,
    closing,
  }));
}

/**
 * Generate a simple evaluation script string.
 */
function arbitraryEvaluationScript(): fc.Arbitrary<string> {
  return fc
    .array(arbitrarySegmentText(), { minLength: 1, maxLength: 5 })
    .map((sentences) => sentences.join(". ") + ".");
}

/**
 * Generate a speaker name.
 */
function arbitrarySpeakerName(): fc.Arbitrary<string> {
  return fc.constantFrom("Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace");
}

/**
 * Generate a complete session suitable for the round-trip test.
 */
function arbitraryCompletedSession(): fc.Arbitrary<Session> {
  return fc
    .tuple(
      fc.uuid(),
      arbitraryTranscriptSegments(),
      arbitraryDeliveryMetrics(),
      arbitraryStructuredEvaluation(),
      fc.option(arbitraryEvaluationScript(), { nil: null }),
      fc.option(arbitrarySpeakerName(), { nil: undefined }),
      // Use integer timestamps to avoid NaN date issues
      fc.integer({ min: 1577836800000, max: 1924905600000 }), // 2020-01-01 to 2030-12-31 in ms
      fc.integer({ min: 60000, max: 1800000 }) // stop offset 1-30 minutes
    )
    .map(([id, transcript, metrics, evaluation, evaluationScript, speakerName, startMs, stopOffset]) => {
      const startedAt = new Date(startMs);
      const stoppedAt = new Date(startMs + stopOffset);

      const session: Session = {
        id,
        state: SessionState.IDLE,
        startedAt,
        stoppedAt,
        transcript,
        liveTranscript: [],
        audioChunks: [],
        metrics,
        evaluation,
        evaluationScript,
        qualityWarning: false,
        outputsSaved: false,
        runId: 1,
      };

      if (speakerName !== undefined) {
        session.speakerName = speakerName;
      }

      return session;
    });
}

// ─── Helper: Parse transcript.txt lines ─────────────────────────────────────────

/**
 * Parse a transcript.txt line of the form "[MM:SS] text here..."
 * Returns { minutes, seconds, text } or null if the line doesn't match.
 */
function parseTranscriptLine(line: string): { minutes: number; seconds: number; text: string } | null {
  const match = line.match(/^\[(\d{2}):(\d{2})\]\s(.+)$/);
  if (!match) return null;
  return {
    minutes: parseInt(match[1], 10),
    seconds: parseInt(match[2], 10),
    text: match[3],
  };
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 10: Session Output File Round-Trip", () => {

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * Property 10: Session Output File Round-Trip — metrics.json
   *
   * For any DeliveryMetrics, serializing via formatMetrics and parsing back
   * SHALL produce data equal to the original DeliveryMetrics.
   * This is a true JSON round-trip.
   */
  it("metrics.json round-trips: JSON.parse(formatMetrics(metrics)) equals original DeliveryMetrics", () => {
    fc.assert(
      fc.property(arbitraryDeliveryMetrics(), (metrics) => {
        const serialized = formatMetrics(metrics);
        const parsed = JSON.parse(serialized) as DeliveryMetrics;

        expect(parsed).toEqual(metrics);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * Property 10: Session Output File Round-Trip — transcript.txt
   *
   * For any array of transcript segments, formatting via formatTranscript
   * and parsing back SHALL produce lines where:
   * - The number of non-empty lines equals the number of segments
   * - Each line contains the segment text
   * - Each line's [MM:SS] timestamp matches the segment's startTime floored to seconds
   */
  it("transcript.txt round-trips: each line contains segment text and correct [MM:SS] timestamp", () => {
    fc.assert(
      fc.property(arbitraryTranscriptSegments(), (segments) => {
        const formatted = formatTranscript(segments);

        if (segments.length === 0) {
          expect(formatted).toBe("");
          return;
        }

        const lines = formatted.split("\n");

        // Number of lines equals number of segments
        expect(lines.length).toBe(segments.length);

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const parsed = parseTranscriptLine(lines[i]);

          expect(parsed).not.toBeNull();

          // The text in the line matches the segment text
          expect(parsed!.text).toBe(segment.text);

          // The timestamp matches the segment's startTime floored to seconds
          const totalSeconds = Math.max(0, Math.floor(segment.startTime));
          const expectedMinutes = Math.floor(totalSeconds / 60);
          const expectedSeconds = totalSeconds % 60;

          expect(parsed!.minutes).toBe(expectedMinutes);
          expect(parsed!.seconds).toBe(expectedSeconds);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * Property 10: Session Output File Round-Trip — evaluation.txt
   *
   * For any completed session, formatting via formatEvaluation SHALL produce
   * content where:
   * - The session ID appears in the header
   * - The evaluation text (evaluationScript or rendered StructuredEvaluation) appears in the body
   * - If metrics are present, the duration appears in the header
   * - If speakerName is present, it appears in the header
   */
  it("evaluation.txt round-trips: contains session ID, evaluation text, and optional metadata", () => {
    fc.assert(
      fc.property(arbitraryCompletedSession(), (session) => {
        const content = formatEvaluation(session);

        // Session ID appears in the header
        expect(content).toContain(`Session ID: ${session.id}`);

        // Header marker is present
        expect(content).toContain("=== Toastmasters Speech Evaluation ===");

        // If metrics are present, duration appears in the header
        if (session.metrics) {
          expect(content).toContain(`Duration: ${session.metrics.durationFormatted}`);
        }

        // If speakerName is present, it appears in the header
        if (session.speakerName) {
          expect(content).toContain(`Speaker: ${session.speakerName}`);
        }

        // Evaluation body: prefer evaluationScript, fall back to StructuredEvaluation
        if (session.evaluationScript) {
          expect(content).toContain(session.evaluationScript);
        } else if (session.evaluation) {
          // The opening text should appear
          expect(content).toContain(session.evaluation.opening);
          // The closing text should appear
          expect(content).toContain(session.evaluation.closing);
          // Each item's summary should appear
          for (const item of session.evaluation.items) {
            expect(content).toContain(item.summary);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * Property 10: Session Output File Round-Trip — full file system round-trip
   *
   * For any completed session, saving via FilePersistence.saveSession() and
   * reading the files back SHALL produce:
   * - Exactly 3 files: transcript.txt, metrics.json, evaluation.txt
   * - metrics.json content that JSON-parses to the original metrics
   * - transcript.txt content matching formatTranscript output
   * - evaluation.txt content matching formatEvaluation output
   */
  it("saveSession writes files whose content matches the format functions", async () => {
    // Create a dedicated temp dir for this test
    const baseDir = await mkdtemp(join(tmpdir(), "fp-prop-roundtrip-"));

    try {
      // Run a smaller number of iterations since each involves filesystem I/O
      await fc.assert(
        fc.asyncProperty(arbitraryCompletedSession(), async (session) => {
          // Each iteration gets its own unique subdirectory
          const iterDir = await mkdtemp(join(baseDir, "iter-"));
          const persistence = new FilePersistence(iterDir);

          const paths = await persistence.saveSession(session);

          // Reset outputsSaved for generator reuse
          session.outputsSaved = false;

          // Exactly 3 paths returned
          expect(paths).toHaveLength(3);

          // Read back all three files
          const transcriptContent = await readFile(paths[0], "utf-8");
          const metricsContent = await readFile(paths[1], "utf-8");
          const evaluationContent = await readFile(paths[2], "utf-8");

          // metrics.json round-trips
          const parsedMetrics = JSON.parse(metricsContent) as DeliveryMetrics;
          expect(parsedMetrics).toEqual(session.metrics);

          // transcript.txt matches formatTranscript output
          expect(transcriptContent).toBe(formatTranscript(session.transcript));

          // evaluation.txt matches formatEvaluation output
          expect(evaluationContent).toBe(formatEvaluation(session));

          // Verify the directory contains exactly 3 files
          const entries = await readdir(iterDir);
          expect(entries).toHaveLength(1); // one session directory
          const sessionDir = join(iterDir, entries[0]);
          const files = await readdir(sessionDir);
          expect(files.sort()).toEqual(["evaluation.txt", "metrics.json", "transcript.txt"]);
        }),
        { numRuns: 100 }
      );
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

// ─── Property 11 Tests ──────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 11: Output Directory Naming Convention", () => {

  /**
   * **Validates: Requirements 6.4**
   *
   * Property 11: Output Directory Naming Convention — directory name format
   *
   * For any completed session, buildDirectoryName(session) SHALL produce a string
   * matching the pattern {YYYY-MM-DD_HH-mm-ss}_{sessionId} where:
   * - The timestamp portion is a valid ISO-style date-time
   * - The session ID appears after the timestamp, separated by an underscore
   * - The timestamp corresponds to the session's startedAt date
   */
  it("buildDirectoryName produces a valid {YYYY-MM-DD_HH-mm-ss}_{sessionId} format", () => {
    fc.assert(
      fc.property(arbitraryCompletedSession(), (session) => {
        const dirName = buildDirectoryName(session);

        // Must match the overall pattern
        const pattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_.+$/;
        expect(dirName).toMatch(pattern);

        // Split into timestamp and sessionId parts
        // The timestamp is exactly 19 characters: YYYY-MM-DD_HH-mm-ss
        const timestampPart = dirName.substring(0, 19);
        const separatorAndId = dirName.substring(19);

        // The separator must be an underscore followed by the session ID
        expect(separatorAndId).toBe(`_${session.id}`);

        // The timestamp portion must parse to a valid date
        // Convert YYYY-MM-DD_HH-mm-ss to YYYY-MM-DDTHH:mm:ss for Date parsing
        const isoString = timestampPart.replace(/_/, "T").replace(/-(\d{2})-(\d{2})$/, ":$1:$2");
        const parsedDate = new Date(isoString);
        expect(parsedDate.getTime()).not.toBeNaN();

        // The parsed date should correspond to the session's startedAt
        const sourceDate = session.startedAt ?? new Date();
        expect(parsedDate.getFullYear()).toBe(sourceDate.getFullYear());
        expect(parsedDate.getMonth()).toBe(sourceDate.getMonth());
        expect(parsedDate.getDate()).toBe(sourceDate.getDate());
        expect(parsedDate.getHours()).toBe(sourceDate.getHours());
        expect(parsedDate.getMinutes()).toBe(sourceDate.getMinutes());
        expect(parsedDate.getSeconds()).toBe(sourceDate.getSeconds());
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * Property 11: Output Directory Naming Convention — session ID preserved
   *
   * For any completed session, the directory name SHALL end with the session's
   * actual ID, ensuring traceability from directory name back to session.
   */
  it("directory name ends with the session's actual ID", () => {
    fc.assert(
      fc.property(arbitraryCompletedSession(), (session) => {
        const dirName = buildDirectoryName(session);

        // The directory name must end with the session ID
        expect(dirName.endsWith(session.id)).toBe(true);

        // The session ID must be preceded by an underscore (the separator)
        const idIndex = dirName.lastIndexOf(session.id);
        expect(idIndex).toBeGreaterThan(0);
        expect(dirName[idIndex - 1]).toBe("_");
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * Property 11: Output Directory Naming Convention — directory contents
   *
   * For any completed session saved via saveSession(), the created directory
   * SHALL contain exactly 3 files: transcript.txt, metrics.json, and evaluation.txt.
   */
  it("saveSession creates a directory containing exactly transcript.txt, metrics.json, and evaluation.txt", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "fp-prop11-contents-"));

    try {
      await fc.assert(
        fc.asyncProperty(arbitraryCompletedSession(), async (session) => {
          const iterDir = await mkdtemp(join(baseDir, "iter-"));
          const persistence = new FilePersistence(iterDir);

          await persistence.saveSession(session);

          // Reset outputsSaved for generator reuse
          session.outputsSaved = false;

          // The output directory should contain exactly one subdirectory
          const topEntries = await readdir(iterDir);
          expect(topEntries).toHaveLength(1);

          // That subdirectory should contain exactly the 3 expected files
          const sessionDir = join(iterDir, topEntries[0]);
          const files = await readdir(sessionDir);
          expect(files.sort()).toEqual(["evaluation.txt", "metrics.json", "transcript.txt"]);

          // Verify the subdirectory name matches buildDirectoryName
          const expectedDirName = buildDirectoryName(session);
          expect(topEntries[0]).toBe(expectedDirName);
        }),
        { numRuns: 100 }
      );
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
