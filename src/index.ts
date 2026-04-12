// AI Speech Evaluator - Entry point
// Wires up all pipeline dependencies and starts the server.

import "dotenv/config";
import { createClient as createDeepgramClient } from "@deepgram/sdk";
import OpenAI from "openai";
import { createAppServer } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { TranscriptionEngine } from "./transcription-engine.js";
import type { OpenAITranscriptionClient } from "./transcription-engine.js";
import { MetricsExtractor } from "./metrics-extractor.js";
import { EvaluationGenerator } from "./evaluation-generator.js";
import type { OpenAIClient } from "./evaluation-generator.js";
import { TTSEngine } from "./tts-engine.js";
import type { OpenAITTSClient } from "./tts-engine.js";
import { FilePersistence } from "./file-persistence.js";
import { VADMonitor } from "./vad-monitor.js";
import type { VADConfig, VADEventCallback } from "./vad-monitor.js";
import { VideoProcessor } from "./video-processor.js";
import type { VideoProcessorDeps } from "./video-processor.js";
import type { VideoConfig } from "./types.js";
import { createUploadRouter } from "./upload-handler.js";
import { GCSUploadService, createGCSClient } from "./gcs-upload.js";
import { GcsHistoryService, createGcsHistoryClient } from "./gcs-history.js";
import { StubPoseDetector } from "./stub-pose-detector.js";
import { StubFaceDetector } from "./stub-face-detector.js";
import { TfjsFaceDetector } from "./tfjs-face-detector.js";
import { TfjsPoseDetector } from "./tfjs-pose-detector.js";
import { initTfjsWasm } from "./tfjs-setup.js";
import type { FaceDetector, PoseDetector } from "./video-processor.js";
import { createAuthMiddleware, verifyAndAuthorize } from "./auth-middleware.js";
import { parse as parseCookie } from "cookie";
import { createLogger } from "./logger.js";
import { createMetricsCollector } from "./metrics-collector.js";

export { APP_NAME, APP_VERSION } from "./version.js";
import { APP_NAME, APP_VERSION } from "./version.js";

const log = createLogger("Main");

const port = parseInt(process.env.PORT || "3000", 10);

// ─── Validate API keys ─────────────────────────────────────────────────────────

const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();

if (!deepgramKey) {
  log.error("DEEPGRAM_API_KEY is not set. Add it to your .env file.");
  process.exit(1);
}

if (!openaiKey) {
  log.error("OPENAI_API_KEY is not set. Add it to your .env file.");
  process.exit(1);
}

log.info("API keys loaded");

// ─── Prevent uncaught exceptions from crashing the server ──────────────────────
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { error: err });
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { error: reason instanceof Error ? reason : new Error(String(reason)) });
});

// ─── Initialize API clients ─────────────────────────────────────────────────────

log.info("Creating Deepgram client...");
const deepgramClient = createDeepgramClient(deepgramKey);

log.info("Creating OpenAI client...");
const openaiClient = new OpenAI({ apiKey: openaiKey });

// ─── Initialize pipeline components ─────────────────────────────────────────────

log.info("Initializing TranscriptionEngine (Deepgram live + OpenAI post-speech)...");
const transcriptionEngine = new TranscriptionEngine(deepgramClient, openaiClient as unknown as OpenAITranscriptionClient);

log.info("Initializing MetricsExtractor...");
const metricsExtractor = new MetricsExtractor();

log.info("Initializing EvaluationGenerator (GPT-4o)...");
const evaluationGenerator = new EvaluationGenerator(openaiClient as unknown as OpenAIClient);

log.info("Initializing TTSEngine (OpenAI TTS)...");
const ttsEngine = new TTSEngine(openaiClient as unknown as OpenAITTSClient);

log.info("Initializing FilePersistence (output/)...");
const filePersistence = new FilePersistence("output");

// ─── Initialize ML detectors (with graceful fallback to stubs) ──────────────────

