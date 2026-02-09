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
  type ServerMessage,
  type Session,
  type TranscriptSegment,
  SessionState,
} from "./types.js";

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
}

const defaultLogger: ServerLogger = {
  info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
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
    sessionManager = new SessionManager(),
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

  // Cancel any pending auto-purge timer when starting a new recording
  clearPurgeTimer(connState);

  sessionManager.startRecording(connState.sessionId);
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
}


// ─── Deliver Evaluation ─────────────────────────────────────────────────────────

async function handleDeliverEvaluation(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  let audioBuffer: Buffer | undefined;

  try {
    audioBuffer = await sessionManager.generateEvaluation(connState.sessionId);
  } catch (err) {
    // LLM failure: session has been transitioned back to PROCESSING by SessionManager (Req 7.3)
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Evaluation generation failed for session ${connState.sessionId}: ${errorMessage}`);

    const session = sessionManager.getSession(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: session.state });
    sendMessage(ws, {
      type: "error",
      message: `Evaluation generation failed: ${errorMessage}. You can retry.`,
      recoverable: true,
    });
    return;
  }

  const session = sessionManager.getSession(connState.sessionId);

  // Send state change to DELIVERING
  sendMessage(ws, { type: "state_change", state: session.state });

  // Send evaluation_ready with the structured evaluation and script
  if (session.evaluation && session.evaluationScript) {
    sendMessage(ws, {
      type: "evaluation_ready",
      evaluation: session.evaluation,
      script: session.evaluationScript,
    });
  }

  if (audioBuffer) {
    // TTS succeeded: stream audio and complete
    logger.info(`Streaming TTS audio for session ${connState.sessionId} (${audioBuffer.length} bytes)`);

    // Send TTS audio as a raw binary WebSocket frame so the client
    // receives it as an ArrayBuffer (not a JSON-serialized object).
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audioBuffer);
    }
    sendMessage(ws, { type: "tts_complete" });

    // Transition back to IDLE after TTS delivery
    sessionManager.completeDelivery(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: SessionState.IDLE });

    // Start auto-purge timer (privacy: 10-minute retention after delivery)
    startPurgeTimer(connState, sessionManager, logger);
  } else if (session.evaluation && session.evaluationScript) {
    // TTS failure: evaluation and script are available but no audio (Req 7.4)
    // The client already has the evaluation_ready message with the script text
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
    startPurgeTimer(connState, sessionManager, logger);
  } else {
    // No evaluation generated (e.g., no transcript/metrics available)
    logger.warn(`No evaluation generated for session ${connState.sessionId}`);

    sessionManager.completeDelivery(connState.sessionId);
    sendMessage(ws, { type: "state_change", state: SessionState.IDLE });
  }
}


// ─── Replay TTS ─────────────────────────────────────────────────────────────────

async function handleReplayTTS(
  ws: WebSocket,
  connState: ConnectionState,
  sessionManager: SessionManager,
  logger: ServerLogger,
): Promise<void> {
  let audioBuffer: Buffer | undefined;

  try {
    audioBuffer = sessionManager.replayTTS(connState.sessionId);
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
    sendMessage(ws, {
      type: "error",
      message: "No TTS audio available for replay.",
      recoverable: true,
    });
    return;
  }

  // Send state change to DELIVERING
  sendMessage(ws, { type: "state_change", state: SessionState.DELIVERING });

  // Send TTS audio as a raw binary WebSocket frame
  logger.info(`Replaying TTS audio for session ${connState.sessionId} (${audioBuffer.length} bytes)`);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(audioBuffer);
  }
  sendMessage(ws, { type: "tts_complete" });

  // Transition back to IDLE
  sessionManager.completeDelivery(connState.sessionId);
  sendMessage(ws, { type: "state_change", state: SessionState.IDLE });

  // Restart auto-purge timer (privacy: 10-minute retention after delivery)
  startPurgeTimer(connState, sessionManager, logger);
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
): void {
  clearPurgeTimer(connState);

  connState.purgeTimer = setTimeout(() => {
    try {
      const session = sessionManager.getSession(connState.sessionId);
      purgeSessionData(session);
      logger.info(`Auto-purge completed for session ${connState.sessionId}`);
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
 * evaluation, and evaluation script.
 */
export function purgeSessionData(session: Session): void {
  session.audioChunks = [];
  session.transcript = [];
  session.liveTranscript = [];
  session.metrics = null;
  session.evaluation = null;
  session.evaluationScript = null;
  session.ttsAudioCache = null;
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
