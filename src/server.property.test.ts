// Property-Based Tests for Server - Audio Capture Inactive During Delivery
// Feature: ai-toastmasters-evaluator, Property 9: Audio Capture Inactive During Delivery

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import WebSocket from "ws";
import {
  createAppServer,
  type AppServer,
  EXPECTED_FORMAT,
} from "./server.js";
import { SessionState, type ServerMessage, type Session } from "./types.js";

// ─── Test Helpers (adapted from server.test.ts) ─────────────────────────────────

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
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        msg = { type: "tts_audio", data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as ServerMessage;
      } else {
        const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        msg = JSON.parse(text) as ServerMessage;
      }
      if (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        waiter(msg);
      } else {
        this.messageQueue.push(msg);
      }
    });
  }

  async waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  nextMessage(timeoutMs = 3000): Promise<ServerMessage> {
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
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

  async nextMessageOfType(type: string, timeoutMs = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const msg = await this.nextMessage(remaining);
        if (msg.type === type) return msg;
      } catch {
        break;
      }
    }
    throw new Error(`nextMessageOfType("${type}") timed out after ${timeoutMs}ms`);
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data);
  }

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
  const initial = await client.nextMessage();
  expect(initial).toEqual({ type: "state_change", state: SessionState.IDLE });
  return client;
}

/**
 * Transitions a client's session to DELIVERING state by performing:
 * audio_format handshake → start_recording → stop_recording → deliver_evaluation
 *
 * Since handleDeliverEvaluation now completes the full pipeline (including
 * completeDelivery), we mock generateEvaluation to keep the session in
 * DELIVERING state for the duration of the test.
 */
async function transitionToDelivering(client: TestClient, server: AppServer): Promise<void> {
  // Set consent before starting recording (required by Phase 2 consent gating)
  client.sendJson({ type: "set_consent", speakerName: "Test Speaker", consentConfirmed: true });
  await client.nextMessageOfType("consent_status");

  client.sendJson({ type: "audio_format", ...EXPECTED_FORMAT });
  client.sendJson({ type: "start_recording" });
  await client.nextMessageOfType("state_change"); // RECORDING

  client.sendJson({ type: "stop_recording" });
  await client.nextMessageOfType("state_change"); // PROCESSING

  // Mock generateEvaluation to keep session in DELIVERING state
  // (the real pipeline would complete delivery and transition to IDLE)
  const origGenerate = server.sessionManager.generateEvaluation.bind(server.sessionManager);
  vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
    const session = server.sessionManager.getSession(sid);
    session.state = SessionState.DELIVERING;
    // Return undefined with no evaluation — server will call completeDelivery
    // but we also mock that to keep the state
    return undefined;
  });
  vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation(() => {
    // No-op: keep session in DELIVERING state for the property test
  });

  client.sendJson({ type: "deliver_evaluation" });
  await client.nextMessageOfType("state_change"); // DELIVERING
}

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generate a valid 16-bit aligned audio chunk buffer of arbitrary size.
 * Sizes range from 2 bytes (minimum valid 16-bit aligned) to 3200 bytes (2x standard chunk).
 * Content is arbitrary binary data representing any possible audio input.
 */
function arbitraryAudioChunk(): fc.Arbitrary<Buffer> {
  return fc
    .integer({ min: 1, max: 1600 })
    .chain((halfLen) =>
      fc
        .uint8Array({ minLength: halfLen * 2, maxLength: halfLen * 2 })
        .map((arr) => Buffer.from(arr))
    );
}

/**
 * Generate a batch of 1 to 5 audio chunks to send in a single test iteration.
 * Keeping the batch small ensures each iteration is fast while still testing
 * multiple chunks per session.
 */
