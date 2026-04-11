// AI Speech Evaluator - Shared TypeScript interfaces and types
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
  /** Pathways project type. Max 100 characters (Req 4.8). */
  projectType: string | null;
  /** Project-specific evaluation objectives. Max 10 items, each max 500 characters (Req 4.8). */
  objectives: string[];
  /** Evaluation feedback style (#133). Defaults to 'classic'. */
  evaluationStyle?: string;
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
  // ─── Phase 4 Fields ──────────────────────────────────────────────────────────
  videoConsent: VideoConsent | null; // Phase 4 (Req 1) — separate from audio consent
  videoStreamReady: boolean; // Phase 4 (Req 1.5) — true after successful getUserMedia handshake
  visualObservations: VisualObservations | null; // Phase 4 — aggregate visual metrics from video processing
  videoConfig: { frameRate: number }; // Phase 4 (Req 2.9) — default: { frameRate: 2 }
  // ─── Eager Pipeline Fields ──────────────────────────────────────────────────
  eagerStatus: EagerStatus; // default: "idle"
  eagerRunId: number | null; // runId captured at eager pipeline start; null when idle
  eagerPromise: Promise<void> | null; // reference to in-flight eager pipeline for await coordination
  evaluationCache: EvaluationCache | null; // single immutable cache object containing all delivery artifacts
  // ─── Operator Notes (#164) ────────────────────────────────────────────────
  operatorNotes: string; // mutable during IDLE + RECORDING, injected into evaluation prompt
}

// ─── Transcript ─────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  startTime: number; // seconds from speech start
  endTime: number; // seconds from speech start
  words: TranscriptWord[];
  isFinal: boolean; // true for finalized segments, false for interim
  speakerId?: number; // Deepgram diarization speaker label (#157)
}

export interface TranscriptWord {
  word: string;
  startTime: number;
  endTime: number;
  confidence: number;
  speakerId?: number; // Deepgram diarization speaker label (#157)
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
  visualMetrics: VisualMetrics | null; // Phase 4 (Req 9.1) — null when video not available
  // #124 — Acoustic analysis (optional, computed when audio is available)
  pitchProfile?: PitchProfile;
  paceVariation?: PaceVariation;
  prosodicIndicators?: ProsodicIndicators;
  // #157 — Per-speaker diarization metrics (optional, present when diarization is available)
  speakerMetrics?: SpeakerMetrics[];
}

/**
 * Per-speaker metrics computed from diarized transcript segments (#157).
 */
