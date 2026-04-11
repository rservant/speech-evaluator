// AI Speech Evaluator — Express + WebSocket server
import { RoleRegistry } from "./role-registry.js";
import { loadGoals, saveGoals, evaluateGoals } from "./goals.js";
import type { SpeakerGoal } from "./goals.js";
import { computeCues, createCueState } from "./coaching-cues.js";
import type { CueState } from "./coaching-cues.js";
import { createLogger } from "./logger.js";
import type { MetricsCollector, MetricsSnapshot } from "./metrics-collector.js";
import { requestTimeout } from "./request-timeout.js";
import { AnalysisTier, getTierConfig } from "./analysis-tiers.js";
import { EvaluationStyle } from "./types.js";
// Requirements: 1.2 (start recording), 1.3 (elapsed time), 1.4 (stop recording),
//               1.6 (deliver evaluation), 1.7 (panic mute), 2.5 (echo prevention)
//
// Privacy: Audio chunks are in-memory only, never written to disk.
//          Session data lives in server memory only. No database, no temp files.

import express, { type Express, type RequestHandler, type Router } from "express";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./session-manager.js";
import {
  type ClientMessage,
  type ConsentRecord,
  type ServerMessage,
  type Session,
  type StructuredEvaluationPublic,
  type TranscriptSegment,
  SessionState,
} from "./types.js";
import { VADMonitor, type VADStatus } from "./vad-monitor.js";
import {
  isTMFrame,
  getFrameType,
  decodeVideoFrame,
  decodeAudioFrame,
} from "./video-frame-codec.js";
import { serializeOutputs } from "./file-persistence.js";
import type { GcsHistoryService } from "./gcs-history.js";
import { generateImprovementPlan } from "./improvement-plan.js";
import { generateHabitReport } from "./habit-detector.js";
import { parseAgendaFromText } from "./agenda-parser.js";
import { extractFormText, isFormMimeType } from "./form-extractor.js";
import multer from "multer";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Expected audio format for the handshake */
const EXPECTED_FORMAT = {
  channels: 1 as const,
  sampleRate: 16000 as const,
  encoding: "LINEAR16" as const,
};

/** Max acceptable jitter between audio chunks (ms) before warning is logged */
const MAX_CHUNK_JITTER_MS = 100;

/** Expected chunk interval in ms (50ms chunks) */
const EXPECTED_CHUNK_INTERVAL_MS = 50;

/** Max speech duration in seconds (25 minutes) */
const MAX_SPEECH_DURATION_SECONDS = 1500;

/** Elapsed time ticker interval in ms */
const ELAPSED_TIME_INTERVAL_MS = 1000;

/** Auto-purge timer duration in ms (10 minutes) after TTS delivery completes */
const AUTO_PURGE_TIMER_MS = 10 * 60 * 1000;

// ─── Per-Connection State ───────────────────────────────────────────────────────

interface ConnectionState {
  sessionId: string;
  audioFormatValidated: boolean;
  lastChunkTimestamp: number | null;
  elapsedTimerInterval: ReturnType<typeof setInterval> | null;
  purgeTimer: ReturnType<typeof setTimeout> | null;
  /** Index tracking for live transcript replaceFromIndex semantics */
  liveTranscriptLength: number;
  /** Periodic video_status sender interval (≤1/sec during RECORDING) */
  videoStatusInterval: ReturnType<typeof setInterval> | null;
  /** Promise tracking the in-flight stopRecording async operation */
  stopRecordingPromise: Promise<void> | null;
  /** IDs of active meeting roles selected by the operator (Phase 9, #72) */
  activeRoles: string[];
  /** Configured analysis tier (#125) */
  analysisTier: string;
  /** Configured evaluation style (#133) */
  evaluationStyle: string;
  /** Buffer of base64 Vision frames for GPT-4o analysis (#128) */
  visionFrameBuffer: string[];
  /** Session mode: live meeting or solo practice (#146) */
  sessionMode: "live" | "practice";
  /** Coaching cue timer interval (practice mode only, #155) */
  coachingCueInterval: ReturnType<typeof setInterval> | null;
  /** Coaching cue cooldown state (#155) */
  coachingCueState: CueState;
  /** Meeting context for grouped evaluations (#174) */
  meetingId: string | null;
  meetingSlotId: string | null;
  meetingClubName: string | null;
}

// ─── Logging ────────────────────────────────────────────────────────────────────

export interface ServerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const structuredLog = createLogger("Server");

const defaultLogger: ServerLogger = {
  info: (msg) => structuredLog.info(msg),
  warn: (msg) => structuredLog.warn(msg),
  error: (msg) => structuredLog.error(msg),
  debug: (msg) => structuredLog.debug(msg),
};

// ─── Server Factory ─────────────────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Directory to serve static files from. Defaults to "public" relative to cwd. */
  staticDir?: string;
  /** Custom logger. Defaults to console-based logger. */
  logger?: ServerLogger;
  /** Externally provided SessionManager (for testing). Created internally if omitted. */
  sessionManager?: SessionManager;
  /** Application version string (from package.json). */
  version?: string;
  /** Upload router for POST /api/upload. */
  uploadRouter?: Router;
  /** Optional auth middleware (mounted before all routes). */
  authMiddleware?: RequestHandler;
  /** Optional function to verify WebSocket upgrade requests. Returns true if allowed. */
  wsAuthVerify?: (req: IncomingMessage) => Promise<boolean>;
  /** Clerk client config served at /api/config (no auth required). */
  clerkConfig?: Record<string, string>;
  /** RoleRegistry for meeting roles (Phase 9). */
  roleRegistry?: RoleRegistry;
  /** MetricsCollector for /api/health and /api/metrics (Phase 7). */
  metricsCollector?: MetricsCollector;
  /** GCS history service for browsable evaluation history (#123). */
  gcsHistoryService?: GcsHistoryService;
  /** OpenAI client for improvement plan generation (#145). */
  openaiClient?: { chat: { completions: { create: (...args: unknown[]) => Promise<{ choices: Array<{ message: { content: string | null } }> }> } } };
}

export interface AppServer {
  app: Express;
  httpServer: HttpServer;
  wss: WebSocketServer;
  sessionManager: SessionManager;
  /** Start listening on the given port. Returns a promise that resolves when listening. */
  listen(port: number): Promise<void>;
  /** Gracefully shut down the server. */
  close(): Promise<void>;
}

/**
 * Creates the Express app, HTTP server, and WebSocket server.
 * Does NOT start listening — call `listen(port)` explicitly.
 * This factory pattern keeps the module testable.
 */