let faceDetector: FaceDetector;
let poseDetector: PoseDetector;

try {
  log.info("Initializing TF.js WASM backend...");
  await initTfjsWasm();
  log.info("TF.js WASM backend ready");

  log.info("Loading BlazeFace (face detection)...");
  const tfjsFace = new TfjsFaceDetector();
  await tfjsFace.init();
  faceDetector = tfjsFace;
  log.info("BlazeFace loaded");

  log.info("Loading MoveNet Lightning (pose estimation)...");
  const tfjsPose = new TfjsPoseDetector();
  await tfjsPose.init();
  poseDetector = tfjsPose;
  log.info("MoveNet Lightning loaded");
} catch (err) {
  log.warn("ML detector init failed, using stubs", { error: err instanceof Error ? err : new Error(String(err)) });
  faceDetector = new StubFaceDetector();
  poseDetector = new StubPoseDetector();
}

// ─── Create SessionManager with all dependencies ────────────────────────────────

const metricsCollector = createMetricsCollector();

log.info("Wiring SessionManager pipeline...");
const sessionManager = new SessionManager({
  transcriptionEngine,
  metricsExtractor,
  evaluationGenerator,
  ttsEngine,
  filePersistence,
  vadMonitorFactory: (config: VADConfig, callbacks: VADEventCallback) =>
    new VADMonitor(config, callbacks),
  videoProcessorFactory: (config: VideoConfig, deps: VideoProcessorDeps) =>
    new VideoProcessor(config, {
      poseDetector: deps.poseDetector ?? poseDetector,
      faceDetector: deps.faceDetector ?? faceDetector,
    }),
  metricsCollector,
});

// ─── Upload Router ──────────────────────────────────────────────────────────────

log.info("Initializing upload endpoint...");
let gcsUploadService: GCSUploadService | undefined;
try {
  gcsUploadService = new GCSUploadService(createGCSClient());
  log.info("GCS upload service initialized (two-phase upload enabled)");
} catch (err) {
  log.warn("GCS upload service unavailable, using legacy direct upload only", { error: err instanceof Error ? err : new Error(String(err)) });
}

// GCS History Service (#123) — persists evaluation results for browsable history
import { runRetentionSweep, type RetentionConfig } from "./retention.js";
let gcsHistoryService: GcsHistoryService | undefined;
let gcsHistoryClient: ReturnType<typeof createGcsHistoryClient> | undefined;
const GCS_HISTORY_BUCKET = process.env.GCS_UPLOAD_BUCKET || "speech-evaluator-uploads-ca";
try {
  gcsHistoryClient = createGcsHistoryClient(GCS_HISTORY_BUCKET);
  gcsHistoryService = new GcsHistoryService(gcsHistoryClient);
  log.info("GCS history service initialized", { bucket: GCS_HISTORY_BUCKET });
} catch (err) {
  log.warn("GCS history service unavailable, evaluation history disabled", { error: err instanceof Error ? err : new Error(String(err)) });
}
const uploadRouter = createUploadRouter({
  transcriptionEngine,
  metricsExtractor,
  evaluationGenerator,
  ttsEngine,
  gcsUploadService,
  gcsHistoryService,
  metricsCollector,
});

// ─── Clerk Auth & Authorization (#158) ──────────────────────────────────────────

