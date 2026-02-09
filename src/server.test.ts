// AI Toastmasters Evaluator - Server Unit Tests
// Tests for WebSocket handler and Express server (Task 8.1)
// Requirements: 1.2, 1.3, 1.4, 1.6, 1.7, 2.5

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import {
  createAppServer,
  type AppServer,
  sendMessage,
  sendTranscriptUpdate,
  purgeSessionData,
  EXPECTED_FORMAT,
} from "./server.js";
import { SessionState, type ServerMessage, type Session } from "./types.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────────

const TEST_PORT = 0; // Let OS assign a random port

/** Silent logger for tests */
function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * A test WebSocket client that queues all incoming messages.
 * Messages are buffered so none are lost to race conditions.
 */
class TestClient {
  ws: WebSocket;
  private messageQueue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: WebSocket.RawData) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
      const msg = JSON.parse(text) as ServerMessage;
      // If someone is waiting for a message, deliver immediately
      if (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        waiter(msg);
      } else {
        this.messageQueue.push(msg);
      }
    });
  }

  /** Wait for the WebSocket to open */
  async waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  /** Get the next message (from queue or wait for one) */
  nextMessage(timeoutMs = 3000): Promise<ServerMessage> {
    // Check queue first
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    // Otherwise wait
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const idx = this.waiters.indexOf(waiterFn);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`nextMessage timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiterFn = (msg: ServerMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(waiterFn);
    });
  }

  /** Get the next message matching a specific type (skips non-matching messages) */
  async nextMessageOfType(type: string, timeoutMs = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await this.nextMessage(remaining);
        if (msg.type === type) return msg;
        // Skip non-matching messages
      } catch {
        break;
      }
    }
    throw new Error(`nextMessageOfType("${type}") timed out after ${timeoutMs}ms`);
  }

  /** Send a JSON message */
  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Send binary data */
  sendBinary(data: Buffer): void {
    this.ws.send(data);
  }

  /** Close the connection */
  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

/** Gets the server address after listening */
function getServerUrl(server: AppServer): string {
  const addr = server.httpServer.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("Unexpected server address format");
  }
  return `ws://127.0.0.1:${addr.port}`;
}