export function createAppServer(options: CreateServerOptions = {}): AppServer {
  const {
    staticDir = path.resolve(process.cwd(), "public"),
    logger = defaultLogger,
    sessionManager = new SessionManager({
      vadMonitorFactory: (config, callbacks) => new VADMonitor(config, callbacks),
    }),
    version = "0.0.0",
    uploadRouter,
    authMiddleware,
    wsAuthVerify,
    clerkConfig,
  } = options;

  const app = express();
  const httpServer = createServer(app);

  // Parse cookies for auth middleware
  app.use(cookieParser());

  // Health check endpoint (unauthenticated — CI/CD readiness checks)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ─── Observability endpoints (Phase 7, #118) ──────────────────────────────────
  const metricsCollector = options.metricsCollector ?? null;

  app.get("/api/health", (_req, res) => {
    const health: Record<string, unknown> = {
      status: "ok",
      version,
      region: process.env.CLOUD_RUN_REGION ?? process.env.K_REVISION ?? "local",
    };
    if (metricsCollector) {
      const snap = metricsCollector.snapshot();
      health.uptimeSeconds = snap.uptimeSeconds;
      health.sessionsTotal = snap.sessionsTotal;
    }
    res.json(health);
  });

  app.get("/api/metrics", (_req, res) => {
    if (!metricsCollector) {
      res.json({ error: "Metrics collector not configured" });
      return;
    }
    res.json(metricsCollector.snapshot());
  });

  // Auth client config endpoint (unauthenticated — needed by login page)
  if (clerkConfig) {
    app.get("/api/config", (_req, res) => {
      res.json(clerkConfig);
    });
  }


  // Mount auth middleware before static files and all other routes
  if (authMiddleware) {
    app.use(authMiddleware);
    logger.info("Auth middleware mounted");
  }

  // Serve static files from public/ directory
  app.use(express.static(staticDir));

  // Current user endpoint — returns authenticated user info for the header (#162)
  app.get("/api/me", (_req, res) => {
    if (!_req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json({
      email: _req.user.email,
      name: _req.user.name ?? null,
      picture: _req.user.picture ?? null,
    });
  });

  // Version endpoint — serves package.json version for the UI footer
  app.get("/api/version", (_req, res) => {
    res.json({ version });
  });

  // Roles endpoint — lists available meeting roles (Phase 9, #72)
  const roleRegistry = options.roleRegistry ?? null;
  app.get("/api/roles", (_req, res) => {
    if (!roleRegistry) {
      res.json({ roles: [] });
      return;
    }
    const roles = roleRegistry.list().map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      requiredInputs: role.requiredInputs,
    }));
    res.json({ roles });
  });



  // Upload endpoint (issues #24-26)
  if (uploadRouter) {
    app.use("/api/upload", requestTimeout(300_000), uploadRouter); // 5 min timeout for evaluations
    logger.info("Upload endpoint mounted at /api/upload (timeout: 300s)");
  }

  // History endpoint (#123) — lists past evaluations from GCS
  const gcsHistoryService = options.gcsHistoryService ?? null;
  if (gcsHistoryService) {
    // GET /api/history — list ALL evaluations for the authenticated user (#184)
    app.get("/api/history", async (_req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(String(_req.query.limit ?? "50"), 10) || 50, 1), 100);
        const cursor = typeof _req.query.cursor === "string" ? _req.query.cursor : undefined;
        const result = await gcsHistoryService.listAllEvaluations(limit, cursor);
        res.json(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`History all API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to load evaluation history" });
      }
    });

    app.get("/api/history/:speaker", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 50);
        const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

        const result = await gcsHistoryService.listEvaluations(speaker, limit, cursor);
        res.json(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`History API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to load evaluation history" });
      }
    });
    logger.info("History endpoint mounted at /api/history/:speaker");

    // DELETE /api/history/:speaker — delete all evaluations for a speaker (#128)
    app.delete("/api/history/:speaker", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const count = await gcsHistoryService.deleteSpeakerHistory(speaker);
        res.json({ deleted: count });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Delete speaker history error: ${errMsg}`);
        res.status(500).json({ error: "Failed to delete speaker history" });
      }
    });

    // DELETE /api/history/:speaker/:evaluationId — delete a single evaluation (#128)
    // evaluationId is the full GCS prefix (URL-encoded)
    app.delete("/api/history/:speaker/:evaluationId", async (req, res) => {
      try {
        const prefix = decodeURIComponent(req.params.evaluationId);
        const count = await gcsHistoryService.deleteEvaluation(prefix);
        res.json({ deleted: count });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Delete evaluation error: ${errMsg}`);
        res.status(500).json({ error: "Failed to delete evaluation" });
      }
    });
    logger.info("History DELETE endpoints mounted (#128)");

    // ─── Meeting API (#176) ─────────────────────────────────────────────────────

    // GET /api/meetings — list all meetings
    app.get("/api/meetings", async (_req, res) => {
      try {
        const limit = Math.min(Math.max(parseInt(String(_req.query.limit ?? "20"), 10) || 20, 1), 50);
        const cursor = typeof _req.query.cursor === "string" ? _req.query.cursor : undefined;
        const result = await gcsHistoryService.listMeetings(limit, cursor);
        res.json(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Meetings list API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to list meetings" });
      }
    });

    // GET /api/meetings/:meetingId — get meeting with slot evaluations
    app.get("/api/meetings/:meetingId", async (req, res) => {
      try {
        const meetingId = req.params.meetingId;
        const record = await gcsHistoryService.getMeetingRecord(meetingId);
        if (!record) {
          res.status(404).json({ error: "Meeting not found" });
          return;
        }
        const evaluations = await gcsHistoryService.getMeetingEvaluations(meetingId);
        res.json({ meeting: record, evaluations });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Meeting detail API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to load meeting" });
      }
    });

    // POST /api/meetings/:meetingId/finalize — save meeting record to GCS
    app.post("/api/meetings/:meetingId/finalize", express.json(), async (req, res) => {
      try {
        const record = req.body as import("./types.js").MeetingRecord;
        if (!record.meetingId || !Array.isArray(record.slots)) {
          res.status(400).json({ error: "Invalid meeting record" });
          return;
        }
        record.completedAt = new Date().toISOString();
        await gcsHistoryService.saveMeetingRecord(record);
        res.json({ status: "ok" });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Meeting finalize API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to finalize meeting" });
      }
    });

    // GET /api/meetings/:meetingId/export — export meeting as Markdown (#177)
    app.get("/api/meetings/:meetingId/export", async (req, res) => {
      try {
        const meetingId = req.params.meetingId;
        const record = await gcsHistoryService.getMeetingRecord(meetingId);
        if (!record) {
          res.status(404).json({ error: "Meeting not found" });
          return;
        }

        const slotEvals = await gcsHistoryService.getMeetingEvaluations(meetingId);

        // Build MarkdownExportInput for each completed slot
        const evalInputs: import("./markdown-export.js").MarkdownExportInput[] = [];
        for (const slotEval of slotEvals) {
          try {
            const [evalRaw, metricsRaw, transcriptRaw] = await Promise.all([
              gcsHistoryService.client.readFile(`${slotEval.prefix}evaluation.json`),
              gcsHistoryService.client.readFile(`${slotEval.prefix}metrics.json`),
              gcsHistoryService.client.readFile(`${slotEval.prefix}transcript.json`),
            ]);
            evalInputs.push({
              metadata: slotEval.metadata,
              evaluation: JSON.parse(evalRaw).evaluation,
              metrics: JSON.parse(metricsRaw),
              transcript: JSON.parse(transcriptRaw),
            });
          } catch {
            // Skip slots with missing files
          }
        }

        const { generateMeetingMarkdownReport } = await import("./markdown-export.js");
        const markdown = generateMeetingMarkdownReport({ meeting: record, evaluations: evalInputs });

        const filename = `meeting-${record.meetingDate}${record.clubName ? `-${record.clubName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""}.md`;
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(markdown);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Meeting export API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to export meeting" });
      }
    });

    logger.info("Meeting API endpoints mounted (#176, #177)");

    // GET /api/progress/:speaker — progress data for trend chart (#140)
    app.get("/api/progress/:speaker", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const progress = await gcsHistoryService.getProgressData(speaker);
        res.json({ speeches: progress });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Progress API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to load progress data" });
      }
    });
    logger.info("Progress endpoint mounted at /api/progress/:speaker (#140)");

    // GET /api/export/:speaker/{*path} — Markdown evaluation export (#164)
    app.get("/api/export/:speaker/{*path}", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const evalPrefix = req.params.path; // Everything after /speaker/

        if (!evalPrefix) {
          res.status(400).json({ error: "Missing evaluation prefix" });
          return;
        }

        const prefix = `results/${evalPrefix}`;

        // Read all required files from GCS
        const [metadataRaw, evaluationRaw, metricsRaw, transcriptRaw] = await Promise.all([
          gcsHistoryService.client.readFile(`${prefix}metadata.json`),
          gcsHistoryService.client.readFile(`${prefix}evaluation.json`),
          gcsHistoryService.client.readFile(`${prefix}metrics.json`),
          gcsHistoryService.client.readFile(`${prefix}transcript.json`),
        ]);

        const metadata = JSON.parse(metadataRaw);
        const evalData = JSON.parse(evaluationRaw);
        const metrics = JSON.parse(metricsRaw);
        const transcript = JSON.parse(transcriptRaw);

        const { generateMarkdownReport } = await import("./markdown-export.js");
        const report = generateMarkdownReport({
          metadata,
          evaluation: evalData.evaluation,
          metrics,
          transcript,
        });

        const filename = `${metadata.speechTitle || "evaluation"}-${metadata.date?.split("T")[0] || "report"}.md`;
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(report);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Export API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to generate export" });
      }
    });
    logger.info("Export endpoint mounted at /api/export/:speaker/{*path} (#164)");

    // POST /api/share — create shareable link (#164)
    app.post("/api/share", express.json(), async (req, res) => {
      try {
        const { evalPrefix } = req.body;
        if (!evalPrefix || typeof evalPrefix !== "string") {
          res.status(400).json({ error: "Missing evalPrefix" });
          return;
        }

        // Ensure evaluation exists
        const metadataPath = `${evalPrefix}metadata.json`;
        const exists = await gcsHistoryService.client.fileExists(metadataPath);
        if (!exists) {
          res.status(404).json({ error: "Evaluation not found" });
          return;
        }

        // Check for existing share record
        const { buildSharePath, buildShareIndexPath, createShareRecord } = await import("./share-token.js");
        const sharePath = buildSharePath(evalPrefix);
        const shareExists = await gcsHistoryService.client.fileExists(sharePath);

        if (shareExists) {
          // Return existing share token
          const existing = JSON.parse(await gcsHistoryService.client.readFile(sharePath));
          res.json({ token: existing.token, url: `/share/${existing.token}` });
          return;
        }

        // Create new share record
        const metadataRaw = await gcsHistoryService.client.readFile(metadataPath);
        const metadata = JSON.parse(metadataRaw);
        const record = createShareRecord(metadata.speakerName, evalPrefix);

        // Save share record alongside evaluation
        await gcsHistoryService.client.saveFile(
          sharePath,
          JSON.stringify(record, null, 2),
          "application/json",
        );

        // Save token index for O(1) lookup
        await gcsHistoryService.client.saveFile(
          buildShareIndexPath(record.token),
          JSON.stringify({ evalPrefix, speaker: record.speaker }, null, 2),
          "application/json",
        );

        res.json({ token: record.token, url: `/share/${record.token}` });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Share API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to create share link" });
      }
    });

    // GET /share/:token — public read-only evaluation view (#164)
    app.get("/share/:token", async (req, res) => {
      try {
        const token = req.params.token;
        if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
          res.status(400).send("Invalid share token");
          return;
        }

        const { buildShareIndexPath } = await import("./share-token.js");
        const indexPath = buildShareIndexPath(token);

        const indexExists = await gcsHistoryService.client.fileExists(indexPath);
        if (!indexExists) {
          res.status(404).send("Share link not found or has expired");
          return;
        }

        const indexData = JSON.parse(await gcsHistoryService.client.readFile(indexPath));
        const { evalPrefix } = indexData;

        // Read evaluation data — handle missing files gracefully (#178)
        const safeRead = async (path: string) => {
          try { return await gcsHistoryService.client.readFile(path); }
          catch { return null; }
        };
        const [metadataRaw, evaluationRaw, metricsRaw] = await Promise.all([
          safeRead(`${evalPrefix}metadata.json`),
          safeRead(`${evalPrefix}evaluation.json`),
          safeRead(`${evalPrefix}metrics.json`),
        ]);

        if (!metadataRaw) {
          res.status(404).send("Evaluation data not found");
          return;
        }

        const metadata = JSON.parse(metadataRaw);
        const evalData = evaluationRaw ? JSON.parse(evaluationRaw) : {};
        const metrics = metricsRaw ? JSON.parse(metricsRaw) : {};

        // Check for TTS audio and generate signed URL (#179)
        let audioUrl: string | null = null;
        try {
          const audioPath = `${evalPrefix}evaluation_audio.mp3`;
          if (await gcsHistoryService.client.fileExists(audioPath)) {
            audioUrl = await gcsHistoryService.client.getSignedReadUrl(audioPath, 60);
          }
        } catch { /* audio is optional */ }

        // Serve a self-contained HTML page
        const html = buildSharePage(metadata, evalData.evaluation, metrics, audioUrl);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Share view error: ${errMsg}`);
        res.status(500).send("Failed to load shared evaluation");
      }
    });
    logger.info("Share endpoints mounted (#164)");

    // POST /api/re-evaluate — re-run evaluation with different style (#187)
    if (options.openaiClient) {
      app.post("/api/re-evaluate", express.json(), async (req, res) => {
        try {
          const { evalPrefix, evaluationStyle } = req.body as { evalPrefix?: string; evaluationStyle?: string };
          if (!evalPrefix || typeof evalPrefix !== "string" || !evaluationStyle || typeof evaluationStyle !== "string") {
            res.status(400).json({ error: "Missing evalPrefix or evaluationStyle" });
            return;
          }

          // Read original evaluation data from GCS
          const safeRead = async (path: string) => { try { return await gcsHistoryService.client.readFile(path); } catch { return null; } };
          const [metadataRaw, transcriptRaw, metricsRaw] = await Promise.all([
            safeRead(`${evalPrefix}metadata.json`),
            safeRead(`${evalPrefix}transcript.json`),
            safeRead(`${evalPrefix}metrics.json`),
          ]);

          if (!metadataRaw || !transcriptRaw || !metricsRaw) {
            res.status(404).json({ error: "Original evaluation data not found" });
            return;
          }

          const metadata = JSON.parse(metadataRaw) as import("./gcs-history.js").EvaluationMetadata;
          const transcript = JSON.parse(transcriptRaw) as import("./types.js").TranscriptSegment[];
          const metrics = JSON.parse(metricsRaw) as import("./types.js").DeliveryMetrics;

          // Run evaluation pipeline with new style
          const { runEvaluationStages } = await import("./evaluation-pipeline.js");
          const { EvaluationGenerator } = await import("./evaluation-generator.js");
          const { TTSEngine } = await import("./tts-engine.js");

          const evalGen = new EvaluationGenerator(options.openaiClient as any);
          const ttsEngine = new TTSEngine(options.openaiClient as any);

          const result = await runEvaluationStages({
            transcript,
            metrics,
            evalConfig: {
              evaluationStyle: evaluationStyle as any,
              speechTitle: metadata.speechTitle,
              projectType: metadata.projectType,
            },
            timeLimitSeconds: 180,
          }, {
            evaluationGenerator: evalGen,
            ttsEngine,
          });

          if (!result) {
            res.status(500).json({ error: "Evaluation pipeline returned no result" });
            return;
          }

          // Save as new evaluation with reference to original
          const newPrefix = await gcsHistoryService.saveEvaluationResults({
            speakerName: metadata.speakerName,
            speechTitle: metadata.speechTitle,
            mode: metadata.mode,
            durationSeconds: metadata.durationSeconds,
            wordsPerMinute: metadata.wordsPerMinute,
            passRate: result.passRate,
            projectType: metadata.projectType,
            transcript,
            metrics,
            evaluation: result.evaluation,
            evaluationScript: result.script,
            ttsAudio: result.ttsAudio,
            analysisTier: metadata.analysisTier,
            reEvaluatedFrom: evalPrefix,
          });

          res.json({ status: "ok", newPrefix, evaluation: result.evaluationPublic ?? result.evaluation });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Re-evaluate API error: ${errMsg}`);
          res.status(500).json({ error: "Failed to re-evaluate" });
        }
      });
      logger.info("Re-evaluate endpoint mounted at /api/re-evaluate (#187)");
    }

    // GET /api/improvement-plan/:speaker — personalized practice plan (#145)
    if (options.openaiClient) {
      const openaiClient = options.openaiClient;
      app.get("/api/improvement-plan/:speaker", async (req, res) => {
        try {
          const speaker = decodeURIComponent(req.params.speaker);
          const plan = await generateImprovementPlan(
            gcsHistoryService.client,
            openaiClient,
            speaker,
          );
          if (!plan) {
            res.json({ plan: null, reason: "Not enough evaluations with category scores (minimum 2 required)" });
            return;
          }
          res.json({ plan });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Improvement plan API error: ${errMsg}`);
          res.status(500).json({ error: "Failed to generate improvement plan" });
        }
      });
      logger.info("Improvement plan endpoint mounted at /api/improvement-plan/:speaker (#145)");

      // POST /api/agenda/parse — extract speakers from meeting agenda PDF/text (#174)
      const agendaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
      app.post("/api/agenda/parse", agendaUpload.single("file"), async (req, res) => {
        try {
          if (!req.file) {
            res.status(400).json({ error: "File upload required (PDF, DOCX, or TXT)" });
            return;
          }
          if (!isFormMimeType(req.file.mimetype)) {
            res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}. Accepted: PDF, DOCX, TXT, Markdown` });
            return;
          }
          const result = await extractFormText(req.file.buffer, req.file.mimetype);
          const slots = await parseAgendaFromText(result.text, openaiClient as any);
          res.json({ slots });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Agenda parse API error: ${errMsg}`);
          res.status(500).json({ error: "Failed to parse agenda" });
        }
      });
      logger.info("Agenda parse endpoint mounted at /api/agenda/parse (#174)");
    }

    // GET /api/habits/:speaker — habit/breakthrough patterns (#147)
    app.get("/api/habits/:speaker", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const report = await generateHabitReport(gcsHistoryService.client, speaker);
        if (!report) {
          res.json({ report: null, reason: "Not enough evaluations with category scores (minimum 3 required)" });
          return;
        }
        res.json({ report });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Habits API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to generate habit report" });
      }
    });
    logger.info("Habits endpoint mounted at /api/habits/:speaker (#147)");

    // GET /api/goals/:speaker — retrieve goals + evaluation status (#153)
    app.get("/api/goals/:speaker", async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const goals = await loadGoals(gcsHistoryService.client, speaker);
        if (goals.length === 0) {
          res.json({ goals: [], evaluations: [] });
          return;
        }
        // Evaluate against latest progress
        const progress = await gcsHistoryService.getProgressData(speaker, 50);
        const evaluations = evaluateGoals(goals, progress);
        res.json({ goals, evaluations });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Goals GET API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to load goals" });
      }
    });

    // POST /api/goals/:speaker — create/update goals (#153)
    app.post("/api/goals/:speaker", express.json(), async (req, res) => {
      try {
        const speaker = decodeURIComponent(req.params.speaker);
        const { goals } = req.body as { goals: SpeakerGoal[] };
        if (!Array.isArray(goals)) {
          res.status(400).json({ error: "goals must be an array" });
          return;
        }
        await saveGoals(gcsHistoryService.client, speaker, goals);
        // Return evaluations for immediate display
        const progress = await gcsHistoryService.getProgressData(speaker, 50);
        const evaluations = evaluateGoals(goals, progress);
        res.json({ goals, evaluations });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Goals POST API error: ${errMsg}`);
        res.status(500).json({ error: "Failed to save goals" });
      }
    });
    logger.info("Goals endpoints mounted at /api/goals/:speaker (#153)");
  }

  // WebSocket server — noServer mode when auth is enabled for manual upgrade
  const wss = new WebSocketServer(wsAuthVerify ? { noServer: true } : { server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    handleConnection(ws, sessionManager, logger, roleRegistry, gcsHistoryService);
  });

  // WebSocket upgrade with auth verification
  if (wsAuthVerify) {
    httpServer.on("upgrade", async (req, socket, head) => {
      try {
        const allowed = await wsAuthVerify(req);
        if (!allowed) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      } catch (err) {
        logger.error(`WebSocket upgrade auth error: ${err}`);
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      }
    });
  }

  return {
    app,
    httpServer,
    wss,
    sessionManager,
    listen(port: number): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.listen(port, () => {
          logger.info(`Server listening on port ${port}`);
          resolve();
        });
        httpServer.on("error", reject);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        logger.info("Graceful shutdown initiated", { wsClients: wss.clients.size });

        // Close all WebSocket connections with 1001 (Going Away)
        for (const client of wss.clients) {
          client.close(1001, "Server shutting down");
        }

        // Force-resolve after 10s (Cloud Run sends SIGTERM 10s before kill)
        const forceTimer = setTimeout(() => {
          logger.warn("Graceful shutdown timeout — force closing");
          resolve();
        }, 10_000);

        wss.close(() => {
          httpServer.close((err) => {
            clearTimeout(forceTimer);
            if (err) {
              logger.error("HTTP server close error", { error: err });
              reject(err);
            } else {
              logger.info("Server closed cleanly");
              resolve();
            }
          });
        });
      });
    },
  };
}

// ─── WebSocket Connection Handler ───────────────────────────────────────────────

function handleConnection(
  ws: WebSocket,
  sessionManager: SessionManager,
  logger: ServerLogger,
  roleRegistry: RoleRegistry | null,
  historyService: GcsHistoryService | null,
): void {
  // Each WebSocket connection gets its own session
  const session = sessionManager.createSession();

  const connState: ConnectionState = {
    sessionId: session.id,
    audioFormatValidated: false,
    lastChunkTimestamp: null,
    elapsedTimerInterval: null,
    purgeTimer: null,
    liveTranscriptLength: 0,
    videoStatusInterval: null,
    stopRecordingPromise: null,
    activeRoles: [],
    analysisTier: "standard",
    evaluationStyle: "classic",
    visionFrameBuffer: [],
    sessionMode: "live",
    coachingCueInterval: null,
    coachingCueState: createCueState(),
    meetingId: null,
    meetingSlotId: null,
    meetingClubName: null,
  };

  logger.info(`New WebSocket connection, session ${session.id}`);

  // Send initial state
  sendMessage(ws, { type: "state_change", state: session.state });

  ws.on("message", (data: Buffer | string, isBinary: boolean) => {
    try {
      if (isBinary) {
        handleBinaryMessage(ws, data as Buffer, connState, sessionManager, logger);
      } else {
        const text = typeof data === "string" ? data : data.toString("utf-8");
        const message = JSON.parse(text) as ClientMessage;
        handleClientMessage(ws, message, connState, sessionManager, logger, roleRegistry, historyService);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Error handling message for session ${connState.sessionId}: ${errorMessage}`);
      sendMessage(ws, {
        type: "error",
        message: errorMessage,
        recoverable: true,
      });
    }
  });

  ws.on("close", () => {
    logger.info(`WebSocket closed, session ${connState.sessionId}`);
    cleanupConnection(connState);
  });

  ws.on("error", (err) => {
    logger.error(`WebSocket error for session ${connState.sessionId}: ${err.message}`);
    cleanupConnection(connState);
  });
}

