// AI Toastmasters Evaluator - Entry point
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

export const APP_NAME = "AI Toastmasters Evaluator";
export const APP_VERSION = "0.1.0";

const port = parseInt(process.env.PORT || "3000", 10);

// ─── Validate API keys ─────────────────────────────────────────────────────────

const deepgramKey = process.env.DEEPGRAM_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!deepgramKey) {
  console.error("[FATAL] DEEPGRAM_API_KEY is not set. Add it to your .env file.");
  process.exit(1);
}

if (!openaiKey) {
  console.error("[FATAL] OPENAI_API_KEY is not set. Add it to your .env file.");
  process.exit(1);
}

console.log("[INIT] API keys loaded");

// ─── Initialize API clients ─────────────────────────────────────────────────────

console.log("[INIT] Creating Deepgram client...");
const deepgramClient = createDeepgramClient(deepgramKey);

console.log("[INIT] Creating OpenAI client...");
const openaiClient = new OpenAI({ apiKey: openaiKey });

// ─── Initialize pipeline components ─────────────────────────────────────────────

console.log("[INIT] Initializing TranscriptionEngine (Deepgram live + OpenAI post-speech)...");
const transcriptionEngine = new TranscriptionEngine(deepgramClient, openaiClient as unknown as OpenAITranscriptionClient);

console.log("[INIT] Initializing MetricsExtractor...");
const metricsExtractor = new MetricsExtractor();

console.log("[INIT] Initializing EvaluationGenerator (GPT-4o)...");
const evaluationGenerator = new EvaluationGenerator(openaiClient as unknown as OpenAIClient);

console.log("[INIT] Initializing TTSEngine (OpenAI TTS)...");
const ttsEngine = new TTSEngine(openaiClient as unknown as OpenAITTSClient);

console.log("[INIT] Initializing FilePersistence (output/)...");
const filePersistence = new FilePersistence("output");

// ─── Create SessionManager with all dependencies ────────────────────────────────

console.log("[INIT] Wiring SessionManager pipeline...");
const sessionManager = new SessionManager({
  transcriptionEngine,
  metricsExtractor,
  evaluationGenerator,
  ttsEngine,
  filePersistence,
  vadMonitorFactory: (config: VADConfig, callbacks: VADEventCallback) =>
    new VADMonitor(config, callbacks),
});

// ─── Start server ───────────────────────────────────────────────────────────────

const server = createAppServer({ sessionManager });

server.listen(port).then(() => {
  console.log(`[INIT] ${APP_NAME} v${APP_VERSION} running at http://localhost:${port}`);
  console.log("[INIT] Pipeline: Deepgram → OpenAI Transcribe → MetricsExtractor → GPT-4o → TTS");
  console.log("[INIT] Ready for connections");
});
