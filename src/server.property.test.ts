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
  it("rejects all arbitrary audio chunks sent during DELIVERING state", async () => {
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