// ─── Binary Message Handler (Audio Chunks) ──────────────────────────────────────

function handleBinaryMessage(
  ws: WebSocket,
  data: Buffer,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  const session = sessionManager.getSession(connState.sessionId);

  // ── TM-prefixed binary frame routing ──
  // Check for TM magic prefix (0x54 0x4D) — type-byte demux, no heuristics
  if (isTMFrame(data)) {
    const frameType = getFrameType(data);

    if (frameType === "video") {
      // Video frame: decode and fire-and-forget to VideoProcessor
      const decoded = decodeVideoFrame(data);
      if (!decoded) {
        // Malformed video frame — silently discard
        return;
      }
      // feedVideoFrame handles state/consent guards internally
      sessionManager.feedVideoFrame(connState.sessionId, decoded.header, decoded.jpegBuffer);
      return;
    }

    if (frameType === "audio") {
      // TM-prefixed audio frame: decode and process synchronously
      const decoded = decodeAudioFrame(data);
      if (!decoded) {
        // Malformed audio frame — silently discard
        return;
      }

      // Reject audio in non-RECORDING states (echo prevention, Req 2.5)
      if (session.state !== SessionState.RECORDING) {
        logger.debug(`[handleBinaryMessage] Rejecting TM audio frame in state="${session.state}" for session ${connState.sessionId}`);
        return;
      }

      sessionManager.feedAudio(connState.sessionId, decoded.pcmBuffer);
      return;
    }

    // Unrecognized type byte — silently discard
    return;
  }

  // ── Legacy raw PCM audio (no TM prefix) — backward compatibility ──

  // Audio format must be validated before accepting audio chunks
  if (!connState.audioFormatValidated) {
    sendMessage(ws, {
      type: "audio_format_error",
      message: "Audio format handshake required before sending audio chunks.",
    });
    return;
  }

  // Reject audio chunks in non-RECORDING states (echo prevention, Req 2.5)
  if (session.state !== SessionState.RECORDING) {
    logger.debug(`[handleBinaryMessage] Rejecting audio chunk in state="${session.state}" for session ${connState.sessionId}`);
    sendMessage(ws, {
      type: "error",
      message: `Audio chunks rejected: session is in "${session.state}" state, not "recording".`,
      recoverable: true,
    });
    return;
  }

  // Validate chunk byte alignment (16-bit PCM = 2 bytes per sample)
  if (data.length % 2 !== 0) {
    sendMessage(ws, {
      type: "audio_format_error",
      message: `Audio chunk byte length (${data.length}) is not a multiple of 2. Expected 16-bit aligned PCM data.`,
    });
    return;
  }

  // Check chunk arrival rate / jitter
  const now = Date.now();
  if (connState.lastChunkTimestamp !== null) {
    const elapsed = now - connState.lastChunkTimestamp;
    const jitter = Math.abs(elapsed - EXPECTED_CHUNK_INTERVAL_MS);
    if (jitter > MAX_CHUNK_JITTER_MS) {
      logger.warn(
        `Chunk jitter ${jitter}ms exceeds ${MAX_CHUNK_JITTER_MS}ms threshold ` +
        `(session ${connState.sessionId}, interval ${elapsed}ms)`,
      );
    }
  }
  connState.lastChunkTimestamp = now;

  // Buffer audio chunk and forward to Deepgram live transcription
  // Privacy: audio chunks are in-memory only, never written to disk
  sessionManager.feedAudio(connState.sessionId, Buffer.from(data));
}