export interface SpeakerMetrics {
  speakerId: number;
  totalWords: number;
  talkTimeSeconds: number;
  wordsPerMinute: number;
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

// ─── Pitch Profile (#124 — Acoustic Analysis) ──────────────────────────────────

export interface PitchProfile {
  /** Extracted F0 values in Hz (one per analysis window, 0 = unvoiced) */
  f0Values: number[];
  /** Window duration in milliseconds */
  windowDurationMs: number;
  /** Minimum F0 across voiced windows (Hz) */
  minF0: number;
  /** Maximum F0 across voiced windows (Hz) */
  maxF0: number;
  /** Mean F0 across voiced windows (Hz) */
  meanF0: number;
  /** Standard deviation of F0 across voiced windows (Hz) */
  stdDevF0: number;
  /** Pitch range in semitones (musical measure of variation) */
  rangeSemitones: number;
  /** Fraction of windows that were voiced (0.0-1.0) */
  voicedFraction: number;
}

// ─── Pace Variation (#124 — Acoustic Analysis) ─────────────────────────────────

export interface PaceVariation {
  /** Local WPM values computed over sliding windows */
  localWPM: number[];
  /** Window duration in seconds */
  windowDurationSeconds: number;
  /** Stride between windows in seconds */
  strideSeconds: number;
  /** Mean local WPM */
  meanWPM: number;
  /** Standard deviation of local WPM */
  stdDevWPM: number;
  /** Coefficient of variation (stdDev / mean) — higher = more variation */
  variationCoefficient: number;
  /** Peak local WPM (fastest section) */
  peakWPM: number;
  /** Trough local WPM (slowest section) */
  troughWPM: number;
}

// ─── Prosodic Indicators (#124 — Acoustic Analysis) ────────────────────────────

export interface ProsodicIndicators {
  /** Vocal jitter: std dev of F0 deltas between consecutive voiced frames (Hz) */
  pitchJitter: number;
  /** Mean RMS energy at the start of utterances (first 100ms after silence) */
  meanOnsetStrength: number;
  /** Number of utterance onsets detected */
  onsetCount: number;
}


// ─── Category Scores (Phase 8 — #144) ───────────────────────────────────────────

export type ScoreCategory = "delivery" | "content" | "structure" | "engagement";

export interface CategoryScore {
  category: ScoreCategory;
  score: number; // 0-10 inclusive
  rationale: string; // 1-2 sentence explanation
}

// ─── Evaluation Styles (#133) ───────────────────────────────────────────────────

export enum EvaluationStyle {
  Classic = "classic",
  SBI = "sbi",
  Feedforward = "feedforward",
  COIN = "coin",
  Holistic = "holistic",
  EEC = "eec",
  RadicalCandour = "radical_candour",
  Socratic = "socratic",
  Comparative = "comparative",
  MicroFocus = "micro_focus",
}

// ─── Style-Specific Item Types (#133) ───────────────────────────────────────────

/** Classic: commendation/recommendation with evidence quotes (default, backward-compatible) */
export interface ClassicEvaluationItem {
  style: "classic";
  type: "commendation" | "recommendation";
  summary: string;
  evidence_quote: string;
  evidence_timestamp: number;
  explanation: string;
}

/** SBI: Situation → Behavior → Impact */
export interface SBIEvaluationItem {
  style: "sbi";
  valence: "positive" | "constructive";
  situation: string;
  behavior: string;
  impact: string;
}

/** Feedforward: observation + future-focused suggestion */
export interface FeedforwardEvaluationItem {
  style: "feedforward";
  observation: string;
  nextTime: string;
}

/** COIN: Context → Observation → Impact → Next Steps */
export interface COINEvaluationItem {
  style: "coin";
  context: string;
  observation: string;
  impact: string;
  nextSteps: string;
}

/** Holistic: What I Heard / Saw / Felt */
export interface HolisticEvaluationItem {
  style: "holistic";
  category: "heard" | "saw" | "felt";
  observation: string;
  detail: string;
}

/** EEC: Example → Effect → Change/Continue (#149) */
export interface EECEvaluationItem {
  style: "eec";
  example: string;
  effect: string;
  change_or_continue: string;
}

/** Radical Candour: Care Personally + Challenge Directly (#149) */
export interface RadicalCandourEvaluationItem {
  style: "radical_candour";
  candour_type: "praise" | "criticism";
  observation: string;
  impact: string;
  suggestion: string;
}

/** Socratic: Reflective questions for self-discovery (#149) */
export interface SocraticEvaluationItem {
  style: "socratic";
  question: string;
  context: string;
  reflection_prompt: string;
}

/** Comparative: Current behavior vs. improved alternative (#149) */
export interface ComparativeEvaluationItem {
  style: "comparative";
  current_behavior: string;
  improved_alternative: string;
  rationale: string;
}

/** Micro-Focus: Deep-dive into one focus area (#149) */
export interface MicroFocusEvaluationItem {
  style: "micro_focus";
  focus_area: string;
  observation: string;
  deep_analysis: string;
  exercises: string[];
}

export type StyledEvaluationItem =
  | ClassicEvaluationItem
  | SBIEvaluationItem
  | FeedforwardEvaluationItem
  | COINEvaluationItem
  | HolisticEvaluationItem
  | EECEvaluationItem
  | RadicalCandourEvaluationItem
  | SocraticEvaluationItem
  | ComparativeEvaluationItem
  | MicroFocusEvaluationItem;

// ─── Structured Evaluation ──────────────────────────────────────────────────────

/** Legacy evaluation item — kept for backward compatibility with classic style */
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
  items: EvaluationItem[]; // classic items (backward-compatible)
  closing: string; // 1-2 sentences
  structure_commentary: StructureCommentary; // Phase 2 (Req 4.9)
  visual_feedback?: VisualFeedbackItem[]; // Phase 4 (Req 8) — optional visual observation items
  completed_form?: string; // Phase 5 (#64) — completed evaluation form text
  evaluation_style?: EvaluationStyle; // #133 — which feedback style was used
  style_items?: StyledEvaluationItem[]; // #133 — style-specific items (non-classic styles)
  category_scores?: CategoryScore[]; // #144 — per-category 0-10 scores
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
  completed_form?: string; // Phase 5 (#64) — completed evaluation form text
  category_scores?: CategoryScore[]; // #144 — per-category 0-10 scores
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

// ─── Tone Checker Types (co-located in tone-checker.ts — #85) ───────────────────
// Re-exported here for backward compatibility

export type { ToneViolation, ToneCheckResult } from "./tone-checker.js";

// ─── Configuration ──────────────────────────────────────────────────────────────

export interface EvaluationConfig {
  objectives?: string[]; // unused in Phase 1, extensibility hook (Req 8.2)
  speechTitle?: string;    // Phase 3: speech title from ProjectContext
  projectType?: string;    // Phase 3: speech project type from ProjectContext
  evaluationFormText?: string; // Phase 5 (#64): extracted text from uploaded evaluation form
  evaluationStyle?: EvaluationStyle; // #133: configurable feedback style
  operatorNotes?: string; // #164: operator observations during recording
}

export interface TTSConfig {
  voice: string; // default: "nova", extensibility hook (Req 8.3)
  maxDurationSeconds: number; // default: 120 (2min), Phase 2 default (Req 6.1)
  calibratedWPM: number; // default: 150, calibrated per voice
  safetyMarginPercent: number; // Phase 2 (Req 6.2) — default: 8
}

// ─── WebSocket Protocol ─────────────────────────────────────────────────────────

// ─── Phase 4: Video Consent (Req 1) ────────────────────────────────────────────

export interface VideoConsent {
  consentGranted: boolean;
  timestamp: Date;
}

// ─── Phase 4: Visual Metrics (Req 9) ───────────────────────────────────────────

export interface VisualMetrics {
  gazeBreakdown: { audienceFacing: number; notesFacing: number; other: number };
  faceNotDetectedCount: number;
  totalGestureCount: number;
  gestureFrequency: number;
  gesturePerSentenceRatio: number | null; // null when suppressed due to low retention
  meanBodyStabilityScore: number;
  stageCrossingCount: number;
  movementClassification: "stationary" | "moderate_movement" | "high_movement";
  meanFacialEnergyScore: number;
  facialEnergyVariation: number;
  facialEnergyLowSignal: boolean;
  framesAnalyzed: number;
  videoQualityGrade: "good" | "degraded" | "poor";
  videoQualityWarning: boolean; // derived: videoQualityGrade !== "good" — NOT stored independently
  gazeReliable: boolean;
  gestureReliable: boolean;
  stabilityReliable: boolean;
  facialEnergyReliable: boolean;
  framesDroppedByFinalizationBudget: number;
  resolutionChangeCount: number;
  videoProcessingVersion: {
    tfjsVersion: string;
    tfjsBackend: string;
    modelVersions: { blazeface: string; movenet: string };
    configHash: string;
  };
  capabilities: {
    face: boolean;  // true iff deps.faceDetector was defined
    pose: boolean;  // true iff deps.poseDetector was defined
  };
  // Optional high-value improvements (Req 21)
  confidenceScores?: MetricConfidenceScores;
  detectionCoverage?: DetectionCoverage;
  cameraPlacementWarning?: CameraPlacementWarning;
}

// ─── Phase 4: Visual Feedback Item (Req 8) ─────────────────────────────────────

export interface VisualFeedbackItem {
  type: "visual_observation";
  summary: string;
  observation_data: string; // formal grammar: "metric=<metricName>; value=<number><unit?>; source=visualObservations"
  explanation: string; // 2-3 sentences, observational "I observed..." language
}

// ─── Phase 4: Gaze Breakdown ───────────────────────────────────────────────────

export interface GazeBreakdown {
  audienceFacing: number;
  notesFacing: number;
  other: number;
}

// ─── Phase 4: Frame Headers and Types (Req 10) ────────────────────────────────

export interface FrameHeader {
  timestamp: number; // seconds since client-side recording start (monotonic)
  seq: number; // incrementing frame sequence number
  width: number;
  height: number;
}

export interface AudioFrameHeader {
  timestamp: number;
  seq: number;
}

export type FrameType = "audio" | "video";

// ─── Phase 4: Video Config (Req 2.9) ──────────────────────────────────────────

export interface VideoConfig {
  frameRate: number; // target FPS for sampling; default: 2, range: 1-5
  gestureDisplacementThreshold: number; // fraction of body bbox height; default: 0.15
  stageCrossingThreshold: number; // fraction of frame width; default: 0.25
  stabilityWindowSeconds: number; // rolling window for body stability; default: 5
  gazeYawThreshold: number; // degrees from camera-facing for "audience-facing"; default: 15
  gazePitchThreshold: number; // degrees below horizontal for "notes-facing"; default: -20
  cameraDropTimeoutSeconds: number; // seconds without frames before declaring camera drop; default: 5
  queueMaxSize: number; // max frames in the internal queue; default: 20
  maxFrameInferenceMs: number; // hard timeout per frame inference; default: 500
  staleFrameThresholdSeconds: number; // max age of frame before discard; default: 2.0
  finalizationBudgetMs: number; // hard max for finalize(); default: 3000
  minFaceAreaFraction: number; // minimum face bbox area / frame area for gaze; default: 0.05
  faceDetectionConfidenceThreshold: number; // min confidence for face detection; default: 0.5
  poseDetectionConfidenceThreshold: number; // min confidence for pose detection; default: 0.3
  minValidFramesPerWindow: number; // min valid frames in a 5s window for metric inclusion; default: 3
  metricRoundingPrecision: number; // decimal places for metric rounding; default: 4
  facialEnergyEpsilon: number; // variance threshold below which facial energy is "low signal"; default: 0.001
  backpressureOverloadThreshold: number; // fraction triggering adaptive sampling; default: 0.20
  backpressureRecoveryThreshold: number; // fraction below which adaptive sampling recovers; default: 0.10
  backpressureCooldownMs: number; // cooldown before restoring configured rate; default: 3000
  frameRetentionWarningThreshold: number; // min retention rate in 5s window; default: 0.50
  motionDeadZoneFraction: number; // min displacement to count as movement; default: 0.0
  gazeCoverageThreshold: number; // per-metric coverage threshold for gaze; default: 0.6
  facialEnergyCoverageThreshold: number; // per-metric coverage threshold for facial energy; default: 0.4
  gestureCoverageThreshold: number; // per-metric coverage threshold for gestures; default: 0.3
  stabilityCoverageThreshold: number; // per-metric coverage threshold for stability; default: 0.6
}

// ─── Phase 4: Confidence Scores (Req 21.1) ────────────────────────────────────

export interface MetricConfidenceScores {
  gaze: number; // 0.0-1.0
  gesture: number; // 0.0-1.0
  stability: number; // 0.0-1.0
  facialEnergy: number; // 0.0-1.0
}

// ─── Phase 4: Detection Coverage (Req 21.2) ───────────────────────────────────

export interface DetectionCoverage {
  gaze: number; // fraction of frames where face detector succeeded
  gesture: number; // fraction of frames where hand keypoints detected
  stability: number; // fraction of frames where body center computed
  facialEnergy: number; // fraction of frames where facial energy computed
}

// ─── Phase 4: Camera Placement Warning (Req 21.6) ─────────────────────────────

export interface CameraPlacementWarning {
  estimatedAngleDeg: number; // estimated camera angle from frontal
  isFrontal: boolean; // true if angle <= 30°
  warning?: string; // human-readable warning if angle > 30°
}

// ─── Phase 4: Visual Observations (aggregate output) ──────────────────────────

export interface VisualObservations {
  gazeBreakdown: GazeBreakdown;
  faceNotDetectedCount: number;
  totalGestureCount: number;
  gestureFrequency: number; // gestures per minute
  gesturePerSentenceRatio: number | null; // 0.0-1.0, null when suppressed
  handsDetectedFrames: number;
  handsNotDetectedFrames: number;
  meanBodyStabilityScore: number; // 0.0-1.0
  stageCrossingCount: number;
  movementClassification: "stationary" | "moderate_movement" | "high_movement";
  meanFacialEnergyScore: number; // 0.0-1.0
  facialEnergyVariation: number; // coefficient of variation
  facialEnergyLowSignal: boolean; // true when variance < epsilon
  framesAnalyzed: number;
  framesReceived: number;
  framesSkippedBySampler: number;
  framesErrored: number;
  framesDroppedByBackpressure: number;
  framesDroppedByTimestamp: number;
  framesDroppedByFinalizationBudget: number;
  resolutionChangeCount: number;
  videoQualityGrade: "good" | "degraded" | "poor";
  videoQualityWarning: boolean; // derived: videoQualityGrade !== "good"
  finalizationLatencyMs: number;
  videoProcessingVersion: {
    tfjsVersion: string;
    tfjsBackend: string;
    modelVersions: { blazeface: string; movenet: string };
    configHash: string;
  };
  gazeReliable: boolean;
  gestureReliable: boolean;
  stabilityReliable: boolean;
  facialEnergyReliable: boolean;
  capabilities: {
    face: boolean;  // true iff deps.faceDetector was defined
    pose: boolean;  // true iff deps.poseDetector was defined
  };
  // Optional high-value improvements (Req 21)
  confidenceScores?: MetricConfidenceScores;
  detectionCoverage?: DetectionCoverage;
  cameraPlacementWarning?: CameraPlacementWarning;
}

// ─── Output File (for client-side download — issue #55) ────────────────────────

export interface OutputFile {
  name: string;       // e.g. "transcript.txt"
  content: string;    // text content or base64-encoded binary
  encoding: "utf-8" | "base64";
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
  | { type: "set_vad_config"; silenceThresholdSeconds: number; enabled: boolean }
  | { type: "set_video_consent"; consentGranted: boolean; timestamp: string }
  | { type: "video_stream_ready"; width: number; height: number; deviceLabel?: string }
  | { type: "set_video_config"; frameRate: number }
  | { type: "set_active_roles"; roleIds: string[] }
  | { type: "set_analysis_tier"; tier: string }
  | { type: "set_evaluation_style"; style: string }
  | { type: "set_session_mode"; mode: string }
  | { type: "set_notes"; notes: string } // #164 — operator notes
  | { type: "set_meeting_context"; meetingId: string; slotId: string; clubName?: string } // #174 — meeting mode
  | { type: "vision_frame"; data: string; seq: number };

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
  | { type: "outputs_saved"; paths: string[]; files: OutputFile[] }
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
  | { type: "pipeline_progress"; stage: PipelineStage; runId: number; message?: string }
  | {
    type: "video_status";
    framesProcessed: number;
    framesDropped: number;
    processingLatencyMs: number;
    framesReceived?: number;
    framesSkippedBySampler?: number;
    framesDroppedByBackpressure?: number;
    framesDroppedByTimestamp?: number;
    framesErrored?: number;
    effectiveSamplingRate?: number;
    finalizationLatencyMs?: number;
    videoQualityGrade?: "good" | "degraded" | "poor";
  }
  | {
    type: "role_results";
    results: Array<{
      roleId: string;
      roleName: string;
      report: { title: string; sections: Array<{ heading: string; content: string }>; data?: Record<string, unknown> };
      script: string;
    }>;
  }
  | { type: "coaching_cue"; cueType: string; message: string; timestamp: number };

// ─── Meeting Agenda Types (#174) ────────────────────────────────────────────

export interface AgendaSlot {
  id: string;
  type: "speech" | "table-topics";
  speakerName: string;
  projectTitle?: string;
  evaluationFormText?: string;
  order: number;
  status: "pending" | "active" | "completed" | "skipped";
}

export interface MeetingAgenda {
  meetingId: string;
  clubName?: string;
  meetingDate: string;
  slots: AgendaSlot[];
  createdAt: string;
}

export interface MeetingRecord {
  meetingId: string;
  clubName?: string;
  meetingDate: string;
  slots: MeetingSlotSummary[];
  createdAt: string;
  completedAt?: string;
}

export interface MeetingSlotSummary {
  slotId: string;
  type: "speech" | "table-topics";
  speakerName: string;
  projectTitle?: string;
  status: "completed" | "skipped";
  evalPrefix?: string;
}

export interface ParsedAgendaSlot {
  type: "speech" | "table-topics";
  speakerName: string;
  projectTitle?: string;
  order: number;
}