/** Creates a connected TestClient and consumes the initial state_change message */
async function createClient(server: AppServer): Promise<TestClient> {
  const url = getServerUrl(server);
  const client = new TestClient(url);
  await client.waitForOpen();
  // Consume the initial state_change IDLE message
  const initial = await client.nextMessage();
  expect(initial).toEqual({ type: "state_change", state: SessionState.IDLE });
  return client;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("Server", () => {
  let server: AppServer;
  let silentLogger: ReturnType<typeof createSilentLogger>;
  let clients: TestClient[];

  beforeEach(async () => {
    silentLogger = createSilentLogger();
    server = createAppServer({ logger: silentLogger });
    await server.listen(TEST_PORT);
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    await server.close();
  });

  function track(client: TestClient): TestClient {
    clients.push(client);
    return client;
  }

  // ─── Connection and Initial State ───────────────────────────────────────────

  describe("connection", () => {
    it("should send initial state_change with IDLE on connection", async () => {
      const url = getServerUrl(server);
      const client = new TestClient(url);
      track(client);
      await client.waitForOpen();

      const msg = await client.nextMessage();
      expect(msg).toEqual({
        type: "state_change",
        state: SessionState.IDLE,
      });
    });

    it("should create a separate session for each connection", async () => {
      const c1 = track(await createClient(server));
      const c2 = track(await createClient(server));

      // Verify the session manager has 2 sessions with different IDs
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      expect(sessions.length).toBe(2);
      expect(sessions[0].id).not.toBe(sessions[1].id);

      // Verify they are independent: start recording on one, other is unaffected
      c1.sendJson({ type: "start_recording" });
      const msg = await c1.nextMessageOfType("state_change");
      expect(msg).toEqual({ type: "state_change", state: SessionState.RECORDING });
    });
  });

  // ─── Audio Format Handshake ─────────────────────────────────────────────────

  describe("audio format handshake", () => {
    it("should accept valid audio format", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "audio_format",
        channels: 1,
        sampleRate: 16000,
        encoding: "LINEAR16",
      });

      // Verify format was accepted by successfully starting recording
      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("state_change");
      expect(msg).toEqual({ type: "state_change", state: SessionState.RECORDING });
    });

    it("should reject wrong number of channels", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "audio_format",
        channels: 2,
        sampleRate: 16000,
        encoding: "LINEAR16",
      });

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("channel");
    });

    it("should reject wrong sample rate", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "audio_format",
        channels: 1,
        sampleRate: 44100,
        encoding: "LINEAR16",
      });

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("sample rate");
    });

    it("should reject wrong encoding", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "audio_format",
        channels: 1,
        sampleRate: 16000,
        encoding: "FLOAT32",
      });

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("encoding");
    });

    it("should reject multiple format errors at once", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "audio_format",
        channels: 2,
        sampleRate: 44100,
        encoding: "FLOAT32",
      });

      const msg = await c.nextMessageOfType("audio_format_error");
      const errorMsg = (msg as { message: string }).message;
      expect(errorMsg).toContain("channel");
      expect(errorMsg).toContain("sample rate");
      expect(errorMsg).toContain("encoding");
    });
  });

  // ─── Audio Chunk Validation ─────────────────────────────────────────────────

  describe("audio chunk handling", () => {
    it("should reject binary audio before format handshake", async () => {
      const c = track(await createClient(server));

      c.sendBinary(Buffer.alloc(1600));

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("handshake");
    });

    it("should reject audio chunks when not in RECORDING state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      // Small delay to ensure handshake is processed before sending binary
      await new Promise((resolve) => setTimeout(resolve, 30));

      c.sendBinary(Buffer.alloc(1600));

      const msg = await c.nextMessageOfType("error");
      expect((msg as { message: string }).message).toContain("not \"recording\"");
    });

    it("should reject audio chunks with odd byte length", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendBinary(Buffer.alloc(1601)); // odd byte length

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("multiple of 2");
    });

    it("should accept and buffer valid audio chunks during RECORDING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendBinary(Buffer.alloc(1600, 0x01));
      c.sendBinary(Buffer.alloc(1600, 0x02));

      // Give time for chunks to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      expect(sessions.length).toBe(1);
      expect(sessions[0].audioChunks.length).toBe(2);
      expect(sessions[0].audioChunks[0].length).toBe(1600);
      expect(sessions[0].audioChunks[1].length).toBe(1600);
    });

    it("should log warning for excessive chunk jitter", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendBinary(Buffer.alloc(1600));
      await new Promise((resolve) => setTimeout(resolve, 200));
      c.sendBinary(Buffer.alloc(1600));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("jitter"),
      );
    });

    it("should reject audio_chunk sent as JSON", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_chunk", data: [] });

      const msg = await c.nextMessageOfType("error");
      expect((msg as { message: string }).message).toContain("binary");
    });
  });

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  describe("session lifecycle", () => {
    it("should handle start_recording → state_change to RECORDING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.RECORDING });
    });

    it("should handle stop_recording → state_change to PROCESSING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.PROCESSING });
    });

    it("should handle deliver_evaluation → state_change to DELIVERING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.DELIVERING });
    });

    it("should return error for invalid state transitions", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "stop_recording" }); // invalid in IDLE
      const msg = await c.nextMessageOfType("error");

      expect((msg as { message: string }).message).toContain("Invalid state transition");
    });
  });

  // ─── Panic Mute ─────────────────────────────────────────────────────────────

  describe("panic mute", () => {
    it("should transition to IDLE from RECORDING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "panic_mute" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should transition to IDLE from PROCESSING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING
      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "panic_mute" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should send IDLE state when already IDLE", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "panic_mute" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should stop the elapsed time ticker", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Wait for at least one elapsed_time message
      await c.nextMessageOfType("elapsed_time");

      // Panic mute
      c.sendJson({ type: "panic_mute" });
      await c.nextMessageOfType("state_change"); // IDLE

      // Verify no more elapsed_time messages arrive (timeout = success)
      const receivedElapsed = await c
        .nextMessageOfType("elapsed_time", 1500)
        .then(() => true)
        .catch(() => false);
      expect(receivedElapsed).toBe(false);
    });
  });

  // ─── Elapsed Time Ticker ────────────────────────────────────────────────────

  describe("elapsed time ticker", () => {
    it("should send elapsed_time messages during RECORDING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      const msg1 = await c.nextMessageOfType("elapsed_time");
      expect(msg1.type).toBe("elapsed_time");
      expect((msg1 as { seconds: number }).seconds).toBeGreaterThanOrEqual(0);

      const msg2 = await c.nextMessageOfType("elapsed_time");
      expect(msg2.type).toBe("elapsed_time");
      expect((msg2 as { seconds: number }).seconds).toBeGreaterThanOrEqual(1);
    });

    it("should stop sending elapsed_time after stop_recording", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING
      await c.nextMessageOfType("elapsed_time"); // wait for one tick

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      // Verify no more elapsed_time messages arrive (timeout = success)
      const receivedElapsed = await c
        .nextMessageOfType("elapsed_time", 1500)
        .then(() => true)
        .catch(() => false);
      expect(receivedElapsed).toBe(false);
    });
  });

  // ─── Save Outputs ───────────────────────────────────────────────────────────

  describe("save outputs", () => {
    it("should return error when no session data available", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "save_outputs" });
      const msg = await c.nextMessageOfType("error");

      expect((msg as { message: string }).message).toContain("No session data");
    });
  });

  // ─── Error Handling Flows (Task 12.2) ───────────────────────────────────────

  describe("error handling flows", () => {
    it("should send quality warning after stop_recording when transcription had issues", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Manually set qualityWarning on the session to simulate transcription drop
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[0];

      // Override stopRecording to set qualityWarning (simulating post-pass failure or Deepgram drop)
      const origStop = server.sessionManager.stopRecording.bind(server.sessionManager);
      vi.spyOn(server.sessionManager, "stopRecording").mockImplementation(async (sid) => {
        await origStop(sid);
        session.qualityWarning = true;
      });

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      const errorMsg = await c.nextMessageOfType("error");
      expect((errorMsg as { message: string; recoverable: boolean }).message).toContain("quality warning");
      expect((errorMsg as { message: string; recoverable: boolean }).recoverable).toBe(true);
    });

    it("should send evaluation_ready and tts_complete on successful deliver_evaluation", async () => {
      const c = track(await createClient(server));

      // Mock generateEvaluation to return audio and set session data
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.DELIVERING;
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done." };
        session.evaluationScript = "Great speech. Well done.";
        return Buffer.from("fake-tts-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });

      const stateMsg = await c.nextMessageOfType("state_change"); // DELIVERING
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      const evalReady = await c.nextMessageOfType("evaluation_ready");
      expect((evalReady as any).script).toBe("Great speech. Well done.");
      expect((evalReady as any).evaluation.opening).toBe("Great speech.");

      await c.nextMessageOfType("tts_audio");
      await c.nextMessageOfType("tts_complete");

      const idleMsg = await c.nextMessageOfType("state_change"); // IDLE
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should send evaluation_ready and TTS error on TTS failure", async () => {
      const c = track(await createClient(server));

      // Mock generateEvaluation to return undefined (TTS failure) but set evaluation data
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.DELIVERING;
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done." };
        session.evaluationScript = "Great speech. Well done.";
        return undefined; // TTS failed
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });

      const stateMsg = await c.nextMessageOfType("state_change"); // DELIVERING
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      const evalReady = await c.nextMessageOfType("evaluation_ready");
      expect((evalReady as any).script).toBe("Great speech. Well done.");

      // Should get an error about TTS failure
      const errorMsg = await c.nextMessageOfType("error");
      expect((errorMsg as { message: string }).message).toContain("Text-to-speech");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(false);

      // Should still transition to IDLE
      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should send recoverable error and stay in PROCESSING on LLM failure", async () => {
      const c = track(await createClient(server));

      // Mock generateEvaluation to throw (LLM failure) — session transitions back to PROCESSING
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.PROCESSING; // SessionManager transitions back
        throw new Error("OpenAI API rate limit exceeded");
      });

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });

      // Should get state_change back to PROCESSING
      const stateMsg = await c.nextMessageOfType("state_change");
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.PROCESSING });

      // Should get a recoverable error
      const errorMsg = await c.nextMessageOfType("error");
      expect((errorMsg as { message: string }).message).toContain("rate limit");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should send transcript_update after stop_recording when transcript is available", async () => {
      const c = track(await createClient(server));

      // Mock stopRecording to populate transcript
      const origStop = server.sessionManager.stopRecording.bind(server.sessionManager);
      vi.spyOn(server.sessionManager, "stopRecording").mockImplementation(async (sid) => {
        await origStop(sid);
        const session = server.sessionManager.getSession(sid);
        session.transcript = [
          { text: "Hello world", startTime: 0, endTime: 2, words: [], isFinal: true },
        ];
      });

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      const transcriptMsg = await c.nextMessageOfType("transcript_update");
      expect((transcriptMsg as any).replaceFromIndex).toBe(0);
      expect((transcriptMsg as any).segments).toHaveLength(1);
      expect((transcriptMsg as any).segments[0].text).toBe("Hello world");
    });
  });

  // ─── Echo Prevention (Req 2.5) ──────────────────────────────────────────────

  describe("echo prevention", () => {
    it("should reject audio chunks in PROCESSING state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendBinary(Buffer.alloc(1600));
      const msg = await c.nextMessageOfType("error");
      expect((msg as { message: string }).message).toContain("not \"recording\"");
    });

    it("should reject audio chunks in DELIVERING state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });
      await c.nextMessageOfType("state_change"); // DELIVERING

      c.sendBinary(Buffer.alloc(1600));
      const msg = await c.nextMessageOfType("error");
      expect((msg as { message: string }).message).toContain("not \"recording\"");
    });
  });

  // ─── Replay TTS (Task 5.2) ────────────────────────────────────────────────

  describe("replay_tts", () => {
    it("should send full message sequence on successful replay", async () => {
      const c = track(await createClient(server));

      // Mock generateEvaluation to return audio and set session data (including ttsAudioCache)
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.DELIVERING;
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done." };
        session.evaluationScript = "Great speech. Well done.";
        session.ttsAudioCache = Buffer.from("fake-tts-audio");
        return Buffer.from("fake-tts-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      // Go through full lifecycle: start → stop → deliver → wait for IDLE
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({ type: "deliver_evaluation" });
      await c.nextMessageOfType("state_change"); // DELIVERING
      await c.nextMessageOfType("evaluation_ready");
      await c.nextMessageOfType("tts_audio");
      await c.nextMessageOfType("tts_complete");
      await c.nextMessageOfType("state_change"); // IDLE

      // Now send replay_tts — mock replayTTS to return the cached buffer and transition state
      vi.spyOn(server.sessionManager, "replayTTS").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.DELIVERING;
        return session.ttsAudioCache!;
      });

      c.sendJson({ type: "replay_tts" });

      // Verify message sequence: state_change(delivering) → tts_audio → tts_complete → state_change(idle)
      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      await c.nextMessageOfType("tts_audio");
      await c.nextMessageOfType("tts_complete");

      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should send error when no TTS audio cache exists", async () => {
      const c = track(await createClient(server));

      // Fresh session — no evaluation done, so no ttsAudioCache
      // replayTTS returns undefined when no cache
      vi.spyOn(server.sessionManager, "replayTTS").mockImplementation(() => {
        return undefined;
      });

      c.sendJson({ type: "replay_tts" });

      const errorMsg = await c.nextMessageOfType("error");
      expect((errorMsg as { message: string }).message).toBe("No TTS audio available for replay.");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should send error when session is in wrong state", async () => {
      const c = track(await createClient(server));

      // Start recording to put session in RECORDING state
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Manually set ttsAudioCache on the session
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[0];
      session.ttsAudioCache = Buffer.from("fake-audio");

      // Send replay_tts — replayTTS should throw because session is in RECORDING state
      c.sendJson({ type: "replay_tts" });

      const errorMsg = await c.nextMessageOfType("error");
      expect((errorMsg as { message: string }).message).toContain("Invalid state transition");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── Unknown Message Type ───────────────────────────────────────────────────

  describe("unknown messages", () => {
    it("should return error for unknown message type", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "unknown_type" });
      const msg = await c.nextMessageOfType("error");

      expect((msg as { message: string }).message).toContain("Unknown message type");
    });
  });

  // ─── Health Check ───────────────────────────────────────────────────────────

  describe("HTTP endpoints", () => {
    it("should respond to /health", async () => {
      const addr = server.httpServer.address();
      if (typeof addr === "string" || addr === null) throw new Error("Bad address");

      const response = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(response.ok).toBe(true);

      const body = await response.json();
      expect(body).toEqual({ status: "ok" });
    });
  });
});

