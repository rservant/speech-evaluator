/**
 * GCS History Service — persist and retrieve evaluation results from GCS.
 *
 * Storage layout:
 *   gs://<bucket>/results/<speaker>/<YYYY-MM-DD-HHMM-title>/
 *     metadata.json
 *     transcript.json
 *     metrics.json
 *     evaluation.json
 *     evaluation_audio.mp3
 *
 * Implements issue #123.
 */

import { Storage, type Bucket, type File } from "@google-cloud/storage";
import { createLogger } from "./logger.js";
import type { TranscriptSegment, DeliveryMetrics, StructuredEvaluation, MeetingRecord } from "./types.js";
import { createWavBuffer } from "./audio-utils.js";

const log = createLogger("GcsHistory");

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface EvaluationMetadata {
  /** ISO 8601 date string */
  date: string;
  speakerName: string;
  speechTitle: string;
  durationSeconds: number;
  wordsPerMinute: number;
  passRate: number;
  projectType?: string;
  /** "live", "upload", or "practice" (#146) */
  mode: "live" | "upload" | "practice";
  /** GCS prefix for this evaluation's files */
  prefix: string;
  /** Analysis tier used for this evaluation (#128) */
  analysisTier?: string;
  /** Number of Vision frames captured (#128) */
  visionFrameCount?: number;
  /** GCS prefix of original evaluation if this is a re-evaluation (#187) */
  reEvaluatedFrom?: string;
}

export interface EvaluationListItem {
  metadata: EvaluationMetadata;
  urls: {
    transcript?: string;
    metrics?: string;
    evaluation?: string;
    audio?: string;
    metadata?: string;
  };
}

export interface ListEvaluationsResult {
  results: EvaluationListItem[];
  nextCursor?: string;
}

export interface SaveEvaluationInput {
  speakerName: string;
  speechTitle: string;
  mode: "live" | "upload" | "practice";
  durationSeconds: number;
  wordsPerMinute: number;
  passRate: number;
  projectType?: string;
  transcript: TranscriptSegment[];
  metrics: DeliveryMetrics;
  evaluation: StructuredEvaluation;
  evaluationScript?: string;
  ttsAudio?: Buffer;
  speechAudio?: Buffer;
  analysisTier?: string;
  visionFrameCount?: number;
  reEvaluatedFrom?: string;
  userId?: string;
}

// ─── GCS History Client Interface (for testability) ──────────────────────────────

export interface GcsHistoryClient {
  saveFile(path: string, content: string | Buffer, contentType: string): Promise<void>;
  listPrefixes(prefix: string, delimiter: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  getSignedReadUrl(path: string, expiryMinutes: number): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<number>;
}

// ─── Real GCS Client ─────────────────────────────────────────────────────────────

export function createGcsHistoryClient(bucketName: string): GcsHistoryClient {
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  return {
    async saveFile(path: string, content: string | Buffer, contentType: string): Promise<void> {
      const file = bucket.file(path);
      await file.save(content, { contentType, resumable: false });
    },

    async listPrefixes(prefix: string, delimiter: string): Promise<string[]> {
      const [, , apiResponse] = await bucket.getFiles({
        prefix,
        delimiter,
        autoPaginate: false,
      });
      return ((apiResponse as { prefixes?: string[] })?.prefixes ?? []);
    },

    async readFile(path: string): Promise<string> {
      const file = bucket.file(path);
      const [content] = await file.download();
      return content.toString("utf-8");
    },

    async getSignedReadUrl(path: string, expiryMinutes: number): Promise<string> {
      const file = bucket.file(path);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + expiryMinutes * 60 * 1000,
      });
      return url;
    },

    async fileExists(path: string): Promise<boolean> {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      return exists;
    },

    async deletePrefix(prefix: string): Promise<number> {
      const [files] = await bucket.getFiles({ prefix });
      if (files.length === 0) return 0;
      await Promise.all(files.map(f => f.delete()));
      return files.length;
    },
  };
}

// ─── Path Helpers ────────────────────────────────────────────────────────────────

const RESULTS_PREFIX = "results/";
const SIGNED_URL_EXPIRY_MINUTES = 15;

/**
 * Sanitize a string for safe use in GCS object paths.
 * Lowercase, replace spaces and special characters with hyphens,
 * collapse multiple hyphens, trim length.
 */
export function sanitizeForPath(input: string, maxLength: number = 60): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength) || "untitled";
}

/**
 * Build the GCS prefix for an evaluation.
 * Format: results/<speaker>/<YYYY-MM-DD-HHMM-title>/
 */