// ─── JSON Client Message Handler ────────────────────────────────────────────────

function handleClientMessage(
  ws: WebSocket,
  message: ClientMessage,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
  roleRegistry: RoleRegistry | null,
  historyService: GcsHistoryService | null,
): void {
  // Helper to catch errors from async handlers and send them to the client
  const catchAsync = (promise: Promise<void>) => {
    promise.catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Async error for session ${connState.sessionId}: ${errorMessage}`);
      sendMessage(ws, {
        type: "error",
        message: errorMessage,
        recoverable: true,
      });
    });
  };

  switch (message.type) {
    case "audio_format":
      handleAudioFormat(ws, message, connState, logger);
      break;

    case "start_recording":
      handleStartRecording(ws, connState, sessionManager, logger);
      break;

    case "stop_recording": {
      const stopPromise = handleStopRecording(ws, connState, sessionManager, logger);
      connState.stopRecordingPromise = stopPromise;
      catchAsync(stopPromise.finally(() => {
        // Clear the reference once complete so we don't hold stale promises
        if (connState.stopRecordingPromise === stopPromise) {
          connState.stopRecordingPromise = null;
        }
      }));
      break;
    }

    case "deliver_evaluation":
      catchAsync(handleDeliverEvaluation(ws, connState, sessionManager, logger, roleRegistry, historyService));
      break;

    case "save_outputs":
      handleSaveOutputs(ws, connState, sessionManager, logger);
      break;

    case "panic_mute":
      handlePanicMute(ws, connState, sessionManager, logger);
      break;

    case "audio_chunk":
      // audio_chunk as JSON is unusual — binary is the expected path.
      // But handle it gracefully if the client sends it as JSON.
      sendMessage(ws, {
        type: "error",
        message: "Audio chunks should be sent as binary WebSocket frames, not JSON.",
        recoverable: true,
      });
      break;

    case "replay_tts":
      catchAsync(handleReplayTTS(ws, connState, sessionManager, logger));
      break;

    case "set_consent":
      handleSetConsent(ws, message, connState, sessionManager, logger);
      break;

    case "revoke_consent":
      handleRevokeConsent(ws, connState, sessionManager, logger);
      break;

    case "set_time_limit":
      handleSetTimeLimit(ws, message, connState, sessionManager, logger);
      break;

    case "set_project_context":
      handleSetProjectContext(ws, message, connState, sessionManager, logger);
      break;

    case "set_vad_config":
      handleSetVADConfig(ws, message, connState, sessionManager, logger);
      break;

    case "set_video_consent":
      handleSetVideoConsent(ws, message, connState, sessionManager, logger);
      break;

    case "video_stream_ready":
      handleVideoStreamReady(ws, message, connState, sessionManager, logger);
      break;

    case "set_video_config":
      handleSetVideoConfig(ws, message, connState, sessionManager, logger);
      break;

    case "set_active_roles":
      connState.activeRoles = message.roleIds ?? [];
      logger.info(`Active roles set: [${connState.activeRoles.join(", ")}] for session ${connState.sessionId}`);
      break;

    case "set_analysis_tier":
      connState.analysisTier = message.tier ?? "standard";
      connState.visionFrameBuffer = []; // Reset buffer on tier change
      logger.info(`Analysis tier set: ${connState.analysisTier} for session ${connState.sessionId}`);
      break;

    case "set_session_mode":
      connState.sessionMode = message.mode === "practice" ? "practice" : "live";
      logger.info(`Session mode set: ${connState.sessionMode} for session ${connState.sessionId}`);
      break;

    case "set_evaluation_style": {
      const requestedStyle = message.style ?? "classic";
      const validStyles = Object.values(EvaluationStyle) as string[];
      if (!validStyles.includes(requestedStyle)) {
        sendMessage(ws, {
          type: "error",
          message: `Invalid evaluation style: "${requestedStyle}". Valid styles: ${validStyles.join(", ")}`,
          recoverable: true,
        });
        break;
      }
      connState.evaluationStyle = requestedStyle;
      logger.info(`Evaluation style set: ${connState.evaluationStyle} for session ${connState.sessionId}`);
      break;
    }
    case "set_notes": {
      // Operator notes — mutable during IDLE + RECORDING (#164)
      try {
        sessionManager.setNotes(connState.sessionId, message.notes ?? "");
      } catch (err) {
        sendMessage(ws, {
          type: "error",
          message: `Failed to set notes: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        });
      }
      break;
    }
    case "set_meeting_context": {
      // Store meeting context for grouped evaluation persistence (#174)
      connState.meetingId = message.meetingId;
      connState.meetingSlotId = message.slotId;
      connState.meetingClubName = message.clubName ?? null;
      break;
    }
    case "vision_frame": {
      // Buffer base64 frame data for GPT-4o Vision analysis (#128)
      const tierConfig = getTierConfig(
        Object.values(AnalysisTier).includes(connState.analysisTier as AnalysisTier)
          ? (connState.analysisTier as AnalysisTier)
          : AnalysisTier.Standard,
      );
      if (!tierConfig.vision || connState.visionFrameBuffer.length >= tierConfig.maxFrames) {
        break; // Drop frame — vision disabled or buffer full
      }
      connState.visionFrameBuffer.push(message.data);
      break;
    }

    default: {
      const exhaustiveCheck: never = message;
      sendMessage(ws, {
        type: "error",
        message: `Unknown message type: ${(exhaustiveCheck as { type: string }).type}`,
        recoverable: true,
      });
    }
  }
}

// ─── Audio Format Handshake ─────────────────────────────────────────────────────

function handleAudioFormat(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "audio_format" }>,
  connState: ConnectionState,
  logger: ServerLogger,
): void {
  const errors: string[] = [];

  if (message.channels !== EXPECTED_FORMAT.channels) {
    errors.push(`Expected ${EXPECTED_FORMAT.channels} channel(s), got ${message.channels}`);
  }
  if (message.sampleRate !== EXPECTED_FORMAT.sampleRate) {
    errors.push(`Expected sample rate ${EXPECTED_FORMAT.sampleRate}, got ${message.sampleRate}`);
  }
  if (message.encoding !== EXPECTED_FORMAT.encoding) {
    errors.push(`Expected encoding "${EXPECTED_FORMAT.encoding}", got "${message.encoding}"`);
  }

  if (errors.length > 0) {
    const errorMsg = `Audio format validation failed: ${errors.join("; ")}`;
    logger.warn(`${errorMsg} (session ${connState.sessionId})`);
    sendMessage(ws, { type: "audio_format_error", message: errorMsg });
    return;
  }

  connState.audioFormatValidated = true;
  logger.info(`Audio format validated for session ${connState.sessionId}`);
}

// ─── Start Recording ────────────────────────────────────────────────────────────

function handleStartRecording(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  const session = sessionManager.getSession(connState.sessionId);

  // Gate on consent confirmation (Req 2.3) — reject if consent not confirmed
  if (!session.consent?.consentConfirmed) {
    logger.warn(`start_recording rejected: consent not confirmed for session ${connState.sessionId}`);
    sendMessage(ws, {
      type: "error",
      message: "Cannot start recording: speaker consent has not been confirmed.",
      recoverable: true,
    });
    return;
  }

  // Cancel any pending auto-purge timer when starting a new recording
  clearPurgeTimer(connState);

  // Register VAD callbacks BEFORE startRecording() so SessionManager can wire them
  // into the VADMonitor when it creates one. Callbacks are wrapped in try/catch
  // to prevent WebSocket errors from affecting recording.
  sessionManager.registerVADCallbacks(connState.sessionId, {
    onSpeechEnd: (silenceDuration: number) => {
      try {
        sendMessage(ws, { type: "vad_speech_end", silenceDurationSeconds: silenceDuration });
      } catch {
        // WebSocket send failure must not affect recording
      }
    },
    onStatus: (status: VADStatus) => {
      try {
        sendMessage(ws, { type: "vad_status", energy: status.energy, isSpeech: status.isSpeech });
      } catch {
        // WebSocket send failure must not affect recording
      }
    },
  });

  sessionManager.startRecording(connState.sessionId, (segment) => {
    // Push live transcript segments to the client as they arrive from Deepgram.
    // Uses replaceFromIndex semantics: interim results replace the last segment,
    // final results append.
    const session = sessionManager.getSession(connState.sessionId);
    if (segment.isFinal) {
      // Final segment: append after all previously finalized segments
      const finalCount = session.liveTranscript.filter((s) => s.isFinal).length;
      sendTranscriptUpdate(ws, [segment], finalCount - 1);
      connState.liveTranscriptLength = finalCount;
    } else {
      // Interim segment: replace from the current finalized count onward
      sendTranscriptUpdate(ws, [segment], connState.liveTranscriptLength);
    }
  }, (status) => {
    // Forward Deepgram reconnection status to the client (#139)
    try {
      ws.send(JSON.stringify({ type: "transcription_status", status }));
    } catch {
      // WebSocket may already be closed
    }
  });
  logger.info(`Recording started for session ${connState.sessionId}`);

  // Reset connection state for new recording
  connState.lastChunkTimestamp = null;
  connState.liveTranscriptLength = 0;

  // Notify client of state change
  sendMessage(ws, { type: "state_change", state: SessionState.RECORDING });

  // Start elapsed time ticker (every second during RECORDING)
  startElapsedTimeTicker(ws, connState, session, sessionManager, logger);

  // Start periodic video_status sender (≤1/sec during RECORDING)
  startVideoStatusSender(ws, connState, sessionManager);

  // Start coaching cue timer (practice mode only, #155)
  if (connState.sessionMode === "practice") {
    startCoachingCueTicker(ws, connState, sessionManager, logger);
  }
}

// ─── Stop Recording ─────────────────────────────────────────────────────────────