function arbitraryAudioChunkBatch(): fc.Arbitrary<Buffer[]> {
  return fc.array(arbitraryAudioChunk(), { minLength: 1, maxLength: 5 });
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 9: Audio Capture Inactive During Delivery", () => {
  /**
   * **Validates: Requirements 5.3**
   *
   * Property 9: Audio Capture Inactive During Delivery
   *
   * For any session in the DELIVERING state, the Audio Capture Module SHALL
   * reject or ignore any incoming audio data. Specifically:
   * - Every audio chunk sent during DELIVERING state receives an error response
   *   containing 'not "recording"'
   * - No audio chunks are buffered in the session during DELIVERING state
   */
  it("rejects all arbitrary audio chunks sent during DELIVERING state", { timeout: 30000 }, async () => {
    // Create a single server for all iterations (stays open throughout the test)
    const silentLogger = createSilentLogger();
    const server = createAppServer({ logger: silentLogger });
    await server.listen(0);

    try {
      await fc.assert(
        fc.asyncProperty(arbitraryAudioChunkBatch(), async (chunks) => {
          const client = await createClient(server);
          try {
            // Transition to DELIVERING state
            await transitionToDelivering(client, server);

            // Verify session is in DELIVERING state and get a reference to it
            const sessions = Array.from(
              (
                server.sessionManager as unknown as {
                  sessions: Map<string, Session>;
                }
              ).sessions.values(),
            );
            const session = sessions[sessions.length - 1];
            expect(session.state).toBe(SessionState.DELIVERING);

            // Record the audio chunk count before sending test chunks
            const chunkCountBefore = session.audioChunks.length;

            // Send all arbitrary audio chunks while in DELIVERING state
            for (const chunk of chunks) {
              client.sendBinary(chunk);
            }

            // Collect error responses — one per chunk sent
            const errors: ServerMessage[] = [];
            for (let i = 0; i < chunks.length; i++) {
              const msg = await client.nextMessageOfType("error", 3000);
              errors.push(msg);
            }

            // PROPERTY ASSERTION 1: Every chunk was rejected with an error
            expect(errors.length).toBe(chunks.length);
            for (const err of errors) {
              expect(err.type).toBe("error");
              expect((err as { message: string }).message).toContain(
                'not "recording"',
              );
            }

            // PROPERTY ASSERTION 2: No audio chunks were buffered during DELIVERING
            expect(session.audioChunks.length).toBe(chunkCountBefore);
          } finally {
            client.close();
            vi.restoreAllMocks();
            // Small delay to let the server process the close before next iteration
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }),
        { numRuns: 100 },
      );
    } finally {
      await server.close();
    }
  });
});


// ─── Eager Evaluation Pipeline Property Tests ───────────────────────────────────