export function buildEvaluationPrefix(
  speakerName: string,
  speechTitle: string,
  date: Date = new Date(),
  userId?: string,
): string {
  const sanitizedSpeaker = sanitizeForPath(speakerName);
  const sanitizedTitle = sanitizeForPath(speechTitle || "untitled");

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  const timestamp = `${year}-${month}-${day}-${hours}${minutes}`;

  // When userId is provided, scope under user ID for cross-app querying (#195)
  const userSegment = userId ? `${userId}/` : "";
  return `${RESULTS_PREFIX}${userSegment}${sanitizedSpeaker}/${timestamp}-${sanitizedTitle}/`;
}

// ─── GCS History Service ─────────────────────────────────────────────────────────

export class GcsHistoryService {
  private readonly _client: GcsHistoryClient;

  constructor(client: GcsHistoryClient) {
    this._client = client;
  }

  /** Public accessor for the underlying GCS client (#145). */
  get client(): GcsHistoryClient {
    return this._client;
  }

  /**
   * Persist evaluation results to GCS.
   * Fire-and-forget — errors are logged but never thrown.
   */
  async saveEvaluationResults(input: SaveEvaluationInput): Promise<string | null> {
    const prefix = buildEvaluationPrefix(input.speakerName, input.speechTitle, new Date(), input.userId);

    try {
      log.info("Saving evaluation results to GCS", { prefix, speaker: input.speakerName });

      // Build metadata
      const metadata: EvaluationMetadata = {
        date: new Date().toISOString(),
        speakerName: input.speakerName,
        speechTitle: input.speechTitle || "Untitled",
        durationSeconds: input.durationSeconds,
        wordsPerMinute: input.wordsPerMinute,
        passRate: input.passRate,
        projectType: input.projectType,
        mode: input.mode,
        prefix,
        analysisTier: input.analysisTier,
        visionFrameCount: input.visionFrameCount,
        reEvaluatedFrom: input.reEvaluatedFrom,
      };

      // Save all files in parallel
      const saves: Promise<void>[] = [
        this._client.saveFile(
          `${prefix}metadata.json`,
          JSON.stringify(metadata, null, 2),
          "application/json",
        ),
        this._client.saveFile(
          `${prefix}transcript.json`,
          JSON.stringify(input.transcript, null, 2),
          "application/json",
        ),
        this._client.saveFile(
          `${prefix}metrics.json`,
          JSON.stringify(input.metrics, null, 2),
          "application/json",
        ),
        this._client.saveFile(
          `${prefix}evaluation.json`,
          JSON.stringify({
            evaluation: input.evaluation,
            script: input.evaluationScript,
          }, null, 2),
          "application/json",
        ),
      ];

      if (input.ttsAudio && input.ttsAudio.length > 0) {
        saves.push(
          this._client.saveFile(
            `${prefix}evaluation_audio.mp3`,
            input.ttsAudio,
            "audio/mpeg",
          ),
        );
      }

      // Save original speech audio as WAV (#187)
      if (input.speechAudio && input.speechAudio.length > 0) {
        const wavBuffer = createWavBuffer(input.speechAudio);
        saves.push(
          this._client.saveFile(
            `${prefix}speech_audio.wav`,
            wavBuffer,
            "audio/wav",
          ),
        );
      }

      await Promise.all(saves);
      log.info("Evaluation results saved to GCS", { prefix, fileCount: saves.length });

      return prefix;
    } catch (err) {
      log.error("Failed to save evaluation results to GCS", {
        error: err instanceof Error ? err : new Error(String(err)),
        prefix,
      });
      return null;
    }
  }

