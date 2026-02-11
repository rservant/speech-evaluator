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
import { encodeVideoFrame, encodeAudioFrame } from "./video-frame-codec.js";

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
        visualMetrics: null,
      },
      evaluation: { opening: "test", items: [], closing: "test", structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null } },
      evaluationPublic: {
        opening: "test public",
        items: [],
        closing: "test public",
        structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
      },
      evaluationScript: "test script",
      ttsAudioCache: null,
      qualityWarning: true,
      outputsSaved: true,
      runId: 1,
      consent: { speakerName: "Test Speaker", consentConfirmed: true, consentTimestamp: new Date() },
      timeLimitSeconds: 120,
      evaluationPassRate: 0.85,
      eagerStatus: "idle",
      eagerRunId: null,
      eagerPromise: null,
      evaluationCache: null,
      projectContext: { speechTitle: "My Speech", projectType: "Ice Breaker", objectives: ["Introduce yourself"] },
      vadConfig: { silenceThresholdSeconds: 5, enabled: true },
      // Phase 4 video fields
      videoConsent: { consentGranted: true, timestamp: new Date() },
      videoStreamReady: true,
      visualObservations: {
        gazeBreakdown: { audienceFacing: 70, notesFacing: 20, other: 10 },
        faceNotDetectedCount: 0, totalGestureCount: 0, gestureFrequency: 0,
        gesturePerSentenceRatio: null, handsDetectedFrames: 0, handsNotDetectedFrames: 0,
        meanBodyStabilityScore: 0, stageCrossingCount: 0, movementClassification: "stationary",
        meanFacialEnergyScore: 0, facialEnergyVariation: 0, facialEnergyLowSignal: false,
        framesAnalyzed: 0, framesReceived: 0, framesSkippedBySampler: 0, framesErrored: 0,
        framesDroppedByBackpressure: 0, framesDroppedByTimestamp: 0,
        framesDroppedByFinalizationBudget: 0, resolutionChangeCount: 0,
        videoQualityGrade: "good", videoQualityWarning: false, finalizationLatencyMs: 0,
        videoProcessingVersion: { tfjsVersion: "4.0.0", tfjsBackend: "cpu", modelVersions: { blazeface: "1.0", movenet: "1.0" }, configHash: "abc" },
        gazeReliable: true, gestureReliable: true, stabilityReliable: true, facialEnergyReliable: true,
      },
      videoConfig: { frameRate: 5 },
    };

    purgeSessionData(session);

    expect(session.audioChunks).toEqual([]);
    expect(session.transcript).toEqual([]);
    expect(session.liveTranscript).toEqual([]);
    expect(session.metrics).toBeNull();
    expect(session.evaluation).toBeNull();
    expect(session.evaluationPublic).toBeNull();
    expect(session.evaluationScript).toBeNull();
    expect(session.evaluationPassRate).toBeNull();
    expect(session.qualityWarning).toBe(false);
    expect(session.projectContext).toBeNull();
    // Session object itself should still exist with its ID and state
    expect(session.id).toBe("test-id");
    expect(session.state).toBe(SessionState.IDLE);
    // consent and outputsSaved are intentionally NOT cleared
    expect(session.consent).toEqual({ speakerName: "Test Speaker", consentConfirmed: true, consentTimestamp: expect.any(Date) });
    expect(session.outputsSaved).toBe(true);
    // vadConfig is NOT cleared (it's configuration, not speech data)
    expect(session.vadConfig).toEqual({ silenceThresholdSeconds: 5, enabled: true });
    // Phase 4: video data is cleared on purge (Req 11.5)
    expect(session.visualObservations).toBeNull();
    expect(session.videoConsent).toBeNull();
    expect(session.videoStreamReady).toBe(false);
    // videoConfig is NOT cleared (it's configuration, not speech data)
    expect(session.videoConfig).toEqual({ frameRate: 5 });
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