async function handleStopRecording(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  stopElapsedTimeTicker(connState);
  stopCoachingCueTicker(connState);
  stopVideoStatusSender(connState);

  // Capture video processor reference before stopRecording (which may remove it)
  const videoProcessor = sessionManager.getVideoProcessor(connState.sessionId);

  await sessionManager.stopRecording(connState.sessionId);
  logger.info(`Recording stopped for session ${connState.sessionId}`);

  // Send final video_status with finalization counters if video was active
  const sessionAfterStop = sessionManager.getSession(connState.sessionId);
  if (sessionAfterStop.visualObservations && ws.readyState === WebSocket.OPEN) {
    const obs = sessionAfterStop.visualObservations;
    sendMessage(ws, {
      type: "video_status",
      framesProcessed: obs.framesAnalyzed,
      framesDropped: obs.framesSkippedBySampler + obs.framesDroppedByBackpressure,
      processingLatencyMs: 0,
      framesReceived: obs.framesReceived,
      framesSkippedBySampler: obs.framesSkippedBySampler,
      framesDroppedByBackpressure: obs.framesDroppedByBackpressure,
      framesDroppedByTimestamp: obs.framesDroppedByTimestamp,
      framesErrored: obs.framesErrored,
      effectiveSamplingRate: 0,
      finalizationLatencyMs: obs.finalizationLatencyMs,
      videoQualityGrade: obs.videoQualityGrade,
    });
  }

  const session = sessionAfterStop;

  sendMessage(ws, { type: "state_change", state: SessionState.PROCESSING });

  // Send final transcript to client
  if (session.transcript.length > 0) {
    sendTranscriptUpdate(ws, session.transcript, 0);
  }

  // Notify client of quality warning (transcription drop or post-pass fallback)
  if (session.qualityWarning) {
    sendMessage(ws, {
      type: "error",
      message: "Transcription quality warning: audio quality issues were detected. The evaluation will proceed with best-effort transcript data.",
      recoverable: true,
    });
  }

  // Send initial progress — processing_speech is emitted by the stop-recording flow
  // (not by the eager pipeline) to indicate transcription/metrics are complete (Hazard 4).
  sendMessage(ws, { type: "pipeline_progress", stage: "processing_speech", runId: session.runId });

  // Kick off eager pipeline — capture runId at this point for progress callback closure.
  // SessionManager owns session.eagerPromise (assigned inside runEagerPipeline per Hazard 1).
  // The server only reads it (in handleDeliverEvaluation), never writes it.
  const capturedRunId = session.runId;
  sessionManager.runEagerPipeline(
    connState.sessionId,
    (stage) => sendMessage(ws, { type: "pipeline_progress", stage, runId: capturedRunId }),
  );
}


// ─── Persist to GCS History (#168) ──────────────────────────────────────────────

/**
 * Fire-and-forget: persist evaluation results to GCS so they show in History.
 * Errors are logged but never block the delivery flow.
 */