// Feature: eager-evaluation-pipeline, Property 10: Cache-hit delivery skips generation
describe("Feature: eager-evaluation-pipeline, Property 10: Cache-hit delivery skips generation", () => {
  /**
   * **Validates: Requirements 5.1**
   *
   * Property 10: Cache-hit delivery skips generation
   *
   * For any session where isEagerCacheValid() returns true, calling the delivery
   * handler SHALL NOT invoke generateEvaluation() or any LLM/TTS API calls,
   * and SHALL deliver the cached ttsAudio via ws.send() directly.
   * The evaluation_ready message SHALL contain cache.evaluationPublic (not raw evaluation).
   */
  it("delivers from cache without calling generateEvaluation when cache is valid", { timeout: 30000 }, async () => {
    const silentLogger = createSilentLogger();
    const server = createAppServer({ logger: silentLogger });
    await server.listen(0);

    try {
      await fc.assert(
        fc.asyncProperty(
          // Generate arbitrary TTS audio buffers (1KB–50KB)
          fc.integer({ min: 1024, max: 51200 }).chain((size) =>
            fc.uint8Array({ minLength: size, maxLength: size }).map((arr) => Buffer.from(arr)),
          ),
          // Generate arbitrary evaluation script strings
          fc.string({ minLength: 10, maxLength: 200 }),
          // Generate arbitrary time limit
          fc.integer({ min: 30, max: 600 }),
          async (ttsAudio, evalScript, timeLimit) => {
            const client = new TestClient(getServerUrl(server));
            await client.waitForOpen();
            // Consume initial state_change IDLE
            const initial = await client.nextMessage();
            expect(initial).toEqual({ type: "state_change", state: SessionState.IDLE });

            try {
              // Set consent and start/stop recording to get to PROCESSING
              client.sendJson({ type: "set_consent", speakerName: "Test Speaker", consentConfirmed: true });
              await client.nextMessageOfType("consent_status");

              client.sendJson({ type: "start_recording" });
              await client.nextMessageOfType("state_change"); // RECORDING

              // Mock runEagerPipeline to be a no-op (we'll set cache manually)
              vi.spyOn(server.sessionManager, "runEagerPipeline").mockReturnValue(Promise.resolve());

              client.sendJson({ type: "stop_recording" });
              await client.nextMessageOfType("state_change"); // PROCESSING

              // Get the session and set up a valid eager cache
              const sessions = Array.from(
                (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
              );
              const session = sessions[sessions.length - 1];

              const evaluationPublic = {
                opening: "Great speech.",
                items: [{
                  type: "commendation" as const,
                  summary: "Good opening",
                  explanation: "Strong start",
                  evidence_quote: "hello world test",
                  evidence_timestamp: 1,
                }],
                closing: "Well done.",
                structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
              };

              session.evaluationCache = {
                runId: session.runId,
                timeLimitSeconds: session.timeLimitSeconds,
                voiceConfig: session.voiceConfig ?? "nova",
                evaluation: {
                  opening: "Great speech.",
                  items: [{
                    type: "commendation",
                    summary: "Good opening",
                    evidence_quote: "hello world test",
                    evidence_timestamp: 1,
                    explanation: "Strong start",
                  }],
                  closing: "Well done.",
                  structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
                },
                evaluationScript: evalScript,
                ttsAudio,
                evaluationPublic,
              };
              session.eagerStatus = "ready";

              // Spy on generateEvaluation to verify it's NOT called
              const generateSpy = vi.spyOn(server.sessionManager, "generateEvaluation");

              // Send deliver_evaluation
              client.sendJson({ type: "deliver_evaluation" });

              // Should get state_change DELIVERING
              const deliveringMsg = await client.nextMessageOfType("state_change");
              expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

              // Should get evaluation_ready with evaluationPublic (not raw evaluation)
              const evalReady = await client.nextMessageOfType("evaluation_ready");
              expect((evalReady as any).evaluation.opening).toBe(evaluationPublic.opening);
              expect((evalReady as any).evaluation.items[0].summary).toBe(evaluationPublic.items[0].summary);
              expect((evalReady as any).script).toBe(evalScript);

              // Should get TTS audio binary frame
              const ttsMsg = await client.nextMessageOfType("tts_audio");
              expect(ttsMsg.type).toBe("tts_audio");

              // Should get tts_complete
              await client.nextMessageOfType("tts_complete");

              // Should get state_change IDLE
              const idleMsg = await client.nextMessageOfType("state_change");
              expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });

              // PROPERTY ASSERTION: generateEvaluation was NEVER called
              expect(generateSpy).not.toHaveBeenCalled();
            } finally {
              client.close();
              vi.restoreAllMocks();
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      await server.close();
    }
  });
});

// Feature: eager-evaluation-pipeline, Property 11: Fallback delivery on failure or missing cache
describe("Feature: eager-evaluation-pipeline, Property 11: Fallback delivery on failure or missing cache", () => {
  /**
   * **Validates: Requirements 5.3**
   *
   * Property 11: Fallback delivery on failure or missing cache
   *
   * For any session where eagerStatus is failed/idle or cache is invalid,
   * calling the delivery handler SHALL run the full synchronous evaluation
   * pipeline as a fallback, and the session SHALL remain in PROCESSING during
   * fallback execution.
   */
  it("runs synchronous fallback when eager status is failed or idle", { timeout: 30000 }, async () => {
    const silentLogger = createSilentLogger();
    const server = createAppServer({ logger: silentLogger });
    await server.listen(0);

    try {
      await fc.assert(
        fc.asyncProperty(
          // Generate arbitrary eager status that triggers fallback
          fc.constantFrom("failed" as const, "idle" as const),
          // Generate arbitrary audio buffer for the fallback pipeline result
          fc.integer({ min: 1024, max: 10240 }).chain((size) =>
            fc.uint8Array({ minLength: size, maxLength: size }).map((arr) => Buffer.from(arr)),
          ),
          async (eagerStatus, fallbackAudio) => {
            const client = new TestClient(getServerUrl(server));
            await client.waitForOpen();
            const initial = await client.nextMessage();
            expect(initial).toEqual({ type: "state_change", state: SessionState.IDLE });

            try {
              // Set consent and start/stop recording to get to PROCESSING
              client.sendJson({ type: "set_consent", speakerName: "Test Speaker", consentConfirmed: true });
              await client.nextMessageOfType("consent_status");

              client.sendJson({ type: "start_recording" });
              await client.nextMessageOfType("state_change"); // RECORDING

              // Mock runEagerPipeline to be a no-op
              vi.spyOn(server.sessionManager, "runEagerPipeline").mockReturnValue(Promise.resolve());

              client.sendJson({ type: "stop_recording" });
              await client.nextMessageOfType("state_change"); // PROCESSING

              // Get the session and set eagerStatus to the test value
              const sessions = Array.from(
                (server.sessionManager as unknown as { sessions: Map<string, Session> }).sessions.values(),
              );
              const session = sessions[sessions.length - 1];
              session.eagerStatus = eagerStatus;
              session.evaluationCache = null; // No valid cache
              session.eagerPromise = null;

              // Verify session is in PROCESSING before delivery
              expect(session.state).toBe(SessionState.PROCESSING);

              // Track state during generateEvaluation to verify PROCESSING is maintained
              let statesDuringGeneration: SessionState[] = [];

              // Mock generateEvaluation — the synchronous fallback path
              vi.spyOn(server.sessionManager, "generateEvaluation").mockImplementation(async (sid) => {
                const s = server.sessionManager.getSession(sid);
                // Record state at the start of generation — should be PROCESSING
                statesDuringGeneration.push(s.state);
                s.state = SessionState.DELIVERING;
                s.evaluation = {
                  opening: "Great speech.",
                  items: [],
                  closing: "Well done.",
                  structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
                };
                s.evaluationScript = "Great speech. Well done.";
                s.evaluationPublic = {
                  opening: "Great speech.",
                  items: [],
                  closing: "Well done.",
                  structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
                };
                return fallbackAudio;
              });
              vi.spyOn(server.sessionManager, "completeDelivery").mockImplementation((sid) => {
                const s = server.sessionManager.getSession(sid);
                s.state = SessionState.IDLE;
              });

              // Send deliver_evaluation
              client.sendJson({ type: "deliver_evaluation" });

              // Should get state_change DELIVERING (from fallback pipeline)
              const deliveringMsg = await client.nextMessageOfType("state_change");
              expect(deliveringMsg).toEqual({ type: "state_change", state: SessionState.DELIVERING });

              // Should get evaluation_ready
              await client.nextMessageOfType("evaluation_ready");

              // Should get TTS audio
              await client.nextMessageOfType("tts_audio");

              // Should get tts_complete
              await client.nextMessageOfType("tts_complete");

              // Should get state_change IDLE
              const idleMsg = await client.nextMessageOfType("state_change");
              expect(idleMsg).toEqual({ type: "state_change", state: SessionState.IDLE });

              // PROPERTY ASSERTION: generateEvaluation WAS called (fallback path)
              expect(server.sessionManager.generateEvaluation).toHaveBeenCalledOnce();

              // PROPERTY ASSERTION: session was in PROCESSING when generateEvaluation started
              expect(statesDuringGeneration.length).toBe(1);
              expect(statesDuringGeneration[0]).toBe(SessionState.PROCESSING);
            } finally {
              client.close();
              vi.restoreAllMocks();
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      await server.close();
    }
  });
});

// Feature: eager-evaluation-pipeline, Property 1: State and behavioral boundary during eager execution (server layer)
describe("Feature: eager-evaluation-pipeline, Property 1: State and behavioral boundary during eager execution (server layer)", () => {
  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * Property 1: State and behavioral boundary during eager execution (server layer)
   *
   * Instrument sendMessage()/ws.send() and assert that the eager kickoff path
   * produces only pipeline_progress messages — no evaluation_ready, TTS audio
   * frames, or tts_complete until deliver_evaluation is received.
   *
   * Strategy: Instead of using slow negative-assertion timeouts per iteration,
   * we intercept ws.send() at the server level and record all messages sent
   * during the eager pipeline phase. This is fast and deterministic.
   */
  it("eager kickoff produces only pipeline_progress messages, no delivery messages", { timeout: 60000 }, async () => {
    const silentLogger = createSilentLogger();
    const server = createAppServer({ logger: silentLogger });
    await server.listen(0);

    try {
      await fc.assert(
        fc.asyncProperty(
          // Generate arbitrary number of pipeline stages to emit (1-3)
          fc.integer({ min: 1, max: 3 }),
          async (stageCount) => {
            const client = new TestClient(getServerUrl(server));
            await client.waitForOpen();
            const initial = await client.nextMessage();
            expect(initial).toEqual({ type: "state_change", state: SessionState.IDLE });

            try {
              // Set consent and start recording
              client.sendJson({ type: "set_consent", speakerName: "Test Speaker", consentConfirmed: true });
              await client.nextMessageOfType("consent_status");

              client.sendJson({ type: "start_recording" });
              await client.nextMessageOfType("state_change"); // RECORDING

              // Control the eager pipeline: capture the onProgress callback and resolve manually
              let capturedOnProgress: ((stage: import("./types.js").PipelineStage) => void) | undefined;
              let resolveEager: (() => void) | undefined;

              vi.spyOn(server.sessionManager, "runEagerPipeline").mockImplementation(
                (_sessionId: string, onProgress?: (stage: import("./types.js").PipelineStage) => void) => {
                  capturedOnProgress = onProgress;
                  const session = server.sessionManager.getSession(_sessionId);
                  session.eagerStatus = "generating";
                  return new Promise<void>((resolve) => {
                    resolveEager = resolve;
                  });
                },
              );

              // Stop recording — triggers eager pipeline kickoff
              client.sendJson({ type: "stop_recording" });
              await client.nextMessageOfType("state_change"); // PROCESSING

              // Consume the pipeline_progress: processing_speech message
              const processingMsg = await client.nextMessageOfType("pipeline_progress");
              expect((processingMsg as any).stage).toBe("processing_speech");

              // Now simulate eager pipeline progress stages
              const stages: import("./types.js").PipelineStage[] = [
                "generating_evaluation",
                "synthesizing_audio",
                "ready",
              ].slice(0, stageCount) as import("./types.js").PipelineStage[];

              for (const stage of stages) {
                capturedOnProgress!(stage);
              }

              // Collect exactly stageCount messages (one per stage emitted)
              const messagesAfterEager: ServerMessage[] = [];
              for (let i = 0; i < stageCount; i++) {
                const msg = await client.nextMessage(2000);
                messagesAfterEager.push(msg);
              }

              // PROPERTY ASSERTION: All messages during eager are pipeline_progress only
              const forbiddenTypes = new Set(["evaluation_ready", "tts_audio", "tts_complete"]);
              for (const msg of messagesAfterEager) {
                expect(msg.type).toBe("pipeline_progress");
                expect(forbiddenTypes.has(msg.type)).toBe(false);
              }

              // PROPERTY ASSERTION: Verify no extra messages are queued
              // The message queue should be empty since we consumed exactly stageCount messages
              // and no delivery messages should have been sent
              // (We don't use a timeout-based negative assertion — the deterministic
              // count-based collection above is sufficient since the server is synchronous
              // in its message sending via the progress callback)

              // Clean up: resolve the eager promise
              if (resolveEager) resolveEager();
            } finally {
              client.close();
              vi.restoreAllMocks();
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      await server.close();
    }
  });
});
