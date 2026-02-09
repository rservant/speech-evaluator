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
    debug: vi.fn(),
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
    this.ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      let msg: ServerMessage;
      if (isBinary) {
        // Binary frame = TTS audio data. Wrap it as a synthetic tts_audio message
        // so tests can use nextMessageOfType("tts_audio") as before.
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        msg = { type: "tts_audio", data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as ServerMessage;
      } else {
        const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        msg = JSON.parse(text) as ServerMessage;
      }
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

/** Sets consent on a client so start_recording is allowed (Phase 2 consent gating) */
async function setConsentForRecording(client: TestClient): Promise<void> {
  client.sendJson({ type: "set_consent", speakerName: "TestSpeaker", consentConfirmed: true });
  await client.nextMessageOfType("consent_status");
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
      await setConsentForRecording(c1);
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
      await setConsentForRecording(c);
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
      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendBinary(Buffer.alloc(1601)); // odd byte length

      const msg = await c.nextMessageOfType("audio_format_error");
      expect((msg as { message: string }).message).toContain("multiple of 2");
    });

    it("should accept and buffer valid audio chunks during RECORDING", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
      await setConsentForRecording(c);
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
      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.RECORDING });
    });

    it("should handle stop_recording → state_change to PROCESSING", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.PROCESSING });
    });

    it("should handle deliver_evaluation → state_change to DELIVERING", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "panic_mute" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should transition to IDLE from PROCESSING", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done.", structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null } };
        session.evaluationScript = "Great speech. Well done.";
        return Buffer.from("fake-tts-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      await setConsentForRecording(c);
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
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done.", structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null } };
        session.evaluationScript = "Great speech. Well done.";
        return undefined; // TTS failed
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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

      await setConsentForRecording(c);
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
      await setConsentForRecording(c);
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
      await setConsentForRecording(c);
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
        session.evaluation = { opening: "Great speech.", items: [], closing: "Well done.", structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null } };
        session.evaluationScript = "Great speech. Well done.";
        session.ttsAudioCache = Buffer.from("fake-tts-audio");
        return Buffer.from("fake-tts-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const session = server.sessionManager.getSession(sid);
        session.state = SessionState.IDLE;
      });

      // Go through full lifecycle: start → stop → deliver → wait for IDLE
      await setConsentForRecording(c);
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
      await setConsentForRecording(c);
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

  // ─── Consent Handlers (Task 11.2) ──────────────────────────────────────────

  describe("set_consent", () => {
    it("should set consent and respond with consent_status", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");

      expect(msg.type).toBe("consent_status");
      const consent = (msg as unknown as { consent: { speakerName: string; consentConfirmed: boolean; consentTimestamp: string } }).consent;
      expect(consent.speakerName).toBe("Alice");
      expect(consent.consentConfirmed).toBe(true);
      expect(consent.consentTimestamp).toBeDefined();
    });

    it("should allow setting consent with consentConfirmed=false", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Bob", consentConfirmed: false });
      const msg = await c.nextMessageOfType("consent_status");

      const consent = (msg as { consent: { speakerName: string; consentConfirmed: boolean } }).consent;
      expect(consent.speakerName).toBe("Bob");
      expect(consent.consentConfirmed).toBe(false);
    });

    it("should return error when setting consent in non-IDLE state", async () => {
      const c = track(await createClient(server));

      // Set consent and start recording to move out of IDLE
      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Try to change consent while recording
      c.sendJson({ type: "set_consent", speakerName: "Bob", consentConfirmed: true });
      const errorMsg = await c.nextMessageOfType("error");

      expect((errorMsg as { message: string }).message).toContain("Cannot modify consent");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should allow updating consent while still in IDLE", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: false });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");

      const consent = (msg as { consent: { consentConfirmed: boolean } }).consent;
      expect(consent.consentConfirmed).toBe(true);
    });
  });

  // ─── Revoke Consent (Task 11.2) ────────────────────────────────────────────

  describe("revoke_consent", () => {
    it("should purge session data and respond with data_purged", async () => {
      const c = track(await createClient(server));

      // Set consent first
      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "revoke_consent" });
      const purgeMsg = await c.nextMessageOfType("data_purged");

      expect(purgeMsg).toEqual({ type: "data_purged", reason: "opt_out" });

      // Should also get state_change to IDLE
      const stateMsg = await c.nextMessageOfType("state_change");
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should purge data during RECORDING state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "revoke_consent" });
      const purgeMsg = await c.nextMessageOfType("data_purged");
      expect(purgeMsg).toEqual({ type: "data_purged", reason: "opt_out" });

      const stateMsg = await c.nextMessageOfType("state_change");
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.IDLE });

      // Verify session data is purged
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[0];
      expect(session.consent).toBeNull();
      expect(session.transcript).toEqual([]);
      expect(session.audioChunks).toEqual([]);
      expect(session.evaluation).toBeNull();
    });

    it("should work even when no consent was set", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "revoke_consent" });
      const purgeMsg = await c.nextMessageOfType("data_purged");
      expect(purgeMsg).toEqual({ type: "data_purged", reason: "opt_out" });

      const stateMsg = await c.nextMessageOfType("state_change");
      expect(stateMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });
  });

  // ─── Set Time Limit (Task 11.2) ────────────────────────────────────────────

  describe("set_time_limit", () => {
    it("should update time limit and respond with duration_estimate", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_time_limit", seconds: 90 });
      const msg = await c.nextMessageOfType("duration_estimate");

      expect(msg).toEqual({
        type: "duration_estimate",
        estimatedSeconds: 90,
        timeLimitSeconds: 90,
      });

      // Verify session was updated
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      expect(sessions[0].timeLimitSeconds).toBe(90);
    });

    it("should accept different time limit values", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_time_limit", seconds: 180 });
      const msg = await c.nextMessageOfType("duration_estimate");

      expect((msg as { timeLimitSeconds: number }).timeLimitSeconds).toBe(180);
      expect((msg as { estimatedSeconds: number }).estimatedSeconds).toBe(180);
    });
  });

  // ─── Consent Gating on start_recording (Task 11.2) ─────────────────────────

  describe("consent gating", () => {
    it("should reject start_recording when no consent is set", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("error");

      expect((msg as { message: string }).message).toContain("consent has not been confirmed");
      expect((msg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should reject start_recording when consent is not confirmed", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: false });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("error");

      expect((msg as { message: string }).message).toContain("consent has not been confirmed");
      expect((msg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should allow start_recording when consent is confirmed", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_consent", speakerName: "Alice", consentConfirmed: true });
      await c.nextMessageOfType("consent_status");

      c.sendJson({ type: "start_recording" });
      const msg = await c.nextMessageOfType("state_change");

      expect(msg).toEqual({ type: "state_change", state: SessionState.RECORDING });
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
        intentionalPauseCount: 0,
        hesitationPauseCount: 0,
        classifiedPauses: [],
        energyVariationCoefficient: 0,
        energyProfile: { windowDurationMs: 250, windows: [], coefficientOfVariation: 0, silenceThreshold: 0 },
        classifiedFillers: [],
      },
      evaluation: { opening: "test", items: [], closing: "test", structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null } },
      evaluationPublic: null,
      evaluationScript: "test script",
      ttsAudioCache: null,
      qualityWarning: false,
      outputsSaved: false,
      runId: 1,
      consent: null,
      timeLimitSeconds: 120,
      evaluationPassRate: null,
      eagerStatus: "idle",
      eagerRunId: null,
      eagerPromise: null,
      evaluationCache: null,
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

// ─── Eager Evaluation Pipeline: Delivery and Invalidation Edge Cases (Task 5.7) ──

describe("Eager pipeline delivery and invalidation edge cases", () => {
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
    vi.restoreAllMocks();
  });

  function track(client: TestClient): TestClient {
    clients.push(client);
    return client;
  }

  /** Helper: transition a client to PROCESSING state with eager pipeline mocked */
  async function transitionToProcessing(client: TestClient): Promise<Session> {
    await setConsentForRecording(client);

    // Mock runEagerPipeline to be a no-op so we control eager state manually
    vi.spyOn(server.sessionManager, "runEagerPipeline").mockReturnValue(Promise.resolve());

    client.sendJson({ type: "start_recording" });
    await client.nextMessageOfType("state_change"); // RECORDING

    client.sendJson({ type: "stop_recording" });
    await client.nextMessageOfType("state_change"); // PROCESSING

    const sessions = Array.from(
      (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
    );
    return sessions[sessions.length - 1];
  }

  /** Helper: build a valid EvaluationCache for a session */
  function buildValidCache(session: Session): import("./types.js").EvaluationCache {
    const evaluation = {
      opening: "Great speech.",
      items: [{
        type: "commendation" as const,
        summary: "Good opening",
        evidence_quote: "hello world test speech words here",
        evidence_timestamp: 1,
        explanation: "Strong start",
      }],
      closing: "Well done.",
      structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
    };
    const evaluationPublic = {
      opening: "Great speech.",
      items: [{
        type: "commendation" as const,
        summary: "Good opening",
        explanation: "Strong start",
        evidence_quote: "hello world test speech words here",
        evidence_timestamp: 1,
      }],
      closing: "Well done.",
      structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
    };
    return {
      runId: session.runId,
      timeLimitSeconds: session.timeLimitSeconds,
      voiceConfig: session.voiceConfig ?? "nova",
      evaluation,
      evaluationScript: "Great speech. Well done.",
      ttsAudio: Buffer.from("fake-tts-audio-data"),
      evaluationPublic,
    };
  }

  // ─── Await-then-deliver flow (Req 5.2) ──────────────────────────────────────

  describe("await-then-deliver flow (Req 5.2)", () => {
    it("should await in-flight eager promise then deliver from cache", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);

      // Control the eager pipeline: capture resolve function
      let resolveEager: (() => void) | undefined;
      vi.spyOn(server.sessionManager, "runEagerPipeline").mockImplementation(
        (sessionId: string, _onProgress?: (stage: import("./types.js").PipelineStage) => void) => {
          const session = server.sessionManager.getSession(sessionId);
          session.eagerStatus = "generating";
          session.eagerRunId = session.runId;
          const p = new Promise<void>((resolve) => {
            resolveEager = resolve;
          });
          session.eagerPromise = p;
          return p;
        },
      );

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[sessions.length - 1];

      // Mock completeDelivery
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      // Send deliver_evaluation while eager is in-flight
      c.sendJson({ type: "deliver_evaluation" });

      // Give the server a moment to start awaiting the promise
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Now simulate eager completing: set cache and resolve
      const cache = buildValidCache(session);
      session.evaluationCache = cache;
      session.eagerStatus = "ready";
      session.eagerPromise = null;
      session.eagerRunId = null;
      resolveEager!();

      // Should get state_change DELIVERING (from cache delivery)
      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      // Should get evaluation_ready
      const evalReady = await c.nextMessageOfType("evaluation_ready");
      expect((evalReady as any).evaluation.opening).toBe("Great speech.");

      // Should get TTS audio
      await c.nextMessageOfType("tts_audio");

      // Should get tts_complete
      await c.nextMessageOfType("tts_complete");

      // Should get state_change IDLE
      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should not throw when awaiting eager promise (never-reject contract)", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);

      // Control the eager pipeline: resolve immediately (simulating fast completion)
      vi.spyOn(server.sessionManager, "runEagerPipeline").mockImplementation(
        (sessionId: string) => {
          const session = server.sessionManager.getSession(sessionId);
          session.eagerStatus = "failed";
          session.eagerRunId = session.runId;
          const p = Promise.resolve();
          session.eagerPromise = p;
          return p;
        },
      );

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[sessions.length - 1];

      // Set eagerStatus to generating so Branch 2 is entered
      session.eagerStatus = "generating";

      // Mock generateEvaluation for the fallback path
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.DELIVERING;
        s.evaluation = {
          opening: "Fallback.",
          items: [],
          closing: "Done.",
          structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
        };
        s.evaluationScript = "Fallback. Done.";
        return Buffer.from("fallback-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      // Send deliver_evaluation — should await the promise (which resolves immediately)
      // then fall through to fallback since cache is invalid
      c.sendJson({ type: "deliver_evaluation" });

      // Should eventually get to DELIVERING and then IDLE without errors
      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      await c.nextMessageOfType("tts_complete");

      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });

    it("should fall through to synchronous fallback when runId changes during await", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);

      // Control the eager pipeline
      let resolveEager: (() => void) | undefined;
      vi.spyOn(server.sessionManager, "runEagerPipeline").mockImplementation(
        (sessionId: string) => {
          const session = server.sessionManager.getSession(sessionId);
          session.eagerStatus = "generating";
          session.eagerRunId = session.runId;
          const p = new Promise<void>((resolve) => {
            resolveEager = resolve;
          });
          session.eagerPromise = p;
          return p;
        },
      );

      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[sessions.length - 1];

      // Mock generateEvaluation for the fallback path
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.DELIVERING;
        s.evaluation = {
          opening: "Fallback after invalidation.",
          items: [],
          closing: "Done.",
          structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
        };
        s.evaluationScript = "Fallback after invalidation. Done.";
        return Buffer.from("fallback-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      // Send deliver_evaluation while eager is in-flight
      c.sendJson({ type: "deliver_evaluation" });

      // Give the server a moment to start awaiting
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate runId change (invalidation during await)
      session.runId++;
      session.eagerStatus = "idle";
      session.evaluationCache = null;
      session.eagerPromise = null;
      session.eagerRunId = null;
      resolveEager!();

      // Should fall through to synchronous fallback
      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      // Verify generateEvaluation was called (fallback path)
      await c.nextMessageOfType("tts_complete");
      expect(server.sessionManager.generateEvaluation).toHaveBeenCalled();

      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });
  });

  // ─── Re-entrancy guard (Req 5.6) ───────────────────────────────────────────

  describe("re-entrancy guard (Req 5.6)", () => {
    it("should ignore deliver_evaluation when already in DELIVERING state", async () => {
      const c = track(await createClient(server));

      const session = await transitionToProcessing(c);

      // Set up valid cache for first delivery
      const cache = buildValidCache(session);
      session.evaluationCache = cache;
      session.eagerStatus = "ready";

      // Mock completeDelivery to keep session in DELIVERING (don't transition to IDLE)
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation(() => {
        // No-op: keep session in DELIVERING state
      });

      // First deliver_evaluation — should succeed
      c.sendJson({ type: "deliver_evaluation" });

      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      await c.nextMessageOfType("evaluation_ready");
      await c.nextMessageOfType("tts_audio");
      await c.nextMessageOfType("tts_complete");

      // deliverFromCache sends state_change: IDLE after completeDelivery even though
      // completeDelivery is mocked — consume it so it doesn't interfere
      await c.nextMessageOfType("state_change"); // IDLE message from deliverFromCache

      // Force session back to DELIVERING (since deliverFromCache reads session.state
      // after completeDelivery, but we need it in DELIVERING for the re-entrancy guard)
      session.state = SessionState.DELIVERING;

      // Spy on generateEvaluation to verify it's NOT called on second attempt
      const generateSpy = vi.spyOn(server.sessionManager, "generateEvaluation");

      // Second deliver_evaluation — should be ignored by re-entrancy guard
      c.sendJson({ type: "deliver_evaluation" });

      // Wait a bit and verify no new state_change or evaluation_ready messages
      const gotResponse = await c
        .nextMessageOfType("state_change", 500)
        .then(() => true)
        .catch(() => false);
      expect(gotResponse).toBe(false);

      // generateEvaluation should NOT have been called
      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Message ordering (Req 5.4) ────────────────────────────────────────────

  describe("message ordering (Req 5.4)", () => {
    it("should send evaluation_ready before TTS audio binary frame on cache-hit delivery", async () => {
      const c = track(await createClient(server));

      const session = await transitionToProcessing(c);

      // Set up valid cache
      const cache = buildValidCache(session);
      session.evaluationCache = cache;
      session.eagerStatus = "ready";

      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      c.sendJson({ type: "deliver_evaluation" });

      // Collect messages in order
      const messages: ServerMessage[] = [];
      // We expect: state_change(DELIVERING), evaluation_ready, tts_audio, tts_complete, state_change(IDLE)
      for (let i = 0; i < 5; i++) {
        messages.push(await c.nextMessage(3000));
      }

      const types = messages.map((m) => m.type);

      // Find indices
      const evalReadyIdx = types.indexOf("evaluation_ready");
      const ttsAudioIdx = types.indexOf("tts_audio");
      const ttsCompleteIdx = types.indexOf("tts_complete");

      // ASSERTION: evaluation_ready comes before tts_audio
      expect(evalReadyIdx).toBeGreaterThanOrEqual(0);
      expect(ttsAudioIdx).toBeGreaterThanOrEqual(0);
      expect(evalReadyIdx).toBeLessThan(ttsAudioIdx);

      // ASSERTION: tts_audio comes before tts_complete
      expect(ttsCompleteIdx).toBeGreaterThanOrEqual(0);
      expect(ttsAudioIdx).toBeLessThan(ttsCompleteIdx);
    });

    it("should send evaluation_ready before TTS audio binary frame on fallback delivery", async () => {
      const c = track(await createClient(server));

      const session = await transitionToProcessing(c);

      // No cache — fallback path
      session.eagerStatus = "idle";
      session.evaluationCache = null;

      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.DELIVERING;
        s.evaluation = {
          opening: "Great speech.",
          items: [],
          closing: "Well done.",
          structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
        };
        s.evaluationScript = "Great speech. Well done.";
        return Buffer.from("fallback-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      c.sendJson({ type: "deliver_evaluation" });

      // Collect messages in order
      const messages: ServerMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(await c.nextMessage(3000));
      }

      const types = messages.map((m) => m.type);

      const evalReadyIdx = types.indexOf("evaluation_ready");
      const ttsAudioIdx = types.indexOf("tts_audio");

      // ASSERTION: evaluation_ready comes before tts_audio
      expect(evalReadyIdx).toBeGreaterThanOrEqual(0);
      expect(ttsAudioIdx).toBeGreaterThanOrEqual(0);
      expect(evalReadyIdx).toBeLessThan(ttsAudioIdx);
    });
  });

  // ─── Replay availability with fake timers (Req 5.7, Property 12) ───────────

  describe("replay availability after delivery (Req 5.7, Property 12)", () => {
    it("should keep evaluationCache available after delivery until auto-purge fires", async () => {
      vi.useFakeTimers();

      try {
        const c = track(await createClient(server));

        const session = await transitionToProcessing(c);

        // Set up valid cache
        const cache = buildValidCache(session);
        session.evaluationCache = cache;
        session.eagerStatus = "ready";

        vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
          const s = server.sessionManager.getSession(sid);
          s.state = SessionState.IDLE;
        });

        c.sendJson({ type: "deliver_evaluation" });

        // Consume all delivery messages
        await c.nextMessageOfType("state_change"); // DELIVERING
        await c.nextMessageOfType("evaluation_ready");
        await c.nextMessageOfType("tts_audio");
        await c.nextMessageOfType("tts_complete");
        await c.nextMessageOfType("state_change"); // IDLE

        // (a) Cache non-null immediately after delivery
        expect(session.evaluationCache).not.toBeNull();
        expect(session.evaluationCache!.ttsAudio).toBeDefined();

        // (b) Cache non-null before purge timer (advance 9 minutes)
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        expect(session.evaluationCache).not.toBeNull();

        // (c) Cache null after purge timer fires (advance past 10 minutes total)
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        expect(session.evaluationCache).toBeNull();
        expect(session.eagerStatus).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── Invalidated gating (Req 6.2) ──────────────────────────────────────────

  describe("invalidated gating (Req 6.2)", () => {
    it("should send pipeline_progress: invalidated when time limit changes during PROCESSING with eager in-flight", async () => {
      const c = track(await createClient(server));

      const session = await transitionToProcessing(c);

      // Set eager status to generating (simulating in-flight eager)
      session.eagerStatus = "generating";
      session.eagerRunId = session.runId;
      session.eagerPromise = new Promise(() => {}); // never resolves

      const runIdBefore = session.runId;

      // Consume pipeline_progress: processing_speech from stop_recording
      await c.nextMessageOfType("pipeline_progress");

      // Change time limit — should trigger invalidation
      c.sendJson({ type: "set_time_limit", seconds: 180 });

      // Should get duration_estimate
      await c.nextMessageOfType("duration_estimate");

      // Should get pipeline_progress: invalidated with NEW runId
      const invalidatedMsg = await c.nextMessageOfType("pipeline_progress");
      expect((invalidatedMsg as any).stage).toBe("invalidated");
      expect((invalidatedMsg as any).runId).toBeGreaterThan(runIdBefore);

      // Verify the stage is "invalidated", NOT "processing_speech"
      expect((invalidatedMsg as any).stage).not.toBe("processing_speech");
    });

    it("should fall through to synchronous fallback after invalidation on deliver click", async () => {
      const c = track(await createClient(server));

      const session = await transitionToProcessing(c);

      // Set up a valid cache that will be invalidated
      const cache = buildValidCache(session);
      session.evaluationCache = cache;
      session.eagerStatus = "ready";

      // Consume pipeline_progress: processing_speech from stop_recording
      await c.nextMessageOfType("pipeline_progress");

      // Change time limit — invalidates the cache
      c.sendJson({ type: "set_time_limit", seconds: 180 });
      await c.nextMessageOfType("duration_estimate");
      await c.nextMessageOfType("pipeline_progress"); // invalidated

      // Verify cache was cleared
      expect(session.evaluationCache).toBeNull();
      expect(session.eagerStatus).toBe("idle");

      // Now deliver — should use synchronous fallback (Branch 3)
      vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.DELIVERING;
        s.evaluation = {
          opening: "New evaluation.",
          items: [],
          closing: "Done.",
          structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
        };
        s.evaluationScript = "New evaluation. Done.";
        return Buffer.from("new-audio");
      });
      vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
        const s = server.sessionManager.getSession(sid);
        s.state = SessionState.IDLE;
      });

      c.sendJson({ type: "deliver_evaluation" });

      const deliveringMsg = await c.nextMessageOfType("state_change");
      expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

      // Verify generateEvaluation was called (fallback path, not cache hit)
      expect(server.sessionManager.generateEvaluation).toHaveBeenCalled();

      await c.nextMessageOfType("tts_complete");
      const idleMsg = await c.nextMessageOfType("state_change");
      expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });
    });
  });
});
