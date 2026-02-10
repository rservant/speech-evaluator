// AI Toastmasters Evaluator - WebSocket Handler and Express Server
// Requirements: 1.2 (start recording), 1.3 (elapsed time), 1.4 (stop recording),
//               1.6 (deliver evaluation), 1.7 (panic mute), 2.5 (echo prevention)
//
// Privacy: Audio chunks are in-memory only, never written to disk.
//          Session data lives in server memory only. No database, no temp files.

import express, { type Express } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
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
}

// ─── Logging ────────────────────────────────────────────────────────────────────

export interface ServerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const isDebug = process.env.NODE_ENV === "development" || process.env.LOG_LEVEL === "debug";

const defaultLogger: ServerLogger = {
  info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg, ...args) => {
    if (isDebug) console.log(`[DEBUG] ${msg}`, ...args);
  },
};

// ─── Server Factory ─────────────────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Directory to serve static files from. Defaults to "public" relative to cwd. */
  staticDir?: string;
  /** Custom logger. Defaults to console-based logger. */
  logger?: ServerLogger;
  /** Externally provided SessionManager (for testing). Created internally if omitted. */
  sessionManager?: SessionManager;
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
  } = options;

  const app = express();
  const httpServer = createServer(app);

  // Serve static files from public/ directory
  app.use(express.static(staticDir));

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    handleConnection(ws, sessionManager, logger);
  });

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
        // Close all WebSocket connections
        for (const client of wss.clients) {
          client.close();
        }
        wss.close(() => {
          httpServer.close((err) => {
            if (err) reject(err);
            else resolve();
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
        handleClientMessage(ws, message, connState, sessionManager, logger);
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
  // too verbose logger.debug(`[handleBinaryMessage] Feeding audio chunk (${data.length} bytes) for session ${connState.sessionId}`);
  sessionManager.feedAudio(connState.sessionId, Buffer.from(data));
}

// ─── JSON Client Message Handler ────────────────────────────────────────────────

function handleClientMessage(
  ws: WebSocket,
  message: ClientMessage,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
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

    case "stop_recording":
      catchAsync(handleStopRecording(ws, connState, sessionManager, logger));
      break;

    case "deliver_evaluation":
      catchAsync(handleDeliverEvaluation(ws, connState, sessionManager, logger));
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
  });
  logger.info(`Recording started for session ${connState.sessionId}`);

  // Reset connection state for new recording
  connState.lastChunkTimestamp = null;
  connState.liveTranscriptLength = 0;

  // Notify client of state change
  sendMessage(ws, { type: "state_change", state: SessionState.RECORDING });

  // Start elapsed time ticker (every second during RECORDING)
  startElapsedTimeTicker(ws, connState, session, sessionManager, logger);
}

// ─── Stop Recording ─────────────────────────────────────────────────────────────

async function handleStopRecording(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  stopElapsedTimeTicker(connState);

  await sessionManager.stopRecording(connState.sessionId);
  logger.info(`Recording stopped for session ${connState.sessionId}`);

  const session = sessionManager.getSession(connState.sessionId);

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


// ─── Deliver Evaluation ─────────────────────────────────────────────────────────

async function handleDeliverEvaluation(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  const session = sessionManager.getSession(connState.sessionId);

  // Re-entrancy guard: ignore deliver_evaluation if already delivering (Req 5.6)
  if (session.state === SessionState.DELIVERING) {
    logger.debug(`[handleDeliverEvaluation] Ignoring deliver_evaluation — already in DELIVERING state for session ${connState.sessionId}`);
    return;
  }

  logger.debug(`[handleDeliverEvaluation] Starting delivery for session ${connState.sessionId}`);

  // ── Branch 1: Cache hit — deliver from eager cache immediately ──
  if (sessionManager.isEagerCacheValid(connState.sessionId)) {
    logger.info(`[handleDeliverEvaluation] Cache hit — delivering from eager cache for session ${connState.sessionId}`);
    deliverFromCache(ws, connState, sessionManager, logger);
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
      deliverFromCache(ws, connState, sessionManager, logger);
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
    audioBuffer = await sessionManager.generateEvaluation(connState.sessionId);
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
): void {
  const session = sessionManager.getSession(connState.sessionId);
  const cache = session.evaluationCache!;

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

  sessionManager
    .saveOutputs(connState.sessionId)
    .then((paths) => {
      if (paths.length > 0) {
        session.outputsSaved = true;
        sendMessage(ws, { type: "outputs_saved", paths });
        logger.info(`Outputs saved for session ${connState.sessionId}: ${paths.join(", ")}`);
      } else {
        sendMessage(ws, {
          type: "error",
          message: "No file persistence engine configured.",
          recoverable: true,
        });
      }
    })
    .catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to save outputs for session ${connState.sessionId}: ${errorMessage}`);
      sendMessage(ws, {
        type: "error",
        message: `Failed to save outputs: ${errorMessage}`,
        recoverable: true,
      });
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
    });
    logger.info(`Project context set for session ${connState.sessionId}: title="${message.speechTitle}", type="${message.projectType}", objectives=${message.objectives.length}`);
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
  clearPurgeTimer(connState);
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
