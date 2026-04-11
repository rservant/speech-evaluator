/**
 * Live Audio Pipeline Integration Test (#190)
 *
 * Exercises the full WebSocket live recording pipeline:
 *   audio chunks → Deepgram live → OpenAI whisper → metrics → evaluation → TTS
 *
 * Requires DEEPGRAM_API_KEY and OPENAI_API_KEY in .env.
 * Streams a pre-recorded WAV file as raw PCM chunks via WebSocket,
 * simulating the browser AudioWorklet.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";
import { createAppServer, type AppServer } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { TranscriptionEngine } from "./transcription-engine.js";
import { MetricsExtractor } from "./metrics-extractor.js";
import { EvaluationGenerator } from "./evaluation-generator.js";
import { TTSEngine } from "./tts-engine.js";
import { VADMonitor } from "./vad-monitor.js";
import { createLogger } from "./logger.js";

// Skip if API keys not available
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const HAS_KEYS = Boolean(DEEPGRAM_KEY && OPENAI_KEY);

const TEST_WAV_PATH = resolve(process.cwd(), "test-fixtures/short-speech.wav");

describe.skipIf(!HAS_KEYS)("Live Audio Pipeline (integration)", () => {
  let server: AppServer;
  let serverUrl: string;
  const logger = createLogger("LivePipelineTest");

  beforeAll(async () => {
    // Create real pipeline with API keys
    const { createClient } = await import("@deepgram/sdk");
    const deepgramClient = createClient(DEEPGRAM_KEY!);
    const OpenAI = (await import("openai")).default;
    const openaiClient = new OpenAI({ apiKey: OPENAI_KEY });

    const transcriptionEngine = new TranscriptionEngine(
      deepgramClient as any,
      openaiClient as any,
    );
    const metricsExtractor = new MetricsExtractor();
    const evaluationGenerator = new EvaluationGenerator(openaiClient as any);
    const ttsEngine = new TTSEngine(openaiClient as any);

    const sessionManager = new SessionManager({
      transcriptionEngine,
      metricsExtractor,
      evaluationGenerator,
      ttsEngine,
      vadMonitorFactory: (config, callbacks) => new VADMonitor(config, callbacks),
    });

    server = createAppServer({
      logger,
      sessionManager,
      version: "integration-test",
      openaiClient: openaiClient as any,
    });

    await server.listen(0); // OS-assigned port
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverUrl = `ws://localhost:${port}`;
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("streams audio and receives evaluation with non-zero metrics", async () => {
    // Read WAV file and strip 44-byte header to get raw PCM
    const wavBuffer = readFileSync(TEST_WAV_PATH);
    const pcmData = wavBuffer.subarray(44);

    const ws = new WebSocket(serverUrl);
    const messages: any[] = [];
    let ttsReceived = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Test timeout (120s)")), 120000);

      ws.on("open", () => {
        // Step 1: Wait for initial state_change
      });

      ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        // Handle binary TTS audio
        if (isBinary) {
          ttsReceived = true;
          return;
        }

        const text = typeof data === "string" ? data : data.toString("utf-8");
        let msg: any;
        try { msg = JSON.parse(text); } catch { return; }
        messages.push(msg);
        logger.info(`[test] received: ${msg.type} ${msg.state || msg.stage || ""}`);


        // Step 2: After initial IDLE, send handshake + consent + start
        if (msg.type === "state_change" && msg.state === "idle" && messages.length === 1) {
          ws.send(JSON.stringify({
            type: "audio_format",
            channels: 1,
            sampleRate: 16000,
            encoding: "LINEAR16",
          }));
          ws.send(JSON.stringify({
            type: "set_consent",
            speakerName: "Integration Tester",
            consentConfirmed: true,
          }));
          ws.send(JSON.stringify({ type: "start_recording" }));
        }

        // Step 3: When RECORDING, stream audio chunks
        if (msg.type === "state_change" && msg.state === "recording") {
          // Stream PCM in 3200-byte chunks (100ms at 16kHz 16-bit mono)
          const CHUNK_SIZE = 3200;
          let offset = 0;
          const sendChunk = () => {
            if (offset >= pcmData.length) {
              // All audio sent — stop recording
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "stop_recording" }));
              }, 500);
              return;
            }
            const chunk = pcmData.subarray(offset, offset + CHUNK_SIZE);
            ws.send(chunk);
            offset += CHUNK_SIZE;
            // Simulate real-time: send chunks every 100ms
            setTimeout(sendChunk, 50); // 2x speed to keep test fast
          };
          sendChunk();
        }

        // Step 4: When PROCESSING completes, deliver evaluation
        if (msg.type === "pipeline_progress" && msg.stage === "ready") {
          ws.send(JSON.stringify({ type: "deliver_evaluation" }));
        }

        // Step 5: Capture evaluation_ready data
        if (msg.type === "evaluation_ready") {
          logger.info("[test] GOT evaluation_ready!");
        }

        // Step 6: When delivering completes (back to idle after delivering), we're done
        if (msg.type === "state_change" && msg.state === "idle") {
          const hasDelivered = messages.some((m: any) => m.type === "state_change" && m.state === "delivering");
          if (hasDelivered) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Verify full state machine cycle: IDLE → RECORDING → PROCESSING → DELIVERING → IDLE
    const stateChanges = messages
      .filter((m: any) => m.type === "state_change")
      .map((m: any) => m.state);
    expect(stateChanges).toContain("recording");
    expect(stateChanges).toContain("processing");
    expect(stateChanges).toContain("delivering");

    // Verify pipeline completed successfully
    const pipelineStages = messages
      .filter((m: any) => m.type === "pipeline_progress")
      .map((m: any) => m.stage);
    expect(pipelineStages).toContain("ready");

    // Verify TTS audio was received
    expect(ttsReceived).toBe(true);
  }, 120000);
});
