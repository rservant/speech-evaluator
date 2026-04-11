// GCS data retention sweeper — deletes evaluations older than maxAgeDays (#130)
//
// Runs periodically (daily) to enforce the 90-day retention policy
// advertised in the privacy notice.

import type { GcsHistoryClient } from "./gcs-history.js";
import { createLogger } from "./logger.js";

const log = createLogger("Retention");

const RESULTS_PREFIX = "results/";

export interface RetentionConfig {
  maxAgeDays: number;
}

export interface SweepResult {
  scanned: number;
  deleted: number;
}

/**
 * Scan all evaluations in GCS and delete those older than maxAgeDays.
 */
export async function runRetentionSweep(
  client: GcsHistoryClient,
  config: RetentionConfig,
): Promise<SweepResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.maxAgeDays);

  // List all speaker prefixes: results/speaker-name/
  const speakers = await client.listPrefixes(RESULTS_PREFIX, "/");
  if (speakers.length === 0) {
    log.info("Retention sweep: no speakers found", { scanned: 0, deleted: 0 });
    return { scanned: 0, deleted: 0 };
  }

  let scanned = 0;
  let deleted = 0;

  for (const speakerPrefix of speakers) {
    // List evaluation prefixes under each speaker
    const evalPrefixes = await client.listPrefixes(speakerPrefix, "/");

    for (const evalPrefix of evalPrefixes) {
      scanned++;

      try {
        const metadataContent = await client.readFile(`${evalPrefix}metadata.json`);
        const metadata = JSON.parse(metadataContent) as { date?: string };

        if (!metadata.date) continue;

        const evalDate = new Date(metadata.date);
        if (evalDate < cutoff) {
          await client.deletePrefix(evalPrefix);
          deleted++;
          log.info("Deleted expired evaluation", { prefix: evalPrefix, date: metadata.date });
        }
      } catch {
        // Skip evaluations with corrupted/missing metadata
        log.warn("Skipped evaluation with unreadable metadata", { prefix: evalPrefix });
      }
    }
  }

  // Sweep meetings/ prefix (#177)
  const meetingPrefixes = await client.listPrefixes("meetings/", "/");
  for (const meetingPrefix of meetingPrefixes) {
    scanned++;
    try {
      const raw = await client.readFile(`${meetingPrefix}meeting.json`);
      const record = JSON.parse(raw) as { createdAt?: string };
      if (!record.createdAt) continue;
      const meetingDate = new Date(record.createdAt);
      if (meetingDate < cutoff) {
        await client.deletePrefix(meetingPrefix);
        deleted++;
        log.info("Deleted expired meeting", { prefix: meetingPrefix, date: record.createdAt });
      }
    } catch {
      log.warn("Skipped meeting with unreadable metadata", { prefix: meetingPrefix });
    }
  }

  log.info("Retention sweep complete", { scanned, deleted, maxAgeDays: config.maxAgeDays });
  return { scanned, deleted };
}