  /**
   * List evaluations for a speaker, sorted newest-first.
   * Uses prefix listing to find evaluation folders, then reads metadata.json
   * and generates signed read URLs for each file.
   *
   * @param speaker - Speaker name (will be sanitized)
   * @param limit - Maximum results to return (default 20)
   * @param cursor - Opaque cursor for pagination (base64-encoded index)
   */
  async listEvaluations(
    speaker: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<ListEvaluationsResult> {
    const sanitizedSpeaker = sanitizeForPath(speaker);
    const speakerPrefix = `${RESULTS_PREFIX}${sanitizedSpeaker}/`;

    log.info("Listing evaluations", { speaker: sanitizedSpeaker, limit, cursor });

    // Get all evaluation prefixes for this speaker
    const prefixes = await this._client.listPrefixes(speakerPrefix, "/");

    // Sort newest-first (prefixes are timestamped, so reverse alpha sort works)
    const sorted = prefixes.sort().reverse();

    // Apply pagination
    const startIndex = cursor ? parseInt(Buffer.from(cursor, "base64").toString("utf-8"), 10) : 0;
    const page = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;

    // Read metadata and generate signed URLs for each evaluation
    const results: EvaluationListItem[] = [];
    for (const evalPrefix of page) {
      try {
        const metadataContent = await this._client.readFile(`${evalPrefix}metadata.json`);
        const metadata = JSON.parse(metadataContent) as EvaluationMetadata;

        // Generate signed read URLs for each file
        const urls = await this.signFilesForPrefix(evalPrefix);

        results.push({ metadata, urls });
      } catch (err) {
        log.warn("Failed to read evaluation metadata", {
          prefix: evalPrefix,
          error: err instanceof Error ? err.message : String(err),
        });
        // Skip this evaluation — corrupted or incomplete
      }
    }

    const nextCursor = hasMore
      ? Buffer.from(String(startIndex + limit)).toString("base64")
      : undefined;

    log.info("Listed evaluations", {
      speaker: sanitizedSpeaker,
      total: sorted.length,
      returned: results.length,
    });

    return { results, nextCursor };
  }

  /**
   * Generate signed read URLs for all files in an evaluation folder.
   */
  private async signFilesForPrefix(
    prefix: string,
  ): Promise<EvaluationListItem["urls"]> {
    const files = [
      { key: "transcript" as const, path: `${prefix}transcript.json` },
      { key: "metrics" as const, path: `${prefix}metrics.json` },
      { key: "evaluation" as const, path: `${prefix}evaluation.json` },
      { key: "audio" as const, path: `${prefix}evaluation_audio.mp3` },
      { key: "metadata" as const, path: `${prefix}metadata.json` },
    ];

    const urls: EvaluationListItem["urls"] = {};

    // Check existence and sign in parallel
    const checks = files.map(async ({ key, path }) => {
      try {
        const exists = await this._client.fileExists(path);
        if (exists) {
          urls[key] = await this._client.getSignedReadUrl(path, SIGNED_URL_EXPIRY_MINUTES);
        }
      } catch {
        // Skip files that can't be signed
      }
    });

    await Promise.all(checks);
    return urls;
  }

  /**
   * Delete a single evaluation by prefix (#128 — privacy hardening).
   * @param prefix - The full GCS prefix for the evaluation (e.g., "results/speaker/timestamp-title/")
   * @returns Number of files deleted
   */
  async deleteEvaluation(prefix: string): Promise<number> {
    if (!prefix.startsWith(RESULTS_PREFIX)) {
      throw new Error(`Invalid evaluation prefix: ${prefix}`);
    }
    const count = await this._client.deletePrefix(prefix);
    log.info("Deleted evaluation", { prefix, filesDeleted: count });
    return count;
  }

  /**
   * Delete all evaluations for a speaker (#128 — privacy hardening).
   * @param speakerName - The speaker name (sanitized internally)
   * @returns Number of files deleted
   */
  async deleteSpeakerHistory(speakerName: string): Promise<number> {
    const sanitized = sanitizeForPath(speakerName);
    const prefix = `${RESULTS_PREFIX}${sanitized}/`;
    const count = await this._client.deletePrefix(prefix);
    log.info("Deleted speaker history", { speaker: speakerName, prefix, filesDeleted: count });
    return count;
  }

  /**
   * Get progress data for a speaker — aggregated metrics across evaluations (#140).
   * Returns chronologically sorted array, oldest-first, capped at 50 most recent.
   * Reads metadata.json for WPM/passRate, and metrics.json for fillerWordFrequency.
   */
  async getProgressData(speakerName: string, maxEntries: number = 50): Promise<SpeakerProgressEntry[]> {
    const sanitized = sanitizeForPath(speakerName);
    const speakerPrefix = `${RESULTS_PREFIX}${sanitized}/`;

    log.info("Fetching progress data", { speaker: sanitized });

    const prefixes = await this._client.listPrefixes(speakerPrefix, "/");

    // Sort chronologically and cap
    const sorted = prefixes.sort();
    const capped = sorted.slice(-maxEntries);

    const entries: SpeakerProgressEntry[] = [];

    for (const evalPrefix of capped) {
      try {
        const metadataContent = await this._client.readFile(`${evalPrefix}metadata.json`);
        const metadata = JSON.parse(metadataContent) as EvaluationMetadata;

        // Try to read fillerWordFrequency from metrics.json
        let fillerWordFrequency: number | undefined;
        try {
          const metricsContent = await this._client.readFile(`${evalPrefix}metrics.json`);
          const metrics = JSON.parse(metricsContent);
          fillerWordFrequency = metrics.fillerWordFrequency;
        } catch {
          // metrics.json may not exist — skip
        }

        entries.push({
          date: metadata.date,
          speechTitle: metadata.speechTitle,
          wordsPerMinute: metadata.wordsPerMinute,
          passRate: metadata.passRate,
          durationSeconds: metadata.durationSeconds,
          fillerWordFrequency,
        });
      } catch (err) {
        log.warn("Skipping evaluation in progress data", {
          prefix: evalPrefix,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("Progress data fetched", { speaker: sanitized, entries: entries.length });
    return entries;
  }

  // ─── All Evaluations (#184) ─────────────────────────────────────────────────

  /**
   * List all evaluations across all speakers, sorted newest-first.
   * Used for user-scoped history (show everything the operator has created).
   */
  async listAllEvaluations(limit: number = 50, cursor?: string, userId?: string): Promise<ListEvaluationsResult> {
    // When userId is provided, scope to user prefix; otherwise list all (#195)
    const rootPrefix = userId ? `${RESULTS_PREFIX}${userId}/` : RESULTS_PREFIX;
    const speakerPrefixes = await this._client.listPrefixes(rootPrefix, "/");

    // Collect all evaluation prefixes across speakers
    const allPrefixes: string[] = [];
    for (const sp of speakerPrefixes) {
      const evalPrefixes = await this._client.listPrefixes(sp, "/");
      allPrefixes.push(...evalPrefixes);
    }

    // If user-scoped and no results, also check legacy (non-user-scoped) path
    if (userId && allPrefixes.length === 0) {
      const legacyPrefixes = await this._client.listPrefixes(RESULTS_PREFIX, "/");
      for (const sp of legacyPrefixes) {
        // Skip user-ID-like prefixes (they belong to other users)
        if (sp.startsWith(`${RESULTS_PREFIX}user_`)) continue;
        const evalPrefixes = await this._client.listPrefixes(sp, "/");
        allPrefixes.push(...evalPrefixes);
      }
    }

    // Sort newest-first (prefixes contain timestamps)
    allPrefixes.sort().reverse();

    // Apply pagination
    const startIndex = cursor ? parseInt(Buffer.from(cursor, "base64").toString("utf-8"), 10) : 0;
    const page = allPrefixes.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allPrefixes.length;

    const results: EvaluationListItem[] = [];
    for (const evalPrefix of page) {
      try {
        const metadataContent = await this._client.readFile(`${evalPrefix}metadata.json`);
        const metadata = JSON.parse(metadataContent) as EvaluationMetadata;
        const urls = await this.signFilesForPrefix(evalPrefix);
        results.push({ metadata, urls });
      } catch {
        // Skip corrupted/incomplete evaluations
      }
    }

    const nextCursor = hasMore
      ? Buffer.from(String(startIndex + limit)).toString("base64")
      : undefined;

    log.info("Listed all evaluations", { total: allPrefixes.length, returned: results.length });
    return { results, nextCursor };
  }

  // ─── Meeting Methods (#176) ───────────────────────────────────────────────────

  /**
   * Save a meeting record (agenda + slot summaries) to GCS.
   */
  async saveMeetingRecord(record: MeetingRecord): Promise<void> {
    const prefix = `meetings/${record.meetingId}/`;
    try {
      await this._client.saveFile(
        `${prefix}meeting.json`,
        JSON.stringify(record, null, 2),
        "application/json",
      );
      log.info("Meeting record saved", { meetingId: record.meetingId });
    } catch (err) {
      log.error("Failed to save meeting record", {
        error: err instanceof Error ? err : new Error(String(err)),
        meetingId: record.meetingId,
      });
    }
  }

  /**
   * Save evaluation data for a meeting slot (dual-write alongside results/).
   */
  async saveMeetingSlotEvaluation(
    meetingId: string,
    slotId: string,
    input: SaveEvaluationInput,
  ): Promise<string | null> {
    const prefix = `meetings/${meetingId}/slots/${slotId}/`;

    try {
      const metadata: EvaluationMetadata = {
        date: new Date().toISOString(),
        speakerName: input.speakerName,
        speechTitle: input.speechTitle || "Untitled",
        durationSeconds: input.durationSeconds,
        wordsPerMinute: input.wordsPerMinute,
        passRate: input.passRate,
        projectType: input.projectType,
        mode: input.mode,
        prefix,
        analysisTier: input.analysisTier,
        visionFrameCount: input.visionFrameCount,
      };

      const saves: Promise<void>[] = [
        this._client.saveFile(`${prefix}metadata.json`, JSON.stringify(metadata, null, 2), "application/json"),
        this._client.saveFile(`${prefix}transcript.json`, JSON.stringify(input.transcript, null, 2), "application/json"),
        this._client.saveFile(`${prefix}metrics.json`, JSON.stringify(input.metrics, null, 2), "application/json"),
        this._client.saveFile(`${prefix}evaluation.json`, JSON.stringify({ evaluation: input.evaluation, script: input.evaluationScript }, null, 2), "application/json"),
      ];

      if (input.ttsAudio && input.ttsAudio.length > 0) {
        saves.push(this._client.saveFile(`${prefix}evaluation_audio.mp3`, input.ttsAudio, "audio/mpeg"));
      }

      await Promise.all(saves);
      log.info("Meeting slot evaluation saved", { meetingId, slotId, prefix });
      return prefix;
    } catch (err) {
      log.error("Failed to save meeting slot evaluation", {
        error: err instanceof Error ? err : new Error(String(err)),
        meetingId,
        slotId,
      });
      return null;
    }
  }

  /**
   * List all meetings, sorted newest-first.
   */
  async listMeetings(limit: number = 20, cursor?: string): Promise<{ results: MeetingListItem[]; nextCursor?: string }> {
    const prefixes = await this._client.listPrefixes("meetings/", "/");

    // Sort newest first (meetingId is UUID, but meeting.json has date)
    // Load all meeting.json files to get dates for sorting
    const items: MeetingListItem[] = [];
    for (const prefix of prefixes) {
      try {
        const raw = await this._client.readFile(`${prefix}meeting.json`);
        const record = JSON.parse(raw) as MeetingRecord;
        items.push({
          meetingId: record.meetingId,
          clubName: record.clubName,
          meetingDate: record.meetingDate,
          slotCount: record.slots.length,
          completedCount: record.slots.filter((s) => s.status === "completed").length,
          createdAt: record.createdAt,
        });
      } catch {
        // Skip meetings with missing/corrupt meeting.json
      }
    }

    items.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));

    const startIndex = cursor ? parseInt(Buffer.from(cursor, "base64").toString("utf-8"), 10) : 0;
    const page = items.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < items.length
      ? Buffer.from(String(startIndex + limit)).toString("base64")
      : undefined;

    return { results: page, nextCursor };
  }

  /**
   * Get a meeting record by ID.
   */
  async getMeetingRecord(meetingId: string): Promise<MeetingRecord | null> {
    try {
      const raw = await this._client.readFile(`meetings/${meetingId}/meeting.json`);
      return JSON.parse(raw) as MeetingRecord;
    } catch {
      return null;
    }
  }

  /**
   * Get all slot evaluations for a meeting with signed URLs.
   */
  async getMeetingEvaluations(meetingId: string): Promise<MeetingSlotEvaluation[]> {
    const slotPrefixes = await this._client.listPrefixes(`meetings/${meetingId}/slots/`, "/");
    const results: MeetingSlotEvaluation[] = [];

    for (const prefix of slotPrefixes) {
      try {
        const metaRaw = await this._client.readFile(`${prefix}metadata.json`);
        const metadata = JSON.parse(metaRaw) as EvaluationMetadata;

        const urls: Record<string, string> = {};
        const fileNames = ["transcript.json", "metrics.json", "evaluation.json", "evaluation_audio.mp3"];
        for (const fileName of fileNames) {
          try {
            if (await this._client.fileExists(`${prefix}${fileName}`)) {
              urls[fileName.replace(".json", "").replace(".mp3", "")] =
                await this._client.getSignedReadUrl(`${prefix}${fileName}`, 15);
            }
          } catch {
            // Skip missing files
          }
        }

        results.push({ metadata, urls, prefix });
      } catch {
        // Skip slots with missing metadata
      }
    }

    return results;
  }
}

// ─── Progress Types (#140) ──────────────────────────────────────────────────────

export interface SpeakerProgressEntry {
  date: string;
  speechTitle: string;
  wordsPerMinute: number;
  passRate: number;
  durationSeconds: number;
  fillerWordFrequency?: number;
}

// ─── Meeting Types (#176) ────────────────────────────────────────────────────

export interface MeetingListItem {
  meetingId: string;
  clubName?: string;
  meetingDate: string;
  slotCount: number;
  completedCount: number;
  createdAt: string;
}

export interface MeetingSlotEvaluation {
  metadata: EvaluationMetadata;
  urls: Record<string, string>;
  prefix: string;
}