// ─── Phase 3: VAD and Project Context Message Handling (Task 5.5) ─────────────

describe("Phase 3 VAD and project context message handling", () => {
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

  // ─── set_vad_config (Req 6.4, 6.5) ───────────────────────────────────────────

  describe("set_vad_config", () => {
    it("should accept set_vad_config in IDLE state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_vad_config", silenceThresholdSeconds: 7, enabled: true });

      // Give time for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify session was updated
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[0];
      expect(session.vadConfig).toEqual({ silenceThresholdSeconds: 7, enabled: true });
    });

    it("should reject set_vad_config in RECORDING state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "set_vad_config", silenceThresholdSeconds: 10, enabled: false });
      const errorMsg = await c.nextMessageOfType("error");

      expect((errorMsg as { message: string }).message).toContain("idle");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── set_project_context (Req 6.1, 6.2, 6.3) ────────────────────────────────

  describe("set_project_context", () => {
    it("should accept set_project_context in IDLE state", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "set_project_context",
        speechTitle: "My Journey",
        projectType: "Ice Breaker",
        objectives: ["Introduce yourself", "Speak for 4-6 minutes"],
      });

      // Give time for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify session was updated
      const sessions = Array.from(
        (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
      );
      const session = sessions[0];
      expect(session.projectContext).toEqual({
        speechTitle: "My Journey",
        projectType: "Ice Breaker",
        objectives: ["Introduce yourself", "Speak for 4-6 minutes"],
      });
    });

    it("should reject set_project_context in RECORDING state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({
        type: "set_project_context",
        speechTitle: "Late Context",
        projectType: "Ice Breaker",
        objectives: [],
      });
      const errorMsg = await c.nextMessageOfType("error");

      expect((errorMsg as { message: string }).message).toContain("idle");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should reject set_project_context in PROCESSING state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({
        type: "set_project_context",
        speechTitle: "Late Context",
        projectType: "Ice Breaker",
        objectives: [],
      });
      const errorMsg = await c.nextMessageOfType("error");

      expect((errorMsg as { message: string }).message).toContain("idle");
      expect((errorMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── vad_speech_end message (Req 2.1) ─────────────────────────────────────────

  describe("vad_speech_end via VAD callback", () => {
    it("should send vad_speech_end message when VAD onSpeechEnd callback fires", async () => {
      const c = track(await createClient(server));

      // Capture the VAD callbacks registered by handleStartRecording
      let capturedCallbacks: { onSpeechEnd: (d: number) => void; onStatus: (s: { energy: number; isSpeech: boolean }) => void } | null = null;
      vi.spyOn(server.sessionManager, "registerVADCallbacks").mockImplementation(
        (_sessionId: string, callbacks: { onSpeechEnd: (d: number) => void; onStatus: (s: { energy: number; isSpeech: boolean }) => void }) => {
          capturedCallbacks = callbacks;
        },
      );

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Verify callbacks were registered
      expect(capturedCallbacks).not.toBeNull();

      // Simulate VAD detecting speech end
      capturedCallbacks!.onSpeechEnd(5.2);

      const vadMsg = await c.nextMessageOfType("vad_speech_end");
      expect(vadMsg).toEqual({ type: "vad_speech_end", silenceDurationSeconds: 5.2 });
    });
  });
});

// ─── Phase 4: Video Message Handler Tests ─────────────────────────────────────

describe("Server — Video Message Handlers", () => {
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

  // ─── set_video_consent ────────────────────────────────────────────────────

  describe("set_video_consent", () => {
    it("should succeed in IDLE state", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });

      // No error should be sent — verify by sending another message and getting its response
      c.sendJson({ type: "set_consent", speakerName: "Test", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");
      expect(msg.type).toBe("consent_status");

      // Verify session has video consent set
      const session = server.sessionManager.getSession(
        Array.from((server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.keys())[0],
      );
      expect(session.videoConsent).not.toBeNull();
      expect(session.videoConsent!.consentGranted).toBe(true);
    });

    it("should return recoverable error in non-IDLE state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── video_stream_ready ───────────────────────────────────────────────────

  describe("video_stream_ready", () => {
    it("should succeed in IDLE state", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "video_stream_ready",
        width: 640,
        height: 480,
      });

      // Verify no error by sending another message
      c.sendJson({ type: "set_consent", speakerName: "Test", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");
      expect(msg.type).toBe("consent_status");
    });

    it("should return recoverable error in non-IDLE state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({
        type: "video_stream_ready",
        width: 640,
        height: 480,
      });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── set_video_config ─────────────────────────────────────────────────────

  describe("set_video_config", () => {
    it("should succeed with valid frameRate in IDLE state", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 3 });

      // Verify no error by sending another message
      c.sendJson({ type: "set_consent", speakerName: "Test", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");
      expect(msg.type).toBe("consent_status");
    });

    it("should return error for invalid frameRate (too low)", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 0 });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should return error for invalid frameRate (too high)", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 10 });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });

    it("should return error in non-IDLE state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "set_video_config", frameRate: 3 });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── Binary frame routing ────────────────────────────────────────────────

  describe("binary frame routing", () => {
    it("should route TM video frames to feedVideoFrame", async () => {
      const c = track(await createClient(server));

      // Set up video consent and stream ready
      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      // Spy on feedVideoFrame
      const feedSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send a TM-prefixed video frame
      const videoFrame = encodeVideoFrame(
        { timestamp: 1.0, seq: 0, width: 640, height: 480 },
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // minimal JPEG-like bytes
      );
      c.sendBinary(videoFrame);

      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 100));

      expect(feedSpy).toHaveBeenCalledTimes(1);
      expect(feedSpy.mock.calls[0][1]).toEqual(
        expect.objectContaining({ timestamp: 1.0, seq: 0, width: 640, height: 480 }),
      );
    });

    it("should route TM audio frames to feedAudio", async () => {
      const c = track(await createClient(server));

      const feedSpy = vi.spyOn(server.sessionManager, "feedAudio");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send a TM-prefixed audio frame
      const pcmData = Buffer.alloc(1600); // 50ms of 16kHz mono 16-bit
      const audioFrame = encodeAudioFrame(
        { timestamp: 0.5, seq: 0 },
        pcmData,
      );
      c.sendBinary(audioFrame);

      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 100));

      expect(feedSpy).toHaveBeenCalled();
    });

    it("should treat non-TM binary data as raw PCM audio (backward compat)", async () => {
      const c = track(await createClient(server));

      // Validate audio format first (required for legacy path)
      c.sendJson({
        type: "audio_format",
        channels: 1,
        sampleRate: 16000,
        encoding: "LINEAR16",
      });

      const feedSpy = vi.spyOn(server.sessionManager, "feedAudio");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send raw PCM data (no TM prefix)
      const rawPcm = Buffer.alloc(1600);
      c.sendBinary(rawPcm);

      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 100));

      expect(feedSpy).toHaveBeenCalled();
    });

    it("should silently discard frames with unrecognized TM type byte", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      const feedVideoSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");
      const feedAudioSpy = vi.spyOn(server.sessionManager, "feedAudio");

      // Send TM frame with unknown type byte 0x58
      const badFrame = Buffer.from([0x54, 0x4d, 0x58, 0x00, 0x00, 0x02, 0x7b, 0x7d]);
      c.sendBinary(badFrame);

      await new Promise((r) => setTimeout(r, 100));

      expect(feedVideoSpy).not.toHaveBeenCalled();
      expect(feedAudioSpy).not.toHaveBeenCalled();
    });
  });

  // ─── video_status periodic sender ─────────────────────────────────────────

  describe("video_status", () => {
    it("should send periodic video_status during recording when video processor exists", async () => {
      const c = track(await createClient(server));

      // Set up video consent and stream ready
      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      // Mock getVideoProcessor to return a fake processor
      const mockStatus = {
        framesProcessed: 10,
        framesDropped: 2,
        processingLatencyMs: 50,
        framesReceived: 15,
        framesSkippedBySampler: 3,
        framesDroppedByBackpressure: 0,
        framesDroppedByTimestamp: 0,
        framesErrored: 0,
        effectiveSamplingRate: 2,
      };
      vi.spyOn(server.sessionManager, "getVideoProcessor").mockReturnValue({
        getExtendedStatus: () => mockStatus,
      } as unknown as ReturnType<typeof server.sessionManager.getVideoProcessor>);

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Wait for at least one video_status message (sent every 1s)
      const statusMsg = await c.nextMessageOfType("video_status", 2000);
      expect(statusMsg.type).toBe("video_status");
      expect((statusMsg as { framesReceived: number }).framesReceived).toBe(15);
      expect((statusMsg as { effectiveSamplingRate: number }).effectiveSamplingRate).toBe(2);
    });

    it("should send final video_status after stop_recording with finalization data", async () => {
      const c = track(await createClient(server));

      // Set up video consent and stream ready
      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Mock stopRecording to set visualObservations on the session
      const originalStop = server.sessionManager.stopRecording.bind(server.sessionManager);
      vi.spyOn(server.sessionManager, "stopRecording").mockImplementation(async (sessionId: string) => {
        await originalStop(sessionId);
        const session = server.sessionManager.getSession(sessionId);
        session.visualObservations = {
          gazeBreakdown: { audienceFacing: 70, notesFacing: 20, other: 10 },
          faceNotDetectedCount: 1,
          totalGestureCount: 5,
          gestureFrequency: 3.0,
          gesturePerSentenceRatio: 0.5,
          handsDetectedFrames: 8,
          handsNotDetectedFrames: 2,
          meanBodyStabilityScore: 0.9,
          stageCrossingCount: 1,
          movementClassification: "stationary" as const,
          meanFacialEnergyScore: 0.4,
          facialEnergyVariation: 0.2,
          facialEnergyLowSignal: false,
          framesAnalyzed: 10,
          framesReceived: 15,
          framesSkippedBySampler: 3,
          framesErrored: 0,
          framesDroppedByBackpressure: 1,
          framesDroppedByTimestamp: 1,
          framesDroppedByFinalizationBudget: 0,
          resolutionChangeCount: 0,
          videoQualityGrade: "good" as const,
          videoQualityWarning: false,
          finalizationLatencyMs: 150,
          videoProcessingVersion: {
            tfjsVersion: "4.0.0",
            tfjsBackend: "cpu",
            modelVersions: { blazeface: "1.0", movenet: "1.0" },
            configHash: "abc123",
          },
          gazeReliable: true,
          gestureReliable: true,
          stabilityReliable: true,
          facialEnergyReliable: true,
        };
      });

      // Also mock getVideoProcessor to return null after stop (processor removed)
      vi.spyOn(server.sessionManager, "getVideoProcessor").mockReturnValue(undefined);

      c.sendJson({ type: "stop_recording" });

      // Look for the final video_status with finalizationLatencyMs
      const finalStatus = await c.nextMessageOfType("video_status", 3000);
      expect(finalStatus.type).toBe("video_status");
      expect((finalStatus as { finalizationLatencyMs: number }).finalizationLatencyMs).toBe(150);
      expect((finalStatus as { videoQualityGrade: string }).videoQualityGrade).toBe("good");
      expect((finalStatus as { framesReceived: number }).framesReceived).toBe(15);
    });

    it("should throttle video_status to at most 1 per second", async () => {
      const c = track(await createClient(server));

      // Mock getVideoProcessor to return a fake processor
      const mockStatus = {
        framesProcessed: 5,
        framesDropped: 0,
        processingLatencyMs: 20,
        framesReceived: 10,
        framesSkippedBySampler: 5,
        framesDroppedByBackpressure: 0,
        framesDroppedByTimestamp: 0,
        framesErrored: 0,
        effectiveSamplingRate: 2,
      };
      vi.spyOn(server.sessionManager, "getVideoProcessor").mockReturnValue({
        getExtendedStatus: () => mockStatus,
      } as unknown as ReturnType<typeof server.sessionManager.getVideoProcessor>);

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Collect video_status messages over ~2.5 seconds
      const statusMessages: ServerMessage[] = [];
      const collectStart = Date.now();
      const collectDuration = 2500;

      while (Date.now() - collectStart < collectDuration) {
        try {
          const msg = await c.nextMessageOfType("video_status", 1200);
          statusMessages.push(msg);
        } catch {
          // Timeout is fine — just means no more messages in this window
          break;
        }
      }

      // Over 2.5 seconds, we should get at most 3 video_status messages (≤1/sec)
      expect(statusMessages.length).toBeGreaterThanOrEqual(1);
      expect(statusMessages.length).toBeLessThanOrEqual(3);
    });
  });

  // ─── Additional binary frame routing tests ──────────────────────────────────

  describe("binary frame routing — edge cases", () => {
    it("should silently discard malformed video frames with corrupt header JSON", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      const feedSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Build a TM video frame with corrupt header JSON
      const corruptHeader = Buffer.from("not{valid}json", "utf-8");
      const frame = Buffer.alloc(6 + corruptHeader.length + 4);
      frame[0] = 0x54; // T
      frame[1] = 0x4d; // M
      frame[2] = 0x56; // V (video)
      frame[3] = (corruptHeader.length >> 16) & 0xff;
      frame[4] = (corruptHeader.length >> 8) & 0xff;
      frame[5] = corruptHeader.length & 0xff;
      corruptHeader.copy(frame, 6);
      // Some JPEG-like bytes
      frame[6 + corruptHeader.length] = 0xff;
      frame[6 + corruptHeader.length + 1] = 0xd8;

      c.sendBinary(frame);
      await new Promise((r) => setTimeout(r, 100));

      // feedVideoFrame should NOT be called — decodeVideoFrame returns null
      expect(feedSpy).not.toHaveBeenCalled();
    });

    it("should silently discard binary frames without TM prefix in RECORDING state", async () => {
      const c = track(await createClient(server));

      const feedVideoSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send binary data that doesn't start with TM magic (0x54 0x4D)
      // and is NOT valid raw PCM (odd length to avoid legacy path processing)
      const nonTMData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      c.sendBinary(nonTMData);

      await new Promise((r) => setTimeout(r, 100));

      // No video frame should be routed
      expect(feedVideoSpy).not.toHaveBeenCalled();
    });

    it("should silently discard video frames in non-RECORDING state", async () => {
      const c = track(await createClient(server));

      const feedSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");

      // Session is in IDLE — send a video frame
      const videoFrame = encodeVideoFrame(
        { timestamp: 1.0, seq: 0, width: 640, height: 480 },
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      );
      c.sendBinary(videoFrame);

      await new Promise((r) => setTimeout(r, 100));

      // feedVideoFrame is called but SessionManager guards on RECORDING state
      // The frame is effectively discarded
      expect(feedSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Video consent in various non-IDLE states ───────────────────────────────

  describe("set_video_consent — non-IDLE state rejection", () => {
    it("should reject set_video_consent in PROCESSING state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Transition to PROCESSING by stopping recording
      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
      expect((errMsg as { message: string }).message).toContain("idle");
    });
  });

  // ─── video_stream_ready in non-IDLE states ─────────────────────────────────

  describe("video_stream_ready — non-IDLE state rejection", () => {
    it("should reject video_stream_ready in PROCESSING state", async () => {
      const c = track(await createClient(server));

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      c.sendJson({ type: "stop_recording" });
      await c.nextMessageOfType("state_change"); // PROCESSING

      c.sendJson({
        type: "video_stream_ready",
        width: 640,
        height: 480,
      });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── set_video_config boundary values ──────────────────────────────────────

  describe("set_video_config — boundary values", () => {
    it("should accept frameRate of 1 (minimum)", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 1 });

      // Verify no error by sending another message and getting its response
      c.sendJson({ type: "set_consent", speakerName: "Test", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");
      expect(msg.type).toBe("consent_status");
    });

    it("should accept frameRate of 5 (maximum)", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 5 });

      // Verify no error
      c.sendJson({ type: "set_consent", speakerName: "Test", consentConfirmed: true });
      const msg = await c.nextMessageOfType("consent_status");
      expect(msg.type).toBe("consent_status");
    });

    it("should reject frameRate of 6 (just above max)", async () => {
      const c = track(await createClient(server));

      c.sendJson({ type: "set_video_config", frameRate: 6 });

      const errMsg = await c.nextMessageOfType("error");
      expect(errMsg.type).toBe("error");
      expect((errMsg as { recoverable: boolean }).recoverable).toBe(true);
    });
  });

  // ─── Audio priority: audio never blocked by video ──────────────────────────

  describe("audio priority", () => {
    it("should process audio frames synchronously even when video frames are sent", async () => {
      const c = track(await createClient(server));

      // Set up video consent and stream ready
      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      const feedAudioSpy = vi.spyOn(server.sessionManager, "feedAudio");
      const feedVideoSpy = vi.spyOn(server.sessionManager, "feedVideoFrame");

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send interleaved video and audio frames
      const videoFrame = encodeVideoFrame(
        { timestamp: 0.5, seq: 0, width: 640, height: 480 },
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      );
      const audioFrame = encodeAudioFrame(
        { timestamp: 0.5, seq: 0 },
        Buffer.alloc(1600), // 50ms of 16kHz mono 16-bit PCM
      );

      // Send video first, then audio
      c.sendBinary(videoFrame);
      c.sendBinary(audioFrame);

      await new Promise((r) => setTimeout(r, 200));

      // Both should be processed — audio is never blocked by video
      expect(feedVideoSpy).toHaveBeenCalledTimes(1);
      expect(feedAudioSpy).toHaveBeenCalledTimes(1);
    });

    it("should handle audio frames via feedAudio (synchronous) while video uses fire-and-forget enqueue", async () => {
      const c = track(await createClient(server));

      c.sendJson({
        type: "set_video_consent",
        consentGranted: true,
        timestamp: new Date().toISOString(),
      });
      c.sendJson({ type: "video_stream_ready", width: 640, height: 480 });

      // Track call order to verify audio is not blocked
      const callOrder: string[] = [];
      vi.spyOn(server.sessionManager, "feedAudio").mockImplementation(() => {
        callOrder.push("audio");
      });
      vi.spyOn(server.sessionManager, "feedVideoFrame").mockImplementation(() => {
        callOrder.push("video");
      });

      await setConsentForRecording(c);
      c.sendJson({ type: "start_recording" });
      await c.nextMessageOfType("state_change"); // RECORDING

      // Send multiple video frames then an audio frame
      for (let i = 0; i < 3; i++) {
        const vf = encodeVideoFrame(
          { timestamp: i * 0.5, seq: i, width: 640, height: 480 },
          Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        );
        c.sendBinary(vf);
      }

      const af = encodeAudioFrame(
        { timestamp: 1.0, seq: 0 },
        Buffer.alloc(1600),
      );
      c.sendBinary(af);

      await new Promise((r) => setTimeout(r, 200));

      // All frames should be processed — video via fire-and-forget, audio synchronously
      const videoCount = callOrder.filter((c) => c === "video").length;
      const audioCount = callOrder.filter((c) => c === "audio").length;
      expect(videoCount).toBe(3);
      expect(audioCount).toBe(1);

      // Audio should appear in the call order (not blocked by video)
      expect(callOrder).toContain("audio");
    });
  });
});