// ─── Unit Tests for Exported Helpers ──────────────────────────────────────────

describe("purgeSessionData", () => {
  it("should clear all speech data from session", () => {
    const session: Session = {
      id: "test-id",
      state: SessionState.IDLE,
      startedAt: new Date(),
      stoppedAt: new Date(),
      transcript: [{ text: "hello", startTime: 0, endTime: 1, words: [], isFinal: true }],
      liveTranscript: [{ text: "hello", startTime: 0, endTime: 1, words: [], isFinal: false }],
      audioChunks: [Buffer.alloc(100)],
      metrics: {
        durationSeconds: 60,
        durationFormatted: "1:00",
        totalWords: 100,
        wordsPerMinute: 100,
        fillerWords: [],
        fillerWordCount: 0,
        fillerWordFrequency: 0,
        pauseCount: 0,
        totalPauseDurationSeconds: 0,
        averagePauseDurationSeconds: 0,
      },
      evaluation: { opening: "test", items: [], closing: "test" },
      evaluationScript: "test script",
      ttsAudioCache: null,
      qualityWarning: false,
      outputsSaved: false,
      runId: 1,
    };

    purgeSessionData(session);

    expect(session.audioChunks).toEqual([]);
    expect(session.transcript).toEqual([]);
    expect(session.liveTranscript).toEqual([]);
    expect(session.metrics).toBeNull();
    expect(session.evaluation).toBeNull();
    expect(session.evaluationScript).toBeNull();
    // Session object itself should still exist with its ID and state
    expect(session.id).toBe("test-id");
    expect(session.state).toBe(SessionState.IDLE);
  });
});

describe("sendTranscriptUpdate", () => {
  it("should send transcript_update with replaceFromIndex", () => {
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => sentMessages.push(data),
    } as unknown as WebSocket;

    const segments = [
      { text: "hello world", startTime: 0, endTime: 1, words: [], isFinal: true },
    ];

    sendTranscriptUpdate(mockWs, segments, 3);

    expect(sentMessages.length).toBe(1);
    const parsed = JSON.parse(sentMessages[0]);
    expect(parsed).toEqual({
      type: "transcript_update",
      segments,
      replaceFromIndex: 3,
    });
  });
});

describe("sendMessage", () => {
  it("should not throw when WebSocket is not OPEN", () => {
    const mockWs = {
      readyState: WebSocket.CLOSED,
      send: vi.fn(),
    } as unknown as WebSocket;

    expect(() => {
      sendMessage(mockWs, { type: "state_change", state: SessionState.IDLE });
    }).not.toThrow();

    expect(mockWs.send).not.toHaveBeenCalled();
  });
});