function persistToHistory(
  connState: ConnectionState,
  session: Session,
  ttsAudio: Buffer | undefined,
  logger: ServerLogger,
  historyService: GcsHistoryService | null,
): void {
  if (!historyService) return;
  if (!session.evaluation || !session.metrics || !session.consent) {
    logger.debug(`[persistToHistory] Skipping — missing evaluation, metrics, or consent for session ${connState.sessionId}`);
    return;
  }

  // Fire-and-forget — never block delivery
  historyService.saveEvaluationResults({
    speakerName: session.consent.speakerName,
    speechTitle: session.projectContext?.speechTitle || "Untitled",
    mode: connState.sessionMode,
    durationSeconds: session.metrics.durationSeconds,
    wordsPerMinute: session.metrics.wordsPerMinute,
    passRate: session.evaluationPassRate ?? 0,
    projectType: session.projectContext?.projectType ?? undefined,
    transcript: session.transcript,
    metrics: session.metrics,
    evaluation: session.evaluation,
    evaluationScript: session.evaluationScript ?? undefined,
    ttsAudio,
    speechAudio: session.audioChunks.length > 0 ? Buffer.concat(session.audioChunks) : undefined,
    analysisTier: connState.analysisTier,
    visionFrameCount: connState.visionFrameBuffer.length,
  }).then((prefix: string | null) => {
    if (prefix) {
      logger.info(`[persistToHistory] Saved to GCS: ${prefix}`);
    } else {
      logger.warn(`[persistToHistory] GCS save returned null for session ${connState.sessionId}`);
    }
  }).catch((err: unknown) => {
    logger.error(`[persistToHistory] GCS save failed for session ${connState.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Dual-write: also save under meeting prefix if in meeting mode (#176)
  if (connState.meetingId && connState.meetingSlotId) {
    const saveInput = {
      speakerName: session.consent.speakerName,
      speechTitle: session.projectContext?.speechTitle || "Untitled",
      mode: connState.sessionMode as "live" | "upload" | "practice",
      durationSeconds: session.metrics.durationSeconds,
      wordsPerMinute: session.metrics.wordsPerMinute,
      passRate: session.evaluationPassRate ?? 0,
      projectType: session.projectContext?.projectType ?? undefined,
      transcript: session.transcript,
      metrics: session.metrics,
      evaluation: session.evaluation,
      evaluationScript: session.evaluationScript ?? undefined,
      ttsAudio,
      speechAudio: session.audioChunks.length > 0 ? Buffer.concat(session.audioChunks) : undefined,
      analysisTier: connState.analysisTier,
      visionFrameCount: connState.visionFrameBuffer.length,
    };
    historyService.saveMeetingSlotEvaluation(
      connState.meetingId,
      connState.meetingSlotId,
      saveInput,
    ).catch((err: unknown) => {
      logger.error(`[persistToHistory] Meeting slot save failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}


// ─── Deliver Evaluation ─────────────────────────────────────────────────────────

async function handleDeliverEvaluation(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
  roleRegistry: RoleRegistry | null,
  historyService: GcsHistoryService | null,
): Promise<void> {
  const session = sessionManager.getSession(connState.sessionId);

  // Re-entrancy guard: ignore deliver_evaluation if already delivering (Req 5.6)
  if (session.state === SessionState.DELIVERING) {
    logger.debug(`[handleDeliverEvaluation] Ignoring deliver_evaluation — already in DELIVERING state for session ${connState.sessionId}`);
    return;
  }

  logger.debug(`[handleDeliverEvaluation] Starting delivery for session ${connState.sessionId}`);

  // Await in-flight stopRecording if it hasn't completed yet.
  // This prevents a race where deliver_evaluation arrives before post-speech
  // transcription finishes, which would cause "No transcript available".
  if (connState.stopRecordingPromise) {
    logger.debug(`[handleDeliverEvaluation] Awaiting in-flight stopRecording for session ${connState.sessionId}`);
    await connState.stopRecordingPromise;
  }

  // ── Branch 1: Cache hit — deliver from eager cache immediately ──
  if (sessionManager.isEagerCacheValid(connState.sessionId)) {
    logger.info(`[handleDeliverEvaluation] Cache hit — delivering from eager cache for session ${connState.sessionId}`);
    deliverFromCache(ws, connState, sessionManager, logger, historyService);
    return;
  }

  // ── Branch 2: Await in-flight eager pipeline ──
  // Snapshot BOTH promise AND runId before any async work (Hazard 6).
  // The promise may be nulled by the pipeline's finally block; the runId detects
  // invalidation during await.
  const eagerP = session.eagerPromise;
  const snapshotRunId = session.runId;

  if (eagerP !== null && (session.eagerStatus === "generating" || session.eagerStatus === "synthesizing")) {
    logger.info(`[handleDeliverEvaluation] Eager pipeline in-flight (status: ${session.eagerStatus}) — awaiting for session ${connState.sessionId}`);

    // Guaranteed to resolve per never-reject contract — no try/catch needed around await
    await eagerP;

    // After await: check if runId changed (invalidation during await)
    if (session.runId !== snapshotRunId) {
      logger.info(`[handleDeliverEvaluation] RunId changed during await (${snapshotRunId} → ${session.runId}) — falling through to synchronous fallback for session ${connState.sessionId}`);
      // Fall through to Branch 3
    } else if (sessionManager.isEagerCacheValid(connState.sessionId)) {
      logger.info(`[handleDeliverEvaluation] Eager pipeline completed successfully — delivering from cache for session ${connState.sessionId}`);
      deliverFromCache(ws, connState, sessionManager, logger, historyService);
      return;
    } else {
      logger.info(`[handleDeliverEvaluation] Eager pipeline completed but cache invalid — falling through to synchronous fallback for session ${connState.sessionId}`);
      // Fall through to Branch 3
    }
  }

  // ── Branch 3: Synchronous fallback — run existing generateEvaluation() pipeline ──
  logger.info(`[handleDeliverEvaluation] Running synchronous fallback pipeline for session ${connState.sessionId}`);

  let audioBuffer: Buffer | undefined;

  try {
    audioBuffer = await sessionManager.generateEvaluation(
      connState.sessionId,
      connState.visionFrameBuffer.length > 0 ? connState.visionFrameBuffer : undefined,
    );
    logger.debug(`[handleDeliverEvaluation] generateEvaluation returned ${audioBuffer ? `${audioBuffer.length} bytes` : "undefined"} for session ${connState.sessionId}`);
  } catch (err) {
    // LLM failure: session has been transitioned back to PROCESSING by SessionManager (Req 7.3)
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Evaluation generation failed for session ${connState.sessionId}: ${errorMessage}`);

    const sessionAfterError = sessionManager.getSession(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: sessionAfterError.state });
    sendMessage(ws, {
      type: "error",
      message: `Evaluation generation failed: ${errorMessage}. You can retry.`,
      recoverable: true,
    });
    return;
  }

  const sessionAfterGen = sessionManager.getSession(connState.sessionId);

  // Send state change to DELIVERING
  sendMessage(ws, { type: "state_change", state: sessionAfterGen.state });
  logger.debug(`[handleDeliverEvaluation] State changed to ${sessionAfterGen.state} for session ${connState.sessionId}`);

  // Send evaluation_ready with the structured evaluation and script (Req 5.4)
  if (sessionAfterGen.evaluation && sessionAfterGen.evaluationScript) {
    const evalPayload = sessionAfterGen.evaluationPublic ?? sessionAfterGen.evaluation;
    sendMessage(ws, {
      type: "evaluation_ready",
      evaluation: evalPayload as StructuredEvaluationPublic,
      script: sessionAfterGen.evaluationScript,
    });
    logger.debug(`[handleDeliverEvaluation] Sent evaluation_ready for session ${connState.sessionId}`);
  }

  // ── Run meeting roles if any are active (Phase 9, #72) ──
  if (connState.activeRoles.length > 0 && roleRegistry) {
    try {
      const session = sessionManager.getSession(connState.sessionId);
      const roleContext = {
        transcript: session.transcript ?? [],
        metrics: session.metrics ?? null,
        visualObservations: session.visualObservations ?? null,
        projectContext: session.projectContext ?? null,
        consent: session.consent ?? null,
        speakerName: session.consent?.speakerName ?? null,
        config: {},
      };

      const roleResults = [];
      for (const roleId of connState.activeRoles) {
        const role = roleRegistry.get(roleId);
        if (!role) {
          logger.warn(`[Roles] Unknown role: ${roleId}`);
          continue;
        }
        try {
          const result = await roleRegistry.run(roleId, roleContext);
          roleResults.push({
            roleId: result.roleId,
            roleName: role.name,
            report: result.report,
            script: result.script,
          });
          logger.info(`[Roles] ${role.name} completed for session ${connState.sessionId}`);
        } catch (roleErr) {
          logger.warn(`[Roles] ${role.name} failed: ${roleErr instanceof Error ? roleErr.message : String(roleErr)}`);
        }
      }

      if (roleResults.length > 0) {
        sendMessage(ws, { type: "role_results", results: roleResults });
        logger.info(`[Roles] Sent ${roleResults.length} role result(s) for session ${connState.sessionId}`);
      }
    } catch (roleErr) {
      logger.warn(`[Roles] Role execution failed: ${roleErr instanceof Error ? roleErr.message : String(roleErr)}`);
    }
  }

  if (audioBuffer) {
    // TTS succeeded: stream audio and complete
    logger.info(`Streaming TTS audio for session ${connState.sessionId} (${audioBuffer.length} bytes)`);

    // Send TTS audio as a raw binary WebSocket frame
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audioBuffer);
      logger.debug(`[handleDeliverEvaluation] Binary audio frame sent (${audioBuffer.length} bytes) for session ${connState.sessionId}`);
    } else {
      logger.warn(`[handleDeliverEvaluation] WebSocket not open, skipping audio send for session ${connState.sessionId}`);
    }
    sendMessage(ws, { type: "tts_complete" });

    // Persist to GCS history (#168) — fire-and-forget before transitioning to IDLE
    persistToHistory(connState, sessionAfterGen, audioBuffer, logger, historyService);

    // Transition back to IDLE after TTS delivery
    sessionManager.completeDelivery(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: SessionState.IDLE });

    // Start auto-purge timer (privacy: 10-minute retention after delivery)
    startPurgeTimer(connState, sessionManager, logger, ws);
  } else if (sessionAfterGen.evaluation && sessionAfterGen.evaluationScript) {
    // TTS failure: evaluation and script are available but no audio (Req 7.4)
    logger.warn(`TTS synthesis failed for session ${connState.sessionId}, falling back to written evaluation`);

    sendMessage(ws, {
      type: "error",
      message: "Text-to-speech synthesis failed. The written evaluation is displayed as a fallback.",
      recoverable: false,
    });

    // Persist to GCS history (#168) — save even without audio
    persistToHistory(connState, sessionAfterGen, undefined, logger, historyService);

    // Complete delivery even without audio — the written evaluation is the fallback
    sessionManager.completeDelivery(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: SessionState.IDLE });

    // Start auto-purge timer
    startPurgeTimer(connState, sessionManager, logger, ws);
  } else {
    // No evaluation generated (e.g., no transcript/metrics available)
    logger.warn(`No evaluation generated for session ${connState.sessionId}`);

    sessionManager.completeDelivery(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: SessionState.IDLE });
  }
}


/**
 * Delivers evaluation from the eager cache (Branch 1 / Branch 2 cache-hit path).
 * Transitions to DELIVERING, sends evaluation_ready + cached TTS audio, completes delivery.
 *
 * Precondition: isEagerCacheValid() must be true before calling.
 */
function deliverFromCache(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
  historyService: GcsHistoryService | null,
): void {
  const session = sessionManager.getSession(connState.sessionId);
  const cache = session.evaluationCache!;

  // Promote cached artifacts to session fields so that saveSession (formatEvaluation)
  // can find them. The eager pipeline stores everything in evaluationCache but
  // formatEvaluation reads session.evaluationScript / evaluationPublic / evaluation.
  session.evaluation = cache.evaluation;
  session.evaluationScript = cache.evaluationScript;
  if (cache.evaluationPublic) {
    session.evaluationPublic = cache.evaluationPublic;
  }

  // Transition to DELIVERING — set state directly since we're skipping generateEvaluation()
  // which normally handles this transition. The session is in PROCESSING state here.
  session.state = SessionState.DELIVERING;
  sendMessage(ws, { type: "state_change", state: SessionState.DELIVERING });

  // Send evaluation_ready with the public (redacted) evaluation and script (Req 5.4)
  sendMessage(ws, {
    type: "evaluation_ready",
    evaluation: cache.evaluationPublic!,
    script: cache.evaluationScript,
  });
  logger.debug(`[deliverFromCache] Sent evaluation_ready for session ${connState.sessionId}`);

  // Send cached TTS audio as a raw binary WebSocket frame — no blocking work (Req 5.1)
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(cache.ttsAudio);
    logger.debug(`[deliverFromCache] Binary audio frame sent (${cache.ttsAudio.length} bytes) for session ${connState.sessionId}`);
  } else {
    logger.warn(`[deliverFromCache] WebSocket not open, skipping audio send for session ${connState.sessionId}`);
  }
  sendMessage(ws, { type: "tts_complete" });

  // Persist to GCS history (#168) — fire-and-forget before transitioning to IDLE
  persistToHistory(connState, session, cache.ttsAudio, logger, historyService);

  // Transition back to IDLE after TTS delivery
  sessionManager.completeDelivery(connState.sessionId);
  sendMessage(ws, { type: "state_change", state: SessionState.IDLE });

  // Start auto-purge timer (privacy: 10-minute retention after delivery)
  // evaluationCache remains available for replay_tts until auto-purge fires (Req 5.7)
  startPurgeTimer(connState, sessionManager, logger, ws);
}


// ─── Replay TTS ─────────────────────────────────────────────────────────────────

async function handleReplayTTS(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  let audioBuffer: Buffer | undefined;

  logger.debug(`[handleReplayTTS] Replay requested for session ${connState.sessionId}`);

  try {
    audioBuffer = sessionManager.replayTTS(connState.sessionId);
    logger.debug(`[handleReplayTTS] replayTTS returned ${audioBuffer ? `${audioBuffer.length} bytes` : "undefined"} for session ${connState.sessionId}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Replay TTS failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
    return;
  }

  if (!audioBuffer) {
    logger.debug(`[handleReplayTTS] No audio buffer available for session ${connState.sessionId}`);
    sendMessage(ws, {
      type: "error",
      message: "No TTS audio available for replay.",
      recoverable: true,
    });
    return;
  }

  // Send state change to DELIVERING
  sendMessage(ws, { type: "state_change", state: SessionState.DELIVERING });
  logger.debug(`[handleReplayTTS] State changed to DELIVERING for session ${connState.sessionId}`);

  // Send TTS audio as a raw binary WebSocket frame
  logger.info(`Replaying TTS audio for session ${connState.sessionId} (${audioBuffer.length} bytes)`);
  logger.debug(`[handleReplayTTS] WebSocket readyState=${ws.readyState} (OPEN=${WebSocket.OPEN}) before sending audio for session ${connState.sessionId}`);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(audioBuffer);
    logger.debug(`[handleReplayTTS] Binary audio frame sent (${audioBuffer.length} bytes) for session ${connState.sessionId}`);
  } else {
    logger.warn(`[handleReplayTTS] WebSocket not open, skipping audio send for session ${connState.sessionId}`);
  }
  sendMessage(ws, { type: "tts_complete" });
  logger.debug(`[handleReplayTTS] Sent tts_complete for session ${connState.sessionId}`);

  // Transition back to IDLE
  sessionManager.completeDelivery(connState.sessionId);
  sendMessage(ws, { type: "state_change", state: SessionState.IDLE });
  logger.debug(`[handleReplayTTS] Transitioned to IDLE for session ${connState.sessionId}`);

  // Restart auto-purge timer (privacy: 10-minute retention after delivery)
  startPurgeTimer(connState, sessionManager, logger, ws);
}


// ─── Save Outputs ───────────────────────────────────────────────────────────────

function handleSaveOutputs(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  const session = sessionManager.getSession(connState.sessionId);

  // Save outputs is only valid when there's data to save
  if (!session.transcript.length && !session.evaluation && !session.metrics) {
    sendMessage(ws, {
      type: "error",
      message: "No session data available to save.",
      recoverable: true,
    });
    return;
  }

  // Serialize files for client-side download (always available, no disk dependency)
  const files = serializeOutputs(session);

  // Attempt server-side persistence (optional secondary storage)
  sessionManager
    .saveOutputs(connState.sessionId)
    .then((paths) => {
      session.outputsSaved = true;
      sendMessage(ws, { type: "outputs_saved", paths, files });
      if (paths.length > 0) {
        logger.info(`Outputs saved for session ${connState.sessionId}: ${paths.join(", ")}`);
      } else {
        logger.info(`Outputs serialized for download (no disk persistence) for session ${connState.sessionId}`);
      }
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to save outputs for session ${connState.sessionId}: ${errorMessage}`);
      // Still send files for download even if disk persistence fails
      session.outputsSaved = true;
      sendMessage(ws, { type: "outputs_saved", paths: [], files });
    });
}


// ─── Panic Mute ─────────────────────────────────────────────────────────────────

function handlePanicMute(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  stopElapsedTimeTicker(connState);
  stopCoachingCueTicker(connState);
  stopVideoStatusSender(connState);

  sessionManager.panicMute(connState.sessionId);
  logger.info(`Panic mute activated for session ${connState.sessionId}`);

  sendMessage(ws, { type: "state_change", state: SessionState.IDLE });
}

// ─── Set Consent (Req 2.1, 2.3) ────────────────────────────────────────────────

function handleSetConsent(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_consent" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    sessionManager.setConsent(connState.sessionId, message.speakerName, message.consentConfirmed);
    const session = sessionManager.getSession(connState.sessionId);
    sendMessage(ws, { type: "consent_status", consent: session.consent });
    logger.info(`Consent set for session ${connState.sessionId}: speaker="${message.speakerName}", confirmed=${message.consentConfirmed}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`set_consent failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

// ─── Revoke Consent / Speaker Opt-Out (Req 2.7) ────────────────────────────────

function handleRevokeConsent(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  // Stop any active timers — session is being purged
  stopElapsedTimeTicker(connState);
  stopCoachingCueTicker(connState);
  clearPurgeTimer(connState);

  sessionManager.revokeConsent(connState.sessionId);
  logger.info(`Consent revoked (opt-out) for session ${connState.sessionId}`);

  // Notify client of data purge and state change
  sendMessage(ws, { type: "data_purged", reason: "opt_out" });
  sendMessage(ws, { type: "state_change", state: SessionState.IDLE });
}

// ─── Set Time Limit (Req 6.8) ──────────────────────────────────────────────────

function handleSetTimeLimit(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_time_limit" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  const session = sessionManager.getSession(connState.sessionId);
  session.timeLimitSeconds = message.seconds;
  logger.info(`Time limit set to ${message.seconds}s for session ${connState.sessionId}`);

  sendMessage(ws, {
    type: "duration_estimate",
    estimatedSeconds: message.seconds,
    timeLimitSeconds: message.seconds,
  });

  // Invalidate eager cache if session is in PROCESSING state and eager data exists or is in-flight.
  // invalidateEagerCache() calls cancelEagerGeneration() internally — increments runId.
  if (
    session.state === SessionState.PROCESSING &&
    (session.evaluationCache !== null ||
      session.eagerStatus === "generating" ||
      session.eagerStatus === "synthesizing" ||
      session.eagerStatus === "ready")
  ) {
    sessionManager.invalidateEagerCache(connState.sessionId);
    logger.info(`Eager cache invalidated due to time limit change for session ${connState.sessionId}`);

    // Send pipeline_progress: invalidated with the NEW runId (post-increment).
    // NOT processing_speech — that stage means "transcription complete" per Hazard 4.
    // UI maps this to "Settings changed — evaluation will regenerate on delivery".
    sendMessage(ws, {
      type: "pipeline_progress",
      stage: "invalidated",
      runId: session.runId,
    });
  }
}

// ─── Set Project Context (Phase 3 — Req 4.8, 6.1, 6.2, 6.3) ───────────────────

function handleSetProjectContext(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_project_context" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    // Validate input constraints (Req 4.8)
    if (typeof message.speechTitle !== "string" || message.speechTitle.length > 200) {
      sendMessage(ws, {
        type: "error",
        message: "speechTitle must be a string of at most 200 characters",
        recoverable: true,
      });
      return;
    }
    if (typeof message.projectType !== "string" || message.projectType.length > 100) {
      sendMessage(ws, {
        type: "error",
        message: "projectType must be a string of at most 100 characters",
        recoverable: true,
      });
      return;
    }
    if (!Array.isArray(message.objectives) || message.objectives.length > 10) {
      sendMessage(ws, {
        type: "error",
        message: "objectives must be an array of at most 10 items",
        recoverable: true,
      });
      return;
    }
    for (const obj of message.objectives) {
      if (typeof obj !== "string" || obj.length > 500) {
        sendMessage(ws, {
          type: "error",
          message: "Each objective must be a string of at most 500 characters",
          recoverable: true,
        });
        return;
      }
    }

    sessionManager.setProjectContext(connState.sessionId, {
      speechTitle: message.speechTitle || null,
      projectType: message.projectType || null,
      objectives: message.objectives,
      evaluationStyle: connState.evaluationStyle,
    });
    logger.info(`Project context set for session ${connState.sessionId}: title="${message.speechTitle}", type="${message.projectType}", objectives=${message.objectives.length}, style=${connState.evaluationStyle}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`set_project_context failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

// ─── Set VAD Config (Phase 3 — Req 3.1, 6.4, 6.5) ─────────────────────────────

function handleSetVADConfig(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_vad_config" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    // Validate input (Req 3.1)
    if (typeof message.silenceThresholdSeconds !== "number" || !Number.isFinite(message.silenceThresholdSeconds)) {
      sendMessage(ws, {
        type: "error",
        message: "silenceThresholdSeconds must be a finite number",
        recoverable: true,
      });
      return;
    }
    if (message.silenceThresholdSeconds < 3 || message.silenceThresholdSeconds > 15) {
      sendMessage(ws, {
        type: "error",
        message: "silenceThresholdSeconds must be between 3 and 15",
        recoverable: true,
      });
      return;
    }
    if (typeof message.enabled !== "boolean") {
      sendMessage(ws, {
        type: "error",
        message: "enabled must be a boolean",
        recoverable: true,
      });
      return;
    }

    sessionManager.setVADConfig(connState.sessionId, {
      silenceThresholdSeconds: message.silenceThresholdSeconds,
      enabled: message.enabled,
    });
    logger.info(`VAD config set for session ${connState.sessionId}: threshold=${message.silenceThresholdSeconds}s, enabled=${message.enabled}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`set_vad_config failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

// ─── Phase 4: Video Message Handlers ──────────────────────────────────────────

function handleSetVideoConsent(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_video_consent" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    sessionManager.setVideoConsent(connState.sessionId, {
      consentGranted: message.consentGranted,
      timestamp: new Date(message.timestamp),
    });
    logger.info(`Video consent set for session ${connState.sessionId}: granted=${message.consentGranted}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`set_video_consent failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

function handleVideoStreamReady(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "video_stream_ready" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    // deviceLabel is accepted for protocol compatibility but NOT stored/logged (Req 11.7)
    sessionManager.setVideoStreamReady(connState.sessionId, message.deviceLabel);
    logger.info(`Video stream ready for session ${connState.sessionId}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`video_stream_ready failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

function handleSetVideoConfig(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "set_video_config" }>,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  try {
    sessionManager.setVideoConfig(connState.sessionId, {
      frameRate: message.frameRate,
    });
    logger.info(`Video config set for session ${connState.sessionId}: frameRate=${message.frameRate}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`set_video_config failed for session ${connState.sessionId}: ${errorMessage}`);
    sendMessage(ws, {
      type: "error",
      message: errorMessage,
      recoverable: true,
    });
  }
}

// ─── Video Status Sender ────────────────────────────────────────────────────────

function startVideoStatusSender(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
): void {
  stopVideoStatusSender(connState);

  connState.videoStatusInterval = setInterval(() => {
    const processor = sessionManager.getVideoProcessor(connState.sessionId);
    if (processor && ws.readyState === WebSocket.OPEN) {
      const status = processor.getExtendedStatus();
      sendMessage(ws, {
        type: "video_status",
        ...status,
      });
    }
  }, 1000);
}

function stopVideoStatusSender(connState: ConnectionState): void {
  if (connState.videoStatusInterval !== null) {
    clearInterval(connState.videoStatusInterval);
    connState.videoStatusInterval = null;
  }
}


// ─── Elapsed Time Ticker ────────────────────────────────────────────────────────

function startElapsedTimeTicker(
  ws: WebSocket,
  connState: ConnectionState,
  session: Session,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  // Clear any existing ticker
  stopElapsedTimeTicker(connState);

  const recordingStartTime = Date.now();

  connState.elapsedTimerInterval = setInterval(() => {
    // Check if session is still in RECORDING state
    try {
      const currentSession = sessionManager.getSession(connState.sessionId);
      if (currentSession.state !== SessionState.RECORDING) {
        stopElapsedTimeTicker(connState);
        return;
      }

      const elapsedSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);

      sendMessage(ws, { type: "elapsed_time", seconds: elapsedSeconds });

      // Enforce max speech duration (25 minutes = 1500 seconds)
      if (elapsedSeconds >= MAX_SPEECH_DURATION_SECONDS) {
        logger.warn(
          `Max speech duration (${MAX_SPEECH_DURATION_SECONDS}s) reached for session ${connState.sessionId}. Auto-stopping.`,
        );
        stopElapsedTimeTicker(connState);

        // Auto-stop recording
        sessionManager
          .stopRecording(connState.sessionId)
          .then(() => {
            sendMessage(ws, { type: "state_change", state: SessionState.PROCESSING });
            sendMessage(ws, {
              type: "error",
              message: `Maximum speech duration of ${MAX_SPEECH_DURATION_SECONDS / 60} minutes reached. Recording stopped automatically.`,
              recoverable: true,
            });
          })
          .catch((err) => {
            logger.error(`Error auto-stopping recording: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    } catch {
      // Session may have been cleaned up
      stopElapsedTimeTicker(connState);
    }
  }, ELAPSED_TIME_INTERVAL_MS);
}

function stopElapsedTimeTicker(connState: ConnectionState): void {
  if (connState.elapsedTimerInterval !== null) {
    clearInterval(connState.elapsedTimerInterval);
    connState.elapsedTimerInterval = null;
  }
}

// ─── Coaching Cue Timer (#155) ──────────────────────────────────────────────────

const COACHING_CUE_INTERVAL_MS = 10_000; // Check every 10 seconds

function startCoachingCueTicker(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): void {
  stopCoachingCueTicker(connState);
  connState.coachingCueState = createCueState();
  const recordingStart = Date.now();

  connState.coachingCueInterval = setInterval(() => {
    try {
      const session = sessionManager.getSession(connState.sessionId);
      if (session.state !== SessionState.RECORDING) {
        stopCoachingCueTicker(connState);
        return;
      }

      const elapsedSeconds = (Date.now() - recordingStart) / 1000;
      const segments = session.liveTranscript;
      const cues = computeCues(segments, elapsedSeconds, connState.coachingCueState);

      for (const cue of cues) {
        sendMessage(ws, {
          type: "coaching_cue",
          cueType: cue.type,
          message: cue.message,
          timestamp: cue.timestamp,
        });
      }
    } catch {
      stopCoachingCueTicker(connState);
    }
  }, COACHING_CUE_INTERVAL_MS);
}

function stopCoachingCueTicker(connState: ConnectionState): void {
  if (connState.coachingCueInterval !== null) {
    clearInterval(connState.coachingCueInterval);
    connState.coachingCueInterval = null;
  }
}

// ─── Auto-Purge Timer ───────────────────────────────────────────────────────────
// Privacy: After TTS delivery completes (state returns to IDLE), a 10-minute
// auto-purge timer starts. When it fires, all transcript, metrics, evaluation,
// and audio chunk references are nulled.

export function startPurgeTimer(
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
  ws?: WebSocket,
): void {
  clearPurgeTimer(connState);

  connState.purgeTimer = setTimeout(() => {
    try {
      const session = sessionManager.getSession(connState.sessionId);
      purgeSessionData(session);
      logger.info(`Auto-purge completed for session ${connState.sessionId}`);

      // Notify client so UI can clear stale local state (project context form,
      // VAD config, evaluation/transcript display)
      if (ws) {
        sendMessage(ws, { type: "data_purged", reason: "auto_purge" });
      }
    } catch {
      // Session may already be gone
    }
  }, AUTO_PURGE_TIMER_MS);
}

function clearPurgeTimer(connState: ConnectionState): void {
  if (connState.purgeTimer !== null) {
    clearTimeout(connState.purgeTimer);
    connState.purgeTimer = null;
  }
}

/**
 * Purges all speech data from a session while preserving the session object
 * for UI state. This is used by the auto-purge timer and speaker opt-out.
 *
 * Privacy: Clears audio chunks, transcript, live transcript, metrics,
 * evaluation, evaluation script, project context, and telemetry data.
 *
 * Note: `session.consent` and `session.outputsSaved` are intentionally NOT
 * cleared — consent is session metadata (not speech data), and `outputsSaved`
 * tracks disk persistence status.
 */
export function purgeSessionData(session: Session): void {
  session.audioChunks = [];
  session.transcript = [];
  session.liveTranscript = [];
  session.metrics = null;
  session.evaluation = null;
  session.evaluationPublic = null;
  session.evaluationScript = null;
  session.ttsAudioCache = null;
  session.evaluationPassRate = null;
  session.qualityWarning = false;
  session.projectContext = null;

  // Phase 4: Clear video data on auto-purge (Req 11.5)
  session.visualObservations = null;
  session.videoConsent = null;
  session.videoStreamReady = false;

  // Clear eager pipeline state — pure reset only, no runId++ needed
  // (purge happens after delivery, no in-flight work to cancel)
  session.eagerStatus = "idle";
  session.eagerRunId = null;
  session.eagerPromise = null;
  session.evaluationCache = null;
}

// ─── Transcript Update Helpers ──────────────────────────────────────────────────

/**
 * Sends a transcript_update message with replaceFromIndex semantics.
 *
 * The client maintains a local segment array and splices from replaceFromIndex
 * onward with the new segments. This handles Deepgram's interim→final
 * replacement pattern without flicker or duplication.
 *
 * @param ws - WebSocket connection
 * @param segments - The replacement suffix segments (not the full transcript)
 * @param replaceFromIndex - The index in the client's segment array to replace from
 */
export function sendTranscriptUpdate(
  ws: WebSocket,
  segments: TranscriptSegment[],
  replaceFromIndex: number,
): void {
  sendMessage(ws, {
    type: "transcript_update",
    segments,
    replaceFromIndex,
  });
}

// ─── Message Sending ────────────────────────────────────────────────────────────

/**
 * Sends a ServerMessage to the client as JSON text.
 * Silently ignores if the WebSocket is not in OPEN state.
 */
export function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ─── Connection Cleanup ─────────────────────────────────────────────────────────

function cleanupConnection(connState: ConnectionState): void {
  stopElapsedTimeTicker(connState);
  stopCoachingCueTicker(connState);
  clearPurgeTimer(connState);
  stopVideoStatusSender(connState);
}

// ─── Share Page Builder (#164) ───────────────────────────────────────────────────

function escapeHtmlServer(value: unknown): string {
  if (value == null) return "";
  const str = String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSharePage(metadata: any, evaluation: any, metrics: any, audioUrl?: string | null): string {
  const date = new Date(metadata.date).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  let itemsHtml = "";
  if (evaluation?.items) {
    for (const item of evaluation.items) {
      const typeLabel = item.type === "commendation" ? "Strength" : "Opportunity";
      const typeClass = item.type === "commendation" ? "strength" : "opportunity";
      itemsHtml += `
        <div class="eval-item ${typeClass}">
          <div class="eval-item-type">${escapeHtmlServer(typeLabel)}</div>
          <div class="eval-item-summary">${escapeHtmlServer(item.summary)}</div>
          <div class="eval-item-body">${escapeHtmlServer(item.explanation)}</div>
          ${item.evidence_quote ? `<div class="eval-evidence">"${escapeHtmlServer(item.evidence_quote)}"</div>` : ""}
        </div>`;
    }
  }

  let scoresHtml = "";
  if (evaluation?.category_scores?.length > 0) {
    scoresHtml = `<div class="scores"><h2>Category Scores</h2>`;
    for (const cs of evaluation.category_scores) {
      const pct = Math.round((cs.score / 10) * 100);
      const cls = cs.score >= 7 ? "good" : cs.score >= 4 ? "fair" : "poor";
      const label = cs.category.charAt(0).toUpperCase() + cs.category.slice(1);
      scoresHtml += `
        <div class="score-row">
          <span class="score-label">${escapeHtmlServer(label)}</span>
          <div class="score-track"><div class="score-fill ${cls}" style="width:${pct}%"></div></div>
          <span class="score-num">${cs.score}/10</span>
        </div>`;
    }
    scoresHtml += `</div>`;
  }

  const audioHtml = audioUrl ? `
    <div class="audio-section">
      <div class="audio-label">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        Listen to AI Evaluation
      </div>
      <audio controls preload="none" src="${escapeHtmlServer(audioUrl)}" style="width:100%;border-radius:8px;"></audio>
    </div>` : "";

  const speakerName = escapeHtmlServer(metadata.speakerName || "Speaker");
  const speechTitle = escapeHtmlServer(metadata.speechTitle || "Speech Evaluation");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:title" content="${speakerName} — ${speechTitle}">
  <meta property="og:description" content="AI-powered speech evaluation with delivery metrics, evidence-based feedback, and category scores.">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${speakerName} — ${speechTitle}">
  <meta name="twitter:description" content="AI-powered speech evaluation with delivery metrics and actionable feedback.">
  <title>${speechTitle} — AI Speech Evaluator</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0C0A0F;--bg2:#14111A;--card:#1A1722;--card-hover:#221E2D;--red:#C13B3B;--red-glow:rgba(232,82,66,0.15);--green:#34D399;--amber:#F5C36A;--text:#F0ECF5;--text2:#9B95A5;--text3:#6B6575;--border:rgba(255,255,255,0.06);--border-accent:rgba(193,59,59,0.3)}
    @media(prefers-color-scheme:light){:root{--bg:#F8F6F3;--bg2:#FFFFFF;--card:#FFFFFF;--card-hover:#F0EDE8;--red:#C13B3B;--red-glow:rgba(193,59,59,0.08);--green:#059669;--amber:#D97706;--text:#1A1722;--text2:#555;--text3:#888;--border:rgba(0,0,0,0.08);--border-accent:rgba(193,59,59,0.2)}}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:'Outfit',-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.65;-webkit-font-smoothing:antialiased}
    .page{max-width:640px;margin:0 auto;padding:24px 20px 48px}
    .brand{text-align:center;padding:20px 0 24px;opacity:0.5;font-size:0.75rem;color:var(--text3);letter-spacing:0.05em;text-transform:uppercase}
    .hero{text-align:center;padding:32px 0 28px;border-bottom:1px solid var(--border)}
    .hero h1{font-size:1.6rem;font-weight:600;line-height:1.3;margin-bottom:10px}
    .hero-meta{color:var(--text2);font-size:0.9rem;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
    .hero-meta .sep{color:var(--text3)}
    .badge{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:2px 12px;font-size:0.8rem;color:var(--text2)}
    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}
    @media(max-width:480px){.metrics{grid-template-columns:repeat(2,1fr)}}
    .metric{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 10px;text-align:center}
    .metric-val{font-size:1.5rem;font-weight:700;color:var(--red)}
    .metric-lbl{font-size:0.7rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px}
    .audio-section{background:var(--card);border:1px solid var(--border-accent);border-radius:12px;padding:16px;margin:20px 0}
    .audio-label{display:flex;align-items:center;gap:8px;font-size:0.9rem;font-weight:500;margin-bottom:10px;color:var(--text)}
    .audio-label svg{color:var(--red)}
    audio{height:40px}
    .opening,.closing{padding:16px 20px;margin:20px 0;border-left:3px solid var(--red);background:var(--card);border-radius:0 8px 8px 0;font-style:italic;color:var(--text2);font-size:0.95rem}
    .scores{margin:24px 0}
    .scores h2{font-size:1rem;font-weight:600;margin-bottom:14px}
    .score-row{display:flex;align-items:center;gap:10px;margin:8px 0}
    .score-label{width:110px;font-size:0.85rem;color:var(--text2)}
    .score-track{flex:1;height:6px;background:var(--bg2);border-radius:3px;overflow:hidden}
    .score-fill{height:100%;border-radius:3px}
    .score-fill.good{background:var(--green)}
    .score-fill.fair{background:var(--amber)}
    .score-fill.poor{background:var(--red)}
    .score-num{font-size:0.8rem;color:var(--text3);width:40px;text-align:right;font-variant-numeric:tabular-nums}
    .feedback{margin:24px 0}
    .feedback h2{font-size:1rem;font-weight:600;margin-bottom:14px}
    .eval-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin:10px 0;transition:border-color 0.15s}
    .eval-item:hover{border-color:var(--border-accent)}
    .eval-item.strength{border-left:3px solid var(--green)}
    .eval-item.opportunity{border-left:3px solid var(--amber)}
    .eval-item-type{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px}
    .strength .eval-item-type{color:var(--green)}
    .opportunity .eval-item-type{color:var(--amber)}
    .eval-item-summary{font-size:1rem;font-weight:600;margin-bottom:6px}
    .eval-item-body{color:var(--text2);font-size:0.9rem;line-height:1.6}
    .eval-evidence{font-style:italic;color:var(--text3);font-size:0.8rem;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
    .cta{text-align:center;background:linear-gradient(135deg,var(--card) 0%,rgba(193,59,59,0.08) 100%);border:1px solid var(--border-accent);border-radius:16px;padding:32px 24px;margin:32px 0}
    .cta h3{font-size:1.15rem;font-weight:600;margin-bottom:8px}
    .cta p{color:var(--text2);font-size:0.9rem;margin-bottom:18px;max-width:400px;margin-left:auto;margin-right:auto}
    .cta-btn{display:inline-block;background:var(--red);color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:0.95rem;transition:opacity 0.15s,transform 0.15s}
    .cta-btn:hover{opacity:0.9;transform:translateY(-1px)}
    .foot{text-align:center;padding:24px 0;color:var(--text3);font-size:0.75rem}
    .foot a{color:var(--text3);text-decoration:none}
    .foot a:hover{color:var(--text2)}
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">AI Speech Evaluator</div>

    <div class="hero">
      <h1>${speechTitle}</h1>
      <div class="hero-meta">
        <span>${speakerName}</span>
        <span class="sep">&middot;</span>
        <span>${escapeHtmlServer(date)}</span>
        ${metadata.projectType ? `<span class="sep">&middot;</span><span class="badge">${escapeHtmlServer(metadata.projectType)}</span>` : ""}
      </div>
    </div>

    <div class="metrics">
      <div class="metric"><div class="metric-val">${Math.round(metrics?.wordsPerMinute || metadata.wordsPerMinute || 0)}</div><div class="metric-lbl">Words/Min</div></div>
      <div class="metric"><div class="metric-val">${escapeHtmlServer(metrics?.durationFormatted || formatDurationStr(metadata.durationSeconds || 0))}</div><div class="metric-lbl">Duration</div></div>
      <div class="metric"><div class="metric-val">${Math.round((metadata.passRate || 0) * 100)}%</div><div class="metric-lbl">Pass Rate</div></div>
      <div class="metric"><div class="metric-val">${metrics?.fillerWordCount ?? "\u2014"}</div><div class="metric-lbl">Fillers</div></div>
    </div>

    ${audioHtml}

    ${evaluation?.opening ? `<div class="opening">${escapeHtmlServer(evaluation.opening)}</div>` : ""}

    ${scoresHtml}

    ${itemsHtml ? `<div class="feedback"><h2>Feedback</h2>${itemsHtml}</div>` : ""}

    ${evaluation?.closing ? `<div class="closing">${escapeHtmlServer(evaluation.closing)}</div>` : ""}

    <div class="cta">
      <h3>Get AI feedback for your Toastmasters club</h3>
      <p>Real-time speech evaluation with instant delivery metrics, evidence-based feedback, and progress tracking.</p>
      <a href="/" class="cta-btn">Try Speech Evaluator</a>
    </div>

    <div class="foot">
      <a href="https://taverns.red">A Red Taverns Production</a>
    </div>
  </div>
</body>
</html>`;
}

function formatDurationStr(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── Exports for Testing ────────────────────────────────────────────────────────

export {
  EXPECTED_FORMAT,
  MAX_CHUNK_JITTER_MS,
  EXPECTED_CHUNK_INTERVAL_MS,
  MAX_SPEECH_DURATION_SECONDS,
  ELAPSED_TIME_INTERVAL_MS,
  AUTO_PURGE_TIMER_MS,
};
export type { ConnectionState };
