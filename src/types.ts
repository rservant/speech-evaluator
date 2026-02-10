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

// ─── Eager Pipeline Types ───────────────────────────────────────────────────────

export type EagerStatus = "idle" | "generating" | "synthesizing" | "ready" | "failed";

export type PipelineStage =
  | "processing_speech"
  | "generating_evaluation"
  | "synthesizing_audio"
  | "ready"
  | "failed"
  | "invalidated"; // Cache invalidated due to parameter change; never emitted by SessionManager — server/UI hint only

export interface EvaluationCache {
  runId: number;
  timeLimitSeconds: number;
  voiceConfig: string;
  evaluation: StructuredEvaluation;
  evaluationScript: string;
  ttsAudio: Buffer; // exact binary payload for ws.send(), no framing needed
  evaluationPublic: StructuredEvaluationPublic | null; // nullable in type but required non-null for cache validity
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

// ─── Consent Record (Phase 2 — Req 2.2) ────────────────────────────────────────

export interface ConsentRecord {
  speakerName: string;
  consentConfirmed: boolean;
  consentTimestamp: Date;
}

// ─── Project Context (Phase 3 — Req 4, 5, 6) ───────────────────────────────────

export interface ProjectContext {
  /** Speech title, free text. Max 200 characters (Req 4.8). */
  speechTitle: string | null;
  /** Toastmasters Pathways project type. Max 100 characters (Req 4.8). */
  projectType: string | null;
  /** Project-specific evaluation objectives. Max 10 items, each max 500 characters (Req 4.8). */
  objectives: string[];
}

// ─── VAD Configuration (Phase 3 — Req 1, 2, 3) ─────────────────────────────────

export interface SessionVADConfig {
  /** Silence duration threshold in seconds. Range: 3-15, default: 5 (Req 3.1). */
  silenceThresholdSeconds: number;
  /** Whether VAD is enabled. Default: true (Req 3.5). */
  enabled: boolean;
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
  evaluationPublic: StructuredEvaluationPublic | null; // Phase 2: redacted version for UI/save
  evaluationScript: string | null; // rendered spoken script
  ttsAudioCache: Buffer | null; // cached TTS audio for replay (in-memory only)
  qualityWarning: boolean;
  outputsSaved: boolean; // opt-in persistence flag
  runId: number; // monotonic integer, incremented on each start/panic; async stages check before committing
  consent: ConsentRecord | null; // Phase 2 (Req 2.2) — replaces speakerName usage
  timeLimitSeconds: number; // Phase 2 (Req 6.1) — default: 120
  evaluationPassRate: number | null; // Phase 2 (Req 1.6) — telemetry
  speakerName?: string; // DEPRECATED — getter from consent (Req 8.4 backward compat)
  /** @deprecated Use `projectContext.objectives` instead. Superseded by Phase 3 project awareness (Req 8.2). */
  evaluationObjectives?: string[]; // extensibility: future project-specific (Req 8.2)
  voiceConfig?: string; // extensibility: future voice selection (Req 8.3)
  // ─── Phase 3 Fields ────────────────────────────────────────────────────────
  projectContext: ProjectContext | null; // Phase 3 (Req 9.1) — project awareness metadata
  vadConfig: SessionVADConfig; // Phase 3 (Req 9.2) — VAD configuration
  // ─── Eager Pipeline Fields ──────────────────────────────────────────────────
  eagerStatus: EagerStatus; // default: "idle"
  eagerRunId: number | null; // runId captured at eager pipeline start; null when idle
  eagerPromise: Promise<void> | null; // reference to in-flight eager pipeline for await coordination
  evaluationCache: EvaluationCache | null; // single immutable cache object containing all delivery artifacts
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
  // Phase 2 additions (Req 5.10)
  intentionalPauseCount: number;
  hesitationPauseCount: number;
  classifiedPauses: ClassifiedPause[];
  energyVariationCoefficient: number;
  energyProfile: EnergyProfile;
  classifiedFillers: ClassifiedFillerEntry[];
}

export interface FillerWordEntry {
  word: string;
  count: number;
  timestamps: number[]; // when each occurrence happened
}

// ─── Classified Filler Entry (Phase 2 — Req 5.9) ───────────────────────────────

export interface ClassifiedFillerEntry {
  word: string;
  count: number;
  timestamps: number[];
  classification: "true_filler" | "discourse_marker";
}

// ─── Classified Pause (Phase 2 — Req 5.1) ──────────────────────────────────────

export interface ClassifiedPause {
  start: number;
  end: number;
  duration: number;
  type: "intentional" | "hesitation";
  reason: string;
}

// ─── Energy Profile (Phase 2 — Req 5.5) ────────────────────────────────────────

export interface EnergyProfile {
  windowDurationMs: number;
  windows: number[];
  coefficientOfVariation: number;
  silenceThreshold: number;
}

// ─── Structured Evaluation ──────────────────────────────────────────────────────

export interface EvaluationItem {
  type: "commendation" | "recommendation";
  summary: string;
  evidence_quote: string; // verbatim snippet from transcript (≤15 words)
  evidence_timestamp: number; // start time of first quoted word, seconds since speech start
  explanation: string; // why this matters
}

// ─── Structure Commentary (Phase 2 — Req 4.9) ──────────────────────────────────

export interface StructureCommentary {
  opening_comment: string | null;
  body_comment: string | null;
  closing_comment: string | null;
}

export interface StructuredEvaluation {
  opening: string; // 1-2 sentences
  items: EvaluationItem[]; // 2-3 commendations + 1-2 recommendations
  closing: string; // 1-2 sentences
  structure_commentary: StructureCommentary; // Phase 2 (Req 4.9)
}

// ─── Public Evaluation Types (Phase 2 — Req 8.1) ───────────────────────────────
// Public versions sent to UI and saved to disk, with third-party names redacted

export interface EvaluationItemPublic {
  type: "commendation" | "recommendation";
  summary: string;
  explanation: string;
  evidence_quote: string; // may contain redacted names (e.g., "a fellow member")
  evidence_timestamp: number;
}

export interface StructuredEvaluationPublic {
  opening: string;
  items: EvaluationItemPublic[];
  closing: string;
  structure_commentary: StructureCommentary;
}

// ─── Redaction Types (Phase 2 — Req 8.1) ────────────────────────────────────────

export interface RedactionInput {
  script: string;
  evaluation: StructuredEvaluation;
  consent: ConsentRecord;
}

export interface RedactionOutput {
  scriptRedacted: string;
  evaluationPublic: StructuredEvaluationPublic;
}

// ─── Tone Checker Types (Phase 2 — Req 3) ───────────────────────────────────────

export interface ToneViolation {
  category:
    | "ungrounded_claim"
    | "psychological_inference"
    | "visual_scope"
    | "punitive_language"
    | "numerical_score";
  sentence: string;
  pattern: string;
  explanation: string;
}

export interface ToneCheckResult {
  passed: boolean;
  violations: ToneViolation[];
}

// ─── Configuration ──────────────────────────────────────────────────────────────

export interface EvaluationConfig {
  objectives?: string[]; // unused in Phase 1, extensibility hook (Req 8.2)
  speechTitle?: string;    // Phase 3: speech title from ProjectContext
  projectType?: string;    // Phase 3: Toastmasters project type from ProjectContext
}

export interface TTSConfig {
  voice: string; // default: "nova", extensibility hook (Req 8.3)
  maxDurationSeconds: number; // default: 120 (2min), Phase 2 default (Req 6.1)
  calibratedWPM: number; // default: 150, calibrated per voice
  safetyMarginPercent: number; // Phase 2 (Req 6.2) — default: 8
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
  | { type: "replay_tts" }
  | { type: "set_consent"; speakerName: string; consentConfirmed: boolean }
  | { type: "revoke_consent" }
  | { type: "set_time_limit"; seconds: number }
  | { type: "set_project_context"; speechTitle: string; projectType: string; objectives: string[] }
  | { type: "set_vad_config"; silenceThresholdSeconds: number; enabled: boolean };

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
      evaluation: StructuredEvaluationPublic;
      script: string;
    }
  | { type: "tts_audio"; data: ArrayBuffer }
  | { type: "tts_complete" }
  | { type: "outputs_saved"; paths: string[] }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "audio_format_error"; message: string }
  | { type: "consent_status"; consent: ConsentRecord | null }
  | {
      type: "duration_estimate";
      estimatedSeconds: number;
      timeLimitSeconds: number;
    }
  | { type: "vad_speech_end"; silenceDurationSeconds: number }
  | { type: "vad_status"; energy: number; isSpeech: boolean }
  | { type: "data_purged"; reason: "opt_out" | "auto_purge" }
  | { type: "pipeline_progress"; stage: PipelineStage; runId: number; message?: string };