const allowedEmailsRaw = process.env.ALLOWED_EMAILS || "";
const allowedEmails = new Set(
  allowedEmailsRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

let authMiddleware;
let wsAuthVerify;

if (allowedEmails.size > 0) {
  log.info("Auth enabled (Clerk)", { allowedCount: allowedEmails.size });

  authMiddleware = createAuthMiddleware({ allowedEmails });

  wsAuthVerify = async (req: import("node:http").IncomingMessage) => {
    const cookieHeader = req.headers.cookie || "";
    const cookies = parseCookie(cookieHeader);
    const token = cookies.__session;
    if (!token) {
      log.warn("WS upgrade rejected: no __session cookie");
      return null;
    }
    const decoded = await verifyAndAuthorize(token, allowedEmails);
    if (!decoded) {
      log.warn("WS upgrade rejected: token invalid/expired/not in allowlist");
      return null;
    }
    return decoded; // { userId, email } — stored on ConnectionState (#195)
  };
} else {
  log.info("Auth disabled: ALLOWED_EMAILS not set (dev mode)");
}

// ─── Clerk client config (served at /api/config for login page) ─────────────
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
const clerkConfig = clerkPublishableKey
  ? { publishableKey: clerkPublishableKey }
  : undefined;

if (!clerkPublishableKey) {
  log.warn("CLERK_PUBLISHABLE_KEY not set — /api/config will not include auth config");
}

// ─── Start server ───────────────────────────────────────────────────────────────

// ─── Meeting Roles (Phase 9, #72) ───────────────────────────────────────────────
import { RoleRegistry } from "./role-registry.js";
import { AhCounterRole } from "./roles/ah-counter-role.js";
import { TimerRole } from "./roles/timer-role.js";
import { GrammarianRole } from "./roles/grammarian-role.js";
import { TableTopicsMasterRole } from "./roles/table-topics-master-role.js";
import { TableTopicsEvaluatorRole } from "./roles/table-topics-evaluator-role.js";
import { GeneralEvaluatorRole } from "./roles/general-evaluator-role.js";


const roleRegistry = new RoleRegistry();
roleRegistry.register(new AhCounterRole());
roleRegistry.register(new TimerRole());
roleRegistry.register(new GrammarianRole());
roleRegistry.register(new TableTopicsMasterRole());
roleRegistry.register(new TableTopicsEvaluatorRole());
roleRegistry.register(new GeneralEvaluatorRole());
log.info("Meeting roles registered", { count: roleRegistry.size, roles: roleRegistry.list().map((r) => r.name) });

const server = createAppServer({ sessionManager, uploadRouter, version: APP_VERSION, authMiddleware, wsAuthVerify, clerkConfig, roleRegistry, metricsCollector, gcsHistoryService, openaiClient: openaiClient as any });

server.listen(port).then(() => {
  log.info("Server started", {
    name: APP_NAME,
    version: APP_VERSION,
    port,
    pipeline: "Deepgram → OpenAI Transcribe → MetricsExtractor → GPT-4o → TTS",
  });

  // ── Retention Sweep (#130) — enforce data retention policy ──
  if (gcsHistoryClient) {
    const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || "90", 10) || 90;
    const retentionConfig: RetentionConfig = { maxAgeDays: retentionDays };
    const sweepIntervalMs = (parseInt(process.env.RETENTION_CHECK_INTERVAL_HOURS || "24", 10) || 24) * 60 * 60 * 1000;

    // Run initial sweep after a short delay (don't block startup)
    setTimeout(() => {
      runRetentionSweep(gcsHistoryClient!, retentionConfig).catch((err) => {
        log.error("Retention sweep failed", { error: err instanceof Error ? err : new Error(String(err)) });
      });
    }, 30_000); // 30s after startup

    // Schedule periodic sweeps
    setInterval(() => {
      runRetentionSweep(gcsHistoryClient!, retentionConfig).catch((err) => {
        log.error("Retention sweep failed", { error: err instanceof Error ? err : new Error(String(err)) });
      });
    }, sweepIntervalMs);

    log.info("Retention sweep scheduled", { maxAgeDays: retentionDays, intervalHours: sweepIntervalMs / 3600000 });
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────────

function handleSignal(signal: string) {
  log.info(`Received ${signal} — starting graceful shutdown`);
  server.close().then(() => {
    log.info("Shutdown complete");
    process.exit(0);
  }).catch((err) => {
    log.error("Shutdown error", { error: err instanceof Error ? err : new Error(String(err)) });
    process.exit(1);
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));
