// AI Toastmasters Evaluator - Shared TypeScript interfaces and types
// Requirements: 8.1 (component separation), 8.2 (evaluation objectives extensibility),
//               8.3 (voice config extensibility), 8.4 (multi-speaker extensibility)

// ─── Session State Machine ──────────────────────────────────────────────────────

export enum SessionState {
  IDLE = "idle",
  RECORDING = "recording",
  PROCESSING = "processing",
  DELIVERING = "delivering",
}

// ─── Session ────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  state: SessionState;
  startedAt: Date | null;
  stoppedAt: Date | null;
  transcript: TranscriptSegment[]; // final transcript (from post-speech pass)
  liveTranscript: TranscriptSegment[]; // live captions (for UI display only)
  audioChunks: Buffer[]; // buffered audio chunks for post-speech transcription
  metrics: DeliveryMetrics | null;
  evaluation: StructuredEvaluation | null;
  evaluationScript: string | null; // rendered spoken script
  ttsAudioCache: Buffer | null; // cached TTS audio for replay (in-memory only)
  qualityWarning: boolean;
  outputsSaved: boolean; // opt-in persistence flag
  runId: number; // monotonic integer, incremented on each start/panic; async stages check before committing
  speakerName?: string; // extensibility: future multi-speaker (Req 8.4)
  evaluationObjectives?: string[]; // extensibility: future project-specific (Req 8.2)
  voiceConfig?: string; // extensibility: future voice selection (Req 8.3)
}

// ─── Transcript ─────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  startTime: number; // seconds from speech start
  endTime: number; // seconds from speech start
  words: TranscriptWord[];
  isFinal: boolean; // true for finalized segments, false for interim
}

export interface TranscriptWord {
  word: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

// ─── Delivery Metrics ───────────────────────────────────────────────────────────

export interface DeliveryMetrics {
  durationSeconds: number;
  durationFormatted: string; // "M:SS"
  totalWords: number;
  wordsPerMinute: number;
  fillerWords: FillerWordEntry[];
  fillerWordCount: number;
  fillerWordFrequency: number; // per minute
  pauseCount: number;
  totalPauseDurationSeconds: number;
  averagePauseDurationSeconds: number;
}

export interface FillerWordEntry {
  word: string;
  count: number;
  timestamps: number[]; // when each occurrence happened
}

// ─── Structured Evaluation ──────────────────────────────────────────────────────

export interface EvaluationItem {
  type: "commendation" | "recommendation";
  summary: string;
  evidence_quote: string; // verbatim snippet from transcript (≤15 words)
  evidence_timestamp: number; // start time of first quoted word, seconds since speech start
  explanation: string; // why this matters
}

export interface StructuredEvaluation {
  opening: string; // 1-2 sentences
  items: EvaluationItem[]; // 2-3 commendations + 1-2 recommendations
  closing: string; // 1-2 sentences
}

// ─── Configuration ──────────────────────────────────────────────────────────────

export interface EvaluationConfig {
  objectives?: string[]; // unused in Phase 1, extensibility hook (Req 8.2)
}

export interface TTSConfig {
  voice: string; // default: "nova", extensibility hook (Req 8.3)
  maxDurationSeconds: number; // default: 210 (3m30s), hard cap
  calibratedWPM: number; // default: 150, calibrated per voice
}

// ─── WebSocket Protocol ─────────────────────────────────────────────────────────

// Client → Server messages
export type ClientMessage =
  | {
      type: "audio_format";
      channels: 1;
      sampleRate: 16000;
      encoding: "LINEAR16";
    }
  | { type: "start_recording" }
  | { type: "audio_chunk"; data: ArrayBuffer }
  | { type: "stop_recording" }
  | { type: "deliver_evaluation" }
  | { type: "save_outputs" }
  | { type: "panic_mute" }
  | { type: "replay_tts" };

// Server → Client messages
export type ServerMessage =
  | { type: "state_change"; state: SessionState }
  | {
      type: "transcript_update";
      segments: TranscriptSegment[];
      replaceFromIndex: number;
    }
  | { type: "elapsed_time"; seconds: number }
  | {
      type: "evaluation_ready";
      evaluation: StructuredEvaluation;
      script: string;
    }
  | { type: "tts_audio"; data: ArrayBuffer }
  | { type: "tts_complete" }
  | { type: "outputs_saved"; paths: string[] }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "audio_format_error"; message: string };
